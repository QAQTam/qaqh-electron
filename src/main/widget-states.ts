/**
 * widget-directive §3/§4：iframe widget 状态快照的 userData 存储。
 *
 * 单文件 kv（`<userData>/widget-states.json`），键 = `workspace|session|path`
 * （pointer docs 状态存储契约）。renderer 经 `widget_state_get_all` /
 * `widget_state_put` 两个 host 命令读写；value 是 renderer 序列化的
 * `{modelContent, privateContent}` JSON 串（≤16KiB，桥侧已闸）。
 */
import { app } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

type WidgetStateMap = Record<string, string>;

let cache: WidgetStateMap | null = null;
let writing: Promise<void> = Promise.resolve();

function stateFile(): string {
  return join(app.getPath("userData"), "widget-states.json");
}

async function loadStates(): Promise<WidgetStateMap> {
  if (cache !== null) return cache;
  try {
    const parsed: unknown = JSON.parse(await readFile(stateFile(), "utf8"));
    cache =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as WidgetStateMap)
        : {};
  } catch {
    // 文件缺失/损坏都从空表继续写（快照本来就是 best-effort 通道）。
    cache = {};
  }
  return cache;
}

export async function readWidgetStates(): Promise<WidgetStateMap> {
  return { ...(await loadStates()) };
}

export async function putWidgetState(key: string, value: string): Promise<boolean> {
  if (key === "") return false;
  const states = await loadStates();
  states[key] = value;
  const payload = JSON.stringify(states);
  writing = writing.then(async () => {
    await writeFile(stateFile(), payload, "utf8");
  });
  await writing;
  return true;
}
