// 레퍼런스 채집 봇 — PROTOCOL.md만 보고 작성했다. @myrpg/protocol을 일부러 임포트하지 않는다.
// 이 파일이 "봇도 같은 문으로 들어온다"(P6)의 실증이자, LLM에게 봇을 짜게 할 때의 예제다.
//
// 사용:  npm run bot -- --name woodbot --url ws://localhost:7777/ws --loop
import WebSocket from "ws";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = parseArgs(process.argv.slice(2));
const url = args.url ?? "ws://localhost:7777/ws";
const name = args.name ?? `bot_${Math.random().toString(36).slice(2, 8)}`;
const loop = "loop" in args;

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

const ws = new WebSocket(url);
const queue: Json[] = [];
const waiters: { pred: (m: Json) => boolean; resolve: (m: Json) => void }[] = [];

ws.on("message", (data) => {
  const msg = JSON.parse(data.toString()) as Json;
  const i = waiters.findIndex((w) => w.pred(msg));
  if (i >= 0) waiters.splice(i, 1)[0]!.resolve(msg);
  else queue.push(msg);
});
ws.on("close", (code) => {
  console.log(`[bot] 연결 종료 (${code})`);
  process.exit(0);
});
ws.on("error", (err) => {
  console.error(`[bot] 연결 실패: ${err.message}`);
  process.exit(1);
});

function send(msg: Json): void {
  ws.send(JSON.stringify(msg));
}
function expectMsg(pred: (m: Json) => boolean, timeoutMs = 15000): Promise<Json> {
  const i = queue.findIndex(pred);
  if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]!);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("메시지 대기 시간 초과")), timeoutMs);
    waiters.push({ pred, resolve: (m) => { clearTimeout(timer); resolve(m); } });
  });
}

await new Promise<void>((res) => ws.on("open", () => res()));

// §4 로그인
const savedToken = loadTokens()[name];
send({ type: "login", name, ...(savedToken ? { token: savedToken } : {}) });
const first = await expectMsg((m) => m.type === "welcome" || m.type === "error");
if (first.type === "error") {
  console.error(`[bot] 로그인 실패: ${first.code} — ${first.message}`);
  process.exit(1);
}
const welcome = first;
saveToken(name, welcome.token);
console.log(`[bot] ${name} 입장 — ${welcome.map.id} (${welcome.you.x}, ${welcome.you.y}), 노드 ${welcome.nodes.length}개`);

let me = { x: welcome.you.x as number, y: welcome.you.y as number };
const nodes = new Map<string, Json>((welcome.nodes as Json[]).map((n) => [n.id, n]));

// 노드 상태를 계속 반영
void (async () => {
  for (;;) {
    const upd = await expectMsg((m) => m.type === "node_update", 86_400_000);
    nodes.set(upd.node.id, upd.node);
  }
})();

// §10 최소 절차 반복
do {
  const alive = [...nodes.values()].filter((n) => n.remaining > 0);
  if (alive.length === 0) {
    console.log("[bot] 살아있는 노드 없음 — 5초 대기");
    await sleep(5000);
    continue;
  }
  alive.sort((a, b) => hyp(a, me) - hyp(b, me));
  const target = alive[0]!;
  console.log(`[bot] 목표: ${target.id} (${target.kind}, 남은 ${target.remaining})`);

  send({ type: "move_to", x: target.x, y: target.y });
  for (;;) {
    const state = await expectMsg((m) => m.type === "state");
    const mine = (state.players as Json[]).find((p) => p.id === welcome.playerId);
    if (mine) me = { x: mine.x, y: mine.y };
    if (hyp(target, me) <= 48) break;
  }

  send({ type: "gather", nodeId: target.id });
  const started = await expectMsg((m) => m.type === "gather_started" || m.type === "gather_failed");
  if (started.type === "gather_failed") {
    console.log(`[bot] 채집 거부: ${started.reason}`);
    nodes.get(target.id)!.remaining = 0; // 다음 후보로
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
ws.close();

function hyp(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
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
