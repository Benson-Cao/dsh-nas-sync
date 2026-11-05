/**
 * dsh-nas-sync · 白名单扫描（r3：按分类勾选）
 * -------------------------------------------
 * rel 一律相对 $DSH_HOME/.dsh，远端路径 = '<remoteRoot>/' + rel，
 * 本地路径 = join(.dsh, rel)，三元一一对应。
 *
 * r3 起「哪些子树参与同步」不再写死，而是由配置里的 `syncScope` 逐类勾选决定；
 * 分类元数据（label/desc/sensitive）集中在这里，状态查询与工具描述都复用同一份，
 * 避免「工具说支持 A、扫描器却不认 A」这类漂移。
 */

import { readdir, stat, readFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { dshHome, localOf, relFromRemote } from '../paths.js';
import { DEFAULT_SYNC_SCOPE, type SyncScope, type SyncScopeKey } from '../config.js';
import { collectWorkspaceDirs, walkWorkspaceFiles, walkCustomFolder, DEFAULT_MAX_FILE_BYTES, selfDevice, type WorkspaceDir, type CustomFolderLike } from './portable.js';

// ManifestEntry 统一定义在 data/models.ts（带 device 字段）。
// 这里曾有一份同名副本，导致 scanner 写出的条目缺 device 而编译器不报错。
import type { ManifestEntry } from '../data/models.js';
export type { ManifestEntry };

/** 一个同步分类的静态元数据。key 与 config 的 syncScope 一一对应。 */
export interface CategoryMeta {
  key: SyncScopeKey;
  /** 相对 ~/.dsh 的目录或文件 */
  localDir: string;
  label: string;
  desc: string;
  /** 可能携带凭据：勾选后仍需 includeSensitive 才带上内部的 .credentials 等 */
  sensitive: boolean;
}

/**
 * 分类表（顺序即界面展示顺序）。
 * 拆得比旧版细：会话标题单独一项（它很小却决定会话列表是否有名字），
 * settings.yaml 与 cordis.patch.yml 分开（前者含密钥、后者只是插件装配）。
 */
export const SYNC_CATEGORIES: CategoryMeta[] = [
  { key: 'sessions', localDir: 'sessions', label: '会话记录', desc: 'sessions/ 下的对话内容', sensitive: false },
  { key: 'workspaces', localDir: 'storages/workspace.json', label: '工作区清单', desc: '侧栏的工作区/文件夹名与会话归属；拉取时合并并自动映射路径', sensitive: false },
  /**
   * 注意：这一项的 localDir 只是「名义前缀」，实际扫的是注册表里每个工作区的真实目录
   * （手机上它们在 $DSH_HOME 之外），见 Scanner#manifestOfWorkspaceFiles。
   * 但 rel 空间一律记作 `workspaces/<名字>/…`，因此拉取端不需要任何特殊处理。
   */
  { key: 'workspaceFiles', localDir: 'workspaces', label: '工作区文件', desc: '每个工作区目录里的源码等文件（跳过 node_modules、.git 等）', sensitive: false },
  { key: 'customFolders', localDir: 'custom-folders', label: '自定义文件夹', desc: '额外指定的任意目录，名字相同即对应同一份数据，本机路径各自设置', sensitive: false },
  { key: 'sessionTitles', localDir: 'session-titles.json', label: '会话标题', desc: '会话列表的标题索引', sensitive: false },
  { key: 'attachments', localDir: 'attachments', label: '附件', desc: 'attachments/ 图片与文件，通常最大', sensitive: false },
  { key: 'skills', localDir: 'skills', label: '技能', desc: 'skills/ 自定义技能', sensitive: false },
  { key: 'profiles', localDir: 'profiles', label: 'Profile 与插件', desc: 'profiles/ 插件配置，可能含插件凭据', sensitive: true },
  { key: 'settings', localDir: 'settings.yaml', label: '主设置', desc: 'settings.yaml，可能含 API Key 明文', sensitive: true },
  { key: 'pluginPatch', localDir: 'cordis.patch.yml', label: '插件补丁', desc: 'cordis.patch.yml 插件装配层', sensitive: true },
];

export function categoryByKey(key: SyncScopeKey): CategoryMeta | undefined {
  return SYNC_CATEGORIES.find((c) => c.key === key);
}

/** 同步规则：由分类表 + 勾选状态推导出来。 */
export interface Rule {
  key: SyncScopeKey;
  /** 相对 ~/.dsh 的目录/文件，如 'sessions'、'settings.yaml' */
  localDir: string;
  sensitive?: boolean;
}

/** 旧行为等价物：未显式给 scope 时按默认勾选推导。 */
export const DEFAULT_RULES: Rule[] = SYNC_CATEGORIES
  .filter((c) => DEFAULT_SYNC_SCOPE[c.key])
  .map((c) => ({ key: c.key, localDir: c.localDir, sensitive: c.sensitive }));

const SENSITIVE_NAMES = ['.credentials.yaml', '.credentials', '.env', '.token'];

/** 递归遍历目录下的普通文件（跳过运行时垃圾）。扫描与统计共用同一份过滤规则。 */
export async function* walkFiles(dir: string): AsyncGenerator<string> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const full = join(dir, name);
    let st;
    try {
      st = await stat(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'nas-sync') continue;
      yield* walkFiles(full);
    } else {
      if (name.endsWith('.base') || name.endsWith('.chunk-manifest.json')) continue;
      if (name.endsWith('.lock')) continue; // 运行时锁文件，不参与同步
      yield full;
    }
  }
}

export class Scanner {
  private includeSensitive: boolean;
  private rules: Rule[];
  private scope: SyncScope;
  private skillFilter: string[];
  private customFolders: CustomFolderLike[];
  private maxFileBytes: number;

  /**
   * @param opts.scope            分类勾选（缺省 = DEFAULT_SYNC_SCOPE）
   * @param opts.includeSensitive 已选分类**内部**是否连凭据文件一起同步
   * @param opts.skillFilter      技能白名单（空 = 全部，见 config.ts 的语义说明）
   * @param opts.customFolders    自定义文件夹映射表（名字 + 本机路径）
   * @param opts.maxFileBytes     单文件上限，超过直接跳过（见 portable.ts 的说明）
   * @param opts.rules            直接指定规则（测试用；给了就不看 scope）
   */
  constructor(opts: {
    scope?: Partial<SyncScope>;
    includeSensitive?: boolean;
    skillFilter?: string[];
    customFolders?: CustomFolderLike[];
    maxFileBytes?: number;
    rules?: Rule[];
  } = {}) {
    this.includeSensitive = opts.includeSensitive ?? false;
    this.scope = { ...DEFAULT_SYNC_SCOPE, ...(opts.scope ?? {}) } as SyncScope;
    this.skillFilter = opts.skillFilter ?? [];
    this.customFolders = opts.customFolders ?? [];
    this.maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.rules = opts.rules ?? this.rulesFromScope();
  }

  /** 勾选的分类 → 规则表。注意：这里**不**用 includeSensitive 过滤整体分类。 */
  private rulesFromScope(): Rule[] {
    return SYNC_CATEGORIES
      .filter((c) => this.scope[c.key] !== false)
      .map((c) => ({ key: c.key, localDir: c.localDir, sensitive: c.sensitive }));
  }

  /** 当前生效的规则（只读，供状态/日志展示）。 */
  activeRules(): Rule[] {
    return this.rules.map((r) => ({ ...r }));
  }

  private isSensitive(rel: string): boolean {
    const base = rel.split('/').pop() ?? '';
    if (SENSITIVE_NAMES.some((s) => base === s)) return true;
    // profiles 下的凭据文件
    return rel.startsWith('profiles/') && SENSITIVE_NAMES.some((s) => base.endsWith(s));
  }

  /**
   * 技能白名单判定（实现见模块级 skillAllowed）。
   */
  private skillAllowed(rel: string): boolean {
    return skillAllowed(rel, this.skillFilter);
  }

  private async* walk(dir: string): AsyncGenerator<string> {
    yield* walkFiles(dir);
  }

  async buildManifest(): Promise<ManifestEntry[]> {
    const base = dshHome();
    const out: ManifestEntry[] = [];
    for (const rule of this.rules) {
      // 工作区文件是唯一「目录来源不是 rule.localDir」的分类，单独走一条支线
      if (rule.key === 'workspaceFiles') {
        out.push(...(await this.manifestOfWorkspaceFiles(base)));
        continue;
      }
      // 自定义文件夹同理：目录来自配置里的映射表，不是 $DSH_HOME/custom-folders
      if (rule.key === 'customFolders') {
        out.push(...(await this.manifestOfCustomFolders()));
        continue;
      }
      const local = resolve(base, rule.localDir);
      let st;
      try {
        st = await stat(local);
      } catch {
        continue;
      }
      if (st.isFile()) {
        const rel = rule.localDir;
        if (!this.includeSensitive && this.isSensitive(rel)) continue;
        out.push(await this.toEntry(local, rel));
        continue;
      }
      for await (const file of this.walk(local)) {
        // rel = 相对 ~/.dsh
        const rel = file.slice(base.length + 1).split(/[\\/]/).join('/');
        if (!this.includeSensitive && this.isSensitive(rel)) continue;
        if (!this.skillAllowed(rel)) continue;
        out.push(await this.toEntry(file, rel));
      }
    }
    return out;
  }

  /**
   * 「工作区文件」的清单。
   *
   * 工作区的真实目录来自 `storages/workspace.json`，不是 `$DSH_HOME/workspaces`
   * —— 手机上的工作区在 home 之外的 `/data/.../home/wstest`。两端都折算成
   * `workspaces/<名字>/…` 这个 rel 前缀，所以拉取端 localOf(rel) 天然落到
   * 合并清单时映射出来的同一目录，无需引擎特判。
   */
  private async manifestOfWorkspaceFiles(base: string): Promise<ManifestEntry[]> {
    const out: ManifestEntry[] = [];
    let dirs: WorkspaceDir[];
    try {
      dirs = await collectWorkspaceDirs(base);
    } catch {
      return out;
    }
    for (const ws of dirs) {
      try {
        for await (const f of walkWorkspaceFiles(ws)) {
          if (!this.includeSensitive && this.isSensitive(f.rel)) continue;
          out.push(await this.toEntry(f.file, f.rel));
        }
      } catch {
        /* 单个工作区读不了（权限/被占用）不该让整轮扫描失败 */
      }
    }
    return out;
  }

  /**
   * 「自定义文件夹」的清单。
   *
   * 目录来自配置里的映射表（`name → 本机 path`），本机没有这个目录就跳过 ——
   * 典型场景是另一台机器刚配好映射、还没把文件拉下来，此时不该报错。
   */
  private async manifestOfCustomFolders(): Promise<ManifestEntry[]> {
    const out: ManifestEntry[] = [];
    for (const folder of this.customFolders) {
      let st;
      try {
        st = await stat(folder.path);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      try {
        for await (const f of walkCustomFolder(folder, this.maxFileBytes)) {
          if (!this.includeSensitive && this.isSensitive(f.rel)) continue;
          out.push(await this.toEntry(f.file, f.rel));
        }
      } catch {
        /* 单个目录读不了（权限/被占用）不该让整轮扫描失败 */
      }
    }
    return out;
  }

  private async toEntry(file: string, rel: string): Promise<ManifestEntry> {
    const s = statSync(file);
    const buf = await readFile(file);
    return {
      rel,
      mtime: s.mtimeMs,
      size: s.size,
      hash: createHash('sha256').update(buf).digest('hex'),
      // 扫描到即认为「本机拥有/上传了它」。engine 写远端清单时会用「内容没变就
      // 保留原来源」的规则把它改回真正的上传方，所以这里填本机是安全的。
      device: selfDevice(),
    };
  }
}

/**
 * 按分类统计清单（供 nas_sync_status 展示「每个勾选项到底带了多少文件」）。
 * 未命中的 rel（理论上不会有）归到 __unknown 里，便于发现规则缺口。
 */
export function countByCategory(entries: ManifestEntry[]): Record<string, { files: number; bytes: number }> {
  const stats: Record<string, { files: number; bytes: number }> = {};
  for (const c of SYNC_CATEGORIES) stats[c.key] = { files: 0, bytes: 0 };
  stats.__unknown = { files: 0, bytes: 0 };
  for (const e of entries) {
    // 最长前缀匹配，避免 'sessions' 命中 'sessions-archive'
    const hit = SYNC_CATEGORIES
      .filter((c) => e.rel === c.localDir || e.rel.startsWith(c.localDir + '/'))
      .sort((a, b) => b.localDir.length - a.localDir.length)[0];
    const bucket = stats[hit ? hit.key : '__unknown'];
    bucket.files += 1;
    bucket.bytes += e.size;
  }
  return stats;
}

export type CategorySummary = Record<SyncScopeKey, { files: number; bytes: number }>;

/**
 * 轻量统计：只 stat、不读内容、不算 hash。
 *
 * 用途是「勾选预览」——用户要看到「关掉附件能省多少」才有判断依据。
 * 不能复用 buildManifest()：它对每个文件 `readFile` 算 sha256，attachments 一大就是
 * 几百 MB 的读盘，光为了显示一个数字不值得。
 */
export async function summarizeCategories(opts: { scope: Partial<SyncScope>; includeSensitive?: boolean; skillFilter?: string[]; customFolders?: CustomFolderLike[] }): Promise<CategorySummary> {
  const scope = { ...DEFAULT_SYNC_SCOPE, ...opts.scope } as SyncScope;
  const out = {} as CategorySummary;
  for (const c of SYNC_CATEGORIES) out[c.key] = { files: 0, bytes: 0 };
  const sc = new Scanner({ scope, includeSensitive: opts.includeSensitive, skillFilter: opts.skillFilter, customFolders: opts.customFolders });
  for (const rule of sc.activeRules()) {
    // 工作区文件：目录来源是注册表里的真实路径，stat 名义前缀会算出假数字
    if (rule.key === 'workspaceFiles') {
      try {
        for (const ws of await collectWorkspaceDirs(dshHome())) {
          for await (const f of walkWorkspaceFiles(ws)) {
            try {
              const fs2 = await stat(f.file);
              out[rule.key].files += 1;
              out[rule.key].bytes += fs2.size;
            } catch { /* 忽略消失的文件 */ }
          }
        }
      } catch { /* 注册表读不了就当 0 */ }
      continue;
    }
    // 自定义文件夹：目录来自配置映射表，同样不能 stat 名义前缀
    if (rule.key === 'customFolders') {
      for (const folder of opts.customFolders ?? []) {
        try {
          for await (const f of walkCustomFolder(folder)) {
            const s = await stat(f.file);
            out[rule.key].files += 1;
            out[rule.key].bytes += s.size;
          }
        } catch { /* 忽略不可读目录 */ }
      }
      continue;
    }
    const local = resolve(dshHome(), rule.localDir);
    let st;
    try { st = await stat(local); } catch { continue; }
    if (st.isFile()) {
      out[rule.key].files += 1;
      out[rule.key].bytes += st.size;
      continue;
    }
    for await (const f of walkFiles(local)) {
      // 统计也要走白名单，否则「关掉几个技能能省多少」显示的数字是假的
      const rel = f.slice(dshHome().length + 1).split(/[\\/]/).join('/');
      if (!skillAllowed(rel, opts.skillFilter ?? [])) continue;
      try {
        const fs2 = await stat(f);
        out[rule.key].files += 1;
        out[rule.key].bytes += fs2.size;
      } catch { /* 忽略消失的文件 */ }
    }
  }
  return out;
}

export interface SkillInfo {
  /** skills/ 下的一级目录名，即技能标识 */
  name: string;
  files: number;
  bytes: number;
}

/**
 * 技能白名单判定（纯函数，便于单测与复用）。
 *
 * rel 形如 `skills/<名字>/SKILL.md`，只按**一级目录名**匹配：
 * `skills/a/b/c.md` 都归 `a` 这个技能管，免得用户勾一个技能还得逐级勾子目录。
 * 空白名单 = 全部放行（默认行为，也是「全勾」归一化后的表示）。
 */
export function skillAllowed(rel: string, filter: string[]): boolean {
  if (!filter || filter.length === 0) return true;
  const parts = rel.split('/');
  if (parts[0] !== 'skills' || parts.length < 2) return true;
  return filter.includes(parts[1]);
}

/**
 * 列出本机 `skills/` 下的技能（一级目录），带文件数与体积。
 *
 * 面板要渲染「每个技能一个勾选框」，名字必须来自**设备真实存在的目录**，
 * 不能靠前端写死 —— 用户装了什么技能只有设备知道。
 * 体积是给用户判断「取消这个能省多少」用的，所以只 stat 不读内容。
 */
export async function listSkills(): Promise<SkillInfo[]> {
  const dir = resolve(dshHome(), 'skills');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: SkillInfo[] = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const full = join(dir, name);
    let st;
    try { st = await stat(full); } catch { continue; }
    if (!st.isDirectory()) continue;
    let files = 0;
    let bytes = 0;
    for await (const f of walkFiles(full)) {
      try {
        const s = await stat(f);
        files += 1;
        bytes += s.size;
      } catch { /* 忽略消失的文件 */ }
    }
    out.push({ name, files, bytes });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}



/** 远端路径（/dsh/<rel>）-> 本地绝对路径（= join(.dsh, rel)）。 */
export function remoteToLocal(remote: string): string {
  return localOf(relFromRemote(remote));
}
