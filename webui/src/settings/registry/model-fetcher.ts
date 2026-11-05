export interface LiveModelOption { id: string; label: string; desc?: string; }

export interface FetchLiveModelsParams {
  baseUrl: string;
  wire: string;
  apiKey?: string;
  signal?: AbortSignal;
}

export interface FetchLiveModelsResult {
  ok: boolean;
  models: LiveModelOption[];
  error?: string;
}

/**
 * 动态拉取指定端点的实时模型列表。
 * 支持 OpenAI 兼容端点、Ollama 本地服务与 Anthropic 官方端点。
 * 自带 6 秒超时防挂死，遇到 CORS 或网络异常时优雅回报错误，供 UI 降级。
 */
export async function fetchLiveModels(params: FetchLiveModelsParams): Promise<FetchLiveModelsResult> {
  const rawUrl = params.baseUrl.trim().replace(/\/+$/, "");
  if (!rawUrl) return { ok: false, models: [], error: "端点 BaseURL 为空" };

  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), 6000);
  const signal = params.signal ? AbortSignal.any([params.signal, timeoutController.signal]) : timeoutController.signal;

  try {
    // 1. Anthropic 官方 messages wire
    if (params.wire === "messages" || rawUrl.includes("anthropic.com")) {
      const endpoint = rawUrl.endsWith("/v1") ? `${rawUrl}/models` : `${rawUrl}/v1/models`;
      const headers: Record<string, string> = {
        "anthropic-version": "2023-06-01",
        "dangerously-allow-browser": "true",
      };
      if (params.apiKey) {
        headers["x-api-key"] = params.apiKey;
      }
      const resp = await fetch(endpoint, { method: "GET", headers, signal });
      clearTimeout(timeoutId);
      if (!resp.ok) {
        return { ok: false, models: [], error: `HTTP ${resp.status}: ${resp.statusText}` };
      }
      const json = await resp.json() as any;
      const list = Array.isArray(json?.data) ? json.data : [];
      const models: LiveModelOption[] = list.map((item: any) => ({
        id: String(item.id),
        label: String(item.display_name || item.id),
        desc: "Anthropic 在线拉取",
      }));
      return { ok: true, models };
    }

    // 2. Ollama 本地端点兼容
    if (rawUrl.includes("11434") || rawUrl.includes("localhost")) {
      try {
        const ollamaTagsUrl = rawUrl.replace(/\/v1$/, "") + "/api/tags";
        const resp = await fetch(ollamaTagsUrl, { method: "GET", signal });
        if (resp.ok) {
          clearTimeout(timeoutId);
          const json = await resp.json() as any;
          const list = Array.isArray(json?.models) ? json.models : [];
          if (list.length > 0) {
            const models: LiveModelOption[] = list.map((item: any) => ({
              id: String(item.name || item.model),
              label: String(item.name || item.model),
              desc: "Ollama 本地已安装",
            }));
            return { ok: true, models };
          }
        }
      } catch {
        // 退回下面的标准 /models 尝试
      }
    }

    // 3. 通用 OpenAI 兼容格式 (/models)
    const modelsEndpoint = `${rawUrl}/models`;
    const headers: Record<string, string> = {};
    if (params.apiKey && params.apiKey.trim() !== "") {
      headers["Authorization"] = `Bearer ${params.apiKey.trim()}`;
    }

    const resp = await fetch(modelsEndpoint, { method: "GET", headers, signal });
    clearTimeout(timeoutId);
    if (!resp.ok) {
      return { ok: false, models: [], error: `HTTP ${resp.status} (${resp.statusText})` };
    }

    const json = await resp.json() as any;
    const rawList = Array.isArray(json?.data) ? json.data : (Array.isArray(json) ? json : []);
    const models: LiveModelOption[] = rawList
      .filter((item: any) => item && (item.id || item.name))
      .map((item: any) => {
        const id = String(item.id || item.name);
        return {
          id,
          label: id,
          desc: "端点在线同步",
        };
      });

    return { ok: true, models };
  } catch (cause) {
    clearTimeout(timeoutId);
    const msg = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, models: [], error: msg };
  }
}
