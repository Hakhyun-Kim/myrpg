// 레퍼런스 채집 봇 — PROTOCOL.md의 룸 계약을 공식 JS SDK(colyseus.js)로 구현했다.
// 이 파일이 "봇도 같은 문으로 들어온다"(P6)의 실증이자, LLM에게 봇을 짜게 할 때의 예제다.
//
// 사용:  npm run bot -- --name woodbot --url ws://localhost:7777 --loop
import { Client, type Room } from "colyseus.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = parseArgs(process.argv.slice(2));
const url = args.url ?? "ws://localhost:7777";
const name = args.name ?? `bot_${Math.random().toString(36).slice(2, 8)}`;
const loop = "loop" in args;

const GATHER_RANGE = 48; // PROTOCOL.md §6

// 토큰 보관 (data/는 gitignore)
const tokenDir = "./data";
const tokenFile = join(tokenDir, "bot-tokens.json");
function loadTokens(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(tokenFile, "utf8"));
  } catch {
    return {};
  }
}
function saveToken(botName: string, token: string): void {
  const tokens = loadTokens();
  tokens[botName] = token;
  mkdirSync(tokenDir, { recursive: true });
  writeFileSync(tokenFile, JSON.stringify(tokens, null, 1));
}

type Json = Record<string, any>;

let room: Room;
try {
  const savedToken = loadTokens()[name];
  room = await new Client(url).joinOrCreate("haran", { name, ...(savedToken ? { token: savedToken } : {}) });
} catch (err) {
  console.error(`[bot] 입장 실패: ${(err as Error).message}`);
  process.exit(1);
}

const queue: Json[] = [];
const waiters: { pred: (m: Json) => boolean; resolve: (m: Json) => void }[] = [];
for (const type of ["welcome", "gather_started", "gather_result", "gather_failed"]) {
  room.onMessage(type, (payload: Json) => {
    const msg = { type, ...payload };
    const i = waiters.findIndex((w) => w.pred(msg));
    if (i >= 0) waiters.splice(i, 1)[0]!.resolve(msg);
    else queue.push(msg);
  });
}
room.onLeave((code) => {
  console.log(`[bot] 연결 종료 (${code})`);
  process.exit(0);
});

function expectMsg(pred: (m: Json) => boolean, timeoutMs = 15000): Promise<Json> {
  const i = queue.findIndex(pred);
  if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]!);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("메시지 대기 시간 초과")), timeoutMs);
    waiters.push({ pred, resolve: (m) => { clearTimeout(timer); resolve(m); } });
  });
}
function waitState(pred: () => boolean, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (pred()) return resolve();
    const start = Date.now();
    const iv = setInterval(() => {
      if (pred()) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(iv);
        reject(new Error("상태 대기 시간 초과"));
      }
    }, 50);
  });
}

// 핸드셰이크: 핸들러 등록 후 welcome 요청
room.send("hello");
const welcome = await expectMsg((m) => m.type === "welcome");
saveToken(name, welcome.token);

const state = room.state as Json;
await waitState(() => state.nodes?.size > 0 && state.players?.has(welcome.playerId));
const myPos = () => state.players.get(welcome.playerId) as { x: number; y: number };
console.log(
  `[bot] ${name} 입장 — ${state.mapId} (${Math.round(myPos().x)}, ${Math.round(myPos().y)}), 노드 ${state.nodes.size}개`,
);

do {
  // 살아있는 노드 중 가장 가까운 것
  let targetId = "";
  let target: Json | null = null;
  let best = Infinity;
  state.nodes.forEach((n: Json, id: string) => {
    if (n.remaining <= 0) return;
    const d = Math.hypot(n.x - myPos().x, n.y - myPos().y);
    if (d < best) {
      best = d;
      target = n;
      targetId = id;
    }
  });
  if (!target) {
    console.log("[bot] 살아있는 노드 없음 — 5초 대기");
    await sleep(5000);
    continue;
  }
  const t = target as Json;
  console.log(`[bot] 목표: ${targetId} (${t.kind}, 남은 ${t.remaining})`);

  room.send("move_to", { x: t.x, y: t.y });
  await waitState(() => Math.hypot(t.x - myPos().x, t.y - myPos().y) <= GATHER_RANGE);

  room.send("gather", { nodeId: targetId });
  const started = await expectMsg((m) => m.type === "gather_started" || m.type === "gather_failed");
  if (started.type === "gather_failed") {
    console.log(`[bot] 채집 거부: ${started.reason}`);
    continue;
  }
  const result = await expectMsg((m) => m.type === "gather_result" || m.type === "gather_failed");
  if (result.type === "gather_result") {
    console.log(`[bot] 획득: ${result.item} ×${result.count} — 가방:`, result.inventory);
  } else {
    console.log(`[bot] 채집 실패: ${result.reason}`);
  }
} while (loop);

console.log("[bot] 1회 채집 완료 — 종료");
await room.leave();
process.exit(0);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else out[key] = "";
    }
  }
  return out;
}
