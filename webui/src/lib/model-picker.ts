/**
 * 原生模型选择器（已退役）。
 * 统一由 WebUI 内部的 Profile / Effort 选择器与设置页承接。
 */
export function nativeModelPickerAvailable(): boolean {
  return false;
}

export async function openNativeModelPicker(_sessionId: string | null): Promise<boolean> {
  return false;
}
