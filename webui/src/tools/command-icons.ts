/**
 * Brand marks used beside shell command summaries. Keep this deliberately small:
 * a missing or ambiguous command should fall back to the regular terminal glyph.
 */
import { parseJsonish } from "../session/reducer";
import type { TimelineToolDisplay } from "../api/qaqh/TimelineToolDisplay";

export interface CommandIcon {
  label: string;
  src: string;
}

const ICONS: Record<string, CommandIcon> = {
  git: { label: "Git", src: new URL("./icons/git.svg", import.meta.url).href },
  pnpm: { label: "pnpm", src: new URL("./icons/pnpm.svg", import.meta.url).href },
  npm: { label: "npm", src: new URL("./icons/npm.svg", import.meta.url).href },
  yarn: { label: "Yarn", src: new URL("./icons/yarn.svg", import.meta.url).href },
  bun: { label: "Bun", src: new URL("./icons/bun.svg", import.meta.url).href },
  rust: { label: "Rust", src: new URL("./icons/rust.svg", import.meta.url).href },
  python: { label: "Python", src: new URL("./icons/python.svg", import.meta.url).href },
  docker: { label: "Docker", src: new URL("./icons/docker.svg", import.meta.url).href },
  github: { label: "GitHub CLI", src: new URL("./icons/github.svg", import.meta.url).href },
  vite: { label: "Vite", src: new URL("./icons/vite.svg", import.meta.url).href },
  bash: { label: "Bash", src: new URL("./icons/bash.svg", import.meta.url).href },
  // PowerShell 用**去底版**的派生文件(见 icons/README.md):Devicon 那张是「浅蓝底版 +
  // 白色箭头」两层叠出来的,取轮廓就是一块实心板,箭头没了。这里只留箭头 + 下划线。
  powershell: { label: "PowerShell", src: new URL("./icons/powershell-glyph.svg", import.meta.url).href },
};

const COMMANDS: Record<string, keyof typeof ICONS> = {
  git: "git",
  pnpm: "pnpm",
  npm: "npm",
  npx: "npm",
  yarn: "yarn",
  bun: "bun",
  bunx: "bun",
  cargo: "rust",
  rustc: "rust",
  rustup: "rust",
  python: "python",
  python3: "python",
  py: "python",
  pip: "python",
  pip3: "python",
  docker: "docker",
  "docker-compose": "docker",
  gh: "github",
  vite: "vite",
  bash: "bash",
  pwsh: "powershell",
  powershell: "powershell",
};

const SHELL_BUILTINS = new Set([
  "cd", "chdir", "pushd", "popd", "pwd", "echo", "printf", "set", "export", "unset",
  "alias", "source", ".", "type", "which", "where", "clear", "exit", "return",
]);
const COMMAND_WRAPPERS = new Set(["sudo", "env", "time", "command", "exec", "nohup", "nice", "corepack"]);

/** Split only at unquoted command operators; this is a display heuristic, not a shell parser. */
function commandSegments(command: string): string[] {
  const result: string[] = [];
  let start = 0;
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!;
    if (escaped) { escaped = false; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote != null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") { quote = char; continue; }
    if (char === ";" || char === "|" || char === "\n" || (char === "&" && command[i + 1] === "&")) {
      result.push(command.slice(start, i));
      if ((char === "|" || char === "&") && command[i + 1] === char) i += 1;
      start = i + 1;
    }
  }
  result.push(command.slice(start));
  return result;
}

/** Read a conservative executable token, including a quoted path. */
function firstWords(segment: string): string[] {
  const words: string[] = [];
  const pattern = /(?:^|\s)(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|`([^`]*)`|([^\s;&|]+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(segment)) != null && words.length < 6) {
    words.push((match[1] ?? match[2]?.replaceAll("''", "'") ?? match[3] ?? match[4] ?? "").replaceAll("\\\"", '"'));
  }
  return words;
}

function commandIcon(command: string): CommandIcon | undefined {
  for (const segment of commandSegments(command)) {
    const words = firstWords(segment);
    let index = 0;
    while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=.*$/.test(words[index]!)) index += 1;
    while (index < words.length && COMMAND_WRAPPERS.has(words[index]!.toLowerCase())) index += 1;
    const word = words[index];
    if (!word) continue;
    const executable = word.split(/[\\/]/).at(-1)!.replace(/\.(?:exe|cmd|bat|ps1)$/i, "").toLowerCase();
    const icon = COMMANDS[executable];
    if (icon) return ICONS[icon];
    // Skip shell built-ins and directory hops to allow a later `&& pnpm ...` command to match.
    if (!SHELL_BUILTINS.has(executable)) continue;
  }
  return undefined;
}

export function toolCommandIcon(
  argsJson: string | undefined,
  display: TimelineToolDisplay | undefined,
): CommandIcon | undefined {
  const args = parseJsonish(argsJson);
  const command = display?.header?.kind === "shell"
    ? display.header.command
    : typeof args?.command === "string" ? args.command : Array.isArray(args?.argv) ? args.argv.map(String).join(" ") : "";
  const executableIcon = command ? commandIcon(command) : undefined;
  if (executableIcon) return executableIcon;

  // Shell type is explicit tool metadata, unlike an inferred command. Use it as a
  // fallback for shell built-ins and scripts that do not begin with a known tool.
  const shell = typeof args?.shell === "string" ? args.shell.toLowerCase() : "";
  return shell === "bash" ? ICONS.bash : ["pwsh", "powershell", "powershell.exe"].includes(shell) ? ICONS.powershell : undefined;
}
