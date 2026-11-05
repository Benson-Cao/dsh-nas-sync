/**
 * dsh-nas-sync · 传输层工厂
 */

import { createWebdavTransport } from './webdav.js';
import { createMountTransport } from './mount.js';
import type { NasTransport } from './transport.js';
import type { NasSyncConfig } from '../config.js';

export function createTransport(cfg: NasSyncConfig): NasTransport {
  if (cfg.type === 'mount') {
    if (!cfg.mountRoot) throw new Error('未配置 mountRoot（NAS 挂载点）');
    return createMountTransport(cfg.mountRoot);
  }
  if (!cfg.webdav) throw new Error('未配置 WebDAV 连接信息');
  return createWebdavTransport(cfg.webdav);
}

export type { NasTransport } from './transport.js';
export { createWebdavTransport } from './webdav.js';
export { createMountTransport } from './mount.js';
