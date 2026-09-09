// 统一 diff 渲染：unified diff 文本 → 行数组（分类着色，spec §9 ToolCard diff 抽屉）。

export interface DiffLine {
  kind: "add" | "del" | "hunk" | "ctx";
  text: string;
}

export function parseDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) out.push({ kind: "hunk", text: line });
    else if (line.startsWith("+")) out.push({ kind: "add", text: line });
    else if (line.startsWith("-")) out.push({ kind: "del", text: line });
    else out.push({ kind: "ctx", text: line });
  }
  return out;
}

export interface DiffStat {
  add: number;
  del: number;
}

export function diffStat(diff: string): DiffStat {
  let add = 0;
  let del = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) add += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) del += 1;
  }
  return { add, del };
}
