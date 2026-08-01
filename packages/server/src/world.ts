// 월드 시뮬레이션 — 서버 권위 물리. 네트워크를 모르는 순수 게임 로직.
// 사람이든 봇이든 여기의 같은 규칙을 통과한다 (P6).
import {
  dist,
  NODE_YIELD,
  type Inventory,
  type MapView,
  type NodeKind,
  type NodeView,
  type PlayerView,
} from "@myrpg/protocol";
import type { GameParams } from "./config.js";

export interface WorldNode {
  id: string;
  kind: NodeKind;
  x: number;
  y: number;
  remaining: number;
  respawnAt: number | null;
}

export interface WorldPlayer {
  id: string;
  name: string;
  x: number;
  y: number;
  target: { x: number; y: number } | null;
  gather: { nodeId: string; endsAt: number } | null;
  inventory: Inventory;
}

/** 틱이 만들어낸 사건들 — 네트워크 계층이 받아서 방송한다. */
export type WorldEvent =
  | { kind: "moved"; players: { id: string; x: number; y: number }[] }
  | { kind: "gather_done"; playerId: string; nodeId: string; item: string; count: number }
  | { kind: "gather_fail"; playerId: string; nodeId: string; reason: "depleted" | "moved" }
  | { kind: "node_changed"; node: NodeView };

export const HARAN_MAP: MapView = { id: "haran", width: 1280, height: 960 };
export const SPAWN = { x: 640, y: 480 };

// 하란 자원 배치: 벌목·채광·약초 3종 × 3개
const NODE_LAYOUT: { kind: NodeKind; x: number; y: number }[] = [
  { kind: "tree", x: 200, y: 200 },
  { kind: "tree", x: 320, y: 720 },
  { kind: "tree", x: 1080, y: 240 },
  { kind: "rock", x: 1100, y: 760 },
  { kind: "rock", x: 880, y: 620 },
  { kind: "rock", x: 160, y: 500 },
  { kind: "herb", x: 560, y: 180 },
  { kind: "herb", x: 700, y: 820 },
  { kind: "herb", x: 940, y: 420 },
];

export class World {
  readonly map = HARAN_MAP;
  readonly players = new Map<string, WorldPlayer>();
  readonly nodes = new Map<string, WorldNode>();

  constructor(private params: GameParams) {
    NODE_LAYOUT.forEach((n, i) => {
      const id = `n_${n.kind}_${i}`;
      this.nodes.set(id, { id, ...n, remaining: params.nodeCapacity, respawnAt: null });
    });
  }

  addPlayer(id: string, name: string, x: number, y: number, inventory: Inventory): WorldPlayer {
    const p: WorldPlayer = {
      id,
      name,
      x: clamp(x, 0, this.map.width),
      y: clamp(y, 0, this.map.height),
      target: null,
      gather: null,
      inventory,
    };
    this.players.set(id, p);
    return p;
  }

  removePlayer(id: string): void {
    this.players.delete(id);
  }

  /** 이동 명령. 채집 중이었다면 취소하고 그 사실을 반환한다. */
  moveTo(p: WorldPlayer, x: number, y: number): { cancelledGather: string | null } {
    p.target = { x: clamp(x, 0, this.map.width), y: clamp(y, 0, this.map.height) };
    const cancelled = p.gather?.nodeId ?? null;
    p.gather = null;
    return { cancelledGather: cancelled };
  }

  stop(p: WorldPlayer): void {
    p.target = null;
  }

  tryGather(
    p: WorldPlayer,
    nodeId: string,
    now: number,
  ): { ok: true; endsAt: number } | { ok: false; reason: "not_found" | "depleted" | "too_far" | "busy" } {
    const node = this.nodes.get(nodeId);
    if (!node) return { ok: false, reason: "not_found" };
    if (node.remaining <= 0) return { ok: false, reason: "depleted" };
    if (p.gather) return { ok: false, reason: "busy" };
    if (dist(p.x, p.y, node.x, node.y) > this.params.gatherRange) return { ok: false, reason: "too_far" };
    p.target = null; // 채집 시작 = 정지
    const endsAt = now + this.params.gatherMs;
    p.gather = { nodeId, endsAt };
    return { ok: true, endsAt };
  }

  /** dt(ms)만큼 시뮬레이션을 진행하고 발생한 사건을 돌려준다. */
  tick(now: number, dtMs: number): WorldEvent[] {
    const events: WorldEvent[] = [];
    const moved: { id: string; x: number; y: number }[] = [];

    for (const p of this.players.values()) {
      if (!p.target) continue;
      const d = dist(p.x, p.y, p.target.x, p.target.y);
      const step = (this.params.moveSpeed * dtMs) / 1000;
      if (d <= step) {
        p.x = p.target.x;
        p.y = p.target.y;
        p.target = null;
      } else {
        p.x += ((p.target.x - p.x) / d) * step;
        p.y += ((p.target.y - p.y) / d) * step;
      }
      moved.push({ id: p.id, x: round1(p.x), y: round1(p.y) });
    }
    if (moved.length > 0) events.push({ kind: "moved", players: moved });

    for (const p of this.players.values()) {
      if (!p.gather || now < p.gather.endsAt) continue;
      const { nodeId } = p.gather;
      p.gather = null;
      const node = this.nodes.get(nodeId);
      if (!node || node.remaining <= 0) {
        events.push({ kind: "gather_fail", playerId: p.id, nodeId, reason: "depleted" });
        continue;
      }
      node.remaining -= 1;
      if (node.remaining === 0) node.respawnAt = now + this.params.nodeRespawnMs;
      const item = NODE_YIELD[node.kind];
      p.inventory[item] = (p.inventory[item] ?? 0) + 1;
      events.push({ kind: "gather_done", playerId: p.id, nodeId, item, count: 1 });
      events.push({ kind: "node_changed", node: this.nodeView(node) });
    }

    for (const node of this.nodes.values()) {
      if (node.respawnAt !== null && now >= node.respawnAt) {
        node.remaining = this.params.nodeCapacity;
        node.respawnAt = null;
        events.push({ kind: "node_changed", node: this.nodeView(node) });
      }
    }

    return events;
  }

  playerView(p: WorldPlayer): PlayerView {
    return { id: p.id, name: p.name, x: round1(p.x), y: round1(p.y) };
  }

  nodeView(n: WorldNode): NodeView {
    return { id: n.id, kind: n.kind, x: n.x, y: n.y, remaining: n.remaining };
  }

  snapshotNodes(): NodeView[] {
    return [...this.nodes.values()].map((n) => this.nodeView(n));
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
