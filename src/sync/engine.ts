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

import { readFile, writeFile, mkdir, rm, cp, rename, readdir as readdirAsync } from 'node:fs/promises';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
// 0.5.9：破坏性动作的纯判据与本地状态文件的安全读写（都能离线单测）
import {
  isSafeRel, evaluateManifestTrust, advanceMissingRounds, shouldRetire,
  computeLocalDeletes, eventStreamAllowsDeletes, normalizeRetentionDays,
  type ManifestRead,
} from './safety.js';
import { readJsonFile, writeJsonAtomic, writeBackup } from './state-file.js';
import { createHash } from 'node:crypto';
import type {
  ConflictItem, ManifestEntry, PendingFile, SyncPhase,
  SyncEvent, Tombstone, DeviceCursor, EventStreamTrust, BidMapEntry,
} from '../data/models.js';
import { isIgnoredRel, Scanner, SYNC_CATEGORIES } from './scanner.js';
import { Crypto } from './crypto.js';
import { Chunker } from './chunker.js';
import type { NasEntry, NasTransport } from '../nas/transport.js';
import type { NasSyncConfig, SessionImportRecord, Store } from '../config.js';
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
  stripDeletedEntries,
} from './manifest.js';
import {
  EVENTS_DIR, TOMBSTONES_FILE, BIDMAP_FILE, eventLogFileOf, eventShardOf, cursorFileOf,
  parseEventLog, serializeEventLog, validateEventStream, mergeEventLogs,
  buildTombstones, mergeTombstones, collectGc, stableKeyOf, nextLocalSeq,
  makeEvent, eventsSince, advanceCursor, tombstoneTargets,
  canonicalSessionRel, mergeBidMaps, sessionIdFromRel,
  type EventLogRead,
} from './events.js';
import {
  MIGRATION_MARKER_PATH, planRelMigration, validateRelPlan, rewriteManifestForMode,
  mergeDualRead, isCanonicalSessionRel, isLegacySessionRel, legacyRelToCanonical,
  canonicalRelToLocal, buildMigrationMarker, legacyProtected, bidMapFromPlan,
  safeCwdSegment,
  type SessionRelMode, type RelMigrationPlan, type MigrationMarker,
} from './rel-migration.js';
import {
  ScanCacheSession, configFingerprint, loadScanCache, saveScanCache,
  DEFAULT_SCAN_CACHE_TTL_MS,
} from './scan-cache.js';
import {
  pluginObjectPath, buildAssemblies, mergeAssemblies, currentTarget,
  type PluginAssembly,
} from './plugin-objects.js';
import { unpackTgz } from './tgz.js';
import type { PluginObjectRecord } from '../data/models.js';
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
  sessionHeaderIdentity,
  dedupeSessionDirs,
  repairSessionCwd,
  registerSessionForRel,
  repairWorkspaceRegistry,
  registryCovers,
  rewriteSessionCwd,
  rewriteSessionCwdTo,
  safeName,
  localIsStaleSnapshot,
  sessionFrameOffsets,
  unregisterSessionFromRel,
  WORKSPACE_REGISTRY_REL,
  listTrashedSessionIds,
  pruneEmptySessionDirs,
  dropSessionProjCache,
  type WorkspaceCollision,
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
/** 0.6.0 / 收尾④：各平台插件包体的装配清单（明文，只有指纹与大小）。 */
const PLUGIN_ASSEMBLIES_FILE = '/dsh/plugin-assemblies.json';
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

  /**
   * 本轮远端清单是否「读到过至少一份非空的设备清单」（0.5.8）。
   *
   * 删除传播要靠「对端清单里这条没了」来判断，而清单读失败时
   * `readManifestAt()` 会吞异常返回 []、`readRemoteManifest()` 又只把非空的塞进
   * 合并结果 —— 于是「NAS 掉线」「GET 拿回半截」「口令不符」全都长得跟
   * 「所有会话都被删了」一模一样。所以只有这个标记为 true 时才允许据此回收镜像。
   */
  private remoteManifestTrusted = false;

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
   * 本机屏蔽的会话 id（0.5.8），来自 `$DSH_HOME/nas-sync/ignored-sessions.json`。
   * 每轮扫描开头重读一次 —— 用户可能在我们跑着的时候手改这个文件。
   */
  private ignoredFromFile = new Set<string>();

  /**
   * 屏蔽清单读坏了（0.5.9）。此时**不**清空 `ignoredFromFile`，并且禁止本轮所有
   * 破坏性回收动作 —— 0.5.8 在这里 fail-open，用户手写坏一次 JSON 就等于撤销屏蔽。
   */
  private ignoredFileError: string | null = null;

  /** 本轮读失败的设备清单名（0.5.9），供状态面板解释「为什么这轮没有删除传播」。 */
  private manifestTrustFailed: string[] = [];

  /**
   * 0.6.0 / 收尾①：会话 rel 空间模式。默认 legacy，升级后线上字节一个都不变。
   * 只有显式配置成 shadow / canonical 才会启用新空间（见 rel-migration.ts）。
   */
  private sessionRelMode: SessionRelMode = 'legacy';

  /** 迁移标记缓存；null = 尚未读取 / 不存在。 */
  private migrationMarker: MigrationMarker | null = null;

  /** 0.6.0 / 收尾③：增量扫描缓存会话（跨轮复用 hash）。 */
  private scanCache?: ScanCacheSession;
  /** 缓存损坏/写盘失败时要显式告警，不能静默退化成每轮全量扫描。 */
  private scanCacheWarning: string | null = null;

  /** 进行中的扫描（并发调用复用同一轮，见 scan() 注释）。 */
  private scanInFlight: Promise<{ local: ManifestEntry[]; pending: PendingFile[]; conflicts: ConflictItem[] }> | null = null;

  /** 本次装载到的工作区 rel 撞车（同名不同路径），供状态面板提示。 */
  private workspaceCollisions: WorkspaceCollision[] = [];

  // ---- 0.6.0 / P1：事件驱动删除传播的运行态 ----
  /** 本轮合并后的全局事件流（所有设备日志按序合并）。 */
  private eventStream: SyncEvent[] = [];
  /** 事件流完整性判据；null = 本轮还没读过。 */
  private eventTrust: EventStreamTrust | null = null;
  /** 由事件流回放出的墓碑（删除优先，带 30 天保留期）。 */
  private tombstones: Tombstone[] = [];
  /** 事件流读取/发布失败的原因，供面板与日志解释「为什么这轮删除没生效」。 */
  private eventStreamError: string | null = null;
  /** 本轮成功发布的本机事件数。 */
  private publishedEvents = 0;
  /** 上次成功读取事件流的时间戳（10 秒内复用，避免一轮同步读两遍）。 */
  private eventStreamFreshAt = 0;

  /** 面板/诊断用：当前安全开关的状态。 */
  safetyStatus(): {
    ignoredFileError: string | null;
    manifestTrustFailed: string[];
    destructiveBlocked: boolean;
    eventStream: {
      trusted: boolean;
      events: number;
      tombstones: number;
      failed: string[];
      gaps: number;
      published: number;
      lastError: string | null;
    };
    /** 0.6.0 / 收尾③：增量扫描缓存命中情况 */
    scanCache: {
      enabled: boolean; hits: number; misses: number; changed: number;
      expired: number; invalidated: boolean; warning: string | null;
    };
  } {
    return {
      ignoredFileError: this.ignoredFileError,
      manifestTrustFailed: [...this.manifestTrustFailed],
      destructiveBlocked: this.ignoredFileError !== null,
      eventStream: {
        trusted: this.eventTrust?.trusted ?? false,
        events: this.eventStream.length,
        tombstones: this.tombstones.length,
        failed: [...(this.eventTrust?.failed ?? [])],
        gaps: this.eventTrust?.gaps.length ?? 0,
        published: this.publishedEvents,
        lastError: this.eventStreamError,
      },
      scanCache: {
        enabled: !!this.scanCache,
        hits: this.scanCache?.stats.hits ?? 0,
        misses: this.scanCache?.stats.misses ?? 0,
        changed: this.scanCache?.stats.changed ?? 0,
        expired: this.scanCache?.stats.expired ?? 0,
        invalidated: this.scanCache?.stats.invalidated ?? false,
        warning: this.scanCacheWarning,
      },
    };
  }

  /**
   * 已经提示过「导入被跳过」的 rel（0.5.6）。
   * 这种跳过每轮都会发生（本机有同 id 会话就一直跳过），不记一下就变成每轮刷日志。
   */
  private importSkipWarned = new Set<string>();

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
    // 0.6.0 / 收尾①：canonical 只用于**远端命名空间**。宿主 dsh 认的是
    // `sessions/<cwd编码>/<sid>/...`，所以拉下来之前先折算回本机 rel。
    // 清单比对仍用 canonical rel，只有「落地路径」这一层做转换。
    let eff = rel;
    if (this.effectiveRelMode() === 'canonical' && isCanonicalSessionRel(rel)) {
      const mapped = canonicalRelToLocal(rel, this.canonicalCwdSegment());
      if (!mapped) throw new Error('无法把 canonical 会话 rel 落到本机：' + rel);
      eff = mapped;
    }
    // 0.5.9 纵深防御：远端清单已被 isSafeRel() 过滤，但所有本地读写最终都汇聚到
    // 这里，再加一道最小判据，防止将来新增的调用点绕过过滤把 `../` 写进文件系统。
    if (
      typeof eff !== 'string' || eff.length === 0 ||
      eff.startsWith('/') || eff.startsWith('\\') || eff.includes('\\') ||
      eff.includes('\0') || eff.split('/').some((s) => s === '..' || s === '.')
    ) {
      throw new Error('拒绝不安全的 rel：' + String(eff).slice(0, 120));
    }
    const hit = customFolderLocalOf(eff, this.deps.config.customFolders ?? []);
    if (hit) return hit.local;

    // 0.3.7：`workspaces/<名字>/<相对路径>` 的真实落点是注册表里该工作区的 path。
    // 手机上的工作区在 $DSH_HOME 之外（files/home/wstest），直接 localOf() 会算成
    // $DSH_HOME/workspaces/wstest/…，readFile ENOENT → 工作区文件从来没传成功过。
    const PREFIX = 'workspaces/';
    if (eff.startsWith(PREFIX)) {
      const rest = eff.slice(PREFIX.length);
      const slash = rest.indexOf('/');
      const name = slash < 0 ? rest : rest.slice(0, slash);
      const tail = slash < 0 ? '' : rest.slice(slash + 1);
      const dir = this.workspaceDirs.get(name);
      if (dir) return tail ? join(dir, ...tail.split('/')) : dir;
    }
    return localOf(eff);
  }

  /** 读注册表缓存「工作区目录名 → 真实路径」；同步/扫描前各刷一次。 */
  private loadWorkspaceDirs(): void {
    this.workspaceDirs.clear();
    this.workspaceCollisions = [];
    try {
      const raw = JSON.parse(readFileSync(join(dshHome(), 'storages', 'workspace.json'), 'utf8'));
      for (const w of Object.values<any>(raw?.tables?.workspaces ?? {})) {
        const p = String(w?.path ?? '');
        if (!p) continue;
        const name = safeName(p);
        if (!name) continue;
        // 0.6.0 收尾：同名不同路径的工作区会抢同一个 rel 前缀。
        // 0.5.9 这里直接 set(name, p)，后到的记录会**静默改写映射** ——
        // 结果是 A 工作区的上传被解析到 B 的目录，A 的文件永远传不上去，
        // 而且看清单完全正常。现在保留先到者（与 collectWorkspaceDirs 的
        // seenRel 语义一致），并把冲突记下来给状态面板/日志。
        const existing = this.workspaceDirs.get(name);
        if (existing !== undefined && existing !== p) {
          const rel = 'workspaces/' + name;
          const hit = this.workspaceCollisions.find((c) => c.rel === rel);
          if (hit) hit.paths.push(p);
          else this.workspaceCollisions.push({ rel, paths: [existing, p] });
          continue;
        }
        this.workspaceDirs.set(name, p);
      }
    } catch {
      /* 注册表读不到就退化成 localOf（和旧行为一致，不会更糟） */
    }
    if (this.workspaceCollisions.length > 0) {
      console.warn('[dsh-nas-sync] 工作区 rel 撞车，后到者已跳过（先到者优先）：'
        + this.workspaceCollisions.map((c) => c.rel + ' ← ' + c.paths.join(' | ')).join('；'));
    }
  }

  constructor(deps: EngineDeps) {
    this.deps = deps;
    this.sessionRelMode = (deps.config as NasSyncConfig & { sessionRelMode?: SessionRelMode })
      .sessionRelMode ?? 'legacy';
    // 0.6.0 / 收尾③：配置指纹决定整表失效，TTL 决定单条强制重算。
    if (deps.config.scanCacheEnabled !== false) {
      const loaded = loadScanCache();
      if (loaded.corrupted) {
        this.scanCacheWarning = '扫描缓存损坏，已按全量重算'
          + (loaded.quarantinedTo ? '（备份：' + loaded.quarantinedTo + '）' : '');
        console.warn('[dsh-nas-sync] ' + this.scanCacheWarning);
      }
      this.scanCache = new ScanCacheSession(loaded.data, {
        fingerprint: this.cachePolicyFingerprint(),
        ttlMs: Math.max(1, Number(deps.config.scanCacheTtlHours ?? 24)) * 3600_000
          || DEFAULT_SCAN_CACHE_TTL_MS,
      });
    }
    this.scanner = new Scanner({
      // 0.6.0 / 收尾①：canonical 模式把本机会话 rel 投影到 by-id 空间。
      // 闭包每次调用时读 effectiveRelMode()，所以「标记没读到自动降级」也生效。
      relProjector: (rel) => this.projectLocalRel(rel),
      // 0.6.0 / 收尾③：命中时跳过整份 readFile + sha256
      cache: this.scanCache,
      // r3：分类勾选决定同步哪些子树；includeSensitive 只管子树内部的凭据文件
      scope: deps.config.syncScope,
      includeSensitive: deps.config.includeSensitive,
      // 技能白名单（空 = 全部），只影响 skills/ 下的一级目录
      skillFilter: deps.config.skillFilter,
      // 自定义文件夹映射表：rel 里的名字 → 本机路径，全靠它
      customFolders: deps.config.customFolders,
      // 0.6.0 / P3：把可配置的文件大小上限真正传给扫描器（此前一直是 64 MiB 硬编码）
      maxFileBytes: deps.config.maxFileBytes,
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
    this.remoteManifestTrusted = false;
    this.manifestTrustFailed = [];
    let names: NasEntry[] = [];
    try {
      names = await this.deps.transport.list(MANIFESTS_DIR);
    } catch (err) {
      // NAS 掉线 / 目录不存在都走这里。0.5.9：不能当成「全新 NAS」就算了 ——
      // 「一份清单都没有」和「一份都没读到」必须区分，后者要禁用删除传播。
      console.warn('[dsh-nas-sync] 设备清单目录读取失败，本轮禁用删除传播：' + String(err));
      names = [];
    }
    // `_legacy.json` 只是「按设备拆分清单」之前那版**整份快照**，用途是迁移。
    // 一旦有了各设备自己的清单，它就是**永久过期**的：某台机器上一轮扫描到、
    // 之后删掉/改名的工作区会烂在里面，别的设备每轮都把它当「远端有、本地没有」
    // 去下载 → NAS 上 404 → 记一次错误 → 下一轮照旧，永远清不掉。
    const files = names.filter(
      (n) => n.type === 'file' && n.name.endsWith('.json') && n.name !== '_legacy.json'
        // 0.5.9：清单名来自远端目录列举，拼进 '/dsh/manifests/<name>' 之前
        // 先挡住分隔符与 '..'，避免被伪造的目录项把 GET 指到别的远端路径。
        && /^[A-Za-z0-9._-]+$/.test(n.name) && !n.name.includes('..'),
    );

    // 远端数据统一在这里过安全过滤：对端可能还在跑旧版扫描器（清单里列着
    // `.plugin-manager/logs/*` 与 `.bak` 副本），也可能被投喂了带 `../` 的 rel。
    const safeEntries = (list: ManifestEntry[]): ManifestEntry[] =>
      list.filter((e) => !!e && isSafeRel(e?.rel) && !isIgnoredRel(e.rel));

    if (files.length === 0) {
      // 一个设备清单都没有才回退到旧格式：先看已迁移的 _legacy.json，再看老路径。
      let legacy = await this.tryReadManifestAt(MANIFESTS_DIR + '/_legacy.json');
      if (legacy === null || legacy.length === 0) {
        // 0.5.9 复核修正：`??` 会把「读成了空数组」误当成「读成了有效内容」，
        // 不再回落老路径 —— 这是相对 0.5.8 的行为回归。空清单必须继续回落。
        legacy = await this.tryReadManifestAt(LEGACY_MANIFEST);
      }
      if (legacy === null || legacy.length === 0) {
        this.manifestTrustFailed = ['(没有读到任何设备清单，或旧格式清单读取失败)'];
        return [];
      }
      const cleaned = safeEntries(legacy);
      this.remoteManifestTrusted = true;
      try {
        await this.writeManifestFile(manifestFileOf('_legacy'), cleaned);
      } catch {
        /* 迁移失败只是每轮多读一次旧文件，不影响同步 */
      }
      return this.projectRemoteMerge(cleaned);
    }

    /**
     * 0.5.9 阻断级修复：0.5.8 用 `parts.length > 0` 判断「清单可信」，而
     * `readManifestAt()` 把解密失败/JSON 损坏一律吞成 `[]`，于是 3 份清单里
     * 坏 2 份、好 1 份时仍判可信 —— 那 2 份里的会话会被当成「对端删了」，
     * 两轮后回收本机会话数据。现在改成「每一份都必须读成」。
     */
    const reads: ManifestRead<ManifestEntry>[] = [];
    for (const f of files) {
      reads.push({ name: f.name, entries: await this.tryReadManifestAt(MANIFESTS_DIR + '/' + f.name) });
    }
    const trust = evaluateManifestTrust(reads);
    this.remoteManifestTrusted = trust.trusted;
    this.manifestTrustFailed = trust.failed;
    if (!trust.trusted) {
      console.warn(
        '[dsh-nas-sync] 本轮 ' + trust.failed.length + '/' + reads.length +
        ' 份设备清单读取失败，禁用删除传播：' + trust.failed.join(', '),
      );
    }
    // 空清单也要计入 parts：一台设备「确实一个条目都没有」是有效信息。
    const parts: ManifestEntry[][] = reads.flatMap((r) => (r.entries === null ? [] : [r.entries]));
    return this.projectRemoteMerge(safeEntries(mergeDeviceManifests(parts)));
  }

  /**
   * 严格版：解密单份清单。**读失败与「读成了空清单」是两种结果**（null vs []），
   * 只有 `readRemoteManifest()` 的删除传播判据能用它，别处不得拿 [] 当失败。
   */
  private async tryReadManifestAt(remote: string): Promise<ManifestEntry[] | null> {
    try {
      const enc = await this.deps.transport.getBuffer(remote);
      const plain = await Crypto.decrypt(enc, this.deps.config.passphrase);
      const list = JSON.parse(new TextDecoder().decode(plain));
      return Array.isArray(list) ? list : null;
    } catch {
      return null;
    }
  }

  /** 兼容旧调用点：读失败按空清单处理，**不可**用于删除传播判据。 */
  private async readManifestAt(remote: string): Promise<ManifestEntry[]> {
    return (await this.tryReadManifestAt(remote)) ?? [];
  }

  private async writeManifestFile(remote: string, entries: ManifestEntry[]): Promise<void> {
    const enc = await this.seal(new TextEncoder().encode(JSON.stringify(entries, null, 2)));
    await this.deps.transport.putBuffer(enc, remote, { mkdirs: true });
  }

  /**
   * 0.6.0 / 收尾②：所有上传密文的唯一出口。
   *
   * `envelopeVersion=1`（默认）写 NSS1，行为与 0.5.9 逐字节一致；`=2` 写 NSS2，
   * 并把稳定主键绑进 AAD。AAD 会写进头部，所以 decrypt() 不需要调用方推算 ——
   * 跨平台会话落地后 rel 变了也照样能解。清单用固定域 `manifest`，避免「同一份
   * 清单换了个文件名就解不开」。
   */
  private async seal(data: Uint8Array, rel?: string): Promise<Uint8Array> {
    const cfg = this.deps.config as NasSyncConfig & { envelopeVersion?: 1 | 2 };
    const version: 1 | 2 = cfg.envelopeVersion === 2 ? 2 : 1;
    const aad = 'dsh-nas-sync|' + (rel ? stableKeyOf(rel) : 'manifest');
    return Crypto.encrypt(data, cfg.passphrase, this.deps.store.salt(), { version, aad });
  }

  /**
   * 本机屏蔽一条会话：以后不再下载它，本地已有的副本在下一轮扫描时回收（0.5.8）。
   *
   * 落盘位置是 `$DSH_HOME/nas-sync/ignored-sessions.json`，不是 `store.json` ——
   * store 是运行中的进程整份重写的（每次 save 都覆盖），外部改不了；
   * 这个清单要让用户/脚本能直接编辑，所以单独一个文件。
   *
   * 0.6.0 / P1：语义从「只有本机不想要」升级为**全局屏蔽**。点击只记一条待发布
   * 意图，下一轮 sync 转成 ignore 事件，对端消费后写进它自己的屏蔽清单。
   * 存量屏蔽（升级前本机已有的 id）不会补发历史事件，所以升级不会突然删掉对端数据。
   */
  async ignoreSession(sid: string): Promise<void> {
    this.checkReady();
    const id = String(sid || '').trim();
    if (!id) return;
    this.ignoredFromFile.add(id);
    this.saveIgnoredFile();
    // 不在点击瞬间写 NAS：网络一断就把用户操作弄丢了。
    this.deps.store.pendingIntents.push({ op: 'ignore', sid: id });
    this.deps.store.pendingFiles = this.deps.store.pendingFiles.filter(
      (p) => this.sessionIdOfRel(p.rel) !== id,
    );
    this.deps.store.snapshot.pendingCount = this.deps.store.pendingFiles.length;
    this.deps.store.save();
  }

  /** `$DSH_HOME/nas-sync/ignored-sessions.json` 的路径。 */
  private ignoredFilePath(): string {
    return join(dshHome(), 'nas-sync', 'ignored-sessions.json');
  }

  /**
   * 读屏蔽清单（0.5.9 fail-closed）。
   *
   * 0.5.8 在 `try` 之前就 `this.ignoredFromFile = new Set()`，`catch` 又吞掉
   * JSON 解析错误 —— 用户把文件写坏一次，屏蔽就被静默撤销，撤掉的会话全部复活。
   * 现在：正常读 → 更新并刷新 last-known-good 备份；读坏 → 先备份原件、再尝试从
   * 备份恢复；连备份都没有 → 保留内存态、置错误位、**本轮禁用一切破坏性回收**。
   */
  private loadIgnoredFile(): void {
    const path = this.ignoredFilePath();
    const backupPath = path + '.bak';
    const main = readJsonFile<unknown>(path);
    const asSet = (v: unknown): Set<string> | null => {
      if (!Array.isArray(v)) return null;
      const s = new Set<string>();
      for (const x of v) if (typeof x === 'string' && x.trim()) s.add(x.trim());
      return s;
    };

    const fromMain = asSet(main.data);
    if (fromMain) {
      this.ignoredFromFile = fromMain;
      this.ignoredFileError = null;
      // 每轮扫描都会走到这里。内容没变就别反复刷 .bak（省一次写盘，也不让 mtime 抖动）
      const bak = readJsonFile<unknown>(backupPath).data;
      const same = Array.isArray(bak) && bak.length === fromMain.size
        && [...fromMain].every((id) => bak.includes(id));
      if (!same) writeBackup(path);
      return;
    }

    // 主文件不存在（首次运行 / 被误删）：有备份就自动恢复，没有才是合法的空清单
    if (main.missing && !main.corrupted) {
      const fromBak = asSet(readJsonFile<unknown>(backupPath).data);
      if (fromBak) {
        this.ignoredFromFile = fromBak;
        this.ignoredFileError = '屏蔽清单主文件缺失，已从 .bak 自动恢复';
        console.warn('[dsh-nas-sync] ' + this.ignoredFileError);
        this.saveIgnoredFile();
        return;
      }
      this.ignoredFromFile = new Set<string>();
      this.ignoredFileError = null;
      return;
    }

    // 损坏 / 不是数组：优先从备份恢复，并把坏文件留证
    const fromBak = asSet(readJsonFile<unknown>(backupPath).data);
    if (fromBak) {
      this.ignoredFromFile = fromBak;
      this.ignoredFileError = '屏蔽清单损坏，已从 .bak 恢复；原件备份在 '
        + (main.quarantinedTo ?? '(备份失败)');
      console.error('[dsh-nas-sync] ' + this.ignoredFileError);
      try { writeJsonAtomic(path, [...fromBak].sort()); } catch { /* 下轮再试 */ }
      return;
    }
    // 无可用备份：不清空、不猜测，直接把本轮标记为不可做破坏性动作
    this.ignoredFileError = '屏蔽清单损坏且无可用备份，本轮已禁用删除传播：'
      + (main.quarantinedTo ?? '(备份失败)');
    console.error('[dsh-nas-sync] ' + this.ignoredFileError);
  }

  private saveIgnoredFile(): void {
    try {
      const path = this.ignoredFilePath();
      // 原子写，避免进程被杀时留下半截 JSON（这正是上面要防的损坏来源）
      writeJsonAtomic(path, [...this.ignoredFromFile].sort());
      writeBackup(path);
    } catch (err) {
      this.ignoredFileError = '屏蔽清单写入失败：' + String(err);
      console.error('[dsh-nas-sync] ' + this.ignoredFileError);
    }
  }

  /** 列出本机屏蔽的会话 id（只读，0.5.9 让这个能力对用户可见）。 */
  listIgnoredSessions(): { ids: string[]; error: string | null } {
    this.loadIgnoredFile();
    return { ids: [...this.ignoredFromFile].sort(), error: this.ignoredFileError };
  }

  /** 撤销屏蔽：这条会话下一轮又能从对端同步回来（0.5.9，让屏蔽可撤销）。 */
  unignoreSession(sid: string): boolean {
    const id = String(sid || '').trim();
    if (!id) return false;
    this.loadIgnoredFile();
    if (!this.ignoredFromFile.delete(id)) return false;
    this.saveIgnoredFile();
    // 0.6.0 / P1：撤销同样要广播，否则对端会一直屏蔽着这条会话
    this.deps.store.pendingIntents.push({ op: 'unignore', sid: id });
    this.deps.store.save();
    return true;
  }

  /** rel 形如 `sessions/<cwd编码>/<sessionId>/session.v<N>.jsonl.zstd`。 */
  private sessionIdOfRel(rel: string): string | null {
    const parts = String(rel || '').split('/');
    if (parts.length < 4 || parts[0] !== 'sessions') return null;
    return parts[parts.length - 2] || null;
  }

  /**
   * 这个 rel 是不是被本机屏蔽了（0.5.8）。
   *
   * 按**会话 id** 判，不按 rel：同一条会话在 NAS 上可能有两份 rel ——
   * 手机原文那份（`sessions/--data-user-…`）和本机镜像曾被误传上去的那份
   * （`sessions/--C-Users-…`）。按 rel 记会漏掉另一半，会话照样被拉回来。
   */
  private isImportIgnored(rel: string): boolean {
    const sid = this.sessionIdOfRel(rel);
    if (!sid) return false;
    return this.ignoredFromFile.has(sid);
  }

  /**
   * 去掉「导入镜像」条目，这些 rel 不该出现在本机清单里（0.5.8）。
   *
   * 镜像的字节和远端原文永远不同（cwd 被改写），却又是本机扫描能扫到的真实文件；
   * 一旦被写进本机清单，就等于对全世界宣布「我这里还有一份」，对端每轮都会去下
   * 一个语义上完全等价、只是路径不同的 579 KB，白白来回。
   */
  private withoutMirrors(fresh: ManifestEntry[]): ManifestEntry[] {
    const imports = this.deps.store.sessionImports ?? {};
    const mirrors = new Set(Object.values(imports).map((r) => r.localRel));
    if (mirrors.size === 0) return fresh;
    return fresh.filter((e) => !mirrors.has(e.rel));
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
    // 0.6.0 / 收尾①：shadow 双写（主链仍 legacy）、canonical 只写新空间。
    // ownManifestEntries() 必须先算完再投影，否则 pushedOk 里的老 rel 会全部对不上。
    const mode = this.effectiveRelMode();
    let toWrite = own;
    if (mode === 'shadow') {
      toWrite = rewriteManifestForMode(own, 'shadow', planRelMigration(own));
    } else if (mode === 'canonical') {
      toWrite = own.map((item) => ({ ...item, rel: this.projectLocalRel(item.rel) }));
    }
    await this.writeManifestFile(remote, toWrite);
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
      const enc = await this.seal(plain, rel);
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

  // ==========================================================================
  // 0.6.0 / P1：事件驱动删除传播
  // --------------------------------------------------------------------------
  // 0.5.9 靠「远端清单里这条连续两轮消失」推断删除，只覆盖跨平台会话镜像。
  // 现在改成显式事件：每台设备只追加自己的日志分片，读端合并回放生成墓碑，
  // 所有分类（附件/技能/工作区文件/会话）共用同一条删除链路。
  //
  // 三条硬纪律：
  //   · 事件流不完整（读失败 / 签名坏 / seq 缺口）→ 整轮禁止按事件删本地文件；
  //   · 本机「消失」要过 computeLocalDeletes 的六道闸才敢发 delete 事件；
  //   · 删除一律「移进回收站」，远端对象保留 retentionDays 天后才由 GC 真删。
  // ==========================================================================

  /** 读远端纯文本；不存在返回空串（仅用于可重建的事件/墓碑文件）。 */
  private async readTextRemote(remote: string): Promise<string> {
    try {
      return new TextDecoder().decode(await this.deps.transport.getBuffer(remote));
    } catch {
      return '';
    }
  }

  /** 读全局事件流：列每台设备的分片、逐片解析、校验完整性、回放墓碑。 */
  private async readEventStream(): Promise<void> {
    /**
     * 同一轮同步里这个函数会被调用两次：`sync()` 开头一次（供注册表剔除用，
     * 注册表必须在本轮扫描**之前**合并），`scanOnce()` 里再一次（供删除判定用）。
     * 十秒内的重复调用直接复用上次结果，免得每轮多一次 NAS 往返。
     */
    if (this.eventTrust && Date.now() - this.eventStreamFreshAt < 10_000) return;
    const t = this.deps.transport;
    this.eventStream = [];
    this.eventTrust = null;
    this.tombstones = [];
    this.eventStreamError = null;
    const reads: EventLogRead[] = [];

    let devices: NasEntry[] = [];
    try {
      devices = await t.list(EVENTS_DIR);
    } catch {
      // 升级后的首轮常态是「/dsh/events 还不存在」。建一次再列；
      // 仍然失败（NAS 掉线 / 无权限）必须判不可信，不能当成空流。
      try {
        await t.mkdir(EVENTS_DIR);
        devices = await t.list(EVENTS_DIR);
      } catch {
        reads.push({ name: EVENTS_DIR, events: null });
      }
    }

    for (const d of devices) {
      if (d.type !== 'dir') continue;
      // 目录名来自远端列举，拼进路径前先挡住分隔符与 '..'
      if (!/^[A-Za-z0-9._-]+$/.test(d.name) || d.name.includes('..')) continue;
      const dir = EVENTS_DIR + '/' + d.name;
      let shards: NasEntry[] = [];
      try {
        shards = await t.list(dir);
      } catch {
        reads.push({ name: dir, events: null });
        continue;
      }
      const files = shards
        .filter((s) => s.type === 'file' && /^\d{6}\.jsonl$/.test(s.name))
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const s of files) {
        const remote = dir + '/' + s.name;
        try {
          const buf = await t.getBuffer(remote);
          const parsed = parseEventLog(new TextDecoder().decode(buf));
          // 坏行 = 读失败，不是「读成了空日志」（0.5.9 在这里踩过坑）
          reads.push({ name: remote, events: parsed.corrupted ? null : parsed.events });
        } catch {
          reads.push({ name: remote, events: null });
        }
      }
    }

    const trust = validateEventStream(reads);
    this.eventTrust = trust;
    this.eventStream = mergeEventLogs(reads.flatMap((r) => (r.events ? [r.events] : [])));
    if (!trust.trusted) {
      this.eventStreamError = eventStreamAllowsDeletes(trust).reason;
      console.warn('[dsh-nas-sync] 事件流不完整，本轮禁用事件驱动删除：' + this.eventStreamError);
    }
    this.tombstones = buildTombstones(this.eventStream, {
      retentionDays: normalizeRetentionDays(this.deps.config.retentionDays),
    });
    this.eventStreamFreshAt = Date.now();
  }

  /** 追加本机事件到自己的分片。CAS 保护同一分片被两个进程同时写。 */
  private async appendLocalEvents(newEvents: SyncEvent[]): Promise<void> {
    if (newEvents.length === 0) return;
    const t = this.deps.transport;
    const device = selfDevice();
    const byShard = new Map<number, SyncEvent[]>();
    for (const e of newEvents) {
      const sh = eventShardOf(e.seq);
      const arr = byShard.get(sh) ?? [];
      arr.push(e);
      byShard.set(sh, arr);
    }
    for (const [sh, evts] of byShard) {
      const remote = eventLogFileOf(device, sh);
      const existing = parseEventLog(await this.readTextRemote(remote));
      if (existing.corrupted) {
        // 分片坏了绝不覆盖 —— 那会毁掉历史删除证据。宁可本轮不写。
        console.warn('[dsh-nas-sync] 事件分片损坏，跳过写入以免覆盖历史：' + remote);
        continue;
      }
      const writeMerged = async (list: SyncEvent[]): Promise<boolean> => {
        const data = new TextEncoder().encode(serializeEventLog(list));
        if (t.putIfMatch) {
          const etag = t.etag ? await t.etag(remote) : null;
          return (await t.putIfMatch(data, remote, etag, { mkdirs: true })).ok;
        }
        await t.putBuffer(data, remote, { mkdirs: true });
        return true;
      };
      if (await writeMerged(mergeEventLogs([existing.events, evts]))) continue;
      // 冲突：重读一次合并再试；仍冲突就抛错，让下一轮重放，绝不盲目覆盖
      const again = parseEventLog(await this.readTextRemote(remote));
      if (!(await writeMerged(mergeEventLogs([again.events, evts])))) {
        throw new Error('事件分片写入冲突：' + remote);
      }
    }
  }

  /** 写墓碑总表（共享文件，CAS 冲突时读回对方的表合并再写）。 */
  private async writeTombstones(): Promise<void> {
    const t = this.deps.transport;
    const write = async (list: Tombstone[]): Promise<boolean> => {
      const data = new TextEncoder().encode(
        JSON.stringify({ tombstones: list, updatedAt: Date.now() }, null, 2),
      );
      if (t.putIfMatch) {
        const etag = t.etag ? await t.etag(TOMBSTONES_FILE) : null;
        return (await t.putIfMatch(data, TOMBSTONES_FILE, etag, { mkdirs: true })).ok;
      }
      await t.putBuffer(data, TOMBSTONES_FILE, { mkdirs: true });
      return true;
    };
    if (await write(this.tombstones)) return;
    let remote: Tombstone[] = [];
    try {
      const parsed = JSON.parse(await this.readTextRemote(TOMBSTONES_FILE));
      if (Array.isArray(parsed?.tombstones)) remote = parsed.tombstones;
    } catch { /* 读不回就只报警，事件流本身可重建 */ }
    if (!(await write(mergeTombstones(remote, this.tombstones)))) {
      // 墓碑总表是缓存，丢了可由事件流重建；不抛错，不让整轮同步判失败
      console.warn('[dsh-nas-sync] 墓碑总表写入冲突（可由事件流重建，不丢数据）');
    }
  }

  /** 写本机位点并持久化，避免重启后重复回放历史 delete 事件。 */
  private async writeCursors(events: SyncEvent[]): Promise<void> {
    const t = this.deps.transport;
    const devices = new Set(events.map((e) => e.device));
    devices.add(selfDevice());
    const cursors: DeviceCursor[] = [];
    let changed = false;
    for (const device of devices) {
      const prev: DeviceCursor = {
        device,
        appliedSeq: this.deps.store.deviceCursors[device] ?? 0,
        updatedAt: 0,
      };
      const next = advanceCursor(prev, events, device);
      cursors.push(next);
      if (next.appliedSeq !== prev.appliedSeq) {
        this.deps.store.deviceCursors[device] = next.appliedSeq;
        changed = true;
      }
    }
    // 位点没推进就别写盘：每轮同步都会走到这里，无谓写只会刷 mtime
    if (!changed) return;
    await t.putBuffer(
      new TextEncoder().encode(JSON.stringify(cursors, null, 2)),
      cursorFileOf(selfDevice()),
      { mkdirs: true },
    );
    this.deps.store.save();
  }

  /** 通用回收：把单个本地文件搬进 removed/ 并写 meta（会话走 retireLocalSession）。 */
  private async retireGeneric(rel: string, reason: string): Promise<string> {
    if (!isSafeRel(rel)) throw new Error('拒绝回收不安全的 rel：' + String(rel).slice(0, 120));
    const abs = this.resolveLocal(rel);
    if (!existsSync(abs)) return '';
    const batch = join(this.removedRoot(), new Date().toISOString().replace(/[:.]/g, '-'));
    const trash = join(batch, rel.replace(/\//g, '__'));
    await mkdir(batch, { recursive: true });
    try {
      await rename(abs, trash);
    } catch {
      await cp(abs, trash, { recursive: true });
      await rm(abs, { recursive: true, force: true });
    }
    try {
      writeJsonAtomic(trash + '.meta.json', {
        rel, retiredAt: new Date().toISOString(), reason, trashPath: trash,
      });
    } catch { /* 元数据失败不影响「文件已搬走」这个事实 */ }
    return trash;
  }

  /** 消费对端 delete / ignore 事件，把本地对应内容移进回收站。 */
  private async applyRemoteDeletes(local: ManifestEntry[]): Promise<ManifestEntry[]> {
    const gate = eventStreamAllowsDeletes(this.eventTrust);
    if (!gate.allowed) {
      if (gate.reason) console.warn('[dsh-nas-sync] 跳过事件删除消费：' + gate.reason);
      return local;
    }
    // 屏蔽清单读坏时连「按事件搬文件」都不做：判据不可信，宁可这轮不收敛
    if (this.ignoredFileError !== null) return local;

    const self = selfDevice();
    const cursors: DeviceCursor[] = Object.entries(this.deps.store.deviceCursors)
      .map(([device, appliedSeq]) => ({ device, appliedSeq, updatedAt: 0 }));
    const freshEvents = eventsSince(this.eventStream, cursors).filter((e) => e.device !== self);
    if (freshEvents.length === 0) return local;

    let out = local;
    const removed = new Set<string>();
    for (const e of freshEvents) {
      if (e.op === 'delete') {
        const tomb = this.tombstones.find((x) => x.key === e.key);
        if (!tomb) continue;
        const { rels, sid } = tombstoneTargets(tomb);
        const targets = out.filter(
          (x) => rels.includes(x.rel) || (!!sid && this.sessionIdOfRel(x.rel) === sid),
        );
        for (const target of targets) {
          if (removed.has(target.rel)) continue;
          try {
            if (this.isSessionBodyRel(target.rel)) {
              await this.retireLocalSession(target.rel, { reason: 'event-delete:' + e.device });
            } else {
              await this.retireGeneric(target.rel, 'event-delete:' + e.device);
            }
            removed.add(target.rel);
          } catch (err) {
            console.warn('[dsh-nas-sync] 按事件回收失败（下轮再试）：' + target.rel + ' · ' + String(err));
          }
        }
      } else if (e.op === 'ignore' || e.op === 'unignore') {
        const sid = e.key.startsWith('session:') ? e.key.slice(8) : '';
        if (!sid) continue;
        if (e.op === 'ignore') this.ignoredFromFile.add(sid);
        else this.ignoredFromFile.delete(sid);
        this.saveIgnoredFile();
      }
    }
    if (removed.size > 0) {
      // 镜像账一并销掉：不销的话下一轮扫描会把已回收的副本当「本机新文件」传回去
      for (const [remoteRel, rec] of Object.entries(this.deps.store.sessionImports)) {
        if (removed.has(rec.localRel)) delete this.deps.store.sessionImports[remoteRel];
      }
      out = out.filter((x) => !removed.has(x.rel));
      this.deps.store.save();
      console.log('[dsh-nas-sync] 按对端删除事件回收 ' + removed.size + ' 个本地文件（可从回收站恢复）');
    }
    return out;
  }

  /** 收尾发布本机事件：上传成功 → upsert；确认删除 → delete；屏蔽操作 → ignore/unignore。 */
  private async publishEvents(fresh: ManifestEntry[], baseline: ManifestEntry[]): Promise<void> {
    const device = selfDevice();
    const ts = Date.now();
    let seq = nextLocalSeq(this.eventStream, device);
    const out: SyncEvent[] = [];
    const retentionDays = normalizeRetentionDays(this.deps.config.retentionDays);

    for (const rel of this.pushedOk) {
      const e = fresh.find((x) => x.rel === rel);
      if (!e || !isSafeRel(rel)) continue;
      out.push(makeEvent({
        device, seq: seq++, ts, key: stableKeyOf(rel), rel, hash: e.hash,
        op: 'upsert', category: rel.split('/')[0],
      }));
    }

    // 排除镜像与本机屏蔽会话：它们的本地副本被搬走是**同步策略**造成的，
    // 不是用户删除，绝不能据此发 delete 事件把对端也删掉。
    const excluded = new Set<string>(
      Object.values(this.deps.store.sessionImports ?? {}).map((r) => r.localRel),
    );
    for (const e of baseline) {
      const sid = this.sessionIdOfRel(e.rel);
      if (sid && this.ignoredFromFile.has(sid)) excluded.add(e.rel);
    }
    // DSH 回收站是**明确的用户删除**，优先级必须高于上面的镜像排除：
    // 跨平台同步过来的会话在 sessionImports 里有 localRel，若不同时放行，
    // delete 事件永远发不出去（真机实测：手机识别到 5 条回收站会话、发出 0 条事件）。
    //
    // 0.6.0 / 收尾②：必须按 **sid** 放行，不能按 `<cwd编码>/<sid>`。
    // 排除集合里是「本机 rel」，而回收站记录里的编码来自**删除方**（可能是另一台
    // 设备同步下来的），两端 cwd 编码永远不等 → 原来这段放行对镜像会话恒为 false。
    try {
      const trashedIds = await listTrashedSessionIds();
      if (trashedIds.size > 0) {
        for (const rel of [...excluded]) {
          const sid = this.sessionIdOfRel(rel);
          if (sid && trashedIds.has(sid)) excluded.delete(rel);
        }
      }
    } catch { /* 回收站读不到就保持原行为，宁可少删 */ }
    // 0.6.2：把「有确凿证据」的条目挑出来 —— 本地 DSH 回收站里就有这条会话的记录。
    // 它们不该受条数/比例上限约束：一台只有一两条会话的设备，删掉唯一那条时
    // 消失比例是 100%，会被比例闸永久拦住（真机复现过这个死角）。
    let explicit: Set<string> | undefined;
    try {
      const trashed = await listTrashedSessionIds();
      if (trashed.size > 0) {
        explicit = new Set(
          baseline
            .filter((e) => {
              const sid = this.sessionIdOfRel(e.rel);
              return !!sid && trashed.has(sid);
            })
            .map((e) => e.rel),
        );
      }
    } catch {
      /* 回收站读不到就没有确凿证据，退回原来的推断闸（宁可不删） */
    }

    const decision = computeLocalDeletes({
      baseline,
      fresh,
      explicit,
      enabledPrefixes: SYNC_CATEGORIES
        .filter((c) => this.deps.config.syncScope[c.key])
        .map((c) => c.localDir),
      eventTrusted: this.eventTrust?.trusted ?? false,
      manifestTrusted: this.remoteManifestTrusted,
      excluded,
      isIgnorable: isIgnoredRel,
    });
    if (decision.blocked) {
      console.warn('[dsh-nas-sync] 本轮不产生删除事件：' + decision.reason);
    } else {
      for (const rel of decision.rels) {
        out.push(makeEvent({
          device, seq: seq++, ts, key: stableKeyOf(rel), rel,
          op: 'delete', retentionDays,
        }));
      }
    }

    for (const intent of this.deps.store.pendingIntents ?? []) {
      out.push(makeEvent({
        device, seq: seq++, ts, key: 'session:' + intent.sid,
        op: intent.op, category: 'sessions',
      }));
    }

    if (out.length === 0) {
      // 即使本机这轮没发任何事件，也必须推进位点 —— 否则对端已有的 delete/ignore
      // 事件会被每轮重复回放（回收是幂等的，但 ignore 会反复写屏蔽清单文件）。
      await this.writeCursors(this.eventStream);
      return;
    }
    await this.appendLocalEvents(out);
    this.deps.store.pendingIntents = [];
    this.eventStream = mergeEventLogs([this.eventStream, out]);
    this.tombstones = buildTombstones(this.eventStream, { retentionDays });
    await this.writeTombstones();
    await this.writeCursors(this.eventStream);
    this.publishedEvents = out.length;
  }

  /** 过期墓碑 GC：保留期内一律不动，到期才真删远端对象与分块残块。 */
  private async gcRemoteObjects(): Promise<void> {
    const t = this.deps.transport;
    const expired = collectGc(this.tombstones);
    if (expired.length === 0) return;
    // 0.6.0 / 收尾①：迁移保留期内，legacy 会话对象是唯一的回滚副本，绝不 GC。
    await this.ensureMigrationMarker();
    const legacyHold = legacyProtected(this.migrationMarker);
    let n = 0;
    for (const tomb of expired) {
      for (const rel of tombstoneTargets(tomb).rels) {
        if (legacyHold && isLegacySessionRel(rel)) continue;
        const remote = '/dsh/' + rel;
        try {
          if (t.deleteTree) await t.deleteTree(remote);
          else await t.delete(remote);
          await t.delete(remote + '.chunk-manifest.json').catch(() => {});
          // 分块残块按序号找；连续两个不存在就认为后面没有了
          let miss = 0;
          for (let i = 0; i < 64 && miss < 2; i++) {
            const part = remote + '.part' + String(i).padStart(4, '0');
            const st = await t.stat(part).catch(() => null);
            if (!st) { miss++; continue; }
            miss = 0;
            await t.delete(part);
          }
          n++;
        } catch (err) {
          console.warn('[dsh-nas-sync] GC 远端对象失败（下轮再试）：' + rel + ' · ' + String(err));
        }
      }
    }
    if (n > 0) console.log('[dsh-nas-sync] 已清理过期回收对象 ' + n + ' 个');
  }

  // ---- 0.6.0 / 收尾④：插件包体 CAS ----

  /** 读装配清单（按 name@version 聚合，每个平台各自的对象指纹）。 */
  async pluginAssemblies(): Promise<PluginAssembly[]> {
    try {
      const raw = await this.readTextRemote(PLUGIN_ASSEMBLIES_FILE);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed?.assemblies)) return [];
      return mergeAssemblies([parsed.assemblies]);
    } catch {
      return [];
    }
  }

  /** 按内容指纹取一个对象；指纹非法 / 对象不存在都返回 null。 */
  async pluginObject(hash: string): Promise<Uint8Array | null> {
    const h = String(hash || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(h)) return null;
    try {
      return await this.deps.transport.getBuffer(pluginObjectPath(h));
    } catch {
      return null;
    }
  }

  /**
   * 发布一个本机平台可用的插件包体（通常是 `pnpm pack` 产出的 .tgz）：
   * 校验 tgz → 按 sha256 写进 CAS → 用 CAS 更新装配清单。
   * 对象一旦存在就不重写（内容地址天然幂等），并发写清单冲突时重读重试。
   */
  async publishPluginObject(input: {
    name: string; version: string; tgzPath: string;
  }): Promise<{
    record: PluginObjectRecord; objectPath: string; assemblies: number;
    entries: number; rejected: number; objectExisted: boolean;
  }> {
    this.checkReady();
    const name = String(input?.name || '').trim();
    const version = String(input?.version || '').trim() || '0.0.0';
    const tgzPath = String(input?.tgzPath || '').trim();
    if (!name || !/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) {
      throw new Error('插件包名非法：' + name);
    }
    if (!tgzPath) throw new Error('缺少 tgzPath（本机 .tgz 文件路径）');
    const data = new Uint8Array(await readFile(tgzPath));
    if (data.length === 0) throw new Error('空的 .tgz 文件');
    const max = 128 * 1024 * 1024;
    if (data.length > max) throw new Error('.tgz 超过 128 MiB 上限');
    // 发布前先完整解一次：坏包 / 越界路径绝不能进 CAS 让别人踩
    let checked;
    try {
      checked = unpackTgz(data, { maxEntryBytes: max, maxTotalBytes: max });
    } catch (err) {
      throw new Error('拒绝发布（.tgz 校验失败）：' + String(err));
    }
    if (checked.entries.length === 0) throw new Error('拒绝发布：包体里没有可用文件');

    const t = this.deps.transport;
    const hash = sha256Hex(data);
    const path = pluginObjectPath(hash);
    let existed = false;
    try { existed = !!(await t.stat(path)); } catch { /* 不存在 */ }
    if (!existed) await t.putBuffer(data, path, { mkdirs: true });

    const target = currentTarget();
    const record: PluginObjectRecord = {
      name, version, target,
      objectHash: hash, size: data.length, device: selfDevice(),
    };
    const write = async (): Promise<PluginAssembly[] | null> => {
      const cur = await this.pluginAssemblies();
      const next = mergeAssemblies([cur, buildAssemblies([record])]);
      const bytes = new TextEncoder().encode(
        JSON.stringify({ assemblies: next, updatedAt: Date.now() }, null, 2),
      );
      if (t.putIfMatch && t.etag) {
        const etag = await t.etag(PLUGIN_ASSEMBLIES_FILE);
        const r = await t.putIfMatch(bytes, PLUGIN_ASSEMBLIES_FILE, etag, { mkdirs: true });
        return r.ok ? next : null;
      }
      await t.putBuffer(bytes, PLUGIN_ASSEMBLIES_FILE, { mkdirs: true });
      return next;
    };
    let merged: PluginAssembly[] | null = null;
    for (let i = 0; i < 3 && !merged; i++) merged = await write();
    if (!merged) throw new Error('装配清单并发冲突，重试 3 次仍失败（对象已写入，可重跑）');

    return {
      record, objectPath: path, assemblies: merged.length,
      entries: checked.entries.length, rejected: checked.rejected.length,
      objectExisted: existed,
    };
  }

  // ---- 0.6.0 / P2：会话稳定 ID 映射账本 ----
  //
  // 会话目录名是 cwd 编码，所以同一会话在电脑和手机上的 rel **永远不相等**。
  // 0.5.9 用 `sessionImports` 在本机记「远端原文 rel → 本地镜像 rel」，但那份账只在本机，
  // 第三台设备加入时无从得知哪个 sid 对应哪条 rel。这里把映射按 sid 汇总到远端，
  // 为将来切到 canonical rel（`sessions/by-id/<sid>/v<N>`）准备好可迁移的账本。
  //
  // 本轮**不切换主 rel 空间**：线上 0.5.9 的 105+ 条存量 rel 一旦换主键，需要一次
  // 全量重写 + 双端停机窗口，硬塞进同一轮会把正在同步的数据弄坏。

  private async readBidMap(): Promise<BidMapEntry[]> {
    try {
      const parsed = JSON.parse(await this.readTextRemote(BIDMAP_FILE));
      return Array.isArray(parsed?.entries) ? mergeBidMaps([parsed.entries]) : [];
    } catch {
      return [];
    }
  }

  private async publishBidMap(): Promise<void> {
    const t = this.deps.transport;
    const own: BidMapEntry[] = [];
    for (const [remoteRel, rec] of Object.entries(this.deps.store.sessionImports ?? {})) {
      const sid = this.sessionIdOfRel(rec.localRel) ?? this.sessionIdOfRel(remoteRel);
      if (!sid || !isSafeRel(rec.localRel)) continue;
      own.push({
        sid,
        canonicalRel: canonicalSessionRel(sid, 1),
        localRel: rec.localRel,
        originalCwd: rec.originalCwd,
        version: 1,
      });
    }
    if (own.length === 0) return;

    const write = async (entries: BidMapEntry[]): Promise<boolean> => {
      const data = new TextEncoder().encode(
        JSON.stringify({ entries, updatedAt: Date.now() }, null, 2),
      );
      if (t.putIfMatch) {
        const etag = t.etag ? await t.etag(BIDMAP_FILE) : null;
        return (await t.putIfMatch(data, BIDMAP_FILE, etag, { mkdirs: true })).ok;
      }
      await t.putBuffer(data, BIDMAP_FILE, { mkdirs: true });
      return true;
    };
    if (await write(mergeBidMaps([await this.readBidMap(), own]))) return;
    // 冲突：重读再合并。bidmap 是按 sid 幂等归并的，重复写不会丢条目。
    await write(mergeBidMaps([await this.readBidMap(), own]));
  }

  /** 面板/工具：查看会话稳定 ID ↔ 各端 rel 的映射账本。 */
  async bidMap(): Promise<{ entries: BidMapEntry[]; count: number }> {
    const entries = await this.readBidMap();
    return { entries, count: entries.length };
  }

  // -------------------------------------------------------------------------
  // 0.6.0 / 收尾①：会话 rel 空间迁移
  // -------------------------------------------------------------------------

  /** 读迁移标记（明文 JSON，只有计数与时间戳，无敏感数据）。 */
  private async ensureMigrationMarker(): Promise<void> {
    if (this.migrationMarker) return;
    try {
      const raw = await this.readTextRemote(MIGRATION_MARKER_PATH);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version === 1 && Number.isFinite(parsed.completedAt)) {
        this.migrationMarker = parsed as MigrationMarker;
      }
    } catch {
      // 不存在 / 损坏都按「尚未迁移」处理：canonical 会自动降级成 legacy，
      // 绝不在标记缺失时把主链切到新空间（fail-closed）。
    }
  }

  /**
   * 生效模式。配置写了 canonical 但迁移标记不存在时降级 legacy，
   * 避免「手滑改了配置，下一轮所有会话 rel 全变、存量对象全找不到」。
   */
  /** 影响「哪些文件进清单 / 清单里叫什么」的配置指纹（0.6.0 / 收尾③）。 */
  private cachePolicyFingerprint(): string {
    const c = this.deps.config as NasSyncConfig & { sessionRelMode?: SessionRelMode };
    return configFingerprint({
      scope: c.syncScope ?? {},
      includeSensitive: !!c.includeSensitive,
      skillFilter: c.skillFilter ?? [],
      customFolders: c.customFolders ?? [],
      maxFileBytes: Number(c.maxFileBytes) || 0,
      sessionRelMode: this.sessionRelMode,
    });
  }

  private effectiveRelMode(): SessionRelMode {
    if (this.sessionRelMode === 'canonical' && !this.migrationMarker) return 'legacy';
    return this.sessionRelMode;
  }

  /** 本机会话 rel → 写进远端清单的 rel（canonical 模式才投影）。 */
  private projectLocalRel(rel: string): string {
    if (this.effectiveRelMode() !== 'canonical') return rel;
    if (isLegacySessionRel(rel)) return legacyRelToCanonical(rel, 1) ?? rel;
    return rel;
  }

  /**
   * canonical 远端 rel 落到本机时的 cwd 编码段。
   * 优先用已知的本机会话落地记录，其次工作区注册表，最后 DSH home 兜底。
   */
  private canonicalCwdSegment(): string {
    for (const rec of Object.values(this.deps.store.sessionImports ?? {})) {
      const parts = String(rec?.localRel || '').split('/');
      if (parts[0] === 'sessions' && parts[1]) return safeCwdSegment(parts[1]);
    }
    for (const dir of this.workspaceDirs.values()) {
      if (dir) return safeCwdSegment(encodeCwd(dir));
    }
    return safeCwdSegment(encodeCwd(dshHome()));
  }

  private isSessionBodyRel(rel: string): boolean {
    return isSessionRel(rel) || isCanonicalSessionRel(rel);
  }

  /**
   * 把「已在 DSH 回收站里」的会话从清单里剔除（0.6.2）。
   *
   * 为什么必须**两处都过这道闸**：扫描（scanOnce）决定本轮上传什么，发布
   * （publishEvents）决定本轮发什么 delete 事件 —— 而后者会**再调一次**
   * `scanner.buildManifest()` 拿 `fresh`。0.6.1 只在扫描那处剔了，`fresh` 里
   * 被删的会话依旧「还在」，`computeLocalDeletes` 算不出差异，delete 事件
   * 永远发不出去。真机实测：手机识别到 7 条回收站会话、发出 0 条事件。
   *
   * 判据是 **sid**，不是 `<cwd编码>/<sid>`：回收站目录名里的编码属于执行删除
   * 的设备，两端 cwd 编码必然不同，拼出来的键永远不相等。
   */
  private async stripTrashed(list: ManifestEntry[]): Promise<ManifestEntry[]> {
    let trashed: Set<string>;
    try {
      trashed = await listTrashedSessionIds();
    } catch (err) {
      // 回收站读不到不影响主流程：最多是这一轮仍按「文件还在」处理
      console.warn('[dsh-nas-sync] 读取 DSH 回收站失败，本轮不按隐藏处理：' + String(err));
      return list;
    }
    if (trashed.size === 0) return list;
    const out = list.filter((e) => {
      if (!this.isSessionBodyRel(e.rel)) return true;
      const sid = this.sessionIdOfRel(e.rel);
      return !(sid && trashed.has(sid));
    });
    const hidden = list.length - out.length;
    if (hidden > 0) {
      console.warn('[dsh-nas-sync] ' + hidden + ' 条会话在 DSH 回收站里（侧栏已隐藏），本轮按已删除处理');
    }
    return out;
  }

  /**
   * 查跨平台会话镜像账。canonical 模式下远端原文 rel 变了，但账本还是按老 rel
   * 记的（迁移不改本机 Store）；按 sid 兜底找一次，避免镜像被误判成「本机已有
   * 同 id 会话」而永远不更新。legacy 模式直接命中，行为不变。
   */
  private importRecordFor(rel: string): SessionImportRecord | undefined {
    const imports = this.deps.store.sessionImports ?? {};
    const direct = imports[rel];
    if (direct) return direct;
    const sid = sessionIdFromRel(rel);
    if (!sid) return undefined;
    for (const [key, rec] of Object.entries(imports)) {
      if (sessionIdFromRel(key) === sid || sessionIdFromRel(rec?.localRel ?? '') === sid) return rec;
    }
    return undefined;
  }

  /**
   * 读侧双空间归并：NAS 上同时有 legacy 与 canonical 两份时按 sid 合成一份视图，
   * 避免同一会话被计数两次、也避免「只删了一个空间」时删除判不出来。
   * 只有 legacy 条目时（默认线上形态）原样返回，行为逐字节不变。
   */
  private projectRemoteMerge(entries: ManifestEntry[]): ManifestEntry[] {
    if (!entries.some((e) => isCanonicalSessionRel(e.rel))) return entries;
    const merged = mergeDualRead(entries);
    if (this.effectiveRelMode() !== 'canonical') return merged;
    const out = new Map<string, ManifestEntry>();
    for (const e of merged) {
      const rel = this.projectLocalRel(e.rel);
      const cur = out.get(rel);
      if (!cur || (e.mtime ?? 0) >= (cur.mtime ?? 0)) out.set(rel, { ...e, rel });
    }
    return [...out.values()].sort((a, b) => a.rel.localeCompare(b.rel));
  }

  /** 只读：生成会话 rel 迁移计划，不写任何东西。 */
  async sessionRelPlan(): Promise<{
    mode: SessionRelMode; effectiveMode: SessionRelMode; migrated: boolean;
    plan: RelMigrationPlan; valid: boolean; errors: string[];
  }> {
    this.checkReady();
    await this.ensureMigrationMarker();
    const remote = await this.readRemoteManifest();
    const plan = planRelMigration(remote, { bidMap: await this.readBidMap() });
    const check = validateRelPlan(plan);
    return {
      mode: this.sessionRelMode,
      effectiveMode: this.effectiveRelMode(),
      migrated: !!this.migrationMarker,
      plan,
      valid: check.ok,
      errors: check.errors,
    };
  }

  /**
   * 两阶段迁移：不带 confirm 只返回计划；带 confirm 才复制对象、写 bidmap、写 marker。
   * 旧对象只复制不删除，保留期内 `legacyProtected()` 会挡住 GC。
   */
  async migrateSessionRels(opts: { confirm?: boolean } = {}): Promise<{
    ok: boolean; dryRun: boolean; alreadyDone: boolean; copied: number;
    skippedChunks: string[]; bidMapEntries: number; errors: string[];
    marker: MigrationMarker | null; hint: string;
  }> {
    this.checkReady();
    await this.ensureMigrationMarker();
    if (this.migrationMarker) {
      return {
        ok: true, dryRun: false, alreadyDone: true, copied: 0, skippedChunks: [],
        bidMapEntries: 0, errors: [], marker: this.migrationMarker,
        hint: '迁移标记已存在，不重复执行。旧对象保留期内仍受保护。',
      };
    }
    const view = await this.sessionRelPlan();
    const plan = view.plan;
    const base = {
      dryRun: !opts.confirm, alreadyDone: false, copied: 0, skippedChunks: [] as string[],
      bidMapEntries: 0, errors: [...view.errors],
      marker: null as MigrationMarker | null,
    };
    if (!view.valid) {
      return { ...base, ok: false, hint: '计划校验未通过，未写入任何数据。' };
    }
    if (!opts.confirm) {
      return {
        ...base, ok: true,
        hint: `只读预演：将复制 ${plan.mappings.length} 个会话对象并写 bidmap。`
          + '确认无误后带 confirm:true 再执行一次。',
      };
    }

    const t = this.deps.transport;
    const skippedChunks: string[] = [];
    let copied = 0;
    for (const m of plan.mappings) {
      const from = '/dsh/' + m.legacyRel;
      const to = '/dsh/' + m.canonicalRel;
      try {
        // 分块对象不能只复制主文件（还有 .partNNNN 与清单）。这类条目保留在
        // legacy 空间由双读继续服务，绝不复制出半份不可解的 canonical 对象。
        let chunked = false;
        try { chunked = !!(await t.stat(from + '.chunk-manifest.json')); } catch { /* 不存在 */ }
        if (chunked) { skippedChunks.push(m.legacyRel); continue; }
        const buf = await t.getBuffer(from);
        if (!buf || buf.length === 0) { skippedChunks.push(m.legacyRel); continue; }
        await t.putBuffer(buf, to, { mkdirs: true });
        copied++;
      } catch (err) {
        base.errors.push('复制失败 ' + m.legacyRel + '：' + String(err));
      }
    }
    if (base.errors.length > 0) {
      return {
        ...base, ok: false, copied, skippedChunks,
        hint: '复制阶段有错误，未写 bidmap / 标记；已复制的对象保留可重跑。',
      };
    }

    const bidEntries = mergeBidMaps([
      await this.readBidMap(),
      bidMapFromPlan(plan, () => this.canonicalCwdSegment()),
    ]);
    const bidData = new TextEncoder().encode(
      JSON.stringify({ entries: bidEntries, updatedAt: Date.now() }, null, 2),
    );
    const marker = buildMigrationMarker(
      plan, selfDevice(), Date.now(), this.deps.config.retentionDays ?? 30,
    );
    const markerData = new TextEncoder().encode(JSON.stringify(marker, null, 2));
    try {
      if (t.putIfMatch && t.etag) {
        const bidEtag = await t.etag(BIDMAP_FILE);
        await t.putIfMatch(bidData, BIDMAP_FILE, bidEtag, { mkdirs: true });
        const mkEtag = await t.etag(MIGRATION_MARKER_PATH);
        await t.putIfMatch(markerData, MIGRATION_MARKER_PATH, mkEtag, { mkdirs: true });
      } else {
        await t.putBuffer(bidData, BIDMAP_FILE, { mkdirs: true });
        await t.putBuffer(markerData, MIGRATION_MARKER_PATH, { mkdirs: true });
      }
    } catch (err) {
      return {
        ...base, ok: false, copied, skippedChunks,
        hint: '写入 bidmap / 标记失败：' + String(err) + '（对象已复制，可重跑）',
      };
    }
    this.migrationMarker = marker;
    return {
      ...base, ok: true, copied, skippedChunks, bidMapEntries: bidEntries.length,
      marker,
      hint: '迁移完成。旧对象仅复制未删除；把 sessionRelMode 设为 canonical 后主链即切换。',
    };
  }

  /** 面板/工具：查看最近事件流与墓碑。 */
  async listEvents(limit = 100): Promise<{
    events: SyncEvent[]; trusted: boolean; tombstones: Tombstone[]; cursors: Record<string, number>;
  }> {
    await this.readEventStream();
    const n = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 100)));
    return {
      events: this.eventStream.slice(-n),
      trusted: this.eventTrust?.trusted ?? false,
      tombstones: this.tombstones,
      cursors: { ...this.deps.store.deviceCursors },
    };
  }

  /** 面板/工具：手动确认删除一条 rel，发布 delete 事件（仍受事件流完整性闸门约束）。 */
  async confirmDelete(rel: string): Promise<{ published: boolean; reason: string }> {
    this.checkReady();
    if (!isSafeRel(rel)) throw new Error('不安全的 rel：' + String(rel).slice(0, 120));
    await this.readEventStream();
    const gate = eventStreamAllowsDeletes(this.eventTrust);
    if (!gate.allowed) return { published: false, reason: gate.reason ?? '事件流不可信' };
    const device = selfDevice();
    const e = makeEvent({
      device, seq: nextLocalSeq(this.eventStream, device), ts: Date.now(),
      key: stableKeyOf(rel), rel, op: 'delete',
      retentionDays: normalizeRetentionDays(this.deps.config.retentionDays),
    });
    await this.appendLocalEvents([e]);
    this.eventStream = mergeEventLogs([this.eventStream, [e]]);
    this.tombstones = buildTombstones(this.eventStream, {
      retentionDays: normalizeRetentionDays(this.deps.config.retentionDays),
    });
    await this.writeTombstones();
    await this.writeCursors(this.eventStream);
    this.publishedEvents++;
    return { published: true, reason: '' };
  }

  /**
   * 扫描入口（0.6.0 收尾 · 并发保护）。
   *
   * `scan()` 会写 `store.pendingFiles` / `snapshot` 并把对端删除执行到本地回收站，
   * 不是幂等只读操作。0.5.9 审查 C 系列点出「scan() 无锁且带回收副作用」：
   * 自动同步定时器、面板手动刷新、工具调用三方并发时，两轮扫描会互相覆盖
   * pending 列表，极端情况下对同一份文件算出不同的「本地有/无」结论。
   *
   * 这里用 in-flight 去重而不是排队：并发的第二个调用**复用同一轮结果**，
   * 既不重复扫盘、也不会因为排队把面板点一下卡两轮。`finally` 保证异常后解锁，
   * 不会出现「第一次失败后永远锁死」。
   */
  async scan(): Promise<{ local: ManifestEntry[]; pending: PendingFile[]; conflicts: ConflictItem[] }> {
    if (this.scanInFlight) return this.scanInFlight;
    const run = this.scanOnce().finally(() => { this.scanInFlight = null; });
    this.scanInFlight = run;
    return run;
  }

  /** 真正的一轮扫描。只允许经 {@link scan} 调用，以保证并发保护不被绕过。 */
  private async scanOnce(): Promise<{ local: ManifestEntry[]; pending: PendingFile[]; conflicts: ConflictItem[] }> {
    this.checkReady();
    this.loadWorkspaceDirs();
    this.loadIgnoredFile();
    // 0.6.0 / 收尾①：先读迁移标记，effectiveRelMode() 据此决定要不要降级。
    await this.ensureMigrationMarker();
    this.setPhase('scanning');
    // 0.6.0 / P1：先读事件流（删除的唯一证据），再按墓碑过滤远端清单、
    // 按对端事件把本地对应内容移进回收站。顺序不能反 —— 否则被删的条目还会
    // 在下面被判成「远端有本地无 → 下载」，删完立刻又拉回来。
    await this.readEventStream();
    let local = await this.scanner.buildManifest();
    // 让「DSH 侧栏可见性」成为同步判据（0.6.2 收进 stripTrashed，两处共用）。
    // 注意：**不能**只在这一处剔除 —— 发布事件那条路会自己再调一次
    // buildManifest，见 stripTrashed 的注释。
    local = await this.stripTrashed(local);
    // 0.6.3：被删会话常留下一个**空目录**（下载路径先 mkdir 再决定写不写），
    // 宿主按目录列举会话，空目录照样渲染成一条「点开就报错」的幽灵。
    // 只清空目录，且 sid 必须在墓碑或本机回收站里、目录 mtime 也够旧。
    try {
      const dead = new Set<string>();
      for (const t of this.tombstones) {
        if (typeof t.key === 'string' && t.key.startsWith('session:')) {
          dead.add(t.key.slice('session:'.length));
        }
      }
      for (const sid of await listTrashedSessionIds()) dead.add(sid);
      if (dead.size > 0) {
        const pruned = await pruneEmptySessionDirs(dead);
        if (pruned.length > 0) {
          console.log('[dsh-nas-sync] 清掉 ' + pruned.length + ' 个已删会话留下的空目录');
        }
      }
    } catch (err) {
      // 清不掉不影响本轮同步：下一轮还会扫到
    }
    // 0.6.0 / 收尾③：扫描成功后原子落盘。写失败只降级（下轮重算），不能让
    // 一轮同步因为缓存写不进去而整体失败。
    if (this.scanCache) {
      try {
        saveScanCache(this.scanCache.snapshot());
      } catch (err) {
        this.scanCacheWarning = '扫描缓存写入失败：' + String(err);
        console.warn('[dsh-nas-sync] ' + this.scanCacheWarning);
      }
    }
    const remote = stripDeletedEntries(await this.readRemoteManifest(), this.tombstones);
    this.remoteManifest = remote;
    local = await this.applyRemoteDeletes(local);

    const localMap = new Map(local.map((e) => [e.rel, e]));
    const remoteMap = new Map(remote.map((e) => [e.rel, e]));
    const pending: PendingFile[] = [];
    const conflicts: ConflictItem[] = [];

    const last = this.deps.store.snapshot.lastSyncTime ?? 0;

    /**
     * 跨平台会话的导入记录（0.5.6）。
     *
     * 落地时 cwd 被改写，本地副本和远端原文**永远不是同一份字节**：
     *   · 不挡下载 → 远端原文每轮都被判「本地没有」→ 每轮重下一遍；
     *   · 不挡上传 → 本地改写副本每轮都被判「远端没有」→ 每轮重传一份（NAS 上还会
     *     多出一份 cwd 是本机路径的副本，对端拿到既打不开、还会撞出同 id 双份）。
     * 所以按 rel 记账：远端原文 hash 没变就不再下载，本地这份也不走上传；
     * 用户在本机真的继续过它（localHash 变了）由 flushSessionImports() 改回原 cwd 回传。
     */
    const imports = this.deps.store.sessionImports ?? (this.deps.store.sessionImports = {});
    const importedLocalRel = new Set<string>();
    // 0.5.9：屏蔽清单读坏时，本轮**不做任何回收**。宁可这轮不收敛，也不能在
    // 不知道哪些会话该保留的情况下搬走用户数据。
    const destructiveBlocked = this.ignoredFileError !== null;
    if (destructiveBlocked) {
      console.warn('[dsh-nas-sync] 本轮跳过全部回收动作：' + this.ignoredFileError);
    }
    for (const [remoteRel, rec] of Object.entries(imports)) {
      let alive = false;
      try {
        alive = existsSync(this.resolveLocal(rec.localRel));
      } catch {
        alive = false;
      }
      if (!alive) {
        delete imports[remoteRel]; // 本地镜像已经没了（用户手删）→ 下次重新导入
        continue;
      }

      if (!remoteMap.has(remoteRel)) {
        /**
         * 远端原文不见了 —— 0.5.8 起判成「对端删了这个会话」，本机镜像一起回收。
         *
         * 0.5.7 之前这里只是 `delete imports[remoteRel]`，后果正好相反：账一销，
         * 本地镜像就不再算「导入副本」，于是下一轮被当成**本机新文件上传**，
         * NAS 上又多回一份 → 对端再下载回来。实测手机上删掉的
         * 「鲸鱼宠物 / 数据库同步问题」就是这样在电脑上反复复活的。
         *
         * 三重保险，避免把「清单读失败」误判成「用户删了」：
         *   ① `remoteManifestTrusted`：本轮**每一份**设备清单都读成了（0.5.9 收紧）；
         *   ② `advanceMissingRounds()`：严格连续两轮，中间任何一轮不可信或又出现
         *      都归零（0.5.8 的不可信分支不复位，实际是「累计两轮」，与 README 不符）；
         *   ③ 回收是移进 `$DSH_HOME/nas-sync/removed/<时间戳>/`，不是硬删，
         *      0.5.9 起还能用 `nas_list_removed` / `nas_restore_session` 真正恢复。
         */
        const rounds = advanceMissingRounds({
          trusted: this.remoteManifestTrusted && !destructiveBlocked,
          present: false,
          previous: rec.missingRounds,
        });
        rec.missingRounds = rounds;
        if (!shouldRetire(rounds)) {
          importedLocalRel.add(rec.localRel); // 还不到两轮：先当「还活着」，别上传别回收
          continue;
        }
        try {
          await this.retireImport(remoteRel, rec);
        } catch (err) {
          console.warn('[dsh-nas-sync] 回收镜像失败（下轮再试）：' + remoteRel + ' · ' + String(err));
          rec.missingRounds = 0;
          importedLocalRel.add(rec.localRel);
        }
        continue;
      }

      rec.missingRounds = 0;
      importedLocalRel.add(rec.localRel);
    }

    /**
     * 本机屏蔽的会话：把本地副本一起回收（0.5.8）。
     *
     * 放在扫描里而不是靠外部脚本，是因为「删本地文件」这个动作**随时可能被撤销**：
     * 只要 NAS 上还有一条同 id 的 rel（手机原文、或本机镜像被误传上去的那份），
     * 下一轮就会把它再下载回来。光删文件不记屏蔽 = 白删。
     * 反过来，只记屏蔽不删文件 = 侧栏里还留着、而且会被当本机文件上传。
     * 两个动作绑在一起、每轮幂等执行，才真正收敛。
     */
    for (const rel of [...localMap.keys()]) {
      if (destructiveBlocked) break; // 屏蔽清单不可信，不敢按它搬文件
      if (!this.isSessionBodyRel(rel) || !this.isImportIgnored(rel)) continue;
      try {
        await this.retireLocalSession(rel);
        localMap.delete(rel);
        const i = local.findIndex((e) => e.rel === rel);
        if (i >= 0) local.splice(i, 1);
      } catch (err) {
        console.warn('[dsh-nas-sync] 回收被屏蔽会话失败（下轮再试）：' + rel + ' · ' + String(err));
      }
    }

    for (const [rel, le] of localMap) {
      // 注册表不参与差集：它由 pullWorkspaceRegistry() 每轮**合并**，永远不可能
      // 和远端字节一致（合并结果包含本机条目），留在差集里会变成「永远待同步 1 项」。
      if (isWorkspaceRegistryRel(rel)) continue;
      // 跨平台会话的本地改写副本：镜像，不参与上传（回传走 flushSessionImports）
      if (importedLocalRel.has(rel)) continue;
      // 本机屏蔽的会话不该上传（上面已回收，这里兜住「回收失败」那种情况）
      if (this.isSessionBodyRel(rel) && this.isImportIgnored(rel)) continue;
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
      // 本机明确屏蔽的（0.5.8）：不进待同步，否则面板永远显示「待同步 N 项」
      if (this.isImportIgnored(rel)) continue;
      // 已经导入过且远端原文没变 → 本地那份就是它（cwd 已改写），不必再下一遍
      const rec = imports[rel];
      if (rec && rec.remoteHash === re.hash) continue;
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
    if (mode !== 'push') {
      // 先读事件流再并注册表：合并时要用墓碑里的 sid 把「已被对端删除」的会话
      // 从 sessionIds 里剔掉，否则每轮都会把它并回来（侧栏幽灵会话）。
      // 读失败不阻断：readEventStream 内部已把不可信状态记在 eventTrust 上，
      // 那种情况下删除传播本来就会整轮禁用。
      await this.readEventStream();
      await this.pullWorkspaceRegistry();
    }
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
            await this.pushFile(item.rel, remoteMap.get(item.rel)?.hash);
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

      // 本机继续过的跨平台会话：改回原 cwd 回传（见 flushSessionImports）。
      // 放在收尾修复之前 —— 回传要用「本轮还没被 dedupe 搬动过」的本地副本。
      if (!this.abort.signal.aborted) {
        try {
          await this.flushSessionImports();
        } catch {
          /* 回传失败不该让整轮同步判失败，下一轮会重试 */
        }
        try {
          await this.registerImportedSessions();
        } catch {
          /* 登记失败不影响整轮结果 */
        }
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
        // 0.6.2：这里必须与扫描阶段同口径（剔除回收站会话），否则
        // computeLocalDeletes 拿到的 fresh 里「已删的会话还在」，一条 delete 都发不出。
        const fresh = await this.stripTrashed(await this.scanner.buildManifest());
        // 保存本轮之前的基线：下面会把 store.localManifest 覆盖成 fresh，
        // 而删除判定必须拿「上一轮」来比，否则一条 delete 事件都发不出来。
        const baseline = this.deps.store.localManifest ?? [];
        /**
         * 来源设备合并：`buildManifest` 会把扫到的每个文件都标成本机（它只知道
         * 「我这儿有这个文件」）。但清单要回答的是「谁传上来的」，所以内容哈希
         * 与上一轮一致的条目**保留原来源**，只有真正变了的才归给本机。
         * 不做这一步，来源每同步一次就被刷成"本机"，等于没记。
         */
        // 0.3.6：只写本设备那份清单，再重读合并视图。
        // 不再「把远端独有的条目补回」—— 每份清单只含确认在远端存在的东西，
        // 补回反而会给对端制造下载不到的幽灵条目。
        await this.writeOwnManifest(this.withoutMirrors(fresh));
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

        // 0.6.0 / P1：事件发布放在所有内容同步完成、清单回写之后。
        // 发布失败不能让整轮同步判失败 —— 事件留在 pendingIntents / 下一轮重放，
        // 已同步的文件不会回滚。
        try {
          await this.publishEvents(fresh, baseline);
        } catch (err) {
          console.warn('[dsh-nas-sync] 事件发布失败（下轮重放）：' + String(err));
        }
        try {
          await this.gcRemoteObjects();
        } catch (err) {
          console.warn('[dsh-nas-sync] 回收对象 GC 失败：' + String(err));
        }
        // 0.6.0 / P2：把本机的跨平台会话映射按 sid 汇总到远端账本
        try {
          await this.publishBidMap();
        } catch (err) {
          console.warn('[dsh-nas-sync] bidmap 发布失败（下轮重试）：' + String(err));
        }

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
  private async pushFile(rel: string, remoteHash?: string): Promise<void> {
    this.setPhase('uploading');
    const localAbs = this.resolveLocal(rel);

    // 可合并文本且远端已有版本 → 先把远端旧内容存为 .base（三路合并公共祖先）
    if (isMergeable(rel) && remoteHash) {
      await this.saveBase(rel);
    }

    await this.pushBytes(rel, await readFile(localAbs));
  }

  /**
   * 把一段明文按同步协议发到 `rel`（加密 + 分块或直传）。
   *
   * 抽出来是为了让「回写跨平台会话」也能复用：那条路径的源文件在**本机另一个
   * rel** 下（cwd 已被改写），不能走 pushFile 的 resolveLocal。
   */
  private async pushBytes(rel: string, data: Uint8Array): Promise<void> {
    const remote = '/dsh/' + rel;
    const plainHash = sha256Hex(data);
    const cipher = await this.seal(data, rel);

    if (data.length >= this.deps.config.chunkThreshold) {
      await this.chunker.upload(cipher, plainHash, data.length, remote);
    } else {
      await this.deps.transport.putBuffer(cipher, remote, { mkdirs: true });
    }
  }

  /**
   * 补登记：「同步进来的会话」逐个确保在工作区注册表里有名分（0.5.7）。
   *
   * 0.5.6 导入的会话只落了文件、没登记，侧栏就看不到（见 registerSessionForRel 注释）。
   * 每轮跑一次、只处理 `sessionImports` 里的条目 —— 不去全盘扫描工作区目录，
   * 免得把用户在侧栏里删掉的会话（目录可能还在）又复活出来。
   */
  private async registerImportedSessions(): Promise<void> {
    let n = 0;
    for (const rec of Object.values(this.deps.store.sessionImports ?? {})) {
      try {
        if (await registerSessionForRel(rec.localRel)) n += 1;
      } catch {
        /* 单条失败不影响其它 */
      }
    }
    if (n > 0) console.log('[dsh-nas-sync] 已补登记 ' + n + ' 个会话到侧栏');
  }

  /** 回收根目录。0.5.9 起这里的内容可被 `listRemovedSessions()` 枚举并恢复。 */
  private removedRoot(): string {
    return join(dshHome(), 'nas-sync', 'removed');
  }

  /**
   * 把某个会话的**目录**搬进回收目录，并清掉它在工作区里的登记。
   * `retireImport()` 与本机屏蔽回收共用这一段。
   *
   * 0.5.9：同时写一个 `<id>.meta.json` 记录原始 rel / 远端 rel / 原因，
   * 否则目录名是 `sessions__xxx__sid__file` 这种有损编码，根本没法还原回去 ——
   * README 说的「随时捞回来」在 0.5.8 里其实没有任何实现。
   *
   * @returns 搬去的目标路径
   */
  private async retireLocalSession(
    localRel: string,
    opts: { remoteRel?: string; reason: string } = { reason: 'locally-ignored' },
  ): Promise<string> {
    if (!isSafeRel(localRel)) throw new Error('拒绝回收不安全的 rel：' + String(localRel).slice(0, 120));
    const abs = this.resolveLocal(localRel);
    // 会话文件在 `sessions/<cwd编码>/<sessionId>/session.v4.jsonl.zstd`，整个目录一起搬
    const cut = Math.max(abs.lastIndexOf('/'), abs.lastIndexOf('\\'));
    if (cut <= 0) throw new Error('无法从 rel 推导会话目录：' + localRel);
    const sessionDir = abs.slice(0, cut);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const id = localRel.replace(/\//g, '__');
    const batch = join(this.removedRoot(), stamp);
    const trash = join(batch, id);
    await mkdir(batch, { recursive: true });

    if (existsSync(sessionDir)) {
      try {
        await rename(sessionDir, trash);
      } catch {
        // 跨卷回退：先复制完整，再删源目录（0.5.8 的 cp→rm 之间没有校验，
        // 复制失败也会把源删掉。这里至少确认目标存在且非空才动手）
        await cp(sessionDir, trash, { recursive: true });
        const copied = await readdirAsync(trash);
        if (copied.length === 0) throw new Error('回收目录复制为空，已保留原文件');
        await rm(sessionDir, { recursive: true, force: true });
      }
    }
    // 元数据放在会话目录旁边，避免污染会话目录本身
    try {
      writeJsonAtomic(trash + '.meta.json', {
        rel: localRel,
        remoteRel: opts.remoteRel ?? null,
        sessionId: this.sessionIdOfRel(localRel),
        retiredAt: new Date().toISOString(),
        reason: opts.reason,
        trashDir: trash,
      });
    } catch (err) {
      console.error('[dsh-nas-sync] 回收元数据写入失败（这条例后将只能手工恢复）：' + String(err));
    }
    const sid = this.sessionIdOfRel(localRel);
    try {
      await unregisterSessionFromRel(localRel);
    } catch {
      /* 清登记失败不致命：文件已经不在，下一轮不会再有这条 */
    }
    /**
     * 0.6.0 / 收尾②：连投影缓存一起清。
     *
     * `storages/session_projcache/sessions/<sid>.json` 不在同步范围，也不会随会话
     * 文件消失而自动清理。部分宿主版本会先读这份快照渲染侧栏，于是出现「文件已经
     * 搬进回收站、侧栏还挂着一条、点开报错」的幽灵条目。清失败不影响回收本身。
     */
    if (sid) {
      try {
        await dropSessionProjCache(sid);
      } catch { /* 尽力而为 */ }
    }
    return trash;
  }

  /** 回收目录里的一条记录。 */
  listRemovedSessions(): Array<{
    id: string; rel: string | null; sessionId: string | null;
    retiredAt: string | null; reason: string | null; restorable: boolean;
  }> {
    const root = this.removedRoot();
    let batches: string[] = [];
    try {
      batches = readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return []; // 还没有回收目录
    }
    const out: ReturnType<Engine['listRemovedSessions']> = [];
    for (const batch of batches) {
      const dir = join(root, batch);
      let names: string[] = [];
      try { names = readdirSync(dir); } catch { continue; }
      for (const name of names) {
        if (!name.endsWith('.meta.json')) continue;
        const metaPath = join(dir, name);
        const meta = readJsonFile<Record<string, any>>(metaPath).data;
        const id = name.slice(0, -'.meta.json'.length);
        out.push({
          id,
          rel: typeof meta?.rel === 'string' ? meta.rel : null,
          sessionId: typeof meta?.sessionId === 'string' ? meta.sessionId : null,
          retiredAt: typeof meta?.retiredAt === 'string' ? meta.retiredAt : null,
          reason: typeof meta?.reason === 'string' ? meta.reason : null,
          restorable: !!meta && isSafeRel(meta.rel),
        });
      }
      // 0.5.8 及更早、或手工搬进去的目录：没有元数据，只列出不提供自动恢复
      for (const name of names) {
        if (name.endsWith('.meta.json') || name.endsWith('.bak')) continue;
        const metaPath = join(dir, name + '.meta.json');
        if (existsSync(metaPath)) continue;
        out.push({
          id: name, rel: null, sessionId: null,
          retiredAt: batch, reason: 'legacy（无元数据）', restorable: false,
        });
      }
    }
    return out.sort((a, b) => String(b.retiredAt ?? '').localeCompare(String(a.retiredAt ?? '')));
  }

  /**
   * 把回收目录里的会话放回原处（0.5.9）。
   *
   * 除了搬文件，还做两件必须的事：重新登记到工作区（否则侧栏看不到），
   * 以及撤销本机屏蔽（否则下一轮扫描立刻又把它搬回来）。
   */
  async restoreRemovedSession(key: string): Promise<{ rel: string; restoredTo: string }> {
    const wanted = String(key || '').trim();
    if (!wanted) throw new Error('请提供回收记录的 id 或原始 rel');
    const entry = this.listRemovedSessions().find((e) => e.id === wanted || e.rel === wanted);
    if (!entry) throw new Error('回收目录里没有这条记录：' + wanted);
    if (!entry.restorable || !entry.rel) {
      throw new Error('这条回收记录没有元数据（旧版/手工搬迁），无法自动还原；请手工从 '
        + this.removedRoot() + ' 拷回 sessions/ 对应目录');
    }
    const rel = entry.rel;
    const abs = this.resolveLocal(rel);
    const cut = Math.max(abs.lastIndexOf('/'), abs.lastIndexOf('\\'));
    if (cut <= 0) throw new Error('无法从 rel 推导会话目录：' + rel);
    const sessionDir = abs.slice(0, cut);
    if (existsSync(sessionDir)) {
      throw new Error('目标目录已存在，拒绝覆盖：' + sessionDir);
    }
    // 定位元数据与回收目录（listRemovedSessions 只给了 id，需要回查原始路径）
    const root = this.removedRoot();
    let trashDir = '';
    let metaPath = '';
    for (const batch of (() => {
      try { return readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); }
      catch { return [] as string[]; }
    })()) {
      const candidate = join(root, batch, entry.id + '.meta.json');
      if (!existsSync(candidate)) continue;
      const m = readJsonFile<Record<string, any>>(candidate).data;
      if (m?.rel !== rel) continue;
      metaPath = candidate;
      trashDir = typeof m?.trashDir === 'string' ? m.trashDir : join(root, batch, entry.id);
      break;
    }
    if (!trashDir || !existsSync(trashDir)) throw new Error('回收目录已不存在：' + (trashDir || entry.id));
    await mkdir(join(sessionDir, '..'), { recursive: true });
    try {
      await rename(trashDir, sessionDir);
    } catch {
      await cp(trashDir, sessionDir, { recursive: true });
      const copied = await readdirAsync(sessionDir);
      if (copied.length === 0) throw new Error('恢复复制为空，已保留回收目录');
    }
    try { await registerSessionForRel(rel); } catch (err) {
      console.warn('[dsh-nas-sync] 恢复后登记侧栏失败：' + String(err));
    }
    const sid = entry.sessionId ?? this.sessionIdOfRel(rel);
    if (sid) this.unignoreSession(sid);
    if (metaPath) {
      try { await rm(metaPath, { force: true }); } catch { /* 留着不影响使用 */ }
    }
    /**
     * 0.6.0 / 收尾②：恢复必须能**撤销墓碑**。
     *
     * 墓碑现在同时驱动两件事：对端按它回收本地副本；本机注册表合并按它的 sid
     * 把会话从 `sessionIds` 里剔掉。恢复只把文件搬回来、不撤销墓碑的话，下一轮
     * 同步会立刻把这条会话重新隐藏（甚至再次回收），用户看到的就是「恢复了又没了」。
     * 发一条更晚的 upsert 即可：`buildTombstones()` 里 upsert 晚于 deletedAt 就销墓碑。
     */
    if (sid) {
      const key = 'session:' + sid;
      if (this.tombstones.some((t) => t.key === key)) {
        try {
          const buf = await readFile(this.resolveLocal(rel));
          const device = selfDevice();
          const e = makeEvent({
            device, seq: nextLocalSeq(this.eventStream, device), ts: Date.now(),
            key, rel, hash: sha256Hex(buf), op: 'upsert', category: 'sessions',
          });
          await this.appendLocalEvents([e]);
          this.eventStream = mergeEventLogs([this.eventStream, [e]]);
          this.tombstones = buildTombstones(this.eventStream, {
            retentionDays: normalizeRetentionDays(this.deps.config.retentionDays),
          });
          await this.writeTombstones();
          await this.writeCursors(this.eventStream);
        } catch (err) {
          console.warn(
            '[dsh-nas-sync] 恢复后撤销删除墓碑失败（下一轮可能又把该会话隐藏）：' + String(err),
          );
        }
      }
    }
    return { rel, restoredTo: sessionDir };
  }

  /**
   * 回收一条导入的会话镜像（0.5.8）。
   *
   * 触发条件是「远端原文在对端清单里连续两轮消失」= 对端删了这个会话。
   * 顺序很关键：**先移文件、再销账、最后清登记** ——
   *   · 先移：`sessionImports` 一旦少了一条，本地这份就会被当成本机新文件上传，
   *     所以必须让文件先不存在，否则会给对端送回去（0.5.7 的老毛病）；
   *   · 后清登记：dsh 侧栏按 `sessionIds` 渲染，文件删了不清登记 = 留一条点不开的幽灵会话。
   *
   * 移动而不是删除：目标在 `$DSH_HOME/nas-sync/removed/<时间戳>/`，仍然是可恢复的
   * 真文件，且和 `sessions/` 同卷，`rename` 是原子操作。
   */
  private async retireImport(
    remoteRel: string,
    rec: SessionImportRecord,
  ): Promise<void> {
    // `adopted` 的条目：那条会话本来就是本机这个工作区的，只是被对端的等价副本
    // 记账收下过。对端删了它不代表要删本机的历史 —— 只销账，文件原样留着。
    if (rec.adopted) {
      delete this.deps.store.sessionImports[remoteRel];
      this.deps.store.save();
      console.log('[dsh-nas-sync] 对端删除了等价副本，本机会话保留不动：' + rec.localRel);
      return;
    }

    const trash = await this.retireLocalSession(rec.localRel, { remoteRel, reason: 'remote-deleted' });

    delete this.deps.store.sessionImports[remoteRel];
    this.deps.store.save();

    console.log('[dsh-nas-sync] 对端已删除该会话，本机镜像已移入回收目录：' + rec.localRel + ' → ' + trash);
  }

  /**
   * 把某个 rel 的新指纹写回**它所属的那份设备清单**（0.5.6）。
   *
   * 为什么必须写：清单是「远端有什么」的唯一真相。跨平台会话回传后如果只把字节
   * PUT 上去、不更新清单，对端扫描时比的是「本地 hash vs 清单 hash」——两边都还是
   * 旧的、相等，于是它根本不会发现自己需要下载，回传等于白做。
   *
   * 为什么能改别人的分片：这里只动**这一条**的指纹（hash/size/mtime），不增不删；
   * 对端下一轮会用自己的扫描结果重写整份清单，不会打架。
   */
  private async updateRemoteManifestEntry(rel: string, hash: string, size: number): Promise<void> {
    let names: NasEntry[] = [];
    try {
      names = await this.deps.transport.list(MANIFESTS_DIR);
    } catch {
      return;
    }
    for (const f of names) {
      if (f.type !== 'file' || !f.name.endsWith('.json') || f.name === '_legacy.json') continue;
      const remote = MANIFESTS_DIR + '/' + f.name;
      const list = await this.readManifestAt(remote);
      const i = list.findIndex((e) => e.rel === rel);
      if (i < 0) continue;
      list[i] = { ...(list[i] as ManifestEntry), hash, size, mtime: Date.now() };
      await this.writeManifestFile(remote, list);
      return;
    }
    // 哪份清单都没有它：对端还没把这条写进清单，下次扫描会按新增处理，无需补记
  }

  /**
   * 回写「本机继续过的跨平台会话」（0.5.6）。
   *
   * 场景：手机会话被导入到电脑（cwd 改成电脑路径），用户在电脑上接着聊。
   * 如果不管，这段新增内容只会留在电脑上 —— 本地那份是镜像、不参与上传，
   * 手机永远看不到，属于**静默丢数据**。
   *
   * 做法：把 cwd 改回**原机器的路径**，按原 rel 回传，并把新指纹写回对端清单。
   * 这样手机拿到的是自己平台的路径、打开就能跑；两端仍只有一条 rel、一个
   * sessionId，不会撞出重复会话。
   */
  private async flushSessionImports(): Promise<number> {
    const imports = this.deps.store.sessionImports ?? {};
    let republished = 0;
    for (const [remoteRel, rec] of Object.entries(imports) as [string, SessionImportRecord][]) {
      if (this.abort?.signal.aborted) break;
      let local: Buffer;
      try {
        local = await readFile(this.resolveLocal(rec.localRel));
      } catch {
        continue; // 本地副本没了：scan() 会把记录清掉
      }
      if (sha256Hex(local) === rec.localHash) continue; // 没动过，不用回传

      const back = rewriteSessionCwdTo(local, rec.originalCwd) ?? local;
      try {
        await this.pushBytes(remoteRel, back);
        const backHash = sha256Hex(back);
        // 记账：远端已经换成了「回传后的那份」
        rec.remoteHash = backHash;
        rec.localHash = sha256Hex(local);
        // 关键一步：把新指纹写进对端清单，否则对端会以为远端还是老内容、不下载
        await this.updateRemoteManifestEntry(remoteRel, backHash, back.length);
        republished += 1;
      } catch (e) {
        console.warn('[dsh-nas-sync] 回传跨平台会话失败（' + remoteRel + '）：' + (e as Error).message);
      }
    }
    if (republished > 0) {
      this.deps.store.save();
      console.log('[dsh-nas-sync] 已回传本机继续过的跨平台会话 ' + republished + ' 个');
    }
    return republished;
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
    // 合并注册表要用屏蔽清单，而 sync() 里这一步排在 scan() 之前 ——
    // 不能等 scan() 去加载，否则这一轮合并又把屏蔽掉的 id 并回来了。
    this.loadIgnoredFile();
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
      /**
       * 0.6.0 / 收尾②：把「已删除会话」的 sid 一并交去剔除。
       *
       * 注册表合并是**单调并集**（只加不改），所以一端删了会话、本机把文件搬走后，
       * 远端注册表下一轮又会把那个 sid 并回 `sessionIds` —— 侧栏立刻多出一条
       * 「文件早没了、点开就报错」的幽灵会话。原先只有本机屏蔽集合走这道过滤，
       * 现在把墓碑里的 sid 也并进去，删除才真正收敛。
       */
      const drops = new Set<string>(this.ignoredFromFile);
      const now = Date.now();
      for (const t of this.tombstones) {
        if (!t.key.startsWith('session:')) continue;
        const sid = t.key.slice('session:'.length);
        if (!sid) continue;
        if (t.expiresAt !== 0 && now >= t.expiresAt) continue; // 保留期已过，不再拦
        drops.add(sid);
      }
      const r = await mergeWorkspaceRegistry(remoteText, undefined, drops);
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
      await this.pushFile(WORKSPACE_REGISTRY_REL);
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

    // 0.5.9：rel 来自远端清单，是**外部输入**。在它进入 fetch 路径拼接与
    // resolveLocal() 之前先挡一道，防止 `../` / 绝对路径 / 编码穿越读写任意文件。
    if (!isSafeRel(rel)) {
      console.warn('[dsh-nas-sync] 拒绝不安全的远端 rel：' + String(rel).slice(0, 120));
      return 'skipped';
    }

    // 0.5.8：本机明确屏蔽的远端会话，连取都不取（省一次 580 KB 的下载）
    if (this.isImportIgnored(rel)) return 'skipped';

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
      await mergeWorkspaceRegistry(Buffer.from(plain).toString('utf8'), undefined, this.ignoredFromFile);
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
    if (this.isSessionBodyRel(rel)) {
      // 同样必须 Buffer.from：rewriteSessionCwd 用的是 readUInt32LE/subarray 这套
      // Buffer 专有 API，直接传 Uint8Array 会在帧解析处抛错并被吞掉。
      const raw = Buffer.from(plain);

      // 0.3.4：跨平台判定必须看**原始 cwd**，不能看改写后的路径（它恒为本机路径）。
      //
      // 0.5.6：**从「一律丢弃」改成「有落脚点就导入」**。0.3.4 之所以一刀切，是为了绕开
      // 「改写后的副本和远端原文永久不同字节 → 每轮再下一次 + 再传一份」的死循环
      // （和本机权威目录撞出同 id 双份，实测 11 份）。那个收敛问题现在由
      // `store.sessionImports` 解决（见 scan() 与 flushSessionImports()），所以只要能
      // 找到本机的落脚目录，跨平台会话就可以安全导入、直接在这个工作区里打开。
      const originalCwd = sessionCwdOf(raw);
      if (!originalCwd) return 'skipped'; // 连 cwd 都读不出来：不落盘，避免幽灵会话

      let targetDir: string;
      let written: Buffer;
      const crossPlatform = platformMismatch(originalCwd);

      if (crossPlatform) {
        // 跨平台：优先用注册表里**同名工作区**的真实路径（电脑上可能是
        // `Desktop\胎教Agent`，而不是映射出来的 nassyncworkspaces 目录 —— 用错会
        // 导进另一个工作区，侧栏里看起来就是「会话跑到别的地方去了」）。
        targetDir = this.workspaceDirs.get(safeName(originalCwd)) ?? mapRemotePath(originalCwd).local;
        // 只在目标目录**已经存在**时导入：硬造一个空目录只会得到一个「打得开但
        // 模型跑不动」的幽灵会话（手机上 `.dsh` 之内的散装 cwd 正是这类）。
        if (!existsSync(targetDir)) {
          console.warn('[dsh-nas-sync] 跳过异平台会话（本机没有对应工作区 ' + targetDir + '）：' + rel);
          return 'skipped';
        }
        written = rewriteSessionCwdTo(raw, targetDir) ?? raw;
      } else {
        // 同平台：沿用原逻辑（cwd 本机已存在就不动，否则映射到 nassyncworkspaces）。
        const out = rewriteSessionCwd(raw);
        targetDir = out ? out.dir : originalCwd;
        written = out ? out.buf : raw;
        await mkdir(targetDir, { recursive: true });
      }

      // 落地 rel 永远是本机的 `sessions/<cwd编码>/<sid>/<文件>`。
      // canonical 远端 rel 是 5 段（多一层 vN），不能再靠 parts[length-2] 取 sid；
      // 统一用 sessionIdFromRel()，两种空间都取得到同一个 sid。
      const sid = sessionIdFromRel(rel) ?? '';
      const fileName = rel.split('/').pop() ?? '';
      const wantDir = encodeCwd(targetDir);
      const targetRel = ['sessions', wantDir, sid, fileName].join('/');
      const target = this.resolveLocal(targetRel);

      /**
       * 跨平台导入撞上「本机**自己**的同 id 会话」时不覆盖。
       *
       * 同一个 sessionId 在两端各继续过一段 = 两条独立历史，谁盖谁都是丢数据
       * （典型：手机上开过、电脑上也开过的同一个会话）。
       * 例外：target 就是**上次给这条 rel 建的镜像**（记录里对得上）—— 那是正常更新。
       *
       * 0.5.8 补充第二个例外 `localIsStaleSnapshot()`：本机那份只是**同一条会话的
       * 更早快照**时也不再挡。按字节哈希比较挡不住这种情况 —— 镜像的 cwd 被改写过，
       * 和远端原文永远不相等，于是它被永久判成冲突：远端聊到 57 万字节，本机一直停在
       * 562 字节的表头快照上，侧栏里就是「这条会话没同步过来」
       * （实测 `B站UP主沐白若风`，aa35e064）。追加序前缀相同 = 覆盖不丢历史。
       */
      const priorRecord = this.importRecordFor(rel);
      const isOurMirror = priorRecord?.localRel === targetRel;
      if (crossPlatform && targetRel !== rel && !isOurMirror && existsSync(target)) {
        const cur = await readFile(target);
        const sameHash = sha256Hex(cur) === sha256Hex(written);
        if (sameHash) {
          // 完全一致，正常往下走（幂等覆盖，不会产生新字节）
        } else if (!localIsStaleSnapshot(cur, written)) {
          if (!this.importSkipWarned.has(rel)) {
            this.importSkipWarned.add(rel);
            console.warn('[dsh-nas-sync] 跳过导入（本机已有同 id 会话，避免互相覆盖）：' + rel);
          }
          return 'skipped';
        } else if (
          sessionFrameOffsets(cur).length === sessionFrameOffsets(written).length &&
          // 0.5.9：单帧会话没有尾帧可比，只比帧数会把两条不同会话误判成「等价副本」。
          // 必须再用首帧身份指纹（忽略 cwd）证明确实是同一条。
          sessionHeaderIdentity(cur) !== null &&
          sessionHeaderIdentity(cur) === sessionHeaderIdentity(written)
        ) {
          /**
           * 帧数一样、尾帧逐字节一样、首帧身份相同 = **内容完全等价，只差第 0 帧的 cwd**
           * （典型：对端把自己那份镜像按本机路径回过一次，又被本机当成一条新 rel 看到）。
           * 这种不要去写盘：写了就得重新压第 0 帧，两端的字节又会互相「看起来更新」，
           * 580 KB 的会话每 5 分钟来回搬一次。只记账、不落盘，下一轮就收敛。
           */
          this.deps.store.sessionImports[rel] = {
            remoteHash: sha256Hex(plain),
            localRel: targetRel,
            localHash: sha256Hex(cur),
            originalCwd,
            adopted: true,
          };
          this.deps.store.save();
          return 'skipped';
        } else {
          console.log('[dsh-nas-sync] 本机副本是旧快照，用远端最新版覆盖：' + rel);
        }
      }

      const cut2 = Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\'));
      await mkdir(target.slice(0, cut2), { recursive: true });
      await writeFile(target, written);

      // 目录名变了就别把旧副本留着 —— 同一个 sessionId 出现在两个 cwd 目录下，
      // dsh 会当成两个会话（其中一个永远打不开）。
      if (target !== localAbs) {
        try {
          await rm(localAbs.slice(0, cut), { recursive: true, force: true });
        } catch {
          /* 删不掉也不影响下一轮再修 */
        }
      }

      // 登记到工作区（0.5.7）：dsh 的侧栏按注册表 sessionIds 列会话，不登记就是
      // 「文件在、内容对、侧栏没有」。跨平台导入（以及新机器首次同步）必踩。
      try {
        if (await registerSessionForRel(targetRel)) {
          console.log('[dsh-nas-sync] 会话已登记到侧栏：' + targetRel);
        }
      } catch {
        /* 登记失败不影响文件落地，下一轮 sync 的补登记还会再试 */
      }

      // 改写过的副本要记账（0.5.6）：本地这个 rel 永不上传、远端原文没变就永不
      // 重下 —— 否则两端字节永远对不上，扫描每轮都会各做一次无用功。
      if (targetRel !== rel) {
        this.deps.store.sessionImports[rel] = {
          remoteHash: sha256Hex(plain),
          localRel: targetRel,
          localHash: sha256Hex(written),
          originalCwd,
        };
        this.deps.store.save();
      }
      return 'written';
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
      await this.pushFile(rel, c.remoteHash);
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
      // 会话被改写 cwd 后，目录名也跟着变了（`sessions/<cwd编码>/…`），原 rel 上
      // 根本没有这个文件 —— 再去 stat 会直接抛错。这种情况内容已经落到别处，
      // 冲突按「已解决」处理即可。
      if (!existsSync(localAbs)) {
        this.deps.store.conflicts = this.deps.store.conflicts.filter((x) => x.rel !== rel);
        this.deps.store.snapshot.conflictCount = this.deps.store.conflicts.length;
        this.deps.store.save();
        return;
      }
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
