/**
 * 交接（handoff）事实层。
 *
 * **判据只有一条**:`tool_name === "handoff"`。以下都被明确禁止当判据使用:
 * - `turn_ended` 终态:`TurnTerminal = completed|failed|cancelled` 是冻结契约,
 *   交接后的会话就是 `completed`,与"自然答完"不可区分;
 * - `compact_skip` / `autoCompactThreshold`:前者至今没有写方,后者只驱动后端
 *   自己的提醒/折叠,不产生任何前端可见字段;
 * - `handoff_path`:那只是本地镜像文件路径,**不是 URL**,也不是权威副本。
 *   权威在 A 会话的 `tool_calls.args_json` 与 timeline 的 tool_result 里,
 *   bootstrap 读得到——所以本模块只认这两份数据,path 最多当纯文本展示。
 */
import { parseJsonish } from "./reducer";
import type { ToolStep, Turn } from "./types";

/** 模型面工具名(后端 `handoff.rs::TOOL_NAME`)。 */
export const HANDOFF_TOOL = "handoff";
/** 交接文档正文字段(与后端 `FIELD_DOC` 同名;取 args 时用这一份结构化那份)。 */
export const HANDOFF_FIELD_DOC = "handoff_doc";
/** 一句话工作简述字段(后端 `FIELD_SUMMARY`;新会话标题直接用它)。 */
export const HANDOFF_FIELD_SUMMARY = "work_summary";
/** 上下文看门狗的 actor id(后端 `session_loop.rs::append_watchdog_input`)。 */
export const WATCHDOG_ACTOR_ID = "handoff-watchdog";

/**
 * 需要人看一眼、**绝不该静默重试**的回合错误码。
 * 都在现成 `TurnError.code` 里,直显 message 就够,这里只用来挑重点呈现的样式:
 * `handoff_missing` = 腾过一次位、模型仍不写交接文档 → 回合终止;
 * `context_overflow` = 上游判超限(后端已把分母收敛)。
 *
 * `handoff_invalid_args` / `handoff_write_failed` **不在**这一档:它们走
 * `tool_finished{status:"error"}`,回合继续、模型可重试(见 `handoffToolErrorCode`)。
 */
export const HANDOFF_FATAL_CODES = ["handoff_missing", "context_overflow"] as const;

export type HandoffFact = {
  /** 去重键:`${from_session_id}|${turn_id}`。同一条只允许 fork 一次。 */
  key: string;
  fromSessionId: string;
  turnId: string;
  workSummary: string;
  handoffDoc: string;
  /** 本地镜像 `.md` 路径(纯文本,永不拼成链接、永不下载)。 */
  handoffPath: string | null;
  modifiedFiles: string[];
  contextUsedTokens: number | null;
  contextWindowTokens: number | null;
  /** 产生这条事实的工具调用 id。 */
  callId: string;
  /**
   * 事实来自推断还是机器面的 `handed_off:true`。
   *
   * `inferred` 只在机器面整段读不出来时出现(同回合的重复调用、或 tool_result
   * 正文取不到但 `args_json` 还在)。`from_session_id`/`turn_id` 那对键退回本地
   * 会话与回合,所以 key 与首封同一条 —— 去重不受影响,但出处要标出来。
   */
  inferred: boolean;
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 从 `start` 处起取第一个**括号配平**的 JSON 对象文本。
 *
 * 为什么不能按 ``` 栅栏切:交接文档正文里带代码栅栏是常态(那是一篇给下一个
 * 会话读的 Markdown),非贪婪匹配会停在文档内部的那个闭合栅栏上,机器面就解析
 * 不出来 —— 表现是"交接成功了但没人接"。配平必须带字符串状态:字符串里的
 * `{`/`}` 不参与计数,转义引号要吃掉。
 */
function balancedObject(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
      if (depth < 0) return null;
    }
  }
  return null;
}

/**
 * 取 `tool_finished.output` 里那段机器面 JSON。
 *
 * 后端输出是「前半句人话 + ```json 机器面」,机器面同时是落库的 tool_result 正文;
 * 整段正文本身就是 JSON 时也吃(给"只渲染 output"的老路径兜底)。
 */
export function handoffPayloadFromOutput(output: string | undefined | null): Record<string, unknown> | null {
  if (!output) return null;
  const direct = parseJsonish(output);
  if (direct != null) return direct;
  let payload: Record<string, unknown> | null = null;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== "{") continue;
    const candidate = balancedObject(output, index);
    if (candidate == null) continue;
    const parsed = parseJsonish(candidate);
    if (parsed == null) continue;
    // 取最后一个带 `handed_off` 的对象;没有就留第一个(文档正文里出现的 JSON 段
    // 不会带这个键,所以误取的风险收在这条判据上)。
    if (payload == null) payload = parsed;
    if (parsed.handed_off !== undefined) return parsed;
  }
  return payload;
}

/**
 * 一条已完成的 handoff 工具调用 → 交接事实。
 *
 * 主判据是机器面里的 `handed_off === true`。它挡住两类假阳性:
 * - 同回合重复调用:后端回的是「这一回合已经交接过了」文本(status 仍是 ok),
 *   **不会再发第二份 `handed_off:true`**;
 * - `handoff_invalid_args` / `handoff_write_failed`:走 `status:"error"`,没有这段 JSON。
 *
 * 次判据(推断封箱)只在**机器面整段读不出来**时启用:那份输出很长,截断或尾部
 * 变形都可能吃掉 JSON。这时按「调用确实成功结束 + args 里有完整文档」成立,
 * id 退回本地会话/回合 —— 重复调用也走这条路,但它的 key 与首封是同一条,
 * 上层按 key 去重,不会因为这条宽容而多开一条会话。
 *
 * 文档正文优先取 `args`(模型亲手写的那份、结构化),output 里的同名字段只作冗余兜底。
 */
export function handoffFactOfToolCall(
  step: Pick<ToolStep, "id" | "name" | "argsJson" | "output" | "outputRef" | "status">,
  context: { sessionId: string; turnId?: string | null },
): HandoffFact | null {
  if (step.name !== HANDOFF_TOOL) return null;
  const payload = handoffPayloadFromOutput(step.output?.text);
  const args = parseJsonish(step.argsJson) ?? {};
  // 文档取 args(模型亲手写的那份结构化),output 里的同名字段只是给"只渲染 output"
  // 的老路径兜底;from_session_id / turn_id 只有 output 里有。
  const argsDoc = text(args[HANDOFF_FIELD_DOC]);
  const sealed = payload?.handed_off === true;
  // 正文还挂在引用上没回填回来时**不推断**:那不是"读不出机器面",是"机器面在路上"。
  // 抢在这里 fork 会拿本地 id 立一条 inferred 事实,把真实封箱标记给盖掉。
  const bodyInFlight = step.outputRef != null && (step.output?.text ?? "") === "";
  const inferred = payload == null && !bodyInFlight && step.status === "finished" && argsDoc != null;
  if (!sealed && !inferred) return null;
  const handoffDoc = argsDoc ?? text(payload?.[HANDOFF_FIELD_DOC]);
  const workSummary = text(args[HANDOFF_FIELD_SUMMARY]) ?? text(payload?.[HANDOFF_FIELD_SUMMARY]) ?? "";
  // 没有正文就不配叫交接:宁可不 fork,也不拿一句人话去喂新会话。
  if (handoffDoc == null) return null;
  const fromSessionId = text(payload?.from_session_id) ?? context.sessionId;
  const turnId = text(payload?.turn_id) ?? context.turnId ?? "";
  if (fromSessionId === "" || turnId === "") return null;
  return {
    key: `${fromSessionId}|${turnId}`,
    fromSessionId,
    turnId,
    workSummary,
    handoffDoc,
    handoffPath: text(payload?.handoff_path),
    modifiedFiles: Array.isArray(payload?.modified_files)
      ? payload.modified_files.filter((item): item is string => typeof item === "string")
      : [],
    contextUsedTokens: count(payload?.context_used_tokens),
    contextWindowTokens: count(payload?.context_window_tokens),
    callId: step.id,
    // 事实来自推断而非机器面:入口照给,但出处标出来,别让人以为读到了封箱标记。
    inferred,
  };
}

/**
 * 一个回合里全部封箱成功的交接事实(按出现顺序,同 key 只留一条)。
 *
 * `turnId` 的兜底用本地回合 id:payload 里本来就有 `turn_id`,只有畸形输出才会
 * 走到这条;连兜底都没有就整条不成立(见上面的 null 分支)。
 *
 * **离线也能重建**:客户端关掉/掉线时 A 停在 `completed`,重新 bootstrap 后这条
 * 交接照样读得出来——权威副本在 `tool_calls.args_json` 与 tool_result 两处。
 * 所以不需要专用下载接口,`handoff_path` 也不必上屏。
 */
export function handoffFactsOfTurn(turn: Turn, sessionId: string): HandoffFact[] {
  const facts: HandoffFact[] = [];
  for (const step of turn.steps) {
    if (step.kind !== "tool") continue;
    const fact = handoffFactOfToolCall(step, { sessionId, turnId: turn.id });
    if (fact != null && !facts.some((item) => item.key === fact.key)) facts.push(fact);
  }
  return facts;
}

/** 回合尾部那条常驻入口取的那一条:最后封箱成功的交接。 */
export function handoffFactOfTurn(turn: Turn, sessionId: string): HandoffFact | null {
  const facts = handoffFactsOfTurn(turn, sessionId);
  return facts[facts.length - 1] ?? null;
}

/**
 * 交接调用失败的错误码(现成 `ToolCallOutcome.failed.error.code`)。
 *
 * 这两类失败走 `tool_finished{status:"error"}` 而**不是** `TurnError`:回合继续,
 * 模型可以改参数重试。所以这里只把 code 摆到状态位上给人看,不做任何自动补救。
 */
export function handoffToolErrorCode(step: Pick<ToolStep, "name" | "status" | "state">): string | null {
  if (step.name !== HANDOFF_TOOL || step.status !== "failed") return null;
  const state = step.state;
  if (state?.kind !== "finished" || state.outcome.kind !== "failed") return null;
  return state.outcome.error.code?.trim() || null;
}
