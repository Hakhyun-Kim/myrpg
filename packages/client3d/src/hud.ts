// DOM HUD — 인벤토리·채팅·채집 진행바 (2D 테스트 클라이언트와 동일한 구조)
import { ITEM_LABELS, type Inventory } from "@myrpg/protocol";

export function renderInventory(inv: Inventory): void {
  const el = document.getElementById("inv-items")!;
  const entries = Object.entries(inv).filter(([, n]) => n > 0);
  el.innerHTML =
    entries.length === 0
      ? "비어 있음"
      : entries.map(([item, n]) => `${ITEM_LABELS[item] ?? item} × ${n}`).join("<br>");
}

export function pushChat(text: string, system: boolean): void {
  const log = document.getElementById("chatlog")!;
  const div = document.createElement("div");
  if (system) div.className = "sys";
  div.textContent = text;
  log.appendChild(div);
  while (log.children.length > 10) log.removeChild(log.firstChild!);
}

let barTimer: { startAt: number; endsAt: number } | null = null;

export function showGatherBar(endsAt: number): void {
  barTimer = { startAt: Date.now(), endsAt };
  document.getElementById("gatherbar")!.style.display = "block";
}

export function hideGatherBar(): void {
  barTimer = null;
  document.getElementById("gatherbar")!.style.display = "none";
}

/** 렌더 루프에서 매 프레임 호출 */
export function updateGatherBar(): void {
  if (!barTimer) return;
  const { startAt, endsAt } = barTimer;
  const pct = Math.min(100, ((Date.now() - startAt) / Math.max(1, endsAt - startAt)) * 100);
  (document.querySelector("#gatherbar > div") as HTMLElement).style.width = `${pct}%`;
  if (pct >= 100) hideGatherBar();
}
