// 네트워크 계층 — HTTP(/health, /config.json, 정적 클라이언트) + WebSocket(/ws).
// 규범은 루트 PROTOCOL.md. 여기가 문서와 어긋나면 버그다.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { z } from "zod";
import {
  GAME,
  PROTOCOL_VERSION,
  WS_PATH,
  type ClientMsg,
  type ErrorCode,
  type ServerMsg,
} from "@myrpg/protocol";
import type { ServerConfig } from "./config.js";
import { emptySave, FileStorage, type Account, type SaveData, type Storage } from "./storage.js";
import { SPAWN, World, type WorldEvent, type WorldPlayer } from "./world.js";

const loginSchema = z.object({
  type: z.literal("login"),
  name: z.string().regex(GAME.NAME_RE),
  token: z.string().max(64).optional(),
});
const moveSchema = z.object({ type: z.literal("move_to"), x: z.number().finite(), y: z.number().finite() });
const chatSchema = z.object({ type: z.literal("chat"), text: z.string().min(1).max(GAME.MAX_CHAT_LEN) });
const gatherSchema = z.object({ type: z.literal("gather"), nodeId: z.string().max(64) });
const pingSchema = z.object({ type: z.literal("ping"), t: z.number().finite() });

interface Session {
  ws: WebSocket;
  player: WorldPlayer | null;
  accountName: string | null;
  windowStart: number;
  windowCount: number;
  loginTimer: NodeJS.Timeout | null;
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

export interface StartOptions {
  config: ServerConfig;
  storage?: Storage;
}

export async function startServer(opts: StartOptions): Promise<RunningServer> {
  const { config } = opts;
  const storage = opts.storage ?? new FileStorage(config.dataDir);
  const save: SaveData = await storage.load().catch((err) => {
    console.error("[storage] load 실패, 빈 상태로 시작:", err);
    return emptySave();
  });

  const world = new World(config.game);
  const sessions = new Set<Session>();
  const byPlayerId = new Map<string, Session>();

  // ---- HTTP ----
  const clientDist = config.clientDist ?? defaultClientDist();
  const httpServer = createServer((req, res) => {
    void handleHttp(req, res, clientDist);
  });

  // ---- WebSocket ----
  const wss = new WebSocketServer({ noServer: true, maxPayload: GAME.MAX_FRAME_BYTES });
  httpServer.on("upgrade", (req, socket, head) => {
    const path = (req.url ?? "").split("?")[0];
    if (path !== WS_PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws: WebSocket) => {
    const session: Session = {
      ws,
      player: null,
      accountName: null,
      windowStart: Date.now(),
      windowCount: 0,
      loginTimer: setTimeout(() => ws.close(1000, "login timeout"), config.game.loginTimeoutMs),
    };
    sessions.add(session);

    ws.on("message", (data: RawData) => handleMessage(session, data));
    ws.on("close", () => {
      if (session.loginTimer) clearTimeout(session.loginTimer);
      if (session.player) {
        persistPlayer(session);
        // 승계로 이미 다른 세션이 이 playerId를 차지했다면 건드리지 않는다
        if (byPlayerId.get(session.player.id) === session) {
          byPlayerId.delete(session.player.id);
          world.removePlayer(session.player.id);
          broadcast({ type: "player_left", id: session.player.id });
        }
      }
      sessions.delete(session);
    });
    ws.on("error", () => ws.close());
  });

  function handleMessage(session: Session, data: RawData): void {
    // 레이트 리밋 — 봇도 사람도 동일 (PROTOCOL.md §3)
    const now = Date.now();
    if (now - session.windowStart >= 1000) {
      session.windowStart = now;
      session.windowCount = 0;
    }
    session.windowCount += 1;
    if (session.windowCount > config.game.rateLimitPerSec) {
      sendError(session, "rate_limited", `초당 ${config.game.rateLimitPerSec}개 초과`);
      session.ws.close(1008, "rate limited");
      return;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(data.toString("utf8"));
    } catch {
      sendError(session, "bad_request", "JSON 파싱 실패");
      return;
    }
    const type = (raw as { type?: unknown })?.type;
    if (typeof type !== "string") {
      sendError(session, "bad_request", "type 필드 누락");
      return;
    }

    if (type === "login") {
      handleLogin(session, raw);
      return;
    }
    if (!session.player) {
      sendError(session, "not_logged_in", "login이 먼저다");
      return;
    }
    const p = session.player;

    switch (type) {
      case "move_to": {
        const msg = moveSchema.safeParse(raw);
        if (!msg.success) return sendError(session, "bad_request", "move_to: x, y 숫자 필요");
        const { cancelledGather } = world.moveTo(p, msg.data.x, msg.data.y);
        if (cancelledGather) send(session, { type: "gather_failed", nodeId: cancelledGather, reason: "moved" });
        return;
      }
      case "stop":
        world.stop(p);
        return;
      case "chat": {
        const msg = chatSchema.safeParse(raw);
        if (!msg.success) return sendError(session, "bad_request", `chat: 1~${GAME.MAX_CHAT_LEN}자`);
        broadcast({ type: "chat", from: p.id, name: p.name, text: msg.data.text, t: now });
        return;
      }
      case "gather": {
        const msg = gatherSchema.safeParse(raw);
        if (!msg.success) return sendError(session, "bad_request", "gather: nodeId 필요");
        const r = world.tryGather(p, msg.data.nodeId, now);
        if (r.ok) send(session, { type: "gather_started", nodeId: msg.data.nodeId, endsAt: r.endsAt });
        else send(session, { type: "gather_failed", nodeId: msg.data.nodeId, reason: r.reason });
        return;
      }
      case "ping": {
        const msg = pingSchema.safeParse(raw);
        if (!msg.success) return sendError(session, "bad_request", "ping: t 숫자 필요");
        send(session, { type: "pong", t: msg.data.t });
        return;
      }
      default:
        sendError(session, "unknown_type", `모르는 type: ${type}`);
    }
  }

  function handleLogin(session: Session, raw: unknown): void {
    if (session.player) return sendError(session, "bad_request", "이미 로그인됨");
    const msg = loginSchema.safeParse(raw);
    if (!msg.success) return sendError(session, "bad_request", "name: 2~16자 [a-zA-Z0-9가-힣_-]");
    const { name, token } = msg.data;

    let account = save.accounts[name];
    if (account) {
      if (token !== account.token) return sendError(session, "auth_failed", "이름-토큰 불일치");
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

    // 같은 계정의 기존 접속은 새 연결이 승계한다 (PROTOCOL.md §4)
    const old = byPlayerId.get(playerId);
    if (old) {
      old.player = null; // close 핸들러가 월드를 건드리지 않게 분리
      old.ws.close(1000, "superseded");
      world.removePlayer(playerId);
    }

    const p = world.addPlayer(playerId, name, account.x, account.y, account.inventory);
    session.player = p;
    session.accountName = name;
    byPlayerId.set(playerId, session);
    if (session.loginTimer) {
      clearTimeout(session.loginTimer);
      session.loginTimer = null;
    }

    send(session, {
      type: "welcome",
      protocol: PROTOCOL_VERSION,
      playerId,
      token: account.token,
      you: world.playerView(p),
      map: world.map,
      players: [...world.players.values()].filter((q) => q.id !== playerId).map((q) => world.playerView(q)),
      nodes: world.snapshotNodes(),
      inventory: { ...p.inventory },
    });
    if (!old) broadcastExcept(session, { type: "player_joined", player: world.playerView(p) });
  }

  // ---- 틱 루프 ----
  const tickTimer = setInterval(() => {
    const now = Date.now();
    for (const ev of world.tick(now, config.game.tickMs)) dispatchEvent(ev, now);
  }, config.game.tickMs);

  function dispatchEvent(ev: WorldEvent, now: number): void {
    switch (ev.kind) {
      case "moved":
        broadcast({ type: "state", t: now, players: ev.players });
        return;
      case "gather_done": {
        const s = byPlayerId.get(ev.playerId);
        if (s?.player)
          send(s, {
            type: "gather_result",
            nodeId: ev.nodeId,
            item: ev.item,
            count: ev.count,
            inventory: { ...s.player.inventory },
          });
        return;
      }
      case "gather_fail": {
        const s = byPlayerId.get(ev.playerId);
        if (s) send(s, { type: "gather_failed", nodeId: ev.nodeId, reason: ev.reason });
        return;
      }
      case "node_changed":
        broadcast({ type: "node_update", node: ev.node });
        return;
    }
  }

  // ---- 저장 ----
  function persistPlayer(session: Session): void {
    if (!session.player || !session.accountName) return;
    const account = save.accounts[session.accountName];
    if (!account) return;
    account.x = session.player.x;
    account.y = session.player.y;
    account.inventory = session.player.inventory;
  }

  async function saveAll(): Promise<void> {
    for (const s of sessions) persistPlayer(s);
    await storage.save(save);
  }

  const autosaveTimer = setInterval(() => {
    void saveAll().catch((err) => console.error("[storage] autosave 실패:", err));
  }, config.autosaveSec * 1000);

  // ---- 송신 헬퍼 ----
  function send(session: Session, msg: ServerMsg): void {
    if (session.ws.readyState === WebSocket.OPEN) session.ws.send(JSON.stringify(msg));
  }
  function sendError(session: Session, code: ErrorCode, message: string): void {
    send(session, { type: "error", code, message });
  }
  function broadcast(msg: ServerMsg): void {
    const raw = JSON.stringify(msg);
    for (const s of sessions) if (s.player && s.ws.readyState === WebSocket.OPEN) s.ws.send(raw);
  }
  function broadcastExcept(except: Session, msg: ServerMsg): void {
    const raw = JSON.stringify(msg);
    for (const s of sessions)
      if (s !== except && s.player && s.ws.readyState === WebSocket.OPEN) s.ws.send(raw);
  }

  // ---- 기동 ----
  await new Promise<void>((res, rej) => {
    httpServer.once("error", rej);
    httpServer.listen(config.port, config.host, res);
  });
  const addr = httpServer.address();
  const port = typeof addr === "object" && addr ? addr.port : config.port;

  return {
    port,
    async close() {
      clearInterval(tickTimer);
      clearInterval(autosaveTimer);
      await saveAll().catch((err) => console.error("[storage] 종료 저장 실패:", err));
      for (const s of sessions) s.ws.close(1001, "server shutdown");
      await new Promise<void>((res) => wss.close(() => res()));
      await new Promise<void>((res) => httpServer.close(() => res()));
    },
  };
}

// ---- 정적 파일 (프로덕션: 서버 하나가 클라이언트도 서빙 — 단일 프로세스 이식성) ----
function defaultClientDist(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const p = resolve(here, "../../client/dist");
  return existsSync(p) ? p : null;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
};

async function handleHttp(req: IncomingMessage, res: ServerResponse, clientDist: string | null): Promise<void> {
  const path = (req.url ?? "/").split("?")[0] ?? "/";
  if (path === "/health") return sendJson(res, { ok: true });
  if (path === "/config.json") return sendJson(res, { wsPath: WS_PATH });

  if (clientDist && req.method === "GET") {
    const rel = path === "/" ? "index.html" : path.slice(1);
    const file = normalize(join(clientDist, rel));
    if (file.startsWith(normalize(clientDist)) && existsSync(file)) {
      try {
        const body = await readFile(file);
        res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
        res.end(body);
        return;
      } catch {
        /* fall through */
      }
    }
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}

function sendJson(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
