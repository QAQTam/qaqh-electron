import { markPlatform } from "./lib/platform";
import { ensurePrefs } from "./lib/prefs";

markPlatform();

/**
 * 偏好水合门闩:app-shell(应用模块全体)在水合完成后才求值——组件
 * module-eval 期同步读(prefGet)的语义由此保序;桌面壳下这段加载由主窗
 * ready-to-show 之前的 splash 盖住。无宿主环境立即放行。
 */
void ensurePrefs()
  .then(() => import("./app-shell"))
  .catch((error) => {
    // 冷启动竞态:vite 依赖再优化会打断在途的动态导入(错误边界在 app-shell 内,
    // 罩不到导入自身)——静默白屏。自愈:重载一次;sessionStorage 防循环。
    console.error("[boot] app-shell 动态导入失败:", error);
    const key = "qaqh.boot-retry";
    try {
      if (sessionStorage.getItem(key) == null) {
        sessionStorage.setItem(key, "1");
        location.reload();
        return;
      }
      sessionStorage.removeItem(key);
    } catch { /* 无 sessionStorage 的环境直接放弃重试 */ }
  });
