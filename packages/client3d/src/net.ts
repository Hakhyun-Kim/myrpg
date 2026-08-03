// 서버 연결 — client(2D 테스트)와 동일한 규칙. 수칙: 주소 하드코딩 금지.
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
    room.send("hello");
  });
  return { room, welcome };
}
