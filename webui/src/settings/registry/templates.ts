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
