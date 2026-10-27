const { existsSync, statSync, readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const { createHash } = require("node:crypto");

const requiredFiles = ["renderer/index.html", "resources/bin/qaqh-daemon",
  "dist/main/index.cjs", "dist/preload/index.cjs"];

function parseArgs(args) {
  const options = { target: "all", skipInstall: false, skipBackend: false, help: false };
  let targetSeen = false;
  for (const arg of args) {
    if (arg === "--skip-install") options.skipInstall = true;
    else if (arg === "--skip-backend") options.skipBackend = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (!targetSeen && ["all", "dir", "AppImage", "deb", "tar.gz"].includes(arg)) {
      options.target = arg;
      targetSeen = true;
    } else throw new Error(`Unknown target/option: ${arg}. Use --help.`);
  }
  return options;
}

function assertInputs(root) {
  for (const file of requiredFiles) {
    const path = join(root, file);
    if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0) {
      throw new Error(`Missing or empty packaging input: ${file}. Run just build dir.`);
    }
  }
  const daemon = join(root, "resources/bin/qaqh-daemon");
  if (!(statSync(daemon).mode & 0o111)) throw new Error("qaqh-daemon is not executable.");
  const header = readFileSync(daemon).subarray(0, 20);
  // ELF64 + little endian + EM_X86_64，防止把 ARM/Windows sidecar 混入 x64 包。
  if (header.length < 20 || header.toString("hex", 0, 4) !== "7f454c46" ||
    header[4] !== 2 || header[5] !== 1 || header.readUInt16LE(18) !== 62) {
    throw new Error("qaqh-daemon must be a Linux x64 ELF executable.");
  }
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (!pkg.author?.name || !pkg.author?.email || !/^https?:\/\//.test(pkg.homepage || "")) {
    throw new Error("Packaging requires author.name, author.email and an HTTP(S) homepage.");
  }
}

function walkFiles(root, prefix = "") {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap(entry => {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return walkFiles(root, name);
    if (!entry.isFile()) throw new Error(`Unsupported symlink/special packaging input: ${name}`);
    return [name];
  });
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

module.exports = { parseArgs, assertInputs, walkFiles, digest };
