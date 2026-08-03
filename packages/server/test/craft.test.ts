// 제작 큐 — 순수 로직(craft.ts) + 룸 메시지 계약 검증
import { describe, expect, it } from "vitest";
import { claim, queueView, settle, tryCraft } from "../src/craft.js";
import { defaultGameParams, type GameParams } from "../src/config.js";
import type { Account } from "../src/storage.js";

const params: GameParams = { ...defaultGameParams(), craftMsT1: 1000, craftSlots: 3 };

function account(inventory: Record<string, number>): Account {
  return { name: "t", token: "tk", x: 0, y: 0, inventory };
}

describe("craft 로직", () => {
  it("등록 시 원료 선불 차감, 시간이 지나면 완성분이 보관함으로", () => {
    const acc = account({ copper_ore: 5 });
    const t0 = 1_000_000;

    const r = tryCraft(acc, "copper_ingot", 2, t0, params);
    expect(r.ok).toBe(true);
    expect(acc.inventory["copper_ore"]).toBe(1); // 2개 × 광석2 = 4 차감

    settle(acc, t0 + 500, params);
    expect(acc.ready).toEqual({}); // 아직 1개도 안 됨

    settle(acc, t0 + 1500, params); // 1개 완성
    expect(acc.ready).toEqual({ copper_ingot: 1 });
    expect(acc.jobs!.length).toBe(1);

    settle(acc, t0 + 10_000, params); // 전부 완성 → 작업 제거
    expect(acc.ready).toEqual({ copper_ingot: 2 });
    expect(acc.jobs!.length).toBe(0);

    const claimed = claim(acc, t0 + 10_000, params);
    expect(claimed).toEqual({ copper_ingot: 2 });
    expect(acc.inventory["copper_ingot"]).toBe(2);
    expect(acc.ready).toEqual({});
  });

  it("오프라인 정산 — 중간 접근 없이 한참 뒤 한 번에 정산해도 결과 동일", () => {
    const acc = account({ wood: 20 });
    const t0 = 0;
    tryCraft(acc, "plank", 10, t0, params);
    // 서버 재시작을 가정: 아무 정산 없이 1시간 뒤
    const q = queueView(acc, 3_600_000, params);
    expect(q.jobs.length).toBe(0);
    expect(q.ready).toEqual({ plank: 10 });
  });

  it("원료 부족 / 슬롯 초과 / 미지 레시피 거부", () => {
    const acc = account({ wood: 1 });
    expect(tryCraft(acc, "plank", 1, 0, params)).toEqual({ ok: false, reason: "no_materials" });
    expect(tryCraft(acc, "mystery", 1, 0, params)).toEqual({ ok: false, reason: "unknown_recipe" });

    const rich = account({ wood: 100 });
    tryCraft(rich, "plank", 1, 0, params);
    tryCraft(rich, "plank", 1, 0, params);
    tryCraft(rich, "plank", 1, 0, params);
    expect(tryCraft(rich, "plank", 1, 0, params)).toEqual({ ok: false, reason: "slots_full" });
    // 슬롯이 비면(정산 후) 다시 가능
    expect(tryCraft(rich, "plank", 1, 5000, params).ok).toBe(true);
  });

  it("병렬 슬롯 — 서로 다른 레시피가 동시에 진행", () => {
    const acc = account({ wood: 4, herb: 4 });
    tryCraft(acc, "plank", 2, 0, params);
    tryCraft(acc, "herb_extract", 2, 0, params);
    settle(acc, 1000, params); // 각 슬롯에서 1개씩
    expect(acc.ready).toEqual({ plank: 1, herb_extract: 1 });
  });
});
