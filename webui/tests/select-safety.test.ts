import { describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import { toSafeKey } from "../src/ui/Select";
import { FONT_PRESETS } from "../src/lib/typography";

describe("Select 组件抗异常与安全隔离测试", () => {
  const window = new Window();
  const document = window.document;

  it("原始字体预设若直接作为 data-key 插入 querySelector 会抛出致命 DOMException", () => {
    // 验证根因：FONT_PRESETS 中的字体带字面量双引号（如 '"PingFang SC", system-ui'）
    const pingfang = FONT_PRESETS.ui.find((f) => f.label.includes("苹方"))!.value;
    expect(pingfang).toContain('"');

    // 直接插模板串会导致属性选择器双引号闭合错误，抛出 DOMException
    expect(() => {
      document.querySelector(`[data-key="${pingfang}"]`);
    }).toThrow(/DOMException|not a valid selector/i);
  });

  it("经 toSafeKey 处理后，所有预设字体均生成合法的 CSS 属性选择器且不抛异常", () => {
    const allPresets = [
      ...FONT_PRESETS.ui,
      ...FONT_PRESETS.prose,
      ...FONT_PRESETS.code,
      ...FONT_PRESETS.terminal,
    ];

    expect(allPresets.length).toBeGreaterThan(15);

    allPresets.forEach((preset, idx) => {
      const safeKey = toSafeKey(preset.value, idx);

      // 验证 key 中绝对不包含任何双引号、单引号、反斜杠、空格或逗号
      expect(safeKey).not.toMatch(/["'\\,\s]/);

      // 创建测试 DOM 节点并注入安全 key
      const el = document.createElement("li");
      el.setAttribute("data-key", safeKey);
      document.body.appendChild(el);

      // 执行 querySelector 必须安全且精准命中对应节点，绝不抛出 DOMException
      expect(() => {
        const found = document.querySelector(`[data-key="${safeKey}"]`);
        expect(found).toBe(el);
      }).not.toThrow();

      el.remove();
    });
  });

  it("用户自定义字体含引号、特殊字符与长空格时也能安全转义", () => {
    const dangerousInputs = [
      `"JetBrains Mono", 'Courier New'`,
      `'Comic Sans MS'\\weird`,
      `[hack]="malicious"`,
      `   spaced    font   `,
      `""`,
    ];

    dangerousInputs.forEach((input, idx) => {
      const safeKey = toSafeKey(input, idx);
      expect(safeKey).not.toMatch(/["'\\,\s]/);

      const el = document.createElement("div");
      el.setAttribute("data-key", safeKey);
      document.body.appendChild(el);

      expect(() => {
        const found = document.querySelector(`[data-key="${safeKey}"]`);
        expect(found).toBe(el);
      }).not.toThrow();

      el.remove();
    });
  });

  it("跨平台通用交互层定义了 Select/Switch/Tooltip 的基础视觉与不透明度", async () => {
    const fs = await import("fs/promises");
    const path = await import("path");

    const controlsCss = await fs.readFile(
      path.resolve(__dirname, "../src/styles/components/controls.css"),
      "utf-8"
    );
    const tokensBaseCss = await fs.readFile(
      path.resolve(__dirname, "../src/styles/tokens/base.css"),
      "utf-8"
    );
    const appCss = await fs.readFile(
      path.resolve(__dirname, "../src/styles/app.css"),
      "utf-8"
    );

    // 1. app.css 引入了通用 controls.css
    expect(appCss).toContain('@import "./components/controls.css";');

    // 2. base tokens 声明了跨平台浮层背景色与边框色（非 Windows 专有）
    expect(tokensBaseCss).toContain("--flyout-bg: var(--surface);");
    expect(tokensBaseCss).toContain("--stroke-control: var(--border-strong);");

    // 3. 通用 controls.css 包含未加平台选择器限制的 .select-content 实体背景与容器样式，杜绝背景穿透与重叠
    expect(controlsCss).toMatch(/\.select-content\s*\{[^}]*background:\s*var\(--flyout-bg/);
    expect(controlsCss).toMatch(/\.select-content\s*\{[^}]*border:\s*1px solid/);
    expect(controlsCss).toMatch(/\.select-content\s*\{[^}]*box-shadow:/);
    expect(controlsCss).toMatch(/\.select-content\s*\{[^}]*z-index:\s*1000/);

    // 4. .select-trigger 包含左右两端对齐与弹性布局
    expect(controlsCss).toMatch(/\.select-trigger\s*\{[^}]*display:\s*flex/);
    expect(controlsCss).toMatch(/\.select-trigger\s*\{[^}]*justify-content:\s*space-between/);

    // 5. .select-item 重置焦点边框，杜绝浏览器默认 focus ring 破坏视觉
    expect(controlsCss).toMatch(/\.select-item:focus-visible\s*\{[^}]*outline:\s*none/);
  });
});
