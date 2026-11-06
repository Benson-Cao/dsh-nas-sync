/**
 * dsh-nas-sync · 跨设备可移植性（工作区清单 + 会话 cwd）
 * -------------------------------------------------------
 * 会话记录和工作区清单里存的都是**绝对路径**，直接拿到另一台设备上用会撞两堵墙：
 *
 *   1. `storages/workspace.json` 是工作区注册表，缺了它侧栏里工作区名字全丢，
 *      同步过来的会话只能落到「未分组」。
 *   2. 会话头 `session.v<N>.jsonl.zstd` 里固化了 `cwd`，例如手机上
 *      `/data/user/0/com.dsh.harness/files/home/wstest`。到 Windows 上这个路径
 *      不存在，跑一轮就报 `working-directory does not exist`。
 *
 * 而且 dsh 明确**拒绝「换一个 cwd 打开老会话」**：
 *   `ApiSessionCwdConflict: session "X" belongs to "A", not "B"`
 * 取值优先级是 `projections.workingDirectory ?? header.cwd ?? 默认目录`，
 * 也就是说调用方临时指定 cwd 没用，必须把记录里的路径改成本机真实存在的目录。
 *
 * 本模块提供三件事：
 *   - `mapRemotePath()`        远端绝对路径 → 本机路径（本机已存在就原样保留）
 *   - `mergeWorkspaceRegistry()` 把同步来的工作区清单**合并**进本地，绝不覆盖本地条目
 *   - `rewriteSessionCwd()`    改写会话头里的 cwd（zstd 解压 → 改 JSON → 重新压缩）
 *
 * 设计取舍：映射目标是 `~/.dsh/workspaces/<名字>`，这样它仍然落在 $DSH_HOME 之内，
 * 后续「工作区文件」也能当成一个普通分类（rel 前缀 workspaces/）来同步，
 * 不需要给引擎引入「虚拟根目录」这种复杂度。
 */

import * as zlib from 'node:zlib';
import { readdir, readFile, writeFile, mkdir, stat, rename, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import * as os from 'node:os';
import { dshHome } from '../paths.js';

/**
 * zstd 同步 API 是 Node 22+ 才补齐的，而本包锁定的一些 `@types/node` 版本里
 * 还没有这两个声明。直接 `import { zstdCompressSync } from 'node:zlib'` 会让 tsc
 * 报「no exported member」，进而把本模块的导出类型整体退化成 any（连带下游一片
 * 假错误）。这里做一次显式类型桥接，并保留运行时可用性探测：宿主如果有、正常用；
 * 如果真没有（老 Node），走「不改写」的降级路径，绝不让同步整轮失败。
 */
const zstdImpl = zlib as unknown as {
  zstdCompressSync?: (buf: Uint8Array) => Buffer;
  zstdDecompressSync?: (buf: Uint8Array) => Buffer;
};

const zstdCompress: ((buf: Uint8Array) => Buffer) | null = zstdImpl.zstdCompressSync ?? null;
const zstdDecompress: ((buf: Uint8Array) => Buffer) | null = zstdImpl.zstdDecompressSync ?? null;

/** 工作区注册表：相对 $DSH_HOME。 */
export const WORKSPACE_REGISTRY_REL = 'storages/workspace.json';
/**
 * 映射后的工作区统一放在 $DSH_HOME 下，两个约束都踩过坑：
 *
 * ① **不能是 `workspaces/`** —— dsh 自己也把它当工作区根（实测它会往里创建
 *    `default-workspace/`），两边抢同一个目录会互相破坏。
 * ② **名字里不能有连字符** —— dsh 的会话目录名是 cwd 的编码（`-` 代表路径分隔符），
 *    解码时 `nas-sync-workspaces` 会被拆成三段 `nas/sync/workspaces`，路径对不上，
 *    会话就全部掉进「未分组」。实测换成不含 `-` 的名字后归属才正确。
 */
export const WORKSPACES_DIR = 'nassyncworkspaces';
/**
 * 工作区文件在 rel 空间的**协议**前缀，**不要**跟着 WORKSPACES_DIR 改。
 *
 * 这个前缀是已经上传到 NAS 的目录结构（`workspaces/<名字>/…`），改了等于让
 * 所有历史数据失联。它只影响「远端长什么样」，而 WORKSPACES_DIR 只影响
 * 「本机落在哪」，两者必须解耦。
 */
export const WORKSPACE_FILES_PREFIX = 'workspaces';

/** 会话正文文件名匹配（格式版本会涨，这里不写死 v4）。 */
const SESSION_FILE_RE = /^session\.v\d+\.jsonl\.zstd$/;
const SESSION_REL_RE = /^sessions\/[^/]+\/[^/]+\/session\.v\d+\.jsonl\.zstd$/;

export function isSessionRel(rel: string): boolean {
  return SESSION_REL_RE.test(rel);
}

export function isWorkspaceRegistryRel(rel: string): boolean {
  return rel === WORKSPACE_REGISTRY_REL;
}

/**
 * 本机的工作区注册表是否「已经可用」。
 *
 * 0.3.5：注册表下载守卫必须是**条件式**的。新机器第一次同步时本机还没有
 * `storages/workspace.json`，无条件跳过下载会让侧栏工作区名、会话归属全丢
 * —— `repairWorkspaceRegistry()` 在本机没有注册表时直接返回 0，兜不住。
 * 只有本机已有可用注册表时，才禁止再用远端覆盖合并。
 */
export function workspaceRegistryReady(home: string = dshHome()): boolean {
  try {
    const p = join(home, 'storages', 'workspace.json');
    if (!existsSync(p)) return false;
    const d = JSON.parse(readFileSync(p, 'utf-8'));
    const ids = d?.global?.workspaceIds;
    if (!Array.isArray(ids) || ids.length === 0) return false;
    if (d?.global?.initialized === false) return false;
    return true;
  } catch {
    return false;
  }
}

/** 取路径最后一段并清掉 Windows 非法字符，作为本地目录名。 */
function safeName(p: unknown): string {
  if (typeof p !== 'string' || p.length === 0) return 'workspace';
  const parts = p.split(/[\\/]+/).filter(Boolean);
  const base = parts.length > 0 ? parts[parts.length - 1] : '';
  const cleaned = base
    // `-` 也必须清掉：dsh 用 `-` 表示会话目录名里的路径分隔符，
    // 目录名自带连字符会让它还原出错误路径（见 WORKSPACES_DIR 的注释）。
    .replace(/[<>:"|?*\u0000-\u001f]/g, '_')
    .replace(/-+/g, '_')
    .replace(/[. ]+$/, '');
  return cleaned.length > 0 ? cleaned : 'workspace';
}

export interface MappedPath {
  /** 本机可用的绝对路径 */
  local: string;
  /** true = 这是映射出来的新位置（原路径在本机不存在） */
  mapped: boolean;
}

/**
 * 远端绝对路径 → 本机路径。
 * 本机已经有这个目录时**原样保留**（同机重同步不会把路径改掉）。
 */
export function mapRemotePath(remotePath: unknown, home: string = dshHome()): MappedPath {
  if (typeof remotePath === 'string' && remotePath.length > 0) {
    try {
      if (existsSync(remotePath)) return { local: remotePath, mapped: false };
    } catch {
      /* existsSync 对非法路径会抛，落到映射分支 */
    }
  }
  return { local: join(home, WORKSPACES_DIR, safeName(remotePath)), mapped: true };
}

/** 某个工作区目录在 rel 空间的挂载点，如 `/a/b/wstest` → `workspaces/wstest`。 */
export function workspaceRelOf(dirPath: string): string {
  return `${WORKSPACE_FILES_PREFIX}/${safeName(dirPath)}`;
}

/**
 * 这个目录能不能当成「工作区文件」的同步根。
 *
 * 必须挡住的几种致命情况：工作区 path 被写成家目录 / 盘符根 / $DSH_HOME 自身
 * 或其祖先 —— 一旦扫进去就是把整个用户目录（含 .ssh、AppData、.dsh 自己）
 * 打包加密上传，而且拉回来时按原来路径覆盖。宁可少同步，也不能放开这个口子。
 */
function isUnsafeWorkspaceRoot(dir: string, home: string): boolean {
  let norm: string;
  let h: string;
  try {
    norm = resolve(dir);
    h = resolve(home);
  } catch {
    return true; // 非法路径（空串、NUL 等）
  }
  // dir 就是 home，或 dir 是 home 的祖先（同步范围会盖住 .dsh 自己）
  if (norm === h || h === norm || h.startsWith(norm.endsWith(sep) ? norm : norm + sep)) return true;
  // 盘符根（`D:\`）/ 文件系统根（`/`）：分段数 ≤ 1 一律拒绝
  const segs = norm.split(/[\\/]+/).filter((s) => s.length > 0);
  return segs.length <= 1;
}

export interface WorkspaceDir {
  id: string;
  title: string;
  /** 本机实际目录 */
  dir: string;
  /** rel 空间挂载点（`workspaces/<名字>`） */
  rel: string;
}

/**
 * 从工作区注册表读出所有工作区的**实际目录**，供「工作区文件」分类扫描。
 *
 * 为什么不能直接扫 `$DSH_HOME/workspaces`：手机上的工作区在 home 之外的
 * `/data/user/0/.../home/wstest`，扫 `.dsh/workspaces` 会得到空集合，用户会以为
 * 「勾了工作区文件却什么都没同步」。所以真正的目录来源必须是注册表里的 path，
 * 再统一折算成 `workspaces/<名字>` 这个 rel 前缀。
 *
 * 兜底：注册表里没提到、但 `$DSH_HOME/workspaces` 下真实存在的目录也收进来
 * （清单可能还没同步过来，文件先同步过来时不该丢）。
 */
export async function collectWorkspaceDirs(home: string = dshHome()): Promise<WorkspaceDir[]> {
  const out: WorkspaceDir[] = [];
  const seenDir = new Set<string>();
  const seenRel = new Set<string>();

  const push = async (id: string, title: string, dir: string): Promise<void> => {
    if (typeof dir !== 'string' || dir.length === 0) return;
    if (isUnsafeWorkspaceRoot(dir, home)) return;
    let st;
    try {
      st = await stat(dir);
    } catch {
      return; // 目录不存在（典型：刚合完清单，文件还没拉下来）
    }
    if (!st.isDirectory()) return;
    const abs = resolve(dir);
    const rel = workspaceRelOf(abs);
    if (seenDir.has(abs) || seenRel.has(rel)) return;
    seenDir.add(abs);
    seenRel.add(rel);
    out.push({ id, title, dir: abs, rel });
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(home, WORKSPACE_REGISTRY_REL), 'utf8'));
  } catch {
    parsed = null;
  }
  const spaces = ((parsed as any)?.['tables']?.['workspaces'] ?? {}) as Record<string, any>;
  for (const [id, w] of Object.entries(spaces)) {
    const title = typeof w?.['title'] === 'string' ? (w['title'] as string) : '';
    await push(id, title, w?.['path']);
  }

  // 兜底：$DSH_HOME/workspaces 下已存在的一级目录
  let names: string[] = [];
  try {
    names = await readdir(join(home, WORKSPACES_DIR));
  } catch {
    names = [];
  }
  for (const name of names) {
    if (name.startsWith('.')) continue;
    await push('', name, join(home, WORKSPACES_DIR, name));
  }

  return out;
}

/** 工作区文件里不该进同步的东西：包管理缓存与版本库元数据，体积大且跨机无意义。 */
const WORKSPACE_SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '__pycache__', '.venv', 'venv',
  '.next', '.nuxt', '.turbo', '.cache', 'nas-sync',
]);

/**
 * 单文件大小上限（默认 64 MiB）。超过就跳过，不再尝试读进来。
 *
 * 这不是省磁盘，是保命：
 *   · 大文件要整块读进内存再 scrypt+secretbox 加密，几百 MB 就能把宿主进程拖死；
 *   · Electron 对**任何路径里带 `.asar` 的文件**都会当成归档去解析，一个 116 MB 的
 *     `app.patched.asar`（asar 打包产物，常见于构建目录）会让 `Failed to parse
 *     header` 刷满 debug.log，而且每次 stat/read 都触发一次。
 * 真要同步大文件，用户可以把它放进 attachments 分类（那条链路走分块上传）。
 */
export const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;

/** Electron 会把 `.asar` 当归档；`stat`/`read` 都会触发解析，直接不碰。 */
export function isElectronAsarPath(p: string): boolean {
  return /\.asar$/i.test(p);
}

/**
 * 遍历一个工作区目录，产出 `[rel 空间路径, 本地绝对路径]`。
 * rel 一定以 `workspaces/<名字>/` 开头 —— 拉取端 resolveLocal(rel) 直接落到同一位置。
 */
export async function* walkWorkspaceFiles(
  ws: WorkspaceDir,
  maxBytes: number = DEFAULT_MAX_FILE_BYTES,
): AsyncGenerator<{ rel: string; file: string }, void, void> {
  yield* walkInto(ws.dir, ws.rel, 0, maxBytes);
}

async function* walkInto(
  dir: string,
  relBase: string,
  depth: number,
  maxBytes: number,
): AsyncGenerator<{ rel: string; file: string }, void, void> {
  if (depth > 24) return; // 防符号链接环 / 病态深目录
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
      if (WORKSPACE_SKIP_DIRS.has(name)) continue;
      yield* walkInto(full, `${relBase}/${name}`, depth + 1, maxBytes);
      continue;
    }
    if (!st.isFile()) continue; // 跳过 socket / fifo
    if (isElectronAsarPath(full)) continue;
    if (st.size > maxBytes) continue;
    if (name.endsWith('.base') || name.endsWith('.chunk-manifest.json') || name.endsWith('.lock')) continue;
    yield { rel: `${relBase}/${name}`, file: full };
  }
}

// ---------------------------------------------------------------------------
// 自定义文件夹（每台机器各自的「名字 → 本机路径」映射）
// ---------------------------------------------------------------------------

/** 自定义文件夹在 rel 空间的前缀。 */
export const CUSTOM_FOLDERS_PREFIX = 'custom-folders';

/** `name` → rel 挂载点，如 `custom-folders/projects`。 */
export function customFolderRelOf(name: string): string {
  return `${CUSTOM_FOLDERS_PREFIX}/${name}`;
}

export interface CustomFolderLike {
  name: string;
  path: string;
}

/**
 * 按 rel 里的 `<name>` 找出本机的落点。
 *
 * 这是「各自指定映射」的关键：远端只有 `custom-folders/projects/a.md`，
 * 至于这个 `projects` 在电脑上是 `D:\Projects`、在手机上是别的目录，
 * 完全由**本机配置**决定，所以同一条同步记录能在两台结构不同的机器上各就各位。
 *
 * @returns null 表示 rel 不属于自定义文件夹，或本机没配这个名字
 */
export function customFolderLocalOf(
  rel: string,
  folders: CustomFolderLike[],
): { local: string; folder: CustomFolderLike } | null {
  const prefix = CUSTOM_FOLDERS_PREFIX + '/';
  if (!rel.startsWith(prefix)) return null;
  const rest = rel.slice(prefix.length);
  if (rest.length === 0) return null;
  const slash = rest.indexOf('/');
  const name = slash === -1 ? rest : rest.slice(0, slash);
  const sub = slash === -1 ? '' : rest.slice(slash + 1);
  const folder = folders.find((f) => f.name === name);
  if (!folder || folder.path.length === 0) return null;
  // sub 来自 rel，可能含 ../（恶意/损坏的远端清单），这里必须挡住
  if (sub.split('/').some((seg) => seg === '..' || seg === '')) return null;
  return { local: sub.length === 0 ? folder.path : join(folder.path, sub), folder };
}

/** 扫一个自定义文件夹目录，产出 rel = `custom-folders/<name>/…`。 */
export async function* walkCustomFolder(
  folder: CustomFolderLike,
  maxBytes: number = DEFAULT_MAX_FILE_BYTES,
): AsyncGenerator<{ rel: string; file: string }, void, void> {
  yield* walkInto(folder.path, customFolderRelOf(folder.name), 0, maxBytes);
}

/**
 * 会话文件是**追加式的多帧 zstd**：每写一批记录就 append 一个新 frame。
 * 而 node:zlib 的 `zstdDecompressSync` 和 `createZstdDecompress()` 都**只解第一帧**
 * 就停（实测：一个 2035 字节、13 帧、合计 2789 字节内容的会话文件，同步解压只
 * 拿到 224 字节的表头）。所以「整文件解开 → 改 → 整文件压缩」这种写法会把会话
 * 历史截成只剩表头 —— 必须先算出帧边界，并且**只重写第一帧**，后面所有追加帧
 * 原样保留，历史字节一个都不动。
 *
 * 帧格式（RFC 8878 §3）：
 *   magic(4) | Frame_Header_Descriptor(1) | [Window_Descriptor(1)]
 *   [Dictionary_ID(0/1/2/4)] [Frame_Content_Size(0/1/2/4/8)] | blocks… | [checksum(4)]
 *   block: header(3) = last(1 bit) type(2 bit) size(21 bit)
 *          type 0=Raw / 1=RLE（载荷只有 1 字节）/ 2=Compressed
 */
const ZSTD_MAGIC = 0xfd2fb528;

function zstdFrameEnd(buf: Buffer, start: number): number {
  if (buf.length - start < 8) throw new Error('zstd: 缓冲区过短');
  if (buf.readUInt32LE(start) !== ZSTD_MAGIC) throw new Error('zstd: magic 不匹配');
  let p = start + 4;
  const fhd = buf[p] as number;
  p += 1;
  const fcsFlag = fhd >> 6;
  const singleSegment = (fhd >> 5) & 1;
  const hasChecksum = (fhd >> 2) & 1;
  const dictFlag = fhd & 3;
  if (singleSegment === 0) p += 1; // Window_Descriptor
  p += [0, 1, 2, 4][dictFlag] ?? 0;
  const fcsSize = fcsFlag === 0 ? (singleSegment === 1 ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8;
  p += fcsSize;

  for (;;) {
    if (p + 3 > buf.length) throw new Error('zstd: block header 越界');
    const bh = (buf[p] as number) | ((buf[p + 1] as number) << 8) | ((buf[p + 2] as number) << 16);
    p += 3;
    const last = bh & 1;
    const type = (bh >> 1) & 3;
    const size = bh >>> 3;
    if (type === 3) throw new Error('zstd: 保留 block 类型');
    p += type === 1 ? 1 : size; // RLE 载荷固定 1 字节
    if (p > buf.length) throw new Error('zstd: block 越界');
    if (last === 1) break;
  }
  if (hasChecksum === 1) p += 4;
  if (p > buf.length) throw new Error('zstd: checksum 越界');
  return p;
}

/** 只解第一帧（表头）。任何解析异常都返回 null —— 宁可不改，也不能截断历史。 */
function decodeFirstFrame(buf: Buffer): string | null {
  if (zstdDecompress === null) return null;
  try {
    const end = zstdFrameEnd(buf, 0);
    return zstdDecompress(buf.subarray(0, end)).toString('utf8');
  } catch {
    return null;
  }
}

/** 会话头（第一行）里的 cwd，读不到就返回 null。 */
function readHeaderCwd(buf: Buffer): { header: Record<string, unknown>; rest: string } | null {
  const text = decodeFirstFrame(buf);
  if (text === null) return null;
  const nl = text.indexOf('\n');
  const headLine = nl === -1 ? text : text.slice(0, nl);
  let header: unknown;
  try {
    header = JSON.parse(headLine);
  } catch {
    return null;
  }
  if (typeof header !== 'object' || header === null) return null;
  const h = header as Record<string, unknown>;
  if (h['type'] !== 'session' || typeof h['cwd'] !== 'string') return null;
  return { header: h, rest: nl === -1 ? '' : text.slice(nl) };
}


export interface SessionRewrite {
  /** 重新压缩后的会话文件内容 */
  buf: Buffer;
  /** 映射出来的本地目录（调用方负责 mkdir） */
  dir: string;
}

/**
 * 把会话头里的 cwd 改写成本机路径。
 *
 * **只替换第一帧**，其余追加帧逐字节保留 —— 会话历史不会因为这次改写而重新
 * 编码（也就没有「解压不完整导致丢记录」的风险）。
 *
 * @returns null 表示这个会话不用动（cwd 本机已存在 / 不是会话文件 / 解析不了）
 */
export function rewriteSessionCwd(buf: Buffer, home: string = dshHome()): SessionRewrite | null {
  if (zstdCompress === null) return null; // 老 Node：降级为「不改写」，不能让同步炸掉
  const parsed = readHeaderCwd(buf);
  if (!parsed) return null;
  const { local, mapped } = mapRemotePath(parsed.header['cwd'], home);
  if (!mapped) return null;

  let end: number;
  try {
    end = zstdFrameEnd(buf, 0);
  } catch {
    return null;
  }

  parsed.header['cwd'] = local;
  const headFrame = zstdCompress(Buffer.from(JSON.stringify(parsed.header) + parsed.rest, 'utf8'));
  return { buf: Buffer.concat([headFrame, buf.subarray(end)]), dir: local };
}

/** 只读地取会话头里的 cwd（给状态展示/诊断用）。 */
export function sessionCwdOf(buf: Buffer): string | null {
  const parsed = readHeaderCwd(buf);
  return parsed && typeof parsed.header['cwd'] === 'string' ? (parsed.header['cwd'] as string) : null;
}

export interface RegistryMergeResult {
  added: number;
  remapped: number;
  total: number;
  /** 合并后被清掉的跨工作区重复 session 归属数 */
  deduped: number;
}

/**
 * 全局收敛 session 归属：一个 sessionId 只能属于一个工作区。
 *
 * dsh 的 `WorkspaceRegistry.validateStoredState()` 会把「同一 session 被两个
 * workspace 同时记账」判成 `workspace domain is inconsistent`，抛错后
 * `workspace` 插件不激活 → `workspaceRegistry` 服务缺失 →
 * `workspace-controller` / `session-controller` / `schedule` 全部 pending，
 * gateway 侧就报 `active Service "workspaceController" is unavailable`
 * （表象是侧栏工作区全空、新建文件夹失败）。
 *
 * 合并逻辑按 **workspace id** 并集 sessionIds，两个 id 可能指向同一个
 * 同名工作区（例如同步映射出来的 wstest 与本机原生 wstest），并集后必然
 * 产生重复归属。所以在任何写回前统一做一次全局去重。
 *
 * 保留优先级 = `global.workspaceIds` 的顺序（即用户看到的侧栏顺序），
 * 表里但不在 workspaceIds 里的 id 追加到最后。绝不删工作区、只删重复引用。
 */
export function dedupeWorkspaceSessions(local: Record<string, any>): number {
  const tables = local?.['tables'];
  const workspaces = tables?.['workspaces'];
  if (!workspaces || typeof workspaces !== 'object') return 0;

  const globals = (local['global'] ?? {}) as Record<string, any>;
  const listed: unknown = globals['workspaceIds'];
  const ids = Object.keys(workspaces as Record<string, any>);
  const order: string[] = [];
  if (Array.isArray(listed)) {
    for (const id of listed) if (typeof id === 'string' && ids.includes(id)) order.push(id);
  }
  for (const id of ids) if (!order.includes(id)) order.push(id);

  const seen = new Set<string>();
  let removed = 0;
  for (const id of order) {
    const w = (workspaces as Record<string, any>)[id] as Record<string, any>;
    const raw: unknown = w?.['sessionIds'];
    if (!Array.isArray(raw)) continue;
    const keep: string[] = [];
    const within = new Set<string>();
    for (const s of raw) {
      const sid = typeof s === 'string' ? s : String(s);
      if (seen.has(sid) || within.has(sid)) {
        removed += 1;
        continue;
      }
      seen.add(sid);
      within.add(sid);
      keep.push(sid);
    }
    w['sessionIds'] = keep;
  }
  return removed;
}

export interface RegistryNormalizeResult {
  /** 被合并掉的重复工作区条目数 */
  merged: number;
  /** 清掉的重复 session 归属数 */
  removed: number;
  /** 修正的 registry order 条目数（重复/缺失引用/orphan） */
  orderFixed: number;
}

/**
 * 把注册表收敛到 dsh `validateStoredState()` 能通过的状态。
 *
 * 宿主的四条硬规则（实测来自 @deepseek-ai/dsh-workspace/lib/index.js）：
 *   ① workspaceIds 不得重复，且每个 id 必须在 workspaces 表里
 *   ② initialized 时表里每个 id 都必须出现在 workspaceIds 里（无 orphan）
 *   ③ 任意两个工作区的 path 不得相同
 *   ④ 任意 sessionId 不得被两个工作区同时记账
 *
 * 双向同步时两个不同 id、同名的工作区（一个是本机原生、一个是远端映射
 * 到 nassyncworkspaces 的副本）会同时存在 → ③④ 必炸 → workspace 插件
 * 不激活 → workspaceController 服务不可用（侧栏全空、无法新建文件夹）。
 *
 * 收敛策略（保守，不删任何目录/会话文件）：
 *   - 同名（忽略大小写）或同 path 的条目合并，保留 workspaceIds 里靠前的
 *   - path 优先挑「不是同步映射目录」的那个，也就是本机真实工作区
 *   - 被合并条目的 sessionIds 并进保留条目，再全局去重
 *   - 修正 workspaceIds 顺序与 defaultWorkspaceId
 */
export function normalizeWorkspaceRegistry(local: Record<string, any>): RegistryNormalizeResult {
  const tables = local?.['tables'];
  const workspaces = tables?.['workspaces'] as Record<string, any> | undefined;
  if (!workspaces || typeof workspaces !== 'object') {
    return { merged: 0, removed: 0, orderFixed: 0 };
  }

  const globals = (local['global'] ?? (local['global'] = {})) as Record<string, any>;
  const listed: unknown = globals['workspaceIds'];
  const ids: string[] = [];
  if (Array.isArray(listed)) {
    for (const id of listed) {
      if (typeof id === 'string' && workspaces[id] && !ids.includes(id)) ids.push(id);
    }
  }
  for (const id of Object.keys(workspaces)) if (!ids.includes(id)) ids.push(id);

  const isMapped = (p: unknown): boolean =>
    typeof p === 'string' && p.includes(WORKSPACES_DIR);

  // union-find：同名或同 path 归一组
  const parent = new Map<string, string>(ids.map((id) => [id, id]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r) as string;
    return r;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  const byTitle = new Map<string, string>();
  const byPath = new Map<string, string>();
  for (const id of ids) {
    const w = workspaces[id] as Record<string, any>;
    const title = String(w?.['title'] ?? '').trim().toLowerCase();
    const path = w?.['path'];
    if (title) {
      const prev = byTitle.get(title);
      if (prev) union(prev, id);
      else byTitle.set(title, id);
    }
    if (typeof path === 'string') {
      const prev = byPath.get(path);
      if (prev) union(prev, id);
      else byPath.set(path, id);
    }
  }

  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const root = find(id);
    const arr = groups.get(root) ?? [];
    arr.push(id);
    groups.set(root, arr);
  }

  const keep: string[] = [];
  let merged = 0;
  for (const [, members] of groups) {
    const keeper = members[0] as string;
    keep.push(keeper);
    if (members.length < 2) continue;
    // 本机真实工作区优先于同步映射出来的空壳目录
    const real = members.find((m) => !isMapped((workspaces[m] as Record<string, any>)['path']));
    if (real && real !== keeper) {
      (workspaces[keeper] as Record<string, any>)['path'] =
        (workspaces[real] as Record<string, any>)['path'];
    }
    const seen = new Set<string>();
    const sessionIds: string[] = [];
    for (const m of members) {
      const raw = (workspaces[m] as Record<string, any>)['sessionIds'];
      if (!Array.isArray(raw)) continue;
      for (const s of raw) {
        const sid = typeof s === 'string' ? s : String(s);
        if (!seen.has(sid)) { seen.add(sid); sessionIds.push(sid); }
      }
    }
    (workspaces[keeper] as Record<string, any>)['sessionIds'] = sessionIds;
    for (const m of members.slice(1)) { delete workspaces[m]; merged += 1; }
  }

  const oldIds = Array.isArray(listed) ? listed : [];
  const orderChanged =
    oldIds.length !== keep.length || oldIds.some((id, i) => id !== keep[i]);
  globals['workspaceIds'] = keep;
  const orderFixed = (orderChanged ? 1 : 0) + merged;
  if (typeof globals['defaultWorkspaceId'] !== 'string' || !keep.includes(globals['defaultWorkspaceId'])) {
    globals['defaultWorkspaceId'] = keep[0] ?? null;
  }
  globals['initialized'] = true;
  globals['archivedSessionIds'] ??= [];
  globals['pinnedSessionIds'] ??= [];

  const removed = dedupeWorkspaceSessions(local);
  return { merged, removed, orderFixed };
}

/** 自愈：把本机现存注册表直接收敛到合法状态（原子写，幂等）。 */
export async function repairWorkspaceRegistry(
  home: string = dshHome(),
): Promise<RegistryNormalizeResult> {
  const localPath = join(home, WORKSPACE_REGISTRY_REL);
  let text: string;
  try {
    text = await readFile(localPath, 'utf8');
  } catch {
    return { merged: 0, removed: 0, orderFixed: 0 };
  }
  let local: Record<string, any>;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return { merged: 0, removed: 0, orderFixed: 0 };
    local = parsed as Record<string, any>;
  } catch {
    return { merged: 0, removed: 0, orderFixed: 0 };
  }
  const result = normalizeWorkspaceRegistry(local);
  if (result.merged === 0 && result.removed === 0 && result.orderFixed === 0) return result;
  const tmp = localPath + '.nas-sync.tmp';
  await writeFile(tmp, JSON.stringify(local, null, 2) + '\n');
  await rename(tmp, localPath);
  return result;
}

/**
 * 合并同步来的工作区注册表。
 *
 * 规则（保守，绝不丢本地数据）：
 *   - 本地没有的 id → 原样收下，但 path 换成本机映射路径（并 mkdir）
 *   - 本地已有的 id → **保留本地 path/title**，只并集 sessionIds；
 *     若本地条目的 path 本身在本机不存在（上一轮同步进来的手机路径），顺手修掉
 *   - 本地 defaultWorkspaceId 已有就不动
 *   - 写回前全局去重 session 归属（见 dedupeWorkspaceSessions）
 */
export async function mergeWorkspaceRegistry(
  remoteText: string,
  home: string = dshHome(),
): Promise<RegistryMergeResult> {
  let remote: unknown;
  try {
    remote = JSON.parse(remoteText);
  } catch {
    return { added: 0, remapped: 0, total: 0, deduped: 0 };
  }

  const localPath = join(home, WORKSPACE_REGISTRY_REL);
  let local: Record<string, any>;
  try {
    const parsed = JSON.parse(await readFile(localPath, 'utf8'));
    local = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, any>) : {};
  } catch {
    local = {};
  }

  local['unit'] ??= { name: 'workspace', version: 2 };
  local['global'] ??= { initialized: true };
  const globals = local['global'] as Record<string, any>;
  globals['workspaceIds'] ??= [];
  globals['archivedSessionIds'] ??= [];
  globals['pinnedSessionIds'] ??= [];
  local['tables'] ??= {};
  const tables = local['tables'] as Record<string, any>;
  tables['workspaces'] ??= {};
  const workspaces = tables['workspaces'] as Record<string, any>;

  const remoteWorkspaces =
    ((remote as Record<string, any>)?.['tables']?.['workspaces'] as Record<string, any>) ?? {};

  let added = 0;
  let remapped = 0;

  for (const [id, raw] of Object.entries(remoteWorkspaces)) {
    const rw = (raw ?? {}) as Record<string, any>;
    const existing = workspaces[id] as Record<string, any> | undefined;

    if (existing !== undefined) {
      // 已存在：只并会话归属
      const set = new Set<string>(Array.isArray(existing['sessionIds']) ? existing['sessionIds'] : []);
      for (const s of Array.isArray(rw['sessionIds']) ? rw['sessionIds'] : []) set.add(String(s));
      existing['sessionIds'] = [...set];

      // 本地条目路径在本机不存在 → 修成映射路径
      const currentPath = existing['path'];
      const badPath =
        typeof currentPath !== 'string' || currentPath.length === 0 || !existsSync(currentPath);
      if (badPath) {
        const m = mapRemotePath(currentPath ?? rw['path'], home);
        await mkdir(m.local, { recursive: true });
        existing['path'] = m.local;
        remapped += 1;
      }
      if (!globals['workspaceIds'].includes(id)) globals['workspaceIds'].push(id);
      continue;
    }

    const m = mapRemotePath(rw['path'], home);
    await mkdir(m.local, { recursive: true });
    workspaces[id] = {
      ...rw,
      path: m.local,
      sessionIds: Array.isArray(rw['sessionIds']) ? [...rw['sessionIds']] : [],
    };
    if (!globals['workspaceIds'].includes(id)) globals['workspaceIds'].push(id);
    added += 1;
  }

  globals['initialized'] ??= true;
  if (!globals['defaultWorkspaceId'] && globals['workspaceIds'].length > 0) {
    globals['defaultWorkspaceId'] = globals['workspaceIds'][0];
  }

  // 关键：按 id 并集之后，两个不同 id 的工作区可能同名/同 path，或同时
  // 记着同一个 session。dsh 的 validateStoredState 四条规定任一不满足就
  // 拒绝激活 workspace 插件，侧栏全空 + workspaceController 服务不可用。
  // 写回前必须做一次完整收敛。
  const norm = normalizeWorkspaceRegistry(local);
  const deduped = norm.removed + norm.merged;

  await mkdir(join(home, 'storages'), { recursive: true });
  /**
   * 原子写：先写同目录临时文件再 rename。
   *
   * workspace.json 是 dsh 运行时也在读的注册表。原来直接 `writeFile` 会先截断再写，
   * 如果 dsh 正好在这个窗口里读，拿到的是半截 JSON —— registry 初始化抛错会顺着
   * 依赖链把 workspaceController 一起带走（表现是「无法选择文件夹，服务不可用」）。
   * rename 在同一分区上是原子的，读方要么看到旧版本、要么看到新版本。
   */
  const tmp = localPath + '.nas-sync.tmp';
  await writeFile(tmp, JSON.stringify(local, null, 2) + '\n');
  await rename(tmp, localPath);
  return { added, remapped, total: Object.keys(workspaces).length, deduped };
}

export interface RepairResult {
  fixed: number;
  scanned: number;
}

/**
 * 把已经落在本地的同步会话逐个检查一遍：cwd 在本机不存在就改写。
 * 幂等——改完的文件下次读到 `mapRemotePath().mapped === false`，直接跳过。
 */
/**
 * 本机设备标识，形如 `win32:DESKTOP-ABC` / `android:V2458A`。
 *
 * 为什么用「平台:主机名」而不是随机 UUID：主机名对人可读，出问题时一眼能对上
 * 是哪台机器；平台前缀则让前端不用额外查就能选对 emoji。同名不同机的情况
 * 在个人使用场景里可以忽略（真撞了也只是 emoji 标错，不影响同步）。
 */
export function selfDevice(): string {
  let host = '';
  try {
    host = os.hostname();
  } catch {
    /* 某些沙箱没有 hostname，退回默认值 */
  }
  const clean = host.replace(/[^\w.-]/g, '').slice(0, 24) || 'device';
  // Android 上的 Node 常常报 platform='linux'（Termux/嵌入式 Node 都是），
  // 那样前端会显示 🐧 而不是 📱。用 Android 独有环境变量纠正。
  const plat = process.platform === 'linux' && (process.env.ANDROID_ROOT || process.env.ANDROID_DATA)
    ? 'android'
    : process.platform;
  return plat + ':' + clean;
}

/** 设备标识 → 前端用的平台前缀（`win32:xxx` → `win32`）。 */
export function devicePlatform(device: string | undefined): string {
  if (!device) return '';
  const i = device.indexOf(':');
  return i === -1 ? device : device.slice(0, i);
}

/**
 * 把绝对路径编码成 dsh 的会话目录名。
 *
 * 规则（用两个真实样本反推验证过）：
 *   ① 非 ASCII 字符 → `~` + 四位大写十六进制（**前缀式**，结尾不带 `~`）
 *      例：`胎教Agent` → `~80CE~6559Agent`
 *   ② 连续的 `\` `/` `:` 合并成一个 `-`
 *   ③ 去掉首尾的 `-`，整体再包一层 `--`
 *
 * 为什么必须精确：dsh 打开会话时会核对「目录名是不是 cwd 的编码」，对不上就
 * 自己"修复"——实测会把两个编码拼成一个畸形目录名（`--旧cwd-新cwd--`）。
 * 所以改了 cwd 就必须同时改目录名，否则一定踩坑。
 *
 * ⚠️ 推论：工作区目录名里**不能有连字符**，否则解码时会被当成路径分隔符
 * （`nas-sync-workspaces` → `nas/sync/workspaces`）。见 WORKSPACES_DIR。
 */
export function encodeCwd(p: string): string {
  const ascii = p.replace(/[^\x20-\x7e]/g, (c) =>
    '~' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'),
  );
  const body = ascii.replace(/[\\/:]+/g, '-').replace(/^-+/, '').replace(/-+$/, '');
  return '--' + body + '--';
}

/**
 * 判断一个 cwd 是否属于「另一种平台」，是就别往本机落。
 *
 * 踩过的坑：电脑上改写过的会话（cwd = `C:\...\wstest`）被同步到手机，
 * 手机上这个路径当然不存在，dsh 一扫描就把整个会话列表搞挂（更糟的是会掉进
 * 「未分组」）。反过来也一样。所以跨平台同步时，这类会话直接跳过而不是硬塞。
 */
export function platformMismatch(p: string): boolean {
  if (typeof p !== 'string' || p.length === 0) return true;
  const looksWindows = /^[A-Za-z]:[\\/]/.test(p);
  const looksPosix = p.startsWith('/');
  if (process.platform === 'win32') return looksPosix && !looksWindows;
  return looksWindows;
}

export async function repairSessionCwd(home: string = dshHome()): Promise<RepairResult> {
  const root = join(home, 'sessions');
  let workspaceDirs: string[];
  try {
    workspaceDirs = await readdir(root);
  } catch {
    return { fixed: 0, scanned: 0 };
  }

  let fixed = 0;
  let scanned = 0;

  for (const dir of workspaceDirs) {
    if (!dir.startsWith('--')) continue;
    const wdir = join(root, dir);
    let sessionDirs: string[];
    try {
      sessionDirs = await readdir(wdir);
    } catch {
      continue;
    }
    for (const sid of sessionDirs) {
      const sdir = join(wdir, sid);
      let files: string[];
      try {
        files = await readdir(sdir);
      } catch {
        continue;
      }
      for (const name of files) {
        if (!SESSION_FILE_RE.test(name)) continue;
        const file = join(sdir, name);
        let buf: Buffer;
        try {
          buf = await readFile(file);
        } catch {
          continue;
        }
        scanned += 1;
        const out = rewriteSessionCwd(buf, home);
        if (!out) continue;
        await mkdir(out.dir, { recursive: true });

        /**
         * 目录名必须跟着 cwd 一起迁移。
         *
         * 只改内容不改目录名的后果：dsh 打开会话时发现「目录名 ≠ cwd 编码」，
         * 会自己动手"修复"，把两个编码拼成 `--旧-新--` 这种畸形名（真出现过）。
         * 所以这里要么原地不动（cwd 没变），要么连目录一起搬。
         */
        const wantDir = encodeCwd(out.dir);
        const target = join(root, wantDir, sid, name);
        if (target === file) {
          await writeFile(file, out.buf);
          fixed += 1;
          continue;
        }
        await mkdir(join(root, wantDir, sid), { recursive: true });
        await writeFile(target, out.buf);
        // 旧位置的副本会让同一会话出现两次，必须清掉（只删这个 session 目录）
        try {
          await rm(sdir, { recursive: true, force: true });
        } catch {
          /* 删不掉也不影响，下次还能再修 */
        }
        fixed += 1;
      }
    }
  }

  return { fixed, scanned };
}

/**
 * 跨 cwd 目录的会话 id 去重（0.3.3）。
 *
 * 故障现场：下载会话时 `rewriteSessionCwd()` 会把远端的绝对路径映射成本机
 * `~/.dsh/nassyncworkspaces/<name>`，而本机同一个 sessionId 可能早就存在于
 * 真实工作区目录里。`dsh-session-persistence-jsonl` 的 `listArtifacts()` 一旦
 * 发现同一个 id 出现在多个 project directory，就直接抛
 *   duplicate JSONL session id "..." appears in multiple project directories
 * → workspace 插件不激活 → workspaceController / sessionController 全部 pending
 * → 侧栏工作区与会话全空、无法新建文件夹。
 *
 * `repairSessionCwd()` 对「cwd 已经映射过且本机存在」的会话是幂等跳过的，
 * 所以那两份目录会永久共存，必须在收尾单独收敛。
 *
 * 策略：**只移动、不删除**。非权威副本整体搬进
 * `~/.dsh/.suspect-quarantine/sessions-dup-<ts>/<dir>/<sid>`，随时可还原。
 * 权威目录优先级：注册表 workspace.path 的 cwd 编码 > 带 session.lock > 字典序最小。
 */
export interface SessionDirDedupeResult {
  /** 扫到的有效会话目录数（有 session.v*.jsonl.zstd 才算） */
  scanned: number;
  /** 出现重复的 sessionId 数 */
  duplicates: number;
  /** 已搬进隔离区的重复副本数 */
  isolated: number;
}

export async function dedupeSessionDirs(home: string = dshHome()): Promise<SessionDirDedupeResult> {
  const root = join(home, 'sessions');
  const result: SessionDirDedupeResult = { scanned: 0, duplicates: 0, isolated: 0 };

  let projectDirs: string[];
  try {
    projectDirs = (await readdir(root)).filter((d) => d.startsWith('--'));
  } catch {
    return result;
  }

  // 注册表里的工作区路径 → cwd 编码目录，作为「权威目录」的首选
  const preferred = new Set<string>();
  try {
    const reg = JSON.parse(await readFile(join(home, WORKSPACE_REGISTRY_REL), 'utf8'));
    const table = reg?.tables?.workspaces ?? {};
    for (const w of Object.values<any>(table)) {
      if (typeof w?.path === 'string') preferred.add(encodeCwd(w.path));
    }
  } catch {
    /* 注册表读不到就退化成 lock / 字典序优先级 */
  }

  const bySid = new Map<string, { dir: string; hasLock: boolean }[]>();
  for (const dir of projectDirs) {
    const wdir = join(root, dir);
    let sessionDirs: string[];
    try {
      sessionDirs = await readdir(wdir);
    } catch {
      continue;
    }
    for (const sid of sessionDirs) {
      let files: string[];
      try {
        files = await readdir(join(wdir, sid));
      } catch {
        continue;
      }
      // 只有 session.lock 的空壳不算，避免把历史残留误判成重复
      if (!files.some((f) => SESSION_FILE_RE.test(f))) continue;
      result.scanned += 1;
      if (!bySid.has(sid)) bySid.set(sid, []);
      bySid.get(sid)!.push({ dir, hasLock: files.includes('session.lock') });
    }
  }

  const rank = (e: { dir: string; hasLock: boolean }): number =>
    preferred.has(e.dir) ? 0 : e.hasLock ? 1 : 2;

  let quarantine = '';
  for (const [sid, entries] of bySid) {
    if (entries.length < 2) continue;
    result.duplicates += 1;
    const sorted = [...entries].sort(
      (a, b) => rank(a) - rank(b) || a.dir.localeCompare(b.dir),
    );
    for (const loser of sorted.slice(1)) {
      if (!quarantine) {
        quarantine = join(home, '.suspect-quarantine', 'sessions-dup-' + Date.now());
        await mkdir(quarantine, { recursive: true });
      }
      try {
        await mkdir(join(quarantine, loser.dir), { recursive: true });
        await rename(join(root, loser.dir, sid), join(quarantine, loser.dir, sid));
        result.isolated += 1;
      } catch {
        /* 搬不动就留着，下一轮再试；绝不 rm 用户数据 */
      }
    }
  }

  return result;
}
