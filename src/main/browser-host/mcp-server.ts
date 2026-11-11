// qaqh-browser MCP server：手写 streamable-HTTP MCP 端点，跑在 Electron 主进程。
// 互操作契约以 daemon 实际使用的 rmcp 3.5.1 客户端源码为准（非规范文档猜测）：
// - POST /mcp：Accept 头为 "text/event-stream, application/json"；本实现恒回
//   application/json 单条 JSON-RPC 响应（202/204 也被客户端接受为通知回执）；
// - initialize 响应携带 Mcp-Session-Id，后续请求必须回传；会话失效回 404，
//   rmcp 会自动做透明重握手（perform_reinitialization 路径）；
// - GET /mcp 回 405 → 客户端按 ServerDoesNotSupportSse 优雅跳过公共 SSE 流；
// - DELETE /mcp 回 200 结束会话；
// - 配置里的自定义 headers（config.toml [mcp.servers.qaqh-browser]）逐请求生效。
//
// 鉴权：仅接受 Authorization: Bearer <token>（per-boot 随机，写入 config.toml，
// 与 daemon 同信任域）。只绑 127.0.0.1。

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

/** MCP 端点路径（rmcp unix-socket 分发同样约定 "/mcp"）。 */
const MCP_PATH = "/mcp";
/** 会话头（MCP streamable HTTP 规范）。 */
const SESSION_HEADER = "mcp-session-id";
/** 兜底协议版本；正常路径回显客户端 initialize 请求的版本。 */
const FALLBACK_PROTOCOL_VERSION = "2025-06-18";

/** 工具执行面：engine 提供按名查找的 handler 表，server 只做协议桥接。 */
export type BrowserToolHandlers = Record<
  string,
  (args: Record<string, unknown>) => Promise<{ content: string; isError?: boolean }>
>;

export interface BrowserToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface BrowserMcpServer {
  port: number;
  close(): Promise<void>;
}

const tools: BrowserToolDef[] = [
  {
    name: "browser_navigate",
    description: "打开内嵌浏览器并导航到 URL（自动展示浏览器面板给用户）。返回页面 title 与最终 URL。",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "完整 http(s) URL" } },
      required: ["url"],
    },
  },
  {
    name: "browser_snapshot",
    description: "读取当前页面结构：可交互元素带 [uid]，文本按层级输出。先 snapshot 再用 uid 操作；uid 在下次导航后失效。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_click",
    description: "点击 snapshot 中的元素（真实鼠标事件派发到元素中心）。",
    inputSchema: {
      type: "object",
      properties: { uid: { type: "string", description: "browser_snapshot 输出的 [uid]" } },
      required: ["uid"],
    },
  },
  {
    name: "browser_type",
    description: "向输入框输入文本（先清空原值）；submit 为 true 时再按回车。",
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "string" },
        text: { type: "string" },
        submit: { type: "boolean", description: "输入后是否回车提交" },
      },
      required: ["uid", "text"],
    },
  },
  {
    name: "browser_press_key",
    description: "向页面派发按键：Enter、Tab、Escape、ArrowDown/Up/Left/Right、Backspace、Delete、PageDown/PageUp、Home/End。",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
  },
  {
    name: "browser_scroll",
    description: "滚动页面。direction: up|down；amount 像素（默认 600）。",
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down"] },
        amount: { type: "number" },
      },
      required: ["direction"],
    },
  },
  {
    name: "browser_screenshot",
    description: "截取当前页面为 PNG 并落盘，返回文件绝对路径；用 read_image 工具查看该路径（本工具不直接返回图片内容）。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_console",
    description: "读取页面 console 消息（最近 200 条，可按 level 过滤：log|info|warning|error）。",
    inputSchema: {
      type: "object",
      properties: { level: { type: "string", enum: ["log", "info", "warning", "error"] } },
    },
  },
  {
    name: "browser_close",
    description: "关闭内嵌浏览器并释放内存。浏览器工作结束时调用。",
    inputSchema: { type: "object", properties: {} },
  },
];

// tools/list 与 handlers 表的一致性（schema 有而 handler 缺）由单测把守。

/**
 * 启动 MCP server。立即 resolve（含实际端口）；协议错误不外泄——工具执行失败
 * 一律转 MCP result isError:true（MCP 规范口径），只有传输层错误走 JSON-RPC error。
 */
export async function startBrowserMcpServer(options: {
  token: string;
  handlers: BrowserToolHandlers;
}): Promise<BrowserMcpServer> {
  const { token, handlers } = options;
  let sessionId: string | null = null;

  const server: Server = createServer((request, response) => {
    void route(request, response).catch(() => {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify(jsonRpcError(null, -32700, "internal error")));
      } else {
        response.end();
      }
    });
  });

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== MCP_PATH) {
      response.writeHead(404).end();
      return;
    }
    // rmcp 经 custom headers 逐请求带 token；token 是唯一鉴权面。
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end();
      return;
    }

    if (request.method === "GET") {
      // 契约：405 让 rmcp 跳过公共 SSE 流（ServerDoesNotSupportSse）。
      response.writeHead(405).end();
      return;
    }
    if (request.method === "DELETE") {
      sessionId = null;
      response.writeHead(200).end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }

    const body = await readBody(request);
    let message: JsonRpcRequest;
    try {
      message = JSON.parse(body) as JsonRpcRequest;
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify(jsonRpcError(null, -32700, "parse error")));
      return;
    }

    // 通知（无 id）：initialized 等，202 + 空体即可。
    if (message.id === undefined || message.id === null) {
      response.writeHead(202).end();
      return;
    }

    // 会话校验：initialize 之外的请求必须携带当前会话；失配回 404 触发 rmcp
    // 的透明重握手（SessionExpired → perform_reinitialization）。
    const attached = request.headers[SESSION_HEADER];
    if (message.method === "initialize") {
      sessionId = randomUUID();
    } else if (sessionId == null || attached !== sessionId) {
      response.writeHead(404).end();
      return;
    }

    // 未知方法走 JSON-RPC error（-32601），不伪装成工具结果。
    const dispatchable = message.method === "initialize" || message.method === "ping"
      || message.method === "tools/list" || message.method === "tools/call"
      // 无资源/无提示词的 server 按规范回空集，避免 rmcp 连接期 -32601 告警噪音。
      || message.method === "resources/list" || message.method === "prompts/list";
    if (!dispatchable) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(jsonRpcError(message.id, -32601, `方法 ${message.method} 不支持`)));
      return;
    }

    const result = await dispatch(message);
    response.writeHead(200, {
      "content-type": "application/json",
      ...(message.method === "initialize" ? { [SESSION_HEADER]: sessionId } : {}),
    });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  }

  async function dispatch(message: JsonRpcRequest): Promise<Record<string, unknown>> {
    switch (message.method) {
      case "initialize": {
        const requested = (message.params as { protocolVersion?: string } | undefined)?.protocolVersion;
        return {
          protocolVersion: typeof requested === "string" && requested ? requested : FALLBACK_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "qaqh-browser", version: "1.0.0" },
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return { tools };
      case "resources/list":
        return { resources: [] };
      case "prompts/list":
        return { prompts: [] };
      case "tools/call": {
        const params = message.params as { name?: unknown; arguments?: Record<string, unknown> } | undefined;
        const name = typeof params?.name === "string" ? params.name : "";
        const handler = handlers[name];
        if (name === "" || handler == null) {
          return errorResult(`未知工具 ${name || "(空)"}；可用工具见 tools/list`);
        }
        try {
          const outcome = await handler(params?.arguments ?? {});
          return { content: [{ type: "text", text: outcome.content }], ...(outcome.isError ? { isError: true } : {}) };
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error));
        }
      }
      default: {
        // 不可达：route 已过滤 dispatchable 白名单。
        return errorResult(`方法 ${message.method} 不支持`);
      }
    }
  }

  await new Promise<void>((resolveListen, failListen) => {
    server.once("error", failListen);
    // 只绑回环；端口 0 = 内核分配临时端口，随后写入 config.toml。
    server.listen(0, "127.0.0.1", () => resolveListen());
  });

  return {
    port: (server.address() as { port: number }).port,
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  };
}

/** 工具失败统一口径：单行 error + 下一步建议（isError:true 的 MCP result）。 */
function errorResult(message: string): Record<string, unknown> {
  return { content: [{ type: "text", text: `error: ${message}` }], isError: true };
}

function jsonRpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function readBody(request: IncomingMessage, limitBytes = 10 * 1024 * 1024): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > limitBytes) {
        rejectBody(new Error("request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    request.on("error", rejectBody);
  });
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: unknown;
}
