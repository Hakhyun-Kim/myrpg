// 대면 거래 — 1:1, 양측 확정, 원자적 교환. GDD §8.3.
// 안전 규칙: 제안이 바뀌면 양측 확정이 풀린다 · 교환 직전에 재고·거리를 다시 검증한다 ·
// 이탈·거리 이탈·요청 만료는 즉시 파기. 네트워크를 모르는 순수 로직 (env로 주입).
import { dist, type Inventory, type TradeCloseReason } from "@myrpg/protocol";

export interface TradeEnv {
  name(pid: string): string;
  pos(pid: string): { x: number; y: number } | null; // null = 오프라인
  inventory(pid: string): Inventory | null;
  send(pid: string, type: string, payload: unknown): void;
}

interface Trade {
  a: string;
  b: string;
  offers: Record<string, Inventory>;
  accepts: Record<string, boolean>;
}

interface PendingRequest {
  from: string;
  at: number;
}

export class TradeManager {
  private byPlayer = new Map<string, Trade>();
  private requests = new Map<string, PendingRequest>(); // key: 요청받은 쪽(pid)

  constructor(
    private env: TradeEnv,
    private range: number,
    private requestTtlMs: number,
  ) {}

  inTrade(pid: string): boolean {
    return this.byPlayer.has(pid);
  }

  request(from: string, target: string, now: number): void {
    if (from === target) return this.env.send(from, "trade_failed", { reason: "self" });
    if (this.byPlayer.has(from) || this.byPlayer.has(target))
      return this.env.send(from, "trade_failed", { reason: "busy" });
    const pf = this.env.pos(from);
    const pt = this.env.pos(target);
    if (!pf || !pt) return this.env.send(from, "trade_failed", { reason: "not_found" });
    if (dist(pf.x, pf.y, pt.x, pt.y) > this.range)
      return this.env.send(from, "trade_failed", { reason: "too_far" });
    this.requests.set(target, { from, at: now });
    this.env.send(target, "trade_requested", { from, name: this.env.name(from) });
  }

  respond(target: string, accept: boolean): void {
    const req = this.requests.get(target);
    if (!req) return;
    this.requests.delete(target);
    const from = req.from;
    if (!accept) return this.env.send(from, "trade_closed", { reason: "declined" });
    if (this.byPlayer.has(from) || this.byPlayer.has(target))
      return this.env.send(from, "trade_closed", { reason: "cancelled" });
    const pf = this.env.pos(from);
    const pt = this.env.pos(target);
    if (!pf || !pt) return this.env.send(target, "trade_closed", { reason: "partner_left" });
    if (dist(pf.x, pf.y, pt.x, pt.y) > this.range) {
      this.env.send(from, "trade_closed", { reason: "too_far" });
      this.env.send(target, "trade_closed", { reason: "too_far" });
      return;
    }
    const trade: Trade = {
      a: from,
      b: target,
      offers: { [from]: {}, [target]: {} },
      accepts: { [from]: false, [target]: false },
    };
    this.byPlayer.set(from, trade);
    this.byPlayer.set(target, trade);
    this.env.send(from, "trade_open", { partner: { id: target, name: this.env.name(target) } });
    this.env.send(target, "trade_open", { partner: { id: from, name: this.env.name(from) } });
    this.pushUpdate(trade);
  }

  offer(pid: string, items: Inventory): void {
    const trade = this.byPlayer.get(pid);
    if (!trade) return;
    const inv = this.env.inventory(pid);
    if (!inv || !hasAll(inv, items))
      return this.env.send(pid, "trade_failed", { reason: "invalid_offer" });
    trade.offers[pid] = { ...items };
    trade.accepts[trade.a] = false; // 제안 변경 = 양측 확정 해제
    trade.accepts[trade.b] = false;
    this.pushUpdate(trade);
  }

  accept(pid: string): void {
    const trade = this.byPlayer.get(pid);
    if (!trade) return;
    trade.accepts[pid] = true;
    if (trade.accepts[trade.a] && trade.accepts[trade.b]) this.complete(trade);
    else this.pushUpdate(trade);
  }

  cancel(pid: string): void {
    const trade = this.byPlayer.get(pid);
    if (trade) this.close(trade, "cancelled");
  }

  onDisconnect(pid: string): void {
    this.requests.delete(pid);
    for (const [target, req] of this.requests) if (req.from === pid) this.requests.delete(target);
    const trade = this.byPlayer.get(pid);
    if (trade) this.close(trade, "partner_left");
  }

  /** 주기 점검: 요청 만료, 거래 중 거리 이탈. */
  tick(now: number): void {
    for (const [target, req] of this.requests) {
      if (now - req.at > this.requestTtlMs) {
        this.requests.delete(target);
        this.env.send(req.from, "trade_closed", { reason: "expired" });
      }
    }
    for (const trade of new Set(this.byPlayer.values())) {
      const pa = this.env.pos(trade.a);
      const pb = this.env.pos(trade.b);
      if (!pa || !pb) this.close(trade, "partner_left");
      else if (dist(pa.x, pa.y, pb.x, pb.y) > this.range * 1.5) this.close(trade, "too_far");
    }
  }

  private complete(trade: Trade): void {
    const invA = this.env.inventory(trade.a);
    const invB = this.env.inventory(trade.b);
    const pa = this.env.pos(trade.a);
    const pb = this.env.pos(trade.b);
    if (!invA || !invB || !pa || !pb) return this.close(trade, "partner_left");
    if (dist(pa.x, pa.y, pb.x, pb.y) > this.range * 1.5) return this.close(trade, "too_far");
    const offerA = trade.offers[trade.a]!;
    const offerB = trade.offers[trade.b]!;
    // 최종 재고 검증 — 거래 중 채집·제작으로 재고가 변했을 수 있다
    if (!hasAll(invA, offerA) || !hasAll(invB, offerB)) return this.close(trade, "invalid_offer");

    subInv(invA, offerA);
    addInv(invB, offerA);
    subInv(invB, offerB);
    addInv(invA, offerB);

    this.env.send(trade.a, "trade_done", { gave: offerA, received: offerB, inventory: { ...invA } });
    this.env.send(trade.b, "trade_done", { gave: offerB, received: offerA, inventory: { ...invB } });
    this.byPlayer.delete(trade.a);
    this.byPlayer.delete(trade.b);
  }

  private close(trade: Trade, reason: TradeCloseReason): void {
    this.byPlayer.delete(trade.a);
    this.byPlayer.delete(trade.b);
    this.env.send(trade.a, "trade_closed", { reason });
    this.env.send(trade.b, "trade_closed", { reason });
  }

  private pushUpdate(trade: Trade): void {
    for (const [me, them] of [
      [trade.a, trade.b],
      [trade.b, trade.a],
    ] as const) {
      this.env.send(me, "trade_update", {
        myOffer: { ...trade.offers[me]! },
        partnerOffer: { ...trade.offers[them]! },
        myAccept: trade.accepts[me]!,
        partnerAccept: trade.accepts[them]!,
      });
    }
  }
}

// ---- 인벤토리 헬퍼 ----
function hasAll(inv: Inventory, items: Inventory): boolean {
  return Object.entries(items).every(
    ([item, n]) => Number.isInteger(n) && n > 0 && (inv[item] ?? 0) >= n,
  );
}
function addInv(inv: Inventory, items: Inventory): void {
  for (const [item, n] of Object.entries(items)) inv[item] = (inv[item] ?? 0) + n;
}
function subInv(inv: Inventory, items: Inventory): void {
  for (const [item, n] of Object.entries(items)) {
    inv[item] = (inv[item] ?? 0) - n;
    if (inv[item]! <= 0) delete inv[item];
  }
}
