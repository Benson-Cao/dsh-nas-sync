/**
 * dsh-nas-sync · 客户端桥接层（Compose 侧）
 * -------------------------------------------
 * 这里只定义接口与默认实现骨架。不同 DSH 版本的客户端 SDK 名字可能不同：
 *  - 若宿主提供 scope.callTool(...)，把调用转发给它即可；
 *  - 若宿主走 postMessage / IPC，把 JSON 序列化挂到对应通道。
 *
 * 重点：本层不访问文件系统、不持有密码明文。
 * 敏感字段（webdav.password / passphrase）只从设置绑定中读取并提交，
 * 不进任何 ViewModel 状态、不进日志。
 */

import type {
  ConflictItem,
  ConflictPage,
  DiffLine,
  MergeResult,
  PendingFile,
  PendingPage,
  SyncSnapshot,
} from '../data/models.js';

export interface DshPluginBridge {
  /** 调用 Host 半注册的工具 */
  callTool<T>(name: string, args?: Record<string, string>): Promise<T>;

  /** 设置命名空间绑定：双向绑定到表单状态 */
  bindConfig<T>(): T;
  saveConfig(): Promise<void>;
}

export class DefaultBridge implements DshPluginBridge {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async callTool<T>(_name: string, _args?: Record<string, string>): Promise<T> {
    // 由宿主 SDK 注入真实实现，例如：
    //   return scope.callTool<T>(name, args);
    throw new Error('DefaultBridge 必须由宿主实现替换，不可直接使用');
  }

  bindConfig<T>(): T {
    throw new Error('bindConfig 必须由宿主实现替换');
  }

  async saveConfig(): Promise<void> {
    throw new Error('saveConfig 必须由宿主实现替换');
  }
}

/** 带序列化 helper：Compose 侧按需求自行封装 */
export async function callList<T>(
  bridge: DshPluginBridge,
  name: string,
  args?: Record<string, string>,
): Promise<T[]> {
  return bridge.callTool<T[]>(name, args);
}

export type {
  ConflictItem,
  ConflictPage,
  DiffLine,
  MergeResult,
  PendingFile,
  PendingPage,
  SyncSnapshot,
};
