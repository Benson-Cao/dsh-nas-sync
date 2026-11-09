/**
 * dsh-nas-sync · 插件包体 CAS 装配清单（0.6.0 / P4 · 纯函数层）
 * -------------------------------------------------------------
 * 0.5.9 的插件同步只做**装配清单对账**：比远端 package.json 的 dependencies 与本机
 * 实际安装，缺的插件给一条 pnpm 命令让用户自己去装。手机端没有 CLI，这条命令等于
 * 没有；而且 PC 的 win32/x64 包体本来就不能直接搬到 android/arm64 上。
 *
 * 目标形态（本模块提供可测的账本语义，主安装链路的切换见交付说明）：
 *   - 包体按内容地址放 `/dsh/objects/<前2位>/<sha256>`，同一份只存一次；
 *   - 装配清单按 `包名@版本` 记录**每个平台**各自的对象指纹与大小；
 *   - 缺插件时按当前设备的 target 找对应对象，从 CAS 直接解包写 node_modules，
 *     不再依赖宿主 CLI；卸载写 delete 事件（P1 已具备）。
 *
 * 这里全部是纯函数：不碰 fs / 网络 / 宿主包，因此可以离线单测。
 */

import type { PluginObjectRecord } from '../data/models.js';
import { objectPathOf, pluginTarget } from './events.js';

/** 装配清单：一个包版本的全部平台对象。 */
export interface PluginAssembly {
  name: string;
  version: string;
  /** `${platform}/${arch}/node-${abi}` → 对象记录 */
  targets: Record<string, { objectHash: string; size: number; device: string }>;
}

export function assemblyKey(name: string, version: string): string {
  return String(name || '') + '@' + String(version || '');
}

/** 当前设备的目标串。abi 取 `process.versions.modules`（宿主 Node ABI）。 */
export function currentTarget(
  platform: string = process.platform,
  arch: string = process.arch,
  abi: string | number = (process.versions as any)?.modules ?? 'unknown',
): string {
  return pluginTarget(platform, arch, abi);
}

export function isValidObjectHash(hash: unknown): hash is string {
  return typeof hash === 'string' && /^[0-9a-f]{64}$/i.test(hash);
}

/** 把扁平的对象记录按 `包名@版本` 聚合成装配清单。非法指纹一律丢弃。 */
export function buildAssemblies(records: ReadonlyArray<PluginObjectRecord>): PluginAssembly[] {
  const by = new Map<string, PluginAssembly>();
  for (const r of records) {
    if (!r || !r.name || !r.target || !isValidObjectHash(r.objectHash)) continue;
    const key = assemblyKey(r.name, r.version);
    const a = by.get(key) ?? { name: r.name, version: r.version, targets: {} };
    // 同一 target 多条时取 size 更大的（更完整的包体），保证结果稳定
    const cur = a.targets[r.target];
    if (!cur || r.size > cur.size) {
      a.targets[r.target] = {
        objectHash: r.objectHash.toLowerCase(), size: r.size, device: r.device,
      };
    }
    by.set(key, a);
  }
  return [...by.values()].sort((a, b) => assemblyKey(a.name, a.version).localeCompare(assemblyKey(b.name, b.version)));
}

/** 合并多端装配清单：同 target 取 size 更大的，与读入顺序无关。 */
export function mergeAssemblies(parts: ReadonlyArray<ReadonlyArray<PluginAssembly>>): PluginAssembly[] {
  const flat: PluginObjectRecord[] = [];
  for (const list of parts) {
    for (const a of list) {
      if (!a || !a.name) continue;
      for (const [target, o] of Object.entries(a.targets ?? {})) {
        flat.push({
          name: a.name, version: a.version, target,
          objectHash: o.objectHash, size: o.size, device: o.device,
        });
      }
    }
  }
  return buildAssemblies(flat);
}

/** 某个平台下所有可用的对象记录（供本机安装）。 */
export function recordsForTarget(
  assemblies: ReadonlyArray<PluginAssembly>,
  target: string,
): PluginObjectRecord[] {
  const out: PluginObjectRecord[] = [];
  for (const a of assemblies) {
    const o = a.targets?.[target];
    if (!o || !isValidObjectHash(o.objectHash)) continue;
    out.push({
      name: a.name, version: a.version, target,
      objectHash: o.objectHash, size: o.size, device: o.device,
    });
  }
  return out.sort((x, y) => assemblyKey(x.name, x.version).localeCompare(assemblyKey(y.name, y.version)));
}

/** 本机 target 下**没有**对应包体的包（需要别的设备上传，或明确标注不支持）。 */
export function missingTargets(
  assemblies: ReadonlyArray<PluginAssembly>,
  target: string,
): Array<{ name: string; version: string; availableOn: string[] }> {
  return assemblies
    .filter((a) => !a.targets?.[target])
    .map((a) => ({ name: a.name, version: a.version, availableOn: Object.keys(a.targets ?? {}).sort() }))
    .sort((x, y) => assemblyKey(x.name, x.version).localeCompare(assemblyKey(y.name, y.version)));
}

/** 对象在 CAS 池里的远端路径（包一层，顺手校验指纹）。 */
export function pluginObjectPath(hash: string): string {
  return objectPathOf(hash);
}

/**
 * 对象 GC：返回**不再被任何装配清单引用**的对象路径，可安全删除。
 * 保留期与删除事件由 P1 的墓碑机制负责，这里只算引用关系。
 */
export function unreferencedObjectPaths(
  assemblies: ReadonlyArray<PluginAssembly>,
  existingHashes: ReadonlyArray<string>,
): string[] {
  const referenced = new Set<string>();
  for (const a of assemblies) {
    for (const o of Object.values(a.targets ?? {})) {
      if (isValidObjectHash(o.objectHash)) referenced.add(o.objectHash.toLowerCase());
    }
  }
  return existingHashes
    .filter((h) => isValidObjectHash(h) && !referenced.has(h.toLowerCase()))
    .map((h) => objectPathOf(h));
}
