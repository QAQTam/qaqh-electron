/**
 * 首跑提升:系统 seed → 用户组件根。
 *
 * deb 的 postinst 以 root 运行,无法感知任何用户家目录,所以维护脚本只把出厂
 * 基线 unpack 到共享 seed(/var/lib/qaqh-harness,世界可读);这里在壳启动时以
 * 用户身份把 seed 提升到用户 overlay(~/.local/share/QAQ-Harness),给 updater
 * 的 plan/stage 提供 install-state 起点。
 *
 * 跳过条件(按序):dev 环境(app.isPackaged=false)/ QAQH_BASELINE_SEED=0 /
 * 用户域已有 install-state.json(提升过或更新过)。任何失败只记警告不阻塞——
 * 系统包里的 baseline 本身就能跑(bootstrap 双根兜底),提升失败只影响热更新链。
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { app } from "electron";
import { resolveEngineCli } from "./updater.js";

const execFileAsync = promisify(execFile);

export function userOverlayRoot(): string {
  return join(homedir(), ".local", "share", "QAQ-Harness");
}

export async function ensureBaselineSeeded(): Promise<void> {
  try {
    if (!app.isPackaged) return;
    if (process.env.QAQH_BASELINE_SEED === "0") return;
    const overlay = userOverlayRoot();
    if (existsSync(join(overlay, "install-state.json"))) return;
    const baselineDir = process.resourcesPath ? join(process.resourcesPath, "baseline") : "";
    if (baselineDir === "" || !existsSync(baselineDir)) return;
    const bundles = readdirSync(baselineDir).filter((name) => name.endsWith(".zip")).sort();
    if (bundles.length === 0) return;
    const maint = resolveEngineCli("qaqh-maint");
    for (const bundle of bundles) {
      await execFileAsync(maint, ["unpack", join(baselineDir, bundle), overlay], { timeout: 120_000 });
    }
    console.log(`[baseline] user overlay seeded from ${baselineDir} (${bundles.join(", ")})`);
  } catch (error) {
    console.warn("[baseline] seed promotion failed; continuing with system baseline:", error);
  }
}
