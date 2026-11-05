/**
 * dsh-nas-sync · 三路合并与行级 diff
 * -----------------------------------
 * 纯文本实现，不依赖外部命令，便于在 Host 侧直接运行。
 * 仅对文本类文件（settings / yaml / json / md）有意义。
 */

import type { DiffLine, DiffLineType, MergeResult } from '../data/models.js';

const MERGEABLE_EXT = ['.yaml', '.yml', '.json', '.md', '.txt', '.csv', '.conf', '.toml'];

export function isMergeable(path: string): boolean {
  const ext = path.toLowerCase().split('.').pop();
  return ext !== undefined && MERGEABLE_EXT.includes('.' + ext);
}

/** 行级 diff（基于最长公共子序列，O(n*m)，仅用于 UI 预览，文件过大时截断） */
export function diffLines(a: string[], b: string[], limit = 5000): DiffLine[] {
  const n = a.length;
  const m = b.length;
  if ((n + 1) * (m + 1) > limit * 20) {
    // 退化：只标“不同”，不逐行比对
    return a.map((l) => ({ type: 'change', line: l }));
  }

  const dp: number[][] = Array.from({ length: n + 1 }, (_, i) =>
    Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]) + 1;
    }
  }

  const out: DiffLine[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      out.push({ type: 'same', line: a[--i] });
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] <= dp[i - 1][j])) {
      out.push({ type: 'add', line: b[--j] });
    } else if (i > 0) {
      out.push({ type: 'remove', line: a[--i] });
    }
  }
  out.reverse();
  return out;
}

export interface ThreeWay {
  base: string[];
  local: string[];
  remote: string[];
}

/**
 * 简易三路合并：
 *  - 三方一致 -> 保留
 *  - 仅一方改动 -> 采用改动
 *  - 双方改动且结果相同 -> 保留
 *  - 双方改动且不同 -> 插入冲突标记，hasConflicts = true
 */
export function mergeThreeWay(base: string, local: string, remote: string): MergeResult {
  const t: ThreeWay = {
    base: base.split(/\r?\n/),
    local: local.split(/\r?\n/),
    remote: remote.split(/\r?\n/),
  };

  // 先各自做两两 diff 得到“相对 base 的变更行区间”，再按行对齐合并
  const bl = diffLines(t.base, t.local);
  const br = diffLines(t.base, t.remote);

  const changedLocal: Set<number> = new Set();
  const changedRemote: Set<number> = new Set();
  let baseIdxL = 0;
  let baseIdxR = 0;

  for (const d of bl) {
    if (d.type !== 'same') changedLocal.add(baseIdxL);
    if (d.type !== 'remove') baseIdxL++;
  }
  for (const d of br) {
    if (d.type !== 'same') changedRemote.add(baseIdxR);
    if (d.type !== 'remove') baseIdxR++;
  }

  const lines: string[] = [];
  let hasConflicts = false;
  const max = Math.max(t.base.length, t.local.length, t.remote.length);

  for (let i = 0; i < max; i++) {
    const inL = changedLocal.has(i);
    const inR = changedRemote.has(i);
    const lv = i < t.local.length ? t.local[i] : null;
    const rv = i < t.remote.length ? t.remote[i] : null;
    const bv = i < t.base.length ? t.base[i] : null;

    if (!inL && !inR) {
      if (bv !== null) lines.push(bv);
    } else if (inL && !inR) {
      if (lv !== null) lines.push(lv);
    } else if (!inL && inR) {
      if (rv !== null) lines.push(rv);
    } else {
      // 双方都改了
      if (lv === rv) {
        if (lv !== null) lines.push(lv);
      } else {
        hasConflicts = true;
        lines.push('<<<<<<< local');
        if (lv !== null) lines.push(lv);
        lines.push('=======');
        if (rv !== null) lines.push(rv);
        lines.push('>>>>>>> remote');
      }
    }
  }

  return {
    success: true,
    mergedContent: lines.join('\n'),
    hasConflicts,
  };
}
