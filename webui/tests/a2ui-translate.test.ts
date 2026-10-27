/**
 * v0.2 翻译器 + 求值器测试:SurfaceIR → A2UI 消息 → SurfaceRegistry → DynamicValue 求值。
 * 覆盖 P1 的纯逻辑层;渲染层(SurfaceView2)另行接入。
 */
import { describe, expect, test } from "vitest";

import type { SurfaceIR } from "../src/genui/compiler";
import { resolveDynamic } from "../src/genui/v2/eval2";
import { SurfaceRegistry } from "../src/genui/v2/store";
import { translateCreate, translateUpdate } from "../src/genui/v2/translate";
import { A2uiError, type DynamicValue } from "../src/genui/v2/types";

/** 手构一个最小但形态完整的 IR:Card(标题表达式) > Text(count + 1)。 */
function makeIr(surfaceId = "t1"): SurfaceIR {
  return {
    irVersion: "0.1",
    surfaceId,
    title: "T",
    rootId: "r",
    states: { count: { type: "number", initial: 2 } },
    order: ["r", "t"],
    nodes: {
      r: {
        id: "r",
        type: "Card",
        props: {
          title: { kind: "lit", value: "Build" },
          children: { kind: "list", items: ["t"] },
        },
      },
      t: {
        id: "t",
        type: "Text",
        props: {
          text: {
            kind: "expr",
            expr: { op: "add", left: { op: "state", key: "count" }, right: { op: "lit", value: 1 } },
          },
        },
      },
    },
  };
}

describe("translate:SurfaceIR → A2UI 消息", () => {
  test("translateCreate 产出带包装根的 createSurface,注册表渲染闸门放行", () => {
    const registry = new SurfaceRegistry();
    registry.apply(translateCreate(makeIr()));
    expect(registry.renderBlocker("t1")).toBeNull();
    const surface = registry.get("t1")!;
    // 包装根:Stack > [v0.1 rootId]
    expect(surface.components.get("root")!.component).toBe("Stack");
    expect(surface.components.get("root")!.children).toEqual(["r"]);
    // 状态进 /s/ 命名空间
    expect(surface.dataModel.s).toEqual({ count: 2 });
  });

  test("表达式降级为 qaqh:arith 函数调用,无表达式 AST 进 wire", () => {
    const registry = new SurfaceRegistry();
    registry.apply(translateCreate(makeIr()));
    const text = registry.get("t1")!.components.get("t")!;
    expect(text.text).toEqual({
      "@call": "qaqh:arith.add",
      args: { left: { "@path": "/s/count" }, right: 1 },
    });
  });

  test("translateUpdate:updateComponents + /s 整体替换,幂等重放一致", () => {
    const registry = new SurfaceRegistry();
    const ir = makeIr();
    registry.apply(translateCreate(ir));
    const messages = translateUpdate(ir);
    for (const message of messages) registry.apply(message);
    expect(registry.renderBlocker("t1")).toBeNull();
    expect(registry.get("t1")!.dataModel.s).toEqual({ count: 2 });
  });

  test("repeat 赂 metadata.extensions[qaqh.dev/repeat](vendor 扩展槽,合法 wire)", () => {
    const ir = makeIr();
    ir.nodes.t!.repeat = { source: "tags", as: "item" };
    ir.states.tags = { type: "list", initial: ["a", "b"] };
    const registry = new SurfaceRegistry();
    registry.apply(translateCreate(ir));
    const extension = registry.get("t1")!.components.get("t")!.metadata?.extensions?.["qaqh.dev/repeat"];
    expect(extension).toEqual({ path: "/s/tags", as: "item" });
  });

  test("followUp 动作降级为命名事件,字段引用保持可解析", () => {
    const ir = makeIr();
    ir.nodes.t!.props.onPress = {
      kind: "action",
      action: { kind: "followUp", prompt: "重试", fields: [{ label: "计数", key: "count" }] },
    };
    const registry = new SurfaceRegistry();
    registry.apply(translateCreate(ir));
    const onPress = registry.get("t1")!.components.get("t")!.onPress as {
      event: { name: string; context: Record<string, DynamicValue> };
    };
    expect(onPress.event.name).toBe("qaqh.action.followUp");
    expect(onPress.event.context.prompt).toBe("重试");
    expect(onPress.event.context.fields).toEqual([{ label: "计数", key: "count" }]);
  });
});

describe("eval2:DynamicValue 求值", () => {
  const model = { s: { count: 2, name: "构建", tags: ["a", "b"] } };

  test("@path 绝对路径取 dataModel", () => {
    expect(resolveDynamic({ "@path": "/s/count" }, model, null)).toBe(2);
    expect(resolveDynamic({ "@path": "/s/missing" }, model, null)).toBeNull();
  });

  test("qaqh:arith.add 数字相加;字符串参与降级拼接(对齐 v0.1 语义)", () => {
    const add = (left: DynamicValue, right: DynamicValue): JsonLike =>
      resolveDynamic({ "@call": "qaqh:arith.add", args: { left, right } }, model, null);
    expect(add({ "@path": "/s/count" }, 1)).toBe(3);
    expect(add("n=", { "@path": "/s/count" })).toBe("n=2");
  });

  test("qaqh:logic.gt 非数字抛错;eq 严格相等", () => {
    expect(() =>
      resolveDynamic({ "@call": "qaqh:logic.gt", args: { left: "x", right: 1 } }, model, null),
    ).toThrowError(A2uiError);
    expect(resolveDynamic({ "@call": "qaqh:logic.eq", args: { left: 1, right: 1 } }, model, null)).toBe(true);
  });

  test("未知函数拒绝(catalog 白名单之外的 @call 不执行)", () => {
    expect(() =>
      resolveDynamic({ "@call": "eval", args: {} } as DynamicValue, model, null),
    ).toThrowError(/未知函数/);
  });

  test("模板项:相对空路径 = 项本身;@index 带偏移", () => {
    const scope = { index: 1, value: "b" };
    expect(resolveDynamic({ "@path": "" }, model, scope)).toBe("b");
    expect(resolveDynamic({ "@call": "@index", args: { offset: 1 } }, model, scope)).toBe(2);
    expect(() => resolveDynamic({ "@path": "" }, model, null)).toThrowError(/模板项作用域/);
  });
});

type JsonLike = string | number | boolean | null | JsonLike[] | { [key: string]: JsonLike };
