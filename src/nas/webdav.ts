/**
 * dsh-nas-sync · WebDAV 传输层
 * -----------------------------
 * 适用于群晖 DSM、OpenList、Nextcloud、Apache mod_dav 等。
 * 不支持原子重命名的服务器上，put 退化为直接覆盖（仍可接受，因为
 * manifest 记录了完整哈希，消费方会校验）。
 *
 * 0.5.2 起每个请求都带硬超时（看门狗的第一道闸）：
 * `webdav@5` 的 client **没有全局 timeout 选项**，底层 fetch 也不设上限 ——
 * NAS 掉电、路由器 NAT 表过期、手机在半路被系统冻结，任何一个都会让请求
 * 永久挂在 socket 上，整轮同步永不返回（实测：面板卡在 scanning 一小时，
 * NAS 侧零写入）。这里把「永远挂着」降级成「N 秒后报一条能看懂的错」。
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

/** 元数据请求（列目录 / stat / 建目录 / 删除）超时：体积极小，20 秒还不回就是死了。 */
const META_TIMEOUT_MS = 20_000;
/**
 * 文件传输的时间下限：2MB 的会话在慢速移动网、冷 TLS 下也可能要一分多钟，
 * 卡太死会误杀正常传输。
 */
const FILE_TIMEOUT_FLOOR_MS = 120_000;
/**
 * 估算超时用的最差吞吐（16 KB/s）。比这更慢的网络本来也传不完一个文件，
 * 与其无限期挂着不如早早失败、让下一轮重试。
 */
const WORST_BPS = 16 * 1024;

/**
 * 按数据量算文件传输超时。
 * 小文件吃下限（120s），大文件按最差吞吐线性放大再留 30s 余量。
 */
function fileTimeoutMs(bytes: number): number {
  const naive = Math.ceil((bytes || 0) / WORST_BPS) * 1000 + 30_000;
  return Math.max(FILE_TIMEOUT_FLOOR_MS, naive);
}

/**
 * 造一个超时信号。
 * Node 18+ 有 `AbortSignal.timeout`；老引擎退化成手搓 controller，
 * 并对定时器 `unref()` —— 否则这个 timer 会把进程钉住不退出。
 */
function timeoutSignal(ms: number): AbortSignal | undefined {
  const anyAbort = AbortSignal as any;
  if (typeof AbortSignal !== 'undefined' && typeof anyAbort?.timeout === 'function') {
    return anyAbort.timeout(ms);
  }
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  (t as any).unref?.();
  return ac.signal;
}

/** 是否是超时/中止类错误（不同 Node / undici 版本给出的 name 不一样）。 */
function isAbortError(e: any): boolean {
  const name = String(e?.name || '');
  const code = String(e?.code || '');
  return name === 'AbortError' || name === 'TimeoutError' || code === 'ABORT_ERR' || code === 'UND_ERR_ABORTED';
}

/**
 * 统一给一次请求套超时，并把原始 abort 错误翻译成人话。
 * 原始错误是 `This operation was aborted`，用户看了完全不知道该干什么。
 */
async function guarded<T>(op: string, ms: number, run: (signal: AbortSignal | undefined) => Promise<T>): Promise<T> {
  try {
    return await run(timeoutSignal(ms));
  } catch (e: any) {
    if (isAbortError(e)) {
      throw new Error(
        op + ' 超时（' + Math.round(ms / 1000) + ' 秒无响应）' +
        '：NAS 可能已断开、被防火墙掐断，或手机在后台被系统冻结。请检查网络后重试。',
      );
    }
    throw e;
  }
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

/** 上传统一收口：Buffer + 显式 Content-Length（不依赖库自身的长度推断）+ 按大小算出的超时 */
async function upload(client: WebDAVClient, target: string, data: Uint8Array | ArrayBuffer | string) {
  const buf = toBuffer(data);
  await guarded('上传 ' + target, fileTimeoutMs(buf.byteLength), (signal) =>
    client.putFileContents(target, buf, { overwrite: true, contentLength: buf.byteLength, signal }));
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
        // 每层单独计时：几十层目录不能共用一个 20 秒的预算
        await guarded('建目录 ' + acc, META_TIMEOUT_MS, (signal) => client.createDirectory(acc, { signal }));
      } catch {
        // 已存在视为成功
      }
    }
  };

  return {
    async test() {
      try {
        await guarded('探测 ' + baseDir, META_TIMEOUT_MS, (signal) => client.getDirectoryContents(baseDir, { signal }));
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
      const target = p(path);
      const raw = await guarded('列目录 ' + target, META_TIMEOUT_MS, (signal) =>
        client.getDirectoryContents(target, { signal }));
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
      const target = p(remote);
      // 下载大小未知，按下限给足 120 秒；真卡住也会在这里断掉而不是挂到天荒地老
      const buf = await guarded('下载 ' + target, FILE_TIMEOUT_FLOOR_MS, (signal) =>
        client.getFileContents(target, { signal }));
      const { writeFileSync, mkdirSync } = await import('node:fs');
      const path = await import('node:path');
      mkdirSync(path.dirname(local), { recursive: true });
      writeFileSync(local, buf as Uint8Array);
    },

    async getBuffer(remote) {
      const target = p(remote);
      const buf = await guarded('下载 ' + target, FILE_TIMEOUT_FLOOR_MS, (signal) =>
        client.getFileContents(target, { signal }));
      return buf as Uint8Array;
    },

    async stat(remote) {
      const target = p(remote);
      try {
        const s = await guarded('stat ' + target, META_TIMEOUT_MS, (signal) =>
          client.stat(target, { signal })) as any;
        return { mtime: new Date(s.lastmod).getTime(), size: Number(s.size) };
      } catch {
        // 不存在 / 超时都返回 null：调用方按「远端没有」处理，下一轮会重试
        return null;
      }
    },

    async delete(remote) {
      const target = p(remote);
      try {
        await guarded('删除 ' + target, META_TIMEOUT_MS, (signal) => client.deleteFile(target, { signal }));
      } catch {
        // 目标不存在视为成功
      }
    },

    async mkdir(remote) {
      const target = p(remote);
      try {
        await guarded('建目录 ' + target, META_TIMEOUT_MS, (signal) => client.createDirectory(target, { signal }));
      } catch {
        // 已存在视为成功
      }
    },
  };
}
