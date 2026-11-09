/**
 * dsh-nas-sync · 传输层抽象
 * ---------------------------
 * 统一 WebDAV 与本地挂载两种后端，同步引擎不感知具体实现。
 * 实现类需保证：所有写操作都是“先写临时名 + 校验 + 重命名”，避免半成品文件。
 */

export interface NasEntry {
  name: string;
  mtime: number;
  size: number;
  type: 'file' | 'dir';
}

export interface PutBufferOptions {
  /** 目标为目录时是否自动创建父级 */
  mkdirs?: boolean;
}

/**
 * CAS 写入结果（0.6.0 / P0）。
 *
 * `ok:false` 且 `reason:'conflict'` 表示远端已被别的设备改过，调用方必须重读再试，
 * 不能盲目覆盖 —— 事件日志分片由多台设备各写各的，但墓碑总表 / 位点这类共享
 * 文件需要这种「比较并交换」才不会互相盖掉。
 */
export interface CasResult {
  ok: boolean;
  etag: string | null;
  reason?: 'conflict' | 'unsupported';
}

export interface NasTransport {
  /** 连通性自检 */
  test(): Promise<boolean>;

  list(path: string): Promise<NasEntry[]>;

  /** 上传：本地文件 -> 远端路径 */
  put(local: string, remote: string, opts?: PutBufferOptions): Promise<void>;

  /** 上传：内存缓冲区 -> 远端路径 */
  putBuffer(data: Uint8Array, remote: string, opts?: PutBufferOptions): Promise<void>;

  /** 下载：远端路径 -> 本地文件 */
  get(remote: string, local: string): Promise<void>;

  /** 下载为缓冲区 */
  getBuffer(remote: string): Promise<Uint8Array>;

  stat(remote: string): Promise<{ mtime: number; size: number } | null>;

  delete(remote: string): Promise<void>;

  /** 创建目录（幂等） */
  mkdir(remote: string): Promise<void>;

  // -------------------------------------------------------------------------
  // 0.6.0 / P0 新增能力。设为**可选**是为了不破坏任何已有实现 / 单测桩；
  // 内置的两个后端（webdav / mount）均已实现。引擎在使用前必须检查存在性，
  // 缺失时退回「只追加、不覆盖」的安全路径（见 engine 的 eventLog 相关代码）。
  // -------------------------------------------------------------------------

  /**
   * 读远端的强校验子（ETag / 内容哈希）。不存在返回 null。
   * 服务器不提供 ETag 时，实现应退回「mtime+size 的确定性串」，保证 CAS 仍可用。
   */
  etag?(remote: string): Promise<string | null>;

  /**
   * 比较并交换：仅当远端当前校验子 === `expectEtag` 时写入。
   * `expectEtag === null` 表示「要求目标当前不存在」（用于首次创建）。
   */
  putIfMatch?(
    data: Uint8Array,
    remote: string,
    expectEtag: string | null,
    opts?: PutBufferOptions,
  ): Promise<CasResult>;

  /** 递归删除目录及其全部内容（0.5.9 的 delete 只能删空目录/单文件）。 */
  deleteTree?(remote: string): Promise<void>;

  /** 原子重命名 / 移动（用于把删除对象搬进回收副本，而不是硬删）。 */
  rename?(from: string, to: string): Promise<void>;
}
