#!/usr/bin/env node
/**
 * 插件构建/watch（bun 是唯一构建器，dev 工具链不进打包产物）。
 *
 * 约定：plugins/<id>/src/entry.ts → plugins/<id>/dist/entry.js
 *   node scripts/plugins-watch.mjs          # watch 模式（开发热迭代）
 *   node scripts/plugins-watch.mjs --once   # 单次构建
 *
 * 产物改写即推进 main 的 stat-poll revision —— 本脚本不做任何热更信号，
 * 信号完全由宿主侧提供（对齐 dsh dev-web 的解耦结论）。
 */
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const once = process.argv.includes("--once");
const root = resolve("plugins");

const dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
const jobs = [];
for (const dir of dirs) {
  const src = resolve(root, dir, "src", "entry.ts");
  // theme 槽(纯 CSS 主题包)没有 JS 源码,直接跳过构建。
  if (!existsSync(src)) continue;
  const outdir = resolve(root, dir, "dist");
  const args = ["build", src, "--outdir", outdir, "--format", "esm", "--target", "browser"];
  if (!once) args.push("--watch");
  const child = spawn("bun", args, { stdio: "inherit" });
  jobs.push(child);
}

if (jobs.length === 0) {
  console.log("[plugins] 没有 plugins/*/src/entry.ts，无事可做");
  process.exit(0);
}
console.log(`[plugins] ${once ? "构建" : "watch"} ${jobs.length} 个插件: ${dirs.join(", ")}`);

const killAll = () => { for (const child of jobs) child.kill(); };
process.on("SIGINT", killAll);
process.on("SIGTERM", killAll);
for (const child of jobs) child.on("exit", (code) => { if (once) process.exitCode = code ?? 1; });
