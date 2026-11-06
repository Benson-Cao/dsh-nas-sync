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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
}

const LOG_CAP = 16 * 1024;

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

export class Installer {
  private jobs = new Map<string, InstallJob>();
  private seq = 0;

  constructor(private readonly profilesRoot: () => string) {}

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
    const cli = resolveCliScript();
    if (!cli) throw new Error('这台设备上没有可用的 dsh CLI，无法自动安装（可以复制命令手动执行）');
    const items2 = items.filter((i) => i && i.target && i.name);
    if (items2.length === 0) throw new Error('没有可安装的插件');
    const busy = this.running();
    if (busy) throw new Error(`已有安装任务在进行中（${busy.profile}）`);

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
}
