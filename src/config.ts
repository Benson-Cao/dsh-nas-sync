/**
 * dsh-nas-sync · 配置与持久化
 * -----------------------------
 *  - ConfigSchema：设置页绑定的 schema，敏感字段用 role('secret') 保护
 *  - NS_NAS_SYNC：Host 半 / 客户端半共用的 namespace key，必须一致
 *  - Store：运行时状态（进度、待同步、冲突）的加载/保存
 */

import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import z from '@deepseek-ai/schemastery';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ConflictItem, FileState, PendingFile, SyncSnapshot } from './data/models.js';

export const NS_NAS_SYNC = settingsNamespace('nas-sync');

export const ConfigSchema = z.object({
  type: z.enum_(['webdav', 'mount']).default('webdav'),
  webdav: z.object({
    url: z.string().default(''),
    username: z.string().default(''),
    password: z.string().role('secret').default(''),
  }).optional(),
  mountRoot: z.string().default(''),
  passphrase: z.string().role('secret').default(''),
  autoSync: z.object({
    enabled: z.boolean().default(false),
    mode: z.enum_(['push', 'pull', 'mirror']).default('push'),
    intervalMin: z.number().min(1).max(1440).default(30),
  }).optional(),
  /** 超过该字节的文件走分块上传，默认 100 MiB */
  chunkThreshold: z.number().min(1024).default(100 * 1024 * 1024),
  /** 分块大小，默认 50 MiB */
  chunkSize: z.number().min(1024).default(50 * 1024 * 1024),
  /** 上传并发数 */
  concurrency: z.number().min(1).max(16).default(4),
  /** 是否同步敏感文件（.credentials 等），默认 false 且需二次确认 */
  includeSensitive: z.boolean().default(false),
});

import type { infer as ZInfer } from '@deepseek-ai/schemastery';
export type NasSyncConfig = ZInfer<typeof ConfigSchema>;

const DEFAULT_SNAPSHOT: SyncSnapshot = {
  lastSyncTime: null,
  phase: 'idle',
  progress: { total: 0, done: 0, errors: 0 },
  pendingCount: 0,
  conflictCount: 0,
  running: false,
};

export class Store {
  private path: string;

  snapshot: SyncSnapshot = { ...DEFAULT_SNAPSHOT };
  pendingFiles: PendingFile[] = [];
  conflicts: ConflictItem[] = [];
  chunkStates: Map<string, FileState> = new Map();

  constructor(profileDataDir: string) {
    this.path = join(profileDataDir, 'nas-sync', 'store.json');
    this.load();
  }

  private load(): void {
    try {
      if (!existsSync(this.path)) return;
      const raw = readFileSync(this.path, 'utf-8');
      const data = JSON.parse(raw);
      this.snapshot = { ...DEFAULT_SNAPSHOT, ...(data.snapshot ?? {}) };
      this.pendingFiles = data.pendingFiles ?? [];
      this.conflicts = data.conflicts ?? [];
      if (data.chunkStates) {
        for (const [k, v] of Object.entries<FileState>(data.chunkStates)) {
          this.chunkStates.set(k, v);
        }
      }
    } catch (e) {
      // 损坏不影响启动，仅重置
      this.snapshot = { ...DEFAULT_SNAPSHOT };
      this.pendingFiles = [];
      this.conflicts = [];
    }
  }

  save(): void {
    try {
      mkdirSync(join(this.path, '..'), { recursive: true });
      const chunkObj: Record<string, FileState> = {};
      for (const [k, v] of this.chunkStates) chunkObj[k] = v;
      writeFileSync(
        this.path,
        JSON.stringify(
          {
            snapshot: this.snapshot,
            pendingFiles: this.pendingFiles,
            conflicts: this.conflicts,
            chunkStates: chunkObj,
          },
          null,
          2,
        ),
        'utf-8',
      );
    } catch {
      // 忽略写入失败，下次再试
    }
  }

  resetProgress(): void {
    this.snapshot.progress = { total: 0, done: 0, errors: 0 };
  }
}

let cachedConfig: NasSyncConfig | null = null;

export function loadConfig(): NasSyncConfig {
  if (cachedConfig) return cachedConfig;
  // 实际项目中由 installSettingsSection 的 current 注入；
  // 这里给一个安全的默认，避免 Host 启动期拿不到配置就崩。
  cachedConfig = ConfigSchema.parse({});
  return cachedConfig;
}

export function updateConfig(next: NasSyncConfig): void {
  cachedConfig = next;
}
