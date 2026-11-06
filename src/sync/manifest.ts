/**
 * dsh-nas-sync · 远端清单合并（纯函数，无宿主依赖）
 * ----------------------------------------------------
 * 从 engine.ts 拆出来是为了**可单测**：engine.ts 的依赖链会带进
 * `@deepseek-ai/schemastery`（config → schema），离线测试环境里没有宿主包，
 * 一 import 就 ERR_MODULE_NOT_FOUND。这两个函数只吃 ManifestEntry 数组，
 * 拆开后测试能直接覆盖「补回 / 不复活」这类语义。
 */

import type { ManifestEntry } from '../data/models.js';

/**
 * 合并清单的来源设备：`fresh` 里的条目都被 scanner 标成了本机，但只有**内容真的
 * 变过**（哈希不同）的文件才算本机上传；其余保留 `prev` 里的原来源。
 *
 * 抽成纯函数是为了能直接测 —— 这个规则写反了，来源标记就会每次同步被刷成本机，
 * 功能等于失效，而且从 UI 上很难察觉。
 */
export function mergeManifestDevices(fresh: ManifestEntry[], prev: ManifestEntry[]): ManifestEntry[] {
  const old = new Map(prev.map((e) => [e.rel, e] as const));
  return fresh.map((e) => {
    const before = old.get(e.rel);
    return before && before.device && before.hash === e.hash
      ? { ...e, device: before.device }
      : e;
  });
}

/**
 * 0.3.5：带基线的远端清单合并。
 *
 * `mergeManifestDevices()` 以本地 `fresh` 为准，会丢掉「远端有、本轮没下载」的条目；
 * 但 0.3.4 那种无脑补回又会把**本机已删除**的文件复活（下一轮重新判成 download）。
 * 所以补回按基线判定：
 *   - 基线里也没有 → 是本机从没见过的条目（对端新增），补回
 *   - 基线里有、现在没有 → 本机删的，不补回
 *
 * @param fresh      本轮本地扫描结果
 * @param prevRemote 本轮读到的远端清单
 * @param baseline   上一轮本地清单（`store.localManifest`）
 */
export function mergeManifestPreserving(
  fresh: ManifestEntry[],
  prevRemote: ManifestEntry[],
  baseline: ManifestEntry[],
): ManifestEntry[] {
  const merged = mergeManifestDevices(fresh, prevRemote);
  const seen = new Set(merged.map((e) => e.rel));
  const had = new Set(baseline.map((e) => e.rel));
  for (const e of prevRemote) {
    if (seen.has(e.rel) || had.has(e.rel)) continue;
    merged.push(e);
  }
  return merged;
}

/** 分设备清单目录（0.3.6）。每台设备只写自己那份，读时合并。 */
export const MANIFESTS_DIR = '/dsh/manifests';

/** 旧版单份清单：只读一次用于迁移，之后不再写。 */
export const LEGACY_MANIFEST = '/dsh/manifest.json';

/** 设备名 → 清单远端路径（只保留安全字符，避免路径注入）。 */
export function manifestFileOf(device: string): string {
  const safe =
    String(device || '')
      .replace(/[^A-Za-z0-9._-]/g, '_')
      // `..` 里的点属于允许字符，不清掉会留下路径穿越片段（../../etc/passwd）
      .replace(/\.{2,}/g, '_')
      .slice(0, 64) || '_unknown';
  return MANIFESTS_DIR + '/' + safe + '.json';
}

/**
 * 合并多份设备清单（0.3.6）。
 *
 * 同一个 rel 可能出现在多份里（两端都同步过同一文件）。冲突时：
 *   - hash 相同 → 保留 device 字典序更小的那条，保证结果**稳定可复现**
 *     （否则两端各自写、读的顺序不同，面板上的来源 emoji 会来回跳）
 *   - hash 不同 → 保留 mtime 更新的那条（远端最新版本）
 */
export function mergeDeviceManifests(parts: ManifestEntry[][]): ManifestEntry[] {
  const byRel = new Map<string, ManifestEntry>();
  for (const list of parts) {
    if (!Array.isArray(list)) continue;
    for (const e of list) {
      if (!e || typeof e.rel !== 'string') continue;
      const cur = byRel.get(e.rel);
      if (!cur) {
        byRel.set(e.rel, e);
        continue;
      }
      if (cur.hash === e.hash) {
        if (String(e.device ?? '') < String(cur.device ?? '')) byRel.set(e.rel, e);
        continue;
      }
      if ((e.mtime ?? 0) > (cur.mtime ?? 0)) byRel.set(e.rel, e);
    }
  }
  return [...byRel.values()];
}

/**
 * 本设备该写进自己那份清单的条目（0.3.6）。
 *
 * 只写「**确认在远端存在**」的：
 *   - 本轮 push 成功的（`pushedOk`）
 *   - 之前本设备写过、且内容哈希没变的
 *
 * 本地有、但本轮没传成功的一律不写 —— 否则对端按清单去下载一个不存在的文件，
 * 就是 `workspaces/` 那种「远端 404、errors 永不归零」的幽灵条目。
 */
export function ownManifestEntries(
  fresh: ManifestEntry[],
  prevOwn: ManifestEntry[],
  pushedOk: Set<string>,
): ManifestEntry[] {
  const prev = new Map(prevOwn.map((e) => [e.rel, e] as const));
  return fresh.filter((e) => {
    if (pushedOk.has(e.rel)) return true;
    const o = prev.get(e.rel);
    return o !== undefined && o.hash === e.hash;
  });
}
