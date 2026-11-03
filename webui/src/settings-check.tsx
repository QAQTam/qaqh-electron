/**
 * 开发夹具:真实 `App` + 假宿主 IPC,在浏览器里跑设置浮层的读写语义。
 *
 * 为什么要有它:设置写入走 Electron 的 `command` 统一命令面，读取走类型化
 * `service_query`。浏览器里既没有 daemon 也没有宿主，所以夹具分别模拟这两条边界；
 * `config.save` 收到什么 patch，就是 webview 实际发出去的 patch。
 *
 * 不进产品构建:vite 构建入口是 `index.html`,本文件只被 `/settings-check.html` 引用。
 */
import { render } from "@solidjs/web";
import App from "./app/App";
import type { ConfigDto } from "./api/qaqh/ConfigDto";
import { simMemorySnapshot } from "./lib/memwatch-sim";
import { openDevConsole } from "./lib/devmode";
import { openSettings } from "./settings/store";
import { openSession } from "./tabs/store";
import type { McpServerDto } from "./api/qaqh/McpServerDto";
import type { LspServerDto } from "./api/qaqh/LspServerDto";
import type { DesktopHostBridge } from "./lib/desktop-host";

type CommandCall = {
  command: Record<string, unknown>;
  target?: Record<string, unknown>;
  preconditions?: Array<Record<string, unknown>>;
  params?: Record<string, unknown>;
};

const baseConfig = (): ConfigDto => ({
  model: "ox-alpha-free",
  baseUrl: "https://opencode.ai/zen/go/v1",
  wire: "chat",
  credential: "api_key",
  maxTokens: 96000,
  contextLength: 1000000,
  reasoningEffort: "max",
  autoCompactThreshold: 0.95,
  permissionLevel: 2,
  apiKey: "****",
  lang: null,
  fontFamily: "",
  theme: null,
  notificationsEnabled: true,
  activeProfile: "default",
  profiles: ["default", "fast"],
  profilesDetail: {
    default: {
      name: "默认",
      model: "ox-alpha-free",
      baseUrl: "https://opencode.ai/zen/go/v1",
      wire: "chat",
      effort: "max",
      contextLength: 1000000,
      maxTokens: 96000,
      apiKeySet: true,
      credential: "api_key",
    },
    fast: {
      name: "极速",
      model: "ox-alpha-fast",
      baseUrl: "https://opencode.ai/zen/go/v1",
      wire: "chat",
      effort: "medium",
      contextLength: 200000,
      maxTokens: 8192,
      apiKeySet: true,
      credential: "api_key",
    },
  },
  complianceEnabled: false,
  exec: { defaultShell: null },
  sessionIdleUnloadSecs: 0,
  subagent: {
    model: "om-two",
    baseUrl: "https://other.example/compat/v1",
    apiKey: "",
    apiKeySet: false,
    maxTokens: 4096,
    timeoutSecs: 120,
    defaultTools: ["read", "write"],
    maxDepth: 1,
    messageInFlightPerPair: 16,
    messageOutboundPerSender: 1024,
  },
  mcp: {
    enabled: true,
    idleShutdownSecs: 300,
    servers: [
      {
        name: "context7",
        transport: "stdio",
        command: "npx",
        args: ["-y", "ctx7"],
        env: { KEY: "${secret:ctx7}" },
        url: "",
        headers: {},
        tools: null,
        resourcesEnabled: false,
        defaultTimeoutSecs: 30,
        maxConcurrentCalls: 8,
        cwd: "",
      } satisfies McpServerDto,
    ],
  },
  lsp: {
    enabled: false,
    idleShutdownSecs: 600,
    servers: [
      {
        name: "rust-analyzer",
        command: "rust-analyzer",
        args: [],
        env: {},
        extensions: ["rs"],
        startupTimeoutSecs: 20,
        defaultTimeoutSecs: 60,
      } satisfies LspServerDto,
    ],
  },
  sandbox: { enabled: true },
  toolAllowlistEnabled: false,
  toolAllowlist: [],
  tokenizerPath: null,
});

const probe = {
  calls: [] as CommandCall[],
  saves: [] as Record<string, unknown>[],
  config: baseConfig(),
  /** Legacy profile service 与新 provider/model catalog 分开维护。 */
  registry: {
    revision: 1,
    default_profile: "default",
    providers: {
      "default-provider": {
        name: "OpenCode Zen",
        base_url: "https://opencode.ai/zen/go/v1",
        wire: "chat",
        credential: "api_key",
        api_key: "****",
      },
      "fast-provider": {
        name: "OpenCode Zen",
        base_url: "https://opencode.ai/zen/fast/v1",
        wire: "chat",
        credential: "api_key",
        api_key: "****",
      },
    },
    // profile.list 现返回 ProfileSummaryDto 摘要(camelCase、按 baseUrl 对回目录,
    // 无 provider 指针);default_profile 仅供夹具内部的 config 投影使用。
    profiles: {
      default: {
        name: "默认",
        model: "ox-alpha-free",
        baseUrl: "https://opencode.ai/zen/go/v1",
        wire: "chat",
        effort: "max",
        contextLength: 1000000,
        maxTokens: 96000,
        apiKeySet: true,
        credential: "api_key",
      },
      fast: {
        name: "极速",
        model: "ox-alpha-fast",
        baseUrl: "https://opencode.ai/zen/fast/v1",
        wire: "chat",
        effort: "medium",
        contextLength: 200000,
        maxTokens: 8192,
        apiKeySet: true,
        credential: "api_key",
      },
    },
  } as Record<string, any>,
  providerCatalog: {
    revision: 1,
    default_model_selection: {
      provider_id: "default-provider",
      model_id: "ox-alpha-free",
      options: { max_output_tokens: 96000, reasoning_effort: "max" },
    },
    providers: {
      "default-provider": {
        name: "OpenCode Zen",
        base_url: "https://opencode.ai/zen/go/v1",
        wire: "chat",
        credential: "api_key",
        api_key: "set",
        headers: {},
        compat: null,
        models: {
          "ox-alpha-free": {
            enabled: true,
            display_name: "Ox Alpha Free",
            context_window: 1000000,
            max_output_tokens: 96000,
            reasoning_levels: ["medium", "high", "max"],
            capabilities: { tool_calls: true, image_input: true, native_web_search: false, reasoning: true },
            defaults: { max_output_tokens: 96000, reasoning_effort: "max", native_web_search: false },
          },
        },
      },
      "fast-provider": {
        name: "OpenCode Zen",
        base_url: "https://opencode.ai/zen/fast/v1",
        wire: "chat",
        credential: "api_key",
        api_key: "set",
        headers: {},
        compat: null,
        models: {
          "ox-alpha-fast": {
            enabled: true,
            display_name: "Ox Alpha Fast",
            context_window: 200000,
            max_output_tokens: 8192,
            reasoning_levels: ["medium", "high"],
            capabilities: { tool_calls: true, image_input: false, native_web_search: false, reasoning: true },
            defaults: { max_output_tokens: 8192, reasoning_effort: "medium", native_web_search: false },
          },
        },
      },
    },
  } as Record<string, any>,
  /** 置 true 后 LAN 重启请求返回 `daemon_busy`,用来走查强制重启确认面板。 */
  lanBusy: false,
};

/** 把 profiles.toml 快照投影回 `config.load` 的顶字段（与 daemon 的读模型一致）。 */
function syncProbeProjection(): void {
  const doc = probe.registry;
  // 摘要没有 provider 指针,和 registry.ts 一样按 baseUrl 对回旧目录。
  const providerIdOf = (baseUrl: string): string =>
    Object.entries(doc.providers).find(([, item]: [string, any]) => item.base_url === baseUrl)?.[0] ?? "";
  const defaultId = doc.default_profile == null ? null : String(doc.default_profile);
  const profile = defaultId == null ? null : doc.profiles[defaultId];
  const provider = profile == null ? null : doc.providers[providerIdOf(profile.baseUrl)];
  probe.config.activeProfile = defaultId ?? "";
  probe.config.profiles = Object.keys(doc.profiles);
  probe.config.profilesDetail = Object.fromEntries(
    Object.entries(doc.profiles).map(([id, item]: [string, any]) => [
      id,
      {
        name: item.name,
        model: item.model,
        baseUrl: item.baseUrl ?? "",
        wire: item.wire ?? "chat",
        effort: item.effort ?? null,
        contextLength: item.contextLength ?? null,
        maxTokens: item.maxTokens ?? null,
        apiKeySet: item.apiKeySet ?? false,
        credential: item.credential ?? "api_key",
      },
    ]),
  );
  if (profile == null || provider == null) return;
  probe.config.model = profile.model;
  probe.config.baseUrl = provider.base_url;
  probe.config.wire = provider.wire;
  probe.config.credential = provider.credential;
  probe.config.reasoningEffort = profile.effort ?? "";
  probe.config.contextLength = profile.contextLength ?? 0;
  probe.config.maxTokens = profile.maxTokens ?? 0;
  probe.config.apiKey = provider.api_key == null ? "" : "****";
}

/** Skills 夹具直接采用 daemon `skills.catalog` 的完成态结果。 */
const projectWorkspace = {
  id: "w1", title: "演示仓库", path: "E:/fixtures/demo-repo", order: 0, session_ids: [], missing_dir: false,
};

/**
 * `?workspaces=multi`:再挂三条与真实用户机器同形的 Windows 工作区——长盘符路径、
 * 其中一条 title 与路径末段同名(正是「名字 + 路径」双行重复的那种)。
 * 默认不挂:布局闸对侧栏条目数的既有断言不受影响。
 */
const multiWorkspaces = new URLSearchParams(window.location.search).get("workspaces") === "multi"
  ? [
      { id: "w2", title: "qaqh-desktop-app", path: "D:/eew/QAQHarness/qaqh-desktop-app", order: 1, session_ids: [], missing_dir: false },
      { id: "w3", title: "qaqh-backend", path: "D:/eew/QAQHarness/qaqh-backend", order: 2, session_ids: [], missing_dir: false },
      { id: "w4", title: "claude-desktop", path: "C:/Users/tsy3m/AppData/Local/Programs/claude-desktop", order: 3, session_ids: [], missing_dir: false },
    ]
  : [];
const skillsCatalogFixture = {
  skills: [
    {
      name: "shadowed-skill",
      description: "项目级同名条目。(layout fixture)",
      scope: "project",
      origin: "project",
      path: `${projectWorkspace.path}/skills/shadowed-skill/SKILL.md`,
    },
    {
      name: "mc-bug-audit",
      description: "独立审计 / 主动找 bug。(layout fixture)",
      scope: "user",
      origin: "user",
      path: "C:/Users/fixture/.agents/skills/mc-bug-audit/SKILL.md",
    },
  ],
  diagnostics: [],
};

/** wire 落盘的读回形态与 daemon 一致:`Wire::parse` 收旧拼写,读模型恒回规范名。 */
const CANONICAL_WIRE: Record<string, string> = {
  openai: "chat",
  "openai-compatible": "chat",
  chat_completions: "chat",
  anthropic: "messages",
  claude: "messages",
  "openai-responses": "responses",
};

/** 假宿主的 merge patch 应用:与 daemon 同语义——缺字段不动,`"****"`/空串密钥保持。 */
function applyMergePatch(target: ConfigDto, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (key === "subagent" && value != null && typeof value === "object") {
      Object.assign(target.subagent, value as Record<string, unknown>);
      continue;
    }
    if (key === "apiKey" && (value === "****" || value === "")) continue;
    // 出网是旧拼写(`openai`/`anthropic`),回显恒为规范名——不换回来,设置页
    // 下拉(只摆规范名)保存后就会丢选中态。
    if (key === "wire" && typeof value === "string") {
      (target as Record<string, unknown>)[key] = CANONICAL_WIRE[value] ?? value;
      continue;
    }
    (target as Record<string, unknown>)[key] = value;
  }
}

function hostService(method: string, params: Record<string, unknown> = {}): unknown {
  probe.calls.push({ command: { type: method }, params: structuredClone(params) });
  switch (method) {
    case "config.load":
      syncProbeProjection();
      return structuredClone(probe.config);
    case "profile.list":
      return structuredClone(probe.registry);
    case "daemon.version":
      return "3.0.20261103-1";
    case "session.list":
    case "session.activity":
      return [];
    case "session.meta":
    case "plan.read":
      return null;
    case "workspace.list":
      return [projectWorkspace, ...multiWorkspaces];
    case "skills.catalog":
      return structuredClone(skillsCatalogFixture);
    case "todo.list":
      return { items: [] };
    case "todo.status":
      return { items: [] };
    case "skills.list_tools":
      return [];
    case "diagnostics.memory.snapshot":
      return simMemorySnapshot();
    default:
      throw new Error(`service query not allowed in fixture: ${method}`);
  }
}

function hostCommand(
  command: Record<string, unknown>,
  target?: Record<string, unknown>,
  preconditions?: Array<Record<string, unknown>>,
): Record<string, unknown> {
  probe.calls.push({ command, target, preconditions });
  const guardedWrites = new Set([
    "provider.upsert", "provider.delete", "provider.model.upsert", "provider.model.delete", "model.selection.set_default",
  ]);
  if (guardedWrites.has(String(command.type))) {
    const guard = preconditions?.find((item) => item.kind === "config_revision");
    if (typeof guard?.revision !== "number" || guard.revision !== probe.providerCatalog.revision) {
      return {
        status: "rejected",
        command_id: "fixture-command",
        code: "config_revision_conflict",
        message: "provider catalog revision changed",
      };
    }
  }
  let result: unknown;
  let revision: number | undefined;
  switch (command.type) {
    case "config.save": {
      const patch = (command.patch ?? {}) as Record<string, unknown>;
      probe.saves.push(structuredClone(patch));
      applyMergePatch(probe.config, patch);
      break;
    }
    case "provider.list":
      result = structuredClone(probe.providerCatalog);
      revision = probe.providerCatalog.revision;
      break;
    case "provider.upsert": {
      const id = String(command.id);
      const input = (command.provider ?? {}) as Record<string, unknown>;
      const previous = probe.providerCatalog.providers[id] ?? { models: {} };
      const secret = input.api_key as Record<string, unknown> | undefined;
      const apiKey = secret?.operation === "clear" ? null
        : secret?.operation === "set" ? "set"
        : previous.api_key;
      probe.providerCatalog.providers[id] = {
        ...previous,
        ...input,
        api_key: apiKey,
      };
      probe.registry.providers[id] = {
        ...(probe.registry.providers[id] ?? {}),
        name: input.name,
        base_url: input.base_url,
        wire: input.wire,
        credential: input.credential,
        api_key: apiKey,
      };
      probe.providerCatalog.revision += 1;
      revision = probe.providerCatalog.revision;
      syncProbeProjection();
      break;
    }
    case "provider.model.upsert": {
      const providerId = String(command.provider_id);
      const modelId = String(command.model_id);
      const provider = probe.providerCatalog.providers[providerId];
      if (provider == null) throw new Error(`provider ${providerId} 不存在`);
      provider.models ??= {};
      provider.models[modelId] = structuredClone(command.model);
      probe.providerCatalog.revision += 1;
      revision = probe.providerCatalog.revision;
      break;
    }
    case "provider.model.delete": {
      const provider = probe.providerCatalog.providers[String(command.provider_id)];
      if (provider != null) delete provider.models?.[String(command.model_id)];
      probe.providerCatalog.revision += 1;
      revision = probe.providerCatalog.revision;
      break;
    }
    case "model.selection.set_default": {
      const selection = command.selection as Record<string, unknown>;
      probe.providerCatalog.default_model_selection = structuredClone(selection);
      const providerIdOf = (baseUrl: string): string =>
        Object.entries(probe.registry.providers).find(([, item]: [string, any]) => item.base_url === baseUrl)?.[0] ?? "";
      const selectedProfile = Object.entries(probe.registry.profiles).find(([, profile]: [string, any]) =>
        providerIdOf(profile.baseUrl) === selection.provider_id && profile.model === selection.model_id);
      probe.registry.default_profile = selectedProfile?.[0] ?? null;
      probe.providerCatalog.revision += 1;
      revision = probe.providerCatalog.revision;
      break;
    }
    case "profile.create": {
      const id = String(command.id ?? command.name);
      probe.registry.profiles[id] = {
        name: command.name,
        model: command.model,
        baseUrl: command.base_url ?? "",
        wire: command.wire ?? "chat",
        effort: command.reasoning_effort ?? null,
        contextLength: command.context_length ?? 0,
        maxTokens: command.max_tokens ?? null,
        apiKeySet: command.api_key != null,
        credential: "api_key",
      };
      if (probe.registry.default_profile == null) probe.registry.default_profile = id;
      syncProbeProjection();
      break;
    }
    case "profile.delete": {
      const id = String(command.name);
      const profile = probe.registry.profiles[id];
      const selection = probe.providerCatalog.default_model_selection;
      const providerIdOf = (baseUrl: string): string =>
        Object.entries(probe.registry.providers).find(([, item]: [string, any]) => item.base_url === baseUrl)?.[0] ?? "";
      const profileProviderId = profile == null ? "" : providerIdOf(profile.baseUrl);
      if (profile != null && selection?.provider_id === profileProviderId && selection?.model_id === profile.model) {
        throw new Error("默认模型存档不可删除");
      }
      delete probe.registry.profiles[id];
      syncProbeProjection();
      break;
    }
    case "diagnostics.memory.start":
    case "diagnostics.memory.stop":
      break;
    default:
      throw new Error(`command not allowed in fixture: ${String(command.type)}`);
  }
  return {
    status: "accepted",
    command_id: "fixture-command",
    operation: String(command.type),
    ...(result === undefined ? {} : { result }),
    ...(revision === undefined ? {} : { revision }),
  };
}

/**
 * 假宿主的 daemon 局域网面:字段与 `qaqh-electron/src/main/ipc-handlers.ts` 的 lanView 同形。
 * 夹具验的是前端语义与观感,所以「重启」只翻转内存状态,不真起进程。
 */
const lan = {
  running: true,
  active: false,
  endpoint: "http://127.0.0.1:61746",
  lan_endpoint: null as string | null,
  tls_fingerprint: null as string | null,
  pid: 45368,
};

const lanView = (): Record<string, unknown> => ({
  ...lan,
  daemon_version: "2.0.20261028",
  build_id: "389a070cf7732256978ab3851e1c841edde24a24",
  protocol_version: 1,
  app_protocol_version: 1,
});

const lanRestartGuard = (): void => {
  if (probe.lanBusy) throw new Error("daemon_busy");
};

function lanEnable(bindIp: string, port: number | null): Record<string, unknown> {
  lanRestartGuard();
  const host = bindIp.trim() === "" ? "192.168.1.23" : bindIp.trim();
  lan.active = true;
  lan.running = true;
  lan.pid += 1;
  lan.lan_endpoint = `https://${host}:${port ?? 64413}`;
  lan.tls_fingerprint = "sha256:8a5f1c2b9d4e7f60aa12b34c5d6e7f80";
  return lanView();
}

function lanDisable(): Record<string, unknown> {
  lanRestartGuard();
  lan.active = false;
  lan.pid += 1;
  lan.lan_endpoint = null;
  lan.tls_fingerprint = null;
  return lanView();
}

const pairingTicket = (): Record<string, unknown> => {
  const baseUrl = (lan.lan_endpoint ?? "https://192.168.1.23:64413").replace(/\/$/, "");
  return {
    qr_payload: JSON.stringify({
      v: 1,
      kind: "qaqh-pair",
      base_url: baseUrl,
      pairing_token: "fixture-one-time-token",
      tls_fp: lan.tls_fingerprint ?? "",
      host_name: "QAQH-DEV",
    }),
    expires_in_ms: 120_000,
    base_url: baseUrl,
  };
};

const callbacks = new Map<number, (payload: unknown) => void>();
let nextCallbackId = 1;

const internals = {
  metadata: { currentWindow: { label: "main" }, windowLabels: { main: 1 } },
  transformCallback(callback: (payload: unknown) => void, once = false): number {
    void once;
    const id = nextCallbackId;
    nextCallbackId += 1;
    callbacks.set(id, callback);
    return id;
  },
  unregisterCallback(id: number): void {
    callbacks.delete(id);
  },
  async invoke(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (cmd === "command") {
      return hostCommand(
        (args.command ?? {}) as Record<string, unknown>,
        args.target as Record<string, unknown> | undefined,
        args.preconditions as Array<Record<string, unknown>> | undefined,
      );
    }
    if (cmd === "service_query") return hostService(String(args.method ?? ""), (args.params ?? {}) as Record<string, unknown>);
    if (cmd === "session_list") return [];
    if (cmd === "timeline_status") return null;
    if (cmd === "daemon_lan_status") return lanView();
    if (cmd === "daemon_lan_enable") return lanEnable(String(args.bindIp ?? ""), (args.port as number | null | undefined) ?? null);
    if (cmd === "daemon_lan_disable") return lanDisable();
    if (cmd === "pairing_create") return pairingTicket();
    if (cmd === "app_version") {
      return { version: "2.0.20261028", commit: "fixture0", display: "2.0.20261028+fixture0" };
    }
    // 界面进程组(commands.rs::host_process_group 的替身)。形状照 procgroup.rs:
    // 角色由「引擎」自报、字节量逐成员给;最后那条 utility 故意读不到,用来验
    // 「失败不静默跳过」——它该进 excluded 而不是被少加。
    if (cmd === "host_process_group") {
      const wave = Math.round(Math.sin(Date.now() / 7_000) * 3_000_000);
      return {
        source: "webview2.pids+psapi",
        error: null,
        members: [
          { pid: 4100, kind: "browser", resident_bytes: 96_000_000 + wave, private_bytes: 88_000_000, error: null },
          { pid: 4120, kind: "renderer", resident_bytes: 168_000_000 + wave * 2, private_bytes: 150_000_000, error: null },
          { pid: 4131, kind: "renderer", resident_bytes: 42_000_000, private_bytes: 36_000_000, error: null },
          { pid: 4108, kind: "gpu", resident_bytes: 54_000_000, private_bytes: 47_000_000, error: null },
          { pid: 4144, kind: "utility", resident_bytes: null, private_bytes: null, error: "OpenProcess(4144) failed: 拒绝访问" },
        ],
      };
    }
    // 壳自己的内存计数(commands.rs::host_memory 的替身)。字段与 psapi 分支同形,
    // 让「本机」面板在浏览器里也有数可拍;private 给值、virtual 给 null,顺带验一次
    // 「缺测显示 —」而不是冒充 0。
    if (cmd === "host_memory") {
      const resident = 214_000_000 + Math.round(Math.sin(Date.now() / 9_000) * 4_000_000);
      return {
        resident_bytes: resident,
        private_bytes: resident - 18_000_000,
        virtual_bytes: null,
        peak_resident_bytes: 268_000_000,
        source: "fixture.psapi",
        error: null,
      };
    }
    if (cmd === "devices_list") {
      return {
        devices: [
          {
            device_id: "dev_seed_1",
            name: "我的手机",
            platform: "mobile",
            scope: "interact",
            created_at_ms: Date.now() - 86_400_000,
            last_seen_ms: Date.now() - 3_600_000,
          },
        ],
      };
    }
    // 插件命令(event/opener/window)在夹具里都是空转:结构合法即可。
    return null;
  },
};

declare global {
  interface Window {
    __qaqhProbe?: typeof probe;
  }
}

const host: DesktopHostBridge = {
  platform: "electron",
  invoke: <T,>(cmd: Parameters<DesktopHostBridge["invoke"]>[0], args?: Record<string, unknown>) =>
    internals.invoke(cmd, args) as Promise<T>,
  listen: () => () => {},
  requestQuit: async () => {},
};
window.qaqhHost = host;
window.__qaqhProbe = probe;

const root = document.getElementById("root");
if (root != null) render(() => <App />, root);

/**
 * `?dev=1`:给开发者控制台铺一层「可拍的真状态」——开一个假会话标签(活动面板就
 * 有 store 可读)、打开设置、并解锁控制台。默认不开:既有断言与基线都不受影响。
 * 走的是真 `App` + 真 `ElectronTransport`,所以事件流面板在这里能看到埋点真的记到了
 * 收发(stress.tsx 那条路把 `transport.query` 整个替掉了,绕过埋点)。
 */
const devHarness = new URLSearchParams(window.location.search).get("dev") === "1";
if (devHarness) {
  void openSession("seed_dev_preview");
  void openSettings();
  openDevConsole();
}
