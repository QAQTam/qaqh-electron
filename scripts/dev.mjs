import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

console.log("[dev] Compiling main & preload with esbuild...");
const bundleProc = spawn("node", ["scripts/bundle.mjs", "all"], {
  cwd: root,
  stdio: "inherit",
});

bundleProc.on("exit", (code) => {
  if (code !== 0) {
    console.error("[dev] Bundle failed, aborting.");
    process.exit(code || 1);
  }

  console.log("[dev] Launching Electron...");
  const electronPath = resolve(root, "node_modules/.bin/electron");
  const electronProc = spawn(electronPath, [root], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_ENV: "development",
    },
  });

  electronProc.on("exit", (elCode) => {
    process.exit(elCode || 0);
  });
});
