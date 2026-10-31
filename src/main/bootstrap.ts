/** System-owned entrypoint: reconcile writable components BEFORE loading main.
 * Business code in an old user overlay must never decide whether it is stale.
 */
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { reconcileBaseline } from "./baseline.js";
import { userComponentRoot } from "./component-paths.js";

interface ElectronAppLike {
  readonly isPackaged: boolean;
  getAppPath(): string;
  requestSingleInstanceLock(): boolean;
  quit(): void;
}

function electronApp(): ElectronAppLike | null {
  try {
    const electron = require("electron") as { app?: ElectronAppLike };
    if (typeof electron.app?.isPackaged === "boolean") return electron.app;
  } catch { /* Plain Node: use the project root. */ }
  return null;
}

function start(): void {
  const app = electronApp();
  // Never unpack into files used by an already running shell. Electron delivers
  // second-instance to the owner, whose business main raises the window.
  if (app?.isPackaged && !app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  const packagedRoot = app?.getAppPath() ?? join(__dirname, "..");
  const componentRoot = userComponentRoot();
  process.env.QAQH_COMPONENT_ROOT = componentRoot;
  const fromEnv = process.env.QAQH_APP_DIR?.trim();
  // Detached updater/relaunch inherits our output environment. That output is
  // NOT an explicit override on the next launch, which must reconcile again.
  const explicit = fromEnv && fromEnv !== process.env.QAQH_RESOLVED_APP_DIR &&
    fromEnv !== join(componentRoot, "app") && fromEnv !== packagedRoot &&
    existsSync(join(fromEnv, "dist/main/index.cjs")) ? fromEnv : null;
  if (!explicit && app?.isPackaged && process.platform === "linux" && process.resourcesPath) {
    const maint = join(process.resourcesPath, "bin", "qaqh-maint");
    const hasShellBaseline = existsSync(join(process.resourcesPath, "baseline"));
    const hasActiveSnapshot = existsSync(join(componentRoot, "active.json"));
    if (hasShellBaseline && hasActiveSnapshot && existsSync(maint)) {
      try {
        const result = execFileSync(maint, ["inspect", "--root", componentRoot, "--json"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 5_000,
        });
        const state = JSON.parse(result) as { state?: { installed?: boolean; current?: string | null; pending?: { operationId?: string } | null } };
        if (state.state?.current) {
          const boot = execFileSync(maint, ["begin-boot", "--root", componentRoot, "--json"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 5_000,
          });
          const bootState = JSON.parse(boot) as { state?: { current?: string | null; pendingOperation?: { operationId?: string } | null } };
          const generationId = bootState.state?.current;
          if (generationId) {
            const generationRoot = join(componentRoot, "generations", generationId);
            const generationApp = join(generationRoot, "app");
            const generationBackend = join(generationRoot, "backend");
            if (!existsSync(join(generationApp, "dist/main/index.cjs")) ||
                !existsSync(join(generationBackend, "qaqh-daemon"))) {
              throw new Error(`active generation ${generationId} is missing required entrypoints`);
            }
            process.env.QAQH_ACTIVE_GENERATION = generationRoot;
            process.env.QAQH_APP_DIR = generationApp;
            process.env.QAQH_USE_USER_BACKEND = "1";
            process.env.QAQH_RESOLVED_APP_DIR = generationApp;
            process.env.QAQH_PENDING_OPERATION =
              bootState.state?.pendingOperation?.operationId ?? "";
            createRequire(join(generationApp, "package.json"))("./dist/main/index.cjs");
            return;
          }
        }
      } catch (error) {
        console.warn("[bootstrap] registered generation recovery failed; falling back to baseline reconciliation:", error);
      }
    }
  }
  const selected = explicit
    ? { frontend: false, backend: false }
    : reconcileBaseline({
        packaged: app?.isPackaged ?? false,
        resourcesPath: process.resourcesPath ?? "",
        appPath: packagedRoot,
      });
  const root = explicit || (selected.frontend ? join(componentRoot, "app") : packagedRoot);
  process.env.QAQH_USE_USER_BACKEND = selected.backend ? "1" : "0";
  process.env.QAQH_APP_DIR = root;
  process.env.QAQH_RESOLVED_APP_DIR = explicit ? "" : root;
  console.log(`[bootstrap] component root: ${root}; user backend: ${selected.backend}`);
  createRequire(join(root, "package.json"))("./dist/main/index.cjs");
}

start();
