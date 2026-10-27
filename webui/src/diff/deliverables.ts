/**
 * Turn 级交付物提取与轻量指纹聚合 (spec §9 / 交付物卡片与审查抽屉数据通道)
 * 
 * 内存安全原则 (Memory Hard Cap):
 * 1. 本模块在常驻状态中只产出 DeliverableFileSummary 元数据指纹 (< 100 字节/文件)。
 * 2. 绝对不在 TurnDeliverables 中长期缓存 ParsedFile 结构、语法高亮 Spans 或大型 diff AST。
 * 3. 完整 diff 文本仅在抽屉激活时通过 `getTurnFileDiff` 按需提取，用完即被 GC 回收。
 */
import type { ToolStep, Turn } from "../session/types";
import { parseUnifiedDiff, type ParsedFile } from "./parse";
import { toolPaths, toolPresentation } from "../tools/presentation";

export type DeliverableFileStatus = "added" | "deleted" | "modified" | "renamed" | "unknown";

export interface DeliverableFileSummary {
  /** 文件规范路径 (相对于 cwd 或清晰相对路径) */
  path: string;
  /** 文件名 (用于高亮醒目标题，例如 "editorStore.ts") */
  filename: string;
  /** 所在目录前缀 (用于低对比度展示，例如 "src/stores/") */
  directory: string;
  status: DeliverableFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  /** 关联的 tool step ids，按发生顺序排列 */
  stepIds: string[];
}

export interface TurnDeliverables {
  turnId: string;
  turnKey: string;
  totalFiles: number;
  totalAdditions: number;
  totalDeletions: number;
  files: DeliverableFileSummary[];
}

/** 分解路径为 directory 与 filename */
export function splitPath(path: string): { directory: string; filename: string } {
  const normalized = path.replaceAll("\\", "/");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash === -1) {
    return { directory: "", filename: normalized };
  }
  return {
    directory: normalized.slice(0, lastSlash + 1),
    filename: normalized.slice(lastSlash + 1),
  };
}

/** 规范化相对路径 (去掉前导 ./ 或冗余斜杠)。抽屉侧按需匹配 diff 文件时复用。 */
export function normalizeDisplayPath(path: string, cwd?: string | null): string {
  let clean = path.replaceAll("\\", "/");
  if (cwd) {
    const cleanCwd = cwd.replaceAll("\\", "/").replace(/\/+$/, "");
    if (clean.startsWith(`${cleanCwd}/`)) {
      clean = clean.slice(cleanCwd.length + 1);
    }
  }
  return clean.replace(/^\.\//, "");
}

/**
 * 从单个回合中提取轻量交付物指纹。
 * 若本回合未发生任何成功的文件修改，返回 null（不渲染交付卡片）。
 */
export function extractTurnDeliverables(turn: Turn, cwd?: string | null): TurnDeliverables | null {
  const toolSteps = turn.steps.filter(
    (s): s is ToolStep => s.kind === "tool" && s.status === "success"
  );
  if (toolSteps.length === 0) return null;

  const fileMap = new Map<string, DeliverableFileSummary>();

  for (const step of toolSteps) {
    const kind = toolPresentation(step);
    // 只关注文件修改类工具 (edit / write / patch / delete 等)
    const isMutationOp =
      kind === "edit" ||
      ["edit", "edit_file", "write", "write_file", "apply_patch", "delete", "delete_file"].includes(
        step.name
      );

    if (!isMutationOp && !step.output?.diffText) {
      continue;
    }

    const diffText = step.output?.diffText;
    if (diffText) {
      let parsedFiles: ParsedFile[] = [];
      try {
        parsedFiles = parseUnifiedDiff(diffText);
      } catch {
        parsedFiles = [];
      }

      if (parsedFiles.length > 0) {
        for (const pf of parsedFiles) {
          const normPath = normalizeDisplayPath(pf.path, cwd);
          const existing = fileMap.get(normPath);
          const { directory, filename } = splitPath(normPath);

          if (existing) {
            existing.additions += pf.stats.add;
            existing.deletions += pf.stats.del;
            if (pf.binary) existing.binary = true;
            if (pf.status === "deleted") existing.status = "deleted";
            else if (existing.status !== "added" && pf.status === "added") existing.status = "added";
            if (!existing.stepIds.includes(step.id)) {
              existing.stepIds.push(step.id);
            }
          } else {
            fileMap.set(normPath, {
              path: normPath,
              filename,
              directory,
              status: pf.status,
              additions: pf.stats.add,
              deletions: pf.stats.del,
              binary: pf.binary,
              stepIds: [step.id],
            });
          }
        }
        continue;
      }
    }

    // 回退路径：有些写工具没有产生 diffText，但有 path 和变更统计
    if (isMutationOp) {
      const paths = toolPaths(step, cwd);
      const targetPath = paths[0];
      if (targetPath) {
        const normPath = normalizeDisplayPath(targetPath, cwd);
        const { directory, filename } = splitPath(normPath);
        const add = step.display?.lines_added ?? (step.name.includes("delete") ? 0 : 1);
        const del = step.display?.lines_removed ?? (step.name.includes("delete") ? 1 : 0);
        const status: DeliverableFileStatus = step.name.includes("delete")
          ? "deleted"
          : step.name.includes("write")
            ? "added"
            : "modified";

        const existing = fileMap.get(normPath);
        if (existing) {
          existing.additions += add;
          existing.deletions += del;
          if (!existing.stepIds.includes(step.id)) {
            existing.stepIds.push(step.id);
          }
        } else {
          fileMap.set(normPath, {
            path: normPath,
            filename,
            directory,
            status,
            additions: add,
            deletions: del,
            binary: false,
            stepIds: [step.id],
          });
        }
      }
    }
  }

  if (fileMap.size === 0) return null;

  const files = Array.from(fileMap.values());
  let totalAdditions = 0;
  let totalDeletions = 0;
  for (const f of files) {
    totalAdditions += f.additions;
    totalDeletions += f.deletions;
  }

  return {
    turnId: turn.id,
    turnKey: turn.key,
    totalFiles: files.length,
    totalAdditions,
    totalDeletions,
    files,
  };
}

/**
 * 按需提取某一特定文件的完整 Unified Diff 文本。
 * 仅在审查抽屉挂载或切换到该文件时调用，不持久驻留在指纹模型中。
 */
export function getTurnFileDiff(turn: Turn, targetPath: string, cwd?: string | null): string | null {
  const normTarget = normalizeDisplayPath(targetPath, cwd);
  const diffSnippets: string[] = [];

  for (const step of turn.steps) {
    if (step.kind !== "tool" || step.status !== "success" || !step.output?.diffText) {
      continue;
    }
    const diffText = step.output.diffText;
    try {
      const files = parseUnifiedDiff(diffText);
      const matched = files.find((f) => normalizeDisplayPath(f.path, cwd) === normTarget);
      if (matched) {
        // 找到了匹配文件，提取该段 diff
        diffSnippets.push(diffText);
      }
    } catch {
      // 容错忽略单个损坏的 diff 文本
    }
  }

  if (diffSnippets.length === 0) {
    return null;
  }

  // 若同一个文件被多次修改，返回最后的合并或连接文本
  return diffSnippets.join("\n");
}
