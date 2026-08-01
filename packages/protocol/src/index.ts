// MyRPG 공유 프로토콜 정의. 규범 문서는 루트 PROTOCOL.md — 여기가 문서와 어긋나면 버그다.

export const PROTOCOL_VERSION = "0.1";
export const WS_PATH = "/ws";

// ---- 게임 상수 (서버 권위 물리 — 클라이언트는 표시용으로만 사용) ----
export const GAME = {
  TICK_MS: 100,
  MOVE_SPEED: 160, // px/초
  GATHER_MS: 3000,
  GATHER_RANGE: 48, // px
  NODE_CAPACITY: 5,
  NODE_RESPAWN_MS: 30_000,
  LOGIN_TIMEOUT_MS: 10_000,
  RATE_LIMIT_PER_SEC: 20,
  MAX_FRAME_BYTES: 4096,
  MAX_CHAT_LEN: 200,
  NAME_RE: /^[a-zA-Z0-9가-힣_-]{2,16}$/,
} as const;

export type NodeKind = "tree" | "rock" | "herb";
export const NODE_YIELD: Record<NodeKind, string> = {
  tree: "wood",
  rock: "copper_ore",
  herb: "herb",
};

export interface PlayerView {
  id: string;
  name: string;
  x: number;
  y: number;
}

export interface NodeView {
  id: string;
  kind: NodeKind;
  x: number;
  y: number;
  remaining: number;
}

export interface MapView {
  id: string;
  width: number;
  height: number;
}

export type Inventory = Record<string, number>;

// ---- C→S ----
export type ClientMsg =
  | { type: "login"; name: string; token?: string }
  | { type: "move_to"; x: number; y: number }
  | { type: "stop" }
  | { type: "chat"; text: string }
  | { type: "gather"; nodeId: string }
  | { type: "ping"; t: number };

// ---- S→C ----
export type ErrorCode =
  | "bad_request"
  | "unknown_type"
  | "auth_failed"
  | "not_logged_in"
  | "rate_limited";

export type GatherFailReason = "too_far" | "depleted" | "busy" | "moved" | "not_found";

export type ServerMsg =
  | {
      type: "welcome";
      protocol: string;
      playerId: string;
      token: string;
      you: PlayerView;
      map: MapView;
      players: PlayerView[];
      nodes: NodeView[];
      inventory: Inventory;
    }
  | { type: "error"; code: ErrorCode; message: string }
  | { type: "state"; t: number; players: { id: string; x: number; y: number }[] }
  | { type: "player_joined"; player: PlayerView }
  | { type: "player_left"; id: string }
  | { type: "chat"; from: string; name: string; text: string; t: number }
  | { type: "gather_started"; nodeId: string; endsAt: number }
  | { type: "gather_result"; nodeId: string; item: string; count: number; inventory: Inventory }
  | { type: "gather_failed"; nodeId: string; reason: GatherFailReason }
  | { type: "node_update"; node: NodeView }
  | { type: "pong"; t: number };

export function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}
