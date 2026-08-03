// 위탁 거래소 — 매칭·에스크로·수수료·환급·만료·NPC 밴드 검증
import { beforeEach, describe, expect, it } from "vitest";
import { GAME } from "@myrpg/protocol";
import { emptyMarket, Market, type MarketData } from "../src/market.js";
import type { Account, SaveData } from "../src/storage.js";

let save: SaveData;
let data: MarketData;
let m: Market;
const T0 = 1_700_000_000_000;

function acc(name: string, silver: number, inventory: Record<string, number> = {}): Account {
  return { name, token: "t", x: 0, y: 0, inventory, silver };
}

beforeEach(() => {
  save = { version: 1, accounts: {} };
  data = emptyMarket();
  m = new Market(save, data);
  save.accounts["seller"] = acc("seller", 100, { copper_ingot: 10 });
  save.accounts["buyer"] = acc("buyer", 1000);
});

const seller = () => save.accounts["seller"]!;
const buyer = () => save.accounts["buyer"]!;

describe("Market", () => {
  it("매도 등록 → 매수 체결: 에스크로·수수료·정산", () => {
    // 매도 10개 @10은 — 등록 수수료 2% = 2은
    const r1 = m.place(seller(), "sell", "copper_ingot", 10, 10, T0);
    expect(r1.ok).toBe(true);
    expect(seller().silver).toBe(98); // 100 - 2
    expect(seller().inventory["copper_ingot"]).toBeUndefined(); // 전량 에스크로

    // 매수 4개 @12은 → 메이커 가격 10은에 체결
    const r2 = m.place(buyer(), "buy", "copper_ingot", 12, 4, T0 + 1000);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.mine).toHaveLength(1);
    expect(r2.mine[0]!.price).toBe(10);
    expect(r2.mine[0]!.qty).toBe(4);

    expect(buyer().inventory["copper_ingot"]).toBe(4);
    // 매수: 등록수수료 ceil(12*4*2%)=1, 에스크로 48, 체결가 차액 환급 (12-10)*4=8
    expect(buyer().silver).toBe(1000 - 1 - 48 + 8);
    // 매도: 대금 40 - 체결수수료 ceil(40*3%)=2
    expect(seller().silver).toBe(98 + 40 - 2);

    const book = m.book("copper_ingot", T0 + 2000);
    expect(book.asks[0]).toEqual({ price: 10, qty: 6 }); // 부분 체결 잔량
    expect(book.lastPrice).toBe(10);
    expect(book.dayVolume).toBe(4);
  });

  it("기준가는 최근 체결의 수량가중평균", () => {
    m.place(seller(), "sell", "copper_ingot", 10, 2, T0);
    m.place(buyer(), "buy", "copper_ingot", 10, 2, T0);
    save.accounts["seller"]!.inventory["copper_ingot"] = 8;
    m.place(seller(), "sell", "copper_ingot", 20, 6, T0);
    m.place(buyer(), "buy", "copper_ingot", 20, 6, T0);
    // (10*2 + 20*6) / 8 = 17.5 → 18
    expect(m.refPrice("copper_ingot", T0 + 1000)).toBe(18);
  });

  it("잔고·재고 부족과 자기 주문 체결 금지", () => {
    const poor = (save.accounts["poor"] = acc("poor", 1, { wood: 1 }));
    expect(m.place(poor, "buy", "wood", 100, 10, T0)).toEqual({ ok: false, reason: "no_silver" });
    expect(m.place(poor, "sell", "wood", 10, 5, T0)).toEqual({ ok: false, reason: "no_items" });

    // 자기 매도-매수는 체결되지 않는다 (수수료 세탁 방지)
    seller().silver = 500;
    m.place(seller(), "sell", "copper_ingot", 10, 5, T0);
    const r = m.place(seller(), "buy", "copper_ingot", 20, 5, T0);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.mine).toHaveLength(0);
  });

  it("취소·만료는 에스크로를 환급한다 (등록 수수료는 환불 없음)", () => {
    const r = m.place(seller(), "sell", "copper_ingot", 10, 10, T0);
    expect(r.ok).toBe(true);
    if (!r.ok || !r.order) return;
    m.cancel(seller(), r.order.id, T0 + 100);
    expect(seller().inventory["copper_ingot"]).toBe(10); // 물건 복귀
    expect(seller().silver).toBe(98); // 등록 수수료 2은은 소멸(Sink)

    const r2 = m.place(buyer(), "buy", "copper_ingot", 10, 5, T0);
    expect(r2.ok).toBe(true);
    const silverAfterPlace = buyer().silver!;
    m.expire(T0 + GAME.MARKET_ORDER_TTL_MS + 1);
    expect(buyer().silver).toBe(silverAfterPlace + 50); // 에스크로 환급
    expect(m.book("copper_ingot", T0 + GAME.MARKET_ORDER_TTL_MS + 2).bids).toHaveLength(0);
  });

  it("NPC 가격 밴드: 매입 60% / 판매 200%, 완제품은 팔지 않는다", () => {
    // 기준가를 만든다: copper_ingot 20은
    m.place(seller(), "sell", "copper_ingot", 20, 5, T0);
    m.place(buyer(), "buy", "copper_ingot", 20, 5, T0);
    const now = T0 + 1000;
    expect(m.refPrice("copper_ingot", now)).toBe(20);
    expect(m.npcBuyPrice("copper_ingot", now)).toBe(12); // 60%
    expect(m.npcSellPrice("copper_ingot", now)).toBeNull(); // 중간재는 NPC가 팔지 않음
    expect(m.npcSellPrice("wood", now)).toBe(40); // T1 원자재는 판매 (기준가 20 × 200%)

    // 플레이어 → NPC 매도 (바닥 가격)
    const p = (save.accounts["p"] = acc("p", 500, { copper_ingot: 3 }));
    const sold = m.npcTrade(p, "sell", "copper_ingot", 3, now);
    expect(sold).toMatchObject({ ok: true, unitPrice: 12 });
    expect(p.silver).toBe(536);

    // NPC → 플레이어 매수 (천장 가격)
    const bought = m.npcTrade(p, "buy", "wood", 4, now);
    expect(bought).toMatchObject({ ok: true, unitPrice: 40 });
    expect(p.inventory["wood"]).toBe(4);
    expect(p.silver).toBe(536 - 160);
    expect(m.npcTrade(p, "buy", "copper_ingot", 1, now)).toEqual({ ok: false, reason: "unknown_item" });
  });

  it("주문 수 상한", () => {
    const rich = (save.accounts["rich"] = acc("rich", 100_000));
    for (let i = 0; i < GAME.MARKET_MAX_ORDERS_PER_PLAYER; i++) {
      expect(m.place(rich, "buy", "wood", 5, 1, T0).ok).toBe(true);
    }
    expect(m.place(rich, "buy", "wood", 5, 1, T0)).toEqual({ ok: false, reason: "too_many_orders" });
  });

  it("여러 매도 호가를 낮은 가격부터 훑어 체결한다", () => {
    const s2 = (save.accounts["s2"] = acc("s2", 100, { wood: 20 }));
    m.place(seller(), "sell", "wood", 0 + 8, 3, T0); // seller에겐 wood가 없다 → 실패 확인용
    seller().inventory["wood"] = 5;
    m.place(seller(), "sell", "wood", 8, 5, T0);
    m.place(s2, "sell", "wood", 6, 4, T0 + 1);

    const r = m.place(buyer(), "buy", "wood", 10, 7, T0 + 2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mine.map((f) => [f.price, f.qty])).toEqual([
      [6, 4],
      [8, 3],
    ]);
    expect(buyer().inventory["wood"]).toBe(7);
  });
});
