/**
 * 开发夹具:真实 `App` + 假宿主 IPC,在浏览器里跑设置浮层的读写语义。
 *
 * 为什么要有它:设置页的唯一通路是 Electron 的 `command` 统一命令面,浏览器里既
 * 没有 daemon 也没有宿主。这里把宿主替身做成「闭集式」的——只认统一命令,
 * 其余抛错,于是 fixture 里能验的是语义而不是便利:`config.patch` 收到什么 patch,
 * 就是 webview 真的发出去了什么。
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

type CommandCall = { command: Record<string, unknown> };

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
      id: "default",
      name: "默认",
      providerId: "default-provider",
      providerName: "OpenCode Zen",
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
      id: "fast",
      name: "极速",
      providerId: "fast-provider",
      providerName: "OpenCode Zen",
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
  defaultToolMode: "",
  tokenizerPath: null,
});

const probe = {
  calls: [] as CommandCall[],
  saves: [] as Record<string, unknown>[],
  config: baseConfig(),
  /** `profile.list` 的权威快照；写命令与 config.load 的读投影都从它派生。 */
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
        base_url: "https://opencode.ai/zen/go/v1",
        wire: "chat",
        credential: "api_key",
        api_key: "****",
      },
    },
    profiles: {
      default: {
        name: "默认",
        provider: "default-provider",
        model: "ox-alpha-free",
        reasoning_effort: "max",
        context_length: 1000000,
        max_tokens: 96000,
      },
      fast: {
        name: "极速",
        provider: "fast-provider",
        model: "ox-alpha-fast",
        reasoning_effort: "medium",
        context_length: 200000,
        max_tokens: 8192,
      },
    },
  } as Record<string, any>,
  /** 置 true 后 LAN 重启请求返回 `daemon_busy`,用来走查强制重启确认面板。 */
  lanBusy: false,
};

/** 把 profiles.toml 快照投影回 `config.load` 的顶字段（与 daemon 的读模型一致）。 */
function syncProbeProjection(): void {
  const doc = probe.registry;
  const defaultId = doc.default_profile == null ? null : String(doc.default_profile);
  const profile = defaultId == null ? null : doc.profiles[defaultId];
  const provider = profile == null ? null : doc.providers[profile.provider];
  probe.config.activeProfile = defaultId ?? "";
  probe.config.profiles = Object.keys(doc.profiles);
  probe.config.profilesDetail = Object.fromEntries(
    Object.entries(doc.profiles).map(([id, item]: [string, any]) => {
      const itemProvider = doc.providers[item.provider];
      return [
        id,
        {
          id,
          name: item.name,
          providerId: item.provider,
          providerName: itemProvider?.name ?? item.provider,
          model: item.model,
          baseUrl: itemProvider?.base_url ?? "",
          wire: itemProvider?.wire ?? "chat",
          effort: item.reasoning_effort ?? null,
          contextLength: item.context_length ?? null,
          maxTokens: item.max_tokens ?? null,
          apiKeySet: itemProvider?.api_key != null,
          credential: itemProvider?.credential ?? "api_key",
        },
      ];
    }),
  );
  if (profile == null || provider == null) return;
  probe.config.model = profile.model;
  probe.config.baseUrl = provider.base_url;
  probe.config.wire = provider.wire;
  probe.config.credential = provider.credential;
  probe.config.reasoningEffort = profile.reasoning_effort ?? "";
  probe.config.contextLength = profile.context_length ?? 0;
  probe.config.maxTokens = profile.max_tokens ?? 0;
  probe.config.apiKey = provider.api_key == null ? "" : "****";
}

/**
 * 项目级 skills 夹具:`workspace.list` 里注册一个工作区,`fs.list`/`fs.read`
 * 给出它下面的 `skills/` 目录(形状与 daemon 的 `fs_git.rs:98-196` 一致)。
 *
 * 与用户级夹具成对:两层各一条同名 `shadowed-skill`,用来在布局闸里验「被同名
 * 覆盖」的降级态真的渲染出来了。
 */
const projectWorkspace = { id: "w1", title: "演示仓库", path: "E:/fixtures/demo-repo", order: 0 };

/**
 * `?workspaces=multi`:再挂三条与真实用户机器同形的 Windows 工作区——长盘符路径、
 * 其中一条 title 与路径末段同名(正是「名字 + 路径」双行重复的那种)。
 * 默认不挂:布局闸对侧栏条目数的既有断言不受影响。
 */
const multiWorkspaces = new URLSearchParams(window.location.search).get("workspaces") === "multi"
  ? [
      { id: "w2", title: "qaqh-desktop-app", path: "D:/eew/QAQHarness/qaqh-desktop-app", order: 1 },
      { id: "w3", title: "qaqh-backend", path: "D:/eew/QAQHarness/qaqh-backend", order: 2 },
      { id: "w4", title: "claude-desktop", path: "C:/Users/tsy3m/AppData/Local/Programs/claude-desktop", order: 3 },
    ]
  : [];
const projectFs: Record<string, unknown> = {
  [projectWorkspace.path]: [
    { name: "skills", path: `${projectWorkspace.path}/skills`, is_dir: true, is_file: false },
  ],
  [`${projectWorkspace.path}/skills`]: [
    { name: "shadowed-skill", path: `${projectWorkspace.path}/skills/shadowed-skill`, is_dir: true, is_file: false },
  ],
  [`${projectWorkspace.path}/skills/shadowed-skill`]: [
    { name: "SKILL.md", path: `${projectWorkspace.path}/skills/shadowed-skill/SKILL.md`, is_dir: false, is_file: true },
  ],
};
const projectFiles: Record<string, string> = {
  [`${projectWorkspace.path}/skills/shadowed-skill/SKILL.md`]:
    "---\nname: shadowed-skill\ndescription: 项目级同名条目。(layout fixture)\n---\n\n# Shadowed\n",
};

/**
 * 用户级 skills 夹具(`skills_user_scan` 的回包形状,见 `qaqh-electron/src/main/skills-scanner.ts`)。
 *
 * 这里是**宿主命令**而不是 daemon rpc:用户级那两个根不在 daemon `fs.*` 的
 * allowed_roots 里,布局回归要验的正是「宿主这一层真的被接上」——所以夹具给的
 * 是宿主的形状,而不是把用户级伪装成一次 fs.list。
 */
const userSkillsFixture = {
  roots: [
    { path: "C:/Users/fixture/.qaqh/skills", label: "~/.qaqh/skills", exists: false },
    { path: "C:/Users/fixture/.agents/skills", label: "~/.agents/skills", exists: true },
  ],
  skills: [
    {
      root: "C:/Users/fixture/.agents/skills",
      path: "C:/Users/fixture/.agents/skills/mc-bug-audit/SKILL.md",
      content: "---\nname: mc-bug-audit\ndescription: 独立审计 / 主动找 bug。(layout fixture)\n---\n\n# Independent bug audit\n",
      bytes: 160,
    },
    {
      root: "C:/Users/fixture/.agents/skills",
      path: "C:/Users/fixture/.agents/skills/shadowed-skill/SKILL.md",
      content: "---\nname: shadowed-skill\ndescription: 用户级同名条目,项目级已先占。(layout fixture)\n---\n\n# Shadowed(user)\n",
      bytes: 160,
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

function hostCommand(command: Record<string, unknown>): unknown {
  probe.calls.push({ command });
  switch (command.type) {
    case "config.load":
      return structuredClone(probe.config);
    case "config.patch": {
      const patch = (command.patch ?? {}) as Record<string, unknown>;
      probe.saves.push(structuredClone(patch));
      applyMergePatch(probe.config, patch);
      return structuredClone(probe.config);
    }
    case "profile.list":
      syncProbeProjection();
      return structuredClone(probe.registry);
    case "provider.upsert": {
      const id = String(command.id);
      const input = (command.provider ?? {}) as Record<string, unknown>;
      const previous = probe.registry.providers[id] ?? {};
      const next: Record<string, unknown> = { ...previous, ...input };
      if ("baseUrl" in input) {
        next.base_url = input.baseUrl;
        delete next.baseUrl;
      }
      if ("apiKey" in input) {
        if (input.apiKey === "") delete next.api_key;
        else next.api_key = "****";
        delete next.apiKey;
      }
      probe.registry.providers[id] = next;
      probe.registry.revision += 1;
      return null;
    }
    case "profile.create": {
      const id = String(command.id);
      const input = (command.profile ?? {}) as Record<string, unknown>;
      probe.registry.profiles[id] = {
        name: input.name,
        provider: input.provider,
        model: input.model,
        reasoning_effort: input.reasoningEffort ?? null,
        context_length: input.contextLength ?? null,
        max_tokens: input.maxTokens ?? null,
      };
      // 与后端一致：第一条存档自动成为默认。
      if (probe.registry.default_profile == null) {
        probe.registry.default_profile = id;
      }
      probe.registry.revision += 1;
      syncProbeProjection();
      return null;
    }
    case "profile.update": {
      const id = String(command.id);
      const input = (command.profile ?? {}) as Record<string, unknown>;
      probe.registry.profiles[id] = {
        name: input.name,
        provider: input.provider,
        model: input.model,
        reasoning_effort: input.reasoningEffort ?? null,
        context_length: input.contextLength ?? null,
        max_tokens: input.maxTokens ?? null,
      };
      probe.registry.revision += 1;
      syncProbeProjection();
      return null;
    }
    case "profile.set_default": {
      const id = String(command.id);
      if (probe.registry.profiles[id] == null) throw new Error(`profile ${id} 不存在`);
      probe.registry.default_profile = id;
      probe.registry.revision += 1;
      syncProbeProjection();
      return null;
    }
    case "profile.delete": {
      const id = String(command.id);
      if (probe.registry.default_profile === id) throw new Error("默认存档不可删除");
      delete probe.registry.profiles[id];
      probe.registry.revision += 1;
      syncProbeProjection();
      return null;
    }
    case "provider.delete": {
      const id = String(command.id);
      const referenced = Object.values(probe.registry.profiles).some(
        (profile: any) => profile.provider === id,
      );
      if (referenced) throw new Error("服务商仍被存档引用");
      delete probe.registry.providers[id];
      probe.registry.revision += 1;
      return null;
    }
    case "daemon.version":
      return "2.0.20261028";
    case "session.list":
      return [];
    case "workspace.list":
      // 裸数组,与 `todo.list` 的
      // `{ items }` 不同形;侧栏按数组直接 `.map`,给成对象会当场halt掉反应式系统。
      return [projectWorkspace, ...multiWorkspaces];
    case "fs.list": {
      const entries = projectFs[String(command.path)];
      if (entries == null) throw new Error(`fs.list ${String(command.path)}: 系统找不到指定的文件。(fixture)`);
      return entries;
    }
    case "fs.read": {
      const content = projectFiles[String(command.path)];
      if (content == null) throw new Error(`fs.read ${String(command.path)}: 系统找不到指定的文件。(fixture)`);
      return { path: command.path, size: content.length, truncated: false, content };
    }
    case "todo.list":
      return { items: [] };
    case "session.meta":
      return null;
    case "diagnostics.memwatch":
      return command.action === "start"
        ? { enabled: true, started_at_ms: Date.now() }
        : { enabled: false };
    case "diagnostics.dump":
      return simMemorySnapshot();
    default:
      throw new Error(`command not allowed in fixture: ${String(command.type)}`);
  }
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
      return {
        status: "completed",
        command_id: "fixture-command",
        result: hostCommand((args.command ?? {}) as Record<string, unknown>),
      };
    }
    if (cmd === "skills_user_scan") return structuredClone(userSkillsFixture);
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
