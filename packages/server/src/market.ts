// 위탁 거래소 — 가격-시간 우선 오더북, 에스크로, 부분 체결, 7일 만료.
// 네트워크를 모르는 순수 로직. 계정 저장소를 직접 다루므로 서버 권위가 유지된다.
//
// 에스크로 원칙: 주문 등록 시점에 물건(매도) 또는 은화(매수)를 계정에서 빼 둔다.
// 그래야 "팔기로 한 물건을 대면 거래로 넘긴 뒤 체결" 같은 이중 지출이 불가능하다.
import { randomBytes } from "node:crypto";
import {
  CONTRACT_ITEMS,
  DEFAULT_REF_PRICE,
  GAME,
  NPC_SELL_ITEMS,
  TRADABLE_ITEMS,
  type ContractView,
  type DepthLevel,
  type FillEvent,
  type Inventory,
  type MarketBookMsg,
  type MarketFailReason,
  type OrderSide,
  type OrderView,
} from "@myrpg/protocol";
import type { Account, SaveData } from "./storage.js";

export interface Order {
  id: string;
  side: OrderSide;
  item: string;
  price: number;
  remaining: number;
  total: number;
  owner: string; // account name
  createdAt: number;
  expiresAt: number;
}

/** 체결 기록 — 기준가(30일 이동평균)와 시세 차트의 원천 */
export interface TradeRecord {
  item: string;
  price: number;
  qty: number;
  at: number;
}

export interface Contract {
  item: string;
  price: number;
  remaining: number;
  total: number;
}

export interface MarketData {
  orders: Order[];
  history: TradeRecord[];
  /** 일일 납품 계약 (완제품 소비처). day는 T0 기준 일차 */
  contracts: Contract[];
  contractDay: number;
  /** 누적 계측 (경제 보고서용) */
  stats: {
    feesCollected: number; // Sink
    npcPaidOut: number; // Faucet (NPC 매입 지출)
    npcTakenIn: number; // Sink (NPC 판매 수입)
    contractPaidOut: number; // Faucet (납품 대금)
    upkeepCollected: number; // Sink (일일 유지비)
    volume: number;
  };
}

export function emptyMarket(): MarketData {
  return {
    orders: [],
    history: [],
    contracts: [],
    contractDay: -1,
    stats: {
      feesCollected: 0,
      npcPaidOut: 0,
      npcTakenIn: 0,
      contractPaidOut: 0,
      upkeepCollected: 0,
      volume: 0,
    },
  };
}

type Fail = { ok: false; reason: MarketFailReason };
const fail = (reason: MarketFailReason): Fail => ({ ok: false, reason });

export class Market {
  constructor(
    private save: SaveData,
    private data: MarketData,
  ) {}

  // ---- 조회 ----

  /** 기준가 = 최근 30일 체결의 수량가중평균. 이력이 없으면 초기값. */
  refPrice(item: string, now: number): number {
    const since = now - GAME.REF_PRICE_WINDOW_MS;
    let value = 0;
    let qty = 0;
    for (const r of this.data.history) {
      if (r.item !== item || r.at < since) continue;
      value += r.price * r.qty;
      qty += r.qty;
    }
    if (qty === 0) return DEFAULT_REF_PRICE[item] ?? 1;
    return Math.max(1, Math.round(value / qty));
  }

  npcBuyPrice(item: string, now: number): number {
    return Math.max(1, Math.floor((this.refPrice(item, now) * GAME.NPC_BUY_PCT) / 100));
  }

  npcSellPrice(item: string, now: number): number | null {
    if (!NPC_SELL_ITEMS.includes(item)) return null;
    return Math.max(1, Math.ceil((this.refPrice(item, now) * GAME.NPC_SELL_PCT) / 100));
  }

  book(item: string, now: number): MarketBookMsg {
    this.expire(now);
    const live = this.data.orders.filter((o) => o.item === item && o.remaining > 0);
    const dayAgo = now - 24 * 3600_000;
    const recent = this.data.history.filter((r) => r.item === item);
    return {
      item,
      bids: depth(live.filter((o) => o.side === "buy")).sort((a, b) => b.price - a.price).slice(0, 10),
      asks: depth(live.filter((o) => o.side === "sell")).sort((a, b) => a.price - b.price).slice(0, 10),
      refPrice: this.refPrice(item, now),
      npcBuy: this.npcBuyPrice(item, now),
      npcSell: this.npcSellPrice(item, now),
      lastPrice: recent.length > 0 ? recent[recent.length - 1]!.price : null,
      dayVolume: recent.filter((r) => r.at >= dayAgo).reduce((s, r) => s + r.qty, 0),
    };
  }

  myOrders(owner: string, now: number): OrderView[] {
    this.expire(now);
    return this.data.orders
      .filter((o) => o.owner === owner && o.remaining > 0)
      .map(view)
      .sort((a, b) => a.expiresAt - b.expiresAt);
  }

  // ---- 주문 ----

  /**
   * 주문 등록. 즉시 체결 가능한 반대편이 있으면 먼저 체결하고, 남으면 장부에 올린다.
   * 반환된 fills는 [주문자 몫, 상대방별 몫]으로 나뉘어 호출자가 통지한다.
   */
  place(
    account: Account,
    side: OrderSide,
    item: string,
    price: number,
    qty: number,
    now: number,
  ): { ok: true; mine: FillEvent[]; others: Map<string, FillEvent[]>; order: OrderView | null } | Fail {
    this.expire(now);
    if (!TRADABLE_ITEMS.includes(item)) return fail("unknown_item");
    if (!Number.isInteger(price) || price < 1 || price > 1_000_000) return fail("bad_price");
    if (!Number.isInteger(qty) || qty < 1 || qty > 9999) return fail("bad_qty");
    if (this.myOrders(account.name, now).length >= GAME.MARKET_MAX_ORDERS_PER_PLAYER)
      return fail("too_many_orders");

    // 등록 수수료 (미체결에도 환불 없음 — 유령 주문 억제)
    const listingFee = Math.ceil((price * qty * GAME.MARKET_LISTING_FEE_PCT) / 100);

    if (side === "sell") {
      if ((account.inventory[item] ?? 0) < qty) return fail("no_items");
      if ((account.silver ?? 0) < listingFee) return fail("no_silver");
    } else {
      const need = price * qty + listingFee;
      if ((account.silver ?? 0) < need) return fail("no_silver");
    }

    // 에스크로: 등록 시점에 자산을 뺀다
    account.silver = (account.silver ?? 0) - listingFee;
    this.data.stats.feesCollected += listingFee;
    if (side === "sell") {
      takeItem(account.inventory, item, qty);
    } else {
      account.silver -= price * qty;
    }

    const order: Order = {
      id: "o_" + randomBytes(5).toString("hex"),
      side,
      item,
      price,
      remaining: qty,
      total: qty,
      owner: account.name,
      createdAt: now,
      expiresAt: now + GAME.MARKET_ORDER_TTL_MS,
    };

    const mine: FillEvent[] = [];
    const others = new Map<string, FillEvent[]>();
    this.match(order, account, mine, others, now);

    if (order.remaining > 0) this.data.orders.push(order);
    return { ok: true, mine, others, order: order.remaining > 0 ? view(order) : null };
  }

  /** 신규 주문을 반대편 장부와 체결. 가격-시간 우선. */
  private match(
    taker: Order,
    takerAccount: Account,
    mine: FillEvent[],
    others: Map<string, FillEvent[]>,
    now: number,
  ): void {
    const opposite = this.data.orders
      .filter(
        (o) =>
          o.item === taker.item &&
          o.remaining > 0 &&
          o.side !== taker.side &&
          o.owner !== taker.owner && // 자기 주문끼리는 체결 안 함 (수수료 세탁 방지)
          (taker.side === "buy" ? o.price <= taker.price : o.price >= taker.price),
      )
      .sort((a, b) =>
        taker.side === "buy" ? a.price - b.price || a.createdAt - b.createdAt : b.price - a.price || a.createdAt - b.createdAt,
      );

    for (const maker of opposite) {
      if (taker.remaining === 0) break;
      const qty = Math.min(taker.remaining, maker.remaining);
      const price = maker.price; // 가격은 먼저 걸어둔 쪽(메이커) 기준
      const makerAccount = this.save.accounts[maker.owner];
      if (!makerAccount) continue;

      taker.remaining -= qty;
      maker.remaining -= qty;

      const gross = price * qty;
      const fee = Math.ceil((gross * GAME.MARKET_TRADE_FEE_PCT) / 100);
      this.data.stats.feesCollected += fee;
      this.data.stats.volume += gross;

      const buyer = taker.side === "buy" ? takerAccount : makerAccount;
      const seller = taker.side === "buy" ? makerAccount : takerAccount;

      // 물건 → 매수자
      addItem(buyer.inventory, taker.item, qty);
      // 은화 → 매도자 (수수료 공제). 매수자 은화는 등록 시 에스크로에서 이미 빠졌다.
      seller.silver = (seller.silver ?? 0) + gross - fee;
      // 매수 주문이 지정가보다 싸게 체결되면 차액 환급
      if (taker.side === "buy" && price < taker.price)
        takerAccount.silver = (takerAccount.silver ?? 0) + (taker.price - price) * qty;
      if (maker.side === "buy" && price < maker.price) {
        // 메이커 매수는 자기 가격에 체결되므로 환급 없음 (price === maker.price)
      }

      this.data.history.push({ item: taker.item, price, qty, at: now });

      const takerFill: FillEvent = {
        orderId: taker.id,
        side: taker.side,
        item: taker.item,
        qty,
        price,
        fee: taker.side === "sell" ? fee : 0,
        counterparty: maker.owner,
      };
      const makerFill: FillEvent = {
        orderId: maker.id,
        side: maker.side,
        item: maker.item,
        qty,
        price,
        fee: maker.side === "sell" ? fee : 0,
        counterparty: taker.owner,
      };
      mine.push(takerFill);
      const list = others.get(maker.owner) ?? [];
      list.push(makerFill);
      others.set(maker.owner, list);
    }

    this.data.orders = this.data.orders.filter((o) => o.remaining > 0);
  }

  /** 주문 취소 — 남은 에스크로를 돌려준다 (등록 수수료는 환불 없음). */
  cancel(account: Account, orderId: string, now: number): { ok: true } | Fail {
    this.expire(now);
    const idx = this.data.orders.findIndex((o) => o.id === orderId && o.owner === account.name);
    if (idx < 0) return fail("not_found");
    const [order] = this.data.orders.splice(idx, 1);
    this.refund(order!, account);
    return { ok: true };
  }

  /** 만료 주문 정리 — 접근 시점 정산 (제작 큐와 같은 패턴) */
  expire(now: number): void {
    const expired = this.data.orders.filter((o) => o.expiresAt <= now);
    if (expired.length === 0) return;
    this.data.orders = this.data.orders.filter((o) => o.expiresAt > now);
    for (const order of expired) {
      const account = this.save.accounts[order.owner];
      if (account) this.refund(order, account);
    }
  }

  private refund(order: Order, account: Account): void {
    if (order.remaining <= 0) return;
    if (order.side === "sell") addItem(account.inventory, order.item, order.remaining);
    else account.silver = (account.silver ?? 0) + order.price * order.remaining;
  }

  // ---- NPC 상시 거래 (가격 밴드 — §9.1) ----

  npcTrade(
    account: Account,
    side: OrderSide,
    item: string,
    qty: number,
    now: number,
  ): { ok: true; unitPrice: number; silver: number; sold?: number } | Fail {
    if (!TRADABLE_ITEMS.includes(item)) return fail("unknown_item");
    if (!Number.isInteger(qty) || qty < 1 || qty > 9999) return fail("bad_qty");

    if (side === "sell") {
      // 플레이어 → NPC (가격 바닥). 모든 품목 매입하되 일일 한도가 있다.
      if ((account.inventory[item] ?? 0) < qty) return fail("no_items");
      const day = Math.floor(now / 86_400_000);
      if (!account.npcSold || account.npcSold.day !== day) account.npcSold = { day, count: 0 };
      const allowed = Math.min(qty, GAME.NPC_DAILY_BUY_LIMIT - account.npcSold.count);
      if (allowed <= 0) return fail("npc_limit");
      const unit = this.npcBuyPrice(item, now);
      takeItem(account.inventory, item, allowed);
      account.npcSold.count += allowed;
      account.silver = (account.silver ?? 0) + unit * allowed;
      this.data.stats.npcPaidOut += unit * allowed;
      return { ok: true, unitPrice: unit, silver: account.silver, sold: allowed };
    }

    // NPC → 플레이어 (가격 천장). T1 원자재만.
    const unit = this.npcSellPrice(item, now);
    if (unit === null) return fail("unknown_item");
    const cost = unit * qty;
    if ((account.silver ?? 0) < cost) return fail("no_silver");
    account.silver = (account.silver ?? 0) - cost;
    addItem(account.inventory, item, qty);
    this.data.stats.npcTakenIn += cost;
    return { ok: true, unitPrice: unit, silver: account.silver };
  }

  // ---- 일일 납품 계약 (완제품 소비처 — GDD §12.2) ----

  /** 날짜가 바뀌면 계약 3건을 새로 뽑는다. 요구량은 활성 인구에 비례. */
  refreshContracts(now: number, activePopulation: number, rng: () => number = Math.random): void {
    const day = Math.floor(now / 86_400_000);
    if (this.data.contractDay === day) return;
    this.data.contractDay = day;
    const pool = [...CONTRACT_ITEMS];
    const picked: Contract[] = [];
    for (let i = 0; i < GAME.CONTRACT_COUNT && pool.length > 0; i++) {
      const item = pool.splice(Math.floor(rng() * pool.length), 1)[0]!;
      const qty = Math.max(4, Math.round(activePopulation * GAME.CONTRACT_QTY_PER_BOT * (0.7 + rng() * 0.6)));
      picked.push({
        item,
        price: Math.max(1, Math.round((this.refPrice(item, now) * GAME.CONTRACT_PRICE_PCT) / 100)),
        remaining: qty,
        total: qty,
      });
    }
    this.data.contracts = picked;
  }

  contracts(): ContractView[] {
    return this.data.contracts.map((c) => ({ ...c }));
  }

  /** 납품 — 계약 수량 안에서만. 체결가는 시세에 반영되지 않는다(NPC 수요는 기준가를 흔들면 안 된다). */
  deliver(
    account: Account,
    item: string,
    qty: number,
  ): { ok: true; delivered: number; unitPrice: number; silver: number } | Fail {
    const contract = this.data.contracts.find((c) => c.item === item && c.remaining > 0);
    if (!contract) return fail("no_contract");
    if (!Number.isInteger(qty) || qty < 1) return fail("bad_qty");
    const delivered = Math.min(qty, contract.remaining, account.inventory[item] ?? 0);
    if (delivered <= 0) return fail("no_items");
    takeItem(account.inventory, item, delivered);
    contract.remaining -= delivered;
    const pay = contract.price * delivered;
    account.silver = (account.silver ?? 0) + pay;
    this.data.stats.contractPaidOut += pay;
    return { ok: true, delivered, unitPrice: contract.price, silver: account.silver };
  }

  /**
   * 일일 유지비 징수 (Sink) — 창고·큐 슬롯 임대료 + 미체결 주문 점유료.
   * 잔고가 모자라면 가진 만큼만 걷는다 (빚은 만들지 않는다).
   */
  chargeUpkeep(account: Account, now: number): number {
    const day = Math.floor(now / 86_400_000);
    if (account.upkeepDay === day) return 0;
    const first = account.upkeepDay === undefined;
    account.upkeepDay = day;
    if (first) return 0; // 가입 첫날은 면제
    const orders = this.data.orders.filter((o) => o.owner === account.name && o.remaining > 0).length;
    const due = GAME.UPKEEP_BASE + orders * GAME.UPKEEP_PER_ORDER;
    const paid = Math.min(due, account.silver ?? 0);
    account.silver = (account.silver ?? 0) - paid;
    this.data.stats.upkeepCollected += paid;
    return paid;
  }

  /** 오래된 체결 이력 정리 (메모리 상한) */
  prune(now: number): void {
    const since = now - GAME.REF_PRICE_WINDOW_MS;
    this.data.history = this.data.history.filter((r) => r.at >= since);
  }

  get stats() {
    return this.data.stats;
  }
  get openOrders(): Order[] {
    return this.data.orders;
  }
  get history(): TradeRecord[] {
    return this.data.history;
  }
}

function depth(orders: Order[]): DepthLevel[] {
  const byPrice = new Map<number, number>();
  for (const o of orders) byPrice.set(o.price, (byPrice.get(o.price) ?? 0) + o.remaining);
  return [...byPrice].map(([price, qty]) => ({ price, qty }));
}

function view(o: Order): OrderView {
  return {
    id: o.id,
    side: o.side,
    item: o.item,
    price: o.price,
    remaining: o.remaining,
    total: o.total,
    expiresAt: o.expiresAt,
  };
}

function addItem(inv: Inventory, item: string, qty: number): void {
  inv[item] = (inv[item] ?? 0) + qty;
}
function takeItem(inv: Inventory, item: string, qty: number): void {
  inv[item] = (inv[item] ?? 0) - qty;
  if (inv[item]! <= 0) delete inv[item];
}
