import { defineConfig } from "vite";
import solidPlugin from "@solidjs/vite-plugin";
import electron from "vite-plugin-electron/simple";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// dev 形态：renderer 同源访问 daemon（经 vite 代理），绕开 daemon 无 CORS/OPTIONS 的问题。
// 生产 file:// 加载同源，无需代理。
function discoveryEndpoint(): string {
  try {
    const dataDir = process.env.QAQH_DATA_DIR ?? path.join(os.homedir(), ".config", "qaqh");
    const d = JSON.parse(fs.readFileSync(path.join(dataDir, "daemon.json"), "utf8"));
    return d.endpoint;
  } catch {
    return "http://127.0.0.1:8712";
  }
}

export default defineConfig({
  base: "./",
  plugins: [
    solidPlugin(),
    electron({
      main: {
        entry: "electron/main/index.ts",
        vite: {
          build: {
            outDir: "out/main",
            lib: { entry: "electron/main/index.ts" },
          },
        },
      },
      preload: {
        input: path.resolve(__dirname, "electron/preload/index.ts"),
        vite: {
          build: { outDir: "out/preload" },
        },
      },
    }),
  ],
  build: {
    outDir: "out/renderer",
    emptyOutDir: true,
    target: "chrome140",
  },
  server: {
    port: 5183,
    strictPort: true,
    proxy: {
      // /qaqh-daemon/* → daemon（同源化，消除 CORS/preflight）
      "/qaqh-daemon": {
        target: discoveryEndpoint(),
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/qaqh-daemon/, ""),
      },
    },
  },
});
