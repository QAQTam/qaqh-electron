/**
 * 回合交付物汇总卡片 (spec §9 / 对齐截图 222138 交付成果视图)
 * 
 * 内存与性能保护:
 * 1. 仅在内存中保留轻量指纹 (路径 + 统计)，绝不持有 AST 或完整 diff 文本。
 * 2. 点击文件行或“审查改动”按钮时，通知 diffReviewStore 唤起抽屉工作台。
 */
import { createMemo, createSignal, For, Show, type Component } from "solid-js";
import IconFileCode from "~icons/lucide/file-code";
import IconEye from "~icons/lucide/eye";
import IconChevronDown from "~icons/lucide/chevron-down";
import IconChevronUp from "~icons/lucide/chevron-up";
import { extractTurnDeliverables, type DeliverableFileSummary } from "./deliverables";
import { diffReviewStore } from "./review-store";
import type { Turn } from "../session/types";

/** 折叠态只露三行:一回合改几十文件时,整列铺开会把答案顶出视野。 */
const VISIBLE_ROWS_WHEN_COLLAPSED = 3;

export interface TurnDeliverablesCardProps {
  turn: Turn;
  sessionId: string;
  cwd?: string | null;
}

export const TurnDeliverablesCard: Component<TurnDeliverablesCardProps> = (props) => {
  const deliverables = createMemo(() => extractTurnDeliverables(props.turn, props.cwd));
  const [expanded, setExpanded] = createSignal(false);

  const handleOpenReview = (targetFilePath?: string) => {
    diffReviewStore.open({
      sessionId: props.sessionId,
      turn: props.turn,
      targetFilePath,
      cwd: props.cwd,
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

  const statusTitle = (status: DeliverableFileSummary["status"]): string => {
    switch (status) {
      case "added":
        return "新增文件";
      case "deleted":
        return "已删除文件";
      case "renamed":
        return "已重命名文件";
      case "modified":
      default:
        return "已修改文件";
    }
  };

  return (
    <Show when={deliverables()}>
      {(data) => (
        <div class="turn-deliverables-card" role="region" aria-label="本回合修改的文件">
          <div class="deliverables-header">
            <div class="deliverables-title-group">
              <IconFileCode class="deliverables-title-icon" />
              <span>{data().totalFiles} 个文件已修改</span>
              <span class="deliverables-stat-rollup">
                <Show when={data().totalAdditions > 0}>
                  <b class="deliverables-stat-add">+{data().totalAdditions}</b>
                </Show>
                <Show when={data().totalDeletions > 0}>
                  <b class="deliverables-stat-del">−{data().totalDeletions}</b>
                </Show>
              </span>
            </div>
            <Show when={data().files.length > VISIBLE_ROWS_WHEN_COLLAPSED}>
              <button
                type="button"
                class="deliverables-btn-review"
                title={expanded() ? "收起文件列表" : "展开完整文件列表"}
                aria-expanded={expanded() ? "true" : "false"}
                onClick={() => setExpanded((value) => !value)}
              >
                <span>{expanded() ? "收起" : "查看更多"}</span>
                {expanded() ? <IconChevronUp /> : <IconChevronDown />}
              </button>
            </Show>
          </div>

          <div class="deliverables-file-list" role="list">
            <For each={expanded() ? data().files : data().files.slice(0, VISIBLE_ROWS_WHEN_COLLAPSED)}>
              {(file) => (
                <div
                  class="deliverables-file-item"
                  role="listitem"
                  title={`点击查看 ${file.path} 的修改对比`}
                  onClick={() => handleOpenReview(file.path)}
                >
                  <div class="deliverables-file-info">
                    <span
                      class={`deliverables-status-badge ${file.status}`}
                      title={statusTitle(file.status)}
                    >
                      {statusLabel(file.status)}
                    </span>
                    <span class="deliverables-file-path">
                      <Show when={file.directory}>
                        <span class="deliverables-dir-prefix">{file.directory}</span>
                      </Show>
                      <span class="deliverables-filename">{file.filename}</span>
                    </span>
                  </div>

                  <div class="deliverables-file-actions">
                    <span class="deliverables-stat-rollup">
                      <Show when={file.additions > 0}>
                        <b class="deliverables-stat-add">+{file.additions}</b>
                      </Show>
                      <Show when={file.deletions > 0}>
                        <b class="deliverables-stat-del">−{file.deletions}</b>
                      </Show>
                    </span>
                    <button
                      type="button"
                      class="deliverables-action-icon-btn"
                      title="预览 Diff"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleOpenReview(file.path);
                      }}
                    >
                      <IconEye />
                    </button>
                  </div>
                </div>
              )}
            </For>
          </div>
        </div>
      )}
    </Show>
  );
};
