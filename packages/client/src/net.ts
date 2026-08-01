// 서버 연결 — 수칙: 주소 하드코딩 금지.
// 우선순위: VITE_SERVER_URL(빌드 시 주입) > dev는 localhost:7777 > prod는 접속한 host 그대로.
import { Client, type Room } from "colyseus.js";
import { ROOM_NAME, type WelcomeMsg } from "@myrpg/protocol";

export function serverUrl(): string {
  const fromEnv = import.meta.env.VITE_SERVER_URL as string | undefined;
  if (fromEnv) return fromEnv;
  if (import.meta.env.DEV) return "ws://localhost:7777";
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}`;
}

export interface JoinResult {
  room: Room;
  welcome: WelcomeMsg;
}

export async function joinGame(name: string, token?: string): Promise<JoinResult> {
  const client = new Client(serverUrl());
  const room = await client.joinOrCreate(ROOM_NAME, { name, ...(token ? { token } : {}) });
  const welcome = await new Promise<WelcomeMsg>((resolve) => {
    room.onMessage("welcome", resolve);
    room.send("hello"); // 핸들러 등록 후 요청 — 수신 누락 없는 핸드셰이크 (PROTOCOL.md)
  });
  return { room, welcome };
}
