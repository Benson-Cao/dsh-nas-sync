/**
 * dsh-nas-sync · 会话 rel 空间迁移（0.6.0 / 收尾①）
 * ---------------------------------------------------
 * 0.5.9 及以前，会话的远端 rel 是 `sessions/<encodeCwd(cwd)>/<sid>/session.vN.jsonl.zstd`。
 * 目录名编码的是**工作目录绝对路径**：PC 上是 `--C-Users-Administrator-…`，
 * 手机上是 `--data-user-0-…`。同一会话在两端 rel 不同，于是：
 *   · 清单对不上、删除事件对不上（P0/P1 用 sid 归键绕开了）；
 *   · 想按内容地址做去重 / 三路合并 / 多设备对齐，根本没有稳定主键。
 *
 * 目标形态：`sessions/by-id/<sid>/vN/<文件名>`。sid 与设备无关，vN 是内容版本。
 * 但**直接切换会毁掉线上数据**：两端 105+ 条非会话 rel、26/29 条会话、以及
 * `/dsh/` 下所有已经加密的密文对象都还挂在老 rel 上。所以本模块遵循三条：
 *
 *   1. **双读**：legacy 与 canonical 两个空间都能读，按 sid 归并，永远不把
 *      「只在一个空间出现」误判成删除；
 *   2. **单写且默认关**：`sessionRelMode` 默认 `legacy`，`shadow` 才双写，
 *      `canonical` 才切主链。配置不显式改，线上字节一个都不变；
 *   3. **两阶段迁移**：`plan()` 只读、`apply()` 必须带 `confirm` 且先写 marker，
 *      旧对象**只复制不删除**，保留回滚窗口。
 *
 * 这里全部是纯函数：不碰 fs / 网络 / 宿主，可离线单测。IO 编排在 engine 里。
 */

import type { BidMapEntry, ManifestEntry } from '../data/models.js';
import { canonicalSessionRel, sessionIdFromRel } from './events.js';

/** 会话 rel 的三种运行模式。默认 legacy —— 升级不改数据。 */
export type SessionRelMode = 'legacy' | 'shadow' | 'canonical';

export const MIGRATION_MARKER_PATH = '/dsh/migration.json';

export function isLegacySessionRel(rel: string): boolean {
  return /^sessions\/[^/]+\/[^/]+\/[^/]+$/.test(String(rel || ''))
    && !isCanonicalSessionRel(rel);
}

export function isCanonicalSessionRel(rel: string): boolean {
  return /^sessions\/by-id\/[^/]+\/v\d+\/[^/]+$/.test(String(rel || ''));
}

/** 老 rel 里的 cwd 编码目录名（落地到本机时要换成**本机**的编码，不是照抄）。 */
export function legacyCwdSegment(rel: string): string | null {
  if (!isLegacySessionRel(rel)) return null;
  return String(rel).split('/')[1] || null;
}

function fileNameOf(rel: string): string {
  const parts = String(rel || '').split('/');
  return parts[parts.length - 1] || '';
}

/**
 * cwd 编码段清洗：只允许 encodeCwd() 会产生的字符集，并把连续的 `..` 压掉。
 * 这个段会被拼进真实文件系统路径，不能让 `../evil` 之流借它落地越界。
 */
export function safeCwdSegment(raw: string): string {
  return String(raw || '')
    .replace(/[^A-Za-z0-9._~-]/g, '_')
    .replace(/\.\./g, '_')
    .replace(/^\.+/, '_');
}

/** legacy rel → canonical rel。非会话 / 非法输入返回 null。 */
export function legacyRelToCanonical(rel: string, version = 1): string | null {
  const sid = sessionIdFromRel(rel);
  if (!sid || !isLegacySessionRel(rel)) return null;
  const file = fileNameOf(rel);
  if (!file) return null;
  return canonicalSessionRel(sid, version) + '/' + file;
}

/**
 * canonical rel → 本机落地 rel。
 *
 * 宿主 dsh 只认 `sessions/<encodeCwd(cwd)>/<sid>/...`，所以 canonical 只用于
 * **远端命名空间**；拉下来必须折算回本机 cwd 编码。传入的 `cwdSegment` 必须是
 * 本机算出来的（不是远端原文里的），否则手机又会拿到 PC 的路径。
 */
export function canonicalRelToLocal(rel: string, cwdSegment: string): string | null {
  if (!isCanonicalSessionRel(rel)) return null;
  const parts = String(rel).split('/');
  const sid = parts[2];
  const file = parts[4];
  const seg = safeCwdSegment(cwdSegment);
  if (!sid || !file || !seg) return null;
  return 'sessions/' + seg + '/' + sid + '/' + file;
}

// ---------------------------------------------------------------------------
// 迁移计划
// ---------------------------------------------------------------------------

export interface RelMapping {
  sid: string;
  legacyRel: string;
  canonicalRel: string;
  /** legacy rel 里的 cwd 编码段，用于写 bidmap 的 originalCwd 溯源 */
  cwdSegment: string;
  device?: string;
  version: number;
  hash: string;
}

export interface RelMigrationPlan {
  createdAt: number;
  mappings: RelMapping[];
  /** 同一 canonical 目标对应多个不同内容的 legacy 条目：必须人工裁决，禁止自动覆盖 */
  collisions: Array<{ canonicalRel: string; legacyRels: string[]; hashes: string[] }>;
  skipped: Array<{ rel: string; reason: string }>;
  /** 已经是 canonical 的条目数（无需迁移） */
  alreadyCanonical: number;
  /** 非会话条目数（保持原 rel） */
  untouched: number;
}

/**
 * 生成迁移计划。只读、幂等、与输入顺序无关。
 *
 * 冲突判定：同一个 sid 下若有多条 legacy 条目映射到同一 canonical 文件名、
 * 但 hash 不同，就是「同名不同内容」——绝不能静默挑一份，列入 collisions 让
 * apply() 整批拒绝。
 */
export function planRelMigration(
  entries: ReadonlyArray<ManifestEntry>,
  opts: { now?: number; version?: number; bidMap?: ReadonlyArray<BidMapEntry> } = {},
): RelMigrationPlan {
  const now = Number.isFinite(opts.now) ? Number(opts.now as number) : Date.now();
  const version = Math.max(1, Math.floor(opts.version ?? 1));
  const byTarget = new Map<string, RelMapping[]>();
  const skipped: RelMigrationPlan['skipped'] = [];
  let alreadyCanonical = 0;
  let untouched = 0;

  // 已有 bidmap 时沿用其 version（取更大者），避免重复迁移把 v1 倒回 v1
  const bidVersion = new Map<string, number>();
  for (const b of opts.bidMap ?? []) {
    if (b?.sid && Number.isFinite(b.version)) {
      bidVersion.set(b.sid, Math.max(bidVersion.get(b.sid) ?? 0, Math.floor(b.version)));
    }
  }

  for (const e of entries) {
    if (!e || typeof e.rel !== 'string' || !e.rel) continue;
    if (isCanonicalSessionRel(e.rel)) { alreadyCanonical++; continue; }
    if (!isLegacySessionRel(e.rel)) { untouched++; continue; }
    const sid = sessionIdFromRel(e.rel);
    const target = legacyRelToCanonical(e.rel, Math.max(version, bidVersion.get(sid ?? '') ?? 0));
    if (!sid || !target) {
      skipped.push({ rel: e.rel, reason: '无法从 rel 解析出合法 sid' });
      continue;
    }
    const item: RelMapping = {
      sid,
      legacyRel: e.rel,
      canonicalRel: target,
      cwdSegment: legacyCwdSegment(e.rel) ?? '',
      device: e.device,
      version: Math.max(version, bidVersion.get(sid) ?? 0),
      hash: String(e.hash || ''),
    };
    const arr = byTarget.get(target) ?? [];
    arr.push(item);
    byTarget.set(target, arr);
  }

  const mappings: RelMapping[] = [];
  const collisions: RelMigrationPlan['collisions'] = [];
  for (const [canonicalRel, arr] of [...byTarget.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const hashes = [...new Set(arr.map((x) => x.hash))];
    if (hashes.length > 1) {
      collisions.push({
        canonicalRel,
        legacyRels: arr.map((x) => x.legacyRel).sort(),
        hashes: hashes.sort(),
      });
      continue;
    }
    // 同 hash 的多条（同会话被两台设备各列一遍）只留一条，来源设备取字典序最小，保证稳定
    const winner = [...arr].sort((a, b) => (a.device ?? '').localeCompare(b.device ?? ''))[0];
    mappings.push(winner);
  }
  mappings.sort((a, b) => a.canonicalRel.localeCompare(b.canonicalRel));

  return { createdAt: now, mappings, collisions, skipped, alreadyCanonical, untouched };
}

/** 计划是否可执行。任何冲突 / 跳过 / 空计划都要挡住 apply。 */
export function validateRelPlan(plan: RelMigrationPlan): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!plan || !Array.isArray(plan.mappings)) return { ok: false, errors: ['计划格式非法'] };
  if (plan.mappings.length === 0) errors.push('没有需要迁移的会话条目');
  if (plan.collisions.length > 0) {
    errors.push(`有 ${plan.collisions.length} 组同名不同内容的会话，需人工裁决：`
      + plan.collisions.slice(0, 3).map((c) => c.canonicalRel).join('、'));
  }
  if (plan.skipped.length > 0) errors.push(`有 ${plan.skipped.length} 条无法解析 sid 的会话`);
  for (const m of plan.mappings) {
    if (!isCanonicalSessionRel(m.canonicalRel)) errors.push('非法 canonical rel：' + m.canonicalRel);
    if (!isLegacySessionRel(m.legacyRel)) errors.push('非法 legacy rel：' + m.legacyRel);
    if (m.canonicalRel.includes('..') || m.legacyRel.includes('..')) {
      errors.push('rel 含路径穿越：' + m.legacyRel);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** 迁移标记：写入后才允许把配置切到 canonical；同时是重复执行的挡板。 */
export interface MigrationMarker {
  version: 1;
  completedAt: number;
  device: string;
  migrated: number;
  fromMode: SessionRelMode;
  /** 旧对象保留到这个时间点才允许 GC（默认 30 天） */
  keepLegacyUntil: number;
}

export function buildMigrationMarker(
  plan: RelMigrationPlan,
  device: string,
  now: number = Date.now(),
  retentionDays = 30,
): MigrationMarker {
  return {
    version: 1,
    completedAt: now,
    device: String(device || 'unknown'),
    migrated: plan.mappings.length,
    fromMode: 'legacy',
    keepLegacyUntil: now + Math.max(0, retentionDays) * 86_400_000,
  };
}

/** 旧对象是否还在保留窗口内（窗口内 deleteTree 必须拒绝）。 */
export function legacyProtected(marker: MigrationMarker | null, now: number = Date.now()): boolean {
  if (!marker || !Number.isFinite(marker.keepLegacyUntil)) return false;
  return now < marker.keepLegacyUntil;
}

// ---------------------------------------------------------------------------
// 双读 / 单写
// ---------------------------------------------------------------------------

/**
 * 写侧：按模式重写本机清单。
 *   legacy    原样（默认）
 *   shadow    原条目 + canonical 副本（双写，供对端提前热身）
 *   canonical 只写 canonical 条目（会话部分），非会话原样
 *
 * canonical 条目的 hash/mtime/size 与源相同 —— 它们是**同一份内容**的两个名字，
 * 不是新文件；device 保持来源设备，方便清单合并时追溯。
 */
export function rewriteManifestForMode(
  entries: ReadonlyArray<ManifestEntry>,
  mode: SessionRelMode,
  plan: RelMigrationPlan,
): ManifestEntry[] {
  if (mode === 'legacy') return [...entries];
  const lookup = new Map(plan.mappings.map((m) => [m.legacyRel, m.canonicalRel]));
  const out: ManifestEntry[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (!e || typeof e.rel !== 'string') continue;
    const target = lookup.get(e.rel);
    if (!target) {
      if (!seen.has(e.rel)) { out.push({ ...e }); seen.add(e.rel); }
      continue;
    }
    if (mode === 'shadow' && !seen.has(e.rel)) { out.push({ ...e }); seen.add(e.rel); }
    if (!seen.has(target)) {
      out.push({ ...e, rel: target });
      seen.add(target);
    }
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/**
 * 读侧：把两个空间按 sid 归并成**一份**视图。
 *
 * 为什么必须归并而不是简单拼接：删除传播的六道闸按 rel 比对，同一会话在两个
 * 空间各出现一次会让「本机条目数」翻倍；更糟的是只删掉其中一个空间时，另一个
 * 还在，删除永远判不出来。canonical 优先，legacy 作为别名补进来。
 */
export function mergeDualRead(entries: ReadonlyArray<ManifestEntry>): ManifestEntry[] {
  const canonical = new Map<string, ManifestEntry>();
  for (const e of entries) {
    if (e && isCanonicalSessionRel(e.rel)) {
      const cur = canonical.get(e.rel);
      if (!cur || (e.mtime ?? 0) > (cur.mtime ?? 0)) canonical.set(e.rel, { ...e });
    }
  }
  const canonicalBySid = new Map<string, string>();
  for (const rel of canonical.keys()) {
    const sid = sessionIdFromRel(rel);
    if (sid && !canonicalBySid.has(sid)) canonicalBySid.set(sid, rel);
  }
  const out: ManifestEntry[] = [...canonical.values()];
  for (const e of entries) {
    if (!e || typeof e.rel !== 'string') continue;
    if (isCanonicalSessionRel(e.rel)) continue;
    // 已有 canonical 版本的 legacy 别名不再单独计入（否则重复计数）
    if (isLegacySessionRel(e.rel)) {
      const sid = sessionIdFromRel(e.rel);
      if (sid && canonicalBySid.has(sid)) continue;
    }
    out.push({ ...e });
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** 从计划生成 bidmap 条目（供 /dsh/bidmap.json 持久化）。 */
export function bidMapFromPlan(
  plan: RelMigrationPlan,
  cwdSegmentForLocal: (m: RelMapping) => string,
): BidMapEntry[] {
  return plan.mappings.map((m) => {
    const file = fileNameOf(m.canonicalRel);
    const seg = safeCwdSegment(cwdSegmentForLocal(m));
    return {
      sid: m.sid,
      canonicalRel: m.canonicalRel,
      localRel: 'sessions/' + seg + '/' + m.sid + '/' + file,
      originalCwd: m.cwdSegment,
      version: m.version,
      hash: m.hash,
    };
  }).sort((a, b) => a.sid.localeCompare(b.sid));
}
