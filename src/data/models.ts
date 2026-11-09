/**
 * dsh-nas-sync · 数据模型
 * -------------------------
 * 所有跨层（Host 工具 <-> 客户端 RPC <-> 持久化 store）传递的结构都集中在此。
 * 新增字段时注意保持 JSON 可序列化，客户端用同名结构反序列化。
 */

export type SyncPhase = 'idle' | 'scanning' | 'uploading' | 'downloading' | 'error';

export interface ProgressInfo {
  /** 本次任务涉及的文件总数 */
  total: number;
  /** 已完成（含跳过）数 */
  done: number;
  /** 失败数 */
  errors: number;
}

export interface SyncSnapshot {
  lastSyncTime: number | null;
  phase: SyncPhase;
  progress: ProgressInfo;
  pendingCount: number;
  conflictCount: number;
  /** 本次任务是否仍在运行 */
  running: boolean;
}

/** 清单条目：本地 / 远端文件指纹 */
export interface ManifestEntry {
  rel: string;
  mtime: number;
  size: number;
  hash: string;
  /**
   * 最后上传这个文件的设备，形如 `win32:DESKTOP-ABC` / `android:V2458A`。
   *
   * 用途：面板上标「这份数据来自哪台设备」。判定原则是**内容没变就保留原来源**
   * （见 engine.sync 收尾），否则每次同步都会被刷成"本机"，等于没记。
   * 旧版本清单没有这个字段，读到时按未知处理，不影响同步。
   */
  device?: string;

  // ---- 0.6.0 / P0：事件协议附加字段（全部可选，v1 清单读到旧结构不受影响） ----
  /** 事件协议版本；v1 清单没有该字段 */
  version?: number;
  /** 内容寻址指纹，指向 /dsh/objects/<前2位>/<hash>；与 hash 同值，显式化便于 CAS 寻址 */
  cas?: string;
  /** 非空表示该条目已被删除（墓碑写进清单时的软删除标记） */
  deletedAt?: number;
  /** 插件包体所属平台：`${platform}/${arch}/node-${abi}` */
  platform?: string;
}

/** 冲突记录：同一文件在两端均有变更，无法自动判定 */
export interface ConflictItem {
  rel: string;
  localMtime: number;
  remoteMtime: number;
  localHash: string;
  remoteHash: string;
  /** 文本类文件才可能为 true，客户端据此显示“尝试自动合并”按钮 */
  mergeable: boolean;
}

/** 待同步文件 */
export interface PendingFile {
  rel: string;
  size: number;
  /** upload = 本地新于远端，需推送；download = 反之；delete = 仅一端存在需删除 */
  action: 'upload' | 'download' | 'delete';
  /**
   * 早期排序用的权重（当前引擎按「先上传后下载、小文件优先」现算，不再读它）。
   * 保留字段但改为可选：历史上没有任何一处赋值，写成必填只会让所有
   * `pending.push({rel,size,action})` 都变成类型错误。
   */
  priority?: number;
}

/** 分页结果 */
export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PendingPage extends PageResult<PendingFile> {}
export interface ConflictPage extends PageResult<ConflictItem> {}

/** 分块状态（持久化于 ~/.dsh/.../chunks/<hash>.json） */
export interface ChunkState {
  index: number;
  offset: number;
  size: number;
  hash: string;
  uploaded: boolean;
}

export interface FileState {
  filePath: string;
  totalSize: number;
  chunks: ChunkState[];
  completeHash: string;
  completed: boolean;
}

/** 分块清单（远端）：读取方据此重组文件 */
export interface ChunkManifest {
  chunks: string[];
  completeHash: string;
}

/** 三路合并结果 */
export interface MergeResult {
  success: boolean;
  mergedContent?: string;
  hasConflicts?: boolean;
  reason?: string;
}

/** 行级 diff */
export type DiffLineType = 'same' | 'add' | 'remove' | 'change';

export interface DiffLine {
  type: DiffLineType;
  line: string;
}

/** 冲突解决方式 */
export type Resolution = 'local' | 'remote' | 'skip';

// ---------------------------------------------------------------------------
// 0.6.0 / P0：事件日志、墓碑、设备位点
// ---------------------------------------------------------------------------

/** 事件种类。事件一旦写入不可变，靠「追加新事件」表达状态变化。 */
export type SyncEventOp =
  | 'upsert'             // 新增 / 更新一条内容
  | 'delete'             // 删除（对端应把对象移进回收站，而不是硬删）
  | 'ignore'             // 屏蔽一条会话（全局生效）
  | 'unignore'           // 撤销屏蔽
  | 'plugin-install'     // 装了某个平台的插件包体
  | 'plugin-uninstall';  // 卸载插件

/**
 * 同步事件（只追加、不可变）。
 *
 * 发号规则：`(device, seq)` 全局唯一，每台设备自己发号、只写自己的日志分片，
 * 因此两台设备并发同步时**不会互相覆盖**。读端按 `(ts, device, seq)` 排序回放。
 *
 * `key` 是稳定主键：会话按 sessionId、插件按 `name@platform/abi`、其余按 rel。
 * 这一点是「一端删除另一端也删除」能跨不同 rel 生效的前提 —— 同一会话在电脑和
 * 手机上的 rel 因为 cwd 编码不同永远不相等，只有按 sid 归并才对得上。
 *
 * `sig` 覆盖除自身外的所有字段，用来分辨「半截写 / 被改过」和「合法空日志」，
 * 与 0.5.9 里 `tryReadManifestAt()` 吞异常返回 [] 是同一类问题的正面解法。
 */
export interface SyncEvent {
  v: 2;
  device: string;
  /** 该设备内从 1 开始单调递增 */
  seq: number;
  /** 物理毫秒；同一毫秒内由 compareEvents 打破平局 */
  ts: number;
  key: string;
  /** 事件对应的 rel（会话可能是 canonical rel） */
  rel?: string;
  /** 内容 CAS 指纹（明文 sha256）；delete 事件可空 */
  hash?: string;
  op: SyncEventOp;
  /** 分类前缀：sessions / attachments / skills / plugins … */
  category?: string;
  /** 插件对象用：平台 / 架构 / Node ABI */
  platform?: string;
  /** 删除事件的回收保留天数；0 = 永久，缺省走 DEFAULT_RETENTION_DAYS */
  retentionDays?: number;
  /** 事件体校验和（sha256 hex） */
  sig?: string;
}

/** 墓碑：由 delete 事件回放生成。删除优先，但保留期内可从回收副本恢复。 */
export interface Tombstone {
  key: string;
  rel?: string;
  deletedAt: number;
  by: string;
  device: string;
  seq: number;
  /** 到期时间（毫秒）；0 = 永不过期 */
  expiresAt: number;
  /** 远端回收副本路径 */
  trashRel?: string;
}

/** 设备位点：本机已确认处理到某台设备的哪个 seq。 */
export interface DeviceCursor {
  device: string;
  appliedSeq: number;
  updatedAt: number;
}

/** 事件流完整性判据（0.6.0 的 fail-closed 闸门）。 */
export interface EventStreamTrust {
  trusted: boolean;
  /** 读失败的日志分片名 + 签名校验失败的事件 id */
  failed: string[];
  /** 每台设备 seq 的缺口 */
  gaps: Array<{ device: string; from: number; to: number }>;
  /** 签名校验失败的事件 id */
  badSignatures: string[];
}

/** 会话稳定 ID ↔ rel 双向映射（P2）。 */
export interface BidMapEntry {
  sid: string;
  /** 跨设备统一的 canonical rel */
  canonicalRel: string;
  /** 本机按宿主 cwd 编码落地的真实 rel */
  localRel: string;
  /** 回传时要改回的原机器 cwd */
  originalCwd?: string;
  version: number;
  hash?: string;
}

/** 插件包体 CAS 装配记录（P4）。 */
export interface PluginObjectRecord {
  name: string;
  version: string;
  /** `${platform}/${arch}/node-${abi}` */
  target: string;
  /** 包体内容的 sha256，指向 /dsh/objects/<前2位>/<hash> */
  objectHash: string;
  size: number;
  device: string;
}
