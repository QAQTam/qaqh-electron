/** 引用不可变：合并重复下载，并限制历史快照的并发量和正文缓存。 */
const GLOBAL_CACHE_BUDGET = 6 * 1024 * 1024;
const GLOBAL_CACHE_ENTRIES = 384;
let loaderSequence = 0;
let globalCacheSize = 0;
const globalLru = new Map<string, { ownerId: number; ref: string; text: string }>();
const ownerCaches = new Map<number, Map<string, string>>();

export class ContentLoader {
  private cache = new Map<string, string>();
  private readonly id = ++loaderSequence;
  private pending = new Set<string>();
  private failed = new Set<string>();
  private queue: string[] = [];
  private inFlight = new Map<string, { controller: AbortController; generation: number }>();
  private generation = 0;

  constructor(
    private read: (ref: string, signal: AbortSignal) => Promise<string>,
    private write: (ref: string, text: string, resolved: boolean) => void,
    private status?: (ref: string, status: "loading" | "ready" | "failed" | "idle") => void,
  ) { ownerCaches.set(this.id, this.cache); }

  request(ref: string): void {
    const cached = this.cache.get(ref);
    if (cached != null) {
      const key = this.cacheKey(ref);
      const entry = globalLru.get(key);
      if (entry) { globalLru.delete(key); globalLru.set(key, entry); }
      this.write(ref, cached, true);
      this.status?.(ref, "ready");
      return;
    }
    if (this.pending.has(ref) || this.failed.has(ref)) return;
    this.pending.add(ref);
    this.queue.push(ref);
    this.status?.(ref, "loading");
    this.drain();
  }

  retryFailed(): void {
    const retry = [...this.failed];
    this.failed.clear();
    for (const ref of retry) this.request(ref);
  }

  clear(evictCache = false): void {
    this.generation++;
    this.failed.clear();
    this.queue = [];
    for (const { controller } of this.inFlight.values()) controller.abort();
    // Requests remain counted until their promises settle; a new activation
    // cannot exceed the real network concurrency limit during cancellation.
    for (const ref of this.pending) this.status?.(ref, "idle");
    this.pending.clear();
    if (evictCache) {
      for (const ref of this.cache.keys()) this.removeCached(ref);
      ownerCaches.delete(this.id);
    }
  }

  private remember(ref: string, text: string): void {
    // JS 字符串按 UTF-16 计，缓存最多约 4 MiB；大正文仅保留在会话状态中。
    if (text.length > 2 * 1024 * 1024) return;
    this.removeCached(ref);
    this.cache.set(ref, text);
    const key = this.cacheKey(ref);
    const entry = { ownerId: this.id, ref, text };
    globalLru.set(key, entry);
    globalCacheSize += text.length;
    while (globalLru.size > GLOBAL_CACHE_ENTRIES || globalCacheSize > GLOBAL_CACHE_BUDGET) {
      const oldest = globalLru.entries().next().value;
      if (!oldest) break;
      globalLru.delete(oldest[0]);
      globalCacheSize -= oldest[1].text.length;
      const cache = ownerCaches.get(oldest[1].ownerId);
      cache?.delete(oldest[1].ref);
      if (cache?.size === 0) ownerCaches.delete(oldest[1].ownerId);
    }
  }

  private cacheKey(ref: string): string { return `${this.id}:${ref}`; }

  private removeCached(ref: string): void {
    const key = this.cacheKey(ref);
    const entry = globalLru.get(key);
    if (entry) {
      globalLru.delete(key);
      globalCacheSize -= entry.text.length;
    }
    this.cache.delete(ref);
  }

  private drain(): void {
    while (this.inFlight.size < 4 && this.queue.length > 0) {
      const ref = this.queue.shift()!;
      if (!this.pending.has(ref)) continue;
      if (this.inFlight.has(ref)) { this.queue.push(ref); break; }
      const generation = this.generation;
      const controller = new AbortController();
      const task = { controller, generation };
      this.inFlight.set(ref, task);
      void Promise.resolve().then(() => this.read(ref, controller.signal)).then(
        (text) => {
          if (generation !== this.generation) return;
          this.remember(ref, text);
          this.write(ref, text, true);
          this.status?.(ref, "ready");
        },
        (error) => {
          if (generation !== this.generation) return;
          if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
            this.status?.(ref, "idle");
            return;
          }
          this.failed.add(ref);
          // Failure state is metadata; never insert an error string into the
          // canonical conversation body.
          this.write(ref, "", false);
          this.status?.(ref, "failed");
        },
      ).finally(() => {
        if (this.inFlight.get(ref) === task) this.inFlight.delete(ref);
        if (generation === this.generation) this.pending.delete(ref);
        this.drain();
      });
    }
  }
}
