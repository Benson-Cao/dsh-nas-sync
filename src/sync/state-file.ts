/**
 * dsh-nas-sync · 本地状态文件的安全读写（0.5.9）
 * ------------------------------------------------
 * 0.5.8 审查里的 Q05/Q06 是同一类问题：**状态文件被写坏或被读坏时静默降级**。
 *   · `store.json` 非原子写 → 进程被杀就留半截 JSON；构造时 `catch` 整份重置，
 *     连带把 scrypt salt 弄丢，历史密文再也解不开；
 *   · `ignored-sessions.json` 解析失败 → 屏蔽集合被静默清空，用户撤掉的会话全部复活。
 *
 * 这里提供四个只用 node 内建 fs 的小工具，便于离线单测（不依赖宿主 @deepseek-ai/*）：
 *   · `writeJsonAtomic()` / `writeTextAtomic()`  临时文件 + rename，带 0600/0700
 *   · `readJsonFile()` / `readTextFile()`       区分「文件不存在」与「文件损坏」，
 *                                              损坏时先备份副本再报告，绝不静默吞掉
 */
import {
  readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync,
  existsSync, copyFileSync, unlinkSync, readdirSync,
} from 'node:fs';
import { dirname, basename, join } from 'node:path';

/** 默认权限：状态文件里有凭据，不该是世界可读。Windows 上 chmod 是尽力而为。 */
export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_DIR_MODE = 0o700;

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/** 当前时间戳，只用于备份文件名。 */
function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** 目录建好并尽力收紧权限；已存在时不改变 owner。 */
function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
  try { chmodSync(dir, PRIVATE_DIR_MODE); } catch { /* Windows / 无权限：忽略 */ }
}

/** 原子写一个文本文件：同目录临时文件 → rename。断电/被杀时旧文件仍完整。 */
export function writeTextAtomic(path: string, text: string, mode = PRIVATE_FILE_MODE): void {
  const dir = dirname(path);
  ensurePrivateDir(dir);
  const tmp = path + '.tmp-' + process.pid;
  try {
    writeFileSync(tmp, text, { encoding: 'utf8', mode });
    try { chmodSync(tmp, mode); } catch { /* 忽略 */ }
    renameSync(tmp, path);
    try { chmodSync(path, mode); } catch { /* 忽略 */ }
  } catch (err) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* 忽略 */ }
    throw err;
  }
}

/** 原子写 JSON（格式与旧版一致：两空格缩进，无尾换行差异不影响解析）。 */
export function writeJsonAtomic(path: string, data: unknown, mode = PRIVATE_FILE_MODE): void {
  writeTextAtomic(path, JSON.stringify(data, null, 2) + '\n', mode);
}

export interface ReadResult<T> {
  /** 解析成功的数据；文件不存在 / 损坏时为 null */
  data: T | null;
  /** 文件本来就不存在（合法情况，不是错误） */
  missing: boolean;
  /** 存在但不是合法 JSON / 读失败 */
  corrupted: boolean;
  /** 损坏时备份出来的副本路径（尽力而为，可能为 undefined） */
  quarantinedTo?: string;
}

/**
 * 把损坏的文件复制一份留证；不删原件，由调用方决定怎么修。
 *
 * 同一个坏文件每轮扫描都会被读到一次，若每次都新建副本，几分钟就能攒出几十个
 * `.corrupt-*` 垃圾。内容相同的只留第一份。
 */
function quarantine(path: string): string | undefined {
  try {
    const raw = readFileSync(path);
    const dir = dirname(path);
    const prefix = basename(path) + '.corrupt-';
    let existing: string[] = [];
    try { existing = readdirSync(dir).filter((n) => n.startsWith(prefix)).slice(-5); } catch { /* 目录读不到 */ }
    for (const name of existing) {
      try {
        if (readFileSync(join(dir, name)).equals(raw)) return join(dir, name);
      } catch { /* 单个副本读不了就跳过 */ }
    }
    const target = path + '.corrupt-' + stamp();
    writeFileSync(target, raw);
    return target;
  } catch {
    return undefined;
  }
}

/** 读并解析 JSON。区分「没有这个文件」与「这个文件坏了」。 */
export function readJsonFile<T>(path: string): ReadResult<T> {
  try {
    const raw = readFileSync(path, 'utf8');
    return { data: JSON.parse(raw) as T, missing: false, corrupted: false };
  } catch (err) {
    if (isMissing(err)) return { data: null, missing: true, corrupted: false };
    return { data: null, missing: false, corrupted: true, quarantinedTo: quarantine(path) };
  }
}

/** 读纯文本（salt.hex 用）。 */
export function readTextFile(path: string): ReadResult<string> {
  try {
    return { data: readFileSync(path, 'utf8'), missing: false, corrupted: false };
  } catch (err) {
    if (isMissing(err)) return { data: null, missing: true, corrupted: false };
    return { data: null, missing: false, corrupted: true, quarantinedTo: quarantine(path) };
  }
}

/** 备份一份已知良好的内容（屏蔽清单的 last-known-good 用）。 */
export function writeBackup(path: string): boolean {
  try {
    if (!existsSync(path)) return false;
    copyFileSync(path, path + '.bak');
    return true;
  } catch {
    return false;
  }
}
