/**
 * 开发夹具:真实 `App` + 假宿主 IPC,在浏览器里跑设置浮层的读写语义。
 *
 * 为什么要有它:设置页的唯一通路是 Tauri 的 `service_rpc` 白名单,浏览器里既没有
 * daemon 也没有宿主。这里把宿主替身做成「白名单式」的——只认宿主真允许的方法,
 * 其余抛错,于是 fixture 里能验的是语义而不是便利:`config.save` 收到什么 patch,
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

type RpcCall = { method: string; params: Record<string, unknown> };

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
  tokenizerPath: null,
});

const probe = {
  calls: [] as RpcCall[],
  saves: [] as Record<string, unknown>[],
  config: baseConfig(),
  /** 置 true 后 LAN 重启请求返回 `daemon_busy`,用来走查强制重启确认面板。 */
  lanBusy: false,
};

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
 * 用户级 skills 夹具(`skills_user_scan` 的回包形状,见 `src-tauri/src/skills.rs`)。
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

function serviceRpc(method: string, params: Record<string, unknown>): unknown {
  probe.calls.push({ method, params });
  switch (method) {
    case "config.load":
      return structuredClone(probe.config);
    case "config.save":
      probe.saves.push(structuredClone(params));
      applyMergePatch(probe.config, params);
      return null;
    case "profile.save_current":
      if (!probe.config.profiles.includes(String(params.name))) {
        probe.config.profiles = [...probe.config.profiles, String(params.name)];
      }
      return null;
    case "profile.apply":
      probe.config.activeProfile = String(params.name);
      return null;
    case "profile.delete":
      probe.config.profiles = probe.config.profiles.filter((name) => name !== String(params.name));
      return null;
    // 与宿主白名单同调(commands.rs:SERVICE_METHODS):这几条现在是真的放行的方法,
    // 夹具不接就等于替真宿主放行它不曾放行过的东西——快照用 memwatch-sim 造。
    case "daemon.version":
      return "0.0.0-fixture";
    case "session.list":
      return [];
    case "workspace.list":
      // 裸数组(service.rs:417 `Ok(Value::Array(items))`),与 `todo.list` 的
      // `{ items }` 不同形;侧栏按数组直接 `.map`,给成对象会当场halt掉反应式系统。
      return [projectWorkspace, ...multiWorkspaces];
    // 项目级 skills 走 daemon 的 fs.*(宿主白名单放行,commands.rs:SERVICE_METHODS)。
    case "fs.list": {
      const entries = projectFs[String(params.path)];
      if (entries == null) throw new Error(`fs.list ${String(params.path)}: 系统找不到指定的文件。(fixture)`);
      return entries;
    }
    case "fs.read": {
      const content = projectFiles[String(params.path)];
      if (content == null) throw new Error(`fs.read ${String(params.path)}: 系统找不到指定的文件。(fixture)`);
      return { path: params.path, size: content.length, truncated: false, content };
    }
    // `?dev=1` 会真开一个标签,store 激活时按宿主白名单拉待办;夹具缺这条就会刷一条
    // 告警出来(真宿主放行,见 commands.rs:SERVICE_METHODS)。
    case "todo.list":
      return { items: [] };
    case "diagnostics.memory.start":
      return { enabled: true, started_at_ms: Date.now() };
    case "diagnostics.memory.stop":
      return { enabled: false };
    case "diagnostics.memory.snapshot":
      return simMemorySnapshot(typeof params.after_sequence === "number" ? params.after_sequence : null);
    default:
      // 宿主白名单(commands.rs 的 SERVICE_METHODS)之外的方法在这里也必须失败,
      // 否则夹具会替真实宿主放行它不曾放行的东西。
      throw new Error(`service method not allowed in fixture: ${method}`);
  }
}

/**
 * 假宿主的 daemon 局域网面:字段与 `src-tauri/src/lan.rs` 的 lan_view 同形。
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
  daemon_version: "2.0.0-beta.3",
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
    if (cmd === "service_rpc") return serviceRpc(String(args.method), (args.params ?? {}) as Record<string, unknown>);
    if (cmd === "skills_user_scan") return structuredClone(userSkillsFixture);
    if (cmd === "session_list") return [];
    if (cmd === "timeline_status") return null;
    if (cmd === "daemon_lan_status") return lanView();
    if (cmd === "daemon_lan_enable") return lanEnable(String(args.bindIp ?? ""), (args.port as number | null | undefined) ?? null);
    if (cmd === "daemon_lan_disable") return lanDisable();
    if (cmd === "pairing_create") return pairingTicket();
    if (cmd === "app_version") {
      return { version: "2.0.0-beta.4", commit: "fixture0", display: "2.0.0-beta.4-fixture0" };
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
    __TAURI_INTERNALS__?: unknown;
    __qaqhProbe?: typeof probe;
  }
}

window.__TAURI_INTERNALS__ = internals;
window.__qaqhProbe = probe;

const root = document.getElementById("root");
if (root != null) render(() => <App />, root);

/**
 * `?dev=1`:给开发者控制台铺一层「可拍的真状态」——开一个假会话标签(活动面板就
 * 有 store 可读)、打开设置、并解锁控制台。默认不开:既有断言与基线都不受影响。
 * 走的是真 `App` + 真 `TauriTransport`,所以事件流面板在这里能看到埋点真的记到了
 * 收发(stress.tsx 那条路把 `transport.rpc` 整个替掉了,绕过埋点)。
 */
const devHarness = new URLSearchParams(window.location.search).get("dev") === "1";
if (devHarness) {
  void openSession("seed_dev_preview");
  void openSettings();
  openDevConsole();
}
