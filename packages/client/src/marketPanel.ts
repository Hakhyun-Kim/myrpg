// 시장 패널 — 호가창, 주문 등록/취소, NPC 즉시 거래, 스킬. (client3d에도 동일 모듈)
import type { Room } from "colyseus.js";
import {
  ITEM_LABELS,
  SKILL_LABELS,
  TRADABLE_ITEMS,
  type Inventory,
  type MarketBookMsg,
  type MarketFillsMsg,
  type MyOrdersMsg,
  type OrderView,
  type SkillsMsg,
} from "@myrpg/protocol";

const FAIL_LABEL: Record<string, string> = {
  unknown_item: "취급하지 않는 품목",
  bad_price: "잘못된 가격",
  bad_qty: "잘못된 수량",
  no_silver: "은화 부족",
  no_items: "물건 부족",
  too_many_orders: "주문 수 상한 초과",
  not_found: "주문을 찾을 수 없음",
};

export function initMarketPanel(
  room: Room,
  initial: { silver: number; orders: OrderView[]; skills: SkillsMsg },
  notify: (text: string) => void,
): void {
  let silver = initial.silver;
  let orders = initial.orders;
  let book: MarketBookMsg | null = null;
  let item = "wood";

  const panel = document.getElementById("market")!;
  const toggle = document.getElementById("market-toggle")!;
  toggle.onclick = () => {
    const open = panel.style.display === "block";
    panel.style.display = open ? "none" : "block";
    if (!open) refresh();
  };
  document.getElementById("market-close")!.onclick = () => (panel.style.display = "none");

  const itemSel = document.getElementById("market-item") as HTMLSelectElement;
  itemSel.innerHTML = TRADABLE_ITEMS.map(
    (i) => `<option value="${i}">${ITEM_LABELS[i] ?? i}</option>`,
  ).join("");
  itemSel.value = item;
  itemSel.onchange = () => {
    item = itemSel.value;
    refresh();
  };

  const priceIn = document.getElementById("market-price") as HTMLInputElement;
  const qtyIn = document.getElementById("market-qty") as HTMLInputElement;
  document.getElementById("market-buy")!.onclick = () => send("buy");
  document.getElementById("market-sell")!.onclick = () => send("sell");
  document.getElementById("npc-sell")!.onclick = () =>
    room.send("npc_trade", { side: "sell", item, qty: num(qtyIn, 1) });
  document.getElementById("npc-buy")!.onclick = () =>
    room.send("npc_trade", { side: "buy", item, qty: num(qtyIn, 1) });

  function num(el: HTMLInputElement, def: number): number {
    const v = Math.floor(Number(el.value));
    return Number.isFinite(v) && v > 0 ? v : def;
  }
  function send(side: "buy" | "sell"): void {
    room.send("market_order", { side, item, price: num(priceIn, book?.refPrice ?? 1), qty: num(qtyIn, 1) });
  }
  function refresh(): void {
    room.send("market_book", { item });
    room.send("my_orders", {});
  }

  function render(): void {
    document.getElementById("silver")!.textContent = `${silver} 은화`;
    const bookEl = document.getElementById("market-book")!;
    if (!book || book.item !== item) {
      bookEl.textContent = "불러오는 중…";
    } else {
      const rows = (side: "asks" | "bids") =>
        book![side].length === 0
          ? "<div class='muted'>없음</div>"
          : book![side]
              .map((d) => `<div>${d.price}은 × ${d.qty}</div>`)
              .join("");
      bookEl.innerHTML =
        `<div class="bookcols"><div><b>매도</b>${rows("asks")}</div>` +
        `<div><b>매수</b>${rows("bids")}</div></div>` +
        `<div class="muted">기준가 ${book.refPrice}은 · 최근 ${book.lastPrice ?? "-"}은 · 24h ${book.dayVolume}개` +
        `<br>NPC 매입 ${book.npcBuy}은${book.npcSell !== null ? ` · NPC 판매 ${book.npcSell}은` : " (NPC 판매 없음)"}</div>`;
    }

    const ordersEl = document.getElementById("market-orders")!;
    ordersEl.innerHTML = "";
    if (orders.length === 0) ordersEl.innerHTML = "<div class='muted'>등록한 주문 없음</div>";
    for (const o of orders) {
      const div = document.createElement("div");
      div.innerHTML = `${o.side === "buy" ? "매수" : "매도"} ${ITEM_LABELS[o.item] ?? o.item} ${o.price}은 × ${o.remaining}/${o.total} `;
      const btn = document.createElement("button");
      btn.textContent = "취소";
      btn.onclick = () => room.send("market_cancel", { orderId: o.id });
      div.appendChild(btn);
      ordersEl.appendChild(div);
    }
  }

  function renderSkills(s: SkillsMsg): void {
    const el = document.getElementById("skills-list")!;
    const entries = Object.entries(s.skills);
    el.innerHTML =
      (entries.length === 0
        ? "<div class='muted'>아직 없음</div>"
        : entries
            .map(([id, v]) => `${SKILL_LABELS[id] ?? id} Lv.${v.level} (${v.xp}/${v.xpNeeded})`)
            .join("<br>")) + `<div class="muted">마스터리 ${s.budgetUsed}/${s.budgetTotal}</div>`;
  }

  room.onMessage<MarketBookMsg>("market_book", (m) => {
    book = m;
    render();
  });
  room.onMessage<MyOrdersMsg>("my_orders", (m) => {
    orders = m.orders;
    silver = m.silver;
    render();
  });
  room.onMessage<MarketFillsMsg>("market_fills", (m) => {
    silver = m.silver;
    for (const f of m.fills) {
      notify(
        `체결: ${f.side === "buy" ? "매수" : "매도"} ${ITEM_LABELS[f.item] ?? f.item} ×${f.qty} @${f.price}은` +
          (f.fee > 0 ? ` (수수료 ${f.fee}은)` : ""),
      );
    }
    refresh();
  });
  room.onMessage<{ inventory: Inventory; silver?: number }>("inventory", (m) => {
    if (typeof m.silver === "number") silver = m.silver;
    render();
  });
  room.onMessage<{ reason: string }>("market_failed", (m) =>
    notify(`시장: ${FAIL_LABEL[m.reason] ?? m.reason}`),
  );
  room.onMessage<SkillsMsg>("skills", renderSkills);

  renderSkills(initial.skills);
  render();
}
