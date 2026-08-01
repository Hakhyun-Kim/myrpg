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
        loginTimeoutMs: 10_000,
        rateLimitPerSec: 1000,
      },
    },
    storage: new MemoryStorage(),
  });
  url = `ws://127.0.0.1:${server.port}/ws`;
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
