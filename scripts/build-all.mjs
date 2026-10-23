import { execSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, cpSync, chmodSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const electronRoot = resolve(__dirname, "..");
const backendRoot = resolve(electronRoot, "../qaqh-backend");
const desktopAppRoot = resolve(electronRoot, "../qaqh-desktop-app");

console.log("====================================================");
console.log("   QAQ-Harness Electron Linux Full Pipeline Build   ");
console.log("====================================================");

// 1. 构建后端 qaqh-backend (qaqh-daemon release)
console.log("\n[1/4] Building qaqh-backend daemon (release)...");
try {
  execSync("cargo build --release -p qaqh-daemon", {
    cwd: backendRoot,
    stdio: "inherit",
    env: process.env,
  });
} catch (err) {
  console.error("Failed to build qaqh-backend:", err);
  process.exit(1);
}

// 拷贝二进制到 resources/bin
const binDir = join(electronRoot, "resources", "bin");
mkdirSync(binDir, { recursive: true });

const daemonSrc = join(backendRoot, "target", "release", "qaqh-daemon");
const daemonDest = join(binDir, "qaqh-daemon");

if (!existsSync(daemonSrc)) {
  console.error(`Target daemon binary not found at ${daemonSrc}`);
  process.exit(1);
}

console.log(`Copying daemon binary to ${daemonDest}...`);
cpSync(daemonSrc, daemonDest);
chmodSync(daemonDest, 0o755);

// 2. 构建前端 qaqh-desktop-app (Vite + SolidJS)
console.log("\n[2/4] Building qaqh-desktop-app renderer...");
try {
  execSync("pnpm run build", {
    cwd: desktopAppRoot,
    stdio: "inherit",
    env: process.env,
  });
} catch (err) {
  console.error("Failed to build qaqh-desktop-app:", err);
  process.exit(1);
}

const rendererSrc = join(desktopAppRoot, "out", "renderer");
const rendererDest = join(electronRoot, "renderer");
if (!existsSync(rendererSrc)) {
  console.error(`Renderer dist not found at ${rendererSrc}`);
  process.exit(1);
}

console.log(`Syncing renderer files to ${rendererDest}...`);
mkdirSync(rendererDest, { recursive: true });
cpSync(rendererSrc, rendererDest, { recursive: true });

// 3. 构建 Electron 主进程与 Preload 脚本
console.log("\n[3/4] Bundling Electron main and preload scripts...");
try {
  execSync("node scripts/bundle.mjs all", {
    cwd: electronRoot,
    stdio: "inherit",
  });
} catch (err) {
  console.error("Failed to bundle Electron scripts:", err);
  process.exit(1);
}

// 4. 调用 electron-builder 生成 Linux 安装包
console.log("\n[4/4] Packaging with electron-builder for Linux...");
const targetArg = process.argv[2] ? ` ${process.argv[2]}` : " --linux";
try {
  execSync(`pnpm exec electron-builder${targetArg}`, {
    cwd: electronRoot,
    stdio: "inherit",
  });
} catch (err) {
  console.error("electron-builder packaging failed:", err);
  process.exit(1);
}

console.log("\n====================================================");
console.log("   Full build completed! Output in release/        ");
console.log("====================================================");
