import type { Room } from "colyseus.js";
import { GAME } from "@myrpg/protocol";
import { joinGame } from "./net.js";
import { World3D } from "./scene3d.js";
import { pushChat } from "./hud.js";

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
    const token = localStorage.getItem(`myrpg.token.${name}`) ?? undefined;
    const { room, welcome } = await joinGame(name, token);

    localStorage.setItem("myrpg.lastName", name);
    localStorage.setItem(`myrpg.token.${name}`, welcome.token);
    document.getElementById("login")!.style.display = "none";
    document.getElementById("hud")!.style.display = "block";

    new World3D(document.getElementById("app")!, room, welcome);
    wireChat(room);

    room.onLeave((code) => {
      pushChat(code === 4001 ? "다른 곳에서 접속해 연결이 종료됐습니다." : "서버 연결이 끊어졌습니다. 새로고침하세요.", true);
    });
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    errEl.textContent = msg.includes("auth_failed")
      ? "이 이름은 다른 토큰으로 등록되어 있습니다. 다른 이름을 쓰세요."
      : `오류: ${msg}`;
  }
}

function wireChat(room: Room): void {
  const input = document.getElementById("chat-input") as HTMLInputElement;
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      const text = input.value.trim();
      if (text.length > 0) room.send("chat", { text });
      input.value = "";
      input.blur();
    }
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && document.activeElement !== input) input.focus();
  });
}
