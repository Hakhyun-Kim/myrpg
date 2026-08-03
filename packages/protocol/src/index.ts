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
  CRAFT_SLOTS: 3,
  CRAFT_MS_T1: 30_000,
  CRAFT_MAX_COUNT: 20, // 작업 1건당 최대 수량
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

// ---- 가공 레시피 (T1) — 원료 → 중간재. GDD §6 제작 체인의 첫 단 ----
export interface RecipeDef {
  id: string;
  label: string;
  skill: string; // 표시용 (마스터리 시스템은 Phase 2)
  tier: 1;
  input: Inventory;
  output: string;
  outputCount: number;
}

export const RECIPES: Record<string, RecipeDef> = {
  plank: {
    id: "plank",
    label: "판재",
    skill: "제재",
    tier: 1,
    input: { wood: 2 },
    output: "plank",
    outputCount: 1,
  },
  copper_ingot: {
    id: "copper_ingot",
    label: "구리 주괴",
    skill: "제련",
    tier: 1,
    input: { copper_ore: 2 },
    output: "copper_ingot",
    outputCount: 1,
  },
  herb_extract: {
    id: "herb_extract",
    label: "약초 추출액",
    skill: "조제",
    tier: 1,
    input: { herb: 2 },
    output: "herb_extract",
    outputCount: 1,
  },
};

export const ITEM_LABELS: Record<string, string> = {
  wood: "원목",
  copper_ore: "구리 광석",
  herb: "생약초",
  plank: "판재",
  copper_ingot: "구리 주괴",
  herb_extract: "약초 추출액",
};

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
export interface CraftMsg {
  recipeId: string;
  count: number; // 1 ~ CRAFT_MAX_COUNT
}
// "queue": 페이로드 없음 — 현재 큐 상태 요청 (queue_state로 응답)
// "claim": 페이로드 없음 — 완료품 전량 수령 (claim_result로 응답)
// "hello": 페이로드 없음 — 핸들러 등록 후 welcome을 요청하는 핸드셰이크

// ---- S→C 룸 메시지 페이로드 ----
export interface CraftJobView {
  id: string;
  recipeId: string;
  total: number;
  done: number; // 생산 완료되어 보관함으로 넘어간 수
  nextDoneAt: number; // 다음 1개 완성 시각 (Unix ms)
}

export interface QueueStateMsg {
  jobs: CraftJobView[];
  ready: Inventory; // 완료품 보관함 (claim으로 수령)
  slots: number; // 총 슬롯 수
}

export type CraftFailReason = "unknown_recipe" | "no_materials" | "slots_full" | "bad_count";

export interface CraftFailedMsg {
  recipeId: string;
  reason: CraftFailReason;
}

export interface ClaimResultMsg {
  claimed: Inventory;
  inventory: Inventory;
}

export interface InventoryMsg {
  inventory: Inventory; // 인벤토리 전체 스냅샷 (원료 차감 등 gather 외 변동 시)
}

export interface WelcomeMsg {
  protocol: string;
  playerId: string; // 상태 스키마 players 맵에서 나의 키
  token: string;
  inventory: Inventory;
  queue: QueueStateMsg;
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
