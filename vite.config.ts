import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// Vite 配置对齐 Tauri 开发模式：
// 1. 不遮挡 Rust 侧报错；2. 固定端口 1420，被占用就失败；3. 不监听 src-tauri 目录
export default defineConfig({
  plugins: [svelte()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
