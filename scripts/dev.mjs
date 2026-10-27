import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rendererRoot = resolve(root, "../qaqh-desktop-app");
const children = new Set();
let shuttingDown = false;

function stop(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
    process.exit(code);
  }, 2500).unref();
  if (children.size === 0) process.exit(code);
}

function start(command, args, cwd, env = process.env, fatal = true) {
  const child = spawn(command, args, { cwd, env, stdio: "inherit" });
  children.add(child);
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (!shuttingDown && fatal && (code ?? 0) !== 0) {
      console.error(`[dev] ${command} exited (${signal ?? code}); stopping remaining processes`);
      stop(code || 1);
    }
    if (shuttingDown && children.size === 0) process.exit(0);
  });
  return child;
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

console.log("[dev] starting Solid renderer at http://127.0.0.1:5173");
let rendererPort = 5173;
for (let port = 5173; port < 5223; port += 1) {
  try { await fetch(`http://127.0.0.1:${port}/`); }
  catch { rendererPort = port; break; }
}
start("pnpm", ["exec", "vite", "--host", "127.0.0.1", "--port", String(rendererPort), "--strictPort"], rendererRoot, process.env, false);

let ready = false;
for (let attempt = 0; attempt < 120; attempt += 1) {
  try {
    const response = await fetch(`http://127.0.0.1:${rendererPort}/`);
    if (response.ok) { ready = true; break; }
  } catch {}
  await delay(250);
}
if (!ready) {
  stop(1);
  throw new Error(`Vite renderer did not become ready at http://127.0.0.1:${rendererPort}`);
}

const bundle = spawnSync(process.execPath, ["scripts/bundle.mjs", "all"], { cwd: root, stdio: "inherit" });
if (bundle.status !== 0) {
  stop(bundle.status || 1);
  throw new Error("Electron main/preload bundle failed");
}

console.log("[dev] launching Electron with the live renderer");
const electronPath = resolve(root, "node_modules/.bin/electron");
const electron = start(electronPath, [root], root, {
  ...process.env,
  NODE_ENV: "development",
  QAQH_DEV_URL: `http://127.0.0.1:${rendererPort}`,
  NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --max-old-space-size=256`.trim(),
});
electron.once("exit", (code) => stop(code || 0));
while (children.size > 0 && !shuttingDown) await delay(100);
