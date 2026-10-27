/**
 * 应用内截图的前端口径（`src/lib/screenshot.ts`）。
 *
 * 截图动作本身在宿主（macOS `screencapture`，那边有 Rust 单测钉旗标）。这里钉的
 * 是三条最容易坏、又只能在前端坏的：键位判定、可用性判定、三种结局不互相冒充。
 */
import { describe, expect, it } from "vitest";

import {
  isScreenshotShortcut,
  screenshotSupported,
  takeScreenshot,
  type ShortcutProbe,
  type ShotDeps,
} from "../src/lib/screenshot";
import type { ScreenshotWire } from "../src/lib/transport/backend";

const key = (over: Partial<ShortcutProbe> = {}): ShortcutProbe => ({
  key: "s",
  ctrlKey: false,
  metaKey: true,
  shiftKey: true,
  altKey: false,
  ...over,
});

describe("截图键位（⌘⇧S）", () => {
  it("⌘⇧S / Ctrl+Shift+S 都算，大小写无关", () => {
    expect(isScreenshotShortcut(key())).toBe(true);
    expect(isScreenshotShortcut(key({ key: "S" }))).toBe(true);
    expect(isScreenshotShortcut(key({ metaKey: false, ctrlKey: true }))).toBe(true);
  });

  it("少了 Shift 就不是：⌘S 留给以后的「保存」", () => {
    expect(isScreenshotShortcut(key({ shiftKey: false }))).toBe(false);
  });

  it("没有修饰键就不是：输入框里打 s 不该触发截图", () => {
    expect(isScreenshotShortcut(key({ metaKey: false, shiftKey: true }))).toBe(false);
    expect(isScreenshotShortcut(key({ metaKey: false, ctrlKey: false }))).toBe(false);
  });

  it("授权门控:预检不过 → permission 结局,且**不调用**取图(黑图根本不该产生)", async () => {
    let captured = 0;
    const outcome = await takeScreenshot("selection", {
      capture: () => {
        captured += 1;
        return Promise.resolve({ path: "/tmp/x.png", name: "x.png", size: 1 });
      },
      ensureScreenRecording: () => Promise.resolve(false),
    });
    expect(outcome).toEqual({ kind: "permission" });
    expect(captured).toBe(0);
  });

  it("授权门控:宿主预检(SCREEN_RECORDING_REQUIRED 标记)也归并为 permission", async () => {
    const outcome = await takeScreenshot("selection", {
      capture: () => Promise.reject(new Error("SCREEN_RECORDING_REQUIRED::需要屏幕录制权限")),
      ensureScreenRecording: () => Promise.resolve(true),
    });
    expect(outcome).toEqual({ kind: "permission" });
  });

  it("授权门控:预检本身抛错 → fail-open,照常取图", async () => {
    const outcome = await takeScreenshot("selection", {
      capture: () => Promise.resolve({ path: "/tmp/x.png", name: "x.png", size: 1 }),
      ensureScreenRecording: () => Promise.reject(new Error("plugin down")),
    });
    expect(outcome.kind).toBe("captured");
  });


  it("带 Alt 不占用，按住连发也不连拍", () => {
    expect(isScreenshotShortcut(key({ altKey: true }))).toBe(false);
    expect(isScreenshotShortcut(key({ repeat: true }))).toBe(false);
  });

  it("别的字母不接管", () => {
    expect(isScreenshotShortcut(key({ key: "t" }))).toBe(false);
    expect(isScreenshotShortcut(key({ key: "3" }))).toBe(false);
  });
});

describe("可用性（决定按钮出不出）", () => {
  const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
  const windows = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

  it("只有桌面壳里的 mac 才有系统截图面", () => {
    expect(screenshotSupported({ inTauri: true, userAgent: mac })).toBe(true);
    expect(screenshotSupported({ inTauri: true, userAgent: windows })).toBe(false);
    // 浏览器预览（无宿主）也算不可用：那里连 `screencapture` 都调不到。
    expect(screenshotSupported({ inTauri: false, userAgent: mac })).toBe(false);
  });

  it("拿不到 UA（非浏览器环境）按不可用处理，而不是猜一个", () => {
    expect(screenshotSupported({ inTauri: true, userAgent: "" })).toBe(false);
  });
});

describe("一次截图的三种结局", () => {
  const shot: ScreenshotWire = {
    path: "/var/folders/x/T/qaqh-shot-1.png",
    name: "qaqh-shot-1.png",
    size: 20480,
  };

  const run = (capture: ShotDeps["capture"]) => takeScreenshot("selection", { capture });

  it("拿到文件 → captured，路径原样带给附件面", async () => {
    await expect(run(async () => shot)).resolves.toEqual({ kind: "captured", shot });
  });

  it("宿主回 null = 取消，**不是**失败", async () => {
    await expect(run(async () => null)).resolves.toEqual({ kind: "cancelled" });
  });

  it("宿主抛错 = 失败，且把原因带出来（否则用户只看到一个孤零零的「截图失败」）", async () => {
    const outcome = await run(async () => {
      throw new Error("应用内截图目前只在 macOS 提供");
    });
    expect(outcome.kind).toBe("failed");
    expect(outcome.kind === "failed" && outcome.message).toContain("macOS");
  });

  it("有对象却没有路径 = 自相矛盾的宿主结果，按失败出声而不是当取消", async () => {
    const outcome = await run(async () => ({ ...shot, path: "   " }));
    expect(outcome.kind).toBe("failed");
  });

  it("mode 原样透传：选区与整屏的区别不该在这一层丢", async () => {
    const seen: string[] = [];
    const deps: ShotDeps = {
      capture: (mode) => {
        seen.push(mode);
        return Promise.resolve(shot);
      },
    };
    await takeScreenshot("fullscreen", deps);
    await takeScreenshot("selection", deps);
    expect(seen).toEqual(["fullscreen", "selection"]);
  });
});
