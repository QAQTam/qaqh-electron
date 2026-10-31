import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { userComponentRoot } from "./component-paths.js";

type ComponentName = "frontend" | "backend";
interface ComponentState { current: string; version: string; health?: string }
interface InstalledState { components?: Partial<Record<ComponentName, ComponentState>> }
interface BaselineComponent { buildId: string; version: string; bundle: string; sha256: string }
interface BaselineIndex {
  formatVersion: 1;
  components: Record<ComponentName, BaselineComponent>;
}
export interface OverlaySelection { frontend: boolean; backend: boolean }
export interface BaselineOptions {
  packaged: boolean;
  resourcesPath: string;
  appPath: string;
}
const RECEIPT = "baseline-receipt.json";

function readJson<T>(file: string): T | null {
  try { return JSON.parse(readFileSync(file, "utf8")) as T; }
  catch { return null; }
}

/** Compare numeric versions and optional numeric prereleases; never order git hashes. */
export function compareReleaseVersions(left: string, right: string): number | null {
  if (typeof left !== "string" || typeof right !== "string") return null;
  const pattern = /^(\d+(?:\.\d+)*)(?:-(\d+))?$/;
  const l = pattern.exec(left), r = pattern.exec(right);
  if (!l || !r) return null;
  const a = l[1].split(".").map(BigInt);
  const b = r[1].split(".").map(BigInt);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const x = a[index] ?? 0n, y = b[index] ?? 0n;
    if (x !== y) return x > y ? 1 : -1;
  }
  if (l[2] === r[2]) return 0;
  // 无后缀表示正式版，高于同核心版本的数字预发布版。
  if (l[2] === undefined) return 1;
  if (r[2] === undefined) return -1;
  const x = BigInt(l[2]), y = BigInt(r[2]);
  return x === y ? 0 : x > y ? 1 : -1;
}

function componentPresent(root: string, name: ComponentName): boolean {
  return name === "frontend"
    ? ["package.json", "dist/main/index.cjs", "dist/preload/index.cjs", "renderer/index.html"]
        .every(file => existsSync(join(root, "app", file)))
    : existsSync(join(root, "backend", process.platform === "win32" ? "qaqh-daemon.exe" : "qaqh-daemon"));
}

export function needsBaseline(
  installed: ComponentState | undefined, baseline: BaselineComponent,
  previousBaseline: string | undefined, present: boolean,
): boolean {
  if (!present || !installed || installed.health === "failed") return true;
  const order = compareReleaseVersions(installed.version, baseline.version);
  if (order === null || order < 0) return true;
  if (order > 0 || installed.current === baseline.buildId) return false;
  // Same-version builds have no chronological order. A changed system baseline
  // wins once; subsequent hot updates survive while that baseline is unchanged.
  return previousBaseline !== baseline.buildId;
}

/** Runs synchronously in the SYSTEM bootstrap, before requiring any user main.
 * Only the single-instance lock holder may call this. Failure disables both
 * overlays for this launch; the next launch retries instead of trusting residue.
 */
export function reconcileBaseline(options: BaselineOptions): OverlaySelection {
  const disabled = { frontend: false, backend: false };
  if (!options.packaged) return disabled;
  const root = userComponentRoot();
  let state = readJson<InstalledState>(join(root, "install-state.json"));
  const indexPath = join(options.resourcesPath, "baseline", "baseline.json");
  if (!existsSync(indexPath)) {
    if (existsSync(join(options.resourcesPath, "baseline"))) {
      console.warn("[baseline] missing baseline index; refusing unverified user overlays");
      return disabled;
    }
    // Portable/full packages have no seeding payload. Do not let an old shell
    // overlay silently shadow a newer full package either.
    const pkg = readJson<{ version: string }>(join(options.appPath, "package.json"));
    const usable = (name: ComponentName) => {
      const installed = state?.components?.[name];
      const order = pkg && installed ? compareReleaseVersions(installed.version, pkg.version) : null;
      return order !== null && order >= 0 && installed?.health !== "failed" && componentPresent(root, name);
    };
    return { frontend: usable("frontend"), backend: usable("backend") };
  }
  try {
    const index = readJson<BaselineIndex>(indexPath);
    if (index?.formatVersion !== 1) throw new Error("invalid baseline index");
    const receipt = readJson<Partial<Record<ComponentName, string>>>(join(root, RECEIPT)) ?? {};
    const decisions: Array<[ComponentName, BaselineComponent, boolean]> = [];
    for (const name of ["frontend", "backend"] as const) {
      const baseline = index.components[name];
      const expectedBundle = name === "frontend" ? "app.zip" : "backend.zip";
      if (!baseline || baseline.bundle !== expectedBundle || !baseline.buildId ||
          compareReleaseVersions(baseline.version, baseline.version) === null || !/^[a-f0-9]{64}$/.test(baseline.sha256)) {
        throw new Error(`invalid ${name} baseline metadata`);
      }
      decisions.push([name, baseline, needsBaseline(state?.components?.[name], baseline, receipt[name], componentPresent(root, name))]);
    }
    // Check every selected payload before modifying either component.
    for (const [, baseline, needed] of decisions) {
      if (!needed) continue;
      const digest = createHash("sha256").update(readFileSync(join(options.resourcesPath, "baseline", baseline.bundle))).digest("hex");
      if (digest !== baseline.sha256) throw new Error(`baseline checksum mismatch: ${baseline.bundle}`);
    }
    for (const [name, baseline, needed] of decisions) {
      if (!needed) continue;
      if (process.env.QAQH_BASELINE_SEED === "0") return disabled;
      const maint = process.env.QAQH_MAINT_BIN?.trim() || join(options.resourcesPath, "bin", "qaqh-maint");
      execFileSync(maint, ["unpack", join(options.resourcesPath, "baseline", baseline.bundle), root], {
        timeout: 120_000, stdio: "pipe",
      });
      state = readJson<InstalledState>(join(root, "install-state.json"));
      if (state?.components?.[name]?.current !== baseline.buildId || !componentPresent(root, name)) {
        throw new Error(`baseline installation incomplete: ${name}`);
      }
      console.log(`[baseline] reconciled ${name} -> ${baseline.buildId}`);
    }
    const nextReceipt = Object.fromEntries(decisions.map(([name, baseline]) => [name, baseline.buildId]));
    const receiptPath = join(root, RECEIPT);
    if (JSON.stringify(receipt) !== JSON.stringify(nextReceipt)) {
      const temporary = `${receiptPath}.${process.pid}.new`;
      writeFileSync(temporary, JSON.stringify(nextReceipt));
      renameSync(temporary, receiptPath);
    }
    return { frontend: true, backend: true };
  } catch (error) {
    console.warn("[baseline] reconciliation failed; using packaged app/backend for this launch:", error);
    return disabled;
  }
}
