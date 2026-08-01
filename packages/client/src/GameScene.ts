import Phaser from "phaser";
import {
  GAME,
  dist,
  type Inventory,
  type NodeView,
  type PlayerView,
  type ServerMsg,
} from "@myrpg/protocol";
import type { Connection } from "./net.js";

type Welcome = Extract<ServerMsg, { type: "welcome" }>;

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
  view: NodeView;
  circle: Phaser.GameObjects.Arc;
  label: Phaser.GameObjects.Text;
}

export class GameScene extends Phaser.Scene {
  private conn!: Connection;
  private welcome!: Welcome;
  private players = new Map<string, PlayerSprite>();
  private nodes = new Map<string, NodeSprite>();
  private pendingGather: string | null = null;
  private progress: Phaser.GameObjects.Rectangle | null = null;

  constructor() {
    super("game");
  }

  init(data: { conn: Connection; welcome: Welcome }): void {
    this.conn = data.conn;
    this.welcome = data.welcome;
  }

  create(): void {
    const { map } = this.welcome;
    this.cameras.main.setBounds(0, 0, map.width, map.height);
    this.physics?.world?.setBounds(0, 0, map.width, map.height);
    this.drawGround(map.width, map.height);

    for (const n of this.welcome.nodes) this.upsertNode(n);
    this.addPlayer(this.welcome.you, true);
    for (const p of this.welcome.players) this.addPlayer(p, false);
    renderInventory(this.welcome.inventory);

    const me = this.players.get(this.welcome.playerId);
    if (me) this.cameras.main.startFollow(me.rect, true, 0.15, 0.15);

    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      const wx = pointer.worldX;
      const wy = pointer.worldY;
      const node = this.nodeAt(wx, wy);
      if (node && node.view.remaining > 0) {
        this.pendingGather = node.view.id;
        this.conn.send({ type: "move_to", x: node.view.x, y: node.view.y });
        this.tryGatherIfNear();
      } else {
        this.pendingGather = null;
        this.conn.send({ type: "move_to", x: wx, y: wy });
      }
    });

    this.wireNet();
  }

  private wireNet(): void {
    this.conn.on("state", (msg) => {
      for (const mv of msg.players) {
        const sprite = this.players.get(mv.id);
        if (sprite) {
          sprite.x = mv.x;
          sprite.y = mv.y;
        }
      }
      this.tryGatherIfNear();
    });
    this.conn.on("player_joined", (msg) => {
      this.addPlayer(msg.player, false);
      pushChat(`${msg.player.name} 님이 입장했습니다`, true);
    });
    this.conn.on("player_left", (msg) => {
      const sprite = this.players.get(msg.id);
      if (sprite) {
        sprite.rect.destroy();
        sprite.label.destroy();
        this.players.delete(msg.id);
      }
    });
    this.conn.on("chat", (msg) => pushChat(`${msg.name}: ${msg.text}`, false));
    this.conn.on("node_update", (msg) => this.upsertNode(msg.node));
    this.conn.on("gather_started", (msg) => this.showProgress(msg.endsAt));
    this.conn.on("gather_result", (msg) => {
      this.hideProgress();
      renderInventory(msg.inventory);
      pushChat(`${ITEM_LABEL[msg.item] ?? msg.item} +${msg.count}`, true);
    });
    this.conn.on("gather_failed", (msg) => {
      this.hideProgress();
      if (msg.reason !== "moved") pushChat(`채집 실패: ${msg.reason}`, true);
    });
  }

  update(): void {
    // 서버 좌표로 보간 이동 (표시만 부드럽게 — 판정은 전부 서버)
    for (const sprite of this.players.values()) {
      sprite.rect.x += (sprite.x - sprite.rect.x) * 0.3;
      sprite.rect.y += (sprite.y - sprite.rect.y) * 0.3;
      sprite.label.setPosition(sprite.rect.x, sprite.rect.y - 22);
      sprite.label.setOrigin(0.5, 1);
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
    if (dist(me.x, me.y, node.view.x, node.view.y) <= GAME.GATHER_RANGE) {
      this.conn.send({ type: "gather", nodeId: this.pendingGather });
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

  private addPlayer(p: PlayerView, isMe: boolean): void {
    if (this.players.has(p.id)) return;
    const rect = this.add.rectangle(p.x, p.y, 20, 26, isMe ? 0x66bb6a : 0x64b5f6).setStrokeStyle(2, 0x1a1a24);
    const label = this.add
      .text(p.x, p.y - 22, p.name, { fontSize: "12px", color: isMe ? "#a5d6a7" : "#bbdefb" })
      .setOrigin(0.5, 1);
    this.players.set(p.id, { rect, label, x: p.x, y: p.y });
  }

  private upsertNode(view: NodeView): void {
    let sprite = this.nodes.get(view.id);
    if (!sprite) {
      const circle = this.add.circle(view.x, view.y, 14, NODE_COLOR[view.kind] ?? 0xffffff);
      circle.setStrokeStyle(2, 0x111118);
      const label = this.add
        .text(view.x, view.y + 18, "", { fontSize: "11px", color: "#ccc" })
        .setOrigin(0.5, 0);
      sprite = { view, circle, label };
      this.nodes.set(view.id, sprite);
    }
    sprite.view = view;
    sprite.circle.setAlpha(view.remaining > 0 ? 1 : 0.25);
    sprite.label.setText(`${NODE_LABEL[view.kind] ?? view.kind} ${view.remaining}`);
  }

  private nodeAt(x: number, y: number): NodeSprite | null {
    for (const s of this.nodes.values()) if (dist(x, y, s.view.x, s.view.y) <= 24) return s;
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
