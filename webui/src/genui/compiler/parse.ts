/**
 * TSX 风格受限 DSL 解析器(spec-generative-ui-runtime §7,原型子集)。
 *
 * 语义是「解析而非执行」:`ui.*` 是编译 intrinsics,降低到 IR,绝不调用任何
 * JavaScript 函数。不支持 import/函数/任意表达式;未知语句、未知组件、未知
 * 状态引用一律具名报错(带行号),不修复半截代码。
 *
 * 原型采用手写扫描器而不是 @babel/parser:语法只有 6 种顶层语句 + 受限
 * JSX 自闭合元素,单趟逐字符扫描足够,且免去新依赖与 Node 构建验证
 * (spec §7.3 的完整禁用清单由「只认识这 6 种语句」天然保证)。
 */
import {
  CATALOG, GenUiError, IR_VERSION, MAX_NODES,
  type Action, type Expr, type IRNode, type PropValue, type StateType, type StateValue, type SurfaceIR,
} from "./ir";

type Statement = { text: string; line: number };

/** 按「深度 0 的分号」切语句;跳过字符串与注释,记录起始行号。
 *  流式容尾(final=false 才由调用方触发重扫):结尾处未终结的语句整体丢弃,
 *  已到齐的语句照常返回——半截 JSX/括号不得拖累前面的节点先渲染。 */
export function splitStatements(source: string, options: { tolerantTail?: boolean } = {}): Statement[] {
  const statements: Statement[] = [];
  let statementStart: number | null = null;
  let line = 1;
  let statementLine = 1;
  let depth = 0;
  let index = 0;
  const push = (end: number): void => {
    if (statementStart == null) return;
    const text = source.slice(statementStart, end).trim();
    if (text !== "") statements.push({ text, line: statementLine });
    statementStart = null;
  };
  while (index < source.length) {
    const char = source[index]!;
    if (char === "\n") { line += 1; index += 1; continue; }
    if (char === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue; // 注释永不属于语句内容:不移动 statementStart
    }
    if (char === "/" && source[index + 1] === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] === "\n") line += 1;
        index += 1;
      }
      if (index >= source.length && options.tolerantTail === true) return statements; // 未闭合注释 = 半截
      index += 2;
      continue;
    }
    if (statementStart == null) {
      if (/\s/.test(char)) { index += 1; continue; }
      statementStart = index;
      statementLine = line;
    }
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      index += 1;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === "\\") { index += 2; continue; }
        if (source[index] === "\n") line += 1;
        index += 1;
      }
      if (index >= source.length && options.tolerantTail === true) return statements; // 未闭合字符串 = 尾部半截语句
      index += 1;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") depth += 1;
    if (char === ")" || char === "]" || char === "}") depth -= 1;
    if (char === ";" && depth <= 0) {
      push(index);
      index += 1;
      continue;
    }
    // 宽容换行(模型省略分号):深度 0、当前位置是新语句关键字起始
    // (ui./const,且前一个非空白字符是换行),且上文有可终止语句的内容。
    if (
      depth <= 0 && statementStart != null && atStatementKeywordStart(source, index)
      && previousNonSpaceIsNewline(source, index) && endsStatementBefore(source, statementStart, index)
    ) {
      push(index);
      statementStart = index;
      statementLine = line;
      continue;
    }
    index += 1;
  }
  // 扫描到源码结尾:容尾模式(流式 final=false)下,凡是没有被分号/宽容换行
  // 边界收尾的尾语句都视为「还在生成中」直接丢弃——半截 JSX/括号/字符串不
  // 拖累已到齐的节点先渲染;严格模式(final)照旧收尾,seal 后半截语句得到
  // 具名报错而不是被静默吞掉。
  if (options.tolerantTail === true) {
    if (statementStart != null && (depth > 0 || !statementsClosedTail(source, statementStart))) {
      return statements;
    }
    push(source.length);
    return statements;
  }
  push(source.length);
  return statements;
}

/** 容尾判定:statementStart 之后(到源码结尾)是否已构成「闭合」的语句形态
 *  (出现 `)`,且深度已归零)。宽容换行能收尾的语句在扫描中早已 push,
 *  这里只处理「结尾悬空」的形态:语句完整(如省略分号的 ui.end())返回 true。 */
function statementsClosedTail(source: string, start: number): boolean {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]!;
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      index += 1;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === "\\") index += 2;
        else index += 1;
      }
      continue;
    }
    if (char === "(" || char === "[" || char === "{") depth += 1;
    if (char === ")" || char === "]" || char === "}") depth -= 1;
  }
  return depth <= 0 && /[\)\}"']\s*$/.test(source.slice(start));
}

/** index 是否正处在新语句的关键字起始(ui./const,大小写敏感)。 */
function atStatementKeywordStart(source: string, index: number): boolean {
  return source.startsWith("ui.", index) || source.startsWith("const ", index);
}

/** index 前最近的非空白字符是否是换行(必须在同一源串里往前扫)。 */
function previousNonSpaceIsNewline(source: string, index: number): boolean {
  let cursor = index - 1;
  while (cursor >= 0 && (source[cursor] === " " || source[cursor] === "\t" || source[cursor] === "\r")) cursor -= 1;
  return cursor >= 0 ? source[cursor] === "\n" : false;
}

/** 从 statementStart 到 index 之间是否存在可终止语句的内容(保守判定)。 */
function endsStatementBefore(source: string, start: number, index: number): boolean {
  const head = source.slice(start, index);
  // 有内容且有闭合括号,或出现引号字符串——都视为一条完整语句已经成立。
  return /[\)"]/.test(head) && head.trim().length > 0;
}

function unescape(raw: string): string {
  return raw.replace(/\\(.)/g, (_, char: string) => (char === "n" ? "\n" : char === "t" ? "\t" : char));
}

function parseStringLiteral(text: string, line: number): string {
  const match = /^"((?:[^"\\]|\\.)*)"$/.exec(text.trim()) ?? /^'((?:[^'\\]|\\.)*)'$/.exec(text.trim());
  if (match == null) throw new GenUiError(`需要字符串字面量:${text}`, line);
  return unescape(match[1]!);
}

/** 取调用括号内的内容(要求语句以 prefix 开头、以 ) 收尾)。 */
function callArgs(statement: Statement, prefix: RegExp): string[] {
  if (!prefix.test(statement.text)) throw new GenUiError(`无法识别的语句:${statement.text}`, statement.line);
  const open = statement.text.indexOf("(");
  const inner = statement.text.slice(open + 1, statement.text.lastIndexOf(")"));
  return splitTop(inner, statement.line);
}

/** 顶层逗号切分(忽略括号/字符串内)。 */
function splitTop(text: string, line: number): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      index += 1;
      while (index < text.length && text[index] !== quote) {
        if (text[index] === "\\") index += 1;
        index += 1;
      }
    } else if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    else if (char === "," && depth <= 0) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
    index += 1;
  }
  if (start <= text.length) parts.push(text.slice(start).trim());
  if (parts.length === 1 && parts[0]!.trim() === "") parts.pop();
  void line;
  return parts;
}

type Symbols = Record<string, { key: string; type?: StateType; item?: boolean; derived?: boolean; expr?: Expr }>;

const hasStateKey = (symbols: Symbols, key: string): boolean => Object.values(symbols).some((entry) => entry.key === key && !entry.item);

/** 表达式优先级级联:or → and → 比较 → 加减/拼接 → 乘除 → 一元 ! → 原子。 */
function parseExpression(text: string, symbols: Symbols, line: number): Expr {
  return parseBinary(text, symbols, line, 0);
}

/** 各级二元操作符:文本形式 → Expr 二元 op。 */
const BINARY_LEVELS: Array<{ ops: string[]; kind: Record<string, "or" | "and" | "eq" | "neq" | "gt" | "lt" | "add" | "sub" | "mul" | "div"> }> = [
  { ops: ["||"], kind: { "||": "or" } },
  { ops: ["&&"], kind: { "&&": "and" } },
  { ops: ["==", "!=", ">=", "<=", ">", "<"], kind: { "==": "eq", "!=": "neq", ">=": "gt", "<=": "lt", ">": "gt", "<": "lt" } },
  { ops: ["+", "-"], kind: { "+": "add", "-": "sub" } },
  { ops: ["*", "/"], kind: { "*": "mul", "/": "div" } },
];

function parseBinary(text: string, symbols: Symbols, line: number, level: number): Expr {
  if (level >= BINARY_LEVELS.length) return parseUnary(text, symbols, line);
  const trimmed = text.trim();
  const found = findTop(trimmed, BINARY_LEVELS[level]!.ops);
  if (found != null) {
    const { index, op } = found;
    return {
      op: BINARY_LEVELS[level]!.kind[op]!,
      left: parseBinary(trimmed.slice(0, index), symbols, line, level),
      right: parseBinary(trimmed.slice(index + op.length), symbols, line, level),
    };
  }
  return parseBinary(trimmed, symbols, line, level + 1);
}

/** 深度 0、字符串外、最左出现的操作符(左结合);多字符 op 按 ops 顺序优先。 */
function findTop(text: string, ops: string[]): { index: number; op: string } | null {
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      index += 1;
      while (index < text.length && text[index] !== quote) {
        if (text[index] === "\\") { index += 2; continue; }
        index += 1;
      }
      continue;
    }
    if (char === "(" || char === "[") depth += 1;
    else if (char === ")" || char === "]") depth -= 1;
    else if (depth === 0 && index > 0) {
      for (const op of ops) {
        if (text.startsWith(op, index) && isOperatorPosition(text, index, op)) return { index, op };
      }
    }
  }
  return null;
}

/** 操作符两侧(越过空白)必须是操作数边界;多字符 op 贪婪匹配(== != >= <= && ||)。 */
function isOperatorPosition(text: string, index: number, op: string): boolean {
  let left = index - 1;
  while (left >= 0 && /\s/.test(text[left]!)) left -= 1;
  let right = index + op.length;
  while (right < text.length && /\s/.test(text[right]!)) right += 1;
  if (left < 0 || right >= text.length) return false;
  // 双字符 op 贪婪:> 单独出现时,若紧跟 = 则由 >= 级联处理。
  if (opsLonger(text, index) && op.length === 1) return false;
  return /[\w)$"]/.test(text[left]!) && /[\w(!"-]/.test(text[right]!);
}

/** index 处是否为双字符操作符的起始(用于贪婪判定)。 */
function opsLonger(text: string, index: number): boolean {
  return ["==", "!=", ">=", "<=", "&&", "||"].includes(text.slice(index, index + 2));
}

function parseUnary(text: string, symbols: Symbols, line: number): Expr {
  const trimmed = text.trim();
  if (trimmed.startsWith("!") && !trimmed.startsWith("!=")) {
    const value = parseUnary(trimmed.slice(1), symbols, line);
    return { op: "not", value };
  }
  return parsePrimary(trimmed, symbols, line);
}

function parsePrimary(text: string, symbols: Symbols, line: number): Expr {
  let trimmed = text.trim();
  let stripped = false;
  // 括号复合表达式:整体被一对括号包住时剥掉,重新进入完整优先级级联。
  while (trimmed.startsWith("(")) {
    let depth = 0;
    let close = -1;
    for (let index = 0; index < trimmed.length; index += 1) {
      if (trimmed[index] === "(") depth += 1;
      if (trimmed[index] === ")") { depth -= 1; if (depth === 0) { close = index; break; } }
    }
    if (close !== trimmed.length - 1) break;
    trimmed = trimmed.slice(1, -1).trim();
    if (trimmed === "") throw new GenUiError("空括号表达式", line);
    stripped = true;
  }
  if (/^"(?:[^"\\]|\\.)*"$/.test(trimmed)) return { op: "lit", value: unescape(trimmed.slice(1, -1)) };
  if (/^[+-]?\d+(?:\.\d+)?$/.test(trimmed)) return { op: "lit", value: Number(trimmed) };
  if (trimmed === "true" || trimmed === "false") return { op: "lit", value: trimmed === "true" };
  if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) {
    const symbol = symbols[trimmed];
    if (symbol == null) throw new GenUiError(`表达式引用未知状态 ${trimmed}`, line);
    if (symbol.item === true) return { op: "item", as: trimmed };
    if (symbol.derived === true) return symbol.expr!;
    return { op: "state", key: symbol.key };
  }
  if (stripped) return parseBinary(trimmed, symbols, line, 0);
  throw new GenUiError(`不支持的表达式:${trimmed}`, line);
}

function parseAction(text: string, symbols: Symbols, line: number): Action {
  const trimmed = text.trim();
  if (/^ui\.reset\(\s*\)$/.test(trimmed)) return { kind: "reset" };
  const set = /^ui\.set\(\s*("(?:[^"\\]|\\.)*")\s*,\s*([\s\S]+)\s*\)$/.exec(trimmed);
  if (set != null) {
    const key = parseStringLiteral(set[1]!, line);
    if (!hasStateKey(symbols, key)) throw new GenUiError(`动作引用未知状态 ${key}`, line);
    return { kind: "set", key, value: parseExpression(set[2]!, symbols, line) };
  }
  // ui.followUp("prompt") / ui.followUp("prompt", { "标签": 字段名, ... }):字段值在
  // 提交事务里从绑定状态读取,不上传其余私有状态(spec §7.6)。
  const followUp = /^ui\.followUp\(\s*("(?:[^"\\]|\\.)*")\s*(?:,\s*(\{[\s\S]*\})\s*)?\)$/.exec(trimmed);
  if (followUp != null) {
    const prompt = parseStringLiteral(followUp[1]!, line);
    const keys = Object.values(symbols).map((entry) => entry.key);
    const fields: Array<{ label: string; key: string }> = [];
    for (const [label, raw] of objectEntries(followUp[2] ?? "{}", line)) {
      const name = raw.trim();
      // 字段值两种写法都收:状态名(标识符)或状态 key 字符串(与 jsonl wire 一致)。
      const key = /^[A-Za-z_$][\w$]*$/.test(name) ? symbols[name]?.key : /^"(?:[^"\\]|\\.)*"$/.test(name) ? unescape(name.slice(1, -1)) : undefined;
      if (key == null || !keys.includes(key)) {
        throw new GenUiError(`followUp 字段 ${label} 引用未知状态 ${name}(字段值应为状态名或其 "key")`, line);
      }
      fields.push({ label, key });
    }
    return { kind: "followUp", prompt, fields };
  }
  // 低风险外围动作:copy(字符串表达式)/ openLink(仅 http(s) 字面量)。
  const copy = /^ui\.copy\(\s*([\s\S]+)\s*\)$/.exec(trimmed);
  if (copy != null) return { kind: "copy", value: parseExpression(copy[1]!, symbols, line) };
  const openLink = /^ui\.openLink\(\s*("(?:[^"\\]|\\.)*")\s*\)$/.exec(trimmed);
  if (openLink != null) {
    const url = parseStringLiteral(openLink[1]!, line);
    if (!/^https:\/\//.test(url) && !/^http:\/\//.test(url)) {
      throw new GenUiError(`openLink 只允许 http(s) 链接:${url}`, line);
    }
    return { kind: "openLink", url };
  }
  // append/remove 只作用于 list 态(类型校验在 validateSurface)。
  const keyed = /^ui\.(append|remove)\(\s*("(?:[^"\\]|\\.)*")\s*,\s*([\s\S]+)\s*\)$/.exec(trimmed);
  if (keyed != null) {
    const key = parseStringLiteral(keyed[2]!, line);
    if (!hasStateKey(symbols, key)) throw new GenUiError(`动作引用未知状态 ${key}`, line);
    return { kind: keyed[1] as "append" | "remove", key, value: parseExpression(keyed[3]!, symbols, line) };
  }
  throw new GenUiError(`不支持的动作:${trimmed}`, line);
}

const IDENT = "[A-Za-z_$][\\w$]*";

/** JSX 自闭合元素:<Type name={expr} name="str" ... />;不支持 children 语法与 spread。 */
function parseJsxNode(text: string, symbols: Symbols, line: number): { type: string; props: Record<string, PropValue> } {
  const match = /^<\s*([A-Za-z][\w]*)\s*([\s\S]*)\/>\s*$/.exec(text.trim());
  if (match == null) throw new GenUiError(`只支持自闭合 JSX 元素:${text}`, line);
  const type = match[1]!;
  const props: Record<string, PropValue> = {};
  const rest = match[2] ?? "";
  let index = 0;
  while (index < rest.length) {
    while (index < rest.length && /\s/.test(rest[index]!)) index += 1;
    const name = new RegExp(`^(${IDENT})\\s*=\\s*`).exec(rest.slice(index));
    if (name == null) {
      if (rest.slice(index).trim() === "") break;
      throw new GenUiError(`无法解析属性:${rest.slice(index, index + 30)}`, line);
    }
    index += name[0].length;
    if (rest[index] === "{") {
      // 平衡花括号取值(数组字面量/表达式);字符串字面量整体跳过,
      // 否则 {"进度："} 里的引号会让花括号配对提前闭合。
      let depth = 0;
      const start = index;
      while (index < rest.length) {
        const char = rest[index]!;
        if (char === '"' || char === "'" || char === "`") {
          const quote = char;
          index += 1;
          while (index < rest.length && rest[index] !== quote) {
            if (rest[index] === "\\") { index += 2; continue; }
            index += 1;
          }
          index += 1;
          continue;
        }
        if (char === "{") depth += 1;
        if (char === "}") { depth -= 1; if (depth === 0) { index += 1; break; } }
        index += 1;
      }
      const raw = rest.slice(start + 1, index - 1).trim();
      const bind = /^ui\.bind\(\s*("(?:[^"\\]|\\.)*")\s*\)$/.exec(raw);
      if (bind != null) {
        // 双向绑定:值的读写都落到该状态域(spec §10)。
        props[name[1]!] = { kind: "binding", key: parseStringLiteral(bind[1]!, line) };
      } else if (name[1] === "repeat") {
        // for/repeat:repeat={ui.for("list态", "循环变量")}(spec §7 for 语句的属性形态)。
        const forMatch = /^ui\.for\(\s*("(?:[^"\\]|\\.)*")\s*,\s*("(?:[^"\\]|\\.)*")\s*\)$/.exec(raw);
        if (forMatch == null) throw new GenUiError(`repeat 需要 ui.for("list态", "循环变量")`, line);
        props.repeat = { kind: "repeat", source: parseStringLiteral(forMatch[1]!, line), as: parseStringLiteral(forMatch[2]!, line) };
      } else if (/^ui\.(?:set|reset|followUp|copy|openLink|append|remove)\(/.test(raw)) {
        // 事件值是 Action 描述,不是表达式(spec §7.1)。
        props[name[1]!] = { kind: "action", action: parseAction(raw, symbols, line) };
      } else if (/^\[\s*(?:"(?:[^"\\]|\\.)*"\s*,?\s*)*\]$/.test(raw)) {
        const items = raw.length > 2
          ? raw.slice(1, -1).split(",").map((item) => parseStringLiteral(item.trim(), line)).filter((item) => item !== "")
          : [];
        props[name[1]!] = { kind: "list", items };
      } else {
        props[name[1]!] = { kind: "expr", expr: parseExpression(raw, symbols, line) };
      }
      continue;
    }
    const stringMatch = /^"((?:[^"\\]|\\.)*)"/.exec(rest.slice(index));
    if (stringMatch != null) {
      props[name[1]!] = { kind: "lit", value: unescape(stringMatch[1]!) };
      index += stringMatch[0].length;
      continue;
    }
    throw new GenUiError(`属性值需要 {expr} 或字符串:${rest.slice(index, index + 30)}`, line);
  }
  return { type, props };
}

/**
 * 解析整个 surface 源码为 IR。结构裁决(spec §6.1/§7.1):
 * ui.surface 必须第一条、ui.end 必须最后一条,中间只允许
 * ui.state 声明与 ui.node;ui.set/ui.reset 只能作为事件值出现。
 */
export function parseSurface(source: string, options: { final?: boolean } = {}): SurfaceIR {
  const final = options.final !== false;
  const statements = splitStatements(source, { tolerantTail: !final });
  if (statements.length === 0) throw new GenUiError("UI 源码为空");

  const symbols: Symbols = {};
  const states: SurfaceIR["states"] = {};
  const order: string[] = [];
  const nodes: Record<string, IRNode> = {};
  let surfaceId: string | null = null;
  let title: string | undefined;
  let fallback: string | undefined;
  let rootId: string | undefined;
  let ended = false;

  // 预扫描 ui.for:循环变量先注册为 item 伪符号,表达式里的标识符才能解析。
  for (const forMatch of source.matchAll(/ui\.for\(\s*"(?:[^"\\]|\\.)*"\s*,\s*"([^"\\]+)"\s*\)/g)) {
    const varName = forMatch[1]!;
    if (symbols[varName] == null) symbols[varName] = { key: varName, item: true };
  }

  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index]!;
    if (ended) throw new GenUiError("ui.end() 之后不允许再有语句", statement.line);
    if (index === 0) {
      if (!statement.text.startsWith("ui.surface(")) throw new GenUiError("第一条语句必须是 ui.surface(...)", statement.line);
      const args = callArgs(statement, /^ui\.surface\(/);
      surfaceId = parseStringLiteral(args[0] ?? "", statement.line);
      if (args[1] != null) {
        for (const [key, value] of objectEntries(args[1]!, statement.line)) {
          if (key === "root") rootId = parseStringLiteral(value, statement.line);
          else if (key === "title") title = parseStringLiteral(value, statement.line);
          else if (key === "fallback") fallback = parseStringLiteral(value, statement.line);
          else throw new GenUiError(`ui.surface 不支持选项 ${key}`, statement.line);
        }
      }
      continue;
    }
    const stateMatch = new RegExp(`^const\\s+(${IDENT})\\s*=\\s*ui\\.state\\(`).exec(statement.text);
    if (stateMatch != null) {
      const symbol = stateMatch[1]!;
      const inner = statement.text.slice(statement.text.indexOf("(", stateMatch[0].length - 1) + 1, statement.text.lastIndexOf(")"));
      const args = splitTop(inner, statement.line);
      const key = parseStringLiteral(args[0] ?? "", statement.line);
      const type = parseStringLiteral(args[1] ?? "", statement.line) as StateType;
      if (!["string", "number", "integer", "boolean", "list"].includes(type)) {
        throw new GenUiError(`不支持的状态类型 ${type}`, statement.line);
      }
      if (args[2] == null || args.length > 3) throw new GenUiError("ui.state(key, type, initial) 需要 3 个参数", statement.line);
      const initial: StateValue = type === "string"
        ? parseStringLiteral(args[2]!, statement.line)
        : type === "boolean"
          ? args[2]!.trim() === "true" ? true : args[2]!.trim() === "false" ? false : (() => { throw new GenUiError("boolean 初始值必须是 true/false", statement.line); })()
          : type === "list"
            ? (() => {
              const raw = args[2]!.trim();
              if (!/^\[\s*(?:"(?:[^"\\]|\\.)*"\s*,?\s*)*\]$/.test(raw)) throw new GenUiError("list 初始值必须是字符串数组", statement.line);
              return raw.length > 2
                ? raw.slice(1, -1).split(",").map((item) => parseStringLiteral(item.trim(), statement.line)).filter((item) => item !== "")
                : [];
            })()
            : Number(args[2]!.trim());
      if (type === "integer" && !(typeof initial === "number" && Number.isSafeInteger(initial) && initial >= 0)) {
        throw new GenUiError("integer 初始值必须是安全整数", statement.line);
      }
      if (type === "number" && !(typeof initial === "number" && Number.isFinite(initial))) throw new GenUiError("number 初始值必须是有限数", statement.line);
      if (symbols[symbol] != null || Object.hasOwn(states, key)) throw new GenUiError(`重复的状态声明 ${symbol}/${key}`, statement.line);
      symbols[symbol] = { key, type };
      states[key] = { type, initial };
      continue;
    }
    if (statement.text.startsWith("ui.node(")) {
      const args = callArgs(statement, /^ui\.node\(/);
      const id = parseStringLiteral(args[0] ?? "", statement.line);
      if (args.length !== 2) throw new GenUiError("ui.node(id, <Component ... />) 需要 2 个参数", statement.line);
      const jsx = parseJsxNode(args[1]!, symbols, statement.line);
      if (!(jsx.type in CATALOG)) throw new GenUiError(`未知组件类型:${jsx.type}`, statement.line);
      if (nodes[id] != null || order.includes(id)) throw new GenUiError(`重复的节点 id ${id}`, statement.line);
      const { repeat: repeatProp, ...props } = jsx.props;
      const repeat = repeatProp?.kind === "repeat" ? { source: repeatProp.source, as: repeatProp.as } : undefined;
      if (repeatProp != null && repeat == null) throw new GenUiError("repeat 只能是 ui.for(...)", statement.line);
      nodes[id] = { id, type: jsx.type, props, line: statement.line, repeat };
      order.push(id);
      continue;
    }
    const deriveMatch = new RegExp(`^const\\s+(${IDENT})\\s*=\\s*ui\\.derive\\(([\\s\\S]+)\\)$`).exec(statement.text);
    if (deriveMatch != null) {
      // 派生态:编译期按声明顺序内联进引用它的表达式(只出不进,天然无环)。
      const symbol = deriveMatch[1]!;
      if (symbols[symbol] != null) throw new GenUiError(`重复的声明 ${symbol}`, statement.line);
      const expr = parseExpression(deriveMatch[2]!, symbols, statement.line);
      symbols[symbol] = { key: symbol, derived: true, expr };
      continue;
    }
    if (statement.text.startsWith("ui.end(")) {
      if (!/^ui\.end\(\s*\)$/.test(statement.text)) throw new GenUiError("ui.end() 不接受参数", statement.line);
      ended = true;
      continue;
    }
    if (/^ui\.(set|reset|followUp|copy|openLink|append|remove)\(/.test(statement.text)) {
      throw new GenUiError("动作只能作为事件值(如 onPress)出现", statement.line);
    }
    throw new GenUiError(`无法识别的语句:${statement.text}`, statement.line);
  }

  if (surfaceId == null) throw new GenUiError("缺少 ui.surface(...)");
  // final=false(流式部分编译):允许缺 ui.end,先渲染已到齐的语句。
  if (!ended && options.final !== false) throw new GenUiError("缺少 ui.end()");
  if (order.length > MAX_NODES) throw new GenUiError(`节点数超过预算(${MAX_NODES})`);
  return { irVersion: IR_VERSION, surfaceId, title, fallback, rootId, states, order, nodes };
}

/** 对象字面量顶层键值切分;键允许 IDENT 或带引号字符串(followUp 标签可中文)。 */
function objectEntries(text: string, line: number): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  const stripped = text.trim().replace(/^\{/, "").replace(/\}$/, "");
  const keyPattern = `(?:"((?:[^"\\\\]|\\\\.)*)"|(${IDENT}))\\s*:\\s*([\\s\\S]+)$`;
  for (const part of splitTop(stripped, line)) {
    const match = new RegExp(`^${keyPattern}`).exec(part.trim());
    if (match == null) throw new GenUiError(`无法解析选项:${part}`, line);
    entries.push([match[1] ?? match[2]!, match[3]!]);
  }
  return entries;
}
