// 수칙: 모든 설정은 env에서, 기본값은 로컬 개발용. 코드 어디에도 배포 주소를 하드코딩하지 않는다.
import { GAME } from "@myrpg/protocol";

export interface GameParams {
  tickMs: number;
  moveSpeed: number;
  gatherMs: number;
  gatherRange: number;
  nodeCapacity: number;
  nodeRespawnMs: number;
  rateLimitPerSec: number;
}

export interface ServerConfig {
  port: number;
  host: string;
  dataDir: string;
  autosaveSec: number;
  clientDist: string | null;
  game: GameParams;
}

export function defaultGameParams(): GameParams {
  return {
    tickMs: GAME.TICK_MS,
    moveSpeed: GAME.MOVE_SPEED,
    gatherMs: GAME.GATHER_MS,
    gatherRange: GAME.GATHER_RANGE,
    nodeCapacity: GAME.NODE_CAPACITY,
    nodeRespawnMs: GAME.NODE_RESPAWN_MS,
    rateLimitPerSec: GAME.RATE_LIMIT_PER_SEC,
  };
}

export function configFromEnv(): ServerConfig {
  return {
    port: intEnv("PORT", 7777),
    host: process.env.HOST ?? "0.0.0.0",
    dataDir: process.env.DATA_DIR ?? "./data",
    autosaveSec: intEnv("AUTOSAVE_SEC", 30),
    clientDist: process.env.CLIENT_DIST ?? null,
    game: defaultGameParams(),
  };
}

function intEnv(key: string, def: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`env ${key}=${v} is not a number`);
  return n;
}
