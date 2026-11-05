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
