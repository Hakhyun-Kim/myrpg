// GameClient — MCP 도구가 사용하는 게임 접속 계층.
// 전용 API가 아니라 PROTOCOL.md의 WebSocket 프로토콜로 접속하는 "또 하나의 클라이언트"다 (P6).
// LLM 에이전트는 턴 단위로 사고하므로, 틱 스트림을 "행동 → 완료까지 대기" 형태로 감싸 준다.
import WebSocket from "ws";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  GAME,
  dist,
  type Inventory,
  type MapView,
  type NodeView,
  type PlayerView,
  type ServerMsg,
} from "@myrpg/protocol";

const TOKEN_DIR = process.env.MYRPG_DATA_DIR ?? "./data";
const TOKEN_FILE = join(TOKEN_DIR, "mcp-tokens.json");

export interface ChatLine {
  name: string;
  text: string;
  t: number;
}

type Listener = (msg: ServerMsg) => void;

export class GameClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();

  playerId = "";
  name = "";
  me = { x: 0, y: 0 };
  map: MapView = { id: "?", width: 0, height: 0 };
  players = new Map<string, PlayerView>();
  nodes = new Map<string, NodeView>();
  inventory: Inventory = {};
  chatLog: ChatLine[] = [];

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.playerId !== "";
  }

  async connect(url: string, name: string): Promise<void> {
    if (this.connected) throw new Error(`이미 ${this.name}(으)로 접속 중입니다. leave 후 다시 시도하세요.`);
    const ws = new WebSocket(url);
    this.ws = ws;
    await new Promise<void>((res, rej) => {
      ws.once("open", () => res());
      ws.once("error", (err) => rej(new Error(`서버 연결 실패 (${url}): ${err.message}`)));
    });
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as ServerMsg;
      this.apply(msg);
      for (const l of [...this.listeners]) l(msg);
    });
    ws.on("close", () => {
      this.playerId = "";
    });

    const token = loadTokens()[name];
    this.send({ type: "login", name, ...(token ? { token } : {}) });
    const first = await this.waitFor((m) => m.type === "welcome" || m.type === "error", 10_000);
    if (first.type === "error") {
      ws.close();
      throw new Error(`로그인 실패: ${first.code} — ${first.message}`);
    }
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
    this.playerId = "";
    this.players.clear();
    this.nodes.clear();
  }

  private apply(msg: ServerMsg): void {
    switch (msg.type) {
      case "welcome":
        this.playerId = msg.playerId;
        this.name = msg.you.name;
        this.me = { x: msg.you.x, y: msg.you.y };
        this.map = msg.map;
        this.inventory = msg.inventory;
        this.players = new Map(msg.players.map((p) => [p.id, p]));
        this.nodes = new Map(msg.nodes.map((n) => [n.id, n]));
        saveToken(msg.you.name, msg.token);
        return;
      case "state":
        for (const p of msg.players) {
          if (p.id === this.playerId) this.me = { x: p.x, y: p.y };
          else {
            const known = this.players.get(p.id);
            if (known) {
              known.x = p.x;
              known.y = p.y;
            }
          }
        }
        return;
      case "player_joined":
        this.players.set(msg.player.id, msg.player);
        return;
      case "player_left":
        this.players.delete(msg.id);
        return;
      case "node_update":
        this.nodes.set(msg.node.id, msg.node);
        return;
      case "gather_result":
        this.inventory = msg.inventory;
        return;
      case "chat":
        this.chatLog.push({ name: msg.name, text: msg.text, t: msg.t });
        if (this.chatLog.length > 30) this.chatLog.shift();
        return;
      default:
        return;
    }
  }

  send(msg: object): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("접속 상태가 아닙니다. join부터 하세요.");
    this.ws.send(JSON.stringify(msg));
  }

  waitFor(pred: (m: ServerMsg) => boolean, timeoutMs: number): Promise<ServerMsg> {
    return new Promise((resolve, reject) => {
      const listener: Listener = (m) => {
        if (!pred(m)) return;
        this.listeners.delete(listener);
        clearTimeout(timer);
        resolve(m);
      };
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        reject(new Error("응답 대기 시간 초과"));
      }, timeoutMs);
      this.listeners.add(listener);
    });
  }

  /** 목표점으로 이동하고 도착(2px 이내)까지 대기. 서버 클램프를 로컬에서도 적용해 판정. */
  async goto(x: number, y: number, timeoutMs = 30_000): Promise<void> {
    const tx = clamp(x, 0, this.map.width);
    const ty = clamp(y, 0, this.map.height);
    if (dist(this.me.x, this.me.y, tx, ty) <= 2) return;
    this.send({ type: "move_to", x: tx, y: ty });
    await this.waitFor(
      (m) => m.type === "state" && dist(this.me.x, this.me.y, tx, ty) <= 2,
      timeoutMs,
    );
  }

  /** 노드로 이동해 채집 1회. 결과 아이템을 반환. */
  async gatherNode(nodeId: string): Promise<{ item: string; count: number }> {
    const node = this.nodes.get(nodeId);
    if (!node) throw new Error(`모르는 노드: ${nodeId}`);
    if (node.remaining <= 0) throw new Error(`고갈된 노드: ${nodeId} (리스폰 대기 중)`);
    if (dist(this.me.x, this.me.y, node.x, node.y) > GAME.GATHER_RANGE) await this.goto(node.x, node.y);

    this.send({ type: "gather", nodeId });
    const started = await this.waitFor(
      (m) =>
        (m.type === "gather_started" || m.type === "gather_failed") && m.nodeId === nodeId,
      5000,
    );
    if (started.type === "gather_failed") throw new Error(`채집 거부: ${started.reason}`);
    const result = await this.waitFor(
      (m) =>
        (m.type === "gather_result" || m.type === "gather_failed") && m.nodeId === nodeId,
      GAME.GATHER_MS + 5000,
    );
    if (result.type === "gather_failed") throw new Error(`채집 실패: ${result.reason}`);
    if (result.type !== "gather_result") throw new Error("도달 불가");
    return { item: result.item, count: result.count };
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
    return {
      me: { id: this.playerId, name: this.name, x: Math.round(this.me.x), y: Math.round(this.me.y) },
      map: this.map,
      inventory: this.inventory,
      players: [...this.players.values()].map((p) => ({
        name: p.name,
        x: Math.round(p.x),
        y: Math.round(p.y),
      })),
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
