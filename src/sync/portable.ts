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
import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
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
 * 映射后的工作区统一放在 $DSH_HOME/workspaces 下，不污染 home 根目录。
 *
 * 这个选择同时解决了两件事：① 映射目标仍然是 $DSH_HOME 的子目录，所以工作区
 * **文件**不需要给同步引擎引入「虚拟根目录」；② 手机上的工作区目录（如
 * `/data/user/0/com.dsh.harness/files/home/wstest`）与电脑上的映射目录，在 rel
 * 空间里都收敛成同一个前缀 `workspaces/<名字>`，两端算法一致就不会错位。
 */
export const WORKSPACES_DIR = 'workspaces';
/** 工作区文件在 rel 空间的前缀（= $DSH_HOME/workspaces）。 */
export const WORKSPACE_FILES_PREFIX = WORKSPACES_DIR;

/** 会话正文文件名匹配（格式版本会涨，这里不写死 v4）。 */
const SESSION_FILE_RE = /^session\.v\d+\.jsonl\.zstd$/;
const SESSION_REL_RE = /^sessions\/[^/]+\/[^/]+\/session\.v\d+\.jsonl\.zstd$/;

export function isSessionRel(rel: string): boolean {
  return SESSION_REL_RE.test(rel);
}

export function isWorkspaceRegistryRel(rel: string): boolean {
  return rel === WORKSPACE_REGISTRY_REL;
}

/** 取路径最后一段并清掉 Windows 非法字符，作为本地目录名。 */
function safeName(p: unknown): string {
  if (typeof p !== 'string' || p.length === 0) return 'workspace';
  const parts = p.split(/[\\/]+/).filter(Boolean);
  const base = parts.length > 0 ? parts[parts.length - 1] : '';
  const cleaned = base
    .replace(/[<>:"|?*\u0000-\u001f]/g, '_')
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
 * 遍历一个工作区目录，产出 `[rel 空间路径, 本地绝对路径]`。
 * rel 一定以 `workspaces/<名字>/` 开头 —— 拉取端 localOf(rel) 直接落到同一位置。
 */
export async function* walkWorkspaceFiles(
  ws: WorkspaceDir,
): AsyncGenerator<{ rel: string; file: string }, void, void> {
  yield* walkInto(ws.dir, ws.rel, 0);
}

async function* walkInto(
  dir: string,
  relBase: string,
  depth: number,
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
      yield* walkInto(full, `${relBase}/${name}`, depth + 1);
      continue;
    }
    if (!st.isFile()) continue; // 跳过 socket / fifo
    if (name.endsWith('.base') || name.endsWith('.chunk-manifest.json') || name.endsWith('.lock')) continue;
    yield { rel: `${relBase}/${name}`, file: full };
  }
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
}

/**
 * 合并同步来的工作区注册表。
 *
 * 规则（保守，绝不丢本地数据）：
 *   - 本地没有的 id → 原样收下，但 path 换成本机映射路径（并 mkdir）
 *   - 本地已有的 id → **保留本地 path/title**，只并集 sessionIds；
 *     若本地条目的 path 本身在本机不存在（上一轮同步进来的手机路径），顺手修掉
 *   - 本地 defaultWorkspaceId 已有就不动
 */
export async function mergeWorkspaceRegistry(
  remoteText: string,
  home: string = dshHome(),
): Promise<RegistryMergeResult> {
  let remote: unknown;
  try {
    remote = JSON.parse(remoteText);
  } catch {
    return { added: 0, remapped: 0, total: 0 };
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

  await mkdir(join(home, 'storages'), { recursive: true });
  await writeFile(localPath, JSON.stringify(local, null, 2) + '\n');
  return { added, remapped, total: Object.keys(workspaces).length };
}

export interface RepairResult {
  fixed: number;
  scanned: number;
}

/**
 * 把已经落在本地的同步会话逐个检查一遍：cwd 在本机不存在就改写。
 * 幂等——改完的文件下次读到 `mapRemotePath().mapped === false`，直接跳过。
 */
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
        await writeFile(file, out.buf);
        fixed += 1;
      }
    }
  }

  return { fixed, scanned };
}
