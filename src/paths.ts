/**
 * dsh-nas-sync · 路径工具（r2 重写）
 * ------------------------------------
 * 统一从宿主解析 Harness home，杜绝到处 process.env.HOME 猜测。
 * 注意：resolveDshHome() 返回的就是 ~/.dsh 目录本身（$DSH_HOME > ~/.dsh），
 * 不要再拼一层 ".dsh"。
 */

import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { join, relative } from 'node:path';

/** Harness home（如 /data/data/com.dsh.harness/files/home/.dsh）。 */
export function dshHome(): string {
  return resolveDshHome();
}

/** 相对 ~/.dsh 的 rel -> 本地绝对路径。rel 必须已归一化（无 ../）。 */
export function localOf(rel: string): string {
  if (rel.includes('..') || rel.startsWith('/')) {
    throw new Error('非法的相对路径: ' + rel);
  }
  return join(dshHome(), rel);
}

/** 本地绝对路径 -> 相对 ~/.dsh 的 rel（不在 .dsh 内则返回 null）。 */
export function relOf(abs: string): string | null {
  const base = dshHome();
  const rel = relative(base, abs);
  if (rel.startsWith('..') || rel === '') return null;
  return rel.split(/[\\/]/).join('/');
}

/** 远端绝对路径（/dsh/<rel>）-> rel。 */
export function relFromRemote(remote: string): string {
  if (!remote.startsWith('/dsh/')) throw new Error('远端路径必须以 /dsh/ 开头: ' + remote);
  const rel = remote.slice('/dsh/'.length);
  if (rel.includes('..') || rel.length === 0) throw new Error('非法的远端路径: ' + remote);
  return rel;
}
