/**
 * dsh-nas-sync · 配置 schema 与运行时状态
 * ------------------------------------------
 * r2 重写：对齐真实宿主 API ——
 *   - schemastery 真实方法（z.union / z.string().role('secret')）
 *   - 设置注册走 ctx.settings.register('nas-sync', Schema, { base })
 *   - Store 持久化到 $DSH_HOME/.dsh/nas-sync/store.json，并保存固定 scrypt salt
 */

import z from '@deepseek-ai/schemastery';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { dshHome } from './paths.js';

export const NS_NAS_SYNC = 'nas-sync';

/**
 * 同步内容分类的默认勾选状态（r3）。
 *
 * 设计取舍：
 *  - **不做**「敏感总开关 + 分类」双闸，避免「我明明勾了 profiles 却没同步」的困惑。
 *    分类勾选**直接决定**同步哪些子树；`includeSensitive` 退化为「子树**内部**的
 *    凭据文件（.credentials.yaml 等）要不要一起走」，两者职责不重叠。
 *  - 敏感分类默认 false（等价于旧版「敏感默认排除」的行为），升级后不会突然多同步东西。
 */
export const DEFAULT_SYNC_SCOPE = {
  /** sessions/ 会话记录本体（聊天内容，不含凭据） */
  sessions: true,
  /** session-titles.json 会话标题索引（很小，但缺了列表会没名字） */
  sessionTitles: true,
  /** attachments/ 图片与文件 */
  attachments: true,
  /** skills/ 自定义技能 */
  skills: true,
  /** profiles/ 插件与 Profile 配置（可能含插件凭据） */
  profiles: false,
  /** settings.yaml 主设置（可能含 API Key 明文） */
  settings: false,
  /** cordis.patch.yml 插件装配层 */
  pluginPatch: false,
} as const;

export type SyncScopeKey = keyof typeof DEFAULT_SYNC_SCOPE;
export type SyncScope = Record<SyncScopeKey, boolean>;

export const NasSyncSchema = z.object({
  type: z.union(['webdav', 'mount']).default('webdav'),
  webdav: z.object({
    url: z.string().default(''),
    /** NAS 端共享文件夹名或子路径（如 /dsh-sync、/home/DSH备份）；空 = 根目录 */
    remotePath: z.string().default(''),
    username: z.string().default(''),
    password: z.string().role('secret').default(''),
  }).default({ url: '', remotePath: '', username: '', password: '' }),
  mountRoot: z.string().default(''),
  /** 加密口令：所有上传内容用 scrypt(secretbox) 加密，必填 */
  passphrase: z.string().role('secret').default(''),
  autoSync: z.object({
    enabled: z.boolean().default(false),
    mode: z.union(['push', 'pull', 'mirror']).default('push'),
    intervalMin: z.number().min(1).max(1440).default(30),
  }).default({ enabled: false, mode: 'push', intervalMin: 30 }),
  /** 超过该字节的文件走分块上传，默认 100 MiB */
  chunkThreshold: z.number().min(1024).default(100 * 1024 * 1024),
  /** 分块大小，默认 50 MiB */
  chunkSize: z.number().min(1024).default(50 * 1024 * 1024),
  /** 上传并发数 */
  concurrency: z.number().min(1).max(16).default(4),
  /** 已选分类**内部**是否连凭据文件（.credentials 等）一起同步，默认 false */
  includeSensitive: z.boolean().default(false),
  /** r3：按分类勾选同步内容（未列出的键走 DEFAULT_SYNC_SCOPE） */
  syncScope: z.object({
    sessions: z.boolean().default(DEFAULT_SYNC_SCOPE.sessions),
    sessionTitles: z.boolean().default(DEFAULT_SYNC_SCOPE.sessionTitles),
    attachments: z.boolean().default(DEFAULT_SYNC_SCOPE.attachments),
    skills: z.boolean().default(DEFAULT_SYNC_SCOPE.skills),
    profiles: z.boolean().default(DEFAULT_SYNC_SCOPE.profiles),
    settings: z.boolean().default(DEFAULT_SYNC_SCOPE.settings),
    pluginPatch: z.boolean().default(DEFAULT_SYNC_SCOPE.pluginPatch),
  }).default({ ...DEFAULT_SYNC_SCOPE }),
  /**
   * 技能白名单：只同步 `skills/` 下**这些一级目录名**。
   *
   * 语义上「空数组 = 全部」而不是「空 = 一个都不要」：
   * ① 默认配置（老版本没有这个键）必须表现为「照旧全同步」，否则升级即静默丢数据；
   * ② 用户勾满所有技能时归一化成空数组，将来新增的技能会自动纳入，不用回头再勾。
   * 想表达「一个技能都不同步」，把 `syncScope.skills` 关掉即可，不必用空列表表达。
   */
  skillFilter: z.array(z.string()).default([]),
});

export type NasSyncConfig = ReturnType<typeof NasSyncSchema.parse>;

/**
 * 把任意来源的 syncScope 归一成**完整**的 7 键对象。
 *
 * 为什么必须做：配置是三层叠加（schema 默认 < patch entry config < store.userConfig），
 * 而顶层是浅展开 —— 用户层只要存过 `{syncScope:{attachments:false}}` 这样的**局部**对象，
 * 展开后就会把下面整层的 syncScope 覆盖掉。若不归一，其余分类会回落到 schema 默认值，
 * 表现成「我上次关掉的分类，重启后又自己开了」。
 */
export function normalizeSyncScope(raw: unknown): SyncScope {
  const src = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
  const out = { ...DEFAULT_SYNC_SCOPE } as SyncScope;
  for (const k of Object.keys(DEFAULT_SYNC_SCOPE) as SyncScopeKey[]) {
    if (typeof src[k] === 'boolean') out[k] = src[k] as boolean;
  }
  return out;
}

/** 已勾选的分类键（供日志/状态展示）。 */
export function enabledScopeKeys(scope: SyncScope): SyncScopeKey[] {
  return (Object.keys(scope) as SyncScopeKey[]).filter((k) => scope[k]);
}


/**
 * 跨版本解析配置：schemastery 0.1.x 的模型有 .parse()，0.2.x 的模型
 * 本身是可调用对象（Schema(data)）。这里做三种形态的兜底。
 */
export function parseNasSyncConfig(raw: unknown): NasSyncConfig {
  const s = NasSyncSchema as unknown as {
    parse?: (v: unknown) => unknown;
    validate?: (v: unknown) => unknown;
  };
  let out: any;
  if (typeof s === 'function') out = s(raw);
  else if (typeof s.parse === 'function') out = s.parse(raw);
  else if (typeof s.validate === 'function') out = s.validate(raw);
  else throw new Error('无法解析配置：schemastery 模型既不可调用也没有 parse/validate');
  // r3：syncScope 归一（局部对象不得把其它分类顶回默认值，详见 normalizeSyncScope 注释）
  out.syncScope = normalizeSyncScope(out.syncScope);
  // 技能白名单同样要归一：数组元素可能是非字符串、带空格、重复
  out.skillFilter = normalizeSkillFilter(out.skillFilter);
  return out as NasSyncConfig;
}

/**
 * 把任意来源的技能白名单归一成「去重、去空白、只留字符串」的数组。
 * 非数组（null/undefined/字符串/对象）一律当「空 = 全部」，不让脏配置把同步清空。
 */
export function normalizeSkillFilter(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const s = v.trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 运行时状态
// ---------------------------------------------------------------------------

export interface ProgressInfo { total: number; done: number; errors: number }
export type SyncPhase = 'idle' | 'scanning' | 'uploading' | 'downloading' | 'error';

export interface SyncSnapshot {
  lastSyncTime: number | null;
  phase: SyncPhase;
  progress: ProgressInfo;
  pendingCount: number;
  conflictCount: number;
  running: boolean;
}

export interface ConflictItem {
  rel: string;
  localMtime: number;
  remoteMtime: number;
  localHash: string;
  remoteHash: string;
  mergeable: boolean;
}

export interface PendingFile {
  rel: string;
  size: number;
  action: 'upload' | 'download' | 'delete';
}

const DEFAULT_SNAPSHOT: SyncSnapshot = {
  lastSyncTime: null,
  phase: 'idle',
  progress: { total: 0, done: 0, errors: 0 },
  pendingCount: 0,
  conflictCount: 0,
  running: false,
};

/** 状态文件目录：$DSH_HOME/.dsh/nas-sync/（不在同步白名单内，不会自我同步）。 */
function storeDir(): string {
  return join(dshHome(), 'nas-sync');
}

export class Store {
  readonly storePath = join(storeDir(), 'store.json');
  /** 固定 scrypt salt（16B hex）。首次生成后持久化；进每个密文文件头，跨机可解。 */
  saltHex: string;

  snapshot: SyncSnapshot = { ...DEFAULT_SNAPSHOT };
  pendingFiles: PendingFile[] = [];
  conflicts: ConflictItem[] = [];
  /** 用户显式修改过的配置覆盖层（合并到 entry config 之上）；null = 未改过 */
  userConfig: Record<string, unknown> | null = null;

  constructor() {
    let salt: string | null = null;
    try {
      if (existsSync(this.storePath)) {
        const data = JSON.parse(readFileSync(this.storePath, 'utf-8'));
        if (data.snapshot) this.snapshot = { ...DEFAULT_SNAPSHOT, ...data.snapshot };
        if (Array.isArray(data.pendingFiles)) this.pendingFiles = data.pendingFiles;
        if (Array.isArray(data.conflicts)) this.conflicts = data.conflicts;
        if (data.userConfig && typeof data.userConfig === 'object') this.userConfig = data.userConfig;
        if (typeof data.saltHex === 'string' && data.saltHex.length === 32) salt = data.saltHex;
      }
    } catch {
      this.snapshot = { ...DEFAULT_SNAPSHOT };
      this.pendingFiles = [];
      this.conflicts = [];
    }
    if (!salt) salt = randomBytes(16).toString('hex');
    this.saltHex = salt;
    this.save();
  }

  save(): void {
    try {
      mkdirSync(dirname(this.storePath), { recursive: true });
      writeFileSync(this.storePath, JSON.stringify({
        saltHex: this.saltHex,
        snapshot: this.snapshot,
        pendingFiles: this.pendingFiles,
        conflicts: this.conflicts,
        userConfig: this.userConfig,
      }, null, 2), 'utf-8');
    } catch {
      /* 写失败不致命，下次再试 */
    }
  }

  salt(): Uint8Array {
    return Uint8Array.from(Buffer.from(this.saltHex, 'hex'));
  }
}
