/** 正文里点击文件引用后的目标；侧栏订阅它展开代码预览。 */
import { createSignal } from "solid-js";

export interface FileRefTarget {
  path: string;
  line?: number;
  col?: number;
}

const [target, setTarget] = createSignal<FileRefTarget | null>(null);

export const fileRefTarget = target;
export const openFileRef = (next: FileRefTarget): void => { setTarget(next); };
export const closeFileRef = (): void => { setTarget(null); };
