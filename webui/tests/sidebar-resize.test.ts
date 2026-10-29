/** 侧栏拖拽调宽纯逻辑(用户侧需求):夹持/拖拽映射/收回阈值/持久化恢复。 */
import { describe, expect, test } from "vitest";
import {
  SIDEBAR_COLLAPSE_BELOW,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_STEP,
  clampSidebarWidth,
  dragSidebarWidth,
  restoreSidebarWidth,
  shouldCollapseSidebar,
} from "../src/lib/sidebar-resize";

describe("clampSidebarWidth", () => {
  test("夹持到 [200, 440]", () => {
    expect(clampSidebarWidth(150)).toBe(SIDEBAR_WIDTH_MIN);
    expect(clampSidebarWidth(500)).toBe(SIDEBAR_WIDTH_MAX);
    expect(clampSidebarWidth(320)).toBe(320);
    expect(clampSidebarWidth(321.7)).toBe(322);
  });
});

describe("dragSidebarWidth", () => {
  test("向右拖变宽,向左拖变窄,终点夹持", () => {
    expect(dragSidebarWidth(100, 288, 160)).toBe(348);
    expect(dragSidebarWidth(100, 288, 40)).toBe(228);
    expect(dragSidebarWidth(100, 288, -1000)).toBe(SIDEBAR_WIDTH_MIN);
    expect(dragSidebarWidth(100, 288, 2000)).toBe(SIDEBAR_WIDTH_MAX);
  });
});

describe("shouldCollapseSidebar", () => {
  test("低于阈值收回;阈值本身不收回", () => {
    expect(shouldCollapseSidebar(SIDEBAR_COLLAPSE_BELOW - 1)).toBe(true);
    expect(shouldCollapseSidebar(SIDEBAR_COLLAPSE_BELOW)).toBe(false);
    expect(shouldCollapseSidebar(SIDEBAR_WIDTH_MIN)).toBe(true);
    expect(shouldCollapseSidebar(288)).toBe(false);
  });
});

describe("restoreSidebarWidth", () => {
  test("合法值原样恢复;非法/脏数据回默认", () => {
    expect(restoreSidebarWidth("320")).toBe(320);
    expect(restoreSidebarWidth(null)).toBe(null);
    expect(restoreSidebarWidth("")).toBe(null);
    expect(restoreSidebarWidth("abc")).toBe(null);
    expect(restoreSidebarWidth("-40")).toBe(null);
    expect(restoreSidebarWidth("9999")).toBe(null);
  });
});

describe("常量关系", () => {
  test("阈值高于最小宽度:拖到最窄松手必收回", () => {
    expect(SIDEBAR_COLLAPSE_BELOW).toBeGreaterThan(SIDEBAR_WIDTH_MIN);
    expect(SIDEBAR_WIDTH_STEP).toBeGreaterThan(0);
  });
});
