// 경제 시뮬레이션 회귀 테스트 — Phase 2 게이트.
// 밸런스 상수를 건드리면 여기가 먼저 깨진다. "사람이 모인 뒤 고치면 늦다"(GDD Phase 2).
import { describe, expect, it } from "vitest";
import { runSimulation } from "../src/sim.js";

describe("경제 시뮬레이션 (봇 20 × 7일)", () => {
  const seeds = [42, 1, 7, 99, 2024];

  it("Sink/Faucet이 목표 구간 0.9~1.0에 수렴한다 (전 시드)", () => {
    for (const seed of seeds) {
      const r = runSimulation({ bots: 20, days: 7, seed });
      expect(r.sinkFaucetRatio, `seed ${seed}`).toBeGreaterThanOrEqual(0.85);
      expect(r.sinkFaucetRatio, `seed ${seed}`).toBeLessThanOrEqual(1.1);
    }
  }, 60_000);

  it("가격이 발산하지 않는다 (기준가가 초기값의 0.5~2배 안)", () => {
    const r = runSimulation({ bots: 20, days: 7, seed: 42 });
    for (const [item, p] of Object.entries(r.prices)) {
      if (p.volume === 0) continue; // 거래가 없으면 기준가는 초기값 그대로
      expect(p.end, item).toBeGreaterThanOrEqual(p.start * 0.5);
      expect(p.end, item).toBeLessThanOrEqual(p.start * 2);
    }
  }, 30_000);

  it("플레이어 간 거래가 NPC 거래보다 크다 (P1: 경제의 주역은 플레이어)", () => {
    const r = runSimulation({ bots: 20, days: 7, seed: 42 });
    expect(r.npcShare).toBeLessThan(0.4);
    expect(r.trades).toBeGreaterThan(1000);
  }, 30_000);

  it("제작 사슬이 실제로 돈다 — 완제품(도구)이 유통된다", () => {
    const r = runSimulation({ bots: 20, days: 7, seed: 42 });
    expect(r.prices["copper_knife"]!.volume).toBeGreaterThan(100);
    expect(r.prices["copper_ingot"]!.volume).toBeGreaterThan(100);
    // 가공직이 스킬을 올릴 만큼 실제로 제작한다
    expect(r.roles["smelter"]!.level).toBeGreaterThan(5);
    expect(r.roles["smith"]!.level).toBeGreaterThan(5);
  }, 30_000);

  it("결과가 재현 가능하다 (같은 시드 = 같은 결과)", () => {
    const a = runSimulation({ bots: 10, days: 3, seed: 5 });
    const b = runSimulation({ bots: 10, days: 3, seed: 5 });
    expect(a.sinkFaucetRatio).toBe(b.sinkFaucetRatio);
    expect(a.trades).toBe(b.trades);
  }, 30_000);
});
