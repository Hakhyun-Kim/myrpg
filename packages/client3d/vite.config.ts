import { defineConfig } from "vite";

export default defineConfig({
  server: { port: 5174 },
  build: { chunkSizeWarningLimit: 1200 }, // three 단일 청크
});
