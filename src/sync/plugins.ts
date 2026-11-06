/**
 * 插件对账：算出「别的设备装了、这台机器还没装」的插件。
 *
 * 为什么需要它：插件的**包体永远不走同步** —— `scanner.ts` 的 `walkFiles()`
 * 遇到 `node_modules` 直接 `continue`，所以能跨设备过去的只有
 * `profiles/<profile>/package.json` 这类装配清单。清单到了、包没到，
 * 界面看起来就是「插件消失」。补齐只能在对端重新安装（按本机平台解依赖），
 * 本模块只负责「算出该装什么」，不搬包体。
 */

/** 依赖的形态。决定它能不能在本机直接安装。 */
export type DepKind = 'registry' | 'git' | 'link' | 'file' | 'workspace' | 'tarball' | 'other';

export interface ProfileDeps {
  /** 包名 → spec（package.json 里写的原样字符串） */
  [name: string]: string;
}

export interface RemoteProfile {
  profile: string;
  deps: ProfileDeps;
  bundles: string[];
}

export interface LocalProfile {
  profile: string;
  /** 本机已安装的包名 → 版本；link 依赖记为 'link'。没装的包不会出现在这里。 */
  installed: Record<string, string>;
}

export interface PluginGap {
  profile: string;
  name: string;
  /** 清单里的原始 spec，用于展示与核对 */
  spec: string;
  kind: DepKind;
  /** missing = 本机压根没装；outdated = 装了但版本与清单不符 */
  status: 'missing' | 'outdated';
  /** 本机已装版本（missing 时为 null） */
  localVersion: string | null;
  /** 能不能在本机装：link/file 指向对端路径，装不了 */
  installable: boolean;
  /** 传给 pnpm 的实参，例如 `dsh-context@0.82.0`；不可安装时为 null */
  target: string | null;
  /** 给人看的完整命令，复制即可用 */
  command: string;
}

/** 判定 spec 的形态。 */
export function depKind(spec: string): DepKind {
  const s = String(spec || '').trim();
  if (!s) return 'other';
  if (s.startsWith('link:')) return 'link';
  if (s.startsWith('file:')) return 'file';
  if (s.startsWith('workspace:')) return 'workspace';
  if (/^(git\+|git:|github:|gitlab:|bitbucket:)/i.test(s)) return 'git';
  if (/\.(tgz|tar\.gz|tar)$/i.test(s)) return 'tarball';
  // registry：版本号 / tag / range / npm: 别名
  if (/^(npm:)?[\^*~><=\s]*v?\d/.test(s) || /^(latest|next|beta|alpha|canary|\*)$/.test(s)) return 'registry';
  if (/^[a-z0-9][a-z0-9._-]*$/i.test(s)) return 'registry'; // 裸 tag 名，如 `latest`
  return 'other';
}

/**
 * 从 package.json 文本解析出「依赖 + bundle 列表」。
 * 解析失败返回 null —— 远端文件可能是半截写入或不是 JSON，不该让整次对账失败。
 */
export function parseProfilePackage(raw: string): { deps: ProfileDeps; bundles: string[] } | null {
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const deps: ProfileDeps = {};
  for (const [k, v] of Object.entries(obj.dependencies ?? {})) {
    if (typeof v === 'string') deps[k] = v;
  }
  const bundles = Array.isArray(obj?.dsh?.profile?.bundles)
    ? obj.dsh.profile.bundles.filter((x: unknown) => typeof x === 'string')
    : [];
  return { deps, bundles };
}

/** 版本号比较只做「字符串是否相同」的粗判，够用且不会误报重装。 */
function sameSpec(local: string, remote: string): boolean {
  const a = String(local || '').trim();
  const b = String(remote || '').trim();
  if (a === b) return true;
  // `^1.2.3` 与 `1.2.3`、`link:` 与已装版本之间不做等价推断：宁可标出来让人看
  return false;
}

/** 生成 pnpm 实参；不可安装的返回 null。 */
export function installTarget(name: string, spec: string): string | null {
  const kind = depKind(spec);
  if (kind === 'registry') return `${name}@${spec}`;
  if (kind === 'git') return spec; // pnpm 支持直接吃 git URL
  return null;
}

export function installCommand(profile: string, target: string): string {
  return `dsh plugin --profile ${profile} add ${target}`;
}

/**
 * 对账。
 *
 * - `installed`：**本机选定 profile 的实际安装状态**（包名 → 版本），
 *   不是本机清单 —— 本机清单也会被同步过来，比清单永远相等，看不出「清单到了包没装」。
 * - `remote`：别的设备各 profile 的依赖清单。
 *
 * 不按 profile 同名对比：手机跑 `web`、电脑跑 `desktop`，同名比会得出「电脑 web
 * 装了、desktop 没装」的无用结论。这里一律拿「远端所有 profile 的依赖」去和
 * 「本机这一个 profile 装了什么」求差集，缺什么就装什么。
 *
 * 内置 bundle（`@deepseek-ai/dsh-*`）不参与对账：它们随宿主发布，不在 profile 里装。
 */
export function diffPlugins(installed: Record<string, string>, remote: RemoteProfile[]): PluginGap[] {
  const out: PluginGap[] = [];
  const seen = new Set<string>();
  for (const r of remote) {
    for (const [name, spec] of Object.entries(r.deps)) {
      if (name.startsWith('@deepseek-ai/')) continue;
      const kind = depKind(spec);
      const have = Object.prototype.hasOwnProperty.call(installed, name) ? installed[name] : null;
      // link/file/workspace 依赖指向「对端本机路径」，git 依赖写的是来源而不是版本：
      // 这三种只要这台机器也装了同名包就算满足，拿 spec 和已装版本比会永远不相等。
      const specIsSource = kind === 'link' || kind === 'file' || kind === 'workspace' || kind === 'git' || kind === 'tarball';
      if (have !== null && (specIsSource || sameSpec(have, spec))) continue;
      const target = installTarget(name, spec);
      const key = name + '\u0000' + spec;
      if (seen.has(key)) continue; // 多个 profile 列了同一个依赖，只报一次
      seen.add(key);
      out.push({
        profile: r.profile,
        name,
        spec,
        kind,
        status: have === null ? 'missing' : 'outdated',
        localVersion: have,
        installable: target !== null,
        target,
        command: target ? installCommand(r.profile, target) : '',
      });
    }
  }
  // 缺的排前面，再按 profile / 包名稳定排序，避免每次刷新顺序乱跳
  out.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'missing' ? -1 : 1;
    if (a.profile !== b.profile) return a.profile < b.profile ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return out;
}
