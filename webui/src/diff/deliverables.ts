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
 * 只有原始工具输出包含可解析的 unified diff 路径时才生成文件卡片。
 * code_delta 的行数统计由工具行直接展示；没有路径时不猜测文件名或文件数。
 */
export function extractTurnDeliverables(turn: Turn, cwd?: string | null): TurnDeliverables | null {
  const toolSteps = turn.steps.filter(
    (s): s is ToolStep => s.kind === "tool" && s.status === "finished"
  );
  if (toolSteps.length === 0) return null;

  const fileMap = new Map<string, DeliverableFileSummary>();
  let totalAdditions = 0;
  let totalDeletions = 0;

  for (const step of toolSteps) {
    const diffText = step.output?.diffText;
    let parsedFiles: ParsedFile[] = [];
    if (diffText) {
      try {
        parsedFiles = parseUnifiedDiff(diffText);
      } catch {
        parsedFiles = [];
      }
    }

    // code_delta 是行数的权威口径；只有缺少结构化统计时才回退到原始 diff 的行数。
    if (step.codeDelta != null) {
      totalAdditions += step.codeDelta.lines_added;
      totalDeletions += step.codeDelta.lines_removed;
    } else {
      totalAdditions += parsedFiles.reduce((sum, file) => sum + file.stats.add, 0);
      totalDeletions += parsedFiles.reduce((sum, file) => sum + file.stats.del, 0);
    }

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
        if (!existing.stepIds.includes(step.id)) existing.stepIds.push(step.id);
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
  }

  if (fileMap.size === 0) return null;

  const files = Array.from(fileMap.values());

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
    if (step.kind !== "tool" || step.status !== "finished" || !step.output?.diffText) {
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
