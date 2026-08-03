// 대면 거래 패널 — 요청 수락/거절, 제안 편집, 양측 확정 표시. (client3d에도 동일 모듈)
import type { Room } from "colyseus.js";
import {
  ITEM_LABELS,
  type Inventory,
  type TradeClosedMsg,
  type TradeDoneMsg,
  type TradeFailedMsg,
  type TradeOpenMsg,
  type TradeRequestedMsg,
  type TradeUpdateMsg,
} from "@myrpg/protocol";

const CLOSE_LABEL: Record<string, string> = {
  declined: "상대가 거래를 거절했습니다",
  cancelled: "거래가 취소되었습니다",
  too_far: "거리가 멀어져 거래가 취소되었습니다",
  partner_left: "상대가 자리를 떠났습니다",
  invalid_offer: "제안이 유효하지 않아 취소되었습니다",
  expired: "거래 요청이 만료되었습니다",
};
const FAIL_LABEL: Record<string, string> = {
  self: "자기 자신과는 거래할 수 없습니다",
  busy: "이미 진행 중인 거래가 있습니다",
  not_found: "상대를 찾을 수 없습니다",
  too_far: "거래하려면 더 가까이 가세요",
  invalid_offer: "보유하지 않은 물건은 제안할 수 없습니다",
};

function fmt(inv: Inventory): string {
  const entries = Object.entries(inv).filter(([, n]) => n > 0);
  return entries.length === 0 ? "없음" : entries.map(([i, n]) => `${ITEM_LABELS[i] ?? i} ×${n}`).join(", ");
}

export function initTradePanel(
  room: Room,
  initialInv: Inventory,
  renderInventory: (inv: Inventory) => void,
  notify: (text: string) => void,
): void {
  let inv: Inventory = { ...initialInv };
  let myOffer: Inventory = {};
  let update: TradeUpdateMsg | null = null;

  const panel = document.getElementById("trade")!;
  const reqBar = document.getElementById("trade-req")!;
  const partnerEl = document.getElementById("trade-partner")!;
  const mineEl = document.getElementById("trade-mine")!;
  const theirsEl = document.getElementById("trade-theirs")!;
  const bagEl = document.getElementById("trade-bag")!;
  const statusEl = document.getElementById("trade-status")!;
  const acceptBtn = document.getElementById("trade-accept") as HTMLButtonElement;
  const cancelBtn = document.getElementById("trade-cancel") as HTMLButtonElement;

  acceptBtn.onclick = () => room.send("trade_accept", {});
  cancelBtn.onclick = () => room.send("trade_cancel", {});
  document.getElementById("trade-req-yes")!.onclick = () => {
    room.send("trade_respond", { accept: true });
    reqBar.style.display = "none";
  };
  document.getElementById("trade-req-no")!.onclick = () => {
    room.send("trade_respond", { accept: false });
    reqBar.style.display = "none";
  };

  function sendOffer(): void {
    const clean: Inventory = {};
    for (const [item, n] of Object.entries(myOffer)) if (n > 0) clean[item] = n;
    myOffer = clean;
    room.send("trade_offer", { items: myOffer });
  }

  function render(): void {
    if (!update) return;
    mineEl.innerHTML = "";
    for (const [item, n] of Object.entries(update.myOffer)) {
      const div = document.createElement("div");
      div.className = "trade-item";
      div.textContent = `${ITEM_LABELS[item] ?? item} ×${n} ▾`;
      div.onclick = () => {
        myOffer[item] = (myOffer[item] ?? 0) - 1;
        sendOffer();
      };
      mineEl.appendChild(div);
    }
    if (mineEl.children.length === 0) mineEl.textContent = "(가방에서 클릭해 추가)";

    bagEl.innerHTML = "";
    for (const [item, n] of Object.entries(inv)) {
      const avail = n - (update.myOffer[item] ?? 0);
      if (avail <= 0) continue;
      const div = document.createElement("div");
      div.className = "trade-item";
      div.textContent = `${ITEM_LABELS[item] ?? item} ×${avail} ▴`;
      div.onclick = () => {
        myOffer[item] = (myOffer[item] ?? 0) + 1;
        sendOffer();
      };
      bagEl.appendChild(div);
    }
    if (bagEl.children.length === 0) bagEl.textContent = "(비어 있음)";

    theirsEl.textContent = fmt(update.partnerOffer);
    statusEl.textContent = `나 ${update.myAccept ? "✅ 확정" : "…"} · 상대 ${update.partnerAccept ? "✅ 확정" : "…"}`;
    acceptBtn.disabled = update.myAccept;
  }

  // 가방 추적 (다른 패널과 병행 구독 — colyseus.js는 타입당 다중 핸들러 허용)
  room.onMessage<{ inventory: Inventory }>("inventory", (m) => {
    inv = { ...m.inventory };
    render();
  });
  room.onMessage<{ inventory: Inventory }>("gather_result", (m) => {
    inv = { ...m.inventory };
    render();
  });
  room.onMessage<{ inventory: Inventory }>("claim_result", (m) => {
    inv = { ...m.inventory };
    render();
  });

  room.onMessage<TradeRequestedMsg>("trade_requested", (m) => {
    document.getElementById("trade-req-name")!.textContent = m.name;
    reqBar.style.display = "block";
  });
  room.onMessage<TradeOpenMsg>("trade_open", (m) => {
    myOffer = {};
    partnerEl.textContent = m.partner.name;
    panel.style.display = "block";
    notify(`${m.partner.name} 님과 거래를 시작합니다`);
  });
  room.onMessage<TradeUpdateMsg>("trade_update", (m) => {
    update = m;
    myOffer = { ...m.myOffer };
    render();
  });
  room.onMessage<TradeDoneMsg>("trade_done", (m) => {
    panel.style.display = "none";
    update = null;
    inv = { ...m.inventory };
    renderInventory(m.inventory);
    notify(`거래 완료 — 준 것: ${fmt(m.gave)} / 받은 것: ${fmt(m.received)}`);
  });
  room.onMessage<TradeClosedMsg>("trade_closed", (m) => {
    panel.style.display = "none";
    reqBar.style.display = "none";
    update = null;
    notify(CLOSE_LABEL[m.reason] ?? `거래 종료: ${m.reason}`);
  });
  room.onMessage<TradeFailedMsg>("trade_failed", (m) => {
    notify(FAIL_LABEL[m.reason] ?? `거래 실패: ${m.reason}`);
  });
}
