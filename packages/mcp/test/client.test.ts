// GameClient(MCP 도구의 게임 접속 계층)가 실제 서버를 상대로 행동 단위 API를 지키는지 검증.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "@myrpg/server/src/server.js";
import { MemoryStorage } from "@myrpg/server/src/storage.js";
import { GameClient } from "../src/client.js";

let server: RunningServer;
let url: string;

beforeAll(async () => {
  server = await startServer({
    config: {
      port: 0,
      host: "127.0.0.1",
      dataDir: "unused",
      autosaveSec: 9999,
      clientDist: null,
      game: {
        tickMs: 20,
        moveSpeed: 2000,
        gatherMs: 200,
        gatherRange: 48,
        nodeCapacity: 5,
        nodeRespawnMs: 1000,
        rateLimitPerSec: 1000,
        craftMsT1: 300,
        craftSlots: 3,
      },
    },
    storage: new MemoryStorage(),
  });
  url = `ws://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
});

describe("GameClient (MCP 계층)", () => {
  it("join → 가장 가까운 바위 채집 → 인벤토리 반영", async () => {
    const c = new GameClient();
    await c.connect(url, "mcp_agent");
    expect(c.connected).toBe(true);
    expect(c.map.id).toBe("haran");

    const rock = c.nearestNode("rock");
    expect(rock).not.toBeNull();

    const r = await c.gatherNode(rock!.id);
    expect(r.item).toBe("copper_ore");
    expect(c.inventory["copper_ore"]).toBe(1);

    const summary = c.summary() as { nodes: { id: string; remaining: number }[] };
    const after = summary.nodes.find((n) => n.id === rock!.id);
    expect(after?.remaining).toBe(4);

    c.disconnect();
  }, 15_000);

  it("goto는 도착까지 대기한다", async () => {
    const c = new GameClient();
    await c.connect(url, "mcp_goto");
    await c.goto(100, 100);
    expect(Math.hypot(c.me.x - 100, c.me.y - 100)).toBeLessThanOrEqual(2);
    c.disconnect();
  }, 15_000);

  it("채집 → 제련 등록 → 완성 대기 → 수령", async () => {
    const c = new GameClient();
    await c.connect(url, "mcp_smith");
    const rock = c.nearestNode("rock")!;
    await c.gatherNode(rock.id);
    await c.gatherNode(rock.id);
    expect(c.inventory["copper_ore"]).toBe(2);

    const q = await c.craft("copper_ingot", 1);
    expect(q.jobs.length).toBe(1);
    expect(c.inventory["copper_ore"] ?? 0).toBe(0); // 원료 차감 (inventory 메시지 반영)

    // craftMsT1=300ms — 완성 후 수령
    await new Promise((r) => setTimeout(r, 600));
    const res = await c.claim();
    expect(res.claimed).toEqual({ copper_ingot: 1 });
    expect(c.inventory["copper_ingot"]).toBe(1);

    await expect(c.craft("copper_ingot", 1)).rejects.toThrow(/no_materials/);
    c.disconnect();
  }, 20_000);

  it("고갈 노드 채집은 명확한 오류를 던진다", async () => {
    const c = new GameClient();
    await c.connect(url, "mcp_err");
    const node = c.nearestNode()!;
    // 남은 수량만큼 캐서 고갈시킨다 (앞 테스트가 이미 캤을 수 있음)
    const remaining = c.nodes.get(node.id)!.remaining;
    for (let i = 0; i < remaining; i++) await c.gatherNode(node.id);
    await expect(c.gatherNode(node.id)).rejects.toThrow(/고갈/);
    c.disconnect();
  }, 20_000);
});
