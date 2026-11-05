/**
 * dsh-nas-sync · 本地挂载点传输层
 * ---------------------------------
 * 用于 NAS 已通过 SMB / NFS / SSHFS 挂到本机某个目录的场景。
 * 由于是本地文件系统，stat 更可靠，适合作为 WebDAV 不可用时的兜底。
 */

import { stat, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { NasEntry, NasTransport, PutBufferOptions } from './transport.js';

export function createMountTransport(root: string): NasTransport {
  const abs = (p: string): string => join(root, p);

  return {
    async test() {
      try {
        await stat(root);
        return true;
      } catch {
        return false;
      }
    },

    async list(path) {
      const dirents = await readdir(abs(path), { withFileTypes: true });
      return Promise.all(
        dirents.map(async (d) => {
          const s = await stat(join(abs(path), d.name));
          return {
            name: d.name,
            mtime: s.mtimeMs,
            size: s.size,
            type: d.isDirectory() ? 'dir' : 'file',
          } as NasEntry;
        }),
      );
    },

    async put(local, remote, _opts) {
      const target = abs(remote);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, await readFile(local));
    },

    async putBuffer(data, remote, _opts) {
      const target = abs(remote);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data);
    },

    async get(remote, local) {
      await mkdir(dirname(local), { recursive: true });
      await writeFile(local, await readFile(abs(remote)));
    },

    async getBuffer(remote) {
      return new Uint8Array(await readFile(abs(remote)));
    },

    async stat(remote) {
      try {
        const s = await stat(abs(remote));
        return { mtime: s.mtimeMs, size: s.size };
      } catch {
        return null;
      }
    },

    async delete(remote) {
      await rm(abs(remote), { force: true, recursive: false });
    },

    async mkdir(remote) {
      await mkdir(abs(remote), { recursive: true });
    },
  };
}
