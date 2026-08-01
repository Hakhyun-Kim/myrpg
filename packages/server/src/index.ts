import { configFromEnv } from "./config.js";
import { startServer } from "./server.js";

const config = configFromEnv();
const server = await startServer({ config });
console.log(`[myrpg] 서버 기동: http://localhost:${server.port} (ws: /ws)`);

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  console.log(`[myrpg] ${signal} — 저장 후 종료`);
  await server.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
