// 경제 시뮬레이션 — 봇 N개 × M일을 가속 시간으로 돌려 Sink/Faucet 균형과 가격 안정성을 검증한다.
// GDD Phase 2 게이트: "사람이 모인 뒤 밸런스를 고치면 이미 늦다".
//
// 네트워크를 타지 않는다: 시장·제작·스킬 로직을 직접 구동해 7일치를 수초에 압축한다.
// 검증 대상은 전송이 아니라 경제 규칙이므로 이게 옳은 층위다.
import {
  CRAFT_SKILL,
  DEFAULT_REF_PRICE,
  GAME,
  NODE_YIELD,
  RECIPES,
  type Inventory,
  type NodeKind,
} from "@myrpg/protocol";
import { defaultGameParams, type GameParams } from "./config.js";
import { claim, settle, tryCraft } from "./craft.js";
import { emptyMarket, Market } from "./market.js";
import { addXp, bonusYield, skillLevel } from "./skills.js";
import { useToolForGather } from "./tools.js";
import type { Account, SaveData } from "./storage.js";

/** 재현 가능한 난수 (mulberry32) — 시뮬 결과가 흔들리면 밸런스 판단이 불가능하다 */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Role = "logger" | "miner" | "herbalist" | "sawyer" | "smelter" | "alchemist" | "smith";

interface Bot {
  account: Account;
  role: Role;
  /** 마지막 행동 시각 */
  nextActAt: number;
}

const ROLE_PLAN: Record<
  Role,
  { gather?: NodeKind; craft?: string; sells: string[]; buys: string[]; skill: string }
> = {
  logger: { gather: "tree", sells: ["wood"], buys: [], skill: "logging" },
  miner: { gather: "rock", sells: ["copper_ore"], buys: [], skill: "mining" },
  herbalist: { gather: "herb", sells: ["herb"], buys: [], skill: "herbalism" },
  sawyer: { craft: "plank", sells: ["plank"], buys: ["wood"], skill: "sawing" },
  smelter: { craft: "copper_ingot", sells: ["copper_ingot"], buys: ["copper_ore"], skill: "smelting" },
  alchemist: { craft: "herb_extract", sells: ["herb_extract"], buys: ["herb"], skill: "alchemy" },
  smith: { craft: "copper_knife", sells: ["copper_knife"], buys: ["copper_ingot", "plank"], skill: "smithing" },
};

export interface SimOptions {
  bots?: number;
  days?: number;
  seed?: number;
  /** 봇 1명의 행동 간격 (게임 시간 ms) — 기본 3분: 하루 8시간 활동 가정 */
  actIntervalMs?: number;
  params?: GameParams;
}

export interface SimReport {
  bots: number;
  days: number;
  /** 정상 상태 유입 (NPC 매입 지출 + 몬스터 드랍). 초기 지참금은 일회성이라 제외 */
  faucet: number;
  sink: number;
  sinkFaucetRatio: number;
  startingGrants: number;
  totalSilver: number;
  volume: number;
  trades: number;
  /** 품목별 [초기 기준가, 최종 기준가, 마지막 체결가] */
  prices: Record<string, { start: number; end: number; last: number | null; volume: number }>;
  /** 역할별 평균 은화·스킬 레벨 */
  roles: Record<string, { silver: number; level: number; count: number }>;
  openOrders: number;
  npcShare: number; // NPC를 거친 거래 비중 (낮을수록 플레이어 경제가 산다)
}

export function runSimulation(opts: SimOptions = {}): SimReport {
  const bots = opts.bots ?? 20;
  const days = opts.days ?? 7;
  const seed = opts.seed ?? 42;
  const actInterval = opts.actIntervalMs ?? 3 * 60_000;
  const params = opts.params ?? defaultGameParams();
  const rng = makeRng(seed);

  const T0 = 1_700_000_000_000;
  const save: SaveData = { version: 1, accounts: {} };
  const marketData = emptyMarket();
  const market = new Market(save, marketData);

  // 역할 배분 — 채집 3 : 가공 3 : 대장 1 비율로 순환
  const roles: Role[] = ["logger", "miner", "herbalist", "sawyer", "smelter", "alchemist", "smith"];
  const pop: Bot[] = [];
  for (let i = 0; i < bots; i++) {
    const role = roles[i % roles.length]!;
    const account: Account = {
      name: `bot${i}`,
      token: "sim",
      x: 0,
      y: 0,
      inventory: {},
      silver: 500,
      skills: {},
      jobs: [],
      ready: {},
    };
    save.accounts[account.name] = account;
    pop.push({ account, role, nextActAt: T0 + Math.floor(rng() * actInterval) });
  }

  const startSilver = bots * 500;
  let monsterFaucet = 0; // Phase 3 전투 전까지는 0 — 계측 자리만 잡아 둔다

  const startPrices: Record<string, number> = {};
  for (const item of Object.keys(DEFAULT_REF_PRICE)) startPrices[item] = market.refPrice(item, T0);

  const endAt = T0 + days * 24 * 3600_000;
  const STEP = 60_000; // 1분 단위 진행

  for (let now = T0; now < endAt; now += STEP) {
    market.expire(now);
    market.refreshContracts(now, bots, rng);
    for (const bot of pop) {
      if (now < bot.nextActAt) continue;
      bot.nextActAt = now + actInterval + Math.floor(rng() * actInterval * 0.5);
      act(bot, now);
    }
  }

  // 마지막 정산
  for (const bot of pop) {
    settle(bot.account, endAt, params);
    claim(bot.account, endAt, params);
  }
  market.expire(endAt);

  // ---- 집계 ----
  const totalSilver = pop.reduce((s, b) => s + (b.account.silver ?? 0), 0);
  const escrowSilver = market.openOrders
    .filter((o) => o.side === "buy")
    .reduce((s, o) => s + o.price * o.remaining, 0);

  const faucet = market.stats.npcPaidOut + market.stats.contractPaidOut + monsterFaucet;
  const sink = market.stats.feesCollected + market.stats.npcTakenIn + market.stats.upkeepCollected;

  const prices: SimReport["prices"] = {};
  for (const item of Object.keys(DEFAULT_REF_PRICE)) {
    const hist = market.history.filter((h) => h.item === item);
    prices[item] = {
      start: startPrices[item]!,
      end: market.refPrice(item, endAt),
      last: hist.length > 0 ? hist[hist.length - 1]!.price : null,
      volume: hist.reduce((s, h) => s + h.qty, 0),
    };
  }

  const roleAgg: SimReport["roles"] = {};
  for (const bot of pop) {
    const key = bot.role;
    const agg = (roleAgg[key] ??= { silver: 0, level: 0, count: 0 });
    agg.silver += bot.account.silver ?? 0;
    agg.level += skillLevel(bot.account, ROLE_PLAN[bot.role].skill);
    agg.count += 1;
  }
  for (const agg of Object.values(roleAgg)) {
    agg.silver = Math.round(agg.silver / agg.count);
    agg.level = Math.round((agg.level / agg.count) * 10) / 10;
  }

  const npcVolume = market.stats.npcPaidOut + market.stats.npcTakenIn + market.stats.contractPaidOut;
  return {
    bots,
    days,
    faucet,
    sink,
    sinkFaucetRatio: faucet > 0 ? Math.round((sink / faucet) * 1000) / 1000 : 0,
    startingGrants: startSilver,
    totalSilver: totalSilver + escrowSilver,
    volume: market.stats.volume,
    trades: market.history.length,
    prices,
    roles: roleAgg,
    openOrders: market.openOrders.length,
    npcShare:
      market.stats.volume + npcVolume > 0
        ? Math.round((npcVolume / (market.stats.volume + npcVolume)) * 1000) / 1000
        : 0,
  };

  // ---- 봇 행동 ----
  // 실제 플레이어처럼 호가창을 보고 움직인다: 반대편 호가가 있으면 즉시 체결(테이커),
  // 없으면 지정가로 걸어두고(메이커) 오래 안 팔리면 취소 후 가격을 조정한다.
  function act(bot: Bot, now: number): void {
    const { account, role } = bot;
    const plan = ROLE_PLAN[role];
    market.chargeUpkeep(account, now); // 일일 유지비 (Sink)
    // 제작 완성분 정산 + 경험치 (room.settleCraft와 동일 규칙)
    for (const [recipeId, units] of Object.entries(settle(account, now, params))) {
      const skill = CRAFT_SKILL[RECIPES[recipeId]?.skill ?? ""];
      if (skill) addXp(account, skill, units * GAME.XP_CRAFT_UNIT);
    }
    claim(account, now, params);

    // 오래 묵은 주문 정리 — 상한(12건)을 채우면 새 기회를 못 잡는다
    const mine = market.myOrders(account.name, now);
    if (mine.length >= GAME.MARKET_MAX_ORDERS_PER_PLAYER - 2) {
      for (const o of mine.slice(0, 4)) market.cancel(account, o.id, now);
    }

    if (plan.gather) {
      // 채집: 노드 이동·쿨다운은 행동 간격으로 추상화. 1회 3개 + 스킬 보너스, 도구 소모.
      const item = NODE_YIELD[plan.gather];
      const base = 3;
      let mult = 1;
      for (let i = 0; i < base; i++) mult = useToolForGather(account).multiplier;
      const bonus = bonusYield(account, plan.skill, rng);
      account.inventory[item] =
        (account.inventory[item] ?? 0) + Math.max(1, Math.floor((base + bonus) * mult));
      addXp(account, plan.skill, GAME.XP_GATHER * base);

      // 도구가 떨어지면 시장에서 사 온다 (완제품 수요의 원천)
      if ((account.inventory[GAME.TOOL_ITEM] ?? 0) === 0) {
        const book = market.book(GAME.TOOL_ITEM, now);
        const bestAsk = book.asks[0];
        if (bestAsk && (account.silver ?? 0) > bestAsk.price * 2) {
          market.place(account, "buy", GAME.TOOL_ITEM, bestAsk.price, Math.min(2, bestAsk.qty), now);
        } else if ((account.silver ?? 0) > book.refPrice * 2) {
          market.place(account, "buy", GAME.TOOL_ITEM, Math.round(book.refPrice * 1.1), 2, now);
        }
      }
    }

    if (plan.craft) {
      const recipe = RECIPES[plan.craft]!;
      for (const input of Object.keys(recipe.input)) {
        const per = recipe.input[input] ?? 0;
        const need = per * 4 - (account.inventory[input] ?? 0);
        if (need <= 0) continue;
        const book = market.book(input, now);
        const ref = book.refPrice;
        // 완성품 기준가에서 역산한 원료 상한 — 이 이상 주면 만들수록 손해다
        const maxPay = Math.max(1, Math.floor((market.refPrice(recipe.output, now) * 0.8) / per));

        const bestAsk = book.asks[0];
        if (bestAsk && bestAsk.price <= maxPay) {
          // 즉시 체결 (테이커) — 유동성을 소비해 채집직에게 은화를 돌려준다
          const qty = Math.min(need, bestAsk.qty, Math.floor((account.silver ?? 0) / bestAsk.price));
          if (qty >= 1) market.place(account, "buy", input, bestAsk.price, qty, now);
        } else {
          // 매물이 없으면 지정가 매수를 걸어 둔다 (기준가 근처)
          const bid = Math.min(maxPay, Math.max(1, Math.round(ref * (0.95 + rng() * 0.2))));
          const qty = Math.min(need, Math.floor(((account.silver ?? 0) * 0.6) / Math.max(1, bid)));
          if (qty >= 1) market.place(account, "buy", input, bid, qty, now);
        }
      }

      const canMake = Math.min(
        GAME.CRAFT_MAX_COUNT,
        ...Object.entries(recipe.input).map(([i, n]) => Math.floor((account.inventory[i] ?? 0) / n)),
      );
      if (canMake >= 1 && (account.jobs?.length ?? 0) < params.craftSlots) {
        tryCraft(account, plan.craft, Math.min(canMake, 5), now, params);
      }
    }

    // 일일 납품 계약 우선 — 시세보다 좋은 값(140%)이라 완제품은 여기부터 나간다
    for (const contract of market.contracts()) {
      const have = account.inventory[contract.item] ?? 0;
      if (have > 0 && contract.remaining > 0) market.deliver(account, contract.item, have);
    }

    // 판매
    for (const item of plan.sells) {
      const have = account.inventory[item] ?? 0;
      if (have < 2) continue;
      const book = market.book(item, now);
      const bestBid = book.bids[0];
      const qty = Math.min(have, 12);

      if (bestBid && bestBid.price >= book.npcBuy) {
        // 매수 호가가 NPC 바닥보다 나으면 즉시 체결
        market.place(account, "sell", item, bestBid.price, Math.min(qty, bestBid.qty), now);
      } else {
        const ask = Math.max(book.npcBuy + 1, Math.round(book.refPrice * (0.9 + rng() * 0.2)));
        const r = market.place(account, "sell", item, ask, qty, now);
        if (!r.ok) market.npcTrade(account, "sell", item, qty, now); // 등록조차 못 하면 NPC 바닥
      }
    }

    // 재고 과잉은 NPC에 처분한다 — 창고가 무한이 아니라는 가정이자 Faucet 경로
    for (const [item, n] of Object.entries(account.inventory)) {
      if (n > 40) market.npcTrade(account, "sell", item, n - 20, now);
    }

    // 자금이 마르면 재고를 NPC에 던진다 (유동성 최후 수단)
    if ((account.silver ?? 0) < 3) {
      for (const [item, n] of Object.entries(account.inventory)) {
        if (n > 0) {
          market.npcTrade(account, "sell", item, n, now);
          break;
        }
      }
    }
  }
}

export function formatReport(r: SimReport): string {
  const lines: string[] = [];
  lines.push(`# 경제 시뮬레이션 — 봇 ${r.bots}명 × ${r.days}일`);
  lines.push("");
  lines.push(
    `Faucet(유입) ${r.faucet}은 · Sink(소멸) ${r.sink}은 · **Sink/Faucet ${r.sinkFaucetRatio}** (목표 0.9~1.0)`,
  );
  lines.push(`(일회성 신규 지참금 ${r.startingGrants}은은 정상 상태 흐름에서 제외)`);
  lines.push(`유통 은화 ${r.totalSilver}은 · 거래액 ${r.volume}은 · 체결 ${r.trades}건 · 미체결 주문 ${r.openOrders}건`);
  lines.push(`NPC 거래 비중 ${(r.npcShare * 100).toFixed(1)}% (낮을수록 플레이어 경제가 산다)`);
  lines.push("");
  lines.push("| 품목 | 시작 기준가 | 최종 기준가 | 마지막 체결 | 거래량 |");
  lines.push("|---|---|---|---|---|");
  for (const [item, p] of Object.entries(r.prices)) {
    lines.push(`| ${item} | ${p.start} | ${p.end} | ${p.last ?? "-"} | ${p.volume} |`);
  }
  lines.push("");
  lines.push("| 역할 | 평균 은화 | 평균 스킬 |");
  lines.push("|---|---|---|");
  for (const [role, a] of Object.entries(r.roles)) {
    lines.push(`| ${role} (${a.count}명) | ${a.silver} | Lv.${a.level} |`);
  }
  return lines.join("\n");
}
