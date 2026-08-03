// TradeManager 단위 테스트 — 가짜 env로 규칙 검증
import { beforeEach, describe, expect, it } from "vitest";
import { TradeManager, type TradeEnv } from "../src/trade.js";
import type { Inventory } from "@myrpg/protocol";

interface Sent {
  pid: string;
  type: string;
  payload: any;
}

let positions: Record<string, { x: number; y: number } | null>;
let inventories: Record<string, Inventory>;
let sent: Sent[];
let tm: TradeManager;

const env: TradeEnv = {
  name: (pid) => pid.toUpperCase(),
  pos: (pid) => positions[pid] ?? null,
  inventory: (pid) => inventories[pid] ?? null,
  send: (pid, type, payload) => sent.push({ pid, type, payload }),
};

function last(pid: string, type: string): Sent | undefined {
  return [...sent].reverse().find((s) => s.pid === pid && s.type === type);
}

beforeEach(() => {
  positions = { a: { x: 0, y: 0 }, b: { x: 50, y: 0 }, far: { x: 500, y: 0 } };
  inventories = { a: { wood: 3 }, b: { herb: 2 }, far: {} };
  sent = [];
  tm = new TradeManager(env, 96, 30_000);
});

function openTrade(): void {
  tm.request("a", "b", 0);
  tm.respond("b", true);
}

describe("TradeManager", () => {
  it("정상 흐름: 요청→수락→제안→양측 확정→원자적 교환", () => {
    tm.request("a", "b", 0);
    expect(last("b", "trade_requested")?.payload).toEqual({ from: "a", name: "A" });

    tm.respond("b", true);
    expect(last("a", "trade_open")?.payload.partner.id).toBe("b");
    expect(last("b", "trade_open")?.payload.partner.id).toBe("a");

    tm.offer("a", { wood: 2 });
    tm.offer("b", { herb: 1 });
    tm.accept("a");
    expect(last("b", "trade_update")?.payload.partnerAccept).toBe(true);
    tm.accept("b");

    expect(last("a", "trade_done")?.payload).toEqual({
      gave: { wood: 2 },
      received: { herb: 1 },
      inventory: { wood: 1, herb: 1 },
    });
    expect(inventories["b"]).toEqual({ herb: 1, wood: 2 });
    expect(tm.inTrade("a")).toBe(false);
  });

  it("제안 변경은 양측 확정을 해제한다", () => {
    openTrade();
    tm.offer("a", { wood: 1 });
    tm.accept("a");
    tm.offer("b", { herb: 1 }); // b의 제안 변경 → a의 확정도 해제
    tm.accept("b");
    expect(tm.inTrade("a")).toBe(true); // 아직 교환 안 됨 (a 재확정 필요)
    tm.accept("a");
    expect(tm.inTrade("a")).toBe(false); // 이제 완료
  });

  it("보유하지 않은 물건은 제안 불가, 교환 직전 재고 재검증", () => {
    openTrade();
    tm.offer("a", { wood: 99 });
    expect(last("a", "trade_failed")?.payload.reason).toBe("invalid_offer");

    tm.offer("a", { wood: 3 });
    tm.accept("a");
    inventories["a"] = { wood: 1 }; // 거래 중 재고가 줄었다 (다른 경로로 소모)
    tm.accept("b");
    expect(last("a", "trade_closed")?.payload.reason).toBe("invalid_offer");
    expect(inventories["b"]).toEqual({ herb: 2 }); // 아무것도 안 넘어감
  });

  it("거절·취소·이탈·거리·만료", () => {
    tm.request("a", "b", 0);
    tm.respond("b", false);
    expect(last("a", "trade_closed")?.payload.reason).toBe("declined");

    tm.request("a", "far", 0);
    expect(last("a", "trade_failed")?.payload.reason).toBe("too_far");

    openTrade();
    tm.cancel("b");
    expect(last("a", "trade_closed")?.payload.reason).toBe("cancelled");

    openTrade();
    tm.onDisconnect("b");
    expect(last("a", "trade_closed")?.payload.reason).toBe("partner_left");

    openTrade();
    positions["b"] = { x: 5000, y: 0 };
    tm.tick(1000);
    expect(last("a", "trade_closed")?.payload.reason).toBe("too_far");

    positions["b"] = { x: 50, y: 0 };
    tm.request("a", "b", 0);
    tm.tick(31_000);
    expect(last("a", "trade_closed")?.payload.reason).toBe("expired");
    sent = []; // 이후 기록만 검사
    tm.respond("b", true); // 만료된 요청은 무효
    expect(last("b", "trade_open")).toBeUndefined();
  });

  it("거래 중에는 새 요청을 받을 수 없다", () => {
    openTrade();
    tm.request("far", "a", 0);
    expect(last("far", "trade_failed")?.payload.reason).toBe("busy");
  });
});
