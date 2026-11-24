/**
 * 文件引用侧栏：点击正文里的 `path:line` 后从右侧展开代码预览。
 *
 * 数据来源只有既有 `fs.read` service 查询（带 scope_session_id 锁工作区），
 * 高亮复用 diff 的 shiki 单例；不引入新命令、不写协议转换层。
 */
import { createEffect, createMemo, createSignal, For, Show, type Component } from "solid-js";
import { transport } from "../lib/transport";
import { resolvedTheme } from "../lib/theme";
import { syntaxPackRef } from "../plugins/loader";
import { highlight } from "../diff/highlight";
import { languageOf } from "../diff/parse";
import { activeTab, sessionCatalog } from "../tabs/store";
import { closeFileRef, fileRefTarget } from "../markdown/fileRefStore";
import type { FileRefTarget } from "../markdown/fileRefStore";
import type { FsReadResult } from "../api/qaqh/FsReadResult";

interface LoadedFile {
  title: string;
  path: string;
  content: string;
  truncated: boolean;
  rows: Array<Array<{ content: string; color?: string }>>;
}

function resolvePath(raw: string, cwd: string | null | undefined): string {
  if (/^(?:[a-zA-Z]:[\\/]|\/)/.test(raw)) return raw;
  const clean = raw.replace(/^\.\//, "");
  if (!cwd) return clean;
  const sep = cwd.includes("\\") ? "\\" : "/";
  return cwd.replace(/[\\/]+$/, "") + sep + clean;
}

export const CodePreviewDrawer: Component = () => {
  const [loaded, setLoaded] = createSignal<LoadedFile | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  let scrollHost: HTMLDivElement | undefined;

  const sessionId = () => activeTab()?.seed ?? "";
  const cwd = () => sessionCatalog().find((s) => s.session_id === sessionId())?.cwd ?? null;

  const load = async (target: FileRefTarget): Promise<void> => {
    const fullPath = resolvePath(target.path, cwd());
    setLoaded(null);
    setError(null);
    setBusy(true);
    try {
      const result = await transport.query("fs.read", {
        path: fullPath,
        max_bytes: 512 * 1024,
        ...(sessionId() !== "" ? { scope_session_id: sessionId() } : {}),
      }) as FsReadResult;
      const source = result.content.split(/\r?\n/);
      let tokens: Array<Array<{ content: string; color?: string }>> | null = null;
      const lang = languageOf(fullPath);
      if (lang != null) {
        try {
          tokens = await highlight(result.content, lang, resolvedTheme(), syntaxPackRef());
        } catch {
          tokens = null;
        }
      }
      const rows = tokens != null && tokens.length === source.length
        ? tokens
        : source.map((line) => [{ content: line }]);
      setLoaded({ title: target.path, path: fullPath, content: result.content, truncated: result.truncated, rows });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  createEffect(
    () => fileRefTarget(),
    (target) => {
      if (target != null) void load(target);
    },
  );

  createEffect(
    () => [fileRefTarget()?.line, loaded()] as const,
    () => {
      const line = fileRefTarget()?.line;
      if (line == null || loaded() == null) return;
      requestAnimationFrame(() => {
        scrollHost?.querySelector<HTMLElement>(`[data-line="${line}"]`)?.scrollIntoView({ block: "center" });
      });
    },
  );

  createEffect(
    () => fileRefTarget() != null,
    (open) => {
      if (!open) return;
      const onKey = (event: KeyboardEvent): void => {
        if (event.key === "Escape") closeFileRef();
      };
      window.addEventListener("keydown", onKey);
      return (): void => window.removeEventListener("keydown", onKey);
    },
  );

  const lineCount = createMemo(() => loaded()?.rows.length ?? 0);

  return (
    <Show when={fileRefTarget() != null}>
      <div
        class="code-preview-backdrop"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeFileRef();
        }}
      >
        <aside class="code-preview-panel" aria-label="代码定位">
          <header class="code-preview-header">
            <div class="code-preview-heading">
              <span class="code-preview-kicker">代码定位</span>
              <strong class="code-preview-path">
                {fileRefTarget()!.path}{fileRefTarget()!.line != null ? `:${fileRefTarget()!.line}` : ""}
              </strong>
            </div>
            <button type="button" class="code-preview-close" aria-label="关闭代码预览" onClick={() => closeFileRef()}>
              ✕
            </button>
          </header>

          <Show when={busy()}>
            <div class="code-preview-state">读取文件中…</div>
          </Show>
          <Show when={error() != null}>
            <div class="code-preview-state">读取失败：{error()}</div>
          </Show>
          <Show when={lineCount() > 0}>
            <div class="code-preview-scroll" ref={scrollHost}>
              <For each={loaded()!.rows}>
                {(row, index) => (
                  <div
                    class={{ "code-preview-line": true, focused: index() + 1 === fileRefTarget()?.line }}
                    data-line={index() + 1}
                  >
                    <span class="code-preview-ln">{index() + 1}</span>
                    <span class="code-preview-code"><For each={row}>{(tok) => <span style={{ color: tok.color }}>{tok.content}</span>}</For></span>
                  </div>
                )}
              </For>
            </div>
          </Show>
          <Show when={loaded()?.truncated === true}>
            <div class="code-preview-truncated">文件过大，仅显示前 512KB。</div>
          </Show>
        </aside>
      </div>
    </Show>
  );
};
