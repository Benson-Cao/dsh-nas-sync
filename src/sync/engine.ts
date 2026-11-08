/**
 * dsh-nas-sync · 同步引擎（r2 重写）
 * ------------------------------------
 * r1 的致命问题已修：
 *   1. 本地路径用 process.env.HOME 猜 → 统一走 localOf(rel)（宿主解析）；
 *   2. 可合并文本文件 push 时从未保存 .base → 三路合并永远拿不到公共祖先；
 *   3. 分块上传传的是明文、completeHash 用明文 hash 对比密文 → 全链路改为密文，
 *      plainHash 记录在 chunk-manifest，下载后对明文校验；
 *   4. resolve('local') 后远端 manifest 未更新 → 下次扫描同一文件再次冲突
 *      （死循环）。现在 resolve 后立即回写远端 manifest；
 *   5. sync 结束写回的 manifest 是扫描时的旧快照 → 结束后重建最新清单再写。
 *
 * rel 约定（与 scanner/paths 一致）：一律相对 $DSH_HOME（即 ~/.dsh），
 * 远端路径 = '/dsh/' + rel，本地路径 = localOf(rel)。
 */

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { ConflictItem, ManifestEntry, PendingFile, SyncPhase } from '../data/models.js';
import { isIgnoredRel, Scanner } from './scanner.js';
import { Crypto } from './crypto.js';
import { Chunker } from './chunker.js';
import type { NasEntry, NasTransport } from '../nas/transport.js';
import type { NasSyncConfig, Store } from '../config.js';
import { isMergeable } from './merger.js';
import { localOf, dshHome } from '../paths.js';
import {
  declaredPluginNames,
  deviceClassOfProfile,
  deviceKindOf,
  diffPlugins,
  installCommand,
  parseProfilePackage,
  type PluginGap,
  type PluginSide,
  type RemoteProfile,
} from './plugins.js';
import {
  MANIFESTS_DIR,
  LEGACY_MANIFEST,
  manifestFileOf,
  mergeDeviceManifests,
  mergeManifestDevices,
  mergeManifestPreserving,
  ownManifestEntries,
} from './manifest.js';
import { join } from 'node:path';
import {
  customFolderLocalOf,
  encodeCwd,
  selfDevice,
  isSessionRel,
  isWorkspaceRegistryRel,
  mapRemotePath,
  mergeWorkspaceRegistry,
  platformMismatch,
  sessionCwdOf,
  dedupeSessionDirs,
  repairSessionCwd,
  repairWorkspaceRegistry,
  registryCovers,
  rewriteSessionCwd,
  safeName,
  WORKSPACE_REGISTRY_REL,
} from './portable.js';

export type SyncMode = 'push' | 'pull' | 'mirror';

/**
 * 下载落地的三种结果。0.3.5 起 downloadEntry 返回它，外层按枚举计数 ——
 * 原来「按策略跳过」也会 pulled++，同步结果会虚报。
 */
export type DownloadOutcome = 'written' | 'merged' | 'skipped';

// 旧的单份清单路径已迁到 manifest.ts 的 LEGACY_MANIFEST，这里不再直连。

/**
 * 每台设备各自写一份「我贡献了哪些目录」的声明，互不覆盖。
 *
 * 为什么不能只用 manifest 里的 device：manifest 是**单份共享文件**，两端交替
 * 覆盖。内容相同的文件（同步后必然相同）会一直保留第一次写入的来源，于是
 * 清单很容易变成清一色同一台设备 —— 本机过滤后就一个 emoji 都看不到。
 * 设备声明按设备名分文件，天然不会互相覆盖，这才稳定回答「这份数据谁在用」。
 */
const DEVICES_REMOTE = '/dsh/devices';
const deviceClaimFile = (device: string) =>
  DEVICES_REMOTE + '/' + device.replace(/[^A-Za-z0-9._-]/g, '_') + '.json';

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * 把一个 rel 归到「文件夹前缀」，用于按目录统计来源设备。
 *
 * `custom-folders/<name>` 要保留两级（否则所有自定义文件夹会合并成一条统计）；
 * 其余分类只取第一级（`sessions`、`attachments`、`skills`…）。
 */
function prefixOf(rel: string): string {
  const parts = rel.split('/');
  if (parts.length === 0 || !parts[0]) return '';
  if (parts[0] === 'custom-folders' && parts[1]) return 'custom-folders/' + parts[1];
  return parts[0];
}

/**
 * 读一个 profile 的 `node_modules`，得到「已安装的包名 → 版本」。
 *
 * 注意这里读的是**实际安装状态**，不是 profile 的 package.json。因为 package.json
 * 本身会被同步过来（清单到了、包没到），拿清单比清单永远相等，看不出缺插件。
 * link/软链依赖读不到 version 时记空串 —— 只要能列出来就说明装上了。
 */
function readInstalled(nodeModulesDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const versionOf = (p: string): string => {
    try {
      return String(JSON.parse(readFileSync(join(p, 'package.json'), 'utf8')).version ?? '');
    } catch {
      return '';
    }
  };
  let entries: any[] = [];
  try {
    entries = readdirSync(nodeModulesDir, { withFileTypes: true });
  } catch {
    return out; // 没有 node_modules：一个都没装
  }
  for (const e of entries) {
    const name = String(e.name);
    if (name.startsWith('.')) continue;
    if (name.startsWith('@')) {
      try {
        for (const s of readdirSync(join(nodeModulesDir, name), { withFileTypes: true })) {
          out[name + '/' + s.name] = versionOf(join(nodeModulesDir, name, s.name));
        }
      } catch {
        /* 空的 scope 目录 */
      }
      continue;
    }
    out[name] = versionOf(join(nodeModulesDir, name));
  }
  return out;
}

/**
 * 读一个 profile **声明**的插件名（package.json 的 dependencies，去掉内置）。
 *
 * 不能用 node_modules 目录当「已装插件」清单：pnpm 在 phone/桌面档里是 hoisted
 * 布局，node_modules 下同时躺着几百个传递依赖（`ansi-styles`、`buffer-crc32`、
 * `@types/node` …），照目录列出来会把 5 个插件淹没成 134 行包名。
 * 声明清单才是「这个档装了哪些插件」的准确口径。
 */
function declaredPlugins(profileDir: string): string[] {
  try {
    const parsed = parseProfilePackage(readFileSync(join(profileDir, 'package.json'), 'utf8'));
    if (!parsed) return [];
    return declaredPluginNames(parsed.deps);
  } catch {
    return [];
  }
}

/**
 * 猜「当前 dsh 跑的是哪个档」。
 *
 * dsh 的启动命令是 `node …/@deepseek-ai/dsh/lib/bin.js <profile> --port …`，
 * 档名就是 bin.js 后面的第一个位置参数（手机上是 web、电脑上是 desktop）。
 * 这个插件本身跑在这个进程里，`process.argv` 直接可读，不用去看进程表。
 * 匹配不上（例如宿主以后改了启动方式）就返回空串，交给调用方兜底。
 */
function runningProfile(candidates: string[]): string {
  const args = process.argv.slice(1);
  for (const a of args) {
    const s = String(a || '');
    if (s && candidates.includes(s)) return s;
  }
  return '';
}

/**
 * 工作区名归一化，用于把「侧栏显示的名字」和「设备声明里的目录名」对上。
 *
 * 两端 title 可能不同（电脑 `wstest（同步）` / 手机 `wstest`），目录名也可能
 * 带下划线（`default_workspace`）。所以去掉括号后缀、连字符/下划线/空格后转小写。
 * `default-workspace` 在侧栏会被 dsh 本地化成「默认工作区」，单独做别名。
 */
export function normalizeWorkspaceName(raw: string): string {
  const s = String(raw || '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[_\s-]+/g, '')
    .toLowerCase();
  if (s === '默认工作区' || s === 'defaultworkspace' || s === 'default') return 'defaultworkspace';
  return s;
}

export { mergeManifestDevices, mergeManifestPreserving };

export interface EngineDeps {
  transport: NasTransport;
  store: Store;
  config: NasSyncConfig;
}

export class Engine {
  private deps: EngineDeps;
  private scanner: Scanner;
  private chunker: Chunker;
  private running = false;
  private abort: AbortController | null = null;
  /**
   * 本轮是否被「无进展看门狗」掐断的（0.5.2）。
   * 不能只靠 `abort.signal.reason`：用户点「停止」也是 abort，两者必须分开报，
   * 否则停一次就提示「同步超时」。
   */
  private stallAbort = false;
  /** scan() 缓存的远端清单（合并视图） */
  private remoteManifest: ManifestEntry[] = [];

  /** 本轮 push 成功的 rel —— 只有它们才有资格写进「本设备清单」（0.3.6） */
  private pushedOk = new Set<string>();

  /**
   * 本机的工作区注册表本轮是否需要发布到 NAS（0.5.5）。
   *
   * 由 `pullWorkspaceRegistry()` 在合并后判定：只有「本机有、远端缺」的标题或
   * 会话归属才需要发布。注册表是单文件、两端 id 又必然不同，若按哈希差异发布，
   * 两台机器会每轮互相盖回去，变成 5 分钟一次的无用上传。
   */
  private registryNeedsPush = false;

  /**
   * 工作区目录名 → 真实路径（0.3.7）。
   * `workspaces/<名字>/…` 的落点**不在 $DSH_HOME 下**，必须查注册表；
   * 之前直接 localOf() 算成 $DSH_HOME/workspaces/…，读不到文件导致 upload 全失败。
   */
  private workspaceDirs = new Map<string, string>();

  /**
   * rel → 本机绝对路径。
   *
   * 绝大多数分类就是 `localOf(rel)`（落在 $DSH_HOME 下）。**唯一例外是自定义文件夹**：
   * 它们的落点由本机配置的映射表决定（电脑上是 `D:\Projects\foo`、手机上可能是别的），
   * 所以必须先按 rel 里的 `<name>` 查表，查不到才回落到 $DSH_HOME。
   *
   * 所有读写路径一律过这里 —— 漏一处就会出现「上传扫的是配置目录、下载却写进 .dsh」
   * 这种一半对一半错的状态。
   */
  private resolveLocal(rel: string): string {
    const hit = customFolderLocalOf(rel, this.deps.config.customFolders ?? []);
    if (hit) return hit.local;

    // 0.3.7：`workspaces/<名字>/<相对路径>` 的真实落点是注册表里该工作区的 path。
    // 手机上的工作区在 $DSH_HOME 之外（files/home/wstest），直接 localOf() 会算成
    // $DSH_HOME/workspaces/wstest/…，readFile ENOENT → 工作区文件从来没传成功过。
    const PREFIX = 'workspaces/';
    if (rel.startsWith(PREFIX)) {
      const rest = rel.slice(PREFIX.length);
      const slash = rest.indexOf('/');
      const name = slash < 0 ? rest : rest.slice(0, slash);
      const tail = slash < 0 ? '' : rest.slice(slash + 1);
      const dir = this.workspaceDirs.get(name);
      if (dir) return tail ? join(dir, ...tail.split('/')) : dir;
    }
    return localOf(rel);
  }

  /** 读注册表缓存「工作区目录名 → 真实路径」；同步/扫描前各刷一次。 */
  private loadWorkspaceDirs(): void {
    this.workspaceDirs.clear();
    try {
      const raw = JSON.parse(readFileSync(join(dshHome(), 'storages', 'workspace.json'), 'utf8'));
      for (const w of Object.values<any>(raw?.tables?.workspaces ?? {})) {
        const p = String(w?.path ?? '');
        if (!p) continue;
        const name = safeName(p);
        if (name) this.workspaceDirs.set(name, p);
      }
    } catch {
      /* 注册表读不到就退化成 localOf（和旧行为一致，不会更糟） */
    }
  }

  constructor(deps: EngineDeps) {
    this.deps = deps;
    this.scanner = new Scanner({
      // r3：分类勾选决定同步哪些子树；includeSensitive 只管子树内部的凭据文件
      scope: deps.config.syncScope,
      includeSensitive: deps.config.includeSensitive,
      // 技能白名单（空 = 全部），只影响 skills/ 下的一级目录
      skillFilter: deps.config.skillFilter,
      // 自定义文件夹映射表：rel 里的名字 → 本机路径，全靠它
      customFolders: deps.config.customFolders,
    });
    this.chunker = new Chunker(deps.transport, {
      chunkSize: deps.config.chunkSize,
      concurrency: deps.config.concurrency,
    });
  }

  /**
   * 按「文件夹前缀」统计来源设备，供面板在分类/自定义文件夹旁标 emoji。
   *
   * 前缀口径与面板展示一致：
   *   · 分类级 → 该分类在 rel 空间的根（`sessions`、`attachments`、`custom-folders/<name>`…）
   *   · 自定义文件夹 → `custom-folders/<name>`
   *
   * 主数据是 `/dsh/devices/` 下每台设备各自的声明文件（互不覆盖）；
   * 远端清单里的 device 作为兼容兜底。旧条目没有 device 就忽略，不搅浑统计。
   *
   * @returns `{ self, byPrefix }`，`self` 是本机标识（前端据此隐藏本机 emoji）
   */
  async sourceDevices(): Promise<{ self: string; byPrefix: Record<string, Array<{ device: string; files: number }>>; byWorkspace: Record<string, Array<{ device: string; files: number }>> }> {
    this.checkReady();
    // 清单在 scan() 里缓存；面板可能先于扫描打开，这里按需补一次
    if (this.remoteManifest.length === 0) {
      try {
        this.remoteManifest = await this.readRemoteManifest();
      } catch {
        /* 远端不可达：返回空统计，面板显示"未知"即可，不阻塞 */
      }
    }

    const counters = new Map<string, Map<string, number>>();
    const wsCounters = new Map<string, Map<string, number>>();
    const bump = (prefix: string, device: string, n: number) => {
      let m = counters.get(prefix);
      if (!m) {
        m = new Map();
        counters.set(prefix, m);
      }
      m.set(device, (m.get(device) ?? 0) + n);
    };

    // ① 主来源：每台设备各自的声明文件（互不覆盖，最可靠）
    try {
      const entries = await this.deps.transport.list(DEVICES_REMOTE);
      for (const entry of entries) {
        if (entry.type !== 'file' || !entry.name.endsWith('.json')) continue;
        try {
          const raw = await this.deps.transport.getBuffer(DEVICES_REMOTE + '/' + entry.name);
          const claim = JSON.parse(new TextDecoder().decode(raw));
          if (!claim || typeof claim.device !== 'string') continue;
          for (const [prefix, n] of Object.entries(claim.prefixes ?? {})) {
            const count = Number(n) || 0;
            if (count > 0) bump(prefix, claim.device, count);
          }
          // 工作区清单：title 与目录名都注册，前端按归一化名查
          for (const ws of claim.workspaces ?? []) {
            for (const rawName of [ws?.title, ws?.name]) {
              const key = normalizeWorkspaceName(String(rawName ?? ''));
              if (!key) continue;
              let m = wsCounters.get(key);
              if (!m) { m = new Map(); wsCounters.set(key, m); }
              m.set(claim.device, 1);
            }
          }
        } catch {
          /* 单个声明损坏不该影响其它设备 */
        }
      }
    } catch {
      /* 目录还不存在（首次同步前），下面还有 manifest 兜底 */
    }

    // ② 兼容兜底：旧数据 / 声明文件还没生成时，用 manifest 里的 device
    for (const e of this.remoteManifest) {
      if (!e.device) continue;
      const prefix = prefixOf(e.rel);
      if (prefix) bump(prefix, e.device, 1);
    }

    const byPrefix: Record<string, Array<{ device: string; files: number }>> = {};
    for (const [prefix, m] of counters) {
      byPrefix[prefix] = [...m.entries()]
        .map(([device, files]) => ({ device, files }))
        .sort((a, b) => b.files - a.files);
    }
    const byWorkspace: Record<string, Array<{ device: string; files: number }>> = {};
    for (const [key, m] of wsCounters) {
      byWorkspace[key] = [...m.entries()]
        .map(([device, files]) => ({ device, files }))
        .sort((a, b) => b.files - a.files);
    }
    return { self: selfDevice(), byPrefix, byWorkspace };
  }

  isRunning(): boolean {
    return this.running;
  }

  stop(): void {
    this.abort?.abort();
    this.deps.store.snapshot.phase = 'idle';
    this.running = false;
  }

  /** 前置检查：缺 passphrase / 缺 NAS 地址时直接给出可读错误，而不是跑到一半失败。 */
  checkReady(): void {
    const c = this.deps.config;
    if (!c.passphrase) throw new Error('未配置加密口令：请先在设置里填写 passphrase');
    if (c.type === 'webdav') {
      if (!c.webdav?.url) throw new Error('未配置 WebDAV 地址（type=webdav 但 webdav.url 为空）');
    } else if (!c.mountRoot) {
      throw new Error('未配置 NAS 挂载点 mountRoot（type=mount）');
    }
  }

  private setPhase(p: SyncPhase): void {
    this.deps.store.snapshot.phase = p;
  }

  /**
   * 读远端清单（0.3.6）：列 `/dsh/manifests/*.json`，逐份解密后按 rel 合并。
   *
   * 为什么拆：单份共享清单是「最后写入者胜出」，两端几乎同时同步时，
   * 后写的那份会把对方刚记录的条目抹掉（实测手机 47 条幽灵条目就是这么来的）。
   * 每台设备各写一份，读时合并，天然无覆盖。
   *
   * 目录为空时回落到旧版单份 `/dsh/manifest.json`，并顺手迁移成 `_legacy.json`。
   */
  private async readRemoteManifest(): Promise<ManifestEntry[]> {
    let names: NasEntry[] = [];
    try {
      names = await this.deps.transport.list(MANIFESTS_DIR);
    } catch {
      names = []; // 目录还不存在 = 全新 NAS
    }
    // `_legacy.json` 只是「按设备拆分清单」之前那版**整份快照**，用途是迁移。
    // 一旦有了各设备自己的清单，它就是**永久过期**的：某台机器上一轮扫描到、
    // 之后删掉/改名的工作区会烂在里面，别的设备每轮都把它当「远端有、本地没有」
    // 去下载 → NAS 上 404 → 记一次错误 → 下一轮照旧，永远清不掉。
    // （手机端实测：23 条幽灵待同步全来自这份文件的 `workspaces/胎教Agent/`。）
    const files = names.filter(
      (n) => n.type === 'file' && n.name.endsWith('.json') && n.name !== '_legacy.json',
    );

    if (files.length === 0) {
      // 一个设备清单都没有才回退到旧格式：先看已迁移的 _legacy.json，再看老路径。
      const migrated = await this.readManifestAt(MANIFESTS_DIR + '/_legacy.json');
      const legacy = migrated.length > 0 ? migrated : await this.readManifestAt(LEGACY_MANIFEST);
      if (legacy.length === 0) return [];
      try {
        await this.writeManifestFile(manifestFileOf('_legacy'), legacy);
      } catch {
        /* 迁移失败只是每轮多读一次旧文件，不影响同步 */
      }
      return legacy.filter((e) => !isIgnoredRel(e.rel));
    }

    const parts: ManifestEntry[][] = [];
    for (const f of files) {
      const list = await this.readManifestAt(MANIFESTS_DIR + '/' + f.name);
      if (list.length > 0) parts.push(list);
    }
    // 远端也过一遍过滤：对端可能还在跑旧版扫描器（它的清单里照样列着
    // `.plugin-manager/logs/*` 与 `.bak` 副本）。只在本地排除的话，这些条目
    // 每轮都会被当「远端有、本地没有」重新下载一遍，待同步永远清不完。
    return mergeDeviceManifests(parts).filter((e) => !isIgnoredRel(e.rel));
  }

  /** 解密单份清单；文件不存在 / 口令不符都返回空（不抛）。 */
  private async readManifestAt(remote: string): Promise<ManifestEntry[]> {
    try {
      const enc = await this.deps.transport.getBuffer(remote);
      const plain = await Crypto.decrypt(enc, this.deps.config.passphrase);
      const list = JSON.parse(new TextDecoder().decode(plain));
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  private async writeManifestFile(remote: string, entries: ManifestEntry[]): Promise<void> {
    const enc = await Crypto.encrypt(
      new TextEncoder().encode(JSON.stringify(entries, null, 2)),
      this.deps.config.passphrase,
      this.deps.store.salt(),
    );
    await this.deps.transport.putBuffer(enc, remote, { mkdirs: true });
  }

  /**
   * 只写「本设备那份」清单：确认在远端存在的条目才写
   * （本轮 push 成功 + 之前已确认且哈希未变）。
   * 不写合并结果 —— 写别人的分片就是又回到互相覆盖。
   */
  private async writeOwnManifest(fresh: ManifestEntry[]): Promise<void> {
    const remote = manifestFileOf(selfDevice());
    const prevOwn = await this.readManifestAt(remote);
    const own = ownManifestEntries(fresh, prevOwn, this.pushedOk);
    await this.writeManifestFile(remote, own);
  }

  /**
   * 同步完成后写本机声明。明文即可 —— 里面只有目录名和计数，不是敏感数据；
   * 而且明文让 sourceDevices 不用解密就能读，面板刷新更快。
   */
  /**
   * 本机各 profile 的插件快照：声明名 + 实际安装版本。
   *
   * 口径与「插件同步管理」一致 —— 用 profile 的 package.json 声明，不看
   * node_modules 目录（hoisted 布局下那里躺着几百个传递依赖）。
   * 版本取 node_modules 里包的真实版本，所以手机与电脑能并排比出「0.82.0 vs 0.81.0」。
   */
  private localPluginSnapshot(): Array<{ profile: string; name: string; version: string }> {
    const out: Array<{ profile: string; name: string; version: string }> = [];
    const root = join(dshHome(), 'profiles');
    let dirs: string[] = [];
    try {
      dirs = readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => String(d.name));
    } catch {
      return out;
    }
    for (const p of dirs) {
      const dir = join(root, p);
      const declared = declaredPlugins(dir);
      if (!declared.length) continue;
      const installed = readInstalled(join(dir, 'node_modules'));
      for (const name of declared) {
        out.push({ profile: p, name, version: String(installed[name] ?? '') });
      }
    }
    return out;
  }

  private async writeDeviceClaim(fresh: ManifestEntry[]): Promise<void> {
    const prefixes: Record<string, number> = {};
    for (const e of fresh) {
      const p = prefixOf(e.rel);
      if (p) prefixes[p] = (prefixes[p] ?? 0) + 1;
    }

    // 本机拥有的工作区：标题来自注册表（侧栏显示的就是它），目录名来自 path。
    // 两者都写，前端用归一化名匹配，能覆盖「两端标题不同」的情况。
    const workspaces: Array<{ title: string; name: string }> = [];
    try {
      const raw = JSON.parse(await readFile(join(dshHome(), 'storages', 'workspace.json'), 'utf8'));
      for (const w of Object.values<any>(raw?.tables?.workspaces ?? {})) {
        const title = String(w?.title ?? '').trim();
        const p = String(w?.path ?? '');
        const name = p.split(/[\\/]+/).filter(Boolean).pop() ?? '';
        if (title) workspaces.push({ title, name });
      }
    } catch {
      /* 注册表读不到就只报目录级来源，不影响同步 */
    }

    // 插件快照：包体不过 NAS，对端只能从这份声明里知道「这台机器装了哪些插件」。
    // 手机与电脑的插件集不同（竖屏适配 vs 桌面布局），面板要并排显示两侧，
    // 光靠 `/dsh/profiles/<档>/package.json` 拿不到版本精度，也分不清是哪台机器写的。
    const plugins = this.localPluginSnapshot();

    const payload = JSON.stringify({
      device: selfDevice(),
      prefixes,
      workspaces,
      plugins,
      updatedAt: Date.now(),
    });
    await this.deps.transport.putBuffer(
      new TextEncoder().encode(payload),
      deviceClaimFile(selfDevice()),
      { mkdirs: true },
    );
  }

  /** 拉取远端某文件并解密（自动识别分块/直传，分块时校验 plainHash）。不存在返回 null。 */
  private async fetchRemotePlain(remote: string): Promise<Uint8Array | null> {
    let cipher: Uint8Array | null = null;
    let expectPlainHash: string | null = null;
    try {
      const r = await this.chunker.download(remote);
      cipher = r.cipher;
      expectPlainHash = r.manifest.plainHash;
    } catch {
      cipher = null; // 无分块清单 → 按直传文件处理
    }
    if (!cipher) {
      try {
        cipher = await this.deps.transport.getBuffer(remote);
      } catch {
        return null; // 远端不存在
      }
    }
    const plain = await Crypto.decrypt(cipher, this.deps.config.passphrase);
    if (expectPlainHash && sha256Hex(plain) !== expectPlainHash) {
      throw new Error('分块重组校验失败（plainHash 不匹配）: ' + remote);
    }
    return plain;
  }

  /** 把远端当前版本保存为 .base（三路合并的公共祖先）。失败不阻断主流程。 */
  private async saveBase(rel: string): Promise<void> {
    try {
      const plain = await this.fetchRemotePlain('/dsh/' + rel);
      if (!plain) return;
      const enc = await Crypto.encrypt(plain, this.deps.config.passphrase, this.deps.store.salt());
      await this.deps.transport.putBuffer(enc, '/dsh/' + rel + '.base', { mkdirs: true });
    } catch {
      /* .base 只是合并辅助，失败可以接受 */
    }
  }

  /**
   * 插件对账（0.4.0）。
   *
   * 插件的**包体永远不走同步**：`Scanner` 的 `walkFiles()` 遇到 `node_modules`
   * 直接跳过，跨设备过去的只有 `profiles/<p>/package.json` 这类装配清单。
   * 于是典型症状是「对端明明装了，这台机器上插件列表里没有」。
   *
   * 取数：
   *   · 远端 —— NAS 上每个 profile 的 package.json（解密后解析）；
   *   · 本机 —— **选定 profile** 的 node_modules 实际装了什么（不是清单）。
   *
   * 不按 profile 同名对比：手机跑 `web`、电脑跑 `desktop`，同名比永远比不出东西。
   * 默认拿「本机包装得最多的 profile」当目标（通常就是正在用的那个）。
   */
  async auditPlugins(targetProfile?: string): Promise<{
    gaps: PluginGap[];
    target: string;
    /** 目标 profile 里已装的第三方插件（不含 @deepseek-ai 内置） */
    installedPlugins: Array<{ name: string; version: string }>;
    localProfiles: Array<{ profile: string; count: number }>;
    remoteProfiles: string[];
    /** 两侧对比：本机（手机）+ 各对端（电脑）。手机与电脑的插件集不同，要并排看 */
    sides: PluginSide[];
    selfDevice: string;
  }> {
    this.checkReady();
    const root = join(dshHome(), 'profiles');

    const locals: Array<{ profile: string; installed: Record<string, string>; declared: string[] }> = [];
    let dirNames: string[] = [];
    try {
      dirNames = readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => String(d.name));
    } catch {
      dirNames = [];
    }
    for (const p of dirNames) {
      const dir = join(root, p);
      if (!existsSync(join(dir, 'package.json'))) continue;
      locals.push({
        profile: p,
        installed: readInstalled(join(dir, 'node_modules')),
        declared: declaredPlugins(dir),
      });
    }

    // 目标 profile：显式指定 > **当前正在跑的档** > 声明插件最多的那个 > 空
    //
    // 中间那一档是必须的：手机上 web 与 desktop 两个档都会被同步过来，只按「装得多」
    // 去挑，会在手机上面挑中 desktop —— 那个档在本机根本没有 node_modules，
    // 于是一排插件全没有版本号，对账口径也错到别的设备上去了。
    const running = runningProfile(locals.map((l) => l.profile));
    let target = '';
    if (targetProfile && locals.some((l) => l.profile === targetProfile)) {
      target = targetProfile;
    } else if (running) {
      target = running;
    } else if (locals.length > 0) {
      target = locals
        .slice()
        .sort((a, b) => b.declared.length - a.declared.length || Object.keys(b.installed).length - Object.keys(a.installed).length)[0]
        .profile;
    }
    const targetLocal = locals.find((l) => l.profile === target);
    const installed: Record<string, string> = (targetLocal || { installed: {} }).installed;

    const remote: RemoteProfile[] = [];
    let remoteDirs: NasEntry[] = [];
    try {
      remoteDirs = await this.deps.transport.list('/dsh/profiles');
    } catch {
      remoteDirs = [];
    }
    for (const d of remoteDirs) {
      // ⚠️ `NasEntry.type` 的取值是 'file' | 'dir'（见 transport.ts），不是 WebDAV 的
      // 'directory'。这里原来写 `!== 'directory'` 恒为真 → 每次都 continue → remote
      // 永远是空数组 → 差集恒为空 → 面板一直显示「所有插件已对齐」。
      // 也就是说 0.4.0 起插件对账其实一次都没真正比对过。
      if (d.type !== 'dir') continue;
      const plain = await this.fetchRemotePlain('/dsh/profiles/' + d.name + '/package.json');
      if (!plain) continue;
      const parsed = parseProfilePackage(new TextDecoder().decode(plain));
      if (!parsed) continue;
      remote.push({ profile: d.name, deps: parsed.deps, bundles: parsed.bundles });
    }

    // 「各自最优」：把目标 profile 传进去，让 diffPlugins 能判掉别的平台的专属插件
    // （手机的 dsh-web-mobile 不该在电脑上被建议安装）。
    const gaps = diffPlugins(installed, remote, { targetProfile: target }).map((g) => ({
      ...g,
      // 命令要装到**目标** profile，而不是清单来源的那个：手机跑 web、电脑跑 desktop，
      // 照抄 `--profile web` 会装进去但永远不会被加载。
      command: g.target ? installCommand(target, g.target) : '',
    }));

    // ---- 两侧视图（手机 / 电脑）----
    // 对账只报差集，用户看不到「两端各装了什么」，于是差集也没有参照物。
    // 这里补齐两侧：本机读磁盘（真值），对端读它同步时留下的插件快照。
    const byName = (a: { name: string }, b: { name: string }) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    const selfId = selfDevice();
    const sides: PluginSide[] = [
      {
        id: selfId,
        kind: deviceKindOf(selfId),
        source: 'self',
        profiles: target ? [target] : [],
        updatedAt: null,
        plugins: (targetLocal?.declared ?? [])
          .map((name) => ({ name, version: String(installed[name] ?? '') }))
          .sort(byName),
      },
    ];

    // 对端侧：设备声明（明文 JSON，`dsh/devices/<device>.json`）里的 plugins 快照。
    // 有版本、有归属，是唯一能分清「这是电脑的插件还是手机的」的来源。
    try {
      const claims = await this.deps.transport.list(DEVICES_REMOTE);
      for (const f of claims) {
        if (f.type !== 'file' || !f.name.endsWith('.json')) continue;
        const id = f.name.replace(/\.json$/, '');
        if (id === selfId) continue;
        let claim: any = null;
        try {
          claim = JSON.parse(
            new TextDecoder().decode(await this.deps.transport.getBuffer(DEVICES_REMOTE + '/' + f.name)),
          );
        } catch {
          continue; // 单个声明坏了不该让整张卡打不开
        }
        if (!claim || typeof claim.device !== 'string' || claim.device === selfId) continue;
        const raw = Array.isArray(claim.plugins) ? claim.plugins : [];
        const plugins = raw
          .filter((p: any) => p && typeof p.name === 'string' && !String(p.name).startsWith('@deepseek-ai/'))
          .map((p: any) => ({ name: String(p.name), version: String(p.version ?? '') }))
          .sort(byName);
        sides.push({
          id: String(claim.device),
          kind: deviceKindOf(String(claim.device)),
          // 声明里还没有 plugins 字段 = 对端跑的是 0.5.3 之前的版本
          source: plugins.length ? 'claim' : 'remote',
          profiles: [...new Set(raw.map((p: any) => String(p?.profile ?? '')).filter(Boolean))] as string[],
          updatedAt: Number(claim.updatedAt) || null,
          plugins,
        });
      }
    } catch {
      /* 远端不可达：只显示本机侧，差集仍然有效 */
    }

    // 退路①：对端是旧版本（声明里没 plugins）→ 拿远端 profile 声明按设备类别补。
    // 版本是 spec 而不是实际安装版本，但至少能并排看出「它装了哪几个」。
    for (const side of sides) {
      if (side.source !== 'remote' || side.plugins.length) continue;
      const near = remote.filter((r) => deviceClassOfProfile(r.profile) === side.kind);
      const merged = new Map<string, string>();
      for (const r of near) {
        for (const [n, spec] of Object.entries(r.deps)) {
          if (n.startsWith('@deepseek-ai/')) continue;
          merged.set(n, spec);
        }
      }
      side.plugins = [...merged].map(([name, version]) => ({ name, version })).sort(byName);
      side.profiles = near.map((r) => r.profile);
    }

    // 退路②：连设备声明都没有 → 按远端 profile 各开一侧（本机那一档跳过，否则会自己跟自己比）
    if (sides.length === 1 && remote.length) {
      for (const r of remote) {
        if (r.profile === target) continue;
        const plugins = Object.entries(r.deps)
          .filter(([n]) => !n.startsWith('@deepseek-ai/'))
          .map(([name, version]) => ({ name, version }))
          .sort(byName);
        if (!plugins.length) continue;
        sides.push({
          id: r.profile,
          kind: deviceClassOfProfile(r.profile),
          source: 'remote',
          profiles: [r.profile],
          updatedAt: null,
          plugins,
        });
      }
    }

    return {
      gaps,
      target,
      // 本机（目标 profile）已装的**第三方**插件清单。对账只报差集，光看差集
      // 用户会以为「一个插件都没装」；这里把已装的也吐出来，面板才能显示全貌。
      // 口径是 profile 声明的依赖，不是 node_modules 目录（后者混着几百个传递依赖）。
      installedPlugins: (targetLocal?.declared ?? [])
        .map((name) => ({ name, version: String(installed[name] ?? '') }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
      // 计数口径同「本机已装」：用声明的插件数，不用 node_modules 条目数
      // （后者在 hoisted 布局下包含几百个传递依赖，会显示成 web(134) 这种噪声）。
      localProfiles: locals.map((l) => ({ profile: l.profile, count: l.declared.length })),
      remoteProfiles: remote.map((r) => r.profile),
      sides,
      selfDevice: selfId,
    };
  }

  async scan(): Promise<{ local: ManifestEntry[]; pending: PendingFile[]; conflicts: ConflictItem[] }> {
    this.checkReady();
    this.loadWorkspaceDirs();
    this.setPhase('scanning');
    const local = await this.scanner.buildManifest();
    const remote = await this.readRemoteManifest();
    this.remoteManifest = remote;

    const localMap = new Map(local.map((e) => [e.rel, e]));
    const remoteMap = new Map(remote.map((e) => [e.rel, e]));
    const pending: PendingFile[] = [];
    const conflicts: ConflictItem[] = [];

    const last = this.deps.store.snapshot.lastSyncTime ?? 0;

    for (const [rel, le] of localMap) {
      // 注册表不参与差集：它由 pullWorkspaceRegistry() 每轮**合并**，永远不可能
      // 和远端字节一致（合并结果包含本机条目），留在差集里会变成「永远待同步 1 项」。
      if (isWorkspaceRegistryRel(rel)) continue;
      const re = remoteMap.get(rel);
      if (!re) {
        pending.push({ rel, size: le.size, action: 'upload' });
        continue;
      }
      if (le.hash === re.hash) continue;

      const localChanged = le.mtime > last;
      const remoteChanged = re.mtime > last;

      if (localChanged && remoteChanged) {
        conflicts.push({
          rel,
          localMtime: le.mtime,
          remoteMtime: re.mtime,
          localHash: le.hash,
          remoteHash: re.hash,
          mergeable: isMergeable(rel),
        });
      } else if (localChanged || le.mtime > re.mtime) {
        pending.push({ rel, size: le.size, action: 'upload' });
      } else {
        pending.push({ rel, size: re.size, action: 'download' });
      }
    }

    // 远端有、本地无 -> 下载
    for (const [rel, re] of remoteMap) {
      if (isWorkspaceRegistryRel(rel)) continue;
      if (!localMap.has(rel)) {
        pending.push({ rel, size: re.size, action: 'download' });
      }
    }

    // 排序：先上传后下载，小文件优先
    const order = (a: string): number => (a === 'upload' ? 0 : 1);
    pending.sort((a, b) => order(a.action) - order(b.action) || a.size - b.size);

    this.deps.store.pendingFiles = pending;
    this.deps.store.conflicts = conflicts;
    this.deps.store.snapshot.pendingCount = pending.length;
    this.deps.store.snapshot.conflictCount = conflicts.length;
    this.deps.store.save();

    return { local, pending, conflicts };
  }

  async sync(mode: SyncMode): Promise<{
    pushed: number;
    pulled: number;
    mergedRegistry: number;
    skippedDownload: number;
    conflicts: number;
  }> {
    if (this.running) throw new Error('同步任务正在进行中');
    this.checkReady();
    this.running = true;
    this.abort = new AbortController();
    this.pushedOk.clear();
    /**
     * 先并注册表，再读「工作区名字 → 本机目录」映射（0.5.5）。
     *
     * 顺序不能反：`loadWorkspaceDirs()` 是 rel 落地位置的唯一依据，手机上新加的
     * 工作区必须在本轮扫描前就被它认出来，否则这一轮它那几十个文件会落到
     * `$DSH_HOME/workspaces/<名字>` 这个退化位置（既看不见、还要下一遍）。
     *
     * push 模式不动本机注册表，但要无条件发布（没有比较依据）；其余模式先合并，
     * 再按 registryCovers 判定「本机有没有远端缺的东西」决定是否发布 —— 否则
     * 两台设备的注册表 id 天然不同，会每轮互相盖回去。
     */
    this.registryNeedsPush = mode === 'push';
    if (mode !== 'push') await this.pullWorkspaceRegistry();
    this.loadWorkspaceDirs();

    // 本机有远端缺的工作区/会话归属 → 发布一次，让对端也能拿到（判定见 registryCovers）。
    // 放在扫描前：远端注册表越早收敛，对端下一步的落地位置就越准。
    if (this.registryNeedsPush && mode !== 'pull') await this.pushWorkspaceRegistry();
    /**
     * 先落盘「运行中 + 空进度」，再进 scan（0.5.1）。
     *
     * scan 在手机上要跑几十秒到几分钟（全量 sha256 + 读远端分片清单），
     * 面板这段时间读的是 store.json 快照。原来 progress 只在 scan **之后**
     * 重置，于是扫描期间面板一直显示上一轮残留的 `scanning (94/145)` ——
     * 一个既不前进也不归零的假进度，用户只会以为「卡死了」。
     */
    this.deps.store.snapshot.running = true;
    this.deps.store.snapshot.progress = { total: 0, done: 0, errors: 0 };
    this.deps.store.save();

    /**
     * 无进展看门狗（0.5.2，第二道闸）。
     *
     * 传输层已经给每个 WebDAV 请求加了硬超时，但挂住不一定发生在请求上 ——
     * 宿主 fs、SAF 桥、scrypt、以及将来任何一处 await 都可能无声卡死。
     * 这里只认一件事：**还有没有在推进**。项与项之间刷新心跳，超过 5 分钟
     * 一次都没动就主动 abort，把「静默挂一小时」变成一条明确的中止。
     */
    const STALL_MS = 5 * 60_000;
    let lastBeat = Date.now();
    /** 每完成一项刷新一次心跳（项内耗时交给传输层超时管） */
    const beat = (): void => { lastBeat = Date.now(); };
    this.stallAbort = false;
    const watchdog = setInterval(() => {
      if (Date.now() - lastBeat < STALL_MS) return;
      this.stallAbort = true;
      try { this.abort?.abort(new Error('stall')); } catch { /* 已中止 */ }
    }, 30_000);
    // 别让这个 interval 把进程钉住不退出
    (watchdog as any).unref?.();

    try {
      const { pending } = await this.scan();
      const localMap = new Map((await this.scanner.buildManifest()).map((e) => [e.rel, e]));
      const remoteMap = new Map(this.remoteManifest.map((e) => [e.rel, e]));

      const total = pending.length;
      this.deps.store.snapshot.progress = { total, done: 0, errors: 0 };
      this.deps.store.snapshot.running = true;
      this.deps.store.save();

      let pushed = 0;
      let pulled = 0;
      /** 拉到注册表并做了合并（不计入 pulled，避免虚报） */
      let mergedRegistry = 0;
      /** 按策略跳过（异平台会话 / 本机注册表已可用） */
      let skippedDownload = 0;
      // 同步成功后要从待办里移除的项。失败的、以及因 mode 不匹配而跳过的，
      // 都留在 remaining 里 —— 否则收尾时把 pendingCount 清零会**谎报**「已全部同步」。
      const remaining = new Set(pending);

      for (const item of pending) {
        if (this.abort.signal.aborted) break;
        try {
          if (mode === 'push' && item.action !== 'upload') continue;
          if (mode === 'pull' && item.action !== 'download') continue;

          if (item.action === 'upload') {
            await this.pushFile(item.rel, item.size, remoteMap.get(item.rel)?.hash);
            this.pushedOk.add(item.rel);
            pushed++;
          } else if (item.action === 'download') {
            // 守卫已下沉到 downloadEntry()（0.3.5），这里只按落地结果计数，
            // 避免「跳过也 pulled++」把同步结果报虚。
            const outcome = await this.downloadEntry(item.rel);
            if (outcome === 'written') pulled++;
            else if (outcome === 'merged') mergedRegistry++;
            else skippedDownload++;
          }
          this.deps.store.snapshot.progress.done++;
          remaining.delete(item);
        } catch {
          this.deps.store.snapshot.progress.errors++;
          // 单项失败不中断整体
        }
        // 成功或失败都算「还在推进」—— 心跳不关心结果，只关心有没有卡死
        beat();
        this.deps.store.save();
      }

      // 收尾修复：把本次以及**以前**同步进来的会话统一检查一遍 cwd。
      // 幂等（cwd 本机已存在就跳过），所以每次 pull 都跑也不会有额外开销；
      // 这样即便上次同步时还没有这套逻辑，下一次 pull 也能把历史的坑填上。
      if (!this.abort.signal.aborted) {
        try {
          // 先收敛工作区注册表：重复 session 归属会让 dsh 的 workspace 插件
          // 拒绝激活，侧栏全空且 workspaceController 报 service-unavailable。
          // 必须放在任何同步方向的收尾（不只是 pull），历史脏数据也能自愈。
          const fix = await repairWorkspaceRegistry();
          if (fix.merged + fix.removed + fix.orderFixed > 0) {
            console.warn(
              '[dsh-nas-sync] 注册表已收敛：合并工作区 ' + fix.merged +
              '、清理重复 session 归属 ' + fix.removed +
              '、修正顺序 ' + fix.orderFixed,
            );
          }
        } catch {
          /* 修复失败不该让整轮同步判失败 */
        }
        try {
          await repairSessionCwd();
        } catch {
          /* 修复失败不该让整轮同步判失败 */
        }
        try {
          // 必须放在 repairSessionCwd 之后：搬目录本身也可能让同一个 sessionId
          // 落到两个 cwd 目录里，而 dsh 扫描到重复就拒绝激活 workspace 插件。
          const dedup = await dedupeSessionDirs();
          if (dedup.duplicates > 0) {
            console.warn(
              '[dsh-nas-sync] 会话目录已收敛：重复 session ' + dedup.duplicates +
              '、隔离副本 ' + dedup.isolated + '（保留在 .suspect-quarantine）',
            );
          }
        } catch {
          /* 修复失败不该让整轮同步判失败 */
        }
      }

      // 回写 manifest：用最新本地状态重建（下载过的文件也反映进来）
      if (!this.abort.signal.aborted) {
        const fresh = await this.scanner.buildManifest();
        /**
         * 来源设备合并：`buildManifest` 会把扫到的每个文件都标成本机（它只知道
         * 「我这儿有这个文件」）。但清单要回答的是「谁传上来的」，所以内容哈希
         * 与上一轮一致的条目**保留原来源**，只有真正变了的才归给本机。
         * 不做这一步，来源每同步一次就被刷成"本机"，等于没记。
         */
        // 0.3.6：只写本设备那份清单，再重读合并视图。
        // 不再「把远端独有的条目补回」—— 每份清单只含确认在远端存在的东西，
        // 补回反而会给对端制造下载不到的幽灵条目。
        await this.writeOwnManifest(fresh);
        this.remoteManifest = await this.readRemoteManifest();
        // 本地基线留着（0.4.x 的删除传播要用）
        this.deps.store.localManifest = fresh;
        // 写本机来源声明。失败不能让整轮同步判失败（只是少了 emoji 而已）。
        try {
          await this.writeDeviceClaim(fresh);
        } catch {
          /* 忽略 */
        }
        this.deps.store.snapshot.lastSyncTime = Date.now();

        // 收尾刷新待办：不留「同步成功但仍显示待同步 N 项」的假状态。
        this.deps.store.pendingFiles = [...remaining];
        this.deps.store.snapshot.pendingCount = remaining.size;
      }

      // 被看门狗掐断：必须把原因抛出去，面板才会显示「为什么没同步完」。
      // 不抛的话用户只看到进度停住、没有任何解释 —— 那就是本次故障的原始体验。
      if (this.stallAbort) {
        throw new Error(
          '同步中止：连续 5 分钟没有任何进展（NAS 可能掉线，或某个请求被网络掐住）。' +
          '断点已保留，网络恢复后重试即可续传。',
        );
      }

      return { pushed, pulled, mergedRegistry, skippedDownload, conflicts: this.deps.store.conflicts.length };
    } finally {
      clearInterval(watchdog);
      this.running = false;
      this.deps.store.snapshot.running = false;
      this.setPhase('idle');
      this.deps.store.save();
    }
  }

  /** 上传单个文件（整体密文；大文件走分块）。remoteHash 存在且为可合并文本时先存 .base。 */
  private async pushFile(rel: string, size: number, remoteHash?: string): Promise<void> {
    this.setPhase('uploading');
    const localAbs = this.resolveLocal(rel);
    const remote = '/dsh/' + rel;

    // 可合并文本且远端已有版本 → 先把远端旧内容存为 .base（三路合并公共祖先）
    if (isMergeable(rel) && remoteHash) {
      await this.saveBase(rel);
    }

    const data = await readFile(localAbs);
    const plainHash = sha256Hex(data);
    const cipher = await Crypto.encrypt(data, this.deps.config.passphrase, this.deps.store.salt());

    if (size >= this.deps.config.chunkThreshold) {
      await this.chunker.upload(cipher, plainHash, size, remote);
    } else {
      await this.deps.transport.putBuffer(cipher, remote, { mkdirs: true });
    }
  }

  /**
   * 把 NAS 上的工作区注册表**合并**进本机（只加不改）。
   *
   * 0.5.5 之前这一步只发生在「本机没有可用注册表」的时候：`downloadEntry()` 里
   * 有一条 `isWorkspaceRegistryRel(rel) && workspaceRegistryReady() → skipped`。
   * 于是**只要本机注册表已经可用，远端注册表就永远不会被合并** —— 手机上新加的
   * 工作区（如「鲸鱼宠物」）在电脑上永远不出现：
   *
   *   loadWorkspaceDirs() 没有这个映射
   *     → resolveLocal('workspaces/鲸鱼宠物/…') 退化成 $DSH_HOME/workspaces/鲸鱼宠物
   *     → 59 个文件确实落地了，但既不在注册表里（侧栏看不见），也不在扫描范围
   *       （nassyncworkspaces/）里
   *     → 用户看到的就是「手机上的文件夹什么都没同步过来」。
   *
   * 合并本身是保守的（见 mergeWorkspaceRegistry：本地已有的 id 一律保留 path/title），
   * 所以每轮都跑也不会抹掉本机条目；无变化时它连盘都不写。
   */
  private async pullWorkspaceRegistry(): Promise<void> {
    this.registryNeedsPush = false;
    const localAbs = join(dshHome(), WORKSPACE_REGISTRY_REL);
    let plain: Uint8Array | null = null;
    try {
      plain = await this.fetchRemotePlain('/dsh/' + WORKSPACE_REGISTRY_REL);
    } catch (e) {
      // 拉不到注册表不该让整轮同步判失败：注册表只决定「目录名 + 会话归属」，
      // 文件本身各自按 rel 走，缺了它只是这一轮看不到新工作区。
      console.warn('[dsh-nas-sync] 拉取工作区注册表失败：' + (e as Error).message);
      return;
    }
    // 远端还没有 → 把本机这份发上去，让新机器也能拿到工作区名
    if (!plain) {
      this.registryNeedsPush = true;
      return;
    }
    // 必须经 Buffer：plain 是 Uint8Array，`toString('utf8')` 会走
    // Array.prototype.toString 拼成 "123,34,…" 的逗号串，JSON.parse 必失败。
    const remoteText = Buffer.from(plain).toString('utf8');
    try {
      const r = await mergeWorkspaceRegistry(remoteText);
      if (r.added > 0 || r.remapped > 0 || r.deduped > 0) {
        console.warn(
          '[dsh-nas-sync] 工作区注册表已合并：新增 ' + r.added +
          '、修正路径 ' + r.remapped + '、去重 ' + r.deduped,
        );
      }
      const localText = await readFile(localAbs, 'utf8');
      this.registryNeedsPush = !registryCovers(remoteText, localText);
    } catch (e) {
      console.warn('[dsh-nas-sync] 合并工作区注册表失败：' + (e as Error).message);
    }
  }

  /** 把本机注册表发布到 NAS（只在 pullWorkspaceRegistry 判定「本机有多出来的部分」时调用）。 */
  private async pushWorkspaceRegistry(): Promise<void> {
    try {
      const abs = join(dshHome(), WORKSPACE_REGISTRY_REL);
      const buf = await readFile(abs);
      await this.pushFile(WORKSPACE_REGISTRY_REL, buf.length);
      this.pushedOk.add(WORKSPACE_REGISTRY_REL);
    } catch (e) {
      // 发布失败不影响整轮结果：下一轮 pull 会重新判定并重试
      console.warn('[dsh-nas-sync] 发布工作区注册表失败：' + (e as Error).message);
    }
  }

  /**
   * 下载单个文件并解密写盘。工作区注册表与会话头要额外处理，见各分支注释。
   */
  private async downloadEntry(rel: string): Promise<DownloadOutcome> {
    this.setPhase('downloading');

    // 0.5.5：这里原来有一条 `isWorkspaceRegistryRel(rel) && workspaceRegistryReady()
    // → 'skipped'` 的守卫，导致「本机注册表一可用，远端注册表就再也不合并」。
    // 那个守卫是想防「覆盖」，但真正的覆盖风险早在下面的合并分支里解决了
    // （mergeWorkspaceRegistry 只加不改、本地 path/title 一律保留），所以守卫
    // 已删除；每轮同步改由 pullWorkspaceRegistry() 在扫描前统一合并。

    const plain = await this.fetchRemotePlain('/dsh/' + rel);
    if (!plain) {
      // 清单里有、NAS 上已经没有了（对端删除/改名，或清单残影）。**不能记成错误**：
      // 每轮都会重来一次，errors 会永远停在某个数字上，「同步失败」变成常驻噪音。
      // 跳过并计数，下一轮扫描时清单若已收敛，这条自然消失。
      console.warn('[dsh-nas-sync] 跳过：远端已不存在 ' + rel);
      return 'skipped';
    }

    // ① 工作区注册表：直接覆盖会把本机的工作区整片抹掉（本地 default-workspace 也没了），
    //    所以这里**只合并不覆盖**，并把远端绝对路径映射成本机真实目录。
    //    注意：plain 是 Uint8Array，`plain.toString('utf8')` 会走 Array.prototype.toString
    //    得到 "123,34,..." 这样的逗号串（encoding 参数被忽略），JSON.parse 必失败，
    //    整个合并就成了静默 no-op。必须显式经过 Buffer。
    if (isWorkspaceRegistryRel(rel)) {
      await mergeWorkspaceRegistry(Buffer.from(plain).toString('utf8'));
      return 'merged';
    }

    const localAbs = this.resolveLocal(rel);
    const cut = Math.max(localAbs.lastIndexOf('/'), localAbs.lastIndexOf('\\'));
    await mkdir(localAbs.slice(0, cut), { recursive: true });

    // ② 会话头里的 cwd 是**原机器**的绝对路径（手机上形如
    //    /data/user/0/com.dsh.harness/files/home/wstest），到本机不存在就会
    //    「本轮运行失败: working-directory does not exist」。而 dsh 明确拒绝
    //    「换一个 cwd 打开已有会话」（ApiSessionCwdConflict），调用方临时指定也没用
    //    —— 唯一可行的是落地时就把记录里的路径改写成本机路径。
    if (isSessionRel(rel)) {
      // 同样必须 Buffer.from：rewriteSessionCwd 用的是 readUInt32LE/subarray 这套
      // Buffer 专有 API，直接传 Uint8Array 会在帧解析处抛错并被吞掉。
      const raw = Buffer.from(plain);

      // 0.3.4：跨平台判定必须看**原始 cwd**，不能看映射后的 out.dir。
      // out.dir 永远是本机路径（Windows 上是盘符路径、手机上是 /data/...），
      // platformMismatch(out.dir) 恒为 false，等于没拦。结果 mirror 每轮把
      // 对端会话映射进本机 nassyncworkspaces/ 新目录，和本机权威目录撞出
      // 同 id 双份，收尾 dedupeSessionDirs 就每轮隔离一批（实测 11 份）。
      const originalCwd = sessionCwdOf(raw);
      if (originalCwd && platformMismatch(originalCwd)) {
        console.warn('[dsh-nas-sync] 跳过异平台会话（原始 cwd=' + originalCwd + '）: ' + rel);
        return 'skipped';
      }

      const out = rewriteSessionCwd(raw);
      // out === null 表示 cwd 本机已存在、无需改写；但**落点仍要按本机 cwd
      // 归一**，否则会写回原 rel 的远端目录，再次制造同 id 双份。
      const localCwd = out ? out.dir : originalCwd
        ? mapRemotePath(originalCwd).local
        : null;
      if (localCwd) {
        await mkdir(localCwd, { recursive: true });

        // rel 形如 sessions/<cwd编码>/<sessionId>/session.v4.jsonl.zstd
        const parts = rel.split('/');
        const sid = parts[parts.length - 2] ?? '';
        const fileName = parts[parts.length - 1] ?? '';
        const wantDir = encodeCwd(localCwd);
        const targetRel = wantDir === parts[1] ? rel : ['sessions', wantDir, sid, fileName].join('/');
        const target = this.resolveLocal(targetRel);
        const cut2 = Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\'));
        await mkdir(target.slice(0, cut2), { recursive: true });
        await writeFile(target, out ? out.buf : raw);

        // 目录名变了就别把旧副本留着 —— 同一个 sessionId 出现在两个 cwd 目录下，
        // dsh 会当成两个会话（其中一个永远打不开）。
        if (target !== localAbs) {
          try {
            await rm(localAbs.slice(0, cut), { recursive: true, force: true });
          } catch {
            /* 删不掉也不影响下一轮再修 */
          }
        }
        return 'written';
      }
      // 连 cwd 都读不出来：不落盘，避免造出一个打不开的幽灵会话。
      return 'skipped';
    }

    await writeFile(localAbs, plain);
    return 'written';
  }

  /** 解决冲突：local = 推本地覆盖远端；remote = 拉远程覆盖本地；skip = 仅移出冲突列表。 */
  async resolve(rel: string, resolution: 'local' | 'remote' | 'skip'): Promise<void> {
    this.checkReady();
    const c = this.deps.store.conflicts.find((x) => x.rel === rel);
    if (!c) throw new Error('冲突记录不存在：' + rel);

    if (resolution === 'local') {
      const localAbs = this.resolveLocal(rel);
      const st = await stat(localAbs);
      // 冲突场景：远端旧内容正是公共祖先，务必先存 .base
      await this.saveBase(rel);
      await this.pushFile(rel, st.size, c.remoteHash);
      // 回写远端 manifest，防止下次扫描再次判定为冲突
      const data = await readFile(localAbs);
      this.remoteManifest = this.remoteManifest.filter((e) => e.rel !== rel);
      this.remoteManifest.push({
        rel,
        mtime: st.mtimeMs,
        size: st.size,
        hash: sha256Hex(data),
        // 本地版本胜出 = 本机上传，来源记为当前设备
        device: selfDevice(),
      });
      this.pushedOk.add(rel);
      await this.writeOwnManifest(await this.scanner.buildManifest());
      this.remoteManifest = await this.readRemoteManifest();
    } else if (resolution === 'remote') {
      const outcome = await this.downloadEntry(rel);
      if (outcome === 'skipped') {
        // 注册表 rel 在本机已可用时禁止远端覆盖（会改写工作区归属）；
        // 异平台会话也不该落地。这里只把冲突移出列表，不动本地文件。
        this.deps.store.conflicts = this.deps.store.conflicts.filter((x) => x.rel !== rel);
        this.deps.store.snapshot.conflictCount = this.deps.store.conflicts.length;
        this.deps.store.save();
        return;
      }
      // 回写远端 manifest：本地 mtime 已变化，记录最新指纹
      const localAbs = this.resolveLocal(rel);
      const st = await stat(localAbs);
      const data = await readFile(localAbs);
      // 远端版本胜出 = 内容来自对方设备，来源必须保留，否则会被刷成"本机"
      const prevDevice = this.remoteManifest.find((e) => e.rel === rel)?.device;
      this.remoteManifest = this.remoteManifest.filter((e) => e.rel !== rel);
      this.remoteManifest.push({
        rel,
        mtime: st.mtimeMs,
        size: st.size,
        hash: sha256Hex(data),
        device: prevDevice,
      });
      // 分设备清单下，这条 rel 属于对端的分片，本机不改它 —— 只刷新合并视图。
      // 若下载时改写了内容（会话 cwd），下一轮会判成 upload 并写进本机分片。
      this.remoteManifest = await this.readRemoteManifest();
    }
    // skip：什么都不做

    this.deps.store.conflicts = this.deps.store.conflicts.filter((x) => x.rel !== rel);
    this.deps.store.snapshot.conflictCount = this.deps.store.conflicts.length;
    this.deps.store.save();
  }

  /** 跳过某个待同步文件（从 pending 中移除，不影响远端）。 */
  async skipPending(rel: string): Promise<void> {
    this.deps.store.pendingFiles = this.deps.store.pendingFiles.filter((p) => p.rel !== rel);
    this.deps.store.snapshot.pendingCount = this.deps.store.pendingFiles.length;
    this.deps.store.save();
  }

  /** 读取远端某文件明文（供 try_merge / diff 工具复用）。 */
  async readRemoteText(rel: string): Promise<string | null> {
    this.checkReady();
    const plain = await this.fetchRemotePlain('/dsh/' + rel);
    return plain ? new TextDecoder().decode(plain) : null;
  }

  /** 读取远端 .base 明文（三路合并公共祖先）。 */
  async readBaseText(rel: string): Promise<string> {
    this.checkReady();
    const plain = await this.fetchRemotePlain('/dsh/' + rel + '.base');
    return plain ? new TextDecoder().decode(plain) : '';
  }
}
