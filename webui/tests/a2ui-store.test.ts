/**
 * A2UI v0.2 Surface 注册表测试:消息消费、生命周期、预算防线、渲染闸门。
 * 夹具形态对齐 specification/v1_0 的 agent_to_renderer 消息(vendored schema 旁证)。
 */
import { describe, expect, test } from "vitest";

import { pointerGet } from "../src/genui/v2/dataModel";
import { SurfaceRegistry } from "../src/genui/v2/store";
import { A2uiError, type AgentToRendererMessage, type WireComponent } from "../src/genui/v2/types";

const V = "v1.0" as const;

const text = (id: string, value: string): WireComponent => ({ id, component: "Text", value });

describe("SurfaceRegistry:消息消费", () => {
  test("createSurface + updateComponents + updateDataModel 端到端", () => {
    const registry = new SurfaceRegistry();
    registry.apply({
      version: V,
      createSurface: {
        surfaceId: "s1",
        catalogId: "qaqh.dev:standard",
        dataModel: { build: { status: "running", errors: [] } },
      },
    });
    expect(registry.renderBlocker("s1")).toContain("root 组件尚未到达");

    registry.apply({
      version: V,
      updateComponents: {
        surfaceId: "s1",
        components: [
          { id: "root", component: "Column", children: ["title", "status"] },
          { id: "title", component: "Title", value: "Cargo Build" },
          { id: "status", component: "Text", value: { "@path": "/build/status" } },
        ],
      },
    });
    expect(registry.renderBlocker("s1")).toBeNull();

    const surface = registry.get("s1")!;
    expect(surface.components.get("status")!.value).toEqual({ "@path": "/build/status" });
    expect(pointerGet(surface.dataModel, "/build/status")).toBe("running");

    registry.apply({ version: V, updateDataModel: { surfaceId: "s1", path: "/build/status", value: "failed: E0597" } });
    expect(pointerGet(registry.get("s1")!.dataModel, "/build/status")).toBe("failed: E0597");
  });

  test("前向引用:root 先到、子组件跨消息补齐,闸门从阻塞转通过", () => {
    const registry = new SurfaceRegistry();
    registry.apply({ version: V, createSurface: { surfaceId: "s2" } });
    registry.apply({
      version: V,
      updateComponents: {
        surfaceId: "s2",
        components: [{ id: "root", component: "Column", children: ["late"] }],
      },
    });
    expect(registry.renderBlocker("s2")).toContain("未定义组件 late");

    registry.apply({
      version: V,
      updateComponents: { surfaceId: "s2", components: [text("late", "补齐")] },
    });
    expect(registry.renderBlocker("s2")).toBeNull();
  });

  test("同 id 重定义 = 组件替换(spec 允许修订)", () => {
    const registry = new SurfaceRegistry();
    registry.apply({ version: V, createSurface: { surfaceId: "s3" } });
    registry.apply({
      version: V,
      updateComponents: { surfaceId: "s3", components: [{ id: "root", component: "Text", value: "v1" }] },
    });
    registry.apply({
      version: V,
      updateComponents: { surfaceId: "s3", components: [{ id: "root", component: "Text", value: "v2" }] },
    });
    expect(registry.get("s3")!.components.get("root")!.value).toBe("v2");
  });

  test("deleteSurface 之后的任何操作都是 UNKNOWN_SURFACE", () => {
    const registry = new SurfaceRegistry();
    registry.apply({ version: V, createSurface: { surfaceId: "s4" } });
    registry.apply({ version: V, deleteSurface: { surfaceId: "s4" } });
    expect(registry.get("s4")).toBeUndefined();
    expect(() =>
      registry.apply({ version: V, updateDataModel: { surfaceId: "s4", value: {} } }),
    ).toThrowError(A2uiError);
  });
});

describe("SurfaceRegistry:协议违规", () => {
  test("重复 createSurface → DUPLICATE_SURFACE", () => {
    const registry = new SurfaceRegistry();
    registry.apply({ version: V, createSurface: { surfaceId: "dup" } });
    try {
      registry.apply({ version: V, createSurface: { surfaceId: "dup" } });
      expect.unreachable("应当抛出");
    } catch (error) {
      expect((error as A2uiError).code).toBe("DUPLICATE_SURFACE");
    }
  });

  test("保留组件名 Surface 被拒绝", () => {
    const registry = new SurfaceRegistry();
    registry.apply({ version: V, createSurface: { surfaceId: "s5" } });
    expect(() =>
      registry.apply({
        version: V,
        updateComponents: { surfaceId: "s5", components: [{ id: "root", component: "Surface" }] },
      }),
    ).toThrowError(/保留的规范根容器/);
  });

  test("环:root 自引用在渲染闸门暴露", () => {
    const registry = new SurfaceRegistry();
    registry.apply({ version: V, createSurface: { surfaceId: "s6" } });
    registry.apply({
      version: V,
      updateComponents: {
        surfaceId: "s6",
        components: [{ id: "root", component: "Column", children: ["root"] }],
      },
    });
    expect(registry.renderBlocker("s6")).toContain("形成环");
  });

  test("深度超过 16 层 → BUDGET_EXCEEDED", () => {
    const registry = new SurfaceRegistry();
    registry.apply({ version: V, createSurface: { surfaceId: "s7" } });
    const chain: WireComponent[] = [];
    for (let depth = 0; depth <= 16; depth += 1) {
      chain.push({ id: depth === 0 ? "root" : `n${depth}`, component: "Column", child: `n${depth + 1}` });
    }
    registry.apply({ version: V, updateComponents: { surfaceId: "s7", components: chain } });
    expect(registry.renderBlocker("s7")).toContain("深度超过");
  });

  test("dataModel 超预算 → BUDGET_EXCEEDED", () => {
    const registry = new SurfaceRegistry();
    registry.apply({ version: V, createSurface: { surfaceId: "s8" } });
    const huge = "x".repeat(300 * 1024);
    expect(() =>
      registry.apply({ version: V, updateDataModel: { surfaceId: "s8", path: "/blob", value: huge } }),
    ).toThrowError(/预算/);
  });

  test("value: null 搭配根路径未定义", () => {
    const registry = new SurfaceRegistry();
    registry.apply({ version: V, createSurface: { surfaceId: "s9" } });
    expect(() =>
      registry.apply({ version: V, updateDataModel: { surfaceId: "s9", value: null } }),
    ).toThrowError(/根路径/);
  });
});

describe("SurfaceRegistry:dataModel 语义", () => {
  test("null 删除键值(幂等);整体替换要求对象;沿途自动建容器", () => {
    const registry = new SurfaceRegistry();
    registry.apply({ version: V, createSurface: { surfaceId: "d1" } });

    registry.apply({ version: V, updateDataModel: { surfaceId: "d1", path: "/a/b/c", value: 42 } });
    expect(pointerGet(registry.get("d1")!.dataModel, "/a/b/c")).toBe(42);

    registry.apply({ version: V, updateDataModel: { surfaceId: "d1", path: "/a/b/c", value: null } });
    expect(pointerGet(registry.get("d1")!.dataModel, "/a/b/c")).toBeUndefined();
    // 再删一次:幂等 no-op
    registry.apply({ version: V, updateDataModel: { surfaceId: "d1", path: "/a/b/c", value: null } });

    registry.apply({ version: V, updateDataModel: { surfaceId: "d1", value: { fresh: true } } });
    expect(registry.get("d1")!.dataModel).toEqual({ fresh: true });
    expect(() =>
      registry.apply({ version: V, updateDataModel: { surfaceId: "d1", value: [1, 2] } }),
    ).toThrowError(/对象/);
  });
});

describe("SurfaceRegistry:函数调用登记", () => {
  test("callRendererFunction 入未决表,agentFunctionResponse 清除", () => {
    const registry = new SurfaceRegistry();
    registry.apply({ version: V, createSurface: { surfaceId: "f1" } });
    registry.apply({
      version: V,
      callRendererFunction: {
        surfaceId: "f1",
        functionCallId: "call-1",
        callFunction: { "@call": "qaqh:followUp", args: { prompt: "重试构建" } },
      },
    });
    expect(registry.pendingFunctionCalls().get("call-1")?.callName).toBe("qaqh:followUp");
    registry.apply({
      version: V,
      agentFunctionResponse: { functionCallId: "call-1", value: null },
    });
    expect(registry.pendingFunctionCalls().has("call-1")).toBe(false);
  });
});

describe("SurfaceRegistry:版本与形状", () => {
  test("未知协议版本拒绝", () => {
    const registry = new SurfaceRegistry();
    expect(() =>
      registry.apply({ version: "v0.9", createSurface: { surfaceId: "x" } } as unknown as AgentToRendererMessage),
    ).toThrowError(/协议版本/);
  });

  test("组件缺 id / 缺 component 被拒绝", () => {
    const registry = new SurfaceRegistry();
    registry.apply({ version: V, createSurface: { surfaceId: "s10" } });
    expect(() =>
      registry.apply({ version: V, updateComponents: { surfaceId: "s10", components: [{ component: "Text" } as WireComponent] } }),
    ).toThrowError(/缺少 id/);
    expect(() =>
      registry.apply({ version: V, updateComponents: { surfaceId: "s10", components: [{ id: "a" } as WireComponent] } }),
    ).toThrowError(/缺少 component/);
  });
});
