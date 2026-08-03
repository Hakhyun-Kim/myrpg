// MyRPG 공유 계약 정의. 규범 문서는 루트 PROTOCOL.md — 여기가 문서와 어긋나면 버그다.
// 전송: Colyseus 0.15 (D7). 상태는 룸 스키마로 자동 동기화, 행동·이벤트는 룸 메시지로.

export const PROTOCOL_VERSION = "0.3";
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
  TRADE_RANGE: 96, // 대면 거래 가능 거리 (px)
  TRADE_REQUEST_TTL_MS: 30_000,
  // ---- 시장 (GDD §8.1, §9.1) ----
  MARKET_LISTING_FEE_PCT: 2, // 등록 수수료 (미체결에도 환불 없음)
  MARKET_TRADE_FEE_PCT: 3, // 체결 수수료 (판매 대금에서 공제)
  MARKET_ORDER_TTL_MS: 7 * 24 * 3600_000, // 주문 유효 7일
  MARKET_MAX_ORDERS_PER_PLAYER: 12,
  REF_PRICE_WINDOW_MS: 30 * 24 * 3600_000, // 기준가 = 최근 30일 체결 가중평균
  NPC_BUY_PCT: 60, // NPC가 플레이어에게서 살 때 (기준가 대비)
  NPC_SELL_PCT: 200, // NPC가 플레이어에게 팔 때
  /**
   * NPC 매입 일일 한도 (계정당 개수). NPC 매입은 안전망이지 주 수입원이면 안 된다 —
   * 봇 시뮬에서 한도가 헐거우면 즉시 화폐 인플레로 이어졌다.
   */
  NPC_DAILY_BUY_LIMIT: 24,
  // ---- 일일 납품 계약 (GDD §12.2) — 완제품의 소비처이자 수요 충격 장치 ----
  CONTRACT_COUNT: 3, // 매일 갱신되는 계약 수
  CONTRACT_PRICE_PCT: 140, // 기준가 대비 매입 단가
  CONTRACT_QTY_PER_BOT: 2, // 활성 인구 1인당 요구 수량 (규모 자동 조정)
  /**
   * 채집 도구 (P2 "모든 아이템은 결국 사라진다"의 최소 구현).
   * 완제품 수요가 NPC 계약뿐이면 그건 화폐 발행이다 — 플레이어 내부의 소비처가 있어야
   * 채집직 → 원료 → 가공직 → 도구 → 채집직으로 고리가 닫힌다.
   */
  TOOL_ITEM: "copper_knife",
  TOOL_USES: 40, // 도구 1개로 가능한 채집 횟수
  TOOL_MISSING_PENALTY: 0.5, // 도구 없이 채집할 때 산출 배율
  // ---- 일일 유지비 (GDD §8.4 Sink: 창고·큐 슬롯 임대료) ----
  UPKEEP_BASE: 120, // 계정당 하루
  UPKEEP_PER_ORDER: 12, // 미체결 주문 1건당 (장부를 오래 점유하는 비용)
  // ---- 마스터리 (GDD §5.2) ----
  MASTERY_BUDGET_START: 40,
  SKILL_MAX_LEVEL: 50,
  XP_GATHER: 2, // 채집 1회
  XP_CRAFT_UNIT: 3, // 가공 1개 완성
  YIELD_BONUS_PER_LEVEL: 0.005, // 레벨당 +0.5% 추가 산출 확률
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
  copper_knife: {
    id: "copper_knife",
    label: "구리 단검",
    skill: "대장",
    tier: 1,
    input: { copper_ingot: 1, plank: 1 },
    output: "copper_knife",
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
  copper_knife: "구리 단검",
};

/** 거래 가능한 전체 품목 (시장·NPC 검증용) */
export const TRADABLE_ITEMS = Object.keys(ITEM_LABELS);

/**
 * 체결 이력이 없을 때의 기준가 초기값 (은화) — 30일 이동평균이 쌓이면 대체됨.
 * 단위가 작으면(1~5은) 수수료 올림이 거래액의 수십 %가 되어 경제가 말라붙는다 —
 * 봇 시뮬이 잡아낸 문제라 T1을 20은대로 잡았다.
 */
export const DEFAULT_REF_PRICE: Record<string, number> = {
  wood: 20,
  copper_ore: 30,
  herb: 20,
  plank: 60,
  copper_ingot: 80,
  herb_extract: 60,
  copper_knife: 220,
};

/** NPC 상시 취급 품목 — T1 원자재만 (P1: 완제품은 취급 안 함. 단, 매수는 모든 품목 = 가격 바닥) */
export const NPC_SELL_ITEMS = ["wood", "copper_ore", "herb"];

/** 일일 납품 계약의 대상 — 가공품·완제품 (채집물은 제외: 소비처는 사슬 위쪽에 있어야 한다) */
export const CONTRACT_ITEMS = ["plank", "copper_ingot", "herb_extract", "copper_knife"];

export interface ContractView {
  item: string;
  price: number; // 개당 은화 (기준가 140%)
  remaining: number;
  total: number;
}
export interface ContractsMsg {
  contracts: ContractView[];
  resetsAt: number;
}
export interface DeliverMsg {
  item: string;
  qty: number;
}

// ---- 스킬 (마스터리) ----
export const SKILL_LABELS: Record<string, string> = {
  logging: "벌목",
  mining: "채광",
  herbalism: "약초학",
  sawing: "제재",
  smelting: "제련",
  alchemy: "조제",
  smithing: "대장",
};
export const NODE_SKILL: Record<NodeKind, string> = {
  tree: "logging",
  rock: "mining",
  herb: "herbalism",
};
export const CRAFT_SKILL: Record<string, string> = {
  제재: "sawing",
  제련: "smelting",
  조제: "alchemy",
  대장: "smithing",
};

export interface SkillView {
  level: number;
  xp: number; // 다음 레벨까지의 진행 xp
  xpNeeded: number;
}
export interface SkillsMsg {
  skills: Record<string, SkillView>;
  budgetUsed: number;
  budgetTotal: number;
}

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

// ---- 대면 거래 (§8) ----
export interface TradeRequestMsg {
  playerId: string; // 대상
}
export interface TradeRespondMsg {
  accept: boolean;
}
export interface TradeOfferMsg {
  items: Inventory; // 내 제안 전체 교체
}
// "trade_accept" / "trade_cancel": 페이로드 없음

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
  silver?: number;
}

// ---- 거래 S→C ----
export interface TradeRequestedMsg {
  from: string;
  name: string;
}
export interface TradeOpenMsg {
  partner: { id: string; name: string };
}
export interface TradeUpdateMsg {
  myOffer: Inventory;
  partnerOffer: Inventory;
  myAccept: boolean;
  partnerAccept: boolean;
}
export interface TradeDoneMsg {
  gave: Inventory;
  received: Inventory;
  inventory: Inventory;
}
export type TradeCloseReason =
  | "declined"
  | "cancelled"
  | "too_far"
  | "partner_left"
  | "invalid_offer"
  | "expired";
export interface TradeClosedMsg {
  reason: TradeCloseReason;
}
export type TradeFailReason = "self" | "busy" | "not_found" | "too_far" | "invalid_offer";
export interface TradeFailedMsg {
  reason: TradeFailReason;
}

// ---- 시장: 위탁 거래소 (§9) ----
export type OrderSide = "buy" | "sell";

export interface OrderView {
  id: string;
  side: OrderSide;
  item: string;
  price: number; // 개당 은화
  remaining: number;
  total: number;
  expiresAt: number;
}

/** 호가창 한 줄 (같은 가격 집계) */
export interface DepthLevel {
  price: number;
  qty: number;
}

export interface MarketBookMsg {
  item: string;
  bids: DepthLevel[]; // 매수, 높은 가격 우선
  asks: DepthLevel[]; // 매도, 낮은 가격 우선
  refPrice: number;
  npcBuy: number; // NPC 매입가 (내가 즉시 팔 수 있는 가격)
  npcSell: number | null; // NPC 판매가 (null = NPC가 팔지 않는 품목)
  lastPrice: number | null;
  dayVolume: number;
}

export interface MyOrdersMsg {
  orders: OrderView[];
  silver: number;
}

export interface FillEvent {
  orderId: string;
  side: OrderSide;
  item: string;
  qty: number;
  price: number;
  fee: number; // 판매자에게서 공제된 수수료 (매수 측은 0)
  counterparty: string; // 상대 이름 (NPC면 "상점")
}

export interface MarketFillsMsg {
  fills: FillEvent[];
  silver: number;
  inventory: Inventory;
}

export type MarketFailReason =
  | "unknown_item"
  | "bad_price"
  | "bad_qty"
  | "no_silver"
  | "no_items"
  | "too_many_orders"
  | "not_found"
  | "npc_limit"
  | "no_contract";

export interface MarketFailedMsg {
  reason: MarketFailReason;
}

// C→S
export interface MarketOrderMsg {
  side: OrderSide;
  item: string;
  price: number;
  qty: number;
}
export interface MarketCancelMsg {
  orderId: string;
}
export interface MarketBookReqMsg {
  item: string;
}
export interface NpcTradeMsg {
  side: OrderSide; // buy = NPC에게서 산다, sell = NPC에게 판다
  item: string;
  qty: number;
}

export interface WelcomeMsg {
  protocol: string;
  playerId: string; // 상태 스키마 players 맵에서 나의 키
  token: string;
  inventory: Inventory;
  silver: number;
  queue: QueueStateMsg;
  skills: SkillsMsg;
  orders: OrderView[];
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
