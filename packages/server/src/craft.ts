// 제작 큐 — 계정 단위, 타임스탬프 기반. P4 "오프라인에도 경제는 돈다"의 실행.
// 서버가 매 순간 시뮬레이션하지 않는다: 접근하는 시점에 경과 시간으로 정산(settle)하므로
// 로그아웃·서버 재시작과 무관하게 진행이 보존된다.
import { randomBytes } from "node:crypto";
import { RECIPES, type CraftFailReason, type Inventory, type QueueStateMsg } from "@myrpg/protocol";
import type { GameParams } from "./config.js";
import type { Account, CraftJob } from "./storage.js";

function unitMs(params: GameParams): number {
  return params.craftMsT1; // 티어 확장 시 recipe.tier로 분기
}

/**
 * 경과 시간만큼 완성분을 ready로 옮긴다. 완주한 작업은 큐에서 제거.
 * 반환: 이번 정산에서 완성된 유닛 수 (레시피별) — 호출자가 경험치 지급에 쓴다.
 */
export function settle(account: Account, now: number, params: GameParams): Record<string, number> {
  if (!account.jobs) account.jobs = [];
  if (!account.ready) account.ready = {};
  const ms = unitMs(params);
  const completed: Record<string, number> = {};
  account.jobs = account.jobs.filter((job) => {
    const recipe = RECIPES[job.recipeId];
    if (!recipe) return false; // 레시피가 사라진 작업은 폐기 (원료는 이미 소모 — 마이그레이션 이슈)
    const producible = Math.min(job.total - job.done, Math.floor((now - job.startAt) / ms));
    if (producible > 0) {
      job.done += producible;
      job.startAt += producible * ms;
      account.ready![recipe.output] = (account.ready![recipe.output] ?? 0) + producible * recipe.outputCount;
      completed[job.recipeId] = (completed[job.recipeId] ?? 0) + producible;
    }
    return job.done < job.total;
  });
  return completed;
}

export function tryCraft(
  account: Account,
  recipeId: string,
  count: number,
  now: number,
  params: GameParams,
): { ok: true; job: CraftJob } | { ok: false; reason: CraftFailReason } {
  settle(account, now, params);
  const recipe = RECIPES[recipeId];
  if (!recipe) return { ok: false, reason: "unknown_recipe" };
  if (!Number.isInteger(count) || count < 1) return { ok: false, reason: "bad_count" };
  if (account.jobs!.length >= params.craftSlots) return { ok: false, reason: "slots_full" };

  // 원료 확인 후 일괄 차감 (등록 시점 선불 — 취소 기능은 아직 없음)
  for (const [item, need] of Object.entries(recipe.input)) {
    if ((account.inventory[item] ?? 0) < need * count) return { ok: false, reason: "no_materials" };
  }
  for (const [item, need] of Object.entries(recipe.input)) {
    account.inventory[item] = (account.inventory[item] ?? 0) - need * count;
    if (account.inventory[item] === 0) delete account.inventory[item];
  }

  const job: CraftJob = {
    id: "j_" + randomBytes(4).toString("hex"),
    recipeId,
    total: count,
    done: 0,
    startAt: now,
  };
  account.jobs!.push(job);
  return { ok: true, job };
}

/** 완료품 전량 수령 → 인벤토리로. */
export function claim(account: Account, now: number, params: GameParams): Inventory {
  settle(account, now, params);
  const claimed: Inventory = { ...account.ready! };
  for (const [item, n] of Object.entries(claimed)) {
    account.inventory[item] = (account.inventory[item] ?? 0) + n;
  }
  account.ready = {};
  return claimed;
}

export function queueView(account: Account, now: number, params: GameParams): QueueStateMsg {
  settle(account, now, params);
  const ms = unitMs(params);
  return {
    jobs: account.jobs!.map((j) => ({
      id: j.id,
      recipeId: j.recipeId,
      total: j.total,
      done: j.done,
      nextDoneAt: j.startAt + ms,
    })),
    ready: { ...account.ready! },
    slots: params.craftSlots,
  };
}
