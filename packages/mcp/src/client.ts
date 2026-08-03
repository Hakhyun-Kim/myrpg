// GameClient — MCP 도구가 사용하는 게임 접속 계층.
// 전용 API가 아니라 PROTOCOL.md의 룸 계약(colyseus.js)으로 접속하는 "또 하나의 클라이언트"다 (P6).
// LLM 에이전트는 턴 단위로 사고하므로, 상태 스트림을 "행동 → 완료까지 대기" 형태로 감싸 준다.
import { Client, type Room } from "colyseus.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  GAME,
  ROOM_NAME,
  dist,
  type Inventory,
  type NodeView,
  type WelcomeMsg,
} from "@myrpg/protocol";

const TOKEN_DIR = process.env.MYRPG_DATA_DIR ?? "./data";
const TOKEN_FILE = join(TOKEN_DIR, "mcp-tokens.json");

export interface ChatLine {
  name: string;
  text: string;
  t: number;
}

type Json = Record<string, any>;
const CAPTURED = [
  "chat",
  "gather_started",
  "gather_result",
  "gather_failed",
  "queue_state",
  "craft_failed",
  "claim_result",
  "inventory",
] as const;

export class GameClient {
  private room: Room | null = null;
  private queue: Json[] = [];
  private waiters: { pred: (m: Json) => boolean; resolve: (m: Json) => void }[] = [];

  playerId = "";
  name = "";
  inventory: Inventory = {};
  chatLog: ChatLine[] = [];
  private lastUrl = "";

  get connected(): boolean {
    return this.room !== null && this.playerId !== "";
  }

  private get state(): Json {
    if (!this.room) throw new Error("접속 상태가 아닙니다. join부터 하세요.");
    return this.room.state as Json;
  }

  get me(): { x: number; y: number } {
    const p = this.state.players.get(this.playerId);
    if (!p) throw new Error("월드에 내 캐릭터가 없습니다");
    return { x: p.x, y: p.y };
  }

  get map(): { id: string; width: number; height: number } {
    return { id: this.state.mapId, width: this.state.width, height: this.state.height };
  }

  get nodes(): Map<string, NodeView> {
    const out = new Map<string, NodeView>();
    this.state.nodes.forEach((n: Json, id: string) => {
      out.set(id, { id, kind: n.kind, x: n.x, y: n.y, remaining: n.remaining });
    });
    return out;
  }

  async connect(url: string, name: string): Promise<void> {
    if (this.connected) throw new Error(`이미 ${this.name}(으)로 접속 중입니다. leave 후 다시 시도하세요.`);
    const token = loadTokens()[name];
    let room: Room;
    try {
      room = await new Client(url).joinOrCreate(ROOM_NAME, { name, ...(token ? { token } : {}) });
    } catch (err) {
      throw new Error(`입장 실패 (${url}): ${(err as Error).message}`);
    }
    this.room = room;

    for (const type of CAPTURED) {
      room.onMessage(type, (payload: Json) => this.push({ type, ...payload }));
    }
    room.onLeave(() => {
      this.room = null;
      this.playerId = "";
    });

    const welcome = await new Promise<WelcomeMsg>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("welcome 대기 시간 초과")), 10_000);
      room.onMessage("welcome", (w: WelcomeMsg) => {
        clearTimeout(timer);
        resolve(w);
      });
      room.send("hello");
    });

    this.playerId = welcome.playerId;
    this.name = name;
    this.lastUrl = url;
    this.inventory = welcome.inventory;
    saveToken(name, welcome.token);
  }

  /**
   * 연결 보장 — MCP 프로세스는 툴 호출 사이에 오래 유휴 상태일 수 있어
   * 그 사이 서버가 연결을 끊었을 수 있다. 죽어 있으면 같은 이름·토큰으로 조용히 재입장한다.
   * (서버가 계정을 영속하므로 인벤토리·위치는 이어진다)
   */
  async ensureConnected(): Promise<void> {
    // 유휴 중 밀려 있던 close 이벤트가 있다면 먼저 처리되게 한 틱 양보
    await new Promise((r) => setImmediate(r));
    if (this.connected) return;
    if (!this.lastUrl || !this.name) throw new Error("접속 상태가 아닙니다. join부터 하세요.");
    this.room = null;
    this.playerId = "";
    this.queue.length = 0;
    this.waiters.length = 0;
    await this.connect(this.lastUrl, this.name);
  }

  disconnect(): void {
    void this.room?.leave();
    this.room = null;
    this.playerId = "";
  }

  send(type: string, payload?: object): void {
    if (!this.room) throw new Error("접속 상태가 아닙니다. join부터 하세요.");
    this.room.send(type, payload);
  }

  private push(msg: Json): void {
    if (msg.type === "chat") {
      this.chatLog.push({ name: msg.name, text: msg.text, t: msg.t });
      if (this.chatLog.length > 30) this.chatLog.shift();
      return;
    }
    if (msg.type === "gather_result" || msg.type === "claim_result" || msg.type === "inventory")
      this.inventory = msg.inventory;
    const i = this.waiters.findIndex((w) => w.pred(msg));
    if (i >= 0) this.waiters.splice(i, 1)[0]!.resolve(msg);
    else this.queue.push(msg);
  }

  private expectMsg(pred: (m: Json) => boolean, timeoutMs: number): Promise<Json> {
    const i = this.queue.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0]!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("응답 대기 시간 초과")), timeoutMs);
      this.waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  private waitState(pred: () => boolean, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (pred()) return resolve();
      const start = Date.now();
      const iv = setInterval(() => {
        try {
          if (pred()) {
            clearInterval(iv);
            resolve();
          } else if (Date.now() - start > timeoutMs) {
            clearInterval(iv);
            reject(new Error("이동/상태 대기 시간 초과"));
          }
        } catch (err) {
          clearInterval(iv);
          reject(err as Error);
        }
      }, 50);
    });
  }

  /** 목표점으로 이동하고 도착(2px 이내)까지 대기. 서버 클램프를 로컬에도 적용해 판정. */
  async goto(x: number, y: number, timeoutMs = 30_000): Promise<void> {
    const tx = clamp(x, 0, this.state.width);
    const ty = clamp(y, 0, this.state.height);
    const near = () => dist(this.me.x, this.me.y, tx, ty) <= 2;
    if (near()) return;
    this.send("move_to", { x: tx, y: ty });
    await this.waitState(near, timeoutMs);
  }

  /** 노드로 이동해 채집 1회. 결과 아이템을 반환. */
  async gatherNode(nodeId: string): Promise<{ item: string; count: number }> {
    const node = this.nodes.get(nodeId);
    if (!node) throw new Error(`모르는 노드: ${nodeId}`);
    if (node.remaining <= 0) throw new Error(`고갈된 노드: ${nodeId} (리스폰 대기 중)`);
    if (dist(this.me.x, this.me.y, node.x, node.y) > GAME.GATHER_RANGE) await this.goto(node.x, node.y);

    this.send("gather", { nodeId });
    const started = await this.expectMsg(
      (m) => (m.type === "gather_started" || m.type === "gather_failed") && m.nodeId === nodeId,
      5000,
    );
    if (started.type === "gather_failed") throw new Error(`채집 거부: ${started.reason}`);
    const result = await this.expectMsg(
      (m) => (m.type === "gather_result" || m.type === "gather_failed") && m.nodeId === nodeId,
      GAME.GATHER_MS + 5000,
    );
    if (result.type === "gather_failed") throw new Error(`채집 실패: ${result.reason}`);
    return { item: result.item, count: result.count };
  }

  /** 요청-응답 전에 같은 타입의 낡은 푸시 메시지를 버린다 (응답 상관관계 보장). */
  private dropQueued(...types: string[]): void {
    this.queue = this.queue.filter((m) => !types.includes(m.type));
  }

  /** 제작 큐에 작업 등록. 원료는 등록 즉시 차감된다. */
  async craft(recipeId: string, count: number): Promise<Json> {
    this.dropQueued("queue_state", "craft_failed");
    this.send("craft", { recipeId, count });
    const res = await this.expectMsg(
      (m) => m.type === "queue_state" || (m.type === "craft_failed" && m.recipeId === recipeId),
      5000,
    );
    if (res.type === "craft_failed") throw new Error(`제작 등록 실패: ${res.reason}`);
    return res;
  }

  /** 현재 큐 상태 조회. */
  async queueState(): Promise<Json> {
    this.dropQueued("queue_state");
    this.send("queue");
    return this.expectMsg((m) => m.type === "queue_state", 5000);
  }

  /** 완료품 전량 수령. */
  async claim(): Promise<Json> {
    this.dropQueued("claim_result");
    this.send("claim");
    return this.expectMsg((m) => m.type === "claim_result", 5000);
  }

  /** 살아있는 노드 중 (선택적으로 종류 필터) 가장 가까운 것. */
  nearestNode(kind?: string): NodeView | null {
    let best: NodeView | null = null;
    let bestD = Infinity;
    for (const n of this.nodes.values()) {
      if (n.remaining <= 0) continue;
      if (kind && n.kind !== kind) continue;
      const d = dist(this.me.x, this.me.y, n.x, n.y);
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    return best;
  }

  /** LLM에게 보여줄 현재 상황 요약. */
  summary(): object {
    const players: { name: string; x: number; y: number }[] = [];
    this.state.players.forEach((p: Json) => {
      players.push({ name: p.name, x: Math.round(p.x), y: Math.round(p.y) });
    });
    return {
      me: { id: this.playerId, name: this.name, x: Math.round(this.me.x), y: Math.round(this.me.y) },
      map: { id: this.state.mapId, width: this.state.width, height: this.state.height },
      inventory: this.inventory,
      players,
      nodes: [...this.nodes.values()]
        .map((n) => ({
          id: n.id,
          kind: n.kind,
          remaining: n.remaining,
          distance: Math.round(dist(this.me.x, this.me.y, n.x, n.y)),
        }))
        .sort((a, b) => a.distance - b.distance),
      recentChat: this.chatLog.slice(-10),
    };
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function loadTokens(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(TOKEN_FILE, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function saveToken(name: string, token: string): void {
  try {
    const tokens = loadTokens();
    if (tokens[name] === token) return;
    tokens[name] = token;
    mkdirSync(TOKEN_DIR, { recursive: true });
    writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 1));
  } catch (err) {
    console.error("[mcp] 토큰 저장 실패:", err);
  }
}
