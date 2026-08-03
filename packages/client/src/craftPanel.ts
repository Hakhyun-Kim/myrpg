// 제작 큐 패널 — 레시피 등록, 진행 카운트다운, 완료품 수령. (client3d에도 동일 모듈이 있음)
import type { Room } from "colyseus.js";
import {
  ITEM_LABELS,
  RECIPES,
  type ClaimResultMsg,
  type CraftFailedMsg,
  type Inventory,
  type InventoryMsg,
  type QueueStateMsg,
} from "@myrpg/protocol";

const FAIL_LABEL: Record<string, string> = {
  unknown_recipe: "모르는 레시피",
  no_materials: "원료 부족",
  slots_full: "큐 슬롯이 가득 참",
  bad_count: "잘못된 수량",
};

export function fmtInv(inv: Inventory): string {
  const entries = Object.entries(inv).filter(([, n]) => n > 0);
  if (entries.length === 0) return "없음";
  return entries.map(([item, n]) => `${ITEM_LABELS[item] ?? item} ×${n}`).join(", ");
}

export function initCraftPanel(
  room: Room,
  initial: QueueStateMsg,
  renderInventory: (inv: Inventory) => void,
  notify: (text: string) => void,
): void {
  let state = initial;

  // 레시피 버튼
  const recipesEl = document.getElementById("craft-recipes")!;
  recipesEl.innerHTML = "";
  for (const recipe of Object.values(RECIPES)) {
    const row = document.createElement("div");
    row.className = "recipe";
    const desc = document.createElement("span");
    desc.textContent = `${recipe.label} (${fmtInv(recipe.input)})`;
    row.appendChild(desc);
    const btns = document.createElement("span");
    for (const count of [1, 5]) {
      const b = document.createElement("button");
      b.textContent = `×${count}`;
      b.onclick = () => room.send("craft", { recipeId: recipe.id, count });
      btns.appendChild(b);
    }
    row.appendChild(btns);
    recipesEl.appendChild(row);
  }

  const queueEl = document.getElementById("craft-queue")!;
  const readyEl = document.getElementById("craft-ready")!;
  const claimBtn = document.getElementById("claim-btn") as HTMLButtonElement;
  claimBtn.onclick = () => room.send("claim", {});

  function render(): void {
    if (state.jobs.length === 0) {
      queueEl.textContent = `대기 중인 작업 없음 (슬롯 ${state.slots}개)`;
    } else {
      queueEl.innerHTML = state.jobs
        .map((j) => {
          const recipe = RECIPES[j.recipeId];
          const remainSec = Math.max(0, Math.ceil((j.nextDoneAt - Date.now()) / 1000));
          return `${recipe?.label ?? j.recipeId} ${j.done}/${j.total} — 다음 완성 ${remainSec}초`;
        })
        .join("<br>");
    }
    const hasReady = Object.values(state.ready).some((n) => n > 0);
    readyEl.textContent = hasReady ? `보관함: ${fmtInv(state.ready)}` : "";
    claimBtn.disabled = !hasReady;
  }

  room.onMessage<QueueStateMsg>("queue_state", (q) => {
    state = q;
    render();
  });
  room.onMessage<ClaimResultMsg>("claim_result", (m) => {
    renderInventory(m.inventory);
    notify(`수령: ${fmtInv(m.claimed)}`);
  });
  room.onMessage<InventoryMsg>("inventory", (m) => renderInventory(m.inventory));
  room.onMessage<CraftFailedMsg>("craft_failed", (m) => notify(`제작 실패: ${FAIL_LABEL[m.reason] ?? m.reason}`));

  setInterval(render, 1000); // 카운트다운 갱신
  render();
}
