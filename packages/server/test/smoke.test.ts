// Phase 1 관문 테스트: "PROTOCOL.md만 보고 짠 봇이 접속해 채집 1회에 성공한다".
// 의도적으로 @myrpg/protocol을 임포트하지 않고 문서의 JSON 리터럴 그대로 통신한다 —
// 이 테스트가 깨지면 코드가 아니라 문서-서버 불일치가 생겼다는 뜻이다.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startServer, type RunningServer } from "../src/server.js";
import { MemoryStorage } from "../src/storage.js";
import type { ServerConfig } from "../src/config.js";

// 테스트는 빠른 물리로 돌린다 — 규칙은 같고 시간만 압축
const testConfig: ServerConfig = {
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
};

type Json = Record<string, any>;

/** 문서만 보고 만든 봇이 하는 일을 그대로 하는 미니 클라이언트. */
class TestClient {
  private queue: Json[] = [];
  private waiters: { pred: (m: Json) => boolean; resolve: (m: Json) => void }[] = [];
  private constructor(private ws: WebSocket) {}

  static connect(url: string): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const client = new TestClient(ws);
      ws.on("open", () => resolve(client));
      ws.on("error", reject);
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString()) as Json;
        const i = client.waiters.findIndex((w) => w.pred(msg));
        if (i >= 0) {
          const [w] = client.waiters.splice(i, 1);
          w!.resolve(msg);
        } else {
          client.queue.push(msg);
        }
      });
    });
  }

  send(msg: Json): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** 조건에 맞는 메시지를 (이미 도착했으면 큐에서, 아니면 도착을 기다려) 반환. */
  expectMsg(pred: (m: Json) => boolean, timeoutMs = 5000): Promise<Json> {
    const i = this.queue.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0]!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("메시지 대기 시간 초과")), timeoutMs);
      this.waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  close(): void {
    this.ws.close();
  }
}

let server: RunningServer;
let url: string;

beforeAll(async () => {
  server = await startServer({ config: testConfig, storage: new MemoryStorage() });
  url = `ws://127.0.0.1:${server.port}/ws`;
});

afterAll(async () => {
  await server.close();
});

describe("PROTOCOL.md 스모크", () => {
  it("봇이 접속 → 이동 → 채집 1회에 성공한다 (§10 최소 절차)", async () => {
    const bot = await TestClient.connect(url);
    bot.send({ type: "login", name: "smokebot" });
    const welcome = await bot.expectMsg((m) => m.type === "welcome");

    expect(welcome.protocol).toBe("0.1");
    expect(welcome.token).toBeTruthy();
    expect(welcome.map.id).toBe("haran");
    expect(welcome.nodes.length).toBeGreaterThan(0);

    // 가장 가까운 살아있는 노드 선택
    const me = welcome.you;
    const nodes = (welcome.nodes as Json[]).filter((n) => n.remaining > 0);
    nodes.sort((a, b) => Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y));
    const target = nodes[0]!;

    bot.send({ type: "move_to", x: target.x, y: target.y });

    // state에서 내 좌표 추적 — 노드 48px 이내 도달까지
    let near = false;
    for (let i = 0; i < 100 && !near; i++) {
      const state = await bot.expectMsg((m) => m.type === "state");
      const mine = (state.players as Json[]).find((p) => p.id === welcome.playerId);
      if (mine && Math.hypot(mine.x - target.x, mine.y - target.y) <= 48) near = true;
    }
    expect(near).toBe(true);

    bot.send({ type: "gather", nodeId: target.id });
    const started = await bot.expectMsg((m) => m.type === "gather_started");
    expect(started.nodeId).toBe(target.id);

    const result = await bot.expectMsg((m) => m.type === "gather_result");
    const expectedItem = { tree: "wood", rock: "copper_ore", herb: "herb" }[target.kind as string];
    expect(result.item).toBe(expectedItem);
    expect(result.inventory[expectedItem!]).toBe(1);

    // 노드 감소가 방송된다
    const nodeUpdate = await bot.expectMsg((m) => m.type === "node_update" && m.node.id === target.id);
    expect(nodeUpdate.node.remaining).toBe(target.remaining - 1);

    bot.close();
  }, 15_000);

  it("채팅이 두 클라이언트 사이에 방송된다", async () => {
    const a = await TestClient.connect(url);
    const b = await TestClient.connect(url);
    a.send({ type: "login", name: "chat_a" });
    b.send({ type: "login", name: "chat_b" });
    await a.expectMsg((m) => m.type === "welcome");
    await b.expectMsg((m) => m.type === "welcome");

    a.send({ type: "chat", text: "주괴 삽니다" });
    const got = await b.expectMsg((m) => m.type === "chat" && m.text === "주괴 삽니다");
    expect(got.name).toBe("chat_a");
    const echo = await a.expectMsg((m) => m.type === "chat" && m.text === "주괴 삽니다");
    expect(echo.from).toBe(got.from);

    a.close();
    b.close();
  });

  it("토큰 불일치 재접속은 auth_failed", async () => {
    const first = await TestClient.connect(url);
    first.send({ type: "login", name: "authtest" });
    await first.expectMsg((m) => m.type === "welcome");
    first.close();

    const second = await TestClient.connect(url);
    second.send({ type: "login", name: "authtest", token: "wrong-token" });
    const err = await second.expectMsg((m) => m.type === "error");
    expect(err.code).toBe("auth_failed");
    second.close();
  });

  it("이름 규칙 위반은 bad_request", async () => {
    const c = await TestClient.connect(url);
    c.send({ type: "login", name: "x" });
    const err = await c.expectMsg((m) => m.type === "error");
    expect(err.code).toBe("bad_request");
    c.close();
  });
});
