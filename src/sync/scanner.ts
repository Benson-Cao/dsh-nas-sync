/**
 * dsh-nas-sync · 白名单扫描
 * ---------------------------
 * 只同步明确列出的路径，敏感文件（.credentials.yaml 等）默认排除。
 * 换机器后 ~ 的绝对路径不同，因此所有记录都以“相对于 ~/.dsh”的相对路径存储。
 */

import { readdir, stat, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { ManifestEntry } from '../data/models.js';

export interface Rule {
  /** 本地绝对路径（文件或目录） */
  local: string;
  /** 远端路径（以 / 开头） */
  remote: string;
  /** 是否可能含敏感内容，需 includeSensitive=true 才同步 */
  sensitive?: boolean;
}

export const DEFAULT_RULES: Rule[] = [
  { local: '.dsh/sessions',             remote: '/dsh/sessions',            sensitive: true },
  { local: '.dsh/settings.yaml',        remote: '/dsh/config/settings.yaml', sensitive: true },
  { local: '.dsh/attachments/v1/objects', remote: '/dsh/attachments' },
  { local: '.dsh/profiles/web',         remote: '/dsh/profiles/web',         sensitive: true },
  { local: '.dsh/skills',               remote: '/dsh/skills' },
];

const SENSITIVE_NAMES = ['.credentials.yaml', '.credentials', '.env', '.token'];

export class Scanner {
  private home: string;
  private includeSensitive: boolean;
  private rules: Rule[];

  constructor(opts: {
    home?: string;
    includeSensitive?: boolean;
    rules?: Rule[];
  } = {}) {
    this.home = opts.home ?? process.env.HOME ?? process.env.USERPROFILE ?? '';
    this.includeSensitive = opts.includeSensitive ?? false;
    this.rules = opts.rules ?? DEFAULT_RULES;
  }

  private expand(p: string): string {
    if (p.startsWith('~/') || p.startsWith('~\\')) return join(this.home, p.slice(2));
    if (p === '~') return this.home;
    return resolve(p);
  }

  async exists(p: string): Promise<boolean> {
    try {
      await stat(p);
      return true;
    } catch {
      return false;
    }
  }

  private async* walk(dir: string): AsyncGenerator<string> {
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
        if (name === 'node_modules') continue;
        yield* this.walk(full);
      } else {
        // 跳过工作区内的隐藏文件（白名单目录名本身不受影响）
        if (name.startsWith('.')) continue;
        yield full;
      }
    }
  }

  private isSensitive(path: string): boolean {
    const base = path.split(/[\\/]/).pop() ?? '';
    return SENSITIVE_NAMES.some((s) => base === s || base.endsWith(s + '.yaml'));
  }

  async buildManifest(): Promise<ManifestEntry[]> {
    const out: ManifestEntry[] = [];
    for (const rule of this.rules) {
      if (rule.sensitive && !this.includeSensitive) continue;
      const local = this.expand(rule.local);
      if (!(await this.exists(local))) continue;

      const s = await stat(local);
      if (s.isFile()) {
        out.push(await this.toEntry(local, local));
        continue;
      }

      for await (const file of this.walk(local)) {
        if (!this.includeSensitive && this.isSensitive(file)) continue;
        out.push(await this.toEntry(file, local));
      }
    }
    return out;
  }

  private async toEntry(file: string, base: string): Promise<ManifestEntry> {
    const s = await stat(file);
    const buf = await readFile(file);
    return {
      rel: relative(base, file).split(/[\\/]/).join('/'),
      mtime: s.mtimeMs,
      size: s.size,
      hash: createHash('sha256').update(buf).digest('hex'),
    };
  }

  /** 远端路径 -> 本地绝对路径（恢复时用） */
  remoteToLocal(remote: string): string {
    for (const rule of this.rules) {
      if (remote.startsWith(rule.remote + '/') || remote === rule.remote) {
        const suffix = remote === rule.remote ? '' : remote.slice(rule.remote.length + 1);
        return join(this.expand(rule.local), suffix);
      }
    }
    // 未知路径放到 .dsh/nas-import 下，避免覆盖本地文件
    return join(this.expand('.dsh/nas-import'), remote.replace(/^\/+/, ''));
  }
}
