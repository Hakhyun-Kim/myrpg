// 룸 상태 스키마 — Colyseus가 자동 동기화하는 공개 상태.
// world.ts가 진실이고 이 스키마는 그 투영이다. 개인 정보(인벤토리·토큰)는 여기 넣지 않는다 — 메시지로만.
//
// 필드는 반드시 `declare` + 생성자 할당으로 쓴다: defineTypes가 프로토타입에 심는 접근자를
// ES2022 class field(defineProperty)가 덮어쓰면 상태 동기화가 조용히 죽는다 (빌드 도구 설정 무관하게 안전한 형태).
import { MapSchema, Schema, defineTypes } from "@colyseus/schema";

export class PlayerSchema extends Schema {
  declare name: string;
  declare x: number;
  declare y: number;

  constructor(name = "", x = 0, y = 0) {
    super();
    this.name = name;
    this.x = x;
    this.y = y;
  }
}
defineTypes(PlayerSchema, { name: "string", x: "number", y: "number" });

export class NodeSchema extends Schema {
  declare kind: string;
  declare x: number;
  declare y: number;
  declare remaining: number;

  constructor(kind = "", x = 0, y = 0, remaining = 0) {
    super();
    this.kind = kind;
    this.x = x;
    this.y = y;
    this.remaining = remaining;
  }
}
defineTypes(NodeSchema, { kind: "string", x: "number", y: "number", remaining: "number" });

export class HaranState extends Schema {
  declare mapId: string;
  declare width: number;
  declare height: number;
  declare players: MapSchema<PlayerSchema>;
  declare nodes: MapSchema<NodeSchema>;

  constructor() {
    super();
    this.mapId = "";
    this.width = 0;
    this.height = 0;
    this.players = new MapSchema<PlayerSchema>();
    this.nodes = new MapSchema<NodeSchema>();
  }
}
defineTypes(HaranState, {
  mapId: "string",
  width: "number",
  height: "number",
  players: { map: PlayerSchema },
  nodes: { map: NodeSchema },
});
