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
