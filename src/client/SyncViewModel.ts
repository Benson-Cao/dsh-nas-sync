/**
 * dsh-nas-sync · SyncViewModel（Compose 侧）
 * -------------------------------------------
 * 职责：
 *  - 每 3 秒轮询 nas_sync_subscribe 刷新快照
 *  - 按需分页加载待同步列表 / 冲突列表
 *  - 暴露同步、停止、解决冲突、跳过文件等动作
 *  - 冲突解决后做乐观更新，再后台刷新校准
 */

import type {
  ConflictItem,
  DshPluginBridge,
  PendingFile,
  SyncSnapshot,
} from './bridge.js';

export type Resolution = 'local' | 'remote' | 'skip';

export interface PendingFilesUiState {
  items: PendingFile[];
  total: number;
  page: number;
  pageSize: number;
  loading: boolean;
}

export interface SyncUiState {
  snapshot: SyncSnapshot | null;
  pending: PendingFilesUiState;
  conflicts: ConflictItem[];
  selectedConflicts: Set<string>;
  error: string | null;
}

const INIT_PENDING: PendingFilesUiState = {
  items: [],
  total: 0,
  page: 1,
  pageSize: 50,
  loading: false,
};

export class SyncViewModel {
  private _state: SyncUiState = {
    snapshot: null,
    pending: { ...INIT_PENDING },
    conflicts: [],
    selectedConflicts: new Set(),
    error: null,
  };

  private listeners = new Set<(s: SyncUiState) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private bridge: DshPluginBridge) {}

  get state(): SyncUiState {
    return this._state;
  }

  subscribe(fn: (s: SyncUiState) => void): () => void {
    this.listeners.add(fn);
    fn(this._state);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const l of this.listeners) l(this._state);
  }

  private update(mut: (s: SyncUiState) => void): void {
    mut(this._state);
    this.emit();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.poll();
    this.timer = setInterval(() => this.poll(), 3000);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
  }

  private async poll(): Promise<void> {
    try {
      const snap = await this.bridge.callTool<SyncSnapshot>('nas_sync_subscribe');
      this.update((s) => {
        s.snapshot = snap;
        // 同步期间进度由快照驱动；未打开列表页时不刷新列表，避免浪费
      });
      this._state.error = null;
    } catch (e) {
      this.update((s) => {
        s.error = (e as Error).message;
      });
    }
  }

  async refreshAll(): Promise<void> {
    await Promise.all([this.poll(), this.loadConflicts(1), this.loadPending(this._state.pending.page)]);
  }

  async loadPending(page: number): Promise<void> {
    this.update((s) => {
      s.pending.loading = true;
    });
    try {
      const res = await this.bridge.callTool<{
        items: PendingFile[];
        total: number;
        page: number;
        pageSize: number;
      }>('nas_pending_files_page', {
        page: String(page),
        pageSize: String(this._state.pending.pageSize),
      });
      this.update((s) => {
        s.pending.items = res.items;
        s.pending.total = res.total;
        s.pending.page = res.page;
        s.pending.pageSize = res.pageSize;
        s.pending.loading = false;
      });
    } catch (e) {
      this.update((s) => {
        s.pending.loading = false;
        s.error = (e as Error).message;
      });
    }
  }

  async loadConflicts(page: number): Promise<void> {
    try {
      const items = await this.bridge.callTool<ConflictItem[]>('nas_get_conflicts', {
        page: String(page),
        pageSize: '50',
      });
      this.update((s) => {
        s.conflicts = items;
      });
    } catch (e) {
      this.update((s) => {
        s.error = (e as Error).message;
      });
    }
  }

  async startSync(mode: string): Promise<void> {
    try {
      await this.bridge.callTool('nas_sync', { mode });
      await this.refreshAll();
    } catch (e) {
      this.update((s) => {
        s.error = (e as Error).message;
      });
    }
  }

  async stopSync(): Promise<void> {
    await this.bridge.callTool<{ stopped: boolean }>('nas_stop_sync');
    await this.poll();
  }

  toggleConflict(file: string): void {
    this.update((s) => {
      const next = new Set(s.selectedConflicts);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      s.selectedConflicts = next;
    });
  }

  selectAllConflicts(): void {
    this.update((s) => {
      s.selectedConflicts = new Set(s.conflicts.map((c) => c.rel));
    });
  }

  clearSelection(): void {
    this.update((s) => {
      s.selectedConflicts = new Set();
    });
  }

  async resolve(file: string, resolution: Resolution): Promise<void> {
    // 乐观更新
    this.update((s) => {
      s.conflicts = s.selectedConflicts.has(file)
        ? s.conflicts.filter((c) => !s.selectedConflicts.has(c.rel))
        : s.conflicts.filter((c) => c.rel !== file);
      if (s.selectedConflicts.has(file)) {
        const next = new Set(s.selectedConflicts);
        next.delete(file);
        s.selectedConflicts = next;
      }
    });
    try {
      await this.bridge.callTool('nas_resolve_conflict', { file, resolution });
      await this.poll();
    } catch (e) {
      this.update((s) => {
        s.error = (e as Error).message;
      });
      await this.loadConflicts(1);
    }
  }

  async batchResolve(resolution: Resolution): Promise<void> {
    const files = Array.from(this._state.selectedConflicts);
    if (files.length === 0) return;
    this.update((s) => {
      s.conflicts = s.conflicts.filter((c) => !s.selectedConflicts.has(c.rel));
      s.selectedConflicts = new Set();
    });
    try {
      await Promise.all(
        files.map((f) => this.bridge.callTool('nas_resolve_conflict', { file: f, resolution })),
      );
      await this.poll();
    } catch (e) {
      this.update((s) => {
        s.error = (e as Error).message;
      });
      await this.loadConflicts(1);
    }
  }

  async skipPending(file: string): Promise<void> {
    this.update((s) => {
      s.pending.items = s.pending.items.filter((p) => p.rel !== file);
      s.pending.total = Math.max(0, s.pending.total - 1);
    });
    try {
      await this.bridge.callTool('nas_resolve_conflict', { file, resolution: 'skip' });
    } catch (e) {
      this.update((s) => {
        s.error = (e as Error).message;
      });
      await this.loadPending(this._state.pending.page);
    }
  }
}
