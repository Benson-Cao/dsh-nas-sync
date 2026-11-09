/**
 * 插件安装执行器。
 *
 * 只做一件事：把「对账算出来的缺失插件」交给宿主自己的 CLI 去装 ——
 *   dsh plugin --profile <名字> add <包>@<版本>
 * 不自己拼 pnpm 参数、不直接改 node_modules：profile 的目录结构、workspace
 * 链接、平台相关依赖解析都交给宿主，避免把 profile 改坏。
 *
 * 装机后还要补一步：把包名登记进 `dsh.profile.bundles`。
 * CLI 只是把参数转给 pnpm，不会改这段声明；不登记的话包装上了但不会被激活。
 */
import { spawn } from 'node:child_process';
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { unpackTgz } from './tgz.js';
import { recordsForTarget, currentTarget, type PluginAssembly } from './plugin-objects.js';
import type { PluginObjectRecord } from '../data/models.js';

export type InstallState = 'running' | 'done' | 'failed';

/** 一项待安装的插件：`target` 传给 pnpm，`name` 用于装完登记 bundles。 */
export interface InstallItem {
  name: string;
  target: string;
}

export interface InstallJob {
  id: string;
  profile: string;
  targets: string[];
  state: InstallState;
  code: number | null;
  log: string;
  startedAt: number;
  endedAt: number | null;
  /** 安装成功后自动登记进 bundles 的包名 */
  registered: string[];
  /** 0.6.0 / 收尾④：这次任务走的是宿主 CLI 还是 CAS 解包 */
  source: 'cli' | 'cas';
}

/** 插件对象源：只负责按内容指纹取对象与给出装配清单，不关心落盘。 */
export interface CasSource {
  getObject(hash: string): Promise<Uint8Array | null>;
  assemblies(): Promise<PluginAssembly[]> | PluginAssembly[];
}

export interface CasInstallResult {
  installed: string[];
  skipped: Array<{ name: string; reason: string }>;
  registered: string[];
  rejectedPaths: number;
}

const LOG_CAP = 16 * 1024;
const DEFAULT_CAS_MAX_BYTES = 128 * 1024 * 1024;

/**
 * 定位宿主 CLI。
 *
 * 桌面端布局固定：`<exe 目录>/resources/app.asar/dsh/node_modules/@deepseek-ai/
 * dsh-desktop-host/lib/cli.js`。注意这个路径**在 asar 内部**，只有 Electron 的
 * 打过补丁的 fs 才看得见 —— 所以这里不直接判定内层文件，而是判外层 `app.asar`
 * 这个真实文件是否存在，避免在普通 node 环境下误判成「没有 CLI」。
 *
 * 找不到（如手机端没有这套运行时）返回 null：面板会退化成「只给命令，不代装」，
 * 这是预期行为而不是错误。
 */
export function resolveCliScript(): string | null {
  const exe = process.execPath;
  if (!exe) return null;
  const appAsar = join(dirname(exe), 'resources', 'app.asar');
  try {
    if (!existsSync(appAsar)) return null;
  } catch {
    return null;
  }
  return join(
    appAsar,
    'dsh',
    'node_modules',
    '@deepseek-ai',
    'dsh-desktop-host',
    'lib',
    'cli.js',
  );
}

/** 读 profile 的 package.json（找不到/坏掉返回 null）。 */
function readProfileJson(profileDir: string): any {
  try {
    return JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 把装好的、声明了 `dsh.bundle.patch` 的包登记进 `dsh.profile.bundles`。
 * 返回实际新增的名字。任何一步失败都只跳过，不影响安装结果。
 */
export function registerBundles(profileDir: string, installed: string[]): string[] {
  const pkg = readProfileJson(profileDir);
  if (!pkg) return [];
  const want: string[] = [];
  for (const name of installed) {
    try {
      const pj = JSON.parse(readFileSync(join(profileDir, 'node_modules', name, 'package.json'), 'utf8'));
      if (pj?.dsh?.bundle?.patch) want.push(name);
    } catch {
      /* 没装上或没有 bundle 声明：跳过 */
    }
  }
  if (want.length === 0) return [];
  const dsh = (pkg.dsh ??= {});
  const prof = (dsh.profile ??= {});
  const bundles: string[] = Array.isArray(prof.bundles) ? prof.bundles : (prof.bundles = []);
  const added: string[] = [];
  for (const name of want) {
    if (!bundles.includes(name)) {
      bundles.push(name);
      added.push(name);
    }
  }
  if (added.length === 0) return [];
  try {
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  } catch {
    return [];
  }
  return added;
}

/**
 * 0.6.0 / 收尾④：从 CAS 对象直接解包安装（手机端没有宿主 CLI 时的主路径）。
 *
 * 每一步都 fail-closed：对象指纹对不上、路径不安全、解包体积超限，一律跳过
 * 这个包而不是写出半份 `node_modules`。写盘用「临时目录 → 移走旧目录 →
 * 原子重命名」，中途失败会回滚旧目录，不会留下装了一半的插件。
 */
export async function installFromCas(
  profileDir: string,
  records: ReadonlyArray<PluginObjectRecord>,
  source: CasSource,
  opts: { maxBytes?: number; now?: number } = {},
): Promise<CasInstallResult> {
  const maxBytes = Math.max(1024, Number(opts.maxBytes ?? DEFAULT_CAS_MAX_BYTES));
  const now = Number.isFinite(opts.now) ? Number(opts.now) : Date.now();
  const root = resolve(profileDir, 'node_modules');
  const installed: string[] = [];
  const skipped: CasInstallResult['skipped'] = [];
  let rejectedPaths = 0;
  let n = 0;

  for (const rec of records) {
    const name = String(rec?.name ?? '').trim();
    const hash = String(rec?.objectHash ?? '').toLowerCase();
    if (!name || !/^[0-9a-f]{64}$/.test(hash)) {
      skipped.push({ name: name || '(空)', reason: '包名或对象指纹非法' });
      continue;
    }
    // 路径边界：scoped 包名（`@scope/pkg`）也要落在 node_modules 之内
    const target = resolve(root, ...name.split('/'));
    if (!target.startsWith(root + sep)) {
      skipped.push({ name, reason: '包名越出 node_modules' });
      continue;
    }
    let buf: Uint8Array | null;
    try {
      buf = await source.getObject(hash);
    } catch (err) {
      skipped.push({ name, reason: '读取对象失败：' + String(err) });
      continue;
    }
    if (!buf || buf.length === 0) {
      skipped.push({ name, reason: 'CAS 里没有这个对象' });
      continue;
    }
    if (buf.length > maxBytes) {
      skipped.push({ name, reason: '对象超过大小上限 ' + maxBytes });
      continue;
    }
    const actual = createHash('sha256').update(Buffer.from(buf)).digest('hex');
    if (actual !== hash) {
      skipped.push({ name, reason: '对象 sha256 与装配清单不符（拒绝解包）' });
      continue;
    }

    let unpacked;
    try {
      unpacked = unpackTgz(buf, { maxEntryBytes: maxBytes, maxTotalBytes: maxBytes * 2 });
    } catch (err) {
      skipped.push({ name, reason: '解包失败：' + String(err) });
      continue;
    }
    rejectedPaths += unpacked.rejected.length;
    if (unpacked.entries.length === 0) {
      skipped.push({ name, reason: '包体里没有可用文件' });
      continue;
    }

    const tmp = target + '.cas-tmp-' + process.pid + '-' + (++n);
    let backup: string | null = null;
    try {
      mkdirSync(tmp, { recursive: true });
      for (const e of unpacked.entries) {
        const dest = resolve(tmp, ...e.path.split('/'));
        // unpackTgz 已做过词法过滤，这里再用真实路径核一次，防止平台差异
        if (dest !== tmp && !dest.startsWith(tmp + sep)) {
          throw new Error('解包路径越界：' + e.path);
        }
        if (e.isDir) {
          mkdirSync(dest, { recursive: true });
        } else {
          mkdirSync(dirname(dest), { recursive: true });
          const mode = (e.mode & 0o777) || 0o644;
          writeFileSync(dest, Buffer.from(e.data), { mode });
        }
      }
      mkdirSync(root, { recursive: true });
      if (existsSync(target)) {
        backup = target + '.cas-bak-' + now + '-' + n;
        renameSync(target, backup);
      }
      renameSync(tmp, target);
      installed.push(name);
      if (backup) {
        try { rmSync(backup, { recursive: true, force: true }); } catch { /* 旧副本留着无妨 */ }
      }
    } catch (err) {
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
      if (backup && !existsSync(target)) {
        try { renameSync(backup, target); } catch { /* 回滚失败会在日志里留痕 */ }
      }
      skipped.push({ name, reason: '落盘失败（已回滚）：' + String(err) });
    }
  }

  // 与 CLI 路径完全一致：只有声明了 dsh.bundle.patch 的包才登记 bundles
  const registered = installed.length > 0 ? registerBundles(profileDir, installed) : [];
  return { installed, skipped, registered, rejectedPaths };
}

export class Installer {
  private jobs = new Map<string, InstallJob>();
  private seq = 0;

  constructor(
    private readonly profilesRoot: () => string,
    private readonly cas?: CasSource,
  ) {}

  /** 当前是否有任务在跑（同一时刻只允许一个，避免两个 pnpm 抢 profile 的锁）。 */
  running(): InstallJob | null {
    for (const j of this.jobs.values()) if (j.state === 'running') return j;
    return null;
  }

  get(id: string): InstallJob | undefined {
    return this.jobs.get(id);
  }

  list(): InstallJob[] {
    return [...this.jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  /**
   * 启动一次安装。`items` 里的 `target` 由 plugins.ts 的 installTarget() 生成，
   * 这里不再解析 spec；`name` 只用于装完登记 `dsh.profile.bundles`。
   */
  start(profile: string, items: InstallItem[]): InstallJob {
    const items2 = items.filter((i) => i && i.target && i.name);
    if (items2.length === 0) throw new Error('没有可安装的插件');
    const busy = this.running();
    if (busy) throw new Error(`已有安装任务在进行中（${busy.profile}）`);

    const cli = resolveCliScript();
    if (!cli) {
      // 0.6.0 / 收尾④：手机端没有宿主 CLI 时改走 CAS 解包，不再只给一条
      // 用户根本执行不了的命令。没有配置对象源才退回原来的报错。
      if (!this.cas) {
        throw new Error('这台设备上没有可用的 dsh CLI，也没有插件对象源（CAS），无法自动安装（可以复制命令手动执行）');
      }
      return this.startCas(profile, items2);
    }

    const targets = items2.map((i) => i.target);
    const names = items2.map((i) => i.name);
    const id = `job-${Date.now()}-${++this.seq}`;
    const job: InstallJob = {
      id,
      profile,
      targets,
      state: 'running',
      code: null,
      log: '',
      startedAt: Date.now(),
      endedAt: null,
      registered: [],
      source: 'cli',
    };
    this.jobs.set(id, job);

    const append = (chunk: Buffer | string) => {
      job.log += String(chunk);
      if (job.log.length > LOG_CAP) job.log = job.log.slice(-LOG_CAP);
    };

    let child;
    try {
      child = spawn(
        process.execPath,
        // 与 dsh.cmd 完全一致：--expose-internals + ELECTRON_RUN_AS_NODE，
        // 少一个参数宿主 CLI 可能起不来。
        ['--expose-internals', cli, 'plugin', '--profile', profile, 'add', ...targets],
        {
          cwd: this.profilesRoot(),
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
    } catch (e: any) {
      job.state = 'failed';
      job.endedAt = Date.now();
      job.log = `无法启动 dsh CLI：${e?.message ?? e}`;
      return job;
    }

    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', (e: any) => {
      job.state = 'failed';
      job.endedAt = Date.now();
      append(`\n启动失败：${e?.message ?? e}\n`);
    });
    child.on('close', (code: number | null) => {
      job.code = code;
      job.endedAt = Date.now();
      job.state = code === 0 ? 'done' : 'failed';
      if (code === 0) {
        const profileDir = join(this.profilesRoot(), profile);
        job.registered = registerBundles(profileDir, names);
        if (job.registered.length > 0) {
          append(`\n已登记到 dsh.profile.bundles：${job.registered.join(', ')}\n重启 DSH 后生效。\n`);
        } else {
          append('\n安装完成。若插件未出现，请重启 DSH。\n');
        }
      }
    });

    return job;
  }

  /**
   * 无 CLI 时的安装路径：按本机 `platform/arch/node-ABI` 找装配清单里对应的
   * CAS 对象，解包写 node_modules 并登记 bundles。与 CLI 路径一样是异步 job，
   * 面板通过 `get(id)` 轮询，不会阻塞请求。
   */
  private startCas(profile: string, items: InstallItem[]): InstallJob {
    const id = `job-${Date.now()}-${++this.seq}`;
    const job: InstallJob = {
      id,
      profile,
      targets: items.map((i) => i.target),
      state: 'running',
      code: null,
      log: '',
      startedAt: Date.now(),
      endedAt: null,
      registered: [],
      source: 'cas',
    };
    this.jobs.set(id, job);
    const append = (chunk: string) => {
      job.log += chunk;
      if (job.log.length > LOG_CAP) job.log = job.log.slice(-LOG_CAP);
    };
    const cas = this.cas!;

    void (async () => {
      try {
        const target = currentTarget();
        const assemblies = await cas.assemblies();
        const wanted = new Set(items.map((i) => i.name));
        const selected = recordsForTarget(assemblies, target).filter((r) => wanted.has(r.name));
        append(`\n本机 target=${target}；装配清单可用 ${assemblies.length} 个包，`
          + `本平台匹配 ${selected.length} 个对象\n`);
        const missing = [...wanted].filter((name) => !selected.some((r) => r.name === name));
        if (missing.length > 0) {
          append('以下包在本平台没有可用对象（需由另一台设备上传）：' + missing.join(', ') + '\n');
        }
        const result = await installFromCas(join(this.profilesRoot(), profile), selected, cas);
        job.registered = result.registered;
        for (const s of result.skipped) append(`跳过 ${s.name}：${s.reason}\n`);
        if (result.rejectedPaths > 0) {
          append(`解包时拒绝了 ${result.rejectedPaths} 个不安全条目（符号链接 / 越界路径）\n`);
        }
        append(`已安装 ${result.installed.length} 个包：${result.installed.join(', ') || '(无)'}\n`);
        if (result.registered.length > 0) {
          append(`已登记到 dsh.profile.bundles：${result.registered.join(', ')}\n重启 DSH 后生效。\n`);
        }
        job.code = result.installed.length > 0 && result.skipped.length === 0 ? 0 : 1;
        job.state = job.code === 0 ? 'done' : 'failed';
      } catch (e: any) {
        job.code = 1;
        job.state = 'failed';
        append('\nCAS 安装失败：' + String(e?.message ?? e) + '\n');
      } finally {
        job.endedAt = Date.now();
      }
    })();

    return job;
  }
}
