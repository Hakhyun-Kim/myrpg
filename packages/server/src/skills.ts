// 생활 스킬 + 마스터리 예산 — GDD §5.2.
// Phase 2 범위: xp 누적 → 레벨, 예산 상한, 수율 보너스. (리스펙·티어 게이트는 Phase 3+)
import { GAME, type SkillsMsg, type SkillView } from "@myrpg/protocol";
import type { Account, SkillState } from "./storage.js";

/** 레벨 L → L+1에 필요한 xp (완만한 지수) */
export function xpNeeded(level: number): number {
  return Math.round(20 * Math.pow(1.12, level - 1));
}

function ensure(account: Account): Record<string, SkillState> {
  if (!account.skills) account.skills = {};
  return account.skills;
}

export function skillLevel(account: Account, skill: string): number {
  return account.skills?.[skill]?.level ?? 1;
}

/** 스킬 레벨의 합 = 사용한 마스터리 (레벨 1은 무료) */
export function budgetUsed(account: Account): number {
  return Object.values(account.skills ?? {}).reduce((s, v) => s + (v.level - 1), 0);
}

export function budgetTotal(): number {
  return GAME.MASTERY_BUDGET_START;
}

/**
 * xp 부여 후 레벨업 처리. 예산이 부족하면 레벨은 잠기고 xp만 쌓인다 (GDD §5.2).
 * 반환: 실제로 오른 레벨 수 (0이면 변화 없음)
 */
export function addXp(account: Account, skill: string, amount: number): number {
  const skills = ensure(account);
  const s = (skills[skill] ??= { level: 1, xp: 0 });
  s.xp += amount;
  let gained = 0;
  for (;;) {
    if (s.level >= GAME.SKILL_MAX_LEVEL) break;
    const need = xpNeeded(s.level);
    if (s.xp < need) break;
    if (budgetUsed(account) >= budgetTotal()) break; // 예산 소진 — 레벨 잠금
    s.xp -= need;
    s.level += 1;
    gained += 1;
  }
  return gained;
}

/** 채집·가공 산출 보너스: 레벨당 +0.5% 확률로 1개 추가 */
export function bonusYield(account: Account, skill: string, rng: () => number): number {
  const level = skillLevel(account, skill);
  const chance = (level - 1) * GAME.YIELD_BONUS_PER_LEVEL;
  if (chance <= 0) return 0;
  const guaranteed = Math.floor(chance);
  return guaranteed + (rng() < chance - guaranteed ? 1 : 0);
}

export function skillsView(account: Account): SkillsMsg {
  const skills: Record<string, SkillView> = {};
  for (const [id, s] of Object.entries(account.skills ?? {})) {
    skills[id] = { level: s.level, xp: s.xp, xpNeeded: xpNeeded(s.level) };
  }
  return { skills, budgetUsed: budgetUsed(account), budgetTotal: budgetTotal() };
}
