/** 本地 dev-only 视觉验收:ask 走居中模态(#approval-slot),不连接 daemon。 */
import { render } from "@solidjs/web";
import { createSignal, Show } from "solid-js";
import { ApprovalStack } from "./approval/ApprovalCards";
import { applyTheme } from "./lib/theme";
import { STR } from "./lib/strings";
import type { ApprovalView } from "./lib/transport";
import "./styles/app.css";

const params = new URLSearchParams(location.search);
applyTheme(params.get("theme") === "dark" ? "dark" : "light");
// `?ttl=1` 用来验失效态:challenge 的 TTL 是真的会到期的,不能只画活着的那一帧。
const ttl = Number(params.get("ttl") ?? 292);
// `?shape=bare` 验极值:没有选项的问题只剩自由作答,输入框该直接摊开而不是先点一下「其它」。
const bare = params.get("shape") === "bare";

// 问题与选项取自 ~/.qaqh/ringing/content 里真实落盘的一次 ask(3 问 batch、
// 选项 p50=22 字/最长 50 字),不是编出来的短示意——截断与换行只有真数据能验。
const askViews: ApprovalView[] = [
  {
    challenge_id: "ask-1", kind: "ask", expires_in: ttl, details: { mode: "batch", questions: [
      { id: "invalidation", question: "「401/40003 → 清凭据 + session-expired」这条链在仓里不存在（SIWC 也一样缺，是既有缺口）。怎么处理？", options: ["另立项，暂不动（推荐：SIWC 也缺，一起做才对称）", "现在就补：两条路由一起接（gate 错误路径分类 → 失效即清 + 一帧可展示提示）", "只给 DeepSeek 账号补（我接受不对称）"], allow_custom: true },
      { id: "housekeeping", question: "两件收尾小事：前端 `.qaqh/` 要不要加 .gitignore？探针脚本要不要入库？", options: ["加进前端 .gitignore（推荐）", "不加，我来处理", "连两条探针脚本 + 注销脚本一起入库（我建议只留前两个，注销脚本是一次性善后）"], allow_custom: true },
      { id: "commit", question: "现在统一提交吗？", options: ["现在提交：后端 / 前端各一个提交", "先别提交，我自己看一遍再说"], allow_custom: false },
    ] },
  },
  { challenge_id: "ask-2", kind: "ask", expires_in: Math.max(0, ttl - 52), details: { mode: "batch", questions: [{ id: "q3", question: "第二组问题(尚未展示)", options: ["甲", "乙"] }] } },
];
const permView: ApprovalView = { challenge_id: "perm-1", kind: "tool_permission", expires_in: 0, details: { tool_name: "exec", action_summary: "运行构建", risk: "medium", level: 2, category: "shell", reason: "写 out/ 目录" } };

const [last, setLast] = createSignal("（尚未提交）");
const [showPerm, setShowPerm] = createSignal(false);
const bareViews: ApprovalView[] = [{
  challenge_id: "ask-bare", kind: "ask", expires_in: ttl, details: { mode: "single", questions: [
    { id: "note", question: "这份改动我按你的口径落地，最后还有什么要交代的？", options: [], allow_custom: true },
  ] },
}];
const respond = async (challengeId: string, decision: string, payload?: Record<string, unknown>): Promise<void> => {
  setLast(JSON.stringify({ challengeId, decision, payload }));
};

render(() => (
  <main style={{ "max-width": "760px", margin: "36px auto", padding: "0 20px", display: "grid", gap: "18px" }}>
    <h2 style={{ "font-size": "16px", "font-weight": "500", margin: "0" }}>ask 居中模态</h2>
    <p style={{ color: "var(--muted)", "font-size": "13px", margin: "0" }}>
      授权/计划评审/AskUser 共用同一个遮罩栈;只展示最早一个 challenge。
    </p>
    <ApprovalStack
      pending={bare ? bareViews : showPerm() ? [permView, ...askViews] : askViews}
      respond={respond}
      refresh={async () => {
        setLast(JSON.stringify({ refreshed: true }));
      }}
    />
    <div
      class="ask-check-last"
      data-last-submit={last()}
      data-expected-more={STR.morePending(1)}
      data-expected-required={STR.askAnswerRequired}
      data-expected-refresh={STR.askRefresh}
    >
      {last()}
    </div>
    <Show when={!showPerm()}>
      <button type="button" id="ask-check-show-perm" onClick={() => setShowPerm(true)}>注入模态授权</button>
    </Show>
  </main>
), document.getElementById("root")!);
