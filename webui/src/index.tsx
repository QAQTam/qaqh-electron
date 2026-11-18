import { markPlatform } from "./lib/platform";
import { ensurePrefs } from "./lib/prefs";

markPlatform();

/**
 * 偏好水合门闩:app-shell(应用模块全体)在水合完成后才求值——组件
 * module-eval 期同步读(prefGet)的语义由此保序;桌面壳下这段加载由主窗
 * ready-to-show 之前的 splash 盖住。无宿主环境立即放行。
 */
void ensurePrefs().then(() => import("./app-shell"));
