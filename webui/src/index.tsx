import { render } from "@solidjs/web";
import { Errored } from "solid-js";
import App from "./app/App";
import { markPlatform } from "./lib/platform";
import "./lib/typography";

markPlatform();

/**
 * 壳级故障隔离边界。
 *
 * 后端不可达是合法运行态——各域有自己的 offline 降级(连接 banner / 设置错误态 /
 * 会话 offline)。这里兜的是**渲染期意外**:任何域的组件抛错都不该把整棵 Solid 树
 * 卸载成白屏(此前裸 render 无边界,一处渲染异常即全屏空白)。给出可恢复出口,
 * 而不是让用户对着白屏猜。
 */
function ShellCrash(props: { error: unknown; reset: () => void }) {
  const message = props.error instanceof Error ? props.error.message : String(props.error);
  return (
    <div
      role="alert"
      style={{
        display: "flex",
        "flex-direction": "column",
        gap: "12px",
        "align-items": "flex-start",
        "justify-content": "center",
        height: "100vh",
        padding: "32px",
        "box-sizing": "border-box",
        color: "var(--qqh-fg, #e6e6e6)",
        background: "var(--qqh-bg, #1e1e1e)",
        font: "14px/1.6 var(--qqh-font, system-ui)",
      }}
    >
      <h1 style={{ margin: 0, "font-size": "18px" }}>界面遇到意外错误</h1>
      <p style={{ margin: 0, opacity: 0.8, "word-break": "break-word" }}>{message}</p>
      <div style={{ display: "flex", gap: "8px" }}>
        <button type="button" class="primary-mini button-primary" onClick={() => props.reset()}>
          重试
        </button>
        <button type="button" class="ghost-mini" onClick={() => location.reload()}>
          重载壳
        </button>
      </div>
    </div>
  );
}

render(
  () => (
    <Errored fallback={(err, reset) => <ShellCrash error={err()} reset={reset} />}>
      <App />
    </Errored>
  ),
  document.getElementById("root")!,
);