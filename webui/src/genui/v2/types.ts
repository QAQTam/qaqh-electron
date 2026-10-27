/**
 * A2UI v1.0 wire 类型（specification/v1_0/json/agent_to_renderer.json 的 TS 镜像）。
 *
 * schema vendored 在 `./schema/`（锁 commit,不裸追上游）；本文件是手写的 TS 镜像,
 * 而非 schema 生成物——渲染层需要的是「窄化后的判别联合」,不是 JSON-Schema 元类型。
 * 字段名与 wire 完全一致（surfaceId/@path/@call/...）,便于直接序列化/调试。
 *
 * 与 qaqh v0.1 的关系：v0.1 的 SurfaceIR 是一次性对象,v0.2 的 wire 是消息流
 * （createSurface → updateComponents* → updateDataModel* → deleteSurface）。
 * 参考 docs/genui-v02-a2ui-migration.md。
 */

export const A2UI_VERSION = "v1.0";

/** wire 上的任意 JSON 值(dataModel 的内容)。 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** `{"@path": "/build/status"}`——dataModel 的 JSON Pointer 绑定。 */
export interface DataBinding {
  "@path": string;
}

/** `{"@call": "fn", args?: ...}`——catalog 函数调用(白名单在 catalog,不在 wire)。 */
export interface FunctionCall {
  "@call": string;
  catalogId?: string;
  args?: { [key: string]: DynamicValue };
}

/** 动态值：字面量 | 路径绑定 | 函数调用。对象字面量不得以 `@` 开头键(保留字)。 */
export type DynamicValue =
  | string
  | number
  | boolean
  | null
  | DynamicValue[]
  | DataBinding
  | FunctionCall
  | { [key: string]: JsonValue };

export type DynamicString = string | DataBinding | FunctionCall;
export type DynamicNumber = number | DataBinding | FunctionCall;
export type DynamicBoolean = boolean | DataBinding | FunctionCall;

/** 无障碍属性(spec ComponentCommon.accessibility)。 */
export interface AccessibilityAttributes {
  label?: DynamicString;
  description?: DynamicString;
  live?: "off" | "polite" | "assertive";
  hidden?: DynamicBoolean;
}

/** 组件信封：所有 catalog 组件共有的基线属性。 */
export interface ComponentCommon {
  id: string;
  catalogId?: string;
  accessibility?: AccessibilityAttributes;
  metadata?: { extensions?: { [key: string]: JsonValue } };
}

/** 静态子组件 id 列表,或「模板 + dataModel 路径」的动态列表。 */
export type ChildList =
  | string[]
  | { componentId: string; path: string };

/**
 * wire 组件：catalog 定义的组件实例。props 形状由 catalog 的 JSON Schema 约束,
 * renderer 侧对未知组件名保持宽容(由 catalog 校验层拒绝),这里只固定信封字段。
 */
export type WireComponent = ComponentCommon & {
  component: string;
  child?: string;
  children?: ChildList;
  [prop: string]: unknown;
};

/** 用户动作意图(组件的 action.event):发给 agent 的命名事件 + 可解析上下文。 */
export interface ActionEvent {
  event: {
    name: string;
    userMessage?: DynamicString;
    context?: { [key: string]: DynamicValue };
  };
}

export interface CreateSurfacePayload {
  surfaceId: string;
  catalogId?: string;
  sendDataModel?: boolean;
  components?: WireComponent[];
  dataModel?: { [key: string]: JsonValue };
  metadata?: { extensions?: { [key: string]: JsonValue } };
}

export interface UpdateComponentsPayload {
  surfaceId: string;
  components: WireComponent[];
}

export interface UpdateDataModelPayload {
  surfaceId: string;
  /** JSON Pointer;缺省或 "/" 指整个 dataModel。 */
  path?: string;
  /** null = 删除 path 处的键值。 */
  value: JsonValue;
}

export interface DeleteSurfacePayload {
  surfaceId: string;
}

export interface CallRendererFunctionPayload {
  surfaceId?: string;
  functionCallId: string;
  callFunction: FunctionCall;
}

export interface AgentFunctionResponsePayload {
  functionCallId: string;
  value?: JsonValue;
  error?: { code: string; message: string };
}

/** agent → renderer 的六种消息(spec oneOf 的判别联合)。 */
export type AgentToRendererMessage =
  | { version: typeof A2UI_VERSION; createSurface: CreateSurfacePayload }
  | { version: typeof A2UI_VERSION; updateComponents: UpdateComponentsPayload }
  | { version: typeof A2UI_VERSION; updateDataModel: UpdateDataModelPayload }
  | { version: typeof A2UI_VERSION; deleteSurface: DeleteSurfacePayload }
  | { version: typeof A2UI_VERSION; callRendererFunction: CallRendererFunctionPayload }
  | { version: typeof A2UI_VERSION; agentFunctionResponse: AgentFunctionResponsePayload };

/** renderer → agent:用户动作(对应 schema renderer_to_agent.json 的 action 分支)。 */
export interface RendererActionMessage {
  version: typeof A2UI_VERSION;
  action: {
    name: string;
    userMessage?: string;
    surfaceId: string;
    sourceComponentId: string;
    timestamp: string;
    context: { [key: string]: JsonValue };
  };
}

/** 协议违规错误:code 对齐 renderer_to_agent.json 的 error 枚举。 */
export class A2uiError extends Error {
  constructor(
    message: string,
    readonly code:
      | "VALIDATION_FAILED"
      | "UNALLOWED_PARENT"
      | "UNALLOWED_CHILD"
      | "UNKNOWN_SURFACE"
      | "DUPLICATE_SURFACE"
      | "BUDGET_EXCEEDED" = "VALIDATION_FAILED",
  ) {
    super(message);
    this.name = "A2uiError";
  }
}
