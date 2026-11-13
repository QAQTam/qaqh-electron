import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function bundleModule(entry) {
  const bundled = await build({ entryPoints: [entry], bundle: true, write: false, format: "esm", platform: "node" });
  return import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
}

const wiring = await bundleModule("src/main/browser-host/config-wiring.ts");
const serverModule = await bundleModule("src/main/browser-host/mcp-server.ts");
const snapshotModule = await bundleModule("src/main/browser-host/snapshot-script.ts");
const devDefsModule = await bundleModule("src/main/dev-host/tool-defs.ts");

const url = "http://127.0.0.1:41235/mcp";
const token = "tok-abc123";

test("spliceMcpSection: 空配置 → 生成最小 [mcp] 段", () => {
  const out = wiring.spliceMcpSection("", url, token);
  assert.match(out, /\[mcp\]\nenabled = true/);
  assert.match(out, /\[mcp\.servers\.qaqh-browser\]/);
  assert.match(out, /url = "http:\/\/127\.0\.0\.1:41235\/mcp"/);
  assert.match(out, /headers = \{ Authorization = "Bearer tok-abc123" \}/);
});

test("spliceMcpSection: 保留既有 section 与注释", () => {
  const input = [
    "# 顶部注释",
    "[providers.my-provider]",
    'name = "x"',
    "",
    "[sandbox]",
    "enabled = true",
    "",
  ].join("\n");
  const out = wiring.spliceMcpSection(input, url, token);
  assert.match(out, /\[providers\.my-provider\]/);
  assert.match(out, /name = "x"/);
  assert.match(out, /\[sandbox\]/);
  assert.match(out, /\[mcp\.servers\.qaqh-browser\]/);
});

test("spliceMcpSection: 替换既有 qaqh-browser 子段且幂等", () => {
  const first = wiring.spliceMcpSection("", url, token);
  const second = wiring.spliceMcpSection(first, "http://127.0.0.1:9999/mcp", "tok-new");
  assert.match(second, /url = "http:\/\/127\.0\.0\.1:9999\/mcp"/);
  assert.doesNotMatch(second, /41235/);
  assert.match(second, /Bearer tok-new/);
  const third = wiring.spliceMcpSection(second, "http://127.0.0.1:9999/mcp", "tok-new");
  assert.equal(third, second, "url+token 一致时不得改写");
});

test("spliceMcpSection: enabled=false 翻转为 true；其他 server 保留", () => {
  const input = [
    "[mcp]",
    "enabled = false",
    "",
    "[mcp.servers.other]",
    'url = "http://127.0.0.1:1/mcp"',
    "",
  ].join("\n");
  const out = wiring.spliceMcpSection(input, url, token);
  assert.match(out, /\[mcp\]\nenabled = true/);
  assert.match(out, /\[mcp\.servers\.other\]/, "其他 server 段必须保留");
  assert.match(out, /\[mcp\.servers\.qaqh-browser\]/);
});

test("spliceMcpSection: [mcp] 头在 server 子段之后时补齐 enabled", () => {
  const input = [
    "[mcp.servers.qaqh-browser]",
    'url = "http://127.0.0.1:1/mcp"',
    "",
    "[mcp]",
    "",
  ].join("\n");
  const out = wiring.spliceMcpSection(input, url, token);
  assert.match(out, /enabled = true/);
  assert.match(out, /url = "http:\/\/127\.0\.0\.1:41235\/mcp"/);
});

test("spliceMcpSection: daemon 子表形态 headers 不产生 duplicate key", () => {
  // 真实事故形态：daemon 把 headers 序列化成 [mcp.servers.qaqh-browser.headers]
  // 子表段回写，壳若只替换到下一个 section 头会留下它，与内联 headers 重复定义。
  const input = [
    "[mcp]",
    "enabled = true",
    "",
    "[mcp.servers.qaqh-browser]",
    'url = "http://127.0.0.1:1/mcp"',
    "default_timeout_secs = 120",
    "",
    "[mcp.servers.qaqh-browser.headers]",
    'Authorization = "Bearer stale"',
    "",
    "[lsp]",
    "enabled = false",
    "",
  ].join("\n");
  const out = wiring.spliceMcpSection(input, url, token);
  assert.doesNotMatch(out, /\[mcp\.servers\.qaqh-browser\.headers\]/, "daemon 子表段必须被移除");
  assert.match(out, /headers = \{ Authorization = "Bearer tok-abc123" \}/);
  assert.match(out, /\[lsp\]/, "无关 section 保留");
  assert.equal(wiring.spliceMcpSection(out, url, token), out, "归一后幂等");
});

test("wireBrowserMcpConfig: 幂等落盘", () => {
  const dir = mkdtempSync(join(tmpdir(), "qaqh-wire-"));
  try {
    const path = join(dir, "config.toml");
    assert.equal(wiring.wireBrowserMcpConfig(path, url, token), true, "首次写入");
    assert.equal(wiring.wireBrowserMcpConfig(path, url, token), false, "重复不写盘");
    assert.match(readFileSync(path, "utf8"), /\[mcp\.servers\.qaqh-browser\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const stubHandlers = {
  browser_navigate: async (args) => ({ content: `nav:${args.url}` }),
  browser_snapshot: async () => ({ content: "elements: 0" }),
};

/** 与 index.ts bootstrap 同形态的门控 surface：devOn 只影响 tools/list 可见性。 */
function makeSurface({ devOn = false, handlers = stubHandlers, extraTools = [], allHandlers = handlers } = {}) {
  return {
    listTools: () => (devOn ? [...serverModule.browserTools, ...extraTools] : [...serverModule.browserTools]),
    resolveHandler: (name) => allHandlers[name],
  };
}

async function post(port, path, body, headers = {}, method = "POST") {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, text, headers: response.headers };
}

test("MCP server: 完整 JSON-RPC 往返（rmcp 兼容面）", async () => {
  const server = await serverModule.startBrowserMcpServer({ token, surface: makeSurface() });
  try {
    // 错误 token → 401
    const bad = await post(server.port, "/mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { authorization: "Bearer wrong" });
    assert.equal(bad.status, 401);

    // initialize → 协议版本回显 + 会话头
    const init = await post(server.port, "/mcp", {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "rmcp", version: "3.5.1" } },
    }, { authorization: `Bearer ${token}` });
    assert.equal(init.status, 200);
    const initResult = JSON.parse(init.text).result;
    assert.equal(initResult.protocolVersion, "2025-06-18");
    assert.ok(initResult.serverInfo.name === "qaqh-browser");
    const sessionHeader = init.headers.get("mcp-session-id");
    assert.ok(sessionHeader, "initialize 响应必须携带 Mcp-Session-Id");

    // 通知 → 202
    const note = await post(server.port, "/mcp", { jsonrpc: "2.0", method: "notifications/initialized" }, {
      authorization: `Bearer ${token}`, "mcp-session-id": sessionHeader,
    });
    assert.equal(note.status, 202);

    // GET → 405（rmcp 据此跳过公共 SSE 流）
    const get = await post(server.port, "/mcp", null, { authorization: `Bearer ${token}` }, "GET");
    assert.equal(get.status, 405);

    // tools/list
    const list = await post(server.port, "/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list" }, {
      authorization: `Bearer ${token}`, "mcp-session-id": sessionHeader,
    });
    const toolNames = JSON.parse(list.text).result.tools.map((tool) => tool.name);
    assert.deepEqual(toolNames, [
      "browser_navigate", "browser_snapshot", "browser_click", "browser_type", "browser_press_key",
      "browser_scroll", "browser_screenshot", "browser_console", "browser_close",
    ]);

    // tools/call 正常路径
    const call = await post(server.port, "/mcp", {
      jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "browser_navigate", arguments: { url: "https://example.com/" } },
    }, { authorization: `Bearer ${token}`, "mcp-session-id": sessionHeader });
    const callResult = JSON.parse(call.text).result;
    assert.equal(callResult.content[0].text, "nav:https://example.com/");
    assert.ok(!("isError" in callResult));

    // tools/call 未知工具 → isError result（非 JSON-RPC error）
    const unknown = await post(server.port, "/mcp", {
      jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope", arguments: {} },
    }, { authorization: `Bearer ${token}`, "mcp-session-id": sessionHeader });
    const unknownResult = JSON.parse(unknown.text);
    assert.equal(unknownResult.result.isError, true);
    assert.match(unknownResult.result.content[0].text, /^error: 未知工具/);

    // 未知方法 → JSON-RPC error -32601（resources/list 已按规范回空集，不算未知）
    const badMethod = await post(server.port, "/mcp", { jsonrpc: "2.0", id: 5, method: "sampling/createMessage" }, {
      authorization: `Bearer ${token}`, "mcp-session-id": sessionHeader,
    });
    assert.equal(JSON.parse(badMethod.text).error.code, -32601);

    // resources/list / prompts/list → 规范空集（rmcp 连接期不再 -32601 告警）
    const resources = await post(server.port, "/mcp", { jsonrpc: "2.0", id: 9, method: "resources/list" }, {
      authorization: `Bearer ${token}`, "mcp-session-id": sessionHeader,
    });
    assert.deepEqual(JSON.parse(resources.text).result, { resources: [] });

    // 会话失配 → 404（rmcp 触发透明重握手）
    const stale = await post(server.port, "/mcp", { jsonrpc: "2.0", id: 6, method: "tools/list" }, {
      authorization: `Bearer ${token}`, "mcp-session-id": "expired-session",
    });
    assert.equal(stale.status, 404);

    // 会话丢失（无头）→ 404
    const headless = await post(server.port, "/mcp", { jsonrpc: "2.0", id: 7, method: "tools/list" }, {
      authorization: `Bearer ${token}`,
    });
    assert.equal(headless.status, 404);

    // DELETE → 会话结束
    const del = await post(server.port, "/mcp", null, { authorization: `Bearer ${token}`, "mcp-session-id": sessionHeader }, "DELETE");
    assert.equal(del.status, 200);
    const after = await post(server.port, "/mcp", { jsonrpc: "2.0", id: 8, method: "tools/list" }, {
      authorization: `Bearer ${token}`, "mcp-session-id": sessionHeader,
    });
    assert.equal(after.status, 404, "DELETE 后旧会话必须失效");
  } finally {
    await server.close();
  }
});

test("snapshot 序列化器：头部与截断口径", () => {
  const full = snapshotModule.serializeSnapshot({ url: "https://example.com/", title: "Example", lines: ["- [1] button \"Ok\""], truncated: false });
  assert.match(full, /^url: https:\/\/example\.com\/\ntitle: Example\nelements: 1\n/);
  assert.match(full, /- \[1\] button "Ok"/);
  const cut = snapshotModule.serializeSnapshot({ url: "u", title: "t", lines: [], truncated: true });
  assert.match(cut, /已截断/);
});

test("工具 schema：browser 9 工具全部具备 name/description/inputSchema", async () => {
  const handlers = Object.fromEntries(
    ["browser_navigate", "browser_snapshot", "browser_click", "browser_type", "browser_press_key", "browser_scroll", "browser_screenshot", "browser_console", "browser_close"]
      .map((name) => [name, async () => ({ content: "ok" })]),
  );
  const server = await serverModule.startBrowserMcpServer({
    token,
    surface: { listTools: () => [...serverModule.browserTools], resolveHandler: (name) => handlers[name] },
  });
  try {
    const init = await post(server.port, "/mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { authorization: `Bearer ${token}` });
    const session = init.headers.get("mcp-session-id");
    const list = await post(server.port, "/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list" }, {
      authorization: `Bearer ${token}`, "mcp-session-id": session,
    });
    const listed = JSON.parse(list.text).result.tools;
    assert.equal(listed.length, 9);
    for (const tool of listed) {
      assert.ok(tool.name && tool.description && tool.inputSchema?.type === "object", `${tool.name} 必须具备完整描述面`);
    }
  } finally {
    await server.close();
  }
});

test("Dev Surface 门控：tools/list 随开关变化，handler 执行面恒定可解析", async () => {
  const devHandlers = Object.fromEntries(
    devDefsModule.devToolDefs.map((tool) => [tool.name, async () => ({ content: `ran:${tool.name}` })]),
  );
  const handlers = { ...stubHandlers, ...devHandlers };
  let devOn = false;
  const surface = {
    listTools: () => (devOn ? [...serverModule.browserTools, ...devDefsModule.devToolDefs] : [...serverModule.browserTools]),
    resolveHandler: (name) => handlers[name],
  };
  const server = await serverModule.startBrowserMcpServer({ token, surface });
  try {
    const init = await post(server.port, "/mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { authorization: `Bearer ${token}` });
    const session = init.headers.get("mcp-session-id");
    const listTools = async () => {
      const res = await post(server.port, "/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list" }, {
        authorization: `Bearer ${token}`, "mcp-session-id": session,
      });
      return JSON.parse(res.text).result.tools.map((tool) => tool.name);
    };

    // 门关：只列 browser 9 件。
    assert.equal((await listTools()).length, 9, "开发者模式关闭时不得暴露 dev 工具");

    // 门开：19 件，名称唯一。
    devOn = true;
    const open = await listTools();
    assert.equal(open.length, 19);
    assert.equal(new Set(open).size, 19, "工具名不得冲突");

    // 门关时直呼 record_stop 仍可执行：门控只管可见性，不管执行
    //（否则收回开发者模式会锁死进行中的录制——见 mcp-server.ts BrowserMcpSurface 注释）。
    devOn = false;
    const call = await post(server.port, "/mcp", {
      jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "record_stop", arguments: {} },
    }, { authorization: `Bearer ${token}`, "mcp-session-id": session });
    const result = JSON.parse(call.text).result;
    assert.equal(result.content[0].text, "ran:record_stop");
    assert.ok(!result.isError);
  } finally {
    await server.close();
  }
});

test("Dev Surface schema：ui_*/record_* 10 件全部具备完整描述面", () => {
  const defs = devDefsModule.devToolDefs;
  assert.equal(defs.length, 10);
  for (const tool of defs) {
    assert.ok(tool.name && tool.description && tool.inputSchema?.type === "object", `${tool.name} 必须具备完整描述面`);
  }
});
