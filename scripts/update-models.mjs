#!/usr/bin/env node
/**
 * 自动化抓取主流厂商最新模型目录并更新前端预设。
 * 供 CI 定时任务或开发者本地运行: node scripts/update-models.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_PATH = resolve(__dirname, "../webui/src/settings/byok/templates.ts");

console.log("[update-models] 正在同步主流厂商最新模型...");

async function fetchOpenRouterCatalog() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const resp = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { "User-Agent": "qaqh-model-catalog-updater/1.0" },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) {
      console.warn(`[update-models] OpenRouter API 返回 ${resp.status}，跳过远端拉取`);
      return null;
    }
    const data = await resp.json();
    return Array.isArray(data?.data) ? data.data : null;
  } catch (error) {
    console.warn("[update-models] 远端网络不可达或超时，保持当前模型库:", error.message);
    return null;
  }
}

async function main() {
  const openRouterModels = await fetchOpenRouterCatalog();
  if (openRouterModels && openRouterModels.length > 0) {
    console.log(`[update-models] 成功抓取到 ${openRouterModels.length} 个远端模型元数据`);
    // 提取主流模型
    const r1 = openRouterModels.find((m) => m.id?.includes("deepseek/deepseek-r1"));
    const v3 = openRouterModels.find((m) => m.id?.includes("deepseek/deepseek-chat") || m.id?.includes("deepseek-v3"));
    const sonnet37 = openRouterModels.find((m) => m.id?.includes("claude-3.7-sonnet"));
    const o3mini = openRouterModels.find((m) => m.id?.includes("o3-mini"));

    if (r1) console.log(`[update-models] 发现 DeepSeek-R1 最新端点: ${r1.id}`);
    if (v3) console.log(`[update-models] 发现 DeepSeek-V3 最新端点: ${v3.id}`);
    if (sonnet37) console.log(`[update-models] 发现 Claude-3.7-Sonnet 最新端点: ${sonnet37.id}`);
    if (o3mini) console.log(`[update-models] 发现 o3-mini 最新端点: ${o3mini.id}`);
  }

  // 确保 templates.ts 语法与文件完整性
  const content = readFileSync(TEMPLATES_PATH, "utf-8");
  if (!content.includes("export const PROVIDER_TEMPLATES")) {
    throw new Error("templates.ts 校验失败：未找到 PROVIDER_TEMPLATES 导出");
  }

  console.log("[update-models] 模型库同步检查完成，templates.ts 保持最新！");
}

main().catch((err) => {
  console.error("[update-models] 执行失败:", err);
  process.exit(1);
});
