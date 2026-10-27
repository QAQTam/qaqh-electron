/** 本地 dev-only 视觉验收：使用真实 StepRow，不连接 daemon。 */
import { render } from "@solidjs/web";
import { createSignal, For } from "solid-js";
import { StepRow } from "./tools/StepRow";
import { applyTheme } from "./lib/theme";
import type { ToolStep, Turn } from "./session/types";
import "./styles/app.css";

const params = new URLSearchParams(location.search);
applyTheme(params.get("theme") === "dark" ? "dark" : "light");
const source = Array.from({ length: 100 }, (_, i) => `// 第 ${i + 1} 行\nconst permission_${i} = "workspace";`).join("\n");
const log = Array.from({ length: 180 }, (_, i) => `\u001b[32mtest ${i}: ok\u001b[0m`).join("\n");
const [steps, setSteps] = createSignal<ToolStep[]>([
  { kind: "tool", id: "exec", seq: 1, name: "exec", status: "success", argsJson: JSON.stringify({ command: "cargo test -p qaqh-runtime -- --nocapture", cwd: "E:/qaqh-backend" }), output: { text: log, stderr: "warning: unused variable", exitCode: 0 } },
  { kind: "tool", id: "read", seq: 2, name: "read", status: "success", argsJson: JSON.stringify({ path: "crates/qaqh-policy/src/lib.rs", limit: 200 }), output: { text: source } },
  { kind: "tool", id: "edit", seq: 3, name: "edit", status: "error", argsJson: JSON.stringify({ path: "E:/qaqh-backend/crates/qaqh-policy/src/lib.rs", old_str: source, new_str: source.replaceAll("workspace", "sandbox") }), error: "锚点未唯一匹配，文件未修改。", output: { text: "No changes applied." } },
  { kind: "tool", id: "diff", seq: 4, name: "edit", status: "success", argsJson: JSON.stringify({ path: "src/policy.ts", old_str: "const level = 2;", new_str: "const level = 4;" }), display: { lines_added: 1, lines_removed: 1 }, output: { diffText: "--- a/src/policy.ts\n+++ b/src/policy.ts\n@@ -1 +1 @@\n-const level = 2;\n+const level = 4;" } },
  { kind: "tool", id: "mcp", seq: 5, name: "mcp__workspace__inspect", status: "success", argsJson: JSON.stringify({ payload: source }), output: { text: source } },
  { kind: "tool", id: "live", seq: 6, name: "exec_command", status: "running", startedAt: Date.now(), argsJson: JSON.stringify({ command: "pnpm run build" }), progressTail: "vite: building renderer…", progressTruncated: true },
  { kind: "tool", id: "todo", seq: 7, name: "todo_write", status: "success", argsJson: JSON.stringify({ items: [
    { title: "梳理渲染分层", status: "completed", evidence: "typecheck 通过" },
    { title: "实现 todo 卡片", status: "completed" },
    { title: "接入深浅主题", status: "in_progress" },
    { title: "待评审的交互细节", status: "pending" },
    { title: "已放弃的旧方案", status: "cancelled" },
  ] }), output: { text: "{\"receipt\":\"internal\"}" } },
  { kind: "tool", id: "skill", seq: 8, name: "skill_activate", status: "success", argsJson: JSON.stringify({ name: "mc-source-driven-mod" }), output: { text: source } },
  { kind: "tool", id: "skill-read", seq: 9, name: "read", status: "success", argsJson: JSON.stringify({ path: "C:/Users/test/.agents/skills/example/SKILL.md" }), output: { text: source } },
]);
const turn = { id: "fixture", key: "fixture", turnIndex: 0, user: { text: "工具渲染验收" }, steps: [], answer: null, answerStepId: null, status: "running", expanded: true } satisfies Turn;
declare global { interface Window { __toolRenderCheck: { finish: () => void } } }
window.__toolRenderCheck = {
  finish: () => setSteps((items) => items.map((step) => step.id === "live" ? { ...step, status: "success", output: { text: "build complete", stderr: "final warning", exitCode: 0 } } : step)),
};
render(() => (
  <main style={{ "max-width": "780px", margin: "36px auto", padding: "0 20px" }}>
    <h2 style={{ "font-size": "16px", "font-weight": "500", "margin-bottom": "16px" }}>工具工作记录</h2>
    <p style={{ color: "var(--muted)", "font-size": "13px", "margin-bottom": "14px" }}>文件路径与修改结果 · 命令实时输出 · 待办与 skills 记录</p>
    <div class="timeline turn-steps"><For each={steps()} keyed={(step) => step.id}>{(step, index) => <StepRow step={step()} turn={turn} cwd="E:/qaqh-backend" isLatest={index() === steps().length - 1} />}</For></div>
  </main>
), document.getElementById("root")!);
