// Dev Surface 工具定义（纯数据，无 electron 运行时依赖——node 单测可直接 bundle
// 断言 schema 面与门控形态）。handler 实现见 dev-host/engine.ts。

import type { BrowserToolDef } from "../browser-host/mcp-server.js";

export const devToolDefs: BrowserToolDef[] = [
  {
    name: "ui_snapshot",
    description:
      "开发者模式：对桌面壳主窗口 UI（renderer 自身）做 DOM snapshot，可交互元素带 [uid]。操作自家界面先于 ui_click/ui_type；注意不含内嵌浏览器面板的内部 DOM（那用 browser_snapshot）。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ui_click",
    description: "点击主窗口 UI 中 snapshot 定位的 [uid]（真实鼠标事件序列）。",
    inputSchema: {
      type: "object",
      properties: { uid: { type: "string", description: "ui_snapshot 输出的 [uid]" } },
      required: ["uid"],
    },
  },
  {
    name: "ui_type",
    description: "向主窗口 UI 的输入元素输入文本；submit 为 true 时补回车。",
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "string" },
        text: { type: "string" },
        submit: { type: "boolean" },
      },
      required: ["uid", "text"],
    },
  },
  {
    name: "ui_press_key",
    description: "向主窗口 UI 派发按键：Enter/Tab/Escape/Backspace/Delete/Arrow*/PageUp/PageDown/Home/End。",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
  },
  {
    name: "ui_scroll",
    description: "滚动主窗口 UI。direction: up|down；amount 像素（默认 600）。",
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down"] },
        amount: { type: "number" },
      },
      required: ["direction"],
    },
  },
  {
    name: "ui_screenshot",
    description:
      "截取主窗口 renderer 层为 PNG 落盘（返回路径，用 read_image 查看）。注意：capturePage 不含内嵌浏览器面板的合成，全窗口画面用 record_start/stop。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ui_evaluate",
    description:
      "在桌面壳主窗口 renderer 执行任意 JS 表达式（async 可用，返回 JSON 化结果，8000 字符截断）。开发者模式的全权操控面：读界面状态、查询内部 store、派发任何 DOM 行为。",
    inputSchema: {
      type: "object",
      properties: { expression: { type: "string", description: "JS 表达式或 IIFE" } },
      required: ["expression"],
    },
  },
  {
    name: "record_start",
    description:
      "开始录制主窗口合成画面（含内嵌浏览器面板；webm、无音频；短时录制口径）。产物 <data_dir>/records/*.webm。窗口最小化/隐藏时会拒绝（全是黑帧）。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "record_stop",
    description: "停止录制并落盘，返回 webm 文件绝对路径与时长/大小。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "record_status",
    description: "查询录制状态：idle 或 recording（文件、已录秒数、已落盘 KB）。",
    inputSchema: { type: "object", properties: {} },
  },
];
