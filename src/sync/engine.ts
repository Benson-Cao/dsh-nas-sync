/**
 * dsh-nas-sync · 同步引擎
 * ------------------------
 * 职责：
 *   1. 构建本地 manifest
 *   2. 拉取远端 manifest（解密后解析）
 *   3. 计算差异 -> 填充 store.pendingFiles / store.conflicts
 *   4. 调度传输（小文件直接 put，大文件走 Chunker）
 *   5. 回写 manifest 与进度
 *
 * 冲突判定：同一 rel 在两端 mtime 均晚于上一次成功同步时间，且 hash 不同。
 */

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { ConflictItem, ManifestEntry, PendingFile, SyncPhase } from '../data/models.js';
import { Scanner } from './scanner.js';
import { Crypto } from './crypto.js';
import { Chunker } from './chunker.js';
import type { NasTransport } from '../nas/transport.js';
import type { NasSyncConfig, Store } from '../config.js';
import { isMergeable } from './merger.js';

export type SyncMode = 'push' | 'pull' | 'mirror';

export interface EngineDeps {
  transport: NasTransport;
  store: Store;
  config: NasSyncConfig;
  /** 允许外部注入 base 版本读取（用于三路合并），可选 */
  baseResolver?: (rel: string) => Promise<string | null>;
}

export class Engine {
  private deps: EngineDeps;
  private scanner: Scanner;
  private chunker: Chunker;
  private running = false;
  private abort: AbortController | null = null;

  constructor(deps: EngineDeps) {
    this.deps = deps;
    this.scanner = new Scanner({
      includeSensitive: deps.config.includeSensitive,
    });
    this.chunker = new Chunker(deps.transport, {
      chunkSize: deps.config.chunkSize,
      concurrency: deps.config.concurrency,
      stateDir: '.dsh-nas-sync/chunks',
    });
  }

  isRunning(): boolean {
    return this.running;
  }

  stop(): void {
    this.abort?.abort();
    this.deps.store.snapshot.phase = 'idle';
    this.running = false;
  }

  private setPhase(p: SyncPhase): void {
    this.deps.store.snapshot.phase = p;
  }

  async scan(): Promise<{ local: ManifestEntry[]; pending: PendingFile[]; conflicts: ConflictItem[] }> {
    this.setPhase('scanning');
    const local = await this.scanner.buildManifest();

    let remote: ManifestEntry[] = [];
    try {
      const enc = await this.deps.transport.getBuffer('/dsh/manifest.json');
      const plain = await Crypto.decrypt(enc, this.deps.config.passphrase);
      remote = JSON.parse(new TextDecoder().decode(plain));
    } catch {
      // 首次同步，远端无 manifest
      remote = [];
    }

    const localMap = new Map(local.map((e) => [e.rel, e]));
    const remoteMap = new Map(remote.map((e) => [e.rel, e]));
    const pending: PendingFile[] = [];
    const conflicts: ConflictItem[] = [];

    const last = this.deps.store.snapshot.lastSyncTime ?? 0;

    for (const [rel, le] of localMap) {
      const re = remoteMap.get(rel);
      if (!re) {
        pending.push({ rel, size: le.size, action: 'upload', priority: 0 });
        continue;
      }
      if (le.hash === re.hash) continue;

      const localChanged = le.mtime > last;
      const remoteChanged = re.mtime > last;

      if (localChanged && remoteChanged) {
        conflicts.push({
          rel,
          localMtime: le.mtime,
          remoteMtime: re.mtime,
          localHash: le.hash,
          remoteHash: re.hash,
          mergeable: isMergeable(rel),
        });
      } else if (localChanged || le.mtime > re.mtime) {
        pending.push({ rel, size: le.size, action: 'upload', priority: 0 });
      } else {
        pending.push({ rel, size: re.size, action: 'download', priority: 0 });
      }
    }

    // 远端有、本地无 -> 下载或删除
    for (const [rel, re] of remoteMap) {
      if (!localMap.has(rel)) {
        pending.push({ rel, size: re.size, action: 'download', priority: 1 });
      }
    }

    // 排序：先下载后上传，小文件优先
    pending.sort((a, b) => a.priority - b.priority || a.size - b.size);

    this.deps.store.pendingFiles = pending;
    this.deps.store.conflicts = conflicts;
    this.deps.store.snapshot.pendingCount = pending.length;
    this.deps.store.snapshot.conflictCount = conflicts.length;
    this.deps.store.save();

    return { local, pending, conflicts };
  }

  async sync(mode: SyncMode): Promise<{ pushed: number; pulled: number; conflicts: number }> {
    if (this.running) throw new Error('同步任务正在进行中');
    this.running = true;
    this.abort = new AbortController();

    try {
      const { local, pending } = await this.scan();
      const total = pending.length;
      this.deps.store.snapshot.progress = { total, done: 0, errors: 0 };
      this.deps.store.snapshot.running = true;
      this.deps.store.save();

      let pushed = 0;
      let pulled = 0;

      for (const item of pending) {
        if (this.abort.signal.aborted) break;
        try {
          if (mode === 'push' && item.action !== 'upload') continue;
          if (mode === 'pull' && item.action !== 'download') continue;

          if (item.action === 'upload') {
            await this.uploadEntry(local.find((e) => e.rel === item.rel)!, mode);
            pushed++;
          } else if (item.action === 'download') {
            await this.downloadEntry(item.rel, mode);
            pulled++;
          }
          this.deps.store.snapshot.progress.done++;
        } catch (e) {
          this.deps.store.snapshot.progress.errors++;
          // 单项失败不中断整体
        }
        this.deps.store.save();
      }

      // 回写 manifest
      if (!this.abort.signal.aborted) {
        const enc = await Crypto.encrypt(
          new TextEncoder().encode(JSON.stringify(local, null, 2)),
          this.deps.config.passphrase,
        );
        await this.deps.transport.putBuffer(enc, '/dsh/manifest.json', { mkdirs: true });
        this.deps.store.snapshot.lastSyncTime = Date.now();
      }

      return { pushed, pulled, conflicts: this.deps.store.conflicts.length };
    } finally {
      this.running = false;
      this.deps.store.snapshot.running = false;
      this.setPhase(this.deps.store.conflicts.length > 0 ? 'idle' : 'idle');
      if (this.deps.store.conflicts.length > 0) this.deps.store.snapshot.phase = 'idle';
      this.deps.store.save();
    }
  }

  private async uploadEntry(entry: ManifestEntry, _mode: SyncMode): Promise<void> {
    this.setPhase('uploading');
    const localAbs = join(
      process.env.HOME ?? process.env.USERPROFILE ?? '',
      '.dsh',
      entry.rel,
    );
    const remote = '/dsh/' + entry.rel;

    if (entry.size >= this.deps.config.chunkThreshold) {
      await this.chunker.upload(localAbs, remote);
      return;
    }

    const data = await readFile(localAbs);
    const enc = await Crypto.encrypt(data, this.deps.config.passphrase);
    await this.deps.transport.putBuffer(enc, remote, { mkdirs: true });
  }

  private async downloadEntry(rel: string, _mode: SyncMode): Promise<void> {
    this.setPhase('downloading');
    const remote = '/dsh/' + rel;
    const localAbs = this.scanner.remoteToLocal(remote);

    // 分块文件：先取清单，再逐块下载拼接
    let plain: Uint8Array;
    try {
      const manifestEnc = await this.deps.transport.getBuffer(remote + '.chunk-manifest.json');
      const manifest = JSON.parse(new TextDecoder().decode(manifestEnc)) as {
        chunks: string[];
        completeHash: string;
      };
      const parts: Uint8Array[] = [];
      for (const c of manifest.chunks) {
        parts.push(await this.deps.transport.getBuffer('/dsh/' + c));
      }
      const total = parts.reduce((s, p) => s + p.length, 0);
      const merged = new Uint8Array(total);
      let off = 0;
      for (const p of parts) {
        merged.set(p, off);
        off += p.length;
      }
      const actual = createHash('sha256').update(merged).digest('hex');
      if (actual !== manifest.completeHash) {
        throw new Error(`文件 ${rel} 下载后校验失败`);
      }
      plain = await Crypto.decrypt(merged, this.deps.config.passphrase);
    } catch {
      // 非分块文件
      const enc = await this.deps.transport.getBuffer(remote);
      plain = await Crypto.decrypt(enc, this.deps.config.passphrase);
    }

    await mkdir(join(localAbs, '..'), { recursive: true });
    await writeFile(localAbs, plain);
  }

  /** 解决冲突：local = 推本地覆盖远端；remote = 拉远程覆盖本地；skip = 仅移出冲突列表 */
  async resolve(rel: string, resolution: 'local' | 'remote' | 'skip'): Promise<void> {
    const c = this.deps.store.conflicts.find((x) => x.rel === rel);
    if (!c) throw new Error('冲突记录不存在：' + rel);

    if (resolution === 'local') {
      const localAbs = join(process.env.HOME ?? '', '.dsh', rel);
      const data = await readFile(localAbs);
      const enc = await Crypto.encrypt(data, this.deps.config.passphrase);
      await this.deps.transport.putBuffer(enc, '/dsh/' + rel, { mkdirs: true });
    } else if (resolution === 'remote') {
      await this.downloadEntry(rel, 'pull');
    }
    // skip：什么都不做

    this.deps.store.conflicts = this.deps.store.conflicts.filter((x) => x.rel !== rel);
    this.deps.store.snapshot.conflictCount = this.deps.store.conflicts.length;
    this.deps.store.save();
  }

  /** 跳过某个待同步文件（从 pending 中移除，不影响远端） */
  async skipPending(rel: string): Promise<void> {
    this.deps.store.pendingFiles = this.deps.store.pendingFiles.filter((p) => p.rel !== rel);
    this.deps.store.snapshot.pendingCount = this.deps.store.pendingFiles.length;
    this.deps.store.save();
  }
}
