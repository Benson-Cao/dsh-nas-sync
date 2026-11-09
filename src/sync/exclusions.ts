/**
 * dsh-nas-sync · 统一排除规则（0.6.0 / P3）
 * ------------------------------------------
 * 0.5.9 里有**两份互不一致**的跳过集合：
 *   · scanner.ts 的 SKIP_DIRS：node_modules / nas-sync / .plugin-manager / .cache / .compile-cache
 *   · portable.ts 的 WORKSPACE_SKIP_DIRS：上面一部分 + .git / .venv / .next / dsh-nas-sync …
 *
 * 后果是同一个目录在「普通分类」和「工作区文件」两条扫描链路里待遇不同：
 * 工作区里跳过 `.git`，普通分类却会把它列进清单；反过来 `.plugin-manager`
 * 只在一边被排除。清单因此长期混着一批永远同步不完的运行时垃圾。
 *
 * 这里收成一份并集，两边共用；并把文件级规则（备份 / 分块残件 / 锁文件）
 * 也抽出来，避免将来再长出第三份副本。
 */

/** 目录名级跳过集合（并集；只按 basename 判定，与所在深度无关）。 */
export const SKIP_DIR_NAMES: ReadonlySet<string> = new Set([
  // 依赖与版本库元数据：体积大、跨机无意义
  'node_modules', '.git', '.svn', '.hg', '__pycache__', '.venv', 'venv',
  // 框架 / 构建缓存
  '.next', '.nuxt', '.turbo', '.cache', '.compile-cache',
  // 宿主运行时产生的目录
  'nas-sync', '.plugin-manager',
  // DSH 自己的会话回收站（0.6.0 / 收尾②）。
  // 它位于 `sessions/.sessions-trash/`，落在 sessions 分类的扫描前缀里；不排除的话
  // 一端删会话会被当成「回收站里多了两个新文件」同步过去，另一端不仅收到 upsert，
  // 还会把 `sessions/.sessions-trash/<ISO>---<enc>---<sid>` 当普通目录下载到本地，
  // 把本机回收站污染成两端时间戳的大杂烩。删除意图只能走 delete 事件，不能靠搬文件。
  '.sessions-trash',
  // 插件自身的安装目录（两端版本/平台不同，搬过去只会把对面弄坏）
  'dsh-nas-sync',
]);

export function isSkippedDirName(name: string): boolean {
  return SKIP_DIR_NAMES.has(String(name || ''));
}

/** 文件级跳过：三路合并的 .base、分块清单、锁文件、各种备份副本。 */
export function isIgnoredFileName(name: string): boolean {
  const n = String(name || '');
  if (!n) return false;
  if (n.endsWith('.base') || n.endsWith('.chunk-manifest.json') || n.endsWith('.lock')) return true;
  return /\.bak(-|$)|\.nassync-bak$/.test(n);
}

/**
 * rel 级判定：任一路径片段命中跳过目录，或末段是垃圾文件。
 *
 * 本地扫描与远端清单过滤共用这一把尺子 —— 只在一边排除不够，只要对端清单里
 * 还列着这些文件，本机每轮都会把它们当「远端有、本地没有」下载一遍。
 */
export function isIgnoredRelPath(rel: string): boolean {
  const parts = String(rel || '').split('/');
  if (parts.some((p) => isSkippedDirName(p))) return true;
  return isIgnoredFileName(parts[parts.length - 1] ?? '');
}
