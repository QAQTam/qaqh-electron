/**
 * Diff 审查工作台瞬态状态机与有界 LRU 缓存 (spec §9 / 内存物理防线)
 * 
 * 内存与性能纪律:
 * 1. 严格锁死最大缓存容量 MAX_DIFF_CACHE_CAPACITY = 3：
 *    即使一个轮次改动了 100 个文件，内存中最多只保留最近查看的 3 个文件的解析产物，
 *    第 4 个文件载入时，最旧的文件立刻被踢出缓存并解除引用。
 * 2. 抽屉关闭即物理清空 (Hard Reset)：
 *    调用 `close()` 时，清空选定状态并执行 `cache.clear()`，
 *    所有 ParsedFile / Diff 行对象完全脱钩，立即交还 V8 垃圾回收，绝不常驻。
 */
import { createSignal, untrack } from "solid-js";
import { parseUnifiedDiff, type ParsedFile } from "./parse";
import { extractTurnDeliverables, getTurnFileDiff, normalizeDisplayPath, type TurnDeliverables } from "./deliverables";
import type { Turn } from "../session/types";

export const MAX_DIFF_CACHE_CAPACITY = 3;

/**
 * 轻量有界 LRU 缓存容器 (无外部依赖，零额外内存开销)
 */
export class BoundedLruCache<K, V> {
  private readonly map = new Map<K, V>();
  private readonly capacity: number;
  private readonly onEvict?: (key: K, value: V) => void;

  constructor(capacity = MAX_DIFF_CACHE_CAPACITY, onEvict?: (key: K, value: V) => void) {
    this.capacity = Math.max(1, capacity);
    this.onEvict = onEvict;
  }

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key)!;
    // 重新置入末尾（刷新至最近使用）
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.capacity) {
      // 淘汰最久未使用的头部节点
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) {
        const oldestValue = this.map.get(oldestKey);
        this.map.delete(oldestKey);
        if (oldestValue !== undefined && this.onEvict) {
          this.onEvict(oldestKey, oldestValue);
        }
      }
    }
    this.map.set(key, value);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }

  keys(): K[] {
    return Array.from(this.map.keys());
  }
}

export interface DiffReviewState {
  isOpen: boolean;
  sessionId: string | null;
  turnKey: string | null;
  turn: Turn | null;
  deliverables: TurnDeliverables | null;
  activeFilePath: string | null;
  /**
   * 打开时由调用方传入的会话工作区。指纹聚合(`extractTurnDeliverables`)用它
   * 把绝对路径归一成相对路径,按需解析(`getTurnFileDiff`)也必须用同一个 cwd
   * 才能匹配回 diff 原文里的绝对路径 —— 之前丢掉它导致抽屉骨架屏永久卡住。
   */
  cwd: string | null;
}

export interface OpenReviewOptions {
  sessionId: string;
  turn: Turn;
  targetFilePath?: string;
  cwd?: string | null;
}

/**
 * 全局单例审查状态机 (通过 Solid signals 驱动响应式)
 */
class DiffReviewStoreController {
  private readonly stateSignal: () => DiffReviewState;
  private readonly setState: (updater: DiffReviewState | ((prev: DiffReviewState) => DiffReviewState)) => void;

  constructor() {
    const [state, setState] = createSignal<DiffReviewState>({
      isOpen: false,
      sessionId: null,
      turnKey: null,
      turn: null,
      deliverables: null,
      activeFilePath: null,
      cwd: null,
    });
    this.stateSignal = state;
    this.setState = setState;
  }

  /** 活跃文件解析产物的有界 LRU 缓存 */
  public readonly lruCache = new BoundedLruCache<string, ParsedFile[]>(MAX_DIFF_CACHE_CAPACITY);

  public get state(): () => DiffReviewState {
    return this.stateSignal;
  }

  /**
   * 打开审查抽屉
   */
  public open(options: OpenReviewOptions): void {
    const { sessionId, turn, targetFilePath, cwd } = options;
    const deliverables = extractTurnDeliverables(turn, cwd);
    if (!deliverables || deliverables.files.length === 0) {
      return;
    }

    const initialFile = targetFilePath
      ? deliverables.files.find((f) => f.path === targetFilePath)?.path ?? deliverables.files[0]!.path
      : deliverables.files[0]!.path;

    // 清理先前旧 session/turn 残留的缓存
    this.lruCache.clear();

    this.setState({
      isOpen: true,
      sessionId,
      turnKey: turn.key,
      turn,
      deliverables,
      activeFilePath: initialFile,
      // cwd 必须随状态驻留:按需解析要靠它把 diff 原文的绝对路径归一回
      // 指纹使用的相对路径(与 extractTurnDeliverables 同一约定)。
      cwd: cwd ?? null,
    });
  }

  /**
   * 关闭审查抽屉 (立即触发彻底物理清空与引用断开)
   */
  public close(): void {
    // 1. 彻底清空 LRU 缓存，断开所有 ParsedFile/DiffRow 引用
    this.lruCache.clear();

    // 2. 重置全局信号，促使抽屉组件直接 unmount
    this.setState({
      isOpen: false,
      sessionId: null,
      turnKey: null,
      turn: null,
      deliverables: null,
      activeFilePath: null,
      cwd: null,
    });
  }

  /**
   * 切换当前查看的文件
   */
  public selectFile(filePath: string): void {
    const current = untrack(this.state);
    if (!current.isOpen || !current.deliverables) return;
    const exists = current.deliverables.files.some((f) => f.path === filePath);
    if (exists && current.activeFilePath !== filePath) {
      this.setState((prev) => ({ ...prev, activeFilePath: filePath }));
    }
  }

  /**
   * 上一个/下一个文件导航
   */
  public navigateFile(direction: -1 | 1): void {
    const current = untrack(this.state);
    if (!current.isOpen || !current.deliverables || !current.activeFilePath) return;
    const files = current.deliverables.files;
    const currentIndex = files.findIndex((f) => f.path === current.activeFilePath);
    if (currentIndex === -1) return;

    const nextIndex = (currentIndex + direction + files.length) % files.length;
    const nextFile = files[nextIndex]!.path;
    this.selectFile(nextFile);
  }

  /**
   * 获取当前选定文件的解析结果（带 LRU 守卫）。
   * cwd 一律取打开时驻留在 state 里的会话工作区——指纹聚合与按需解析必须用
   * 同一个 cwd 归一路径，抽屉侧不传参也不会再失配（骨架屏永久卡住的根因）。
   */
  public getActiveFileParsed(): ParsedFile | null {
    const current = this.state();
    if (!current.isOpen || !current.turn || !current.activeFilePath) return null;
    const cwd = current.cwd;

    const cacheKey = `${current.turnKey}:${current.activeFilePath}`;
    const cached = this.lruCache.get(cacheKey);
    if (cached && cached.length > 0) {
      return this.matchFile(cached, current.activeFilePath, cwd);
    }

    const diffText = getTurnFileDiff(current.turn, current.activeFilePath, cwd);
    if (!diffText) return null;

    try {
      const parsed = parseUnifiedDiff(diffText);
      if (parsed.length > 0) {
        this.lruCache.set(cacheKey, parsed);
        return this.matchFile(parsed, current.activeFilePath, cwd);
      }
    } catch {
      return null;
    }

    return null;
  }

  /**
   * `getTurnFileDiff` 交回的是**整段** step diff(可能一次改动多个文件),
   * 直接取 [0] 会把用户点的第二个文件渲染成第一个文件的对比。
   */
  private matchFile(files: ParsedFile[], targetPath: string, cwd: string | null): ParsedFile | null {
    return files.find((file) => normalizeDisplayPath(file.path, cwd) === targetPath) ?? files[0] ?? null;
  }
}

export const diffReviewStore = new DiffReviewStoreController();
