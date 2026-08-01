// 서버 연결 — 수칙: 주소 하드코딩 금지.
// 우선순위: VITE_SERVER_URL(빌드 시 주입) > dev는 localhost:7777 > prod는 접속한 host 그대로.
import type { ClientMsg, ServerMsg } from "@myrpg/protocol";

export function serverUrl(): string {
  const fromEnv = import.meta.env.VITE_SERVER_URL as string | undefined;
  if (fromEnv) return fromEnv;
  if (import.meta.env.DEV) return "ws://localhost:7777/ws";
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

type Handler = (msg: ServerMsg) => void;

export class Connection {
  private ws: WebSocket;
  private handlers = new Map<string, Handler[]>();
  private anyHandlers: Handler[] = [];
  onClose: (() => void) | null = null;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string) as ServerMsg;
      for (const h of this.handlers.get(msg.type) ?? []) h(msg);
      for (const h of this.anyHandlers) h(msg);
    };
    ws.onclose = () => this.onClose?.();
  }

  static connect(url: string): Promise<Connection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => resolve(new Connection(ws));
      ws.onerror = () => reject(new Error(`서버에 연결할 수 없습니다: ${url}`));
    });
  }

  on<T extends ServerMsg["type"]>(type: T, handler: (msg: Extract<ServerMsg, { type: T }>) => void): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler as Handler);
    this.handlers.set(type, list);
  }

  send(msg: ClientMsg): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}
