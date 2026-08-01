// MyRPG 공유 계약 정의. 규범 문서는 루트 PROTOCOL.md — 여기가 문서와 어긋나면 버그다.
// 전송: Colyseus 0.15 (D7). 상태는 룸 스키마로 자동 동기화, 행동·이벤트는 룸 메시지로.

export const PROTOCOL_VERSION = "0.2";
export const ROOM_NAME = "haran";

// ---- 게임 상수 (서버 권위 물리 — 클라이언트는 표시용으로만 사용) ----
export const GAME = {
  TICK_MS: 100,
  MOVE_SPEED: 160, // px/초
  GATHER_MS: 3000,
  GATHER_RANGE: 48, // px
  NODE_CAPACITY: 5,
  NODE_RESPAWN_MS: 30_000,
  RATE_LIMIT_PER_SEC: 20,
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

// ---- 룸 입장 옵션 (joinOrCreate 두 번째 인자) ----
export interface JoinOptions {
  name: string;
  token?: string;
}

// ---- C→S 룸 메시지 페이로드 ----
export interface MoveToMsg {
  x: number;
  y: number;
}
export interface ChatSendMsg {
  text: string;
}
export interface GatherMsg {
  nodeId: string;
}
// "hello": 페이로드 없음 — 핸들러 등록 후 welcome을 요청하는 핸드셰이크

// ---- S→C 룸 메시지 페이로드 ----
export interface WelcomeMsg {
  protocol: string;
  playerId: string; // 상태 스키마 players 맵에서 나의 키
  token: string;
  inventory: Inventory;
}
export interface ChatMsg {
  from: string;
  name: string;
  text: string;
  t: number;
}
export interface GatherStartedMsg {
  nodeId: string;
  endsAt: number;
}
export type GatherFailReason = "too_far" | "depleted" | "busy" | "moved" | "not_found";
export interface GatherFailedMsg {
  nodeId: string;
  reason: GatherFailReason;
}
export interface GatherResultMsg {
  nodeId: string;
  item: string;
  count: number;
  inventory: Inventory;
}

export function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}
