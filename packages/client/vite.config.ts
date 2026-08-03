import { defineConfig } from "vite";

// 2D 테스트 클라이언트 — 프로덕션에서는 /test 경로에 서빙된다 (고비주얼 3D가 루트)
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/test/" : "/",
  server: { port: 5173 },
  build: { chunkSizeWarningLimit: 1600 }, // phaser 단일 청크
}));
