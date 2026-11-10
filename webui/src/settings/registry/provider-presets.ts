/**
 * 后端 provider 预设表的模块级读模型（与 registry.ts 同风格）。
 *
 * `provider.presets.list`（qaqh-profile PROVIDER_PRESETS）是端点事实的真源；
 * 静态模板表（./templates）在数据到达前先渲染、在后端版本错位时兜底。
 * 单飞：`ensurePresetsLoaded` 幂等，引导页与设置页共用同一份 signal。
 */
import { createSignal } from "solid-js";

import { transport } from "../../lib/transport";
import {
  PROVIDER_TEMPLATES,
  mergeProviderPresets,
  type ProviderPresetWire,
  type ProviderTemplate,
} from "./templates";

const [presetTemplates, setPresetTemplates] = createSignal<ProviderTemplate[]>(PROVIDER_TEMPLATES);
export { presetTemplates };

const record = (value: unknown): Record<string, unknown> | null =>
  value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

function readPresetSnapshot(value: unknown): ProviderPresetWire[] {
  if (!Array.isArray(value)) throw new Error("provider.presets.list returned an invalid preset snapshot");
  return value.map((entry) => {
    const row = record(entry);
    if (row == null
      || typeof row.id !== "string"
      || typeof row.name !== "string"
      || typeof row.baseUrl !== "string"
      || typeof row.wire !== "string"
      || typeof row.credential !== "string") {
      throw new Error("provider.presets.list returned an invalid preset snapshot");
    }
    return {
      id: row.id,
      name: row.name,
      baseUrl: row.baseUrl,
      wire: row.wire,
      credential: row.credential,
    };
  });
}

let loading = false;

/** 幂等触发后端预设读取；失败静默降级到静态表（永远可用的兜底 UI）。 */
export function ensurePresetsLoaded(): void {
  if (loading) return;
  loading = true;
  void transport
    .command({ type: "provider.presets.list" })
    .then((ack) => {
      if (ack.status !== "accepted") return;
      const presets = readPresetSnapshot(ack.result);
      if (presets.length > 0) setPresetTemplates(mergeProviderPresets(presets));
    })
    .catch(() => {
      // 后端未升级（无该命令）或快照异常：静态表兜底保持渲染。
    });
}
