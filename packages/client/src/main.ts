import Phaser from "phaser";
import { GAME } from "@myrpg/protocol";
import { Connection, serverUrl } from "./net.js";
import { GameScene, pushChat } from "./GameScene.js";

const form = document.getElementById("login-form") as HTMLFormElement;
const nameInput = document.getElementById("name") as HTMLInputElement;
const errEl = document.getElementById("login-err")!;

nameInput.value = localStorage.getItem("myrpg.lastName") ?? "";

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  if (!GAME.NAME_RE.test(name)) {
    errEl.textContent = "이름은 2~16자, 한글/영문/숫자/_/-";
    return;
  }
  errEl.textContent = "접속 중…";
  void enter(name);
});

async function enter(name: string): Promise<void> {
  try {
    const conn = await Connection.connect(serverUrl());
    conn.on("error", (msg) => {
      if (msg.code === "auth_failed") {
        errEl.textContent = "이 이름은 다른 토큰으로 등록되어 있습니다. 다른 이름을 쓰세요.";
      } else {
        errEl.textContent = `오류: ${msg.message}`;
      }
    });
    conn.on("welcome", (welcome) => {
      localStorage.setItem("myrpg.lastName", name);
      localStorage.setItem(`myrpg.token.${name}`, welcome.token);
      document.getElementById("login")!.style.display = "none";
      document.getElementById("hud")!.style.display = "block";

      const game = new Phaser.Game({
        type: Phaser.AUTO,
        parent: "app",
        backgroundColor: "#1a1a24",
        scale: { mode: Phaser.Scale.RESIZE, width: window.innerWidth, height: window.innerHeight },
        scene: [],
      });
      game.scene.add("game", GameScene, true, { conn, welcome });
      wireChat(conn);

      conn.onClose = () => {
        pushChat("서버 연결이 끊어졌습니다. 새로고침하세요.", true);
      };
    });
    const token = localStorage.getItem(`myrpg.token.${name}`) ?? undefined;
    conn.send({ type: "login", name, token });
  } catch (err) {
    errEl.textContent = (err as Error).message;
  }
}

function wireChat(conn: Connection): void {
  const input = document.getElementById("chat-input") as HTMLInputElement;
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      const text = input.value.trim();
      if (text.length > 0) conn.send({ type: "chat", text });
      input.value = "";
      input.blur();
    }
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && document.activeElement !== input) input.focus();
  });
}
