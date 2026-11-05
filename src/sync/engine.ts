/**
 * dsh-nas-sync · 同步引擎（r2 重写）
 * ------------------------------------
 * r1 的致命问题已修：
 *   1. 本地路径用 process.env.HOME 猜 → 统一走 localOf(rel)（宿主解析）；
 *   2. 可合并文本文件 push 时从未保存 .base → 三路合并永远拿不到公共祖先；
 *   3. 分块上传传的是明文、completeHash 用明文 hash 对比密文 → 全链路改为密文，
 *      plainHash 记录在 chunk-manifest，下载后对明文校验；
 *   4. resolve('local') 后远端 manifest 未更新 → 下次扫描同一文件再次冲突
 *      （死循环）。现在 resolve 后立即回写远端 manifest；
 *   5. sync 结束写回的 manifest 是扫描时的旧快照 → 结束后重建最新清单再写。
 *
 * rel 约定（与 scanner/paths 一致）：一律相对 $DSH_HOME（即 ~/.dsh），
 * 远端路径 = '/dsh/' + rel，本地路径 = localOf(rel)。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { ConflictItem, ManifestEntry, PendingFile, SyncPhase } from '../data/models.js';
import { Scanner } from './scanner.js';
import { Crypto } from './crypto.js';
import { Chunker } from './chunker.js';
import type { NasTransport } from '../nas/transport.js';
import type { NasSyncConfig, Store } from '../config.js';
import { isMergeable } from './merger.js';
import { localOf } from '../paths.js';
import {
  isSessionRel,
  isWorkspaceRegistryRel,
  mergeWorkspaceRegistry,
  repairSessionCwd,
  rewriteSessionCwd,
} from './portable.js';

export type SyncMode = 'push' | 'pull' | 'mirror';

const MANIFEST_REMOTE = '/dsh/manifest.json';

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export interface EngineDeps {
  transport: NasTransport;
  store: Store;
  config: NasSyncConfig;
}

export class Engine {
  private deps: EngineDeps;
  private scanner: Scanner;
  private chunker: Chunker;
  private running = false;
  private abort: AbortController | null = null;
  /** scan() 缓存的远端清单（resolve 时回写用） */
  private remoteManifest: ManifestEntry[] = [];

  constructor(deps: EngineDeps) {
    this.deps = deps;
    this.scanner = new Scanner({
      // r3：分类勾选决定同步哪些子树；includeSensitive 只管子树内部的凭据文件
      scope: deps.config.syncScope,
      includeSensitive: deps.config.includeSensitive,
      // 技能白名单（空 = 全部），只影响 skills/ 下的一级目录
      skillFilter: deps.config.skillFilter,
    });
    this.chunker = new Chunker(deps.transport, {
      chunkSize: deps.config.chunkSize,
      concurrency: deps.config.concurrency,
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

  /** 前置检查：缺 passphrase / 缺 NAS 地址时直接给出可读错误，而不是跑到一半失败。 */
  checkReady(): void {
    const c = this.deps.config;
    if (!c.passphrase) throw new Error('未配置加密口令：请先在设置里填写 passphrase');
    if (c.type === 'webdav') {
      if (!c.webdav?.url) throw new Error('未配置 WebDAV 地址（type=webdav 但 webdav.url 为空）');
    } else if (!c.mountRoot) {
      throw new Error('未配置 NAS 挂载点 mountRoot（type=mount）');
    }
  }

  private setPhase(p: SyncPhase): void {
    this.deps.store.snapshot.phase = p;
  }

  private async readRemoteManifest(): Promise<ManifestEntry[]> {
    try {
      const enc = await this.deps.transport.getBuffer(MANIFEST_REMOTE);
      const plain = await Crypto.decrypt(enc, this.deps.config.passphrase);
      const list = JSON.parse(new TextDecoder().decode(plain));
      return Array.isArray(list) ? list : [];
    } catch {
      // 首次同步，远端无 manifest（或口令已变更）
      return [];
    }
  }

  private async writeRemoteManifest(entries: ManifestEntry[]): Promise<void> {
    const enc = await Crypto.encrypt(
      new TextEncoder().encode(JSON.stringify(entries, null, 2)),
      this.deps.config.passphrase,
      this.deps.store.salt(),
    );
    await this.deps.transport.putBuffer(enc, MANIFEST_REMOTE, { mkdirs: true });
  }

  /** 拉取远端某文件并解密（自动识别分块/直传，分块时校验 plainHash）。不存在返回 null。 */
  private async fetchRemotePlain(remote: string): Promise<Uint8Array | null> {
    let cipher: Uint8Array | null = null;
    let expectPlainHash: string | null = null;
    try {
      const r = await this.chunker.download(remote);
      cipher = r.cipher;
      expectPlainHash = r.manifest.plainHash;
    } catch {
      cipher = null; // 无分块清单 → 按直传文件处理
    }
    if (!cipher) {
      try {
        cipher = await this.deps.transport.getBuffer(remote);
      } catch {
        return null; // 远端不存在
      }
    }
    const plain = await Crypto.decrypt(cipher, this.deps.config.passphrase);
    if (expectPlainHash && sha256Hex(plain) !== expectPlainHash) {
      throw new Error('分块重组校验失败（plainHash 不匹配）: ' + remote);
    }
    return plain;
  }

  /** 把远端当前版本保存为 .base（三路合并的公共祖先）。失败不阻断主流程。 */
  private async saveBase(rel: string): Promise<void> {
    try {
      const plain = await this.fetchRemotePlain('/dsh/' + rel);
      if (!plain) return;
      const enc = await Crypto.encrypt(plain, this.deps.config.passphrase, this.deps.store.salt());
      await this.deps.transport.putBuffer(enc, '/dsh/' + rel + '.base', { mkdirs: true });
    } catch {
      /* .base 只是合并辅助，失败可以接受 */
    }
  }

  async scan(): Promise<{ local: ManifestEntry[]; pending: PendingFile[]; conflicts: ConflictItem[] }> {
    this.checkReady();
    this.setPhase('scanning');
    const local = await this.scanner.buildManifest();
    const remote = await this.readRemoteManifest();
    this.remoteManifest = remote;

    const localMap = new Map(local.map((e) => [e.rel, e]));
    const remoteMap = new Map(remote.map((e) => [e.rel, e]));
    const pending: PendingFile[] = [];
    const conflicts: ConflictItem[] = [];

    const last = this.deps.store.snapshot.lastSyncTime ?? 0;

    for (const [rel, le] of localMap) {
      const re = remoteMap.get(rel);
      if (!re) {
        pending.push({ rel, size: le.size, action: 'upload' });
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
        pending.push({ rel, size: le.size, action: 'upload' });
      } else {
        pending.push({ rel, size: re.size, action: 'download' });
      }
    }

    // 远端有、本地无 -> 下载
    for (const [rel, re] of remoteMap) {
      if (!localMap.has(rel)) {
        pending.push({ rel, size: re.size, action: 'download' });
      }
    }

    // 排序：先上传后下载，小文件优先
    const order = (a: string): number => (a === 'upload' ? 0 : 1);
    pending.sort((a, b) => order(a.action) - order(b.action) || a.size - b.size);

    this.deps.store.pendingFiles = pending;
    this.deps.store.conflicts = conflicts;
    this.deps.store.snapshot.pendingCount = pending.length;
    this.deps.store.snapshot.conflictCount = conflicts.length;
    this.deps.store.save();

    return { local, pending, conflicts };
  }

  async sync(mode: SyncMode): Promise<{ pushed: number; pulled: number; conflicts: number }> {
    if (this.running) throw new Error('同步任务正在进行中');
    this.checkReady();
    this.running = true;
    this.abort = new AbortController();

    try {
      const { pending } = await this.scan();
      const localMap = new Map((await this.scanner.buildManifest()).map((e) => [e.rel, e]));
      const remoteMap = new Map(this.remoteManifest.map((e) => [e.rel, e]));

      const total = pending.length;
      this.deps.store.snapshot.progress = { total, done: 0, errors: 0 };
      this.deps.store.snapshot.running = true;
      this.deps.store.save();

      let pushed = 0;
      let pulled = 0;
      // 同步成功后要从待办里移除的项。失败的、以及因 mode 不匹配而跳过的，
      // 都留在 remaining 里 —— 否则收尾时把 pendingCount 清零会**谎报**「已全部同步」。
      const remaining = new Set(pending);

      for (const item of pending) {
        if (this.abort.signal.aborted) break;
        try {
          if (mode === 'push' && item.action !== 'upload') continue;
          if (mode === 'pull' && item.action !== 'download') continue;

          if (item.action === 'upload') {
            await this.pushFile(item.rel, item.size, remoteMap.get(item.rel)?.hash);
            pushed++;
          } else if (item.action === 'download') {
            await this.downloadEntry(item.rel);
            pulled++;
          }
          this.deps.store.snapshot.progress.done++;
          remaining.delete(item);
        } catch {
          this.deps.store.snapshot.progress.errors++;
          // 单项失败不中断整体
        }
        this.deps.store.save();
      }

      // 收尾修复：把本次以及**以前**同步进来的会话统一检查一遍 cwd。
      // 幂等（cwd 本机已存在就跳过），所以每次 pull 都跑也不会有额外开销；
      // 这样即便上次同步时还没有这套逻辑，下一次 pull 也能把历史的坑填上。
      if (!this.abort.signal.aborted) {
        try {
          await repairSessionCwd();
        } catch {
          /* 修复失败不该让整轮同步判失败 */
        }
      }

      // 回写 manifest：用最新本地状态重建（下载过的文件也反映进来）
      if (!this.abort.signal.aborted) {
        const fresh = await this.scanner.buildManifest();
        await this.writeRemoteManifest(fresh);
        this.remoteManifest = fresh;
        this.deps.store.snapshot.lastSyncTime = Date.now();

        // 收尾刷新待办：不留「同步成功但仍显示待同步 N 项」的假状态。
        this.deps.store.pendingFiles = [...remaining];
        this.deps.store.snapshot.pendingCount = remaining.size;
      }

      return { pushed, pulled, conflicts: this.deps.store.conflicts.length };
    } finally {
      this.running = false;
      this.deps.store.snapshot.running = false;
      this.setPhase('idle');
      this.deps.store.save();
    }
  }

  /** 上传单个文件（整体密文；大文件走分块）。remoteHash 存在且为可合并文本时先存 .base。 */
  private async pushFile(rel: string, size: number, remoteHash?: string): Promise<void> {
    this.setPhase('uploading');
    const localAbs = localOf(rel);
    const remote = '/dsh/' + rel;

    // 可合并文本且远端已有版本 → 先把远端旧内容存为 .base（三路合并公共祖先）
    if (isMergeable(rel) && remoteHash) {
      await this.saveBase(rel);
    }

    const data = await readFile(localAbs);
    const plainHash = sha256Hex(data);
    const cipher = await Crypto.encrypt(data, this.deps.config.passphrase, this.deps.store.salt());

    if (size >= this.deps.config.chunkThreshold) {
      await this.chunker.upload(cipher, plainHash, size, remote);
    } else {
      await this.deps.transport.putBuffer(cipher, remote, { mkdirs: true });
    }
  }

  /** 下载单个文件并解密写盘。工作区注册表与会话头要额外处理，见各分支注释。 */
  private async downloadEntry(rel: string): Promise<void> {
    this.setPhase('downloading');
    const plain = await this.fetchRemotePlain('/dsh/' + rel);
    if (!plain) throw new Error('远端不存在: ' + rel);

    // ① 工作区注册表：直接覆盖会把本机的工作区整片抹掉（本地 default-workspace 也没了），
    //    所以这里**只合并不覆盖**，并把远端绝对路径映射成本机真实目录。
    if (isWorkspaceRegistryRel(rel)) {
      // 注意：plain 是 Uint8Array，`plain.toString('utf8')` 会走 Array.prototype.toString
      // 得到 "123,34,..." 这样的逗号串（encoding 参数被忽略），JSON.parse 必失败，
      // 整个合并就成了静默 no-op。必须显式经过 Buffer。
      await mergeWorkspaceRegistry(Buffer.from(plain).toString('utf8'));
      return;
    }

    const localAbs = localOf(rel);
    const cut = Math.max(localAbs.lastIndexOf('/'), localAbs.lastIndexOf('\\'));
    await mkdir(localAbs.slice(0, cut), { recursive: true });

    // ② 会话头里的 cwd 是**原机器**的绝对路径（手机上形如
    //    /data/user/0/com.dsh.harness/files/home/wstest），到本机不存在就会
    //    「本轮运行失败: working-directory does not exist」。而 dsh 明确拒绝
    //    「换一个 cwd 打开已有会话」（ApiSessionCwdConflict），调用方临时指定也没用
    //    —— 唯一可行的是落地时就把记录里的路径改写成本机路径。
    if (isSessionRel(rel)) {
      // 同样必须 Buffer.from：rewriteSessionCwd 用的是 readUInt32LE/subarray 这套
      // Buffer 专有 API，直接传 Uint8Array 会在帧解析处抛错并被吞掉，
      // 表现成「会话拉下来了但 cwd 永远是手机路径」。
      const out = rewriteSessionCwd(Buffer.from(plain));
      if (out !== null) {
        await mkdir(out.dir, { recursive: true });
        await writeFile(localAbs, out.buf);
        return;
      }
    }

    await writeFile(localAbs, plain);
  }

  /** 解决冲突：local = 推本地覆盖远端；remote = 拉远程覆盖本地；skip = 仅移出冲突列表。 */
  async resolve(rel: string, resolution: 'local' | 'remote' | 'skip'): Promise<void> {
    this.checkReady();
    const c = this.deps.store.conflicts.find((x) => x.rel === rel);
    if (!c) throw new Error('冲突记录不存在：' + rel);

    if (resolution === 'local') {
      const localAbs = localOf(rel);
      const st = await stat(localAbs);
      // 冲突场景：远端旧内容正是公共祖先，务必先存 .base
      await this.saveBase(rel);
      await this.pushFile(rel, st.size, c.remoteHash);
      // 回写远端 manifest，防止下次扫描再次判定为冲突
      const data = await readFile(localAbs);
      this.remoteManifest = this.remoteManifest.filter((e) => e.rel !== rel);
      this.remoteManifest.push({
        rel,
        mtime: st.mtimeMs,
        size: st.size,
        hash: sha256Hex(data),
      });
      await this.writeRemoteManifest(this.remoteManifest);
    } else if (resolution === 'remote') {
      await this.downloadEntry(rel);
      // 回写远端 manifest：本地 mtime 已变化，记录最新指纹
      const localAbs = localOf(rel);
      const st = await stat(localAbs);
      const data = await readFile(localAbs);
      this.remoteManifest = this.remoteManifest.filter((e) => e.rel !== rel);
      this.remoteManifest.push({
        rel,
        mtime: st.mtimeMs,
        size: st.size,
        hash: sha256Hex(data),
      });
      await this.writeRemoteManifest(this.remoteManifest);
    }
    // skip：什么都不做

    this.deps.store.conflicts = this.deps.store.conflicts.filter((x) => x.rel !== rel);
    this.deps.store.snapshot.conflictCount = this.deps.store.conflicts.length;
    this.deps.store.save();
  }

  /** 跳过某个待同步文件（从 pending 中移除，不影响远端）。 */
  async skipPending(rel: string): Promise<void> {
    this.deps.store.pendingFiles = this.deps.store.pendingFiles.filter((p) => p.rel !== rel);
    this.deps.store.snapshot.pendingCount = this.deps.store.pendingFiles.length;
    this.deps.store.save();
  }

  /** 读取远端某文件明文（供 try_merge / diff 工具复用）。 */
  async readRemoteText(rel: string): Promise<string | null> {
    this.checkReady();
    const plain = await this.fetchRemotePlain('/dsh/' + rel);
    return plain ? new TextDecoder().decode(plain) : null;
  }

  /** 读取远端 .base 明文（三路合并公共祖先）。 */
  async readBaseText(rel: string): Promise<string> {
    this.checkReady();
    const plain = await this.fetchRemotePlain('/dsh/' + rel + '.base');
    return plain ? new TextDecoder().decode(plain) : '';
  }
}
