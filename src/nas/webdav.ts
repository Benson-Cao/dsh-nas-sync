/**
 * dsh-nas-sync · WebDAV 传输层
 * -----------------------------
 * 适用于群晖 DSM、OpenList、Nextcloud、Apache mod_dav 等。
 * 不支持原子重命名的服务器上，put 退化为直接覆盖（仍可接受，因为
 * manifest 记录了完整哈希，消费方会校验）。
 */

import { createClient, type WebDAVClient } from 'webdav';
import type { NasEntry, NasTransport, PutBufferOptions } from './transport.js';

export interface WebdavOptions {
  url: string;
  username: string;
  password: string;
}

export function createWebdavTransport(opts: WebdavOptions): NasTransport {
  const client: WebDAVClient = createClient(opts.url, {
    username: opts.username,
    password: opts.password,
  });

  const ensureParent = async (remote: string): Promise<void> => {
    const segs = remote.split('/').filter(Boolean);
    segs.pop();
    if (segs.length === 0) return;
    let acc = '';
    for (const seg of segs) {
      acc += '/' + seg;
      try {
        await client.createDirectory(acc);
      } catch {
        // 已存在视为成功
      }
    }
  };

  return {
    async test() {
      try {
        await client.getDirectoryContents('/');
        return true;
      } catch {
        return false;
      }
    },

    async list(path) {
      const raw = await client.getDirectoryContents(path);
      const items = Array.isArray(raw) ? raw : [raw];
      return items.map((i: any) => ({
        name: String(i.basename),
        mtime: new Date(i.lastmod).getTime(),
        size: Number(i.size),
        type: i.type === 'directory' ? 'dir' : 'file',
      }));
    },

    async put(local, remote, opts) {
      if (opts?.mkdirs) await ensureParent(remote);
      const { readFileSync } = await import('node:fs');
      const data = readFileSync(local);
      await client.putFileContents(remote, data, { overwrite: true });
    },

    async putBuffer(data, remote, opts) {
      if (opts?.mkdirs) await ensureParent(remote);
      await client.putFileContents(remote, data, { overwrite: true });
    },

    async get(remote, local) {
      const buf = await client.getFileContents(remote);
      const { writeFileSync, mkdirSync, dirname } = await import('node:fs');
      const path = await import('node:path');
      mkdirSync(path.dirname(local), { recursive: true });
      writeFileSync(local, buf as Uint8Array);
    },

    async getBuffer(remote) {
      const buf = await client.getFileContents(remote);
      return buf as Uint8Array;
    },

    async stat(remote) {
      try {
        const s = await client.stat(remote) as any;
        return { mtime: new Date(s.lastmod).getTime(), size: Number(s.size) };
      } catch {
        return null;
      }
    },

    async delete(remote) {
      try {
        await client.deleteFile(remote);
      } catch {
        // 目标不存在视为成功
      }
    },

    async mkdir(remote) {
      try {
        await client.createDirectory(remote);
      } catch {
        // 已存在视为成功
      }
    },
  };
}
