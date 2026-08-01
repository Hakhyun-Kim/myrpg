import Phaser from "phaser";
import type { Room } from "colyseus.js";
import {
  GAME,
  dist,
  type ChatMsg,
  type GatherFailedMsg,
  type GatherResultMsg,
  type GatherStartedMsg,
  type Inventory,
  type WelcomeMsg,
} from "@myrpg/protocol";

// 서버 스키마의 클라이언트 측 투영 (colyseus.js 리플렉션 인스턴스)
interface PlayerState {
  name: string;
  x: number;
  y: number;
  onChange(cb: () => void): () => void;
}
interface NodeState {
  kind: string;
  x: number;
  y: number;
  remaining: number;
  onChange(cb: () => void): () => void;
}

const NODE_COLOR: Record<string, number> = { tree: 0x2e7d32, rock: 0x78909c, herb: 0xab47bc };
const NODE_LABEL: Record<string, string> = { tree: "나무", rock: "바위", herb: "약초" };
const ITEM_LABEL: Record<string, string> = { wood: "원목", copper_ore: "구리 광석", herb: "생약초" };

interface PlayerSprite {
  rect: Phaser.GameObjects.Rectangle;
  label: Phaser.GameObjects.Text;
  x: number;
  y: number;
}

interface NodeSprite {
  state: NodeState;
  circle: Phaser.GameObjects.Arc;
  label: Phaser.GameObjects.Text;
}

export class GameScene extends Phaser.Scene {
  private room!: Room;
  private welcome!: WelcomeMsg;
  private players = new Map<string, PlayerSprite>();
  private nodes = new Map<string, NodeSprite>();
  private pendingGather: string | null = null;
  private progress: Phaser.GameObjects.Rectangle | null = null;
  private joinedAt = 0;

  constructor() {
    super("game");
  }

  init(data: { room: Room; welcome: WelcomeMsg }): void {
    this.room = data.room;
    this.welcome = data.welcome;
  }

  create(): void {
    this.joinedAt = Date.now();
    const state = this.room.state as {
      width: number;
      height: number;
      players: {
        onAdd(cb: (p: PlayerState, id: string) => void, triggerAll?: boolean): void;
        onRemove(cb: (p: PlayerState, id: string) => void): void;
      };
      nodes: { onAdd(cb: (n: NodeState, id: string) => void, triggerAll?: boolean): void };
    };

    this.cameras.main.setBounds(0, 0, state.width, state.height);
    this.drawGround(state.width, state.height);
    renderInventory(this.welcome.inventory);

    state.players.onAdd((p, id) => {
      this.addPlayer(id, p);
      if (id !== this.welcome.playerId && Date.now() - this.joinedAt > 1000)
        pushChat(`${p.name} 님이 입장했습니다`, true);
      p.onChange(() => {
        const sprite = this.players.get(id);
        if (sprite) {
          sprite.x = p.x;
          sprite.y = p.y;
        }
        if (id === this.welcome.playerId) this.tryGatherIfNear();
      });
    }, true);
    state.players.onRemove((_p, id) => {
      const sprite = this.players.get(id);
      if (sprite) {
        sprite.rect.destroy();
        sprite.label.destroy();
        this.players.delete(id);
      }
    });
    state.nodes.onAdd((n, id) => {
      this.upsertNode(id, n);
      n.onChange(() => this.upsertNode(id, n));
    }, true);

    this.room.onMessage<ChatMsg>("chat", (msg) => pushChat(`${msg.name}: ${msg.text}`, false));
    this.room.onMessage<GatherStartedMsg>("gather_started", (msg) => this.showProgress(msg.endsAt));
    this.room.onMessage<GatherResultMsg>("gather_result", (msg) => {
      this.hideProgress();
      renderInventory(msg.inventory);
      pushChat(`${ITEM_LABEL[msg.item] ?? msg.item} +${msg.count}`, true);
    });
    this.room.onMessage<GatherFailedMsg>("gather_failed", (msg) => {
      this.hideProgress();
      if (msg.reason !== "moved") pushChat(`채집 실패: ${msg.reason}`, true);
    });

    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      const wx = pointer.worldX;
      const wy = pointer.worldY;
      const nodeId = this.nodeAt(wx, wy);
      const node = nodeId ? this.nodes.get(nodeId) : null;
      if (nodeId && node && node.state.remaining > 0) {
        this.pendingGather = nodeId;
        this.room.send("move_to", { x: node.state.x, y: node.state.y });
        this.tryGatherIfNear();
      } else {
        this.pendingGather = null;
        this.room.send("move_to", { x: wx, y: wy });
      }
    });
  }

  update(): void {
    // 서버 좌표로 보간 이동 (표시만 부드럽게 — 판정은 전부 서버)
    for (const sprite of this.players.values()) {
      sprite.rect.x += (sprite.x - sprite.rect.x) * 0.3;
      sprite.rect.y += (sprite.y - sprite.rect.y) * 0.3;
      sprite.label.setPosition(sprite.rect.x, sprite.rect.y - 22);
    }
    if (this.progress) {
      const me = this.players.get(this.welcome.playerId);
      if (me) this.progress.setPosition(me.rect.x, me.rect.y - 30);
    }
  }

  private tryGatherIfNear(): void {
    if (!this.pendingGather) return;
    const me = this.players.get(this.welcome.playerId);
    const node = this.nodes.get(this.pendingGather);
    if (!me || !node) return;
    if (dist(me.x, me.y, node.state.x, node.state.y) <= GAME.GATHER_RANGE) {
      this.room.send("gather", { nodeId: this.pendingGather });
      this.pendingGather = null;
    }
  }

  private drawGround(w: number, h: number): void {
    const g = this.add.graphics();
    g.fillStyle(0x22301c);
    g.fillRect(0, 0, w, h);
    g.lineStyle(1, 0x2a3a24, 0.6);
    for (let x = 0; x <= w; x += 64) g.lineBetween(x, 0, x, h);
    for (let y = 0; y <= h; y += 64) g.lineBetween(0, y, w, y);
    g.lineStyle(3, 0x5a4a2a);
    g.strokeRect(0, 0, w, h);
  }

  private addPlayer(id: string, p: PlayerState): void {
    if (this.players.has(id)) return;
    const isMe = id === this.welcome.playerId;
    const rect = this.add.rectangle(p.x, p.y, 20, 26, isMe ? 0x66bb6a : 0x64b5f6).setStrokeStyle(2, 0x1a1a24);
    const label = this.add
      .text(p.x, p.y - 22, p.name, { fontSize: "12px", color: isMe ? "#a5d6a7" : "#bbdefb" })
      .setOrigin(0.5, 1);
    this.players.set(id, { rect, label, x: p.x, y: p.y });
    if (isMe) this.cameras.main.startFollow(rect, true, 0.15, 0.15);
  }

  private upsertNode(id: string, n: NodeState): void {
    let sprite = this.nodes.get(id);
    if (!sprite) {
      const circle = this.add.circle(n.x, n.y, 14, NODE_COLOR[n.kind] ?? 0xffffff);
      circle.setStrokeStyle(2, 0x111118);
      const label = this.add
        .text(n.x, n.y + 18, "", { fontSize: "11px", color: "#ccc" })
        .setOrigin(0.5, 0);
      sprite = { state: n, circle, label };
      this.nodes.set(id, sprite);
    }
    sprite.state = n;
    sprite.circle.setAlpha(n.remaining > 0 ? 1 : 0.25);
    sprite.label.setText(`${NODE_LABEL[n.kind] ?? n.kind} ${n.remaining}`);
  }

  private nodeAt(x: number, y: number): string | null {
    for (const [id, s] of this.nodes) if (dist(x, y, s.state.x, s.state.y) <= 24) return id;
    return null;
  }

  private showProgress(endsAt: number): void {
    this.hideProgress();
    const me = this.players.get(this.welcome.playerId);
    if (!me) return;
    this.progress = this.add.rectangle(me.rect.x, me.rect.y - 30, 1, 4, 0xd8b45a).setOrigin(0.5, 0.5);
    const duration = Math.max(50, endsAt - Date.now());
    this.tweens.add({ targets: this.progress, width: 36, duration, onComplete: () => this.hideProgress() });
  }

  private hideProgress(): void {
    this.progress?.destroy();
    this.progress = null;
  }
}

// ---- DOM HUD ----
export function renderInventory(inv: Inventory): void {
  const el = document.getElementById("inv-items")!;
  const entries = Object.entries(inv).filter(([, n]) => n > 0);
  el.innerHTML =
    entries.length === 0
      ? "비어 있음"
      : entries.map(([item, n]) => `${ITEM_LABEL[item] ?? item} × ${n}`).join("<br>");
}

export function pushChat(text: string, system: boolean): void {
  const log = document.getElementById("chatlog")!;
  const div = document.createElement("div");
  if (system) div.className = "sys";
  div.textContent = text;
  log.appendChild(div);
  while (log.children.length > 10) log.removeChild(log.firstChild!);
}
