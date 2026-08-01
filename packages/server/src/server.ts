// 서버 기동 — Colyseus Server + HTTP(/health, /config.json, 정적 클라이언트).
// Colyseus는 /matchmake* 요청만 가로채고 나머지는 우리 핸들러에 위임한다.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// colyseus는 CJS 전용 배포라 Node ESM에서 named import가 깨진다 — require로 가져온다
const require = createRequire(import.meta.url);
const { Server } = require("colyseus") as typeof import("colyseus");
const { WebSocketTransport } = require("@colyseus/ws-transport") as typeof import("@colyseus/ws-transport");
import { ROOM_NAME } from "@myrpg/protocol";
import type { ServerConfig } from "./config.js";
import { emptySave, FileStorage, type Storage } from "./storage.js";
import { HaranRoom } from "./room.js";

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

export interface StartOptions {
  config: ServerConfig;
  storage?: Storage;
}

export async function startServer(opts: StartOptions): Promise<RunningServer> {
  const { config } = opts;
  const storage = opts.storage ?? new FileStorage(config.dataDir);
  const save = await storage.load().catch((err) => {
    console.error("[storage] load 실패, 빈 상태로 시작:", err);
    return emptySave();
  });

  const clientDist = config.clientDist ?? defaultClientDist();
  const httpServer = createServer((req, res) => {
    void handleHttp(req, res, clientDist);
  });

  const gameServer = new Server({
    transport: new WebSocketTransport({ server: httpServer }),
    greet: false,
  });
  gameServer.define(ROOM_NAME, HaranRoom, { deps: { config, storage, save } });

  await gameServer.listen(config.port, config.host);
  const addr = httpServer.address();
  const port = typeof addr === "object" && addr ? addr.port : config.port;

  return {
    port,
    async close() {
      // 룸 dispose(저장 포함) + 전송 종료
      await gameServer.gracefullyShutdown(false);
    },
  };
}

// ---- 정적 파일 (프로덕션: 서버 하나가 클라이언트도 서빙 — 단일 프로세스 이식성) ----
function defaultClientDist(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const p = resolve(here, "../../client/dist");
  return existsSync(p) ? p : null;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
};

async function handleHttp(req: IncomingMessage, res: ServerResponse, clientDist: string | null): Promise<void> {
  const path = (req.url ?? "/").split("?")[0] ?? "/";
  if (path === "/health") return sendJson(res, { ok: true });
  if (path === "/config.json") return sendJson(res, { room: ROOM_NAME });

  if (clientDist && req.method === "GET") {
    const rel = path === "/" ? "index.html" : path.slice(1);
    const file = normalize(join(clientDist, rel));
    if (file.startsWith(normalize(clientDist)) && existsSync(file)) {
      try {
        const body = await readFile(file);
        res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
        res.end(body);
        return;
      } catch {
        /* fall through */
      }
    }
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}

function sendJson(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
