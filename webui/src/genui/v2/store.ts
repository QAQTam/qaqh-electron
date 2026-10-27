/**
 * Surface 注册表(v0.2 渲染器的数据底座):按序消费 A2UI 消息,维护每个 surface
 * 的组件表与 dataModel。v0.1 的「全文重解析 + 整树重挂」在这里变成「按消息 patch」——
 * 流式卡顿的根治点(docs/genui-v02-a2ui-migration.md §1)。
 *
 * 校验分两层:
 *  - 即时(apply 时):信封形状、surface 生命周期(create→update→delete)、预算;
 *  - 惰性(isRenderable):root 存在且从 root 可达的引用全部解析,renderer 只在
 *    可渲染时挂载——updateComponents 允许前向引用(spec 不禁止跨消息定义),
 *    坏引用在挂载闸门处暴露,而不是阻断流式。
 * 预算(深度/节点数)是 qaqh 侧 DoS 防线,A2UI spec 留给 renderer,从 v0.1 平移。
 */

import { pointerRemove, pointerSet } from "./dataModel";
import {
  A2uiError,
  type AgentToRendererMessage,
  type CreateSurfacePayload,
  type JsonValue,
  type UpdateComponentsPayload,
  type WireComponent,
} from "./types";

/** 单 surface 组件数预算(对齐 v0.1 的 MAX_NODES)。 */
export const MAX_NODES = 512;
/** 组件树深度预算(对齐 v0.1 的 MAX_TREE_DEPTH)。 */
export const MAX_TREE_DEPTH = 16;
/** dataModel 单值序列化体积预算:防模型灌巨包(渲染层还有 CSS 溢出兜底)。 */
const MAX_DATA_MODEL_BYTES = 256 * 1024;

export interface SurfaceState {
  surfaceId: string;
  catalogId?: string;
  sendDataModel: boolean;
  components: Map<string, WireComponent>;
  dataModel: { [key: string]: JsonValue };
}

export class SurfaceRegistry {
  private readonly surfaces = new Map<string, SurfaceState>();
  /** callRendererFunction 的未决调用(functionCallId → 函数),P1 桥接用。 */
  private readonly pendingCalls = new Map<string, { surfaceId?: string; callName: string }>();

  /** 按序消费一条消息;协议违规抛 A2uiError,调用方决定降级(占位卡/上报)。 */
  apply(message: AgentToRendererMessage): void {
    if (message.version !== "v1.0") {
      throw new A2uiError(`未知协议版本 ${message.version}(本 renderer 支持 v1.0)`);
    }
    if ("createSurface" in message) this.applyCreate(message.createSurface);
    else if ("updateComponents" in message) this.applyUpdateComponents(message.updateComponents);
    else if ("updateDataModel" in message) this.applyUpdateDataModel(message.updateDataModel);
    else if ("deleteSurface" in message) this.applyDelete(message.deleteSurface);
    else if ("callRendererFunction" in message) this.applyCallRendererFunction(message.callRendererFunction);
    else if ("agentFunctionResponse" in message) this.applyAgentFunctionResponse(message.agentFunctionResponse);
    else throw new A2uiError("消息不含任何已知操作键");
  }

  get(surfaceId: string): SurfaceState | undefined {
    return this.surfaces.get(surfaceId);
  }

  surfaceIds(): string[] {
    return [...this.surfaces.keys()];
  }

  /**
   * 渲染闸门:root 存在、从 root 出发引用全部可解析、无环、不超深。
   * 返回 null = 还不能渲染(流式中);字符串 = 违规原因(具名错误)。
   */
  renderBlocker(surfaceId: string): string | null {
    const surface = this.surfaces.get(surfaceId);
    if (surface == null) return `surface ${surfaceId} 不存在`;
    const root = surface.components.get("root");
    if (root == null) return "root 组件尚未到达";
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (id: string, depth: number): string | null => {
      if (done.has(id)) return null;
      if (visiting.has(id)) return `children 形成环:${id}`;
      if (depth > MAX_TREE_DEPTH) return `组件树深度超过 ${MAX_TREE_DEPTH}`;
      const component = surface.components.get(id);
      if (component == null) return `引用了未定义组件 ${id}`;
      visiting.add(id);
      for (const childId of staticChildren(component)) {
        const blocker = visit(childId, depth + 1);
        if (blocker != null) return blocker;
      }
      visiting.delete(id);
      done.add(id);
      return null;
    };
    return visit("root", 1);
  }

  /** callRendererFunction 的未决表(P1 沙箱桥按 functionCallId 关联回复)。 */
  pendingFunctionCalls(): ReadonlyMap<string, { surfaceId?: string; callName: string }> {
    return this.pendingCalls;
  }

  private applyCreate(payload: CreateSurfacePayload): void {
    if (payload.surfaceId === "") throw new A2uiError("createSurface 缺少 surfaceId");
    if (this.surfaces.has(payload.surfaceId)) {
      throw new A2uiError(`surface ${payload.surfaceId} 已存在(须先 deleteSurface)`, "DUPLICATE_SURFACE");
    }
    const components = new Map<string, WireComponent>();
    if (payload.components != null) {
      for (const component of payload.components) {
        checkComponentShape(component);
        if (components.has(component.id)) {
          throw new A2uiError(`createSurface 组件列表内 id 重复:${component.id}`);
        }
        components.set(component.id, component);
      }
      if (components.size > MAX_NODES) {
        throw new A2uiError(`组件数超过预算(${MAX_NODES})`, "BUDGET_EXCEEDED");
      }
    }
    const dataModel = payload.dataModel ?? {};
    checkDataModelBudget(dataModel);
    this.surfaces.set(payload.surfaceId, {
      surfaceId: payload.surfaceId,
      catalogId: payload.catalogId,
      sendDataModel: payload.sendDataModel === true,
      components,
      dataModel,
    });
  }

  private applyUpdateComponents(payload: UpdateComponentsPayload): void {
    const surface = this.requireSurface(payload.surfaceId);
    if (payload.components.length === 0) {
      throw new A2uiError("updateComponents 的组件列表为空");
    }
    for (const component of payload.components) {
      checkComponentShape(component);
      // 同 id 重定义 = 组件替换(spec 允许多次 updateComponents 修订同一节点)。
      surface.components.set(component.id, component);
    }
    if (surface.components.size > MAX_NODES) {
      throw new A2uiError(`组件数超过预算(${MAX_NODES})`, "BUDGET_EXCEEDED");
    }
  }

  private applyUpdateDataModel(payload: import("./types").UpdateDataModelPayload): void {
    const surface = this.requireSurface(payload.surfaceId);
    const path = payload.path ?? "/";
    if (payload.value === null && path === "/") {
      throw new A2uiError("value: null 搭配根路径未定义(删除请给出具体 path)");
    }
    if (payload.value === null) {
      pointerRemove(surface.dataModel, path);
      return;
    }
    if (path === "/") {
      if (payload.value == null || typeof payload.value !== "object" || Array.isArray(payload.value)) {
        throw new A2uiError("整体替换要求 dataModel 是对象");
      }
      surface.dataModel = payload.value as { [key: string]: JsonValue };
    } else {
      pointerSet(surface.dataModel, path, payload.value);
    }
    checkDataModelBudget(surface.dataModel);
  }

  private applyDelete(payload: import("./types").DeleteSurfacePayload): void {
    if (!this.surfaces.delete(payload.surfaceId)) {
      throw new A2uiError(`surface ${payload.surfaceId} 不存在`, "UNKNOWN_SURFACE");
    }
  }

  private applyCallRendererFunction(payload: import("./types").CallRendererFunctionPayload): void {
    if (payload.surfaceId != null) this.requireSurface(payload.surfaceId);
    if (payload.callFunction["@call"] === "") throw new A2uiError("callRendererFunction 缺少 @call");
    this.pendingCalls.set(payload.functionCallId, {
      surfaceId: payload.surfaceId,
      callName: payload.callFunction["@call"],
    });
  }

  private applyAgentFunctionResponse(payload: import("./types").AgentFunctionResponsePayload): void {
    this.pendingCalls.delete(payload.functionCallId);
  }

  private requireSurface(surfaceId: string): SurfaceState {
    const surface = this.surfaces.get(surfaceId);
    if (surface == null) throw new A2uiError(`surface ${surfaceId} 不存在`, "UNKNOWN_SURFACE");
    return surface;
  }
}

/** 组件信封校验(id/component 必填,component 不得是保留的 Surface)。 */
function checkComponentShape(component: WireComponent): void {
  if (typeof component.id !== "string" || component.id === "") {
    throw new A2uiError(`组件缺少 id:${JSON.stringify(component).slice(0, 80)}`);
  }
  if (typeof component.component !== "string" || component.component === "") {
    throw new A2uiError(`组件 ${component.id} 缺少 component 类型名`);
  }
  if (component.component === "Surface") {
    throw new A2uiError(`Surface 是保留的规范根容器,不允许显式定义:${component.id}`);
  }
}

function checkDataModelBudget(dataModel: { [key: string]: JsonValue }): void {
  const serialized = JSON.stringify(dataModel);
  if (serialized.length > MAX_DATA_MODEL_BYTES) {
    throw new A2uiError(`dataModel 超过 ${MAX_DATA_MODEL_BYTES / 1024}KB 预算`, "BUDGET_EXCEEDED");
  }
}

/** 静态 children:单子组件 `child` 与列表 `children` 的并集(模板列表不在此查)。 */
function staticChildren(component: WireComponent): string[] {
  const list = Array.isArray(component.children) ? component.children : [];
  if (typeof component.child !== "string") return list;
  return list.includes(component.child) ? list : [component.child, ...list];
}
