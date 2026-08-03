// 3D 월드 뷰 (Three.js) — 서버 룸 상태의 시각화일 뿐, 판정은 전부 서버.
// 게임 좌표 (x, y) → 3D 좌표 (x, 0, y) 매핑. 단위는 게임과 동일한 픽셀.
import * as THREE from "three";
import type { Room } from "colyseus.js";
import {
  GAME,
  ITEM_LABELS,
  dist,
  type ChatMsg,
  type GatherFailedMsg,
  type GatherResultMsg,
  type GatherStartedMsg,
  type WelcomeMsg,
} from "@myrpg/protocol";
import { hideGatherBar, pushChat, renderInventory, showGatherBar, updateGatherBar } from "./hud.js";

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

interface PlayerObj {
  group: THREE.Group;
  sx: number; // 서버 좌표 (보간 목표)
  sy: number;
}

interface NodeObj {
  group: THREE.Group;
  state: NodeState;
  label: THREE.Sprite;
}

const NODE_LABEL: Record<string, string> = { tree: "나무", rock: "바위", herb: "약초" };

export class World3D {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private raycaster = new THREE.Raycaster();
  private players = new Map<string, PlayerObj>();
  private nodes = new Map<string, NodeObj>();
  private clickables: THREE.Object3D[] = [];
  private ground!: THREE.Mesh;
  private pendingGather: string | null = null;
  private zoom = 1;
  private joinedAt = Date.now();

  constructor(
    container: HTMLElement,
    private room: Room,
    private welcome: WelcomeMsg,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x10141c);
    this.scene.fog = new THREE.Fog(0x10141c, 900, 2000);

    this.camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 1, 4000);
    this.camera.position.set(640, 500, 900);

    this.buildTerrain();
    this.buildLights();
    this.bindState();
    this.bindInput();

    window.addEventListener("resize", () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });

    renderInventory(welcome.inventory);
    this.animate();
  }

  // ---- 지형 ----
  private buildTerrain(): void {
    const state = this.room.state as { width: number; height: number };
    const w = state.width || 1280;
    const h = state.height || 960;

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshLambertMaterial({ color: 0x2c4526 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(w / 2, 0, h / 2);
    ground.receiveShadow = true;
    this.scene.add(ground);
    this.ground = ground;

    // 맵 밖 어두운 대지 (경계 인지용)
    const outer = new THREE.Mesh(
      new THREE.PlaneGeometry(w * 4, h * 4),
      new THREE.MeshLambertMaterial({ color: 0x1a2418 }),
    );
    outer.rotation.x = -Math.PI / 2;
    outer.position.set(w / 2, -0.5, h / 2);
    this.scene.add(outer);

    // 풀 장식 (시각적 깊이감용 — 게임 데이터 아님)
    const tuftGeo = new THREE.ConeGeometry(3, 8, 5);
    const tuftMat = new THREE.MeshLambertMaterial({ color: 0x3a5c30 });
    for (let i = 0; i < 80; i++) {
      const tuft = new THREE.Mesh(tuftGeo, tuftMat);
      tuft.position.set(Math.random() * w, 4, Math.random() * h);
      tuft.rotation.y = Math.random() * Math.PI;
      this.scene.add(tuft);
    }
  }

  private buildLights(): void {
    this.scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x2a3a24, 0.9));
    const sun = new THREE.DirectionalLight(0xfff2d8, 1.6);
    sun.position.set(900, 800, 300);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -900;
    sun.shadow.camera.right = 900;
    sun.shadow.camera.top = 900;
    sun.shadow.camera.bottom = -900;
    sun.shadow.camera.far = 2500;
    sun.target.position.set(640, 0, 480);
    this.scene.add(sun, sun.target);
  }

  // ---- 상태 바인딩 (2D 클라이언트와 동일한 계약) ----
  private bindState(): void {
    const state = this.room.state as {
      players: {
        onAdd(cb: (p: PlayerState, id: string) => void, triggerAll?: boolean): void;
        onRemove(cb: (p: PlayerState, id: string) => void): void;
      };
      nodes: { onAdd(cb: (n: NodeState, id: string) => void, triggerAll?: boolean): void };
    };

    state.players.onAdd((p, id) => {
      this.addPlayer(id, p);
      if (id !== this.welcome.playerId && Date.now() - this.joinedAt > 1000)
        pushChat(`${p.name} 님이 입장했습니다`, true);
      p.onChange(() => {
        const obj = this.players.get(id);
        if (obj) {
          obj.sx = p.x;
          obj.sy = p.y;
        }
        if (id === this.welcome.playerId) this.tryGatherIfNear();
      });
    }, true);
    state.players.onRemove((_p, id) => {
      const obj = this.players.get(id);
      if (obj) {
        this.scene.remove(obj.group);
        this.players.delete(id);
      }
    });
    state.nodes.onAdd((n, id) => {
      this.addNode(id, n);
      n.onChange(() => this.refreshNode(id));
    }, true);

    this.room.onMessage<ChatMsg>("chat", (msg) => pushChat(`${msg.name}: ${msg.text}`, false));
    this.room.onMessage<GatherStartedMsg>("gather_started", (msg) => showGatherBar(msg.endsAt));
    this.room.onMessage<GatherResultMsg>("gather_result", (msg) => {
      hideGatherBar();
      renderInventory(msg.inventory);
      pushChat(`획득 +${msg.count} (${ITEM_LABELS[msg.item] ?? msg.item})`, true);
    });
    this.room.onMessage<GatherFailedMsg>("gather_failed", (msg) => {
      hideGatherBar();
      if (msg.reason !== "moved") pushChat(`채집 실패: ${msg.reason}`, true);
    });
  }

  // ---- 오브젝트 생성 ----
  private addPlayer(id: string, p: PlayerState): void {
    if (this.players.has(id)) return;
    const isMe = id === this.welcome.playerId;
    const group = new THREE.Group();

    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(9, 18, 4, 12),
      new THREE.MeshLambertMaterial({ color: isMe ? 0x5cbb6a : 0x5a9be0 }),
    );
    body.position.y = 20;
    body.castShadow = true;
    group.add(body);

    const label = makeTextSprite(p.name, isMe ? "#a5d6a7" : "#bbdefb");
    label.position.y = 52;
    group.add(label);

    group.position.set(p.x, 0, p.y);
    this.scene.add(group);
    this.players.set(id, { group, sx: p.x, sy: p.y });
  }

  private addNode(id: string, n: NodeState): void {
    if (this.nodes.has(id)) return;
    const group = new THREE.Group();

    if (n.kind === "tree") {
      const trunk = new THREE.Mesh(
        new THREE.CylinderGeometry(4, 6, 26, 7),
        new THREE.MeshLambertMaterial({ color: 0x6b4a2a }),
      );
      trunk.position.y = 13;
      trunk.castShadow = true;
      const leaves = new THREE.Mesh(
        new THREE.ConeGeometry(22, 44, 8),
        new THREE.MeshLambertMaterial({ color: 0x2e7d32 }),
      );
      leaves.position.y = 46;
      leaves.castShadow = true;
      group.add(trunk, leaves);
    } else if (n.kind === "rock") {
      const rock = new THREE.Mesh(
        new THREE.DodecahedronGeometry(16, 0),
        new THREE.MeshLambertMaterial({ color: 0x8a97a5 }),
      );
      rock.position.y = 10;
      rock.rotation.set(Math.random(), Math.random() * Math.PI, Math.random() * 0.5);
      rock.castShadow = true;
      group.add(rock);
    } else {
      const stemMat = new THREE.MeshLambertMaterial({ color: 0x3f6f35 });
      const bloomMat = new THREE.MeshLambertMaterial({ color: 0xab47bc });
      for (let i = 0; i < 3; i++) {
        const stem = new THREE.Mesh(new THREE.CylinderGeometry(1, 1.4, 12, 5), stemMat);
        const angle = (i / 3) * Math.PI * 2;
        stem.position.set(Math.cos(angle) * 7, 6, Math.sin(angle) * 7);
        const bloom = new THREE.Mesh(new THREE.SphereGeometry(4, 8, 6), bloomMat);
        bloom.position.set(stem.position.x, 14, stem.position.z);
        bloom.castShadow = true;
        group.add(stem, bloom);
      }
    }

    const label = makeTextSprite(`${NODE_LABEL[n.kind] ?? n.kind} ${n.remaining}`, "#d9dee7");
    label.position.y = n.kind === "tree" ? 80 : 36;
    group.add(label);

    group.position.set(n.x, 0, n.y);
    group.userData.nodeId = id;
    group.traverse((o) => (o.userData.nodeId = id));
    this.scene.add(group);
    this.clickables.push(group);
    this.nodes.set(id, { group, state: n, label });
  }

  private refreshNode(id: string): void {
    const obj = this.nodes.get(id);
    if (!obj) return;
    const depleted = obj.state.remaining <= 0;
    obj.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        const mat = o.material as THREE.MeshLambertMaterial;
        mat.transparent = true;
        mat.opacity = depleted ? 0.25 : 1;
      }
    });
    updateSpriteText(obj.label, `${NODE_LABEL[obj.state.kind] ?? obj.state.kind} ${obj.state.remaining}`, "#d9dee7");
  }

  // ---- 입력 ----
  private bindInput(): void {
    const el = this.renderer.domElement;
    el.addEventListener("pointerdown", (ev) => {
      const ndc = new THREE.Vector2(
        (ev.clientX / window.innerWidth) * 2 - 1,
        -(ev.clientY / window.innerHeight) * 2 + 1,
      );
      this.raycaster.setFromCamera(ndc, this.camera);

      const nodeHit = this.raycaster.intersectObjects(this.clickables, true)[0];
      if (nodeHit) {
        const nodeId = nodeHit.object.userData.nodeId as string | undefined;
        const node = nodeId ? this.nodes.get(nodeId) : null;
        if (node && node.state.remaining > 0) {
          this.pendingGather = nodeId!;
          this.room.send("move_to", { x: node.state.x, y: node.state.y });
          this.tryGatherIfNear();
          return;
        }
      }
      const groundHit = this.raycaster.intersectObject(this.ground)[0];
      if (groundHit) {
        this.pendingGather = null;
        this.room.send("move_to", { x: groundHit.point.x, y: groundHit.point.z });
      }
    });
    el.addEventListener("wheel", (ev) => {
      this.zoom = Math.min(2.2, Math.max(0.5, this.zoom + (ev.deltaY > 0 ? 0.1 : -0.1)));
    });
  }

  private tryGatherIfNear(): void {
    if (!this.pendingGather) return;
    const me = this.players.get(this.welcome.playerId);
    const node = this.nodes.get(this.pendingGather);
    if (!me || !node) return;
    if (dist(me.sx, me.sy, node.state.x, node.state.y) <= GAME.GATHER_RANGE) {
      this.room.send("gather", { nodeId: this.pendingGather });
      this.pendingGather = null;
    }
  }

  // ---- 렌더 루프 ----
  private animate = (): void => {
    requestAnimationFrame(this.animate);

    for (const obj of this.players.values()) {
      obj.group.position.x += (obj.sx - obj.group.position.x) * 0.2;
      obj.group.position.z += (obj.sy - obj.group.position.z) * 0.2;
    }

    const me = this.players.get(this.welcome.playerId);
    if (me) {
      const target = me.group.position;
      const desired = new THREE.Vector3(target.x, 420 * this.zoom, target.z + 340 * this.zoom);
      this.camera.position.lerp(desired, 0.08);
      this.camera.lookAt(target.x, 20, target.z);
    }

    updateGatherBar();
    this.renderer.render(this.scene, this.camera);
  };
}

// ---- 텍스트 스프라이트 ----
function makeTextSprite(text: string, color: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  drawLabel(canvas, text, color);
  const texture = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false }));
  sprite.scale.set(64, 16, 1);
  return sprite;
}

function updateSpriteText(sprite: THREE.Sprite, text: string, color: string): void {
  const texture = sprite.material.map as THREE.CanvasTexture;
  drawLabel(texture.image as HTMLCanvasElement, text, color);
  texture.needsUpdate = true;
}

function drawLabel(canvas: HTMLCanvasElement, text: string, color: string): void {
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = "bold 26px 'Malgun Gothic', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(0,0,0,.8)";
  ctx.shadowBlur = 6;
  ctx.fillStyle = color;
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
}
