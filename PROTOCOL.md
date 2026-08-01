# MyRPG 프로토콜 v0.1

> **이 문서만 읽고 봇(클라이언트)을 만들 수 있어야 한다.** 그게 이 게임의 규칙이다 — 사람 클라이언트와 봇은 같은 문으로 들어온다. 봇 전용 API는 없다.
> 이 문서와 서버 구현이 어긋나면 그것은 버그다. `packages/server/test/smoke.test.ts`가 이 문서의 예제 그대로 동작함을 검증한다.
>
> LLM에게 봇을 짜게 하려면: 이 파일 전체를 붙여넣고 "이 프로토콜로 접속해서 나무를 캐는 봇을 만들어줘"라고 하면 된다.

## 1. 연결

- 전송: **WebSocket**, 텍스트 프레임, **UTF-8 JSON**. 프레임 1개 = 메시지 1개 (배칭 없음).
- 엔드포인트: `ws://HOST:PORT/ws` (로컬 기본 `ws://localhost:7777/ws`)
- 연결 후 **10초 안에 `login`을 보내지 않으면** 서버가 연결을 끊는다.
- 부가 HTTP: `GET /health` → `{"ok":true}`, `GET /config.json` → `{"wsPath":"/ws"}`

## 2. 메시지 봉투

모든 메시지는 `type` 필드를 가진 JSON 오브젝트다.

```json
{ "type": "move_to", "x": 400, "y": 300 }
```

모르는 `type`을 받으면 무시하라 (서버는 확장될 수 있다). 서버는 클라이언트의 모르는 `type`에 `error(unknown_type)`로 답한다.

## 3. 제한

| 항목 | 값 | 초과 시 |
|---|---|---|
| 메시지 빈도 | 초당 20개 | `error(rate_limited)` 후 연결 종료 (code 1008) |
| 프레임 크기 | 4096 바이트 | 연결 종료 (1009) |
| 채팅 길이 | 200자 | `error(bad_request)` |

봇도 사람도 같은 제한이다. 서버가 물리를 판정하므로 더 빨리 보내도 더 빨리 움직이지 않는다.

## 4. 로그인

**C→S**
```json
{ "type": "login", "name": "torin", "token": "선택 — 재접속 시 필수" }
```
- `name`: 2~16자, `[a-zA-Z0-9가-힣_-]`
- 최초 로그인 시 서버가 계정을 만들고 `token`을 발급한다. **저장하라.** 같은 이름으로 다시 접속하려면 token이 맞아야 한다 (`error(auth_failed)`).
- 같은 계정이 이미 접속 중이면 기존 연결이 끊기고 새 연결이 승계한다.

**S→C 성공**
```json
{
  "type": "welcome",
  "protocol": "0.1",
  "playerId": "p_ab12cd",
  "token": "9f3a…",
  "you": { "id": "p_ab12cd", "name": "torin", "x": 640, "y": 480 },
  "map": { "id": "haran", "width": 1280, "height": 960 },
  "players": [ { "id": "p_ff00aa", "name": "mira", "x": 500, "y": 210 } ],
  "nodes": [ { "id": "n_tree_1", "kind": "tree", "x": 200, "y": 200, "remaining": 5 } ],
  "inventory": { "wood": 3 }
}
```
- `players`는 **나를 제외한** 현재 접속자.
- `nodes.kind`: `tree`(→ `wood`) · `rock`(→ `copper_ore`) · `herb`(→ `herb`). `remaining: 0`이면 고갈 상태(리스폰 대기).

**S→C 실패**: `{ "type": "error", "code": "...", "message": "..." }` — code는 §9.

## 5. 이동

- 좌표계: 픽셀, **좌상단 원점**, x→오른쪽, y→아래.
- 이동 속도: **160 px/초**. 서버가 매 틱(100ms) 목표점을 향해 직선 이동시킨다. 맵 경계 밖은 자동 클램프.

**C→S** `{ "type": "move_to", "x": 400, "y": 300 }` — 새 `move_to`는 이전 목표를 덮어쓴다.
**C→S** `{ "type": "stop" }`

**S→C (100ms마다, 위치가 변한 플레이어만 담김. 아무도 안 움직이면 생략)**
```json
{ "type": "state", "t": 1730000000000, "players": [ { "id": "p_ab12cd", "x": 412.3, "y": 305.1 } ] }
```
- `t`: 서버 시각 (Unix ms). 봇은 자기 `id`의 좌표를 여기서 추적하면 된다.

**S→C 입퇴장**: `{ "type": "player_joined", "player": {...} }` / `{ "type": "player_left", "id": "p_..." }`

## 6. 채팅

**C→S** `{ "type": "chat", "text": "주괴 삽니다" }`
**S→C (본인 포함 전체 방송)** `{ "type": "chat", "from": "p_ab12cd", "name": "torin", "text": "주괴 삽니다", "t": 1730000000000 }`

## 7. 채집

**C→S** `{ "type": "gather", "nodeId": "n_tree_1" }`

조건: 노드 중심에서 **48px 이내**, `remaining > 0`, 진행 중인 다른 채집이 없을 것.

**S→C 시작** `{ "type": "gather_started", "nodeId": "n_tree_1", "endsAt": 1730000003000 }` — 채집은 **3000ms** 걸린다. `endsAt`까지 기다려라. 도중에 움직이면(`move_to`) 취소된다.

**S→C 완료**
```json
{ "type": "gather_result", "nodeId": "n_tree_1", "item": "wood", "count": 1, "inventory": { "wood": 4 } }
```
**S→C 실패** `{ "type": "gather_failed", "nodeId": "n_tree_1", "reason": "too_far | depleted | busy | moved | not_found" }`

**S→C 노드 변화 (방송)** `{ "type": "node_update", "node": { "id": "n_tree_1", "kind": "tree", "x": 200, "y": 200, "remaining": 4 } }`
- 노드는 `remaining`이 0이 되면 **30초** 뒤 5로 리스폰된다 (그때도 `node_update`가 온다).

## 8. 핑

**C→S** `{ "type": "ping", "t": 123 }` → **S→C** `{ "type": "pong", "t": 123 }` (`t`는 그대로 반사)

## 9. 오류 코드

| code | 뜻 |
|---|---|
| `bad_request` | 형식 위반 (필드 누락·타입 오류·길이 초과) |
| `unknown_type` | 모르는 메시지 type |
| `auth_failed` | 이름-토큰 불일치 |
| `not_logged_in` | login 전에 다른 메시지를 보냄 |
| `rate_limited` | §3 위반 (연결이 곧 닫힌다) |

## 10. 봇 작성자를 위한 최소 절차

```
1. ws://localhost:7777/ws 접속
2. {"type":"login","name":"mybot"} 전송 → welcome 수신, token 저장
3. welcome.nodes에서 목표 노드 선택 (remaining > 0)
4. {"type":"move_to","x":노드x,"y":노드y} 전송
5. state 메시지에서 내 좌표 추적, 노드와 거리 ≤ 48 되면
6. {"type":"gather","nodeId":"..."} 전송
7. gather_result 수신 → 성공. 반복하거나 다른 노드로.
```

버전: 프로토콜이 바뀌면 `welcome.protocol`이 올라가고 이 문서가 갱신된다. 하위호환이 깨지는 변경은 메이저 버전에서만.
