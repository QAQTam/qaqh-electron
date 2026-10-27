/**
 * 原生模型选择器入口。
 *
 * 选择器本身是 Electron 主进程里的独立窗口(`MODEL_PICKER_HTML`),webui 只负责
 * 打开它;保存后主进程广播 `model-picker:changed`,App 再刷新配置。
 */
import { desktopHost } from "./desktop-host";

export function nativeModelPickerAvailable(): boolean {
  return desktopHost()?.modelPicker?.open != null;
}

export async function openNativeModelPicker(sessionId: string | null): Promise<boolean> {
  const picker = desktopHost()?.modelPicker;
  if (picker?.open == null) return false;
  await picker.open({ sessionId });
  return true;
}
