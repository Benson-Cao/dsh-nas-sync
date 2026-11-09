/**
 * dsh-nas-sync · 本地挂载点传输层
 * ---------------------------------
 * 用于 NAS 已通过 SMB / NFS / SSHFS 挂到本机某个目录的场景。
 * 由于是本地文件系统，stat 更可靠，适合作为 WebDAV 不可用时的兜底。
 *
 * 0.6.0 / P0：
 *   - 所有写操作真正走「临时文件 + 原子重命名」（文件头注释承诺了很久，之前 putBuffer
 *     是直接 writeFile，断电/中断会留下半截文件）；
 *   - 补齐 etag / putIfMatch / deleteTree / rename 四个新能力，语义与 webdav 后端对齐。
 */

import { stat, mkdir, writeFile, readFile, rm, readdir, rename as fsRename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import type { CasResult, NasEntry, NasTransport } from './transport.js';

export function createMountTransport(root: string): NasTransport {
  const abs = (p: string): string => join(root, p);

  /**
   * 本地没有 ETag，用 `weak:<mtime>:<size>` 当校验子。
   * ENOENT 才是「不存在」；EACCES / EIO 一律冒泡，不能被 CAS 误当成可覆盖。
   */
  const etagOf = async (remote: string): Promise<string | null> => {
    try {
      const s = await stat(abs(remote));
      return 'weak:' + Math.floor(s.mtimeMs) + ':' + s.size;
    } catch (e: any) {
      if (e?.code === 'ENOENT') return null;
      throw e;
    }
  };

  /** 原子写：同目录临时名 → rename。跨设备挂载时同目录保证同一文件系统。 */
  const atomicWrite = async (target: string, data: Uint8Array): Promise<void> => {
    await mkdir(dirname(target), { recursive: true });
    const tmp = target + '.tmp-' + randomUUID();
    try {
      await writeFile(tmp, data);
      await fsRename(tmp, target);
    } catch (e) {
      try { await rm(tmp, { force: true }); } catch { /* 清理失败不影响抛错 */ }
      throw e;
    }
  };

  return {
    async test() {
      try {
        await stat(root);
        return true;
      } catch (e: any) {
        throw new Error(`挂载点不可访问 ${root}（code=${e?.code ?? 'unknown'}）：${e?.message ?? e}`);
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
      await atomicWrite(abs(remote), await readFile(local));
    },

    async putBuffer(data, remote, _opts) {
      await atomicWrite(abs(remote), data);
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

    // ---- 0.6.0 / P0：CAS / 递归删 / 原子重命名 ----
    etag: etagOf,

    async putIfMatch(data, remote, expectEtag, _opts): Promise<CasResult> {
      const cur = await etagOf(remote);
      if (cur !== expectEtag) return { ok: false, etag: cur, reason: 'conflict' };
      await atomicWrite(abs(remote), data);
      return { ok: true, etag: await etagOf(remote) };
    },

    async deleteTree(remote) {
      // 0.5.9 这里 recursive:false，遇到非空目录直接失败；删除传播必须能删整棵会话子树。
      await rm(abs(remote), { force: true, recursive: true });
    },

    async rename(from, to) {
      const b = abs(to);
      await mkdir(dirname(b), { recursive: true });
      await fsRename(abs(from), b);
    },
  };
}
