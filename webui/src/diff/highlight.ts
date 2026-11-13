/**
 * Diff 语法高亮宿主:shiki 生命周期 + 主题解析(内置 github 对 + 插件主题包)。
 *
 * 从 DiffView 抽出独立模块:渲染器只管行/开窗,高亮器单例、语言懒加载、
 * 插件主题 fetch/loadTheme 全在这里,可单测(真实 shiki core,node 环境即跑)。
 *
 * 主题名纪律:shiki 按注册名寻址。内置对注册名是 github-light/github-dark,
 * 界面 mode 是 light/dark——必须经 BUILTIN_THEME 映射,直接把 mode 当主题名
 * 会 throw 并静默退纯文本(历史 bug,本模块立此存照)。
 *
 * 插件主题包(slot=syntax-theme):manifest 带 light/dark 两份 shiki 主题 JSON,
 * 经 app:// 同源 fetch,注册名含 rev——热更推进 rev 即换名重载,不吃旧缓存。
 * 插件资产加载失败回退内置对(高亮不因一个坏包全灭),失败仍 throw 给渲染层
 * 走 §9.4 纯文本兜底。
 */
import type { SyntaxPackRef } from "../plugins/loader";

export type Tokens = Array<Array<{ content: string; color?: string }>>;

/** 超过该改动行数默认折叠(§9.5 大 diff);展开后走虚拟开窗,只挂可见行。 */
const LANG_IMPORTS: Record<string, () => Promise<unknown>> = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
};

/** 界面 mode → 内置 shiki 注册名。直 import 两份主题,不走 shiki/themes barrel
 *  (barrel 会把 60+ 个用不到的主题全切成 chunk 打进产物)。 */
const BUILTIN_THEME: Record<"light" | "dark", string> = {
  light: "github-light",
  dark: "github-dark",
};

interface Highlighter {
  codeToTokens: (code: string, opts: { lang: string; theme: string }) => { tokens: Tokens };
  loadLanguage: (input: unknown) => Promise<void>;
  getLoadedLanguages: () => string[];
  loadTheme: (input: unknown) => Promise<void>;
  getLoadedThemes: () => string[];
}

let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
  if (highlighterPromise == null) {
    // shiki/core + JS 引擎:全量入口会把所有语言和 wasm 打进产物;这里按需。
    // 亮/暗两套主题同时注册:主题切换只换 codeToTokens 的 theme 参数,
    // 不重建 highlighter(重建会丢已加载的语言)。
    highlighterPromise = (async () => {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, githubLight, githubDark] = await Promise.all([
        import("shiki/core"),
        import("shiki/engine/javascript"),
        import("shiki/themes/github-light.mjs"),
        import("shiki/themes/github-dark.mjs"),
      ]);
      return createHighlighterCore({
        themes: [githubLight.default, githubDark.default],
        langs: [],
        engine: createJavaScriptRegexEngine({ forgiving: true }),
      }) as unknown as Highlighter;
    })();
  }
  return highlighterPromise;
}

/** 插件主题注册名:含 rev,热更即换名重载。 */
function packThemeName(pack: SyntaxPackRef, mode: "light" | "dark"): string {
  return `qaqh:${pack.id}:${mode}:${pack.rev}`;
}

async function resolveTheme(
  highlighter: Highlighter,
  mode: "light" | "dark",
  pack: SyntaxPackRef | null,
): Promise<string> {
  if (pack == null) return BUILTIN_THEME[mode];
  const name = packThemeName(pack, mode);
  if (highlighter.getLoadedThemes().includes(name)) return name;
  try {
    const url = mode === "dark" ? pack.dark : pack.light;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const theme = (await response.json()) as Record<string, unknown>;
    await highlighter.loadTheme({ ...theme, name });
    return name;
  } catch (error) {
    // 坏包不拖垮高亮:回退内置对,下一帧 graph 会把失配包撤出目录。
    console.warn(`[highlight] 插件主题 ${pack.id}(${mode}) 加载失败,回退内置:`, error);
    return BUILTIN_THEME[mode];
  }
}

/**
 * 高亮整篇内容,按换行切 token 行。语言未知/加载失败/高亮失败一律 throw,
 * 由渲染层走纯文本兜底(§9.4:不得改变文本与行数)。
 */
export async function highlight(
  content: string,
  lang: string,
  mode: "light" | "dark",
  pack: SyntaxPackRef | null,
): Promise<Tokens> {
  const highlighter = await getHighlighter();
  if (!highlighter.getLoadedLanguages().includes(lang)) {
    const importer = LANG_IMPORTS[lang];
    if (importer == null) throw new Error(`unsupported language: ${lang}`);
    await highlighter.loadLanguage(await importer());
  }
  const theme = await resolveTheme(highlighter, mode, pack);
  return highlighter.codeToTokens(content, { lang, theme }).tokens;
}
