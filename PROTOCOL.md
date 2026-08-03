# MyRPG 프로토콜 v0.2 (Colyseus 계약)

> **이 문서와 공식 JS SDK만으로 봇을 만들 수 있어야 한다.** 사람 클라이언트와 봇은 같은 룸에 같은 계약으로 들어온다 — 봇 전용 API는 없다.
> 이 문서와 서버 구현이 어긋나면 그것은 버그다. `packages/server/test/smoke.test.ts`가 이 문서의 계약 그대로 동작함을 검증한다.
>
> **v0.1 → v0.2**: 전송 계층이 순수 JSON/WS에서 **Colyseus 0.15**로 바뀌었다(결정 D7). 상태는 룸 스키마로 자동 동기화되고, 행동·이벤트는 룸 메시지로 오간다.
>
> 봇을 만드는 가장 쉬운 길 둘:
> 1. **MCP 도구** — Claude Code에서 이 프로젝트를 열면 `myrpg` MCP 서버(join/look/goto/gather/say)가 붙는다. 코드 없이 AI에게 "나무 캐줘"라고 말하면 된다.
> 2. **colyseus.js 직접** — 이 문서를 LLM에게 주고 "이 계약으로 봇을 짜줘"라고 하면 된다. 참고 구현: `packages/bot/src/bot.ts`

## 1. 연결과 입장

- 서버: `ws://HOST:PORT` (로컬 기본 `ws://localhost:7777`). 부가 HTTP: `GET /health`, `GET /config.json`
- SDK: `colyseus.js` ^0.15
- 룸 이름: **`haran`**

```js
import { Client } from "colyseus.js";
const room = await new Client("ws://localhost:7777").joinOrCreate("haran", {
  name: "mybot",          // 2~16자, [a-zA-Z0-9가-힣_-]
  token: "저장해둔 토큰",  // 재접속 시 필수 (최초 입장 시 생략)
});
```

입장 거부 (joinOrCreate가 reject):

| code | message 접두 | 뜻 |
|---|---|---|
| 400 | `bad_request:` | 이름 규칙 위반 |
| 401 | `auth_failed:` | 이름-토큰 불일치 |

같은 계정이 이미 접속 중이면 **기존 연결이 code 4001로 끊기고 새 연결이 승계**한다.

## 2. 핸드셰이크: hello → welcome

메시지 핸들러를 **모두 등록한 뒤** `hello`를 보내라. 서버가 `welcome`으로 답한다.
(등록 전에 도착한 메시지는 유실된다 — 그래서 클라이언트가 준비 시점을 정하는 요청-응답 구조다.)

```js
room.onMessage("welcome", (w) => { /* w.playerId, w.token, w.inventory, w.protocol */ });
room.onMessage("gather_result", ...); // §6의 나머지도 등록
room.send("hello");
```

- `welcome.playerId`: 상태 스키마 `players` 맵에서 **나의 키**
- `welcome.token`: **저장하라.** 같은 이름의 재입장에 필요하다

## 3. 상태 스키마 (자동 동기화)

`room.state`는 서버가 자동으로 밀어주는 공개 상태다. 틱(100ms)마다 변경분이 반영된다.

```
state.mapId    : string            // "haran"
state.width    : number            // 1280 (px)
state.height   : number            // 960 (px)
state.players  : Map<playerId, { name, x, y }>
state.nodes    : Map<nodeId,   { kind, x, y, remaining }>
```

- 좌표계: 픽셀, 좌상단 원점.
- `nodes.kind`: `tree`(→`wood`) · `rock`(→`copper_ore`) · `herb`(→`herb`). `remaining: 0`이면 고갈(리스폰 대기).
- 변화 감지: `state.players.onAdd/onRemove/onChange`, 각 인스턴스의 `.onChange(cb)` / `.listen("x", cb)` (colyseus.js 표준).
- **개인 정보(인벤토리·토큰)는 스키마에 없다** — 메시지로만 온다(§6).

## 4. C→S 메시지 (행동)

| type | 페이로드 | 설명 |
|---|---|---|
| `hello` | — | welcome 요청 (§2) |
| `move_to` | `{ x, y }` | 목표점 이동. 새 명령이 이전 목표를 덮어씀. 이동 속도 **160px/초**, 서버가 판정. 채집 중이면 취소됨 |
| `stop` | — | 정지 |
| `chat` | `{ text }` | 전체 채팅 (≤200자) |
| `gather` | `{ nodeId }` | 채집 시도 (§6) |
| `craft` | `{ recipeId, count }` | 제작 큐 등록 (§7). count 1~20 |
| `queue` | — | 제작 큐 상태 요청 → `queue_state` |
| `claim` | — | 완료품 전량 수령 → `claim_result` |
| `trade_request` | `{ playerId }` | 대면 거래 요청 (§8). 96px 이내 |
| `trade_respond` | `{ accept }` | 받은 요청에 응답 |
| `trade_offer` | `{ items }` | 내 제안 전체 교체 |
| `trade_accept` | — | 내 쪽 확정 |
| `trade_cancel` | — | 거래 취소 |

형식 위반 메시지는 조용히 무시된다 (서버는 판정만 한다 — 올바른 요청을 보내는 것은 클라이언트의 몫).

## 5. 제한

- 메시지 빈도: **초당 20개** — 초과 시 code **4002**로 연결이 끊긴다. 봇도 사람도 동일.
- 서버가 물리를 판정하므로 더 빨리 보내도 더 빨리 움직이지 않는다.

## 6. 채집

조건: 노드 중심에서 **48px 이내**, `remaining > 0`, 진행 중인 채집이 없을 것. 소요 **3000ms**.

**S→C 메시지 (핸들러를 미리 등록해 둘 것):**

| type | 페이로드 | 설명 |
|---|---|---|
| `gather_started` | `{ nodeId, endsAt }` | 시작됨. `endsAt`(Unix ms)까지 대기. 도중에 `move_to`하면 취소 |
| `gather_result` | `{ nodeId, item, count, inventory }` | 완료. `inventory`는 내 가방 전체 스냅샷 |
| `gather_failed` | `{ nodeId, reason }` | `too_far` \| `depleted` \| `busy` \| `moved` \| `not_found` |
| `chat` | `{ from, name, text, t }` | 전체 채팅 방송 (본인 포함) |
| `welcome` | `{ protocol, playerId, token, inventory }` | §2 |

- 노드는 고갈 후 **30초** 뒤 5로 리스폰 (스키마 `remaining` 변화로 관측).

## 7. 제작 큐 (가공)

원료 → 중간재 가공. **오프라인에도 진행된다** — 서버가 타임스탬프로 정산하므로 로그아웃·재접속과 무관하다.

**T1 레시피** (`recipeId`):

| recipeId | 산출 | 원료 | 소요 |
|---|---|---|---|
| `plank` | 판재 ×1 | 원목(wood) ×2 | 30초 |
| `copper_ingot` | 구리 주괴 ×1 | 구리 광석(copper_ore) ×2 | 30초 |
| `herb_extract` | 약초 추출액 ×1 | 생약초(herb) ×2 | 30초 |

규칙:
- 슬롯 **3개** — 동시에 3개 작업까지, 슬롯끼리는 병렬 진행. 작업 1건 = 레시피 × 수량(1~20), 수량은 슬롯 안에서 순차 생산
- 원료는 **등록 즉시 차감** (취소 불가). 완성품은 **보관함(ready)** 에 쌓이고 `claim`으로 수령해야 가방에 들어간다
- `welcome.queue`에 입장 시점의 큐 상태가 들어 있다

**S→C 메시지:**

| type | 페이로드 | 설명 |
|---|---|---|
| `queue_state` | `{ jobs: [{id, recipeId, total, done, nextDoneAt}], ready, slots }` | craft/claim 후, 그리고 접속 중 완성 시 서버가 밀어줌 |
| `craft_failed` | `{ recipeId, reason }` | `unknown_recipe` \| `no_materials` \| `slots_full` \| `bad_count` |
| `claim_result` | `{ claimed, inventory }` | 수령 내역 + 가방 스냅샷 |
| `inventory` | `{ inventory }` | 원료 차감 등 가방 변동 스냅샷 |

## 8. 대면 거래

1:1, 양측 확정, 원자적 교환. 흐름:

```
A: trade_request {playerId:B}   (A·B 거리 ≤ 96px, 요청 유효 30초)
B ← trade_requested {from, name}
B: trade_respond {accept:true}
양쪽 ← trade_open {partner} → trade_update
양쪽: trade_offer {items} 자유롭게 변경   ※ 제안이 바뀌면 양측 확정이 풀린다
양쪽: trade_accept → 둘 다 확정되는 순간 서버가 재고·거리를 재검증 후 원자적으로 교환
양쪽 ← trade_done {gave, received, inventory}
```

**S→C 메시지:**

| type | 페이로드 | 설명 |
|---|---|---|
| `trade_requested` | `{ from, name }` | 요청 수신 |
| `trade_open` | `{ partner: {id, name} }` | 거래 시작 |
| `trade_update` | `{ myOffer, partnerOffer, myAccept, partnerAccept }` | 제안·확정 변화마다 (수신자 기준으로 개인화) |
| `trade_done` | `{ gave, received, inventory }` | 교환 완료 |
| `trade_closed` | `{ reason }` | `declined` \| `cancelled` \| `too_far` \| `partner_left` \| `invalid_offer` \| `expired` |
| `trade_failed` | `{ reason }` | 요청/제안 거부: `self` \| `busy` \| `not_found` \| `too_far` \| `invalid_offer` |

안전 규칙: 보유하지 않은 물건은 제안 불가 · 교환 직전 재고를 다시 검증(거래 중 소모 대비) · 거래 중 144px 초과로 멀어지면 자동 취소 · 이탈 시 자동 취소.

## 9. 봇 작성자를 위한 최소 절차

```
1. joinOrCreate("haran", { name }) → 핸들러 등록 → send("hello") → welcome 수신, token 저장
2. state.nodes에서 remaining > 0인 노드 선택
3. send("move_to", { x: 노드x, y: 노드y })
4. state.players.get(내 playerId) 좌표를 관찰, 노드와 거리 ≤ 48이 되면
5. send("gather", { nodeId })
6. gather_result 수신 → 성공. 반복하거나 다른 노드로.
```

버전: 계약이 바뀌면 `welcome.protocol`이 올라가고 이 문서가 갱신된다. 하위호환이 깨지는 변경은 메이저 버전에서만.
