/**
 * 壳引导入口 —— 双根形态(shell 包 + 用户组件根)下唯一的 package.json main。
 *
 * 职责单一:选出组件根,把真正的 main 加载进来,自己不做任何业务。
 *
 * 解析顺序:
 *   1. QAQH_APP_DIR —— dev/测试显式指定,最高优先级;
 *   2. 用户组件根 ~/.local/share/QAQ-Harness/app —— updater 热通道落盘处,
 *      仅打包形态生效(app.isPackaged),dev 不让本机残留 overlay 干扰开发;
 *   3. baseline —— electron 加载的 app 根(app.getAppPath()),即系统包出厂快照。
 *
 * 选中后设置 QAQH_APP_DIR,真正的 main(和 renderer 解析、preload 相对路径)
 * 都以组件根为基准。updater 的 apply-staged 语义保证应用时进程已退出,
 * 这里不做暂存区状态机——那是 qaqh-maint/updater 的职责。
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";

const MAIN_MODULE = join("dist", "main", "index.cjs");

interface ElectronAppLike {
  readonly isPackaged: boolean;
  getAppPath(): string;
}

function electronApp(): ElectronAppLike | null {
  // 打包形态的判定只能用 app.isPackaged:process.isPackaged 在 Electron 运行时
  // 并不存在(实测为 undefined)。bootstrap 也可能被裸 Node 加载,此时
  // require("electron") 拿到的是 npm 包导出的路径字符串而非 app 对象。
  try {
    const electron = require("electron") as unknown;
    const app = (electron as { app?: unknown }).app;
    if (
      typeof (app as ElectronAppLike | undefined)?.isPackaged === "boolean" &&
      typeof (app as ElectronAppLike).getAppPath === "function"
    ) {
      return app as ElectronAppLike;
    }
  } catch {
    // 裸 Node 或异常环境,走文件系统回退。
  }
  return null;
}

function hasMain(root: string): boolean {
  return existsSync(join(root, MAIN_MODULE));
}

function userComponentRoot(): string | null {
  const app = electronApp();
  if (app == null || !app.isPackaged) return null;
  const candidate = join(homedir(), ".local", "share", "QAQ-Harness", "app");
  return hasMain(candidate) ? candidate : null;
}

function resolveComponentRoot(): string {
  const fromEnv = process.env.QAQH_APP_DIR?.trim();
  if (fromEnv !== "" && fromEnv != null && hasMain(fromEnv)) return fromEnv;
  const overlay = userComponentRoot();
  if (overlay != null) return overlay;
  // app.getAppPath() 在 dev 返回工程根、打包形态返回 <resources>/app(含 app.asar
  // 形态),两种布局都直接是组件根,无需按 isPackaged 自己推算相对层级。
  const app = electronApp();
  if (app != null) return app.getAppPath();
  // 裸 Node 从 <工程根>/dist/ 加载本文件,组件根(package.json + dist/main 所在)
  // 就是上一级。注意 electron 两种形态也同为上一级,差异本可忽略;保留 getAppPath
  // 优先是因为它对 asar 形态同样成立。
  return join(__dirname, "..");
}

const root = resolveComponentRoot();
process.env.QAQH_APP_DIR = root;
// eslint-disable-next-line no-console -- 引导期唯一日志,排查"到底加载了哪个根"用的
console.log(`[bootstrap] component root: ${root}`);
createRequire(join(root, "package.json"))("./dist/main/index.cjs");
