/**
 * dsh-nas-sync · 破坏性动作的安全判据（0.5.9）
 * ------------------------------------------------
 * 0.5.8 的审查结论里有两条阻断级都指向同一个根因：**把「读失败」当成「读到了空」**。
 *   · `remoteManifestTrusted = parts.length > 0` 只保证「至少一份清单读成」；
 *   · `missingRounds` 在不可信轮不复位，把「连续两轮」实现成了「累计两轮」。
 * 这两条合起来可以让 N-1 份设备清单读失败时，本机会话被当成「对端删了」而回收。
 *
 * 本模块把这三个判据抽成**纯函数**，不碰文件系统、不碰网络，因此可以直接单测：
 *   - `isSafeRel()`              远端 rel 能不能进本机文件系统路径
 *   - `evaluateManifestTrust()`  本轮清单是否「全部读成」
 *   - `advanceMissingRounds()`   连续缺失计数（任何一轮不可信/又出现了就归零）
 *
 * 原则：**宁可不删，不可误删**。判据拿不准时一律 fail-closed。
 */

/** 远端 rel 是否可安全用于本机文件系统路径。 */
export function isSafeRel(rel: unknown): rel is string {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 1024) return false;
  // 绝对路径 / UNC / Windows 盘符：一律拒绝，rel 必须相对 $DSH_HOME
  if (rel.startsWith('/') || rel.startsWith('\\')) return false;
  if (/^[A-Za-z]:[\\/]/.test(rel)) return false;
  // rel 空间统一用 /，反斜杠出现在远端数据里就是可疑的
  if (rel.includes('\\')) return false;
  if (/[\x00-\x1f\x7f]/.test(rel)) return false;
  // 编码过的 .. / 分隔符：WebDAV 路径拼接处可能被解码一次，提前挡掉
  if (/%(?:2e|2f|5c|00)/i.test(rel)) return false;

  const segments = rel.split('/');
  for (const s of segments) {
    if (!s || s === '.' || s === '..') return false;
    // Windows 会静默吞掉尾部的点和空格，可能绕过基于字符串的边界检查
    if (s.endsWith('.') || s.endsWith(' ')) return false;
  }
  return true;
}

/** 单份设备清单的读取结果。`entries === null` 表示**读失败**，空数组表示「读成了，但一台条目都没有」。 */
export interface ManifestRead<T> {
  name: string;
  entries: T[] | null;
}

export interface TrustResult {
  /** 只有「至少一份清单存在」且「每一份都读成」才为 true */
  trusted: boolean;
  /** 读失败的清单名，供日志/状态面板展示 */
  failed: string[];
  /** 成功读到的份数（含空清单） */
  okCount: number;
}

/**
 * 本轮远端清单是否足以支撑删除传播。
 *
 * 与 0.5.8 的 `parts.length > 0` 不同：空清单**也算读成**（一台设备确实可能一个条目都没有），
 * 而任何一份解密/JSON 失败都让整轮不可信 —— 因为「缺一条」正是我们要拿来删本地文件的信号，
 * 只要还有一份没读全，就不能排除「那条就在没读到的那份里」。
 */
export function evaluateManifestTrust<T>(reads: ReadonlyArray<ManifestRead<T>>): TrustResult {
  const failed = reads.filter((r) => r.entries === null).map((r) => r.name);
  return {
    trusted: reads.length > 0 && failed.length === 0,
    failed,
    okCount: reads.length - failed.length,
  };
}

/** 连续多少轮「可信地缺失」才允许回收本地镜像。README 对外承诺的口径。 */
export const RETIRE_AFTER_MISSING_ROUNDS = 2;

export interface MissingRoundInput {
  /** 本轮远端清单是否完全可信 */
  trusted: boolean;
  /** 这条远端原文本轮是否仍然出现在清单里 */
  present: boolean;
  /** 上一轮的计数值 */
  previous: number | undefined;
}

/**
 * 推进「连续缺失」计数。
 *
 * 三种情况都必须归零，缺一个就会把「连续」退化成「累计」：
 *   · 本轮又出现了（对端撤销删除 / 上次是抖动）；
 *   · 本轮清单不可信（这份「缺」根本不能当证据）；
 *   · 计数不是合法数字（历史脏数据）。
 */
export function advanceMissingRounds(input: MissingRoundInput): number {
  const prev = Number.isFinite(input.previous) && (input.previous ?? 0) > 0
    ? Math.floor(input.previous as number)
    : 0;
  if (!input.trusted || input.present) return 0;
  return prev + 1;
}

/** 是否达到回收阈值。 */
export function shouldRetire(rounds: number | undefined): boolean {
  return (rounds ?? 0) >= RETIRE_AFTER_MISSING_ROUNDS;
}

// ---------------------------------------------------------------------------
// 0.6.0 / P1：事件驱动删除的 fail-closed 判据
// ---------------------------------------------------------------------------

/**
 * 事件流是否允许本轮执行删除动作。
 *
 * 事件日志是删除传播的**唯一证据**。只要有一片没读成、一条签名不对、或某台设备
 * 的 seq 有缺口，就不能排除「那条证据恰好在没读到的部分里」，必须整轮禁止回收。
 * 这与 0.5.9 的 `evaluateManifestTrust()` 是同一条纪律，换成事件流口径。
 */
export interface EventTrustInput {
  trusted: boolean;
  failed: ReadonlyArray<string>;
  gaps: ReadonlyArray<{ device: string; from: number; to: number }>;
}

export function eventStreamAllowsDeletes(t: EventTrustInput | null): { allowed: boolean; reason: string | null } {
  if (!t) return { allowed: false, reason: '本轮尚未读取事件流' };
  if (!t.trusted) {
    const bits: string[] = [];
    if (t.failed.length) bits.push('读失败/签名异常 ' + t.failed.length + ' 处');
    if (t.gaps.length) bits.push('序号缺口 ' + t.gaps.length + ' 段');
    return { allowed: false, reason: '事件流不完整（' + (bits.join('、') || '未知原因') + '）' };
  }
  return { allowed: true, reason: null };
}

export interface DeleteCandidateInput {
  /** 上一轮本地清单（删除判定的基线） */
  baseline: ReadonlyArray<{ rel: string }>;
  /** 本轮本地清单 */
  fresh: ReadonlyArray<{ rel: string }>;
  /**
   * 本轮**启用分类**的 rel 前缀。
   *
   * 这是防「关掉一个分类勾选 = 把对端该分类全删光」的主闸：关掉的分类不在列表里，
   * 它下面的文件从清单消失就不再被当成删除。
   */
  enabledPrefixes: ReadonlyArray<string>;
  eventTrusted: boolean;
  manifestTrusted: boolean;
  /** 不参与判定的 rel（跨平台镜像 / 本机屏蔽 / 工作区注册表等） */
  excluded?: ReadonlySet<string>;
  /** 运行时垃圾判定（由调用方注入 isIgnoredRel，保持本模块零宿主依赖） */
  isIgnorable?: (rel: string) => boolean;
  /** 单轮最多允许删除多少条，超过整批拒绝 */
  maxDeletes?: number;
  /** 删除数占基线的比例上限，超过整批拒绝 */
  maxRatio?: number;
  /**
   * **有确凿删除证据**的 rel（0.6.2）：本地 DSH 回收站里就有这条会话的记录。
   *
   * 条数上限与比例上限防的是「扫描范围变了」这类**推断**误差 —— 远端清单读失败、
   * 扫描器临时读不到某个目录、用户关掉分类勾选，在「本轮少了 N 条」上长得一模一样。
   * 但回收站记录不是推断：用户确实按了删除，DSH 落了 `<ISO>---<编码>---<sid>` 目录。
   * 所以这类条目只过第 ④ 道闸（安全 rel / 启用分类 / 排除集合），不受 ⑤⑥ 限制 ——
   * 否则一台只有一两条会话的设备，删掉唯一那条会被比例闸永久拦住（1/1 = 100%）。
   */
  explicit?: ReadonlySet<string>;
}

export interface DeleteDecision {
  rels: string[];
  blocked: boolean;
  reason: string | null;
  /** 被各类闸排除掉的条数，用于日志解释「为什么这轮没删」 */
  excludedCount: number;
}

/**
 * 从「上一轮有、这一轮没有」里挑出**可以确认为用户主动删除**的条目。
 *
 * 逐道闸门（任何一道不过都整批拒，不做部分删除 —— 部分删除最难排查）：
 *   ① 事件流可信；② 远端清单可信；③ 本地基线非空（首轮不产生删除）；
 *   ④ rel 安全、不是运行时垃圾、不在排除集合、且落在启用分类内；
 *   ⑤ 条数不超过上限；⑥ 占基线比例不超过上限。
 *
 * 第 ④ 条最关键：远端清单读失败、扫描器临时读不到某个工作区目录、用户关掉分类勾选，
 * 三种情况在「本轮少了 N 条」上长得一模一样，只有按启用分类 + 比例上限才能挡住。
 */
export function computeLocalDeletes(input: DeleteCandidateInput): DeleteDecision {
  const empty: DeleteDecision = { rels: [], blocked: false, reason: null, excludedCount: 0 };
  if (!input.eventTrusted) return { ...empty, blocked: true, reason: '事件流不可信' };
  if (!input.manifestTrusted) return { ...empty, blocked: true, reason: '远端清单不可信' };
  if (input.baseline.length === 0) return { ...empty, blocked: true, reason: '本地基线为空（首轮不产生删除）' };

  const present = new Set(input.fresh.map((e) => e.rel));
  const prefixes = input.enabledPrefixes.filter(Boolean);
  const excluded = input.excluded ?? new Set<string>();
  const ignorable = input.isIgnorable ?? (() => false);
  const inScope = (rel: string): boolean =>
    prefixes.some((p) => rel === p || rel.startsWith(p + '/'));

  const candidates: string[] = [];
  let excludedCount = 0;
  for (const e of input.baseline) {
    const rel = e.rel;
    if (present.has(rel)) continue;
    if (
      !isSafeRel(rel) || ignorable(rel) || excluded.has(rel) ||
      !inScope(rel)
    ) {
      excludedCount++;
      continue;
    }
    candidates.push(rel);
  }
  if (candidates.length === 0) return { ...empty, excludedCount };

  // 0.6.2：有确凿证据的条目（回收站记录）不计入「推断消失」，只受 ④ 约束。
  const explicit = input.explicit ?? new Set<string>();
  const inferred = candidates.filter((rel) => !explicit.has(rel));

  const maxDeletes = input.maxDeletes ?? 50;
  if (inferred.length > maxDeletes) {
    return {
      ...empty, blocked: true, excludedCount,
      reason: '单轮消失 ' + inferred.length + ' 条，超过上限 ' + maxDeletes + '（疑似配置/路径变更）',
    };
  }
  const maxRatio = input.maxRatio ?? 0.5;
  if (inferred.length / input.baseline.length > maxRatio) {
    return {
      ...empty, blocked: true, excludedCount,
      reason: '单轮消失比例 ' + (inferred.length / input.baseline.length).toFixed(2) +
        ' 超过上限 ' + maxRatio + '（疑似扫描范围变更）',
    };
  }
  return { rels: candidates.sort(), blocked: false, reason: null, excludedCount };
}

/** 回收保留天数归一：非法值一律回默认 30 天，0 = 永久保留。 */
export function normalizeRetentionDays(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 30;
  return Math.min(3650, Math.floor(n));
}
