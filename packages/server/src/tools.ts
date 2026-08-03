// 채집 도구 소모 — GDD P2 "모든 아이템은 결국 사라진다"의 최소 구현.
// 채집 TOOL_USES회마다 도구 1개가 사라진다. 도구가 없으면 산출이 절반.
// 이 소비가 대장장이 수요를 만들고 채집직의 은화를 가공 사슬로 되돌린다.
import { GAME } from "@myrpg/protocol";
import type { Account } from "./storage.js";

export interface ToolResult {
  /** 산출 배율 (도구 없으면 0.5) */
  multiplier: number;
  /** 이번 채집으로 도구가 소모됐는가 */
  consumed: boolean;
}

export function useToolForGather(account: Account): ToolResult {
  const item = GAME.TOOL_ITEM;
  const have = account.inventory[item] ?? 0;
  if (have <= 0) return { multiplier: GAME.TOOL_MISSING_PENALTY, consumed: false };

  account.toolUses = (account.toolUses ?? 0) + 1;
  if (account.toolUses < GAME.TOOL_USES) return { multiplier: 1, consumed: false };

  account.toolUses = 0;
  account.inventory[item] = have - 1;
  if (account.inventory[item]! <= 0) delete account.inventory[item];
  return { multiplier: 1, consumed: true };
}
