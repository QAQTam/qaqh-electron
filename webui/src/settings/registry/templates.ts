/**
 * 「设置 → 服务商」模板芯片的数据源。
 *
 * 后端 `provider.presets.list`（qaqh-profile PROVIDER_PRESETS 静态表）是
 * 端点事实（id/name/baseUrl/wire/credential）的**唯一真源**；本文件的静态
 * 表退居两个角色：
 * 1. UX 字段供给——badge/keyHint/keyRequired 这些界面体验后端不建模，按 id
 *    富化进 preset；
 * 2. 降级与补集——后端未覆盖的厂商（硅基流动等聚合/本地端点）保留在这里，
 *    后端命令不可用（版本错位）时整个静态表兜底，表单永远可用。
 */
export interface ProviderTemplate {
  id: string;
  name: string;
  badge: string;
  baseUrl: string;
  wire: string;
  keyHint: string;
  keyRequired: boolean;
}

export const PROVIDER_TEMPLATES: ProviderTemplate[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    badge: "官方端点",
    baseUrl: "https://api.deepseek.com",
    wire: "chat",
    keyHint: "sk-...",
    keyRequired: true,
  },
  {
    id: "anthropic",
    name: "Anthropic",
    badge: "Claude 官方",
    baseUrl: "https://api.anthropic.com",
    wire: "messages",
    keyHint: "sk-ant-...",
    keyRequired: true,
  },
  {
    id: "openai",
    name: "OpenAI",
    badge: "官方端点",
    baseUrl: "https://api.openai.com/v1",
    wire: "chat",
    keyHint: "sk-proj-...",
    keyRequired: true,
  },
  {
    id: "gemini",
    name: "Google Gemini",
    badge: "官方端点",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    wire: "gemini",
    keyHint: "AIzaSy...",
    keyRequired: true,
  },
  {
    id: "qianwen",
    name: "千问 AI 平台",
    badge: "Anthropic 兼容面",
    baseUrl: "https://maas.qianwenaiapi.com/apps/anthropic",
    wire: "messages",
    keyHint: "sk-...",
    keyRequired: true,
  },
  {
    id: "qwen-token-plan-cn",
    name: "Qwen (Token-Plan CN)",
    badge: "Token Plan 包月专线",
    baseUrl: "https://token-plan.maas.qianwenaiapi.com/apps/anthropic",
    wire: "messages",
    keyHint: "sk-...",
    keyRequired: true,
  },
  {
    id: "siliconflow",
    name: "SiliconFlow (硅基流动)",
    badge: "云聚合端点",
    baseUrl: "https://api.siliconflow.cn/v1",
    wire: "chat",
    keyHint: "sk-...",
    keyRequired: true,
  },
  {
    id: "moonshot",
    name: "Moonshot (Kimi)",
    badge: "月之暗面",
    baseUrl: "https://api.moonshot.cn/v1",
    wire: "chat",
    keyHint: "sk-...",
    keyRequired: true,
  },
  {
    id: "zhipu",
    name: "Zhipu AI (智谱清言)",
    badge: "开放平台",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    wire: "chat",
    keyHint: "key.secret",
    keyRequired: true,
  },
  {
    id: "ollama",
    name: "Ollama (本地运行)",
    badge: "本地免密",
    baseUrl: "http://localhost:11434/v1",
    wire: "chat",
    keyHint: "本地模型无需填写密钥",
    keyRequired: false,
  },
  {
    id: "custom",
    name: "自定义 / 其他",
    badge: "通用兼容",
    baseUrl: "",
    wire: "chat",
    keyHint: "API Key",
    keyRequired: false,
  },
];

/** `provider.presets.list` 快照形状（后端 ProviderPreset，serde camelCase）。 */
export interface ProviderPresetWire {
  id: string;
  name: string;
  baseUrl: string;
  wire: string;
  credential: string;
}

/**
 * 以后端 presets 为序合并：端点事实取后端值，UX 字段按 id 从静态表富化，
 * 缺省给 api_key 通用体验（新预设第一次出现时静态表可能还没有它的行）。
 * 非 api_key 凭据类型（oauth 套餐 / chatgpt_plan）不进 BYOK 表单——创建流
 * 只能写 api_key 槽（byok.ts 的 credential 固定值），让它们出现在芯片里
 * 只会制造一个必然建坏的入口。
 * 后端未覆盖的静态条目保序追加；custom 永远垫底。
 */
export function mergeProviderPresets(presets: readonly ProviderPresetWire[]): ProviderTemplate[] {
  const fallback = new Map(PROVIDER_TEMPLATES.map((item) => [item.id, item]));
  const merged: ProviderTemplate[] = [];
  for (const preset of presets) {
    if (preset.credential !== "api_key") continue;
    const ux = fallback.get(preset.id);
    merged.push({
      id: preset.id,
      name: preset.name,
      baseUrl: preset.baseUrl,
      wire: preset.wire,
      badge: ux?.badge ?? "预设",
      keyHint: ux?.keyHint ?? "sk-...",
      keyRequired: ux?.keyRequired ?? true,
    });
    fallback.delete(preset.id);
  }
  const extras = [...fallback.values()];
  merged.push(
    ...extras.filter((item) => item.id !== "custom"),
    ...extras.filter((item) => item.id === "custom"),
  );
  return merged;
}
