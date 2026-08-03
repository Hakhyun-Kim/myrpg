#!/usr/bin/env node
// MyRPG MCP 서버 — AI 에이전트를 이 게임의 플레이어로 만드는 공식 도구.
// 전용 API가 아니다: 내부적으로 PROTOCOL.md의 WebSocket 프로토콜로 접속하는 클라이언트일 뿐 (P6).
// 주의: stdio MCP 서버에서 stdout은 프로토콜 채널이다 — 로그는 반드시 stderr로.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { GAME, RECIPES } from "@myrpg/protocol";
import { GameClient } from "./client.js";

const SERVER_URL = process.env.MYRPG_URL ?? "ws://localhost:7777";
const client = new GameClient();

const mcp = new McpServer({ name: "myrpg", version: "0.1.0" });

function ok(data: object | string): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 1) }] };
}
function fail(err: unknown): { content: { type: "text"; text: string }[]; isError: true } {
  return { content: [{ type: "text", text: `오류: ${(err as Error).message}` }], isError: true };
}

mcp.tool(
  "join",
  "게임 세계 '하란'에 캐릭터로 입장한다. 같은 이름으로 재접속하면 토큰이 자동 재사용된다. 입장 후 현재 상황 요약을 반환한다.",
  { name: z.string().regex(GAME.NAME_RE).describe("캐릭터 이름 (2~16자, 한글/영문/숫자/_/-)") },
  async ({ name }) => {
    try {
      if (client.connected && client.name === name) return ok(client.summary()); // 이미 접속 중 — 멱등
      if (client.connected) client.disconnect();
      await client.connect(SERVER_URL, name);
      return ok(client.summary());
    } catch (err) {
      return fail(err);
    }
  },
);

mcp.tool(
  "look",
  "현재 상황 요약: 내 위치, 가방, 주변 플레이어, 자원 노드(가까운 순, 거리 포함), 최근 채팅.",
  {},
  async () => {
    try {
      await client.ensureConnected();
      return ok(client.summary());
    } catch (err) {
      return fail(err);
    }
  },
);

mcp.tool(
  "goto",
  "지정 좌표로 이동하고 도착할 때까지 기다린다. 이동 속도는 초당 160px (서버 판정).",
  { x: z.number().describe("목표 x (픽셀)"), y: z.number().describe("목표 y (픽셀)") },
  async ({ x, y }) => {
    try {
      await client.ensureConnected();
      await client.goto(x, y);
      return ok({ arrived: { x: Math.round(client.me.x), y: Math.round(client.me.y) } });
    } catch (err) {
      return fail(err);
    }
  },
);

mcp.tool(
  "gather",
  "자원을 채집한다 (이동→채집 완료까지 자동 대기, 회당 3초). nodeId를 주면 그 노드, kind만 주면 가장 가까운 해당 종류, 둘 다 없으면 가장 가까운 노드. tree→wood(원목), rock→copper_ore(구리 광석), herb→herb(생약초).",
  {
    nodeId: z.string().optional().describe("특정 노드 id (look의 nodes 참고)"),
    kind: z.enum(["tree", "rock", "herb"]).optional().describe("자원 종류로 선택"),
    times: z.number().int().min(1).max(10).optional().describe("반복 횟수 (기본 1, 최대 10)"),
  },
  async ({ nodeId, kind, times }) => {
    try {
      await client.ensureConnected();
      const n = times ?? 1;
      const got: Record<string, number> = {};
      for (let i = 0; i < n; i++) {
        const target = nodeId ? client.nodes.get(nodeId) : client.nearestNode(kind);
        if (!target) throw new Error(kind ? `살아있는 ${kind} 노드가 없습니다` : "살아있는 노드가 없습니다");
        if (nodeId && target.remaining <= 0) throw new Error(`고갈된 노드: ${nodeId}`);
        const r = await client.gatherNode(target.id);
        got[r.item] = (got[r.item] ?? 0) + r.count;
      }
      return ok({ gathered: got, inventory: client.inventory });
    } catch (err) {
      return fail(err);
    }
  },
);

mcp.tool(
  "craft",
  "제작 큐에 가공 작업을 등록한다 (원료 즉시 차감, 회당 30초, 슬롯 3개, 오프라인에도 진행). 레시피: plank(판재)=원목2, copper_ingot(구리 주괴)=구리 광석2, herb_extract(약초 추출액)=생약초2. 완성품은 보관함에 쌓이며 claim으로 수령.",
  {
    recipeId: z.enum(Object.keys(RECIPES) as [string, ...string[]]).describe("레시피 id"),
    count: z.number().int().min(1).max(GAME.CRAFT_MAX_COUNT).describe("제작 수량"),
  },
  async ({ recipeId, count }) => {
    try {
      await client.ensureConnected();
      const q = await client.craft(recipeId, count);
      return ok({ queue: q, inventory: client.inventory });
    } catch (err) {
      return fail(err);
    }
  },
);

mcp.tool("queue", "제작 큐 상태를 본다: 진행 중 작업(다음 완성 시각 포함)과 완료품 보관함.", {}, async () => {
  try {
    await client.ensureConnected();
    return ok(await client.queueState());
  } catch (err) {
    return fail(err);
  }
});

mcp.tool("claim", "제작 완료품을 전량 수령해 가방에 넣는다.", {}, async () => {
  try {
    await client.ensureConnected();
    return ok(await client.claim());
  } catch (err) {
    return fail(err);
  }
});

mcp.tool(
  "trade_request",
  "다른 플레이어에게 대면 거래를 요청하고 상대가 수락할 때까지 기다린다 (멀면 자동으로 다가감, 요청 유효 30초). 열리면 trade_offer로 제안하고 trade_accept로 확정한다.",
  { player: z.string().describe("상대 이름 또는 playerId (look의 players 참고)") },
  async ({ player }) => {
    try {
      await client.ensureConnected();
      const r = await client.requestTrade(player);
      return ok({ opened: r, hint: "trade_offer로 제안 → trade_accept로 확정" });
    } catch (err) {
      return fail(err);
    }
  },
);

mcp.tool(
  "trade_respond",
  "나에게 온 거래 요청(look의 incomingTradeRequest)에 응답한다.",
  { accept: z.boolean() },
  async ({ accept }) => {
    try {
      await client.ensureConnected();
      const r = await client.respondTrade(accept);
      return ok(accept ? { opened: r } : "거절했습니다");
    } catch (err) {
      return fail(err);
    }
  },
);

mcp.tool(
  "trade_offer",
  "진행 중인 거래에서 내 제안을 통째로 교체한다 (예: {\"wood\": 2}). 제안이 바뀌면 양측 확정이 풀린다.",
  { items: z.record(z.string(), z.number().int().min(1)).describe("아이템 id → 수량") },
  async ({ items }) => {
    try {
      await client.ensureConnected();
      return ok(await client.offerTrade(items));
    } catch (err) {
      return fail(err);
    }
  },
);

mcp.tool(
  "trade_accept",
  "내 쪽 확정. 상대도 확정하면 교환이 실행된다 — 완료(또는 종료)까지 기다린 뒤 결과를 반환한다.",
  {},
  async () => {
    try {
      await client.ensureConnected();
      return ok(await client.acceptTrade());
    } catch (err) {
      return fail(err);
    }
  },
);

mcp.tool("trade_cancel", "진행 중인 거래를 취소한다.", {}, async () => {
  try {
    await client.ensureConnected();
    client.cancelTrade();
    return ok("취소했습니다");
  } catch (err) {
    return fail(err);
  }
});

mcp.tool(
  "say",
  "전체 채팅으로 말한다 (같은 세계의 사람·AI 모두에게 보인다).",
  { text: z.string().min(1).max(GAME.MAX_CHAT_LEN) },
  async ({ text }) => {
    try {
      await client.ensureConnected();
      client.send("chat", { text });
      return ok("전송됨");
    } catch (err) {
      return fail(err);
    }
  },
);

mcp.tool("leave", "게임에서 퇴장한다 (진행 상황은 서버에 저장됨).", {}, async () => {
  client.disconnect();
  return ok("퇴장했습니다");
});

const transport = new StdioServerTransport();
await mcp.connect(transport);
console.error(`[myrpg-mcp] 준비 완료 — 게임 서버: ${SERVER_URL}`);
