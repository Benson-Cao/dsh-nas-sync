/**
 * dsh-nas-sync · 分块断点续传（r2 重写）
 * ----------------------------------------
 * r1 两个致命 bug：
 *   1. 直接把**明文**分块上传到 NAS（与 README 声称的加密快照矛盾）；
 *   2. completeHash 是明文 hash，下载端却拿密文合并结果去对比 → 每个大文件
 *      下载必报「校验失败」。
 *
 * r2 语义（全链路密文）：
 *   - 上传方：明文整体 sha256 = plainHash → 整体加密（Crypto，salt 进头）
 *     → 密文按 chunkSize 切块 → 每块 sha256（密文）= 块 hash
 *   - 远端：<base>.partNNNN + <base>.chunk-manifest.json（plainHash + 块文件名）
 *   - 断点续传：远端块 stat 大小一致 → 跳过；否则删残块重传
 *   - 下载方（engine.downloadEntry）：按清单拉块拼密文 → decrypt →
 *     sha256(明文) 对比 plainHash
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

  /** 上传一段**已加密**的完整密文（含 NSS1 头）。plainHash 由调用方传入。 */
  async upload(cipher: Uint8Array, plainHash: string, plainSize: number, remotePath: string): Promise<void> {
    const chunkSize = this.opts.chunkSize;
    const num = Math.max(1, Math.ceil(cipher.length / chunkSize));

    // 断点续传：先看远端是否已有完整清单
    try {
      const prev = await this.transport.getBuffer(remotePath + '.chunk-manifest.json');
      const manifest = JSON.parse(new TextDecoder().decode(prev)) as ChunkManifest;
      if (manifest.plainHash === plainHash) {
        // 内容没变：校验每块在远端的大小，全对就只补清单
        let allOk = true;
        for (let i = 0; i < num; i++) {
          const remote = this.chunkRemote(remotePath, i);
          const st = await this.transport.stat(remote);
          const expect = i === num - 1 ? cipher.length - (num - 1) * chunkSize : chunkSize;
          if (!st || st.size !== expect) { allOk = false; break; }
        }
        if (allOk) return;
      }
    } catch {
      /* 无清单，正常首次上传 */
    }

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
          this.uploadOne(cipher, i, remotePath)
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

    const manifest: ChunkManifest = {
      chunks: Array.from({ length: num }, (_, i) =>
        this.chunkRemote(remotePath, i).split('/').pop()!),
      plainHash,
      plainSize,
    };
    await this.transport.putBuffer(
      new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
      remotePath + '.chunk-manifest.json',
      { mkdirs: true },
    );
  }

  private async uploadOne(cipher: Uint8Array, index: number, remotePath: string): Promise<void> {
    const remote = this.chunkRemote(remotePath, index);
    const offset = index * this.opts.chunkSize;
    const chunk = cipher.subarray(offset, Math.min(offset + this.opts.chunkSize, cipher.length));

    const st = await this.transport.stat(remote);
    if (st && st.size === chunk.length) return;   // 大小一致 → 视为已完成（断点续传）

    await this.transport.putBuffer(chunk, remote, { mkdirs: true });
  }

  /** 下载：按清单拉全部块拼回密文。返回 { cipher, manifest }。 */
  async download(remotePath: string): Promise<{ cipher: Uint8Array; manifest: ChunkManifest }> {
    const manifestEnc = await this.transport.getBuffer(remotePath + '.chunk-manifest.json');
    const manifest = JSON.parse(new TextDecoder().decode(manifestEnc)) as ChunkManifest;
    // 清单里存的是块 basename（<file>.partNNNN），要拼回其所在目录
    const dir = remotePath.slice(0, remotePath.lastIndexOf('/') + 1);
    const parts: Uint8Array[] = [];
    for (const c of manifest.chunks) {
      parts.push(await this.transport.getBuffer(dir + c));
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
}
