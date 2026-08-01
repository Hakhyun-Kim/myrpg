# MyRPG

경제·생활 중심 웹 MMORPG. 기획은 [docs/GDD.md](docs/GDD.md), 통신 규약은 [PROTOCOL.md](PROTOCOL.md).

**봇도 시민이다** — 사람 클라이언트와 봇은 같은 Colyseus 룸에 같은 계약으로 접속한다. 봇 전용 API는 없다.
PROTOCOL.md와 공식 SDK(colyseus.js)만으로 봇을 만들 수 있으며, 그게 안 되면 버그다 (스모크 테스트가 검증).

## 빠른 시작

```bash
npm install
npm run dev        # 서버(7777) + 클라이언트(5173) 동시 기동
```

브라우저에서 http://localhost:5173 → 이름 입력 → 클릭 이동, 노드 클릭 채집, Enter 채팅.

봇 접속 (다른 터미널에서):
```bash
npm run bot -- --name woodbot --loop
```

## AI로 플레이하기 (MCP)

이 저장소의 [.mcp.json](.mcp.json)이 `myrpg` MCP 서버를 등록한다 — Claude Code에서 이 프로젝트를 열면
AI가 `join / look / goto / gather / say` 도구로 직접 게임에 입장해 플레이할 수 있다.
"woodbot이라는 이름으로 들어가서 나무 10개 캐줘"라고 말하면 된다.

MCP 서버는 전용 API가 아니다 — 내부적으로 PROTOCOL.md의 룸 계약으로 접속하는
또 하나의 클라이언트일 뿐이며(P6), 서버 판정이므로 사람보다 빠를 수 없다.

테스트 / 타입체크:
```bash
npm test
npm run typecheck
```

프로덕션 (단일 프로세스 — 서버가 클라이언트 정적 파일도 서빙):
```bash
npm run build
npm start          # http://localhost:7777
```

## 구조

```
PROTOCOL.md          통신 규약 — 이 프로젝트의 헌법
packages/
  protocol/          공유 타입·상수 (서버·클라 공용)
  server/            권위 서버: 월드 시뮬(world.ts) + Colyseus 룸(room.ts) + 스토리지 어댑터
  client/            Vite + Phaser 클라이언트
  bot/               레퍼런스 봇 — colyseus.js로 PROTOCOL.md 계약만 보고 작성
  mcp/               MCP 서버 — AI 에이전트를 게임 플레이어로 (join/look/goto/gather/say)
```

## 개발 수칙 (이식성)

1. **모든 설정은 env로, 기본값은 로컬용.** 아무것도 설정하지 않아도 `npm run dev` 하나로 돈다. [.env.example](.env.example) 참고.
2. **주소 하드코딩 금지.** 클라이언트는 `VITE_SERVER_URL` → dev 기본값 → 접속 host 순으로 서버를 찾는다.
3. **영속화는 Storage 인터페이스 뒤에만** ([storage.ts](packages/server/src/storage.ts)). 지금은 JSON 파일, 클라우드 이전 시 Postgres 어댑터로 교체.
4. **게임 로직(world.ts)은 네트워크를 모른다.** 시뮬과 전송이 분리되어 있어야 스케일아웃 때 살아남는다.
5. **프로덕션 = 단일 프로세스.** 서버 하나가 정적 파일까지 서빙 → Docker 한 장, VM 한 대, 어디로든 옮긴다.
6. **시간·판정은 전부 서버 권위.** 클라이언트와 봇은 표시와 요청만 한다.

## 개발일지

공개 일지: https://github.com/Hakhyun-Kim/myrpg-devlog
