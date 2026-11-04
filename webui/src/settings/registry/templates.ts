export interface ModelOption {
  id: string;
  label: string;
  desc?: string;
  defaultEffort?: string;
}

export interface ProviderTemplate {
  id: string;
  name: string;
  badge: string;
  baseUrl: string;
  wire: string;
  keyHint: string;
  keyRequired: boolean;
  models: ModelOption[];
  modelPlaceholder?: string;
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
    modelPlaceholder: "输入模型代号（如 deepseek-flash / deepseek-v4-pro）",
    models: [],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    badge: "Claude 官方",
    baseUrl: "https://api.anthropic.com",
    wire: "messages",
    keyHint: "sk-ant-...",
    keyRequired: true,
    modelPlaceholder: "输入模型代号（如 opus5 / fable5 / claude-3-7-sonnet）",
    models: [],
  },
  {
    id: "openai",
    name: "OpenAI",
    badge: "官方端点",
    baseUrl: "https://api.openai.com/v1",
    wire: "chat",
    keyHint: "sk-proj-...",
    keyRequired: true,
    modelPlaceholder: "输入模型代号（如 gpt-6-sol / gpt-4o / o3-mini）",
    models: [],
  },
  {
    id: "gemini",
    name: "Google Gemini",
    badge: "官方端点",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    wire: "gemini",
    keyHint: "AIzaSy...",
    keyRequired: true,
    modelPlaceholder: "输入模型代号（如 gemini-3.8 / gemini-4 / gemini-2.0-flash）",
    models: [],
  },
  {
    id: "siliconflow",
    name: "SiliconFlow (硅基流动)",
    badge: "云聚合端点",
    baseUrl: "https://api.siliconflow.cn/v1",
    wire: "chat",
    keyHint: "sk-...",
    keyRequired: true,
    modelPlaceholder: "输入模型代号（或填 Key 后点击【探测在线模型】自动获取）",
    models: [],
  },
  {
    id: "moonshot",
    name: "Moonshot (Kimi)",
    badge: "月之暗面",
    baseUrl: "https://api.moonshot.cn/v1",
    wire: "chat",
    keyHint: "sk-...",
    keyRequired: true,
    modelPlaceholder: "输入模型代号（如 kimi-latest / moonshot-v1-128k）",
    models: [],
  },
  {
    id: "zhipu",
    name: "Zhipu AI (智谱清言)",
    badge: "开放平台",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    wire: "chat",
    keyHint: "key.secret",
    keyRequired: true,
    modelPlaceholder: "输入模型代号（如 glm-4-plus）",
    models: [],
  },
  {
    id: "ollama",
    name: "Ollama (本地运行)",
    badge: "本地免密",
    baseUrl: "http://localhost:11434/v1",
    wire: "chat",
    keyHint: "本地模型无需填写密钥",
    keyRequired: false,
    modelPlaceholder: "点击【探测在线模型】自动拉取本地已下载模型",
    models: [],
  },
  {
    id: "custom",
    name: "自定义 / 其他",
    badge: "通用兼容",
    baseUrl: "https://api.your-provider.com/v1",
    wire: "chat",
    keyHint: "API Key",
    keyRequired: false,
    modelPlaceholder: "输入自定义端点的模型标识符",
    models: [],
  },
];
