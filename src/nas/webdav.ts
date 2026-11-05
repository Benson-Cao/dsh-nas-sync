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
  /** NAS 端共享文件夹名或子路径（如 /dsh-sync）；空 = 根目录 */
  remotePath?: string;
}

/**
 * 归一化成 Buffer —— webdav@5 的入参判定只认 Buffer / ArrayBuffer / string，
 * **裸 Uint8Array 会连中两枪**：
 *   1. `calculateDataLength()` 三个分支全落空 → 抛 `Cannot calculate data length: Invalid type`；
 *   2. 就算绕过第 1 条，`requestDataToFetchBody()` 会把 Uint8Array 当成普通对象
 *      去 `JSON.stringify`，传上去的是 `{"0":137,"1":80,...}` 这种垃圾字节
 *      —— 比直接报错更糟，NAS 上会落一堆看起来「成功」的坏文件。
 *
 * 而本插件的同步引擎传的全是裸 Uint8Array（TextEncoder.encode / secretbox 输出 /
 * subarray 切片），所以必须在这里做转换。
 *
 * `Buffer.from(arrayBuffer, offset, length)` 与源共享同一段内存（零拷贝），
 * 但对 `subarray()` 产生的视图必须带上 byteOffset/byteLength，否则会传错区间。
 */
function toBuffer(data: Uint8Array | ArrayBuffer | string): Buffer {
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  const u8 = data as Uint8Array;
  return Buffer.from(u8.buffer as ArrayBuffer, u8.byteOffset, u8.byteLength);
}

/** 上传统一收口：Buffer + 显式 Content-Length（不依赖库自身的长度推断） */
async function upload(client: WebDAVClient, target: string, data: Uint8Array | ArrayBuffer | string) {
  const buf = toBuffer(data);
  await client.putFileContents(target, buf, { overwrite: true, contentLength: buf.byteLength });
}

export function createWebdavTransport(opts: WebdavOptions): NasTransport {
  const client: WebDAVClient = createClient(opts.url, {
    username: opts.username,
    password: opts.password,
  });

  // 远程基路径规范化：'共享文件夹/子目录'（去首尾斜杠）；空 = 根目录。
  // 所有远端操作在传输层内部统一拼前缀，引擎与同步逻辑传相对路径即可。
  const base = String(opts.remotePath || '').replace(/^\/+|\/+$/g, '');
  const p = (remote: string): string => {
    const r = String(remote).replace(/^\/+/, '');
    return base ? base + '/' + r : r;
  };
  /** test 用的目录：有 base 时直接探测该目录（fnOS/群晖按共享文件夹授权，根路径可能 401/403） */
  const baseDir = base ? '/' + base : '/';

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
        await client.getDirectoryContents(baseDir);
        return true;
      } catch (e: any) {
        const parts: string[] = [];
        if (e?.response?.status) parts.push('HTTP ' + e.response.status);
        if (e?.status) parts.push('HTTP ' + e.status);
        if (e?.code) parts.push('code=' + e.code);
        const msg = String(e?.message || e || 'unknown');
        throw new Error(
          `${opts.url}${baseDir} 无法访问` + (parts.length ? '（' + parts.join(', ') + '）' : '') + '：' + msg
            + (parts.includes('HTTP 401') ? '（用户名或密码错误，或该账号无 WebDAV 权限）' : ''),
        );
      }
    },

    async list(path) {
      const raw = await client.getDirectoryContents(p(path));
      const items = Array.isArray(raw) ? raw : [raw];
      return items.map((i: any) => ({
        name: String(i.basename),
        mtime: new Date(i.lastmod).getTime(),
        size: Number(i.size),
        type: i.type === 'directory' ? 'dir' : 'file',
      }));
    },

    async put(local, remote, opts) {
      const target = p(remote);
      if (opts?.mkdirs) await ensureParent(target);
      const { readFileSync } = await import('node:fs');
      await upload(client, target, readFileSync(local));
    },

    async putBuffer(data, remote, opts) {
      const target = p(remote);
      if (opts?.mkdirs) await ensureParent(target);
      await upload(client, target, data);
    },

    async get(remote, local) {
      const buf = await client.getFileContents(p(remote));
      const { writeFileSync, mkdirSync, dirname } = await import('node:fs');
      const path = await import('node:path');
      mkdirSync(path.dirname(local), { recursive: true });
      writeFileSync(local, buf as Uint8Array);
    },

    async getBuffer(remote) {
      const buf = await client.getFileContents(p(remote));
      return buf as Uint8Array;
    },

    async stat(remote) {
      try {
        const s = await client.stat(p(remote)) as any;
        return { mtime: new Date(s.lastmod).getTime(), size: Number(s.size) };
      } catch {
        return null;
      }
    },

    async delete(remote) {
      try {
        await client.deleteFile(p(remote));
      } catch {
        // 目标不存在视为成功
      }
    },

    async mkdir(remote) {
      try {
        await client.createDirectory(p(remote));
      } catch {
        // 已存在视为成功
      }
    },
  };
}
