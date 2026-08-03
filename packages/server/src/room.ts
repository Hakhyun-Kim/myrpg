// 하란 룸 — Colyseus 네트워크 계층. 게임 판정은 전부 world.ts가 한다.
// 사람 클라이언트·봇·MCP 도구 모두 이 룸의 같은 계약(PROTOCOL.md)으로 들어온다.
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import type { Client } from "colyseus";
import { z } from "zod";

// colyseus는 CJS 전용 배포라 Node ESM에서 named import가 깨진다 — require로 가져온다
const require = createRequire(import.meta.url);
const { Room, ServerError } = require("colyseus") as typeof import("colyseus");
import { GAME, PROTOCOL_VERSION, type JoinOptions, type WelcomeMsg } from "@myrpg/protocol";
import { claim, queueView, tryCraft } from "./craft.js";
import type { ServerConfig } from "./config.js";
import type { SaveData, Storage } from "./storage.js";
import { SPAWN, World, type WorldEvent } from "./world.js";
import { HaranState, NodeSchema, PlayerSchema } from "./schema.js";

export interface RoomDeps {
  config: ServerConfig;
  storage: Storage;
  save: SaveData;
}

interface UserData {
  playerId: string;
  accountName: string;
}

const joinSchema = z.object({
  name: z.string().regex(GAME.NAME_RE),
  token: z.string().max(64).optional(),
});
const moveSchema = z.object({ x: z.number().finite(), y: z.number().finite() });
const chatSchema = z.object({ text: z.string().min(1).max(GAME.MAX_CHAT_LEN) });
const gatherSchema = z.object({ nodeId: z.string().max(64) });
const craftSchema = z.object({
  recipeId: z.string().max(64),
  count: z.number().int().min(1).max(GAME.CRAFT_MAX_COUNT),
});

export class HaranRoom extends Room<HaranState> {
  private world!: World;
  private deps!: RoomDeps;
  private byPlayerId = new Map<string, Client>();
  private buckets = new Map<string, { start: number; count: number }>();

  onCreate(options: { deps: RoomDeps }): void {
    this.deps = options.deps;
    this.autoDispose = false; // 마지막 플레이어가 나가도 월드는 계속 돈다
    this.maxClients = 64;

    const { config } = this.deps;
    this.world = new World(config.game);

    const state = new HaranState();
    state.mapId = this.world.map.id;
    state.width = this.world.map.width;
    state.height = this.world.map.height;
    for (const n of this.world.nodes.values()) {
      state.nodes.set(n.id, new NodeSchema(n.kind, n.x, n.y, n.remaining));
    }
    this.setState(state);

    this.setSimulationInterval((dt) => this.update(dt), config.game.tickMs);
    this.setPatchRate(config.game.tickMs);
    this.clock.setInterval(() => {
      void this.saveAll().catch((err) => console.error("[storage] autosave 실패:", err));
    }, config.autosaveSec * 1000);

    // ---- 메시지 핸들러 (PROTOCOL.md §4) ----
    this.onMessage("hello", (client) => {
      client.send("welcome", this.makeWelcome(client));
    });
    this.onMessage("move_to", (client, raw) => {
      if (!this.allow(client)) return;
      const msg = moveSchema.safeParse(raw);
      const p = this.playerOf(client);
      if (!msg.success || !p) return;
      const { cancelledGather } = this.world.moveTo(p, msg.data.x, msg.data.y);
      if (cancelledGather) client.send("gather_failed", { nodeId: cancelledGather, reason: "moved" });
    });
    this.onMessage("stop", (client) => {
      if (!this.allow(client)) return;
      const p = this.playerOf(client);
      if (p) this.world.stop(p);
    });
    this.onMessage("chat", (client, raw) => {
      if (!this.allow(client)) return;
      const msg = chatSchema.safeParse(raw);
      const ud = client.userData as UserData | undefined;
      if (!msg.success || !ud) return;
      this.broadcast("chat", {
        from: ud.playerId,
        name: ud.accountName,
        text: msg.data.text,
        t: Date.now(),
      });
    });
    this.onMessage("gather", (client, raw) => {
      if (!this.allow(client)) return;
      const msg = gatherSchema.safeParse(raw);
      const p = this.playerOf(client);
      if (!msg.success || !p) return;
      const r = this.world.tryGather(p, msg.data.nodeId, Date.now());
      if (r.ok) client.send("gather_started", { nodeId: msg.data.nodeId, endsAt: r.endsAt });
      else client.send("gather_failed", { nodeId: msg.data.nodeId, reason: r.reason });
    });

    // ---- 제작 큐 (PROTOCOL.md §8) ----
    this.onMessage("craft", (client, raw) => {
      if (!this.allow(client)) return;
      const msg = craftSchema.safeParse(raw);
      const account = this.accountOf(client);
      if (!account) return;
      if (!msg.success) {
        client.send("craft_failed", { recipeId: String((raw as { recipeId?: unknown })?.recipeId ?? "?"), reason: "bad_count" });
        return;
      }
      const r = tryCraft(account, msg.data.recipeId, msg.data.count, Date.now(), config.game);
      if (!r.ok) {
        client.send("craft_failed", { recipeId: msg.data.recipeId, reason: r.reason });
        return;
      }
      client.send("queue_state", queueView(account, Date.now(), config.game));
      client.send("inventory", { inventory: { ...account.inventory } }); // 원료 차감 반영
    });
    this.onMessage("queue", (client) => {
      if (!this.allow(client)) return;
      const account = this.accountOf(client);
      if (account) client.send("queue_state", queueView(account, Date.now(), config.game));
    });
    this.onMessage("claim", (client) => {
      if (!this.allow(client)) return;
      const account = this.accountOf(client);
      if (!account) return;
      const claimed = claim(account, Date.now(), config.game);
      client.send("claim_result", { claimed, inventory: { ...account.inventory } });
      client.send("queue_state", queueView(account, Date.now(), config.game));
    });
  }

  onJoin(client: Client, options: unknown): void {
    const parsed = joinSchema.safeParse(options);
    if (!parsed.success) throw new ServerError(400, "bad_request: name은 2~16자 [a-zA-Z0-9가-힣_-]");
    const { name, token } = parsed.data as JoinOptions;
    const { save } = this.deps;

    let account = save.accounts[name];
    if (account) {
      if (token !== account.token) throw new ServerError(401, "auth_failed: 이름-토큰 불일치");
    } else {
      account = {
        name,
        token: randomBytes(16).toString("hex"),
        x: SPAWN.x,
        y: SPAWN.y,
        inventory: {},
      };
      save.accounts[name] = account;
    }

    const playerId = "p_" + Buffer.from(name).toString("hex").slice(0, 12);
    client.userData = { playerId, accountName: name } satisfies UserData;

    const old = this.byPlayerId.get(playerId);
    this.byPlayerId.set(playerId, client);
    if (old) {
      // 같은 계정의 새 접속이 기존 연결을 승계한다 — 월드·스키마는 그대로 둔다
      old.leave(4001);
    } else {
      const p = this.world.addPlayer(playerId, name, account.x, account.y, account.inventory);
      this.state.players.set(playerId, new PlayerSchema(name, p.x, p.y));
    }
  }

  onLeave(client: Client): void {
    const ud = client.userData as UserData | undefined;
    if (!ud) return;
    this.buckets.delete(client.sessionId);
    if (this.byPlayerId.get(ud.playerId) !== client) return; // 승계됨
    this.persist(ud);
    this.byPlayerId.delete(ud.playerId);
    this.world.removePlayer(ud.playerId);
    this.state.players.delete(ud.playerId);
  }

  async onDispose(): Promise<void> {
    await this.saveAll().catch((err) => console.error("[storage] 종료 저장 실패:", err));
  }

  // ---- 틱: world가 진실, 스키마는 투영 ----
  private lastCraftCheck = 0;

  private update(dtMs: number): void {
    const now = Date.now();
    for (const ev of this.world.tick(now, dtMs)) this.dispatch(ev);

    // 접속 중인 플레이어의 제작 완료를 1초 주기로 확인해 밀어준다 (오프라인은 다음 접근 때 정산)
    if (now - this.lastCraftCheck >= 1000) {
      this.lastCraftCheck = now;
      for (const client of this.byPlayerId.values()) {
        const account = this.accountOf(client);
        if (!account?.jobs?.length) continue;
        const ms = this.deps.config.game.craftMsT1;
        const due = account.jobs.some((j) => now >= j.startAt + ms);
        if (due) client.send("queue_state", queueView(account, now, this.deps.config.game));
      }
    }
  }

  private dispatch(ev: WorldEvent): void {
    switch (ev.kind) {
      case "moved":
        for (const m of ev.players) {
          const ps = this.state.players.get(m.id);
          if (ps) {
            ps.x = m.x;
            ps.y = m.y;
          }
        }
        return;
      case "gather_done": {
        const client = this.byPlayerId.get(ev.playerId);
        const p = this.world.players.get(ev.playerId);
        if (client && p)
          client.send("gather_result", {
            nodeId: ev.nodeId,
            item: ev.item,
            count: ev.count,
            inventory: { ...p.inventory },
          });
        return;
      }
      case "gather_fail": {
        const client = this.byPlayerId.get(ev.playerId);
        if (client) client.send("gather_failed", { nodeId: ev.nodeId, reason: ev.reason });
        return;
      }
      case "node_changed": {
        const ns = this.state.nodes.get(ev.node.id);
        if (ns) ns.remaining = ev.node.remaining;
        return;
      }
    }
  }

  // ---- 헬퍼 ----
  private makeWelcome(client: Client): WelcomeMsg {
    const ud = client.userData as UserData;
    const account = this.deps.save.accounts[ud.accountName]!;
    const p = this.world.players.get(ud.playerId);
    return {
      protocol: PROTOCOL_VERSION,
      playerId: ud.playerId,
      token: account.token,
      inventory: { ...(p?.inventory ?? account.inventory) },
      queue: queueView(account, Date.now(), this.deps.config.game),
    };
  }

  private accountOf(client: Client): (typeof this.deps.save.accounts)[string] | null {
    const ud = client.userData as UserData | undefined;
    return ud ? (this.deps.save.accounts[ud.accountName] ?? null) : null;
  }

  private playerOf(client: Client) {
    const ud = client.userData as UserData | undefined;
    return ud ? (this.world.players.get(ud.playerId) ?? null) : null;
  }

  /** 레이트 리밋 — 봇도 사람도 초당 20개 (PROTOCOL.md §5) */
  private allow(client: Client): boolean {
    const now = Date.now();
    let b = this.buckets.get(client.sessionId);
    if (!b || now - b.start >= 1000) {
      b = { start: now, count: 0 };
      this.buckets.set(client.sessionId, b);
    }
    b.count += 1;
    if (b.count > this.deps.config.game.rateLimitPerSec) {
      client.leave(4002, "rate limited");
      return false;
    }
    return true;
  }

  private persist(ud: UserData): void {
    const account = this.deps.save.accounts[ud.accountName];
    const p = this.world.players.get(ud.playerId);
    if (!account || !p) return;
    account.x = p.x;
    account.y = p.y;
    account.inventory = p.inventory;
  }

  private async saveAll(): Promise<void> {
    for (const client of this.byPlayerId.values()) {
      const ud = client.userData as UserData | undefined;
      if (ud) this.persist(ud);
    }
    await this.deps.storage.save(this.deps.save);
  }
}
