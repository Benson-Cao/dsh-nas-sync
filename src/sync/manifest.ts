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
