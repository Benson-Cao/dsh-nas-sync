/**
 * dsh-nas-sync · 分块断点续传（r3 / 0.6.0）
 * ------------------------------------------
 * r1 两个致命 bug：
 *   1. 直接把**明文**分块上传到 NAS（与 README 声称的加密快照矛盾）；
 *   2. completeHash 是明文 hash，下载端却拿密文合并结果去对比 → 每个大文件
 *      下载必报「校验失败」。
 *
 * r2 语义（全链路密文）：
 *   - 上传方：明文整体 sha256 = plainHash → 整体加密（Crypto，salt 进头）
 *     → 密文按 chunkSize 切块 → 每块 sha256（密文）= 块 hash
 *   - 远端：<base>.partNNNN + <base>.chunk-manifest.json（plainHash + 块文件名）
 *
 * r3（0.6.0 / P3）补上审查里点名的三个洞：
 *   - 清单新增 `chunkHashes[]`，**下载端逐块校验**：以前只校验整体 plainHash，
 *     某块半截写/被覆盖时只会报「解密失败」，既定位不到块、也没法只重下那一块；
 *   - 断点续传判定从「只比远端块 size」升级为「清单里的块 hash 与本地算出的
 *     完全一致 + size 一致」，size 相同但内容被换掉的情况不再被当成已完成；
 *   - 内容变小（块数减少）后，旧版本多出来的 `.partNNNN` 会残留，下载端按清单
 *     不会读它们，但 NAS 上永远留着垃圾。现在重传后主动清理多余残块。
 *
 * 旧清单没有 chunkHashes 时一律**向后兼容**：退回「只比大小 + 整体校验」，
 * 不因为升级就把 NAS 上所有历史分块判成损坏。
 */

import { createHash } from 'node:crypto';
import type { NasTransport } from '../nas/transport.js';

export interface ChunkerOptions {
  chunkSize: number;
  concurrency: number;
}

export interface ChunkManifest {
  chunks: string[];
  plainHash: string;
  plainSize: number;
  /** 0.6.0：每块**密文**的 sha256 hex，与 chunks 一一对应。旧清单可能没有。 */
  chunkHashes?: string[];
}

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export class Chunker {
  private transport: NasTransport;
  private opts: ChunkerOptions;

  constructor(transport: NasTransport, opts: ChunkerOptions) {
    this.transport = transport;
    this.opts = opts;
  }

  private chunkRemote(base: string, index: number): string {
    return base + '.part' + String(index).padStart(4, '0');
  }

  /** 切块并算出每块的密文 hash（一次遍历，上传与清单共用）。 */
  private slice(cipher: Uint8Array): Array<{ data: Uint8Array; hash: string }> {
    const chunkSize = this.opts.chunkSize;
    const num = Math.max(1, Math.ceil(cipher.length / chunkSize));
    const out: Array<{ data: Uint8Array; hash: string }> = [];
    for (let i = 0; i < num; i++) {
      const off = i * chunkSize;
      const data = cipher.subarray(off, Math.min(off + chunkSize, cipher.length));
      out.push({ data, hash: sha256Hex(data) });
    }
    return out;
  }

  /** 读旧清单；读不到/损坏一律返回 null（不把「读失败」当成「没有清单」）。 */
  private async readManifest(remotePath: string): Promise<ChunkManifest | null> {
    try {
      const raw = await this.transport.getBuffer(remotePath + '.chunk-manifest.json');
      const m = JSON.parse(new TextDecoder().decode(raw)) as ChunkManifest;
      return m && Array.isArray(m.chunks) ? m : null;
    } catch {
      return null;
    }
  }

  /** 上传一段**已加密**的完整密文（含 NSS1 头）。plainHash 由调用方传入。 */
  async upload(cipher: Uint8Array, plainHash: string, plainSize: number, remotePath: string): Promise<void> {
    const parts = this.slice(cipher);
    const num = parts.length;
    const chunkHashes = parts.map((p) => p.hash);

    const prev = await this.readManifest(remotePath);
    const prevNum = prev?.chunks.length ?? 0;
    // 旧清单没有 chunkHashes 时按「plainHash 相同即同一内容」兼容，避免升级后全量重传。
    const hashesMatch = prev && Array.isArray(prev.chunkHashes)
      ? prev.chunkHashes.length === num && prev.chunkHashes.every((h, i) => h === chunkHashes[i])
      : true;
    const contentSame = !!(prev && prev.plainHash === plainHash && hashesMatch);

    if (contentSame) {
      let allOk = true;
      for (let i = 0; i < num; i++) {
        const st = await this.transport.stat(this.chunkRemote(remotePath, i));
        if (!st || st.size !== parts[i].data.length) { allOk = false; break; }
      }
      if (allOk) {
        // 清单缺块 hash 时顺手补上（不重传数据，只更新元数据）
        if (!Array.isArray(prev!.chunkHashes)) {
          await this.writeManifest(remotePath, {
            chunks: Array.from({ length: num }, (_, i) =>
              this.chunkRemote(remotePath, i).split('/').pop()!),
            plainHash, plainSize, chunkHashes,
          });
        }
        return;
      }
    }

    // 内容变了必须**强制覆盖每一块**。只比 size 会在「新内容块大小恰好相同」
    // 时跳过，导致 NAS 上留着旧字节、清单却记着新 hash，下载端必然校验失败。
    const force = !contentSame;

    // 并发上传各块
    const queue: number[] = [];
    for (let i = 0; i < num; i++) queue.push(i);
    let active = 0;
    let failed: Error | null = null;

    await new Promise<void>((resolve, reject) => {
      const spawn = (): void => {
        if (failed) return;
        while (queue.length > 0 && active < this.opts.concurrency) {
          const i = queue.shift()!;
          active++;
          this.uploadOne(parts[i].data, i, remotePath, force)
            .then(() => {
              active--;
              if (queue.length === 0 && active === 0) resolve();
              else spawn();
            })
            .catch((e: Error) => {
              failed = e;
              reject(e);
            });
        }
      };
      spawn();
    });

    // 0.6.0：清掉上一版多出来的残块。不清的话内容变小后 NAS 上会永久留下
    // 一批不会被任何清单引用的孤儿块，而且下次 expand 又可能被误当成断点续传成果。
    for (let i = num; i < prevNum; i++) {
      try { await this.transport.delete(this.chunkRemote(remotePath, i)); } catch { /* 不存在即成功 */ }
    }

    await this.writeManifest(remotePath, {
      chunks: Array.from({ length: num }, (_, i) =>
        this.chunkRemote(remotePath, i).split('/').pop()!),
      plainHash,
      plainSize,
      chunkHashes,
    });
  }

  private async writeManifest(remotePath: string, manifest: ChunkManifest): Promise<void> {
    await this.transport.putBuffer(
      new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
      remotePath + '.chunk-manifest.json',
      { mkdirs: true },
    );
  }

  private async uploadOne(
    chunk: Uint8Array, index: number, remotePath: string, force: boolean,
  ): Promise<void> {
    const remote = this.chunkRemote(remotePath, index);
    if (!force) {
      const st = await this.transport.stat(remote);
      if (st && st.size === chunk.length) return;   // 内容未变、大小一致 → 断点续传跳过
    }
    await this.transport.putBuffer(chunk, remote, { mkdirs: true });
  }

  /** 下载：按清单拉全部块拼回密文。返回 { cipher, manifest }。 */
  async download(remotePath: string): Promise<{ cipher: Uint8Array; manifest: ChunkManifest }> {
    const manifestEnc = await this.transport.getBuffer(remotePath + '.chunk-manifest.json');
    const manifest = JSON.parse(new TextDecoder().decode(manifestEnc)) as ChunkManifest;
    // 清单里存的是块 basename（<file>.partNNNN），要拼回其所在目录
    const dir = remotePath.slice(0, remotePath.lastIndexOf('/') + 1);
    const parts: Uint8Array[] = [];
    for (let i = 0; i < manifest.chunks.length; i++) {
      const name = manifest.chunks[i];
      const buf = await this.transport.getBuffer(dir + name);
      // 0.6.0：逐块校验，坏块立刻定位到序号，而不是等整体解密失败才猜
      const expected = Array.isArray(manifest.chunkHashes) ? manifest.chunkHashes[i] : undefined;
      if (expected && sha256Hex(buf) !== expected) {
        throw new Error(
          '分块校验失败：第 ' + i + ' 块 (' + name + ') 内容损坏或半截写入。' +
          '请删除该分块后重传，或用 nas_confirm_delete 清理后重新同步。',
        );
      }
      parts.push(buf);
    }
    const total = parts.reduce((s, p) => s + p.length, 0);
    const merged = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      merged.set(p, off);
      off += p.length;
    }
    return { cipher: merged, manifest };
  }

  /** 清理某个分块文件的全部残块（P1 的过期 GC / 手动清理复用）。 */
  async cleanup(remotePath: string, upTo = 64): Promise<number> {
    let n = 0;
    let miss = 0;
    for (let i = 0; i < upTo && miss < 2; i++) {
      const remote = this.chunkRemote(remotePath, i);
      const st = await this.transport.stat(remote).catch(() => null);
      if (!st) { miss++; continue; }
      miss = 0;
      try { await this.transport.delete(remote); n++; } catch { /* 保留，下轮再试 */ }
    }
    try { await this.transport.delete(remotePath + '.chunk-manifest.json'); n++; } catch { /* 不存在 */ }
    return n;
  }
}
