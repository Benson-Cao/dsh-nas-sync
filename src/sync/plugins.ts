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

/** 设备类别。用于「各自最优」：平台专属插件不该被建议跨平台安装。 */
export type DeviceClass = 'mobile' | 'desktop' | 'cli' | 'unknown';

/**
 * 「插件同步管理」里的一侧 —— 本机（手机）或某个对端（电脑）。
 *
 * 为什么要有它：对账只报差集，用户看到的是一份"缺什么"的清单，却不知道
 * **两端各装了什么**。手机与电脑的插件集本来就不该一样（竖屏适配 vs 桌面布局），
 * 所以面板要能并排看两侧，差集才有参照物。
 *
 * 数据来源按可靠性排序：
 *   · `self`   —— 本机磁盘（profile 声明 + node_modules 里的真实版本），永远最新
 *   · `claim`  —— 对端每次同步结束时写下的插件快照（`dsh/devices/<device>.json`）
 *   · `remote` —— 退路：NAS 上 `/dsh/profiles/<档>/package.json` 的声明，没有版本精度
 */
export interface PluginSide {
  /** 设备标识（`android_localhost` / `win32_Benson`），退路模式下是 profile 名 */
  id: string;
  kind: DeviceClass;
  /** self = 本机；claim = 对端自报；remote = 从远端装配清单推断 */
  source: 'self' | 'claim' | 'remote';
  /** 这一侧涉及的 profile（对端可能同时有 desktop 与 acp 两个档） */
  profiles: string[];
  /** 快照时间；remote 退路模式下为 null */
  updatedAt: number | null;
  /** 声明的第三方插件（不含 @deepseek-ai 内置），按包名排序 */
  plugins: Array<{ name: string; version: string }>;
}

/**
 * 从设备标识猜设备类别。
 *
 * `selfDevice()` 拼的是 `<platform>_<hostname>`（手机 `android_localhost`、
 * 电脑 `win32_Benson`）。声明文件里只有这个字符串，没有别的类别信息，
 * 所以按平台前缀判断 —— 比看 profile 名可靠（对端可能根本没跑 web 档）。
 */
export function deviceKindOf(id: string): DeviceClass {
  const s = String(id || '').toLowerCase();
  if (s.includes('android') || s.includes('phone') || s.includes('mobile') || s.includes('ios')) return 'mobile';
  if (s.includes('win32') || s.includes('win64') || s.includes('darwin') || s.includes('desktop') || s.includes('mac')) return 'desktop';
  if (s.includes('linux') || s.includes('cli') || s.includes('acp') || s.includes('termux')) return 'cli';
  return 'unknown';
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
  /** 能不能在本机装：link/file 指向对端路径，装不了；平台不符也不装 */
  installable: boolean;
  /** 传给 pnpm 的实参，例如 `dsh-context@0.82.0`；不可安装时为 null */
  target: string | null;
  /** 给人看的完整命令，复制即可用 */
  command: string;
  /** 插件自报的平台归属（从包名读，离线可得）；看不出来是 null */
  platform?: DeviceClass | null;
  /** 非空表示「这是别的平台的专属插件」，值就是那个平台 */
  foreignPlatform?: DeviceClass | null;
  /** 不可安装的原因：platform = 平台专属，source = link/file 指向对端路径 */
  reason?: 'platform' | 'source' | null;
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

/**
 * 从 profile 的 dependencies 里挑出「真正的插件」。
 *
 * 只排除内置（`@deepseek-ai/*`，随宿主发布、不在 profile 里装），其余保留原文顺序
 * 之外不做启发式过滤 —— 叫 `dsh-foo` 还是 `@scope/bar` 都可能是插件，靠名字猜只会误伤。
 */
export function declaredPluginNames(deps: ProfileDeps): string[] {
  return Object.keys(deps || {}).filter((n) => !n.startsWith('@deepseek-ai/'));
}

/** 版本号比较只做「字符串是否相同」的粗判，够用且不会误报重装。 */function sameSpec(local: string, remote: string): boolean {
  const a = String(local || '').trim();
  const b = String(remote || '').trim();
  if (a === b) return true;
  // `^1.2.3` 与 `1.2.3`、`link:` 与已装版本之间不做等价推断：宁可标出来让人看
  return false;
}

/** 只取主版本三元组，预发布后缀（-rc.1）与 build 后缀一律忽略。 */
function parseVer(s: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(s || '').trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function cmpVer(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * 从范围表达式里取出「可接受的最低版本」。
 *
 * 为什么需要：`sameSpec` 是严格字符串比较，`^0.82.1` 和已装的 `0.82.1` 不相等，
 * 于是「已经装得比要求还新」会被误报成 `outdated`，点「全部安装」甚至会按对端的
 * 旧范围把本机**降级**。两端各自最优的前提下，本机装得更新是正确的，不该被拉平。
 *
 * 只认最常见、语义无歧义的写法（裸版本 / `^` / `~` / `>=` / `=`，多段用空格、多选
 * 用 `||`）。认不出的返回 null，调用方回落到严格比较 —— 宁可多报一条，不要悄悄漏。
 */
export function minVersionOf(spec: string): [number, number, number] | null {
  const s = String(spec || '').trim();
  if (!s) return null;
  if (/^(latest|next|beta|alpha|canary|\*|x)$/i.test(s)) return null;
  let best: [number, number, number] | null = null;
  for (const alt of s.split('||')) {
    let low: [number, number, number] | null = null;
    let ok = true;
    for (const part of alt.trim().split(/\s+/)) {
      if (!part) continue;
      let v: [number, number, number] | null = null;
      if (part.startsWith('<')) {
        continue; // 上界约束的是天花板，不影响「最低可接受版本」
      } else if (part.startsWith('>=')) v = parseVer(part.slice(2));
      else if (part.startsWith('>')) v = parseVer(part.slice(1)); // 严格大于近似当下界，只会更宽松
      else if (part.startsWith('=')) v = parseVer(part.slice(1));
      else if (part.startsWith('^') || part.startsWith('~')) v = parseVer(part.slice(1));
      else if (/^\d/.test(part)) v = parseVer(part);
      else {
        ok = false; // hyphen 区间等写法：整段放弃，走严格比较
        break;
      }
      if (!v) {
        ok = false;
        break;
      }
      low = low === null || cmpVer(v, low) > 0 ? v : low; // 多个下界取最大的那个
    }
    if (!ok) continue;
    if (low && (best === null || cmpVer(low, best) < 0)) best = low; // 多个可选段取下界最低的
  }
  return best;
}

/**
 * 本机已装版本是否「够用」：优先严格相等，其次比范围下界。
 * 装得比要求更新 → 够用（不降级）；装得比下界还旧 → 不够用。
 */
function versionSatisfies(have: string, spec: string): boolean {
  if (sameSpec(have, spec)) return true;
  const min = minVersionOf(spec);
  const hv = parseVer(have);
  if (!min || !hv) return false;
  return cmpVer(hv, min) >= 0;
}

/**
 * 把 GitHub 仓库地址改写成 **tarball 下载地址**。
 *
 * 为什么需要：pnpm 拿到 `git+https://…` 会去 spawn `git ls-remote`；手机端的运行时
 * 里没有 git（bundle 只带 node/bash），于是安装必然失败，而报错还被翻译成
 * 「Permission denied」。同一个仓库换成 `/archive/<ref>.tar.gz`，pnpm 走的是普通
 * HTTPS 下载 + 解包，全程不碰 git —— 实测在手机上 50 秒装完。
 *
 * 认不出的形式返回 null，调用方保持原 spec 不动（宁可失败，也不要改出一个错的地址）。
 */
export function toTarballSpec(spec: string): string | null {
  const raw = String(spec || '').trim();
  if (!raw) return null;
  // git+https:// / git+ssh:// / git@ / ssh:// 都只是传输方式，仓库路径是一样的
  let s = raw.replace(/^git\+/, '');
  let m = /^(?:https?:\/\/)(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?(?:#(.+))?$/.exec(s);
  if (!m) {
    m = /^(?:ssh:\/\/)?git@github\.com[:/]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?(?:#(.+))?$/.exec(s);
  }
  if (!m) return null;
  const [, owner, repo, ref] = m;
  if (!owner || !repo) return null;
  // HEAD 由 GitHub 解析成默认分支，不用猜 main 还是 master
  const rev = (ref || 'HEAD').trim();
  return `https://github.com/${owner}/${repo}/archive/${rev}.tar.gz`;
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
 * 一个 profile 属于哪类设备。
 *
 * 只看名字，所以必然是启发式：`web` 在本项目里是手机跑的那套（APK + 竖屏），
 * `desktop` 是电脑，`acp` 是命令行。认不出来就返回 unknown —— 此时不做任何
 * 平台过滤，宁可多报一条，也不要因为猜错而漏掉真正该装的插件。
 */
export function deviceClassOfProfile(profile: string): DeviceClass {
  const p = String(profile || '').toLowerCase();
  if (!p) return 'unknown';
  if (p === 'desktop' || p.includes('desktop') || p.includes('win') || p.includes('mac')) return 'desktop';
  if (p === 'web' || p.includes('mobile') || p.includes('phone') || p.includes('tablet') || p.includes('android')) return 'mobile';
  if (p === 'acp' || p === 'cli' || p.includes('termux') || p.includes('tui')) return 'cli';
  return 'unknown';
}

/**
 * 插件自报的平台归属 —— 从包名判断，不需要联网查 registry。
 *
 * `dsh-web-mobile`（竖屏适配）、`dsh-desktop-*`、`dsh-cli-*` 这类命名是社区约定。
 * 看不出来返回 null：绝大多数插件是通用的，返回值 null 就是「不参与平台过滤」。
 */
export function pluginDeviceClass(name: string): DeviceClass | null {
  const n = String(name || '').toLowerCase();
  if (/(^|[-_.])mobile([-_.]|$)/.test(n) || /(^|[-_.])phone([-_.]|$)/.test(n) || /(^|[-_.])touch([-_.]|$)/.test(n)) {
    return 'mobile';
  }
  if (/(^|[-_.])desktop([-_.]|$)/.test(n)) return 'desktop';
  if (/(^|[-_.])cli([-_.]|$)/.test(n) || /(^|[-_.])tui([-_.]|$)/.test(n)) return 'cli';
  return null;
}

export interface DiffOptions {
  /** 对账的目标 profile —— 用它推断「本机是什么设备」，据此过滤平台专属插件 */
  targetProfile?: string;
  /** 显式放行的包名：即使平台不符也照样建议安装（用户自己覆盖） */
  allowPlatform?: string[];
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
 *
 * **「各自最优」**：两端不必装同一套插件。手机需要 `dsh-web-mobile` 这种竖屏适配，
 * 电脑装上只会把布局压成手机版；反之桌面向的插件在手机上也没意义。所以当目标
 * profile 能推断出设备类别、且插件自己标明了另一类平台时，这个差值**不算待装**，
 * 而是标成 `reason: 'platform'` 让界面解释清楚。`opts.allowPlatform` 可以按包名
 * 覆盖这个判断。
 */
export function diffPlugins(
  installed: Record<string, string>,
  remote: RemoteProfile[],
  opts: DiffOptions = {},
): PluginGap[] {
  const targetClass = deviceClassOfProfile(opts.targetProfile ?? '');
  const allow = new Set((opts.allowPlatform ?? []).map((n) => String(n)));
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
      // tag 类 spec（latest/*/next…）没有可比对的版本下限，装了就算满足。
      const specIsTag = /^(latest|next|beta|alpha|canary|\*|x)$/i.test(String(spec).trim());
      if (have !== null && (specIsSource || specIsTag || versionSatisfies(have, spec))) continue;
      let target = installTarget(name, spec);
      // 手机上装 git 依赖必然失败（运行时没有 git）。这里改写成 tarball 地址，
      // 让「全部安装」在手机端真的能跑通；电脑端保留 git 形式（可跟踪分支更新）。
      if (target && kind === 'git' && targetClass === 'mobile') {
        target = toTarballSpec(spec) ?? target;
      }
      // 平台专属判定：本机设备类别未知时（unknown）一律不过滤。
      const platform = pluginDeviceClass(name);
      const foreign = Boolean(
        platform &&
          platform !== 'unknown' &&
          targetClass !== 'unknown' &&
          platform !== targetClass &&
          !allow.has(name),
      );
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
        installable: target !== null && !foreign,
        target: foreign ? null : target,
        command: '',
        platform,
        foreignPlatform: foreign ? platform : null,
        reason: foreign ? 'platform' : target === null ? 'source' : null,
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
