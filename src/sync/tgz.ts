/**
 * dsh-nas-sync · 零依赖 tgz 解包（0.6.0 / 收尾④）
 * ---------------------------------------------------
 * 插件包体进 CAS 后是 `.tgz`（gzip + tar）。手机端没有宿主 CLI，不能靠
 * `pnpm add` 去装，必须自己把对象解包写进 `node_modules/<name>/`。
 *
 * 为什么不用 tar / adm-zip 之类的依赖：这个插件要塞进 DSH 的 bundle，
 * 多一个依赖就多一份跨平台原生模块风险；Node 22 自带 `zlib.gunzipSync`，
 * tar 的 USTAR / PAX / GNU longname 解析只有一百多行，完全可以自己写。
 *
 * 这是一段**处理不可信输入**的代码（对象来自 NAS，可能被篡改），所以默认
 * fail-closed：
 *   · 拒绝绝对路径、盘符、`..`、反斜杠、NUL、符号链接 / 硬链接 / 设备文件；
 *   · 条目数、单文件大小、解压总大小、压缩比都有上限（防解压炸弹）；
 *   · 校验 tar 头 checksum；
 *   · 路径归一化后仍必须落在给定的目标目录内（由调用方再核一次）。
 *
 * 只读内存、不碰 fs；写文件由 installer.ts 负责。
 */

import { gunzipSync } from 'node:zlib';

const BLOCK = 512;

export interface TgzEntry {
  /** 归一化后的相对路径（无前导 /、无 ..） */
  path: string;
  data: Uint8Array;
  /** tar 里的 mode（八进制数值），目录项 data 为空 */
  mode: number;
  isDir: boolean;
}

export interface UnpackOptions {
  /** 剥离 npm tarball 常见的顶层目录，默认 'package/' */
  stripPrefix?: string;
  maxEntries?: number;
  maxTotalBytes?: number;
  maxEntryBytes?: number;
  /** 解压后 / 压缩前 的字节比上限，默认 200 */
  maxInflationRatio?: number;
}

export interface UnpackResult {
  entries: TgzEntry[];
  /** 被安全策略拒绝的条目（路径 / 类型） */
  rejected: Array<{ path: string; reason: string }>;
}

const DEFAULTS = {
  maxEntries: 20_000,
  maxTotalBytes: 256 * 1024 * 1024,
  maxEntryBytes: 64 * 1024 * 1024,
  maxInflationRatio: 200,
};

function cstr(bytes: Uint8Array, at: number, len: number): string {
  let end = at + len;
  if (end > bytes.length) end = bytes.length;
  let out = '';
  for (let i = at; i < end; i++) {
    if (bytes[i] === 0) break;
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}

/** tar 的 size 字段：普通八进制，或高位为 1 的 base-256。 */
function parseSize(bytes: Uint8Array, at: number, len: number): number {
  const first = bytes[at];
  if (first & 0x80) {
    let n = BigInt(first & 0x7f);
    for (let i = 1; i < len; i++) n = (n << 8n) | BigInt(bytes[at + i]);
    const v = Number(n);
    return Number.isSafeInteger(v) ? v : -1;
  }
  const s = cstr(bytes, at, len).replace(/\s/g, '');
  if (!s) return 0;
  const v = parseInt(s, 8);
  return Number.isSafeInteger(v) && v >= 0 ? v : -1;
}

function parseMode(bytes: Uint8Array, at: number, len: number): number {
  const s = cstr(bytes, at, len).replace(/\s/g, '');
  const v = s ? parseInt(s, 8) : 0o644;
  return Number.isFinite(v) && v >= 0 ? v : 0o644;
}

/** tar 头校验和：空格当作校验位，signed / unsigned 两种算法都接受。 */
function checksumOk(header: Uint8Array): boolean {
  const want = parseSize(header, 148, 8);
  if (want < 0) return false;
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK; i++) {
    const b = i >= 148 && i < 156 ? 0x20 : header[i];
    unsigned += b;
    signed += b > 127 ? b - 256 : b;
  }
  return unsigned === want || signed === want;
}

/** PAX 扩展头：`"<长度> <key>=<value>\n"` 逐条拼接。 */
function parsePax(data: Uint8Array): Record<string, string> {
  const text = Buffer.from(data).toString('latin1'); // 1 字节 1 字符，偏移才对得上
  const out: Record<string, string> = {};
  let i = 0;
  while (i < text.length) {
    const sp = text.indexOf(' ', i);
    if (sp < 0) break;
    const len = parseInt(text.slice(i, sp), 10);
    if (!Number.isFinite(len) || len <= 0 || i + len > text.length) break;
    const rec = text.slice(sp + 1, i + len).replace(/\n$/, '');
    const eq = rec.indexOf('=');
    if (eq > 0) {
      const key = rec.slice(0, eq);
      const raw = rec.slice(eq + 1);
      // 值按 UTF-8 还原（路径可能含中文）
      out[key] = Buffer.from(raw, 'latin1').toString('utf8');
    }
    i += len;
  }
  return out;
}

/**
 * 把 tar 里的原始路径归一化成安全的相对路径。
 * 返回 null 表示必须拒绝。这里只做词法判定，真正的「落在目标目录内」
 * 由调用方用 path.resolve 再核一次。
 */
export function safeTarPath(raw: string, stripPrefix = 'package/'): string | null {
  let p = String(raw || '');
  if (!p || p.includes('\0') || p.includes('\\')) return null;
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return null;
  if (stripPrefix && p.startsWith(stripPrefix)) p = p.slice(stripPrefix.length);
  const parts = p.split('/').filter((s) => s.length > 0 && s !== '.');
  if (parts.some((s) => s === '..')) return null;
  if (parts.length === 0) return null;      // 顶层 package/ 目录本身不需要写
  return parts.join('/');
}

/** 解开一段 .tgz 数据。任何越界 / 损坏 / 超限都抛错，不返回半份结果。 */
export function unpackTgz(gz: Uint8Array, opts: UnpackOptions = {}): UnpackResult {
  const o = { ...DEFAULTS, ...opts };
  if (!gz || gz.length === 0) throw new Error('空的 tgz 对象');
  let tar: Buffer;
  try {
    tar = gunzipSync(Buffer.from(gz));
  } catch (err) {
    throw new Error('tgz 解压失败（gzip 损坏或不是 gzip）：' + String(err));
  }
  if (tar.length > Math.max(1, o.maxTotalBytes)) {
    throw new Error('解压后体积超过上限 ' + o.maxTotalBytes);
  }
  if (gz.length > 0 && tar.length / gz.length > o.maxInflationRatio) {
    throw new Error('解压比异常（疑似解压炸弹）：' + (tar.length / gz.length).toFixed(1));
  }

  const entries: TgzEntry[] = [];
  const rejected: UnpackResult['rejected'] = [];
  let at = 0;
  let total = 0;
  let longName: string | null = null;
  let pax: Record<string, string> = {};
  let zeroBlocks = 0;

  while (at + BLOCK <= tar.length) {
    const header = tar.subarray(at, at + BLOCK);
    // tar 以两个全零块结束
    if (header.every((b) => b === 0)) {
      zeroBlocks++;
      at += BLOCK;
      if (zeroBlocks >= 2) break;
      continue;
    }
    zeroBlocks = 0;
    if (!checksumOk(header)) throw new Error('tar 头 checksum 不匹配（对象可能已损坏）');

    let name = cstr(header, 0, 100);
    const prefix = cstr(header, 345, 155);
    if (prefix) name = prefix + '/' + name;
    if (longName) { name = longName; longName = null; }
    const type = String.fromCharCode(header[156] || 0x30);
    let size = parseSize(header, 124, 12);
    if (pax.size) {
      const n = Number(pax.size);
      if (Number.isSafeInteger(n) && n >= 0) size = n;
    }
    if (pax.path) name = pax.path;
    pax = {};
    if (size < 0) throw new Error('tar 条目长度非法：' + name);
    const dataAt = at + BLOCK;
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    if (dataAt + padded > tar.length) throw new Error('tar 数据被截断：' + name);
    const body = tar.subarray(dataAt, dataAt + size);
    at = dataAt + padded;

    // GNU longname / PAX 扩展头：内容不是文件，只作用于下一条
    if (type === 'L') { longName = Buffer.from(body).toString('utf8').replace(/\0+$/, ''); continue; }
    if (type === 'x' || type === 'g') { pax = parsePax(body); continue; }

    const kindOk = type === '0' || type === '\0' || type === '5' || type === '7';
    if (!kindOk) {
      rejected.push({ path: name, reason: '不支持的 tar 类型 ' + JSON.stringify(type)
        + '（符号链接 / 硬链接 / 设备文件一律拒绝）' });
      continue;
    }
    const rel = safeTarPath(name, o.stripPrefix ?? 'package/');
    if (!rel) { rejected.push({ path: name, reason: '不安全的路径' }); continue; }
    if (entries.length >= o.maxEntries) throw new Error('tar 条目数超过上限 ' + o.maxEntries);
    if (size > o.maxEntryBytes) throw new Error('单文件超过上限：' + rel + ' (' + size + ')');
    total += size;
    if (total > o.maxTotalBytes) throw new Error('解压总大小超过上限 ' + o.maxTotalBytes);

    const isDir = type === '5' || name.endsWith('/');
    entries.push({
      path: rel,
      data: isDir ? new Uint8Array(0) : new Uint8Array(body),
      mode: parseMode(header, 100, 8),
      isDir,
    });
  }
  return { entries, rejected };
}
