/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import solid from "@solidjs/vite-plugin";
import Icons from "unplugin-icons/vite";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

// 资源受限/只读环境兜底：确保有可写的临时目录供 Vite/Vitest 缓存
const localTmp = resolve(import.meta.dirname ?? process.cwd(), ".tmp");
if (!existsSync(localTmp)) {
  try {
    mkdirSync(localTmp, { recursive: true });
  } catch {}
}
if (!process.env.TMPDIR || process.env.TMPDIR === "/tmp") {
  process.env.TMPDIR = localTmp;
}

// C3 起,本仓的唯一构建产物是 Tauri 壳的 renderer 资源
// (`out/renderer`,由 `tauri.conf.json > build.frontendDist` 消费)。
// CSP 由 `tauri.conf.json > app.security.csp` 一处接管,构建期不再注入,
// 也不存在浏览器直连的 gateway 代理。

export default defineConfig({
  plugins: [solid(), Icons({ compiler: "solid" })],
  base: "/",
  server: {
    port: 5173,
    proxy: {
      "/__qaqh_preview": {
        target: "http://127.0.0.1:5174",
        changeOrigin: false,
      },
    },
  },
  build: {
    target: "esnext",
    outDir: "out/renderer",
    emptyOutDir: true,
  },
  // 单测是纯逻辑(不碰 DOM),显式指定 node 环境——否则 vitest 5 会去找
  // jsdom/happy-dom 并因缺失而拒绝启动 worker。
  // 在双核弱硬件下限制并发 worker 数量为 2，避免瞬间派生数十个进程打爆 CPU 与内存。
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    maxWorkers: 2,
  },
});
