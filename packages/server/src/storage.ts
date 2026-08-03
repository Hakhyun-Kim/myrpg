// 수칙: 영속화는 이 인터페이스 뒤에만. 클라우드 이전 시 FileStorage → PostgresStorage 교체로 끝나야 한다.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Inventory } from "@myrpg/protocol";
// 타입 전용 순환 참조 (런타임에는 지워진다) — 시장 데이터의 정의는 market.ts가 소유한다
import type { MarketData } from "./market.js";

export interface CraftJob {
  id: string;
  recipeId: string;
  total: number;
  done: number; // ready로 옮겨진 수
  startAt: number; // 현재 진행 중인 유닛의 시작 시각 (Unix ms) — 오프라인 진행의 근거
}

export interface SkillState {
  level: number;
  xp: number; // 현재 레벨에서 누적한 xp
}

export interface Account {
  name: string;
  token: string;
  x: number;
  y: number;
  inventory: Inventory;
  jobs?: CraftJob[]; // 제작 큐 (구버전 세이브 호환 위해 optional)
  ready?: Inventory; // 완료품 보관함
  silver?: number; // 은화 (Phase 2)
  skills?: Record<string, SkillState>; // 생활 스킬
  npcSold?: { day: number; count: number }; // NPC 매입 일일 한도 추적
  upkeepDay?: number; // 유지비를 마지막으로 낸 일차
  toolUses?: number; // 현재 도구의 사용 횟수
}

export interface SaveData {
  version: 1;
  accounts: Record<string, Account>;
  market?: MarketData; // 위탁 거래소 (Phase 2)
}

export interface Storage {
  load(): Promise<SaveData>;
  save(data: SaveData): Promise<void>;
}

export function emptySave(): SaveData {
  return { version: 1, accounts: {} };
}

/** JSON 파일 스토리지 — Phase 1용. 임시 파일에 쓴 뒤 rename으로 원자적 교체. */
export class FileStorage implements Storage {
  constructor(private dir: string) {}

  private get file(): string {
    return join(this.dir, "save.json");
  }

  async load(): Promise<SaveData> {
    try {
      const raw = await readFile(this.file, "utf8");
      return JSON.parse(raw) as SaveData;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptySave();
      throw err;
    }
  }

  async save(data: SaveData): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = this.file + ".tmp";
    await writeFile(tmp, JSON.stringify(data, null, 1), "utf8");
    await rename(tmp, this.file);
  }
}

/** 테스트용 인메모리 스토리지. */
export class MemoryStorage implements Storage {
  private data: SaveData = emptySave();
  async load(): Promise<SaveData> {
    return structuredClone(this.data);
  }
  async save(data: SaveData): Promise<void> {
    this.data = structuredClone(data);
  }
}
