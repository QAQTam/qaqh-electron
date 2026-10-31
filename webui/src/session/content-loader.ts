export const CONTENT_LOAD_FAILED = "正文加载失败，请重新连接重试";

/** 引用不可变：合并重复下载，并限制历史快照的并发量和正文缓存。 */
export class ContentLoader {
  private cache = new Map<string, string>();
  private cacheSize = 0;
  private pending = new Set<string>();
  private failed = new Set<string>();
  private queue: string[] = [];
  private active = 0;
  private generation = 0;

  constructor(
    private read: (ref: string) => Promise<string>,
    private write: (ref: string, text: string, resolved: boolean) => void,
  ) {}

  request(ref: string): void {
    const cached = this.cache.get(ref);
    if (cached != null) {
      this.write(ref, cached, true);
      return;
    }
    if (this.pending.has(ref) || this.failed.has(ref)) return;
    this.pending.add(ref);
    this.queue.push(ref);
    this.drain();
  }

  retryFailed(): void {
    this.failed.clear();
  }

  clear(): void {
    this.generation++;
    this.cache.clear();
    this.cacheSize = 0;
    this.pending.clear();
    this.failed.clear();
    this.queue = [];
    this.active = 0;
  }

  private remember(ref: string, text: string): void {
    // JS 字符串按 UTF-16 计，缓存最多约 4 MiB；大正文仅保留在会话状态中。
    if (text.length > 2 * 1024 * 1024) return;
    this.cache.set(ref, text);
    this.cacheSize += text.length;
    while (this.cache.size > 128 || this.cacheSize > 2 * 1024 * 1024) {
      const oldest = this.cache.entries().next().value!;
      this.cache.delete(oldest[0]);
      this.cacheSize -= oldest[1].length;
    }
  }

  private drain(): void {
    while (this.active < 4 && this.queue.length > 0) {
      const ref = this.queue.shift()!;
      const generation = this.generation;
      this.active++;
      void Promise.resolve().then(() => this.read(ref)).then(
        (text) => {
          if (generation !== this.generation) return;
          this.remember(ref, text);
          this.write(ref, text, true);
        },
        () => {
          if (generation !== this.generation) return;
          this.failed.add(ref);
          this.write(ref, CONTENT_LOAD_FAILED, false);
        },
      ).finally(() => {
        if (generation !== this.generation) return;
        this.active--;
        this.pending.delete(ref);
        this.drain();
      });
    }
  }
}
