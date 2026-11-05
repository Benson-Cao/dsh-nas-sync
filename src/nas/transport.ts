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
}
