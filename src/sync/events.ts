/**
 * dsh-nas-sync · 事件日志 / 墓碑 / 设备位点（0.6.0 · P0）
 * ----------------------------------------------------------
 * 0.5.9 的删除传播靠「远端清单里这条连续两轮消失」来推断，天生有三个缺口：
 *   · 只有 `sessionImports` 里的跨平台会话镜像 + 本机屏蔽会话会被回收；
 *   · 普通文件（附件 / 技能 / 工作区文件）删除根本不传播；
 *   · 没有「谁删的、什么时候删的」，无法可靠区分删除与清单读失败。
 *
 * 0.6.0 改成**显式事件**：每台设备只往自己的日志分片追加不可变事件，读端合并
 * 所有分片、按时序回放，delete 事件生成墓碑；删除优先，但墓碑保留
 * `DEFAULT_RETENTION_DAYS` 天，期间可从回收副本恢复，过期才 GC。
 *
 * 本模块全部是**纯函数**（只吃数组 / 字符串，不碰 fs / 网络 / 宿主包），因此能进
 * 离线单测 —— 补上 0.5.8 审查里「删除传播没有任何单测」的那笔账。
 */

import { createHash } from 'node:crypto';
import type {
  SyncEvent, SyncEventOp, Tombstone, DeviceCursor,
  EventStreamTrust, ManifestEntry, BidMapEntry, VersionVector,
} from '../data/models.js';

/** 事件日志根目录：每台设备一个子目录，分片 JSONL。 */
export const EVENTS_DIR = '/dsh/events';
/** 墓碑总表（合并视图；可从事件流重建，允许任一端重写）。 */
export const TOMBSTONES_FILE = '/dsh/tombstones.json';
/** 设备位点：每台设备记自己读到别的设备哪个 seq。 */
export const CURSORS_DIR = '/dsh/cursors';
/** CAS 对象池（P3 大文件 / P4 插件包体共用）。 */
export const OBJECTS_DIR = '/dsh/objects';
/** 远端回收副本：delete 时把原对象搬到这里，保留期过后才真删。 */
export const TRASH_DIR = '/dsh/trash';
/** 会话稳定 ID ↔ rel 双向映射（P2）。 */
export const BIDMAP_FILE = '/dsh/bidmap.json';

/** 删除后回收副本默认保留天数。 */
export const DEFAULT_RETENTION_DAYS = 30;
/** 单个日志分片最多多少条；超过就开新片，避免一台设备的日志无限膨胀成单文件。 */
export const EVENT_SHARD_SIZE = 500;

const DAY_MS = 24 * 60 * 60 * 1000;
const VALID_OPS = new Set<SyncEventOp>([
  'upsert', 'delete', 'ignore', 'unignore', 'plugin-install', 'plugin-uninstall',
]);

/** 设备名 / key 安全化：只留安全字符，挡掉 `..` 与路径分隔符。 */
function safeName(raw: string): string {
  return (
    String(raw || '')
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .replace(/\.{2,}/g, '_')
      .slice(0, 64) || '_unknown'
  );
}

// ---------------------------------------------------------------------------
// 远端路径
// ---------------------------------------------------------------------------

/** 某台设备第 `shard` 片日志的远端路径。 */
export function eventLogFileOf(device: string, shard = 0): string {
  const s = Math.max(0, Math.floor(Number(shard) || 0));
  return EVENTS_DIR + '/' + safeName(device) + '/' + String(s).padStart(6, '0') + '.jsonl';
}

/** 第 `seq` 号事件落在哪个分片。 */
export function eventShardOf(seq: number): number {
  const n = Math.max(1, Math.floor(Number(seq) || 1));
  return Math.floor((n - 1) / EVENT_SHARD_SIZE);
}

export function cursorFileOf(device: string): string {
  return CURSORS_DIR + '/' + safeName(device) + '.json';
}

/** CAS 对象路径：两级散列避免单目录几万个文件。 */
export function objectPathOf(hash: string): string {
  const h = String(hash || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(h)) throw new Error('非法 CAS 指纹：' + String(hash).slice(0, 80));
  return OBJECTS_DIR + '/' + h.slice(0, 2) + '/' + h;
}

/** 回收副本路径：按日期分桶 + key + 时间戳，避免同名互相覆盖。 */
export function trashPathOf(key: string, at: number): string {
  const k = safeName(key).slice(0, 96);
  const date = new Date(Number.isFinite(at) ? at : Date.now()).toISOString().slice(0, 10);
  return TRASH_DIR + '/' + date + '/' + k + '-' + Math.floor(at);
}

// ---------------------------------------------------------------------------
// 稳定主键（P2 的纯函数层）
// ---------------------------------------------------------------------------

/** 会话 canonical rel：以 sid 为主键，不再把 cwd 编码进 rel。 */
export function canonicalSessionRel(sid: string, version = 1): string {
  return 'sessions/by-id/' + safeName(sid).slice(0, 96) + '/v' + Math.max(1, Math.floor(version));
}

/** 从会话 rel 里抽 sid：`sessions/<cwd>/<sid>/<file>` 或 canonical `sessions/by-id/<sid>/…`。 */
export function sessionIdFromRel(rel: string): string | null {
  const parts = String(rel || '').split('/');
  if (parts[0] !== 'sessions') return null;
  /**
   * 回收站里的副本不是会话本体（0.6.0 / 收尾②）。
   *
   * 它形如 `sessions/.sessions-trash/<ISO>---<cwd编码>---<sid>/session.v4.jsonl.zstd.trash`，
   * 倒数第二段是**回收站目录名**，照通用规则抽出来会得到
   * `session:2026-11-09T10-52-22.155Z---...---session-xxx` 这种假 sid ——
   * 既不会和真会话的墓碑对上，还会在事件流里长出一批永远无法回收的键。
   * 回收站条目不该参与会话归键，一律回落到 `rel:` 空间。
   */
  if (parts[1] === '.sessions-trash') return null;
  if (parts[1] === 'by-id' && parts.length >= 3) return parts[2] || null;
  if (parts.length < 4) return null;
  return parts[parts.length - 2] || null;
}

/**
 * 稳定主键：会话按 sid，插件按 `name@platform/abi`，其余按 rel。
 *
 * 这是「一端删除另一端也删除」能跨路径生效的关键：同一会话在两端 rel 不同
 * （cwd 编码不同），只有按 sid 归并才对得上。
 */
export function stableKeyOf(
  rel: string,
  opts: { sid?: string; plugin?: { name: string; platform: string; abi?: string } } = {},
): string {
  if (opts.plugin) {
    const p = opts.plugin;
    return 'plugin:' + p.name + '@' + p.platform + '/' + (p.abi || 'none');
  }
  const sid = opts.sid ?? sessionIdFromRel(rel);
  if (sid) return 'session:' + sid;
  return 'rel:' + rel;
}

/** 插件包体的目标串（P4）：`${platform}/${arch}/node-${abi}`。 */
export function pluginTarget(platform: string, arch: string, abi: string | number): string {
  return [platform, arch, 'node-' + String(abi)].join('/');
}

// ---------------------------------------------------------------------------
// 事件构造与校验
// ---------------------------------------------------------------------------

/**
 * 签名覆盖的固定字段顺序 —— 与对象属性插入顺序无关，JSON.parse 回来也能校验。
 *
 * 注意：`obs`（向量时钟）**故意不在签名范围内**。
 * 原因是跨版本互通：0.6.x 的读端按它自己那份字段表算签名，如果 0.7.0 把 `obs`
 * 也算进去，旧端会算出不同的哈希、把每条新事件判成「被篡改」→ `badSignatures`
 * 非空 → 整轮事件流不可信 → **旧端直接禁用删除传播**。为避免升级一半就炸，
 * `obs` 只做数据不做签名。事件日志本身从来就不是认证信道（能写 NAS 的人都能
 * 改），签名挡的是「半截写 / 手滑改坏」，不是恶意伪造 —— 这个取舍是划算的。
 */
const SIG_KEYS = [
  'v', 'device', 'seq', 'ts', 'key', 'rel', 'hash', 'op',
  'category', 'platform', 'retentionDays',
] as const;

/**
 * 版本向量的规范串：按设备名排序后拼 `d:seq`。
 *
 * 虽然不进签名，仍需要规范化形式：日志/测试里比较两个向量时不能受对象键序影响。
 * 空向量返回空串。
 */
export function canonicalVector(v: VersionVector | undefined | null): string {
  if (!v || typeof v !== 'object') return '';
  const keys = Object.keys(v).filter((k) => Number.isFinite(v[k])).sort();
  if (keys.length === 0) return '';
  return keys.map((k) => k + ':' + String(Math.floor(v[k]))).join(',');
}

function canonicalForSig(e: SyncEvent): string {
  const parts: string[] = [];
  for (const k of SIG_KEYS) {
    const v = (e as unknown as Record<string, unknown>)[k];
    if (v !== undefined && v !== null) parts.push(k + '=' + String(v));
  }
  return parts.join('\n');
}

/** 事件体校验和。 */
export function eventSignature(e: SyncEvent): string {
  return createHash('sha256').update(canonicalForSig(e)).digest('hex');
}

export interface MakeEventInput {
  device: string;
  seq: number;
  ts?: number;
  key: string;
  rel?: string;
  hash?: string;
  op: SyncEventOp;
  category?: string;
  platform?: string;
  retentionDays?: number;
  /** 写入时的因果前沿；传空对象等同于不传 */
  obs?: VersionVector;
}

/** 造一条自校验事件。所有写入端都必须走这里，禁止手写对象字面量。 */
export function makeEvent(input: MakeEventInput): SyncEvent {
  const e: SyncEvent = {
    v: 2,
    device: String(input.device || '_unknown'),
    seq: Math.max(1, Math.floor(Number(input.seq) || 1)),
    ts: Number.isFinite(input.ts) ? Math.floor(input.ts as number) : Date.now(),
    key: String(input.key || ''),
    op: input.op,
  };
  if (input.rel) e.rel = input.rel;
  if (input.hash) e.hash = input.hash;
  if (input.category) e.category = input.category;
  if (input.platform) e.platform = input.platform;
  if (Number.isFinite(input.retentionDays)) e.retentionDays = Math.max(0, Math.floor(input.retentionDays as number));
  const obs = normalizeVector(input.obs);
  if (obs) e.obs = obs;
  e.sig = eventSignature(e);
  return e;
}

/** 规范化版本向量：丢掉非正 / 非有限值，空结果返回 undefined（不写进事件）。 */
export function normalizeVector(v: VersionVector | undefined | null): VersionVector | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const out: VersionVector = {};
  let any = false;
  for (const k of Object.keys(v)) {
    const n = Math.floor(Number(v[k]));
    if (!k || !Number.isFinite(n) || n <= 0) continue;
    out[k] = n;
    any = true;
  }
  return any ? out : undefined;
}

/** 事件是否完整且未被篡改。半截写 / 手改 / 版本不对一律 false。 */
export function verifyEvent(e: unknown): e is SyncEvent {
  if (!e || typeof e !== 'object') return false;
  const r = e as unknown as Record<string, unknown>;
  if (r.v !== 2) return false;
  if (typeof r.device !== 'string' || !r.device) return false;
  if (!Number.isInteger(r.seq) || (r.seq as number) < 1) return false;
  if (!Number.isFinite(r.ts)) return false;
  if (typeof r.key !== 'string' || !r.key) return false;
  if (!VALID_OPS.has(r.op as SyncEventOp)) return false;
  if (typeof r.sig !== 'string' || !r.sig) return false;
  // obs 允许缺省（0.6.x 的历史事件）；一旦出现就必须是「设备名 → 正整数」
  if (r.obs !== undefined) {
    if (!r.obs || typeof r.obs !== 'object' || Array.isArray(r.obs)) return false;
    for (const [k, n] of Object.entries(r.obs as Record<string, unknown>)) {
      if (!k || !Number.isFinite(n) || (n as number) < 1) return false;
    }
  }
  try {
    return eventSignature(e as SyncEvent) === r.sig;
  } catch {
    return false;
  }
}

export function eventId(e: SyncEvent): string {
  return e.device + ':' + e.seq;
}

// ---------------------------------------------------------------------------
// 排序 / 合并
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 向量时钟：同一 key 上 delete / upsert 的胜负裁决
// ---------------------------------------------------------------------------

/**
 * 一条事件的完整时钟 = 写入时的观测前沿 ∪ {自己的 (device, seq)}。
 *
 * `obs` 只记「别人的进度」，自己的位置由 `(device, seq)` 表示 —— 两者相加
 * 才是一个完整的版本向量。旧事件没有 `obs`，退化成只含自己那一维，
 * 于是它与任何跨设备事件都「并发」，由下面的兜底规则处理。
 */
export function vectorClockOf(e: SyncEvent): VersionVector {
  const v: VersionVector = { ...(e.obs ?? {}) };
  v[e.device] = Math.max(v[e.device] ?? 0, e.seq);
  return v;
}

/** `a` 是否严格支配 `b`：每个维度都不小于，且至少一个维度更大。 */
export function dominates(a: VersionVector, b: VersionVector): boolean {
  let strictly = false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const x = a[k] ?? 0;
    const y = b[k] ?? 0;
    if (x < y) return false;
    if (x > y) strictly = true;
  }
  return strictly;
}

export type CausalOrder = 'after' | 'before' | 'concurrent' | 'equal';

/**
 * 两条事件的因果关系。
 *
 * `after` 表示 a 的作者**在写 a 之前已经见过 b** —— 这才是「更新」的正确含义。
 * `concurrent` 表示互相都没见过（离线各改各的、或时钟错乱导致的伪并发）。
 */
export function compareCausally(a: SyncEvent, b: SyncEvent): CausalOrder {
  if (a.device === b.device && a.seq === b.seq) return 'equal';
  const va = vectorClockOf(a);
  const vb = vectorClockOf(b);
  if (dominates(va, vb)) return 'after';
  if (dominates(vb, va)) return 'before';
  return 'concurrent';
}

/**
 * 同一毫秒 / 并发的确定性兜底顺序。
 *
 * 只在**语义相同**的两条事件之间用来挑代表（两条 delete、两条 upsert），
 * 保证两端算出来的代表完全一致 —— 不能让它变成「谁时钟快谁说了算」。
 */
function stableTieBreak(a: { ts: number; seq: number; device: string }, b: { ts: number; seq: number; device: string }): number {
  if (a.ts !== b.ts) return a.ts - b.ts;
  const d = String(a.device).localeCompare(String(b.device));
  if (d !== 0) return d;
  return a.seq - b.seq;
}

/** 参与「内容裁决」的操作：只有这两类会决定一个 key 是活的还是死的。 */
function isContentOp(op: SyncEventOp): boolean {
  return op === 'delete' || op === 'upsert' || op === 'plugin-install';
}

/**
 * 在一组同 key 的事件里挑出胜者。
 *
 * 规则（与墙钟彻底脱钩）：
 *   ① 先求「因果极大集」—— 被别的事件因果压过的直接淘汰；
 *   ② 极大集里只要有一条 delete，**delete 胜**（并发删除语义，宁删不活）；
 *   ③ 极大集全是 upsert（真·复活，即写入者确实见过之前的删除）时取确定性的
 *      最大者；④ 全是 delete 时同样取确定性的最大者，仅用于选代表。
 */
export function pickWinner(events: ReadonlyArray<SyncEvent>): SyncEvent | null {
  const list = events.filter((e) => e && isContentOp(e.op));
  if (list.length === 0) return null;
  if (list.length === 1) return list[0];

  const maximal = list.filter((e) => !list.some((o) => o !== e && compareCausally(o, e) === 'after'));
  const pool = maximal.length > 0 ? maximal : list;

  const dead = pool.filter((e) => e.op === 'delete');
  const candidates = dead.length > 0 ? dead : pool;
  return candidates.reduce((best, cur) => (stableTieBreak(cur, best) > 0 ? cur : best));
}

/**
 * LWW 比较：`ts` 大者胜。同一毫秒里 `delete` 排后面（后回放 = 胜），
 * 即「删除优先」；再按 `(device, seq)` 稳定打破平局，保证两端结果一致。
 *
 * 0.7.0 起它**只用于输出顺序**（让日志、清单、测试输出可复现），
 * 胜负改由 `pickWinner()` 按向量时钟裁决。
 */
export function compareEvents(a: SyncEvent, b: SyncEvent): number {
  if (a.ts !== b.ts) return a.ts - b.ts;
  if (a.op !== b.op && (a.op === 'delete' || b.op === 'delete')) {
    return a.op === 'delete' ? 1 : -1;
  }
  const d = String(a.device).localeCompare(String(b.device));
  if (d !== 0) return d;
  return a.seq - b.seq;
}

export function sortEvents(events: ReadonlyArray<SyncEvent>): SyncEvent[] {
  return [...events].sort(compareEvents);
}

/** 按 `(device, seq)` 去重 —— 同一分片被重复读到时不能回放两遍。 */
export function dedupeEvents(events: ReadonlyArray<SyncEvent>): SyncEvent[] {
  const seen = new Set<string>();
  const out: SyncEvent[] = [];
  for (const e of events) {
    if (!e || !e.device || !e.seq) continue;
    const id = eventId(e);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(e);
  }
  return out;
}

/** 合并多台设备的日志分片 → 全局有序事件流。 */
export function mergeEventLogs(logs: ReadonlyArray<ReadonlyArray<SyncEvent>>): SyncEvent[] {
  const all: SyncEvent[] = [];
  for (const log of logs) {
    if (!Array.isArray(log)) continue;
    for (const e of log) if (e && e.device && e.seq) all.push(e);
  }
  return sortEvents(dedupeEvents(all));
}

/** 某台设备下一个可用序号。只数自己的事件，不受别的设备发号影响。 */
export function nextLocalSeq(events: ReadonlyArray<SyncEvent>, device: string): number {
  let max = 0;
  for (const e of events) {
    if (e.device === device && Number.isInteger(e.seq)) max = Math.max(max, e.seq);
  }
  return max + 1;
}

// ---------------------------------------------------------------------------
// 完整性判据（fail-closed）
// ---------------------------------------------------------------------------

export interface EventLogRead {
  name: string;
  /** null = 读失败（不是「读成了空日志」） */
  events: SyncEvent[] | null;
}

/**
 * 本轮事件流是否足以支撑删除传播。
 *
 * 三个条件全满足才可信：
 *   ① 每一份日志分片都读成（空分片也算读成）；
 *   ② 每个事件的签名都有效；
 *   ③ 每台设备的 seq 从 1 连续，没有缺口。
 *
 * 缺任何一条就禁止按 delete 事件回收本地文件 —— 因为「缺一条 delete」和
 * 「少读一片日志」在结果上无法区分，宁可这轮不删，也不能误删。
 */
export function validateEventStream(reads: ReadonlyArray<EventLogRead>): EventStreamTrust {
  const failed = reads.filter((r) => r.events === null).map((r) => r.name);
  const merged = mergeEventLogs(reads.flatMap((r) => (r.events ? [r.events] : [])));
  const badSignatures: string[] = [];
  const byDevice = new Map<string, number[]>();

  for (const e of merged) {
    if (!verifyEvent(e)) {
      badSignatures.push(eventId(e));
      continue;
    }
    const arr = byDevice.get(e.device) ?? [];
    arr.push(e.seq);
    byDevice.set(e.device, arr);
  }

  const gaps: Array<{ device: string; from: number; to: number }> = [];
  for (const [device, seqs] of byDevice) {
    seqs.sort((a, b) => a - b);
    let expect = 1;
    for (const s of seqs) {
      if (s > expect) gaps.push({ device, from: expect, to: s - 1 });
      expect = Math.max(expect, s + 1);
    }
  }

  return {
    trusted: failed.length === 0 && badSignatures.length === 0 && gaps.length === 0,
    failed: [...failed, ...badSignatures].sort(),
    gaps,
    badSignatures,
  };
}

// ---------------------------------------------------------------------------
// 墓碑
// ---------------------------------------------------------------------------

export interface TombstoneOptions {
  retentionDays?: number;
  now?: number;
  /** 已有墓碑，做增量合并 */
  previous?: ReadonlyArray<Tombstone>;
}

/** 由一条 delete 事件派生墓碑。 */
function tombstoneOf(e: SyncEvent, days: number): Tombstone {
  const d = e.retentionDays ?? days;
  return {
    key: e.key,
    rel: e.rel,
    deletedAt: e.ts,
    by: e.device,
    device: e.device,
    seq: e.seq,
    expiresAt: d > 0 ? e.ts + d * DAY_MS : 0,
    trashRel: e.rel ? trashPathOf(e.key, e.ts) : undefined,
    vc: vectorClockOf(e),
  };
}

/**
 * 一条 upsert 能否「复活」既有墓碑。
 *
 * 只有**写入者确实见过这条删除**（向量时钟支配墓碑的时钟）才算真复活。
 * 旧墓碑（0.6.x 写入、没有 `vc`）退回墙钟兜底，保持升级前后行为一致。
 */
function resurrects(e: SyncEvent, t: Tombstone): boolean {
  const vc = normalizeVector(t.vc);
  if (vc) return dominates(vectorClockOf(e), vc);
  return e.ts > t.deletedAt;
}

/**
 * 从事件流回放生成墓碑。
 *
 * 0.7.0 起不再「按 ts 顺序一条条套用」，而是**按 key 归组后一次性裁决**
 * （`pickWinner()`）。原因：流式套用隐含依赖「事件按真实发生顺序排列」，
 * 而墙钟排序在有设备时钟偏移时根本不成立 —— 一条 ts 偏大的 upsert 只要排在
 * delete 后面就会把删除抹掉。按 key 归组后胜负只取决于因果，与顺序无关，
 * 于是 `buildTombstones` 对输入顺序不再敏感（可交换、可重放）。
 */
export function buildTombstones(
  events: ReadonlyArray<SyncEvent>,
  opts: TombstoneOptions = {},
): Tombstone[] {
  const days = opts.retentionDays ?? DEFAULT_RETENTION_DAYS;

  const byKey = new Map<string, SyncEvent[]>();
  for (const e of events) {
    if (!e || !e.key || !isContentOp(e.op)) continue;
    const arr = byKey.get(e.key);
    if (arr) arr.push(e);
    else byKey.set(e.key, [e]);
  }

  const out = new Map<string, Tombstone>();
  for (const [key, list] of byKey) {
    const winner = pickWinner(list);
    if (winner && winner.op === 'delete') out.set(key, tombstoneOf(winner, days));
  }

  // 旧墓碑兜底：日志被 GC / 本轮只读到部分分片时，不能因为「没看到那几条事件」
  // 就把删除忘掉。只有拿到「因果上更晚的写入」才允许撤销。
  for (const t of opts.previous ?? []) {
    if (!t || !t.key || out.has(t.key)) continue;
    const list = byKey.get(t.key);
    if (!list) {
      out.set(t.key, t);
      continue;
    }
    const winner = pickWinner(list);
    if (!winner || !resurrects(winner, t)) out.set(t.key, t);
  }

  return [...out.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** 两份墓碑谁该留作代表：先看因果，因果不可比时用确定性兜底。 */
function tombstoneWins(a: Tombstone, b: Tombstone): boolean {
  const va = normalizeVector(a.vc);
  const vb = normalizeVector(b.vc);
  if (va && vb) {
    if (dominates(va, vb)) return true;
    if (dominates(vb, va)) return false;
  }
  // 两边都是「删除」，语义完全一致；这里只在挑代表（谁的时间戳/回收期当前），
  // 用确定性顺序保证两端选到同一条，不会因为时钟快慢改变「已删除」这个结论。
  return stableTieBreak(
    { ts: a.deletedAt, seq: a.seq, device: String(a.device) },
    { ts: b.deletedAt, seq: b.seq, device: String(b.device) },
  ) > 0;
}

/** 合并多份墓碑表：因果更晚者胜；并发（两边都是删除）时确定性收敛。 */
export function mergeTombstones(...lists: ReadonlyArray<ReadonlyArray<Tombstone>>): Tombstone[] {
  const byKey = new Map<string, Tombstone>();
  for (const list of lists) {
    for (const t of list) {
      if (!t || !t.key) continue;
      const cur = byKey.get(t.key);
      if (!cur) {
        byKey.set(t.key, t);
        continue;
      }
      if (tombstoneWins(t, cur)) byKey.set(t.key, t);
    }
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** 该 key 当前是否仍处于「已删除且未过期」状态。 */
export function isDeleted(
  key: string,
  tombstones: ReadonlyArray<Tombstone>,
  now: number = Date.now(),
): boolean {
  const t = tombstones.find((x) => x.key === key);
  if (!t) return false;
  return t.expiresAt === 0 || now < t.expiresAt;
}

/** 已过期、可以真删远端回收副本的墓碑。 */
export function collectGc(
  tombstones: ReadonlyArray<Tombstone>,
  now: number = Date.now(),
): Tombstone[] {
  return tombstones.filter((t) => t.expiresAt !== 0 && now >= t.expiresAt);
}

/**
 * 墓碑的影响范围：只按 `key` 的语义推导，**不信任**与 key 不一致的 `t.rel`。
 *
 * 这是「宁可不删不可误删」的一道闸：远端日志可能被投喂一条
 * `key=session:s1, rel=attachments/a.png` 的事件，若照 `rel` 直接删，
 * 就会把一个毫不相干的附件搬进回收站。`rel` 只作为记录（恢复时用），
 * 不参与「删哪些清单条目」的判定。
 */
export function tombstoneTargets(t: Tombstone): { rels: string[]; sid: string | null } {
  if (t.key.startsWith('session:')) return { rels: [], sid: t.key.slice(8) };
  if (t.key.startsWith('rel:')) return { rels: [t.key.slice(4)], sid: null };
  // plugin: 等不在清单 rel 空间里的 key 不影响任何清单条目
  return { rels: [], sid: null };
}

// ---------------------------------------------------------------------------
// 位点
// ---------------------------------------------------------------------------

/** 把本机对某设备的位点推进到已见到的最大 seq。 */
export function advanceCursor(
  cursor: DeviceCursor | undefined,
  events: ReadonlyArray<SyncEvent>,
  device: string,
  now: number = Date.now(),
): DeviceCursor {
  let max = cursor?.appliedSeq ?? 0;
  for (const e of events) {
    if (e.device === device && Number.isInteger(e.seq)) max = Math.max(max, e.seq);
  }
  return { device, appliedSeq: max, updatedAt: now };
}

/** 按位点取增量事件（对端只回放自己没处理过的部分）。 */
export function eventsSince(
  events: ReadonlyArray<SyncEvent>,
  cursors: ReadonlyArray<DeviceCursor>,
): SyncEvent[] {
  const m = new Map(cursors.map((c) => [c.device, c.appliedSeq] as const));
  return events.filter((e) => e.seq > (m.get(e.device) ?? 0));
}

// ---------------------------------------------------------------------------
// 应用到清单 / 迁移 / 序列化
// ---------------------------------------------------------------------------

/**
 * 把墓碑与 upsert 事件应用到一个清单视图。
 *
 * 用于「事件流是真相、清单只是缓存」的新路径：清单里被删的 rel 要剔除，
 * 事件里新写但还没进清单的内容要补上。会话墓碑按 sid 删，所以两端 rel 不同也能命中。
 */
export function applyEventsToManifest(
  entries: ReadonlyArray<ManifestEntry>,
  tombstones: ReadonlyArray<Tombstone>,
  events: ReadonlyArray<SyncEvent>,
  now: number = Date.now(),
): ManifestEntry[] {
  const out = new Map<string, ManifestEntry>();
  for (const e of entries) if (e && typeof e.rel === 'string') out.set(e.rel, { ...e });

  for (const t of tombstones) {
    if (!isDeleted(t.key, tombstones, now)) continue;
    const { rels, sid } = tombstoneTargets(t);
    for (const rel of rels) out.delete(rel);
    if (sid) {
      for (const rel of [...out.keys()]) {
        if (sessionIdFromRel(rel) === sid) out.delete(rel);
      }
    }
  }

  for (const e of sortEvents(events)) {
    if (e.op !== 'upsert' || !e.rel || !e.hash) continue;
    if (isDeleted(e.key, tombstones, now)) continue;
    const cur = out.get(e.rel);
    out.set(e.rel, {
      rel: e.rel,
      hash: e.hash,
      size: cur?.size ?? 0,
      mtime: Math.max(cur?.mtime ?? 0, e.ts),
      device: e.device,
    });
  }
  return [...out.values()].sort((a, b) => a.rel.localeCompare(b.rel));
}

/**
 * v1 清单 → 初始 upsert 事件（迁移用）。
 *
 * 只给存量数据补一条基线，**绝不产生 delete**：迁移时清单里没有的条目可能是
 * 从没同步过的新文件，凭空生成删除事件等于把用户数据判死刑。
 */
export function migrateV1ToEvents(
  parts: ReadonlyArray<ReadonlyArray<ManifestEntry>>,
  device: string,
  ts: number = Date.now(),
): SyncEvent[] {
  const merged = new Map<string, ManifestEntry>();
  for (const list of parts) {
    for (const e of list) {
      if (!e || typeof e.rel !== 'string') continue;
      merged.set(e.rel, e);
    }
  }
  let seq = 1;
  return [...merged.values()]
    .sort((a, b) => a.rel.localeCompare(b.rel))
    .map((e) =>
      makeEvent({
        device,
        seq: seq++,
        ts,
        key: stableKeyOf(e.rel),
        rel: e.rel,
        hash: e.hash,
        op: 'upsert',
        category: e.rel.split('/')[0],
      }),
    );
}

export interface ParsedEventLog {
  events: SyncEvent[];
  badLines: number;
  /** 有任何一行解析/校验失败就为 true —— 调用方必须据此禁用删除传播 */
  corrupted: boolean;
}

/** 解析 JSONL 日志。坏行单独计数并报 corrupted，不静默当成「空日志」。 */
export function parseEventLog(text: string): ParsedEventLog {
  const events: SyncEvent[] = [];
  let badLines = 0;
  for (const line of String(text || '').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const e = JSON.parse(s);
      if (!verifyEvent(e)) {
        badLines++;
        continue;
      }
      events.push(e);
    } catch {
      badLines++;
    }
  }
  return { events, badLines, corrupted: badLines > 0 };
}

export function serializeEventLog(events: ReadonlyArray<SyncEvent>): string {
  return events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : '');
}

// ---------------------------------------------------------------------------
// BidMap（P2 的纯函数层）
// ---------------------------------------------------------------------------

/** 合并多端 bidmap：同一 sid 取 version 更大的；同 version 保持先到者，稳定可复现。 */
export function mergeBidMaps(
  parts: ReadonlyArray<ReadonlyArray<BidMapEntry>>,
): BidMapEntry[] {
  const by = new Map<string, BidMapEntry>();
  for (const list of parts) {
    for (const e of list) {
      if (!e || !e.sid) continue;
      const cur = by.get(e.sid);
      if (!cur || (e.version ?? 0) > (cur.version ?? 0)) by.set(e.sid, e);
    }
  }
  return [...by.values()].sort((a, b) => a.sid.localeCompare(b.sid));
}

export function bidMapLookup(
  map: ReadonlyArray<BidMapEntry>,
  sid: string,
): BidMapEntry | null {
  return map.find((e) => e.sid === sid) ?? null;
}
