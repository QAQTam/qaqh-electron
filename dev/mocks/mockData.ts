// Mock 会话数据 — 视觉验收用。类型全部来自 SDK bindings（禁手写协议字段）。
import type {
  TimelineBlock,
  TimelineSnapshot,
  TimelineTurn,
  ToolResult,
} from "qaqh-js-sdk";

export interface MockPermission {
  toolCallId: string;
  toolName: string;
  reason: string;
  paths: string[];
  category: string;
  level: number;
  risk: string;
  consequence: string;
}

export interface MockAsk {
  interactionId: string;
  questions: Array<{ id: string; question: string; options?: string[]; allow_custom: boolean }>;
}

export interface MockSession {
  seed: string;
  title: string;
  cwd: string;
  model: string;
  mode: number;
  activity: "starting" | "idle" | "working" | "waiting_user" | "disconnected";
  contextUsed: number;
  contextLimit: number;
  snapshot: TimelineSnapshot;
  pendingPermission?: MockPermission;
  ask?: MockAsk;
}

const seedA = "9f21c4a7e3d84b56a0c2f1e8d7b64a93";
const seedB = "c2d80e51f7a94b3d8e60b9a17c45f2d8";
const seedC = "4b7a1f92e5c34d68b1a09f7e3d25c841";

const block = (o: Partial<TimelineBlock> & { block_order: number; kind: TimelineBlock["kind"] }): TimelineBlock => ({
  block_id: `blk-${o.block_order}`,
  state: "sealed",
  ...o,
} as TimelineBlock);

function toolResult(status: ToolResult["status"], summary: string, extra?: Partial<ToolResult>): ToolResult {
  return {
    status,
    summary,
    data: null,
    model: { text: "", truncated: false, total_tokens: 0 },
    ...extra,
  };
}
void toolResult;

function turnBase(turnId: string, createdSeq: number, userText: string): TimelineTurn {
  return {
    turn_id: turnId,
    created_seq: createdSeq,
    user_text: userText,
    sealed: true,
    state: "completed",
    failure: null,
    rounds: [],
  };
}

// ── 会话 A：完整体验（多轮 + 工具 + diff + reasoning + 审批） ──
const turnA1 = turnBase("t1", 1, "帮我看看 src/parser.ts 里的 tokenizer 有没有性能问题");
turnA1.rounds = [
  {
    round_num: 1,
    sealed: true,
    is_final: false,
    blocks: [
      block({
        block_order: 0,
        kind: "reasoning",
        text: "用户怀疑 tokenizer 有性能问题。先读一下这个文件，统计行数和热点函数，重点看正则和字符串拼接的部分。",
      }),
      block({
        block_order: 1,
        kind: "tool",
        tool: {
          tool_call_id: "tc1",
          name: "read_file",
          state: "succeeded",
          summary: "src/parser.ts · 412 行",
          args_json: '{"path":"src/parser.ts","offset":1,"limit":120}',
          output:
            "import { Token } from './types';\n\nexport function tokenize(src: string): Token[] {\n  const out: Token[] = [];\n  let i = 0;\n  while (i < src.length) {\n    const ch = src[i];\n    // 每个字符都走一遍完整正则链\n    for (const re of TOKEN_REGEXES) {\n      const m = re.exec(src.slice(i));\n      …\n    }\n  }\n  return out;\n}",
          diff: null,
          progress: undefined,
          failure: null,
          permission: null,
        },
      }),
      block({
        block_order: 2,
        kind: "text",
        text: "读完前 120 行，`tokenize` 对每个字符执行 `src.slice(i)`，这是 O(n²) 的根源。我继续看 `TOKEN_REGEXES` 的定义和调用频次。",
      }),
    ],
  },
  {
    round_num: 2,
    sealed: true,
    is_final: true,
    blocks: [
      block({
        block_order: 0,
        kind: "text",
        text:
          "**确认了两处性能问题：**\n\n1. `src.slice(i)` 在主循环里产生 O(n²) 内存拷贝 —— 412 行的文件在 10k tokens 输入下分配约 50MB 中间字符串。\n2. 正则链没有按首字符分派，每个字符最多尝试 14 个正则。\n\n修复建议：\n\n```ts\n// 用 lastIndex + sticky 正则避免 slice\nconst re = new RegExp(pattern, \"ys\");\nre.lastIndex = i;\nconst m = re.exec(src);\n```\n\n按首字符建分派表后，单次 tokenize 从 220ms 降到 18ms（-92%）。要我直接改吗？",
      }),
      block({
        block_order: 1,
        kind: "tool",
        tool: {
          tool_call_id: "tc2",
          name: "edit_file",
          state: "succeeded",
          summary: "src/parser.ts +38 −12",
          args_json: '{"path":"src/parser.ts","mode":"replace"}',
          output: null,
          diff:
            "diff --git a/src/parser.ts b/src/parser.ts\n--- a/src/parser.ts\n+++ b/src/parser.ts\n@@ -18,9 +18,21 @@ export function tokenize(src: string): Token[] {\n-  while (i < src.length) {\n-    const ch = src[i];\n-    for (const re of TOKEN_REGEXES) {\n-      const m = re.exec(src.slice(i));\n+  const byFirst = buildDispatchTable(TOKEN_REGEXES);\n+  while (i < src.length) {\n+    const ch = src[i];\n+    const candidates = byFirst.get(ch) ?? FALLBACK;\n+    for (const re of candidates) {\n+      re.lastIndex = i;\n+      const m = re.exec(src);",
          progress: undefined,
          failure: null,
          permission: null,
        },
      }),
    ],
  },
];

const turnA2 = turnBase("t2", 2, "好，直接改吧，改完跑一下基准测试对比");
turnA2.rounds = [
  {
    round_num: 1,
    sealed: true,
    is_final: false,
    blocks: [
      block({
        block_order: 0,
        kind: "text",
        text: "开始改造 `tokenize` 并补一个分派表构建函数，然后跑 `cargo bench` 对比。",
      }),
    ],
  },
  {
    round_num: 2,
    sealed: false,
    is_final: true,
    blocks: [
      block({
        block_order: 0,
        kind: "tool",
        tool: {
          tool_call_id: "tc3",
          name: "bash",
          state: "running",
          summary: "cargo bench --bench tokenizer",
          args_json: '{"command":"cargo bench --bench tokenizer","timeout":120}',
          output: "running 6 tests\ntest tokenize::bench_10k … ",
          diff: null,
          progress: "42%",
          failure: null,
          permission: null,
        },
      }),
      block({
        block_order: 1,
        kind: "text",
        state: "open",
        text: "基准测试进行中。10k 输入下初步数据：旧实现 220ms，新实现 19.2ms，等完整报告出来后我汇总对比表。",
      }),
    ],
  },
];
turnA2.sealed = false;
turnA2.state = "running";

const sessionA: MockSession = {
  seed: seedA,
  title: "tokenizer 性能分析与修复",
  cwd: "/home/qaqtamsy/Projects/qaqh-parser",
  model: "glm-4.7-flash",
  mode: 0,
  activity: "working",
  contextUsed: 61_440,
  contextLimit: 200_000,
  snapshot: { watermark: 12, turns: [turnA1, turnA2] },
  pendingPermission: {
    toolCallId: "tc4",
    toolName: "bash",
    reason: "需要执行 git push 将修复推送到远端分支 perf/tokenizer",
    paths: ["/home/qaqtamsy/Projects/qaqh-parser"],
    category: "network",
    level: 2,
    risk: "medium",
    consequence: "推送 2 个提交到 origin/perf/tokenizer",
  },
};

// ── 会话 B：Ask 问卷 + 失败轮 ──
const turnB1 = turnBase("t1", 1, "把发布流程改成从 GitHub Actions 触发");
turnB1.rounds = [
  {
    round_num: 1,
    sealed: true,
    is_final: true,
    blocks: [
      block({
        block_order: 0,
        kind: "reasoning",
        text: "用户想把发布流程迁移到 GitHub Actions。需要确认触发方式：tag 推送还是手动 workflow_dispatch。这决定 workflow 文件的结构。",
      }),
      block({
        block_order: 1,
        kind: "text",
        text: "在动手前我需要确认几个关键点：",
      }),
      block({
        block_order: 2,
        kind: "notice",
        text: "等待用户回答问卷（interaction_requested）",
      }),
    ],
  },
];

const turnB2: TimelineTurn = {
  turn_id: "t2",
  created_seq: 2,
  user_text: "上一次构建为什么失败了",
  sealed: true,
  state: "failed",
  failure: { code: "provider_unavailable", message: "上游模型服务 503，重试 3 次后放弃" },
  rounds: [
    {
      round_num: 1,
      sealed: true,
      is_final: true,
      blocks: [
        block({
          block_order: 0,
          kind: "tool",
          tool: {
            tool_call_id: "tc5",
            name: "read_file",
            state: "failed",
            summary: ".github/workflows/release.yml",
            args_json: '{"path":".github/workflows/release.yml"}',
            output: null,
            diff: null,
            progress: undefined,
            failure: { code: "provider_unavailable", message: "上游模型服务 503，重试 3 次后放弃" },
            permission: null,
          },
        }),
      ],
    },
  ],
};

const sessionB: MockSession = {
  seed: seedB,
  title: "发布流程迁移 GitHub Actions",
  cwd: "/home/qaqtamsy/Projects/qaqh-release-infra/deploy",
  model: "glm-4.7-flash",
  mode: 1,
  activity: "waiting_user",
  contextUsed: 18_000,
  contextLimit: 200_000,
  snapshot: { watermark: 4, turns: [turnB1, turnB2] },
  ask: {
    interactionId: "ix1",
    questions: [
      {
        id: "q1",
        question: "**发布触发方式**用哪种？",
        options: ["tag 推送自动触发", "手动 workflow_dispatch", "两者都要"],
        allow_custom: true,
      },
      {
        id: "q2",
        question: "构建产物要推到哪个 registry？",
        options: ["ghcr.io", "Docker Hub"],
        allow_custom: true,
      },
    ],
  },
};

// ── 会话 C：新建空会话 ──
const sessionC: MockSession = {
  seed: seedC,
  title: "未命名会话",
  cwd: "/home/qaqtamsy/Projects/qaqh-electron",
  model: "glm-4.7-flash",
  mode: 0,
  activity: "idle",
  contextUsed: 0,
  contextLimit: 200_000,
  snapshot: { watermark: 0, turns: [] },
};

// ── 归档会话（⌘K 可见） ──
export const archivedSession: MockSession = {
  seed: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
  title: "旧版 CLI 参数迁移调查",
  cwd: "/home/qaqtamsy/Projects/qaqh-cli",
  model: "glm-4.5",
  mode: 0,
  activity: "idle",
  contextUsed: 0,
  contextLimit: 0,
  snapshot: { watermark: 0, turns: [] },
};

export const MOCK_SESSIONS: MockSession[] = [sessionA, sessionB, sessionC];

export const MOCK_RAW_EVENTS: string[] = [
  "conversation · turn_started · t1 · seq=3",
  "tool · tool_call_prepared · tc1 read_file · seq=4",
  "tool · tool_finished · tc1 ok · seq=5",
  "conversation · text_delta · blk2 · seq=6 (+120 chars)",
  "tool · code_changed · tc2 src/parser.ts +38 −12 · seq=9",
  "conversation · turn_sealed · t1 completed · seq=10",
  "control · session_activity_changed · working · seq=11",
  "tool · tool_permission_requested · tc4 bash · seq=12",
];
