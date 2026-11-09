/**
 * dsh-nas-sync · 配置 schema 与运行时状态
 * ------------------------------------------
 * r2 重写：对齐真实宿主 API ——
 *   - schemastery 真实方法（z.union / z.string().role('secret')）
 *   - 设置注册走 ctx.settings.register('nas-sync', Schema, { base })
 *   - Store 持久化到 $DSH_HOME/.dsh/nas-sync/store.json，并保存固定 scrypt salt
 */

import z from '@deepseek-ai/schemastery';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { dshHome } from './paths.js';
import type { ManifestEntry } from './data/models.js';
import { readJsonFile, readTextFile, writeJsonAtomic, writeTextAtomic } from './sync/state-file.js';

export const NS_NAS_SYNC = 'nas-sync';

/** 跨平台会话的导入记录：远端原文指纹 + 本地改写后的副本。 */
export interface SessionImportRecord {
  /** 远端原文（未改写 cwd）的 sha256 —— 它没变就不重复下载 */
  remoteHash: string;
  /** 本地落地副本的 rel（cwd 已被改成本机路径，目录名也随之变了） */
  localRel: string;
  /** 落地时本地副本的 sha256 —— 之后变了说明用户在本机继续过它 */
  localHash: string;
  /** 远端原文里的 cwd（回传时要改回这条路径，否则对端打不开） */
  originalCwd: string;
  /**
   * 远端清单连续几轮都没这份原文了（0.5.8）。
   *
   * 对端删掉会话时，它自己的设备清单里那一条会消失 —— 这就是本机唯一能观测到的
   * 「删除信号」。但清单是 WebDAV 上的一个文件，写入瞬断/读到半截都会让整份清单
   * 解不出来（`readManifestAt` 吞异常返回空），一次误判就会把镜像连同会话一起删掉。
   * 所以要求**连续两轮**都观测到缺失才回收，并且回收是「移进回收目录」而不是硬删。
   */
  missingRounds?: number;
  /**
   * 只是「顺手收下」的等价副本，不是本插件搬下来的（0.5.8）。
   *
   * 两端内容完全一样、仅第 0 帧 cwd 不同时，我们会记账但不落盘 —— 那条会话本来就
   * 属于本机这个工作区。**回收时必须放过它**：对端删掉同 id 的会话不该连带删掉
   * 本机自己的历史（`retireImport()` 见这个标记只销账、不动文件）。
   */
  adopted?: boolean;
}

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
  /** storages/workspace.json 工作区注册表（缺了它，同步过来的会话只能落到「未分组」） */
  workspaces: true,
  /**
   * 工作区**目录内容**（源码等）。rel 空间统一挂在 `workspaces/<名字>/` 下，
   * 手机与电脑的工作区绝对路径不同，但折算后落到同一前缀，所以两端不会错位。
   */
  workspaceFiles: true,
  /** 用户自己加的任意目录（配置里的 customFolders 映射表），与工作区文件并列 */
  customFolders: true,
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
  /**
   * 删除后回收副本保留天数（0.6.0 / P1）。
   * 0 = 永久保留；到期后由 gcRemoteObjects() 真删远端对象与分块残块。
   * 默认 30 天，与 README 对外承诺一致。
   */
  retentionDays: z.number().min(0).max(3650).default(30),
  /**
   * 会话 rel 空间（0.6.0 / 收尾①）。
   *   legacy    = 0.5.9 行为：`sessions/<cwd编码>/<sid>/...`（默认，升级不改数据）
   *   shadow    = 主链仍是 legacy，但额外把会话双写到 canonical 空间
   *   canonical = 主链切到 `sessions/by-id/<sid>/vN/...`（须先执行迁移并写 marker）
   * 读侧永远双空间归并，所以三种模式可以混跑、可回滚。
   */
  sessionRelMode: z.union(['legacy', 'shadow', 'canonical']).default('legacy'),
  /**
   * 上传密文的信封版本（0.6.0 / 收尾②）。1 = NSS1（0.5.9 兼容），2 = NSS2
   * （带版本字段与 AAD 绑定）。解密永远双读，改这个数字不会让 NAS 上的历史密文失效。
   */
  envelopeVersion: z.number().min(1).max(2).default(1),
  /** 增量扫描缓存（0.6.0 / 收尾③）：命中时跳过 readFile + sha256。 */
  scanCacheEnabled: z.boolean().default(true),
  /** 缓存条目最长可复用时长（小时）；到期强制重算，防 mtime 被保持的静默改写。 */
  scanCacheTtlHours: z.number().min(1).max(720).default(24),
  /**
   * 工作区 / 自定义文件夹的单文件扫描上限（字节，0.6.0 / P3）。
   *
   * 0.5.9 里这是 portable.ts 里写死的 64 MiB，配置改不动，而且 `walkWorkspaceFiles`
   * 两处调用都漏传参数 —— 用户在面板上调大也没用。现在配置化并由引擎贯穿到扫描器。
   * 超大文件建议放 attachments 分类（那条链路走分块上传）。
   */
  maxFileBytes: z.number().min(1024).default(64 * 1024 * 1024),
  /** 已选分类**内部**是否连凭据文件（.credentials 等）一起同步，默认 false */
  includeSensitive: z.boolean().default(false),
  /** r3：按分类勾选同步内容（未列出的键走 DEFAULT_SYNC_SCOPE） */
  syncScope: z.object({
    sessions: z.boolean().default(DEFAULT_SYNC_SCOPE.sessions),
    workspaces: z.boolean().default(DEFAULT_SYNC_SCOPE.workspaces),
    workspaceFiles: z.boolean().default(DEFAULT_SYNC_SCOPE.workspaceFiles),
    customFolders: z.boolean().default(DEFAULT_SYNC_SCOPE.customFolders),
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
  /**
   * 自定义文件夹：**每台机器各自维护**的「名字 → 本机路径」映射表。
   *
   * 为什么不是「两端同一个绝对路径」：手机和电脑的盘符/目录结构天然不同，
   * 要求一致等于把这个功能限制成同机备份。所以用 `name` 当跨设备的稳定标识
   * （rel 前缀 `custom-folders/<name>/`），`path` 只在本机有意义 ——
   * 同一份远端数据，在电脑上落到 `D:\Projects\foo`、在手机上落到别的目录都行。
   *
   * 上传：扫 `path` 目录，rel 记作 `custom-folders/<name>/…`
   * 下载：按 rel 里的 `<name>` 查出本机 `path`，落到那里（见 engine 的 resolveLocal）
   */
  customFolders: z.array(z.object({
    name: z.string(),
    path: z.string(),
  })).default([]),
});

export type NasSyncConfig = ReturnType<typeof NasSyncSchema.parse>;

/**
 * 把任意来源的 syncScope 归一成**完整**的键对象。
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
  // 自定义文件夹：去重、要求 name 可做目录名、path 必须非空
  out.customFolders = normalizeCustomFolders(out.customFolders);
  return out as NasSyncConfig;
}

/** 一个自定义文件夹条目：跨设备用 name 标识，path 只在本机有意义。 */
export interface CustomFolder {
  name: string;
  path: string;
}

/**
 * 归一自定义文件夹表。
 *
 * name 会被拼进 rel（`custom-folders/<name>/…`），所以必须清掉路径分隔符与
 * Windows 非法字符 —— 否则 `name: "../x"` 就能把文件写到 rel 空间外面。
 * 重名直接丢弃后来者：两条配置映射到同一个 rel 前缀只会互相覆盖。
 */
export function normalizeCustomFolders(raw: unknown): CustomFolder[] {
  if (!Array.isArray(raw)) return [];
  const out: CustomFolder[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const name = typeof rec['name'] === 'string' ? rec['name'].trim() : '';
    const path = typeof rec['path'] === 'string' ? rec['path'].trim() : '';
    if (name.length === 0 || path.length === 0) continue;
    const safe = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '_');
    if (safe.length === 0 || seen.has(safe)) continue;
    seen.add(safe);
    out.push({ name: safe, path });
  }
  return out;
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

/** 状态文件目录：$DSH_HOME/nas-sync/（不在同步白名单内，不会自我同步）。 */
function storeDir(): string {
  return join(dshHome(), 'nas-sync');
}

/**
 * 把两个口令字段从 `userConfig` 里拆出来（0.5.9）。
 *
 * 这不是加密 —— 在没有系统 keyring 的跨端环境里做不到真正的密钥托管。
 * 但 `store.json` 是排障时最常被整份贴出来/拷走的文件，把口令挪进单独一个
 * 0600 文件，至少不会「贴状态 = 贴口令」。迁移要向后兼容：老版本的口令还在
 * store.json 里，构造时读出来拆走，下次 save 就写成新格式。
 */
function splitSecrets(uc: Record<string, unknown> | null): {
  publicPart: Record<string, unknown> | null;
  secrets: Record<string, unknown>;
} {
  const secrets: Record<string, unknown> = {};
  if (!uc || typeof uc !== 'object') return { publicPart: uc, secrets };
  const publicPart: Record<string, unknown> = { ...uc };
  if (typeof uc['passphrase'] === 'string') {
    secrets['passphrase'] = uc['passphrase'];
    delete publicPart['passphrase'];
  }
  const wd = uc['webdav'];
  if (wd && typeof wd === 'object' && !Array.isArray(wd)) {
    const w = wd as Record<string, unknown>;
    if (typeof w['password'] === 'string') {
      secrets['webdav'] = { password: w['password'] };
      const clean = { ...w };
      delete clean['password'];
      publicPart['webdav'] = clean;
    }
  }
  return { publicPart, secrets };
}

/** 把独立凭据文件里的字段并回内存态（只在内存里合并，store.json 永远不含它们）。 */
function mergeSecrets(
  uc: Record<string, unknown> | null,
  secrets: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const out: Record<string, unknown> = { ...(uc ?? {}) };
  if (secrets && typeof secrets === 'object') {
    if (typeof secrets['passphrase'] === 'string') out['passphrase'] = secrets['passphrase'];
    const w = secrets['webdav'];
    if (w && typeof w === 'object' && !Array.isArray(w)) {
      const pwd = (w as Record<string, unknown>)['password'];
      if (typeof pwd === 'string') {
        const base = out['webdav'] && typeof out['webdav'] === 'object'
          ? { ...(out['webdav'] as Record<string, unknown>) }
          : {};
        base['password'] = pwd;
        out['webdav'] = base;
      }
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

export class Store {
  readonly storePath = join(storeDir(), 'store.json');
  /**
   * salt 单独存一份（0.5.9）。它进每个密文的文件头，丢了 = NAS 上所有历史密文
   * 永久解不开。以前只写在 store.json 里，那份文件一坏就被构造函数的 catch 整份
   * 重置，等于把钥匙一起扔了。现在独立、原子、只读一次。
   */
  readonly saltPath = join(storeDir(), 'salt.hex');
  /** 口令类字段单独落 0600 文件，不进 store.json（0.5.9）。 */
  readonly credentialsPath = join(storeDir(), 'credentials.json');
  /** 固定 scrypt salt（16B hex）。首次生成后持久化；进每个密文文件头，跨机可解。 */
  saltHex: string;
  /** 上次状态文件异常，供状态面板/日志显示；不再静默吞掉。 */
  lastError: string | null = null;
  /** 避免每轮同步都重写凭据文件（save() 调用非常频繁）。 */
  private lastCredentialsJson = '';

  snapshot: SyncSnapshot = { ...DEFAULT_SNAPSHOT };
  pendingFiles: PendingFile[] = [];
  conflicts: ConflictItem[] = [];
  /**
   * 上一轮本地清单，删除传播的基线。
   * 0.3.5 起用它区分「对端新增的条目（要补回）」与「本机删掉的条目（不能补回）」。
   */
  localManifest: ManifestEntry[] = [];
  /** 用户显式修改过的配置覆盖层（合并到 entry config 之上）；null = 未改过 */
  userConfig: Record<string, unknown> | null = null;
  /**
   * 跨平台会话的导入记录（0.5.6）：远端 rel → 本地落地副本。
   *
   * 跨平台会话落地时 cwd 会被改写（不改就打不开），于是本地副本和远端原文
   * **永远不是同一份字节**。不记这一笔，扫描每轮都会判「远端有本地无 → 再下一遍」
   * 和「本地有远端无 → 再传一份」，永不收敛。
   */
  sessionImports: Record<string, SessionImportRecord> = {};

  /**
   * 0.6.0 / P1：本机对每台设备事件日志的处理位点。
   * 不存就会在每次重启后重放历史 delete 事件（虽然本地回收是幂等的，但会刷日志、
   * 也会让「本机继续编辑过的会话」被重复搬动）。
   */
  deviceCursors: Record<string, number> = {};

  /**
   * 0.6.0 / P1：待发布的屏蔽意图。
   *
   * `ignoreSession()` / `unignoreSession()` 是面板同步调用，不该在点击瞬间去写
   * NAS（网络一断就把用户操作弄丢）。先记成意图，下一轮 sync 再转成正式事件发布，
   * 对端消费后同样写进它自己的屏蔽清单 —— 这就是「屏蔽清单全局事件化」。
   */
  pendingIntents: Array<{ op: 'ignore' | 'unignore'; sid: string }> = [];

  constructor() {
    // ① 状态文件：区分「不存在」与「损坏」。损坏时留备份并大声报错，
    //    绝不因为一个坏字段就把 snapshot / pending / conflicts 整份重置。
    const stored = readJsonFile<Record<string, any>>(this.storePath);
    const data = stored.data;
    if (stored.corrupted) {
      this.lastError = '状态文件损坏，已备份到 ' + (stored.quarantinedTo ?? '(备份失败)');
      console.error('[dsh-nas-sync] ' + this.lastError);
    }

    // ② salt 独立持久化：store.json 没了/坏了，历史密文仍可解。
    let salt: string | null = null;
    const saltFile = readTextFile(this.saltPath);
    if (saltFile.data && /^[0-9a-f]{32}$/i.test(saltFile.data.trim())) {
      salt = saltFile.data.trim().toLowerCase();
    } else if (typeof data?.saltHex === 'string' && /^[0-9a-f]{32}$/i.test(data.saltHex)) {
      salt = data.saltHex.toLowerCase(); // 从老版 store.json 迁移
    }
    if (!salt) salt = randomBytes(16).toString('hex');
    this.saltHex = salt;
    try {
      writeTextAtomic(this.saltPath, this.saltHex + '\n');
    } catch (err) {
      this.lastError = 'salt 持久化失败（历史密文可能无法解开）：' + String(err);
      console.error('[dsh-nas-sync] ' + this.lastError);
    }

    // ③ 逐字段恢复，坏一个不影响其它。
    if (data && typeof data === 'object') {
      if (data.snapshot && typeof data.snapshot === 'object') {
        /**
         * 僵尸态清理（0.5.1）：手机切后台时 node 进程会被冻结/杀掉，`sync()` 的
         * finally 等不到，磁盘上就留下 running:true + 半截 progress。Store 只在
         * 插件加载时构造一次，此刻本进程不可能已有同步在跑，所以那是上一具尸体。
         */
        this.snapshot = {
          ...DEFAULT_SNAPSHOT,
          ...data.snapshot,
          running: false,
          phase: 'idle',
        };
      }
      if (Array.isArray(data.pendingFiles)) this.pendingFiles = data.pendingFiles;
      if (Array.isArray(data.conflicts)) this.conflicts = data.conflicts;
      if (Array.isArray(data.localManifest)) this.localManifest = data.localManifest;
      if (data.userConfig && typeof data.userConfig === 'object') this.userConfig = data.userConfig;
      if (data.sessionImports && typeof data.sessionImports === 'object') {
        this.sessionImports = data.sessionImports as Record<string, SessionImportRecord>;
      }
      if (data.deviceCursors && typeof data.deviceCursors === 'object') {
        const out: Record<string, number> = {};
        for (const [k, v] of Object.entries(data.deviceCursors)) {
          if (Number.isFinite(v) && (v as number) >= 0) out[k] = Math.floor(v as number);
        }
        this.deviceCursors = out;
      }
      if (Array.isArray(data.pendingIntents)) {
        this.pendingIntents = data.pendingIntents.filter(
          (x: any) => x && (x.op === 'ignore' || x.op === 'unignore') && typeof x.sid === 'string' && x.sid,
        ).slice(0, 200);
      }
    }

    // ④ 凭据：优先独立文件；老版本从 store.json 迁移（下次 save 写成新格式）。
    const credFile = readJsonFile<Record<string, unknown>>(this.credentialsPath);
    if (credFile.corrupted) {
      this.lastError = '凭据文件损坏，已备份到 ' + (credFile.quarantinedTo ?? '(备份失败)')
        + '；请重新执行 nas_set_config 设置口令';
      console.error('[dsh-nas-sync] ' + this.lastError);
    }
    let secrets: Record<string, unknown> | null = credFile.data;
    if (!secrets && this.userConfig) {
      const migrated = splitSecrets(this.userConfig);
      secrets = migrated.secrets;
      this.userConfig = migrated.publicPart;
    }
    this.userConfig = mergeSecrets(this.userConfig, secrets);

    this.save();
  }

  save(): void {
    try {
      const { publicPart, secrets } = splitSecrets(this.userConfig);
      writeJsonAtomic(this.storePath, {
        saltHex: this.saltHex,
        snapshot: this.snapshot,
        pendingFiles: this.pendingFiles,
        conflicts: this.conflicts,
        localManifest: this.localManifest,
        userConfig: publicPart,
        sessionImports: this.sessionImports,
        deviceCursors: this.deviceCursors,
        pendingIntents: this.pendingIntents,
      });
      const credJson = JSON.stringify(secrets);
      if (credJson !== this.lastCredentialsJson) {
        writeJsonAtomic(this.credentialsPath, secrets);
        this.lastCredentialsJson = credJson;
      }
    } catch (err) {
      this.lastError = '状态文件写入失败：' + String(err);
      console.error('[dsh-nas-sync] ' + this.lastError);
    }
  }

  salt(): Uint8Array {
    return Uint8Array.from(Buffer.from(this.saltHex, 'hex'));
  }
}
