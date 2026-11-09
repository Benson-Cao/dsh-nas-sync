/**
 * dsh-nas-sync · 增量扫描缓存（0.6.0 / 收尾③）
 * ------------------------------------------------
 * 0.5.9 每轮扫描都对**每个**文件 `readFile()` 整份读进来算 sha256。工作区文件一多，
 * 手机上就是几秒钟的 IO + CPU，而且绝大部分文件内容根本没变。
 *
 * 这里用一个按 rel 记录的 `(mtimeMs, ctimeMs, size) → hash` 缓存：
 * 命中就跳过 readFile 与 sha256，直接复用上轮指纹。
 *
 * 为什么必须保守 —— 缓存误判的后果不是「慢一点」，是**内容变了却没上传**：
 *   · mtime 与 size 都可能被工具保持/伪造（touch -r、同秒覆盖写同样长度）；
 *   · 排除规则 / 分类勾选 / 单文件上限一变，原来的命中项可能已不该存在；
 *   · 进程被杀时缓存写一半，读到半截 JSON 会被当成「全新缓存」。
 *
 * 因此有五道失效判据，任一不满足就重算：
 *   ① 配置指纹不同 → 整表失效；
 *   ② mtimeMs / ctimeMs / size 任一变化 → 该条重算；
 *   ③ 超过 TTL（默认 24h）→ 该条强制重算；
 *   ④ hash 不是 64 位十六进制 → 该条丢弃；
 *   ⑤ 缓存文件损坏 → 整表作废并留下告警（不静默当空缓存）。
 *
 * 本模块只有纯逻辑 + 明确的 fs 边界（load/save 两个函数），便于离线单测。
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { dshHome } from '../paths.js';
import { readJsonFile, writeJsonAtomic } from './state-file.js';

export const SCAN_CACHE_VERSION = 1;
export const DEFAULT_SCAN_CACHE_TTL_MS = 24 * 3600 * 1000;

export interface ScanStat {
  mtimeMs: number;
  ctimeMs: number;
  size: number;
}

export interface ScanCacheEntry extends ScanStat {
  /** 上轮算出的 sha256（明文文件） */
  hash: string;
  /** 该条写入缓存的时间戳 */
  at: number;
}

export interface ScanCacheFile {
  version: number;
  /** 配置指纹；不同就整表失效 */
  fingerprint: string;
  entries: Record<string, ScanCacheEntry>;
}

export interface ScanCachePolicy {
  scope: Record<string, boolean>;
  includeSensitive: boolean;
  skillFilter: string[];
  customFolders: Array<{ name: string; path: string }>;
  maxFileBytes: number;
  sessionRelMode: string;
}

/** 配置指纹：任何影响「哪些文件进清单 / 清单里叫什么」的配置变化都要让它变。 */
export function configFingerprint(policy: ScanCachePolicy): string {
  const stable = {
    scope: Object.keys(policy.scope ?? {}).sort().map((k) => [k, !!policy.scope[k]]),
    includeSensitive: !!policy.includeSensitive,
    skillFilter: [...(policy.skillFilter ?? [])].sort(),
    customFolders: [...(policy.customFolders ?? [])]
      .map((f) => [String(f.name), String(f.path)])
      .sort((a, b) => a[0].localeCompare(b[0])),
    maxFileBytes: Number(policy.maxFileBytes) || 0,
    sessionRelMode: String(policy.sessionRelMode ?? 'legacy'),
  };
  return createHash('sha256').update(JSON.stringify(stable), 'utf8').digest('hex');
}

function validHash(h: unknown): h is string {
  return typeof h === 'string' && /^[0-9a-f]{64}$/i.test(h);
}

export function isCacheEntryValid(e: unknown): e is ScanCacheEntry {
  if (!e || typeof e !== 'object') return false;
  const x = e as Record<string, unknown>;
  return validHash(x.hash)
    && Number.isFinite(x.mtimeMs) && Number.isFinite(x.ctimeMs)
    && Number.isFinite(x.size) && Number.isFinite(x.at);
}

/** 单条是否可复用。纯函数，便于把五道判据逐条单测。 */
export function shouldReuse(
  prev: ScanCacheEntry | undefined,
  stat: ScanStat,
  opts: { now: number; ttlMs: number; samePolicy: boolean },
): boolean {
  if (!prev || !opts.samePolicy) return false;
  if (!isCacheEntryValid(prev)) return false;
  if (prev.mtimeMs !== stat.mtimeMs || prev.ctimeMs !== stat.ctimeMs || prev.size !== stat.size) {
    return false;
  }
  return opts.now - prev.at < Math.max(1, opts.ttlMs);
}

export interface ScanCacheStats {
  hits: number;
  misses: number;
  /** 因 stat 三元组变化而重算 */
  changed: number;
  /** 因 TTL 到期而重算 */
  expired: number;
  /** 因配置指纹变化而整表失效 */
  invalidated: boolean;
}

/**
 * 一轮扫描的缓存会话。Scanner 只通过 `lookup()` / `record()` 与它交互，
 * 不关心文件怎么存；引擎在扫描结束后 `snapshot()` 写盘。
 */
export class ScanCacheSession {
  readonly stats: ScanCacheStats = {
    hits: 0, misses: 0, changed: 0, expired: 0, invalidated: false,
  };
  private entries: Record<string, ScanCacheEntry> = {};

  constructor(
    prev: ScanCacheFile | null,
    private readonly opts: { fingerprint: string; ttlMs: number; now?: number },
  ) {
    const samePolicy = !!prev && prev.version === SCAN_CACHE_VERSION
      && prev.fingerprint === opts.fingerprint;
    if (prev && !samePolicy) this.stats.invalidated = true;
    if (samePolicy && prev) {
      for (const [rel, e] of Object.entries(prev.entries ?? {})) {
        if (isCacheEntryValid(e)) this.entries[rel] = { ...e };
      }
    }
  }

  private now(): number {
    return Number.isFinite(this.opts.now) ? Number(this.opts.now) : Date.now();
  }

  /** 命中返回可直接复用的 hash；未命中返回 null。 */
  lookup(rel: string, stat: ScanStat): string | null {
    const prev = this.entries[rel];
    const now = this.now();
    const samePolicy = true; // 构造时已处理整表失效
    if (shouldReuse(prev, stat, { now, ttlMs: this.opts.ttlMs, samePolicy })) {
      this.stats.hits++;
      return (prev as ScanCacheEntry).hash;
    }
    this.stats.misses++;
    if (prev) {
      if (prev.mtimeMs !== stat.mtimeMs || prev.ctimeMs !== stat.ctimeMs || prev.size !== stat.size) {
        this.stats.changed++;
      } else if (now - prev.at >= Math.max(1, this.opts.ttlMs)) {
        this.stats.expired++;
      }
    }
    return null;
  }

  record(rel: string, stat: ScanStat, hash: string): void {
    if (!validHash(hash)) return;
    this.entries[rel] = {
      mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, size: stat.size,
      hash, at: this.now(),
    };
  }

  /** 只保留本轮真实见过的 rel，避免删掉的文件永久占着缓存。 */
  prune(seenRels: ReadonlyArray<string>): void {
    const keep = new Set(seenRels);
    for (const rel of Object.keys(this.entries)) {
      if (!keep.has(rel)) delete this.entries[rel];
    }
  }

  snapshot(): ScanCacheFile {
    return {
      version: SCAN_CACHE_VERSION,
      fingerprint: this.opts.fingerprint,
      entries: { ...this.entries },
    };
  }
}

// ---------------------------------------------------------------------------
// fs 边界
// ---------------------------------------------------------------------------

export function scanCachePath(): string {
  return join(dshHome(), 'nas-sync', 'scan-cache.json');
}

export interface ScanCacheLoad {
  data: ScanCacheFile | null;
  missing: boolean;
  corrupted: boolean;
  quarantinedTo?: string;
}

/**
 * 读缓存。坏文件会被 state-file 备份并报告，调用方应把它当**告警**而不是
 * 「正常的新缓存」—— 否则用户永远不知道自己的缓存一直在失效。
 */
export function loadScanCache(path: string = scanCachePath()): ScanCacheLoad {
  const r = readJsonFile<ScanCacheFile>(path);
  if (r.data && typeof r.data === 'object' && Array.isArray(r.data.entries)) {
    // entries 应该是 rel→条目 的字典；数组形态说明是别的版本/坏数据
    return { data: null, missing: false, corrupted: true, quarantinedTo: r.quarantinedTo };
  }
  if (r.data && typeof r.data === 'object' && r.data.entries && typeof r.data.entries === 'object') {
    return { data: r.data, missing: false, corrupted: false };
  }
  return {
    data: null, missing: r.missing,
    corrupted: r.corrupted || (!r.missing && !r.data),
    quarantinedTo: r.quarantinedTo,
  };
}

export function saveScanCache(data: ScanCacheFile, path: string = scanCachePath()): void {
  writeJsonAtomic(path, data);
}
