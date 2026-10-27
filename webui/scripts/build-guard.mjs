#!/usr/bin/env node
/**
 * 构建新鲜度闸。`pre` 在 tauri build 之前跑,`post` 在之后跑。
 *
 * 为什么要它:NSIS 包名钉死在版本号上(`QAQ-Harness_<version>_x64-setup.exe`),
 * 而版本长期不 bump。于是 `just desktop-build` 里任何一步在打包前失败,旧安装包都会
 * 原地留着、文件名一模一样——「我明明编译了,装上还是旧 UI」在产物层面无法自证。
 *
 * pre  :删掉旧 bundle(没有产物就是没成功,别让上一次的成功冒充这次),并挡住
 *        「已安装实例还在跑」——exe 被锁着,NSIS 覆盖必败或静默跳过。
 * post :把壳二进制里嵌的前端入口 hash 与刚构建的 `out/renderer` 对撞,再确认安装包
 *        不比二进制旧。对不上就红,并说清该重跑哪一条。
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync, statSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDir = join(root, "target/release/bundle");
const shellBin = join(root, "target/release", process.platform === "win32" ? "qaqh-webui-app.exe" : "qaqh-webui-app");
/** 已安装实例:壳 + 它拉起的 daemon 子进程,两者都在安装目录里,都会锁文件。 */
const installedNames = process.platform === "win32"
  ? ["qaqh-webui-app.exe", "qaqh-daemon.exe"]
  : ["qaqh-webui-app", "qaqh-daemon"];

const fail = (message) => {
  console.error(`build-guard: ${message}`);
  process.exit(1);
};

function runningInstances() {
  if (process.platform === "win32") {
    return installedNames.filter((name) => {
      try {
        return execFileSync("tasklist", ["/FI", `IMAGENAME eq ${name}`, "/NH"], { encoding: "utf8" })
          .toLowerCase().includes(name);
      } catch { return false; }
    });
  }
  return installedNames.filter((name) => {
    try {
      execFileSync("pgrep", ["-x", name], { stdio: "ignore" });
      return true;
    } catch { return false; }
  });
}

/** vite 的入口资源名(内容 hash),这是「前端是哪一版」的最小可辨识指纹。 */
function rendererEntries() {
  const htmlPath = join(root, "out/renderer/index.html");
  if (!existsSync(htmlPath)) fail("缺 out/renderer/index.html——先跑 pnpm run build");
  const html = readFileSync(htmlPath, "utf8");
  const entries = [...html.matchAll(/(index-[A-Za-z0-9_-]{6,14}\.(?:js|css))/g)].map((m) => m[1]);
  if (entries.length === 0) fail("out/renderer/index.html 里找不到带 hash 的入口资源");
  return [...new Set(entries)];
}

function walkInstallers(dir) {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, item.name);
    // mac 的 .app 是目录产物(`--bundles app` 时没有 .dmg),按目录收,不下钻。
    if (item.isDirectory()) {
      if (item.name.endsWith(".app")) found.push(path);
      else found.push(...walkInstallers(path));
    } else if (/\.(exe|dmg)$/.test(item.name)) {
      found.push(path);
    }
  }
  return found;
}

const mode = process.argv[2];

if (mode === "pre") {
  const busy = runningInstances();
  if (busy.length > 0) {
    fail(`已安装的实例还在运行:${busy.join("、")}。窗口关了不代表进程退了(托盘 + single-instance),`
      + "NSIS 覆盖不了被锁的 exe。先从托盘退出(含 qaqh-daemon)再打包。");
  }
  const removed = walkInstallers(bundleDir);
  rmSync(bundleDir, { recursive: true, force: true });
  console.log(`build-guard pre: 清掉 ${removed.length} 个旧安装包(${bundleDir})`);
} else if (mode === "post") {
  if (!existsSync(shellBin)) fail(`没有 ${shellBin}——tauri build 根本没跑到编译`);
  const embedded = readFileSync(shellBin, "latin1");
  const expected = rendererEntries();
  const missing = expected.filter((entry) => !embedded.includes(entry));
  if (missing.length > 0) {
    fail(`壳二进制嵌的不是当前前端。out/renderer 现在是 ${expected.join("、")},`
      + `壳里缺 ${missing.join("、")}。多半是 tauri build 之前又改过渲染层:重跑 just desktop-build。`);
  }
  const cargoToml = readFileSync(join(root, "Cargo.toml"), "utf8");
  const cargoVersion = cargoToml.match(/^\[workspace\.package\][\s\S]*?^version = "([^"]+)"/m)?.[1] ?? null;
  const confVersion = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8")).version;
  if (cargoVersion != null && cargoVersion !== confVersion) {
    fail(`版本两处漂移:Cargo.toml=${cargoVersion} 而 tauri.conf.json=${confVersion}。`
      + "包名取后者,「关于」取前者,留着必骗人。");
  }
  if (cargoVersion != null && !embedded.includes(cargoVersion)) {
    fail(`壳二进制里没有版本字面量 ${cargoVersion}`);
  }
  const installers = walkInstallers(bundleDir);
  if (installers.length === 0) fail(`bundle 目录空:编译过了但打包步骤没产出(Cargo 报错?NSIS 被拦?)`);
  // 拿安装包和「壳二进制」的 mtime 比没意义(NSIS 写包与 tauri 回填 bundle 信息只差
  // 几十毫秒)。有意义的是:它得比当前这次前端构建新,否则就是上一次留下的旧包。
  const rendererAt = statSync(join(root, "out/renderer/index.html")).mtimeMs;
  const stale = installers.filter((path) => statSync(path).mtimeMs < rendererAt);
  if (stale.length > 0) {
    fail(`这些安装包早于当前前端构建,是残留:${stale.join("、")}。`
      + "正常路径下 `just build-pre` 会先清空 bundle——它没跑成功多半是被活实例断言拦下了。");
  }
  console.log(`build-guard post: 壳内嵌前端 = ${expected.join("、")};版本 ${confVersion}`);
  for (const path of installers) {
    const { size, mtime } = statSync(path);
    console.log(`  ${(size / 1048576).toFixed(2)} MiB  ${mtime.toISOString().replace("T", " ").slice(0, 19)}  ${path}`);
  }
} else {
  fail("用法: node scripts/build-guard.mjs pre|post");
}
