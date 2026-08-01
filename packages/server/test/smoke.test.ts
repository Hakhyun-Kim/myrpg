// Phase 1 관문 테스트: "PROTOCOL.md만 보고 짠 봇이 접속해 채집 1회에 성공한다".
// D7 이후 계약은 Colyseus 룸이다 — 봇은 공식 JS SDK(colyseus.js)로 문서의 계약 그대로 통신한다.
// 이 테스트가 깨지면 코드가 아니라 문서-서버 불일치가 생겼다는 뜻이다.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Room } from "colyseus.js";
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
    rateLimitPerSec: 1000,
  },
};

type Json = Record<string, any>;
const CAPTURED = ["welcome", "chat", "gather_started", "gather_result", "gather_failed"] as const;

/** 룸 메시지를 큐로 받아 조건 대기할 수 있게 감싼 미니 클라이언트. */
class TestClient {
  private queue: Json[] = [];
  private waiters: { pred: (m: Json) => boolean; resolve: (m: Json) => void }[] = [];

  private constructor(readonly room: Room) {
    for (const type of CAPTURED) {
      room.onMessage(type, (payload: Json) => {
        const msg = { type, ...payload };
        const i = this.waiters.findIndex((w) => w.pred(msg));
        if (i >= 0) this.waiters.splice(i, 1)[0]!.resolve(msg);
        else this.queue.push(msg);
      });
    }
  }

  static async join(url: string, options: Json): Promise<TestClient> {
    const room = await new Client(url).joinOrCreate("haran", options);
    const tc = new TestClient(room);
    tc.room.send("hello"); // 핸들러 등록 후 welcome 요청 (PROTOCOL.md 핸드셰이크)
    return tc;
  }

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

  /** 상태 스키마에서 조건 충족까지 대기 (폴링 — 스키마는 자동 동기화됨). */
  waitState(pred: () => boolean, timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const iv = setInterval(() => {
        if (pred()) {
          clearInterval(iv);
          resolve();
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(iv);
          reject(new Error("상태 대기 시간 초과"));
        }
      }, 20);
    });
  }

  async leave(): Promise<void> {
    await this.room.leave();
  }
}

let server: RunningServer;
let url: string;

beforeAll(async () => {
  server = await startServer({ config: testConfig, storage: new MemoryStorage() });
  url = `ws://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
});

describe("PROTOCOL.md 스모크 (Colyseus 계약)", () => {
  it("봇이 입장 → 이동 → 채집 1회에 성공한다", async () => {
    const bot = await TestClient.join(url, { name: "smokebot" });
    const welcome = await bot.expectMsg((m) => m.type === "welcome");
    expect(welcome.protocol).toBe("0.2");
    expect(welcome.token).toBeTruthy();

    const state = bot.room.state as Json;
    await bot.waitState(() => state.nodes.size > 0 && state.players.has(welcome.playerId));
    expect(state.mapId).toBe("haran");

    // 가장 가까운 살아있는 노드 선택
    const me = state.players.get(welcome.playerId);
    let target: Json | null = null;
    let targetId = "";
    let best = Infinity;
    state.nodes.forEach((n: Json, id: string) => {
      if (n.remaining <= 0) return;
      const d = Math.hypot(n.x - me.x, n.y - me.y);
      if (d < best) {
        best = d;
        target = n;
        targetId = id;
      }
    });
    expect(target).not.toBeNull();
    const initialRemaining = target!.remaining as number;

    bot.room.send("move_to", { x: target!.x, y: target!.y });
    await bot.waitState(() => {
      const p = state.players.get(welcome.playerId);
      return Math.hypot(p.x - target!.x, p.y - target!.y) <= 48;
    });

    bot.room.send("gather", { nodeId: targetId });
    const started = await bot.expectMsg((m) => m.type === "gather_started");
    expect(started.nodeId).toBe(targetId);

    const result = await bot.expectMsg((m) => m.type === "gather_result");
    const expectedItem = { tree: "wood", rock: "copper_ore", herb: "herb" }[target!.kind as string];
    expect(result.item).toBe(expectedItem);
    expect(result.inventory[expectedItem!]).toBe(1);

    // 노드 감소가 스키마로 동기화된다
    await bot.waitState(() => state.nodes.get(targetId).remaining === initialRemaining - 1);

    await bot.leave();
  }, 15_000);

  it("채팅이 두 클라이언트 사이에 방송된다", async () => {
    const a = await TestClient.join(url, { name: "chat_a" });
    const b = await TestClient.join(url, { name: "chat_b" });
    await a.expectMsg((m) => m.type === "welcome");
    await b.expectMsg((m) => m.type === "welcome");

    a.room.send("chat", { text: "주괴 삽니다" });
    const got = await b.expectMsg((m) => m.type === "chat" && m.text === "주괴 삽니다");
    expect(got.name).toBe("chat_a");
    const echo = await a.expectMsg((m) => m.type === "chat" && m.text === "주괴 삽니다");
    expect(echo.from).toBe(got.from);

    await a.leave();
    await b.leave();
  });

  it("토큰 불일치 재접속은 거부된다", async () => {
    const first = await TestClient.join(url, { name: "authtest" });
    await first.expectMsg((m) => m.type === "welcome");
    await first.leave();

    await expect(TestClient.join(url, { name: "authtest", token: "wrong-token" })).rejects.toThrow(
      /auth_failed/,
    );
  });

  it("이름 규칙 위반은 거부된다", async () => {
    await expect(TestClient.join(url, { name: "x" })).rejects.toThrow(/bad_request/);
  });
});
