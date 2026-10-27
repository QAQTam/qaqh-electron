/**
 * Diff 审查抽屉工作台 (spec §9 / 对齐截图 222205 沉浸式审查画板)
 * 
 * 性能与零掉帧防护纪律:
 * 1. 物理卸载: diffReviewStore.state().isOpen 为 false 时整棵子树不挂载。
 * 2. 动画-渲染时间片错峰: 抽屉从右侧滑入的 200ms 内只展示极轻量 Skeleton，
 *    GPU Compositor 线程以 120 FPS 满帧推进，动画结束后再点亮虚拟开窗 DiffView。
 * 3. 内存隔离: 切换文件与查看均通过 diffReviewStore 的有界 LRU 缓存，抽屉关闭即清零。
 */
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
  type Component,
} from "solid-js";
import IconX from "~icons/lucide/x";
import IconChevronLeft from "~icons/lucide/chevron-left";
import IconChevronRight from "~icons/lucide/chevron-right";
import IconCopy from "~icons/lucide/copy";
import IconFileCode from "~icons/lucide/file-code";
import { diffReviewStore } from "./review-store";
import { DiffFileView } from "./DiffView";
import type { DeliverableFileSummary } from "./deliverables";

export const DiffReviewDrawer: Component = () => {
  const state = () => diffReviewStore.state();
  const [filterQuery, setFilterQuery] = createSignal("");
  const [animReady, setAnimReady] = createSignal(false);
  const [copied, setCopied] = createSignal(false);

  // 动画-渲染解耦：打开时延后一拍点亮重度视图，确保滑入动画 120 FPS
  createEffect(
    () => state().isOpen,
    (isOpen) => {
      setAnimReady(false);
      if (!isOpen) return undefined;
      setFilterQuery("");
      // 等待 200ms 滑入 CSS 动画落地后再挂载虚拟开窗 DOM。
      // effect 的 apply 作用域里 `onCleanup` 注册等于永不执行(rc.13 NO_OWNER_CLEANUP),
      // 必须**返回**清理函数才会挂到下一次运行/销毁上——否则迟到的 timer 会写进
      // 已经关掉的抽屉。
      const timer = setTimeout(() => setAnimReady(true), 200);
      return (): void => clearTimeout(timer);
    }
  );

  // 全局 Escape 键快捷关闭抽屉 & 上下左右键盘快速切换
  const handleKeyDown = (e: KeyboardEvent) => {
    if (!state().isOpen) return;
    if (e.key === "Escape") {
      e.preventDefault();
      diffReviewStore.close();
    } else if ((e.ctrlKey || e.metaKey) && (e.key === "ArrowLeft" || e.key === "ArrowUp")) {
      e.preventDefault();
      diffReviewStore.navigateFile(-1);
    } else if ((e.ctrlKey || e.metaKey) && (e.key === "ArrowRight" || e.key === "ArrowDown")) {
      e.preventDefault();
      diffReviewStore.navigateFile(1);
    }
  };

  createEffect(
    () => state().isOpen,
    (isOpen) => {
      if (!isOpen) return undefined;
      window.addEventListener("keydown", handleKeyDown);
      // 同上:返回清理函数才会真的解绑,否则每开一次抽屉就多挂一个 keydown 监听。
      return (): void => window.removeEventListener("keydown", handleKeyDown);
    }
  );

  const files = createMemo(() => state().deliverables?.files ?? []);

  const filteredFiles = createMemo(() => {
    const q = filterQuery().trim().toLowerCase();
    if (!q) return files();
    return files().filter((f) => f.path.toLowerCase().includes(q));
  });

  const activeSummary = createMemo<DeliverableFileSummary | undefined>(() => {
    const current = state().activeFilePath;
    if (!current) return undefined;
    return files().find((f) => f.path === current);
  });

  const activeParsed = createMemo(() => {
    if (!animReady() || !state().isOpen) return null;
    return diffReviewStore.getActiveFileParsed();
  });

  const handleCopyPath = () => {
    const p = state().activeFilePath;
    if (!p) return;
    void navigator.clipboard.writeText(p).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  const statusLabel = (status: DeliverableFileSummary["status"]): string => {
    switch (status) {
      case "added":
        return "A";
      case "deleted":
        return "D";
      case "renamed":
        return "R";
      case "modified":
      default:
        return "M";
    }
  };

  return (
    <Show when={state().isOpen}>
      <div
        class="diff-drawer-backdrop"
        onClick={(e) => {
          if (e.target === e.currentTarget) {
            diffReviewStore.close();
          }
        }}
        role="presentation"
      >
        <aside
          class="diff-drawer-panel"
          role="dialog"
          aria-modal="true"
          aria-label="改动审查抽屉"
        >
          {/* 顶栏控制栏 */}
          <header class="diff-drawer-header">
            <div class="diff-drawer-header-left">
              <span class="diff-drawer-title">改动审查</span>
              <span class="deliverables-stat-rollup">
                <Show when={(state().deliverables?.totalAdditions ?? 0) > 0}>
                  <b class="deliverables-stat-add">+{state().deliverables?.totalAdditions}</b>
                </Show>
                <Show when={(state().deliverables?.totalDeletions ?? 0) > 0}>
                  <b class="deliverables-stat-del">−{state().deliverables?.totalDeletions}</b>
                </Show>
              </span>
              <div class="diff-drawer-nav-group">
                <button
                  type="button"
                  class="diff-drawer-nav-btn"
                  title="上一个文件 (Ctrl+Left)"
                  onClick={() => diffReviewStore.navigateFile(-1)}
                >
                  <IconChevronLeft />
                </button>
                <button
                  type="button"
                  class="diff-drawer-nav-btn"
                  title="下一个文件 (Ctrl+Right)"
                  onClick={() => diffReviewStore.navigateFile(1)}
                >
                  <IconChevronRight />
                </button>
              </div>
            </div>

            <button
              type="button"
              class="diff-drawer-close-btn"
              title="关闭抽屉 (Esc)"
              onClick={() => diffReviewStore.close()}
            >
              <IconX />
            </button>
          </header>

          {/* 抽屉左右分栏双区 */}
          <div class="diff-drawer-body">
            {/* 左侧文件导航列表 */}
            <div class="diff-drawer-sidebar">
              <div class="diff-drawer-filter">
                <input
                  type="text"
                  class="diff-drawer-input"
                  placeholder="过滤文件..."
                  value={filterQuery()}
                  onInput={(e) => setFilterQuery(e.currentTarget.value)}
                />
              </div>

              <div class="diff-drawer-file-nav" role="list">
                <For each={filteredFiles()}>
                  {(file) => (
                    <div
                      class={{
                        "diff-drawer-file-row": true,
                        active: state().activeFilePath === file.path,
                      }}
                      role="listitem"
                      title={file.path}
                      onClick={() => diffReviewStore.selectFile(file.path)}
                    >
                      <div class="deliverables-file-info">
                        <span class={`deliverables-status-badge ${file.status}`}>
                          {statusLabel(file.status)}
                        </span>
                        <span class="deliverables-file-path">
                          <Show when={file.directory}>
                            <span class="deliverables-dir-prefix">{file.directory}</span>
                          </Show>
                          <span class="deliverables-filename">{file.filename}</span>
                        </span>
                      </div>
                      <span class="deliverables-stat-rollup">
                        <Show when={file.additions > 0}>
                          <b class="deliverables-stat-add">+{file.additions}</b>
                        </Show>
                        <Show when={file.deletions > 0}>
                          <b class="deliverables-stat-del">−{file.deletions}</b>
                        </Show>
                      </span>
                    </div>
                  )}
                </For>
              </div>
            </div>

            {/* 右侧 Diff 虚拟开窗画布 */}
            <div class="diff-drawer-content-pane">
              {/* 当前激活文件条幅 */}
              <div class="diff-drawer-file-banner">
                <div class="deliverables-file-info">
                  <IconFileCode style={{ width: "16px", height: "16px", color: "var(--accent)" }} />
                  <span style={{ "font-weight": "600", color: "var(--text)" }}>
                    {state().activeFilePath}
                  </span>
                  <Show when={activeSummary()}>
                    {(s) => (
                      <span class="deliverables-stat-rollup" style={{ "margin-left": "8px" }}>
                        <Show when={s().additions > 0}>
                          <b class="deliverables-stat-add">+{s().additions}</b>
                        </Show>
                        <Show when={s().deletions > 0}>
                          <b class="deliverables-stat-del">−{s().deletions}</b>
                        </Show>
                      </span>
                    )}
                  </Show>
                </div>
                <button
                  type="button"
                  class="deliverables-btn-review"
                  title="复制文件路径"
                  onClick={handleCopyPath}
                >
                  <IconCopy />
                  <span>{copied() ? "已复制" : "复制路径"}</span>
                </button>
              </div>

              {/* 核心 Diff 视口 */}
              <div class="diff-drawer-scrollable">
                <Show
                  when={activeParsed()}
                  fallback={
                    <div class="diff-drawer-skeleton">
                      <Show when={animReady()} fallback={<>
                        <div class="diff-drawer-skeleton-line" style={{ width: "80%" }} />
                        <div class="diff-drawer-skeleton-line" style={{ width: "65%" }} />
                        <div class="diff-drawer-skeleton-line" style={{ width: "90%" }} />
                        <div class="diff-drawer-skeleton-line" style={{ width: "50%" }} />
                      </>}>
                        {/* 动画已落地却仍解析不出内容 = 这一格确实没有 diff 原文:
                            binary 改动、delete(旧内容只进 trash)、或是本修复之前
                            (apply_patch 不下发 display.diff)归档的旧回合。不能让它永远骨架。 */}
                        <div class="diff-drawer-empty">该文件没有可展示的对比内容。</div>
                      </Show>
                    </div>
                  }
                >
                  {(parsed) => <DiffFileView file={parsed()} hidePath />}
                </Show>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </Show>
  );
};
