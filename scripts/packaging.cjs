const { existsSync, statSync, readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const { createHash } = require("node:crypto");

const requiredFiles = ["renderer/index.html", "resources/bin/qaqh-daemon",
  "dist/main/index.cjs", "dist/preload/index.cjs"];

function parseArgs(args) {
  const options = { target: "all", skipInstall: false, skipBackend: false, help: false, shell: false };
  let targetSeen = false;
  for (const arg of args) {
    if (arg === "--skip-install") options.skipInstall = true;
    else if (arg === "--skip-backend") options.skipBackend = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--shell") options.shell = true;
    else if (!targetSeen && ["all", "dir", "AppImage", "deb", "tar.gz"].includes(arg)) {
      options.target = arg;
      targetSeen = true;
    } else throw new Error(`Unknown target/option: ${arg}. Use --help.`);
  }
  return options;
}

/**
 * The canonical build identity is produced by `just` once and exported to every
 * stage. Node must not invent its own date/version here: a packaging run that
 * bypasses just would otherwise silently produce a differently-versioned app.
 * @param {NodeJS.ProcessEnv} env
 */
function parseBuildIdentity(env = process.env) {
  const version = String(env.QAQH_BUILD_VERSION ?? "").trim();
  const date = String(env.QAQH_BUILD_DATE ?? "").trim();
  const commit = String(env.QAQH_GIT_COMMIT ?? "").trim();
  const dirty = String(env.QAQH_GIT_DIRTY ?? "") === "1";
  const match = /^\d+\.\d+\.(\d{8})(?:-\d+)?$/.exec(version);
  if (!match) {
    throw new Error("QAQH_BUILD_VERSION must be major.minor.YYYYMMDD[-revision]; run `just build`.");
  }
  if (date !== "" && !/^\d{8}$/.test(date)) {
    throw new Error(`QAQH_BUILD_DATE must be YYYYMMDD; got ${date}.`);
  }
  if (date !== "" && date !== match[1]) {
    throw new Error("QAQH_BUILD_VERSION (" + version + ") and QAQH_BUILD_DATE (" +
      date + ") disagree; run `just build`.");
  }
  if (commit === "") throw new Error("QAQH_GIT_COMMIT is missing; run `just build`.");
  return { version, date: date || match[1], commit, dirty };
}

/**
 * electron-builder writes the injected version into the packaged package.json.
 * afterPack therefore compares against the injected value, not the source
 * manifest, since explicit build overrides may carry a different revision.
 */
function expectedPackageVersion(sourceVersion, env = process.env) {
  const injected = String(env.QAQH_BUILD_VERSION ?? "").trim();
  if (injected !== "" && !/^\d+\.\d+\.\d{8}(?:-\d+)?$/.test(injected)) {
    throw new Error(`Invalid injected package version: ${injected}.`);
  }
  return injected || sourceVersion;
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

module.exports = {
  parseArgs,
  parseBuildIdentity,
  expectedPackageVersion,
  assertInputs,
  walkFiles,
  digest,
};
