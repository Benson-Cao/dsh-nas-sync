/**
 * dsh-nas-sync · 分块断点续传上传
 * --------------------------------
 *  - 本地保留 chunks/<md5>.json 记录每块偏移/哈希/是否上传
 *  - 远端文件名：<base>.partNNNN，另附 <base>.chunk-manifest.json
 *  - 每次上传前 stat 远端已存在块，大小匹配即视为已完成（断点续传）
 *  - 大小不匹配则删除残块重传
 *  - 并发受 concurrency 控制
 */

import { readFile, writeFile, unlink, mkdir, open } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { ChunkManifest, ChunkState, FileState } from '../data/models.js';
import type { NasTransport } from '../nas/transport.js';

export interface ChunkerOptions {
  chunkSize: number;
  concurrency: number;
  stateDir: string;
}

export class Chunker {
  private transport: NasTransport;
  private opts: Required<ChunkerOptions>;

  constructor(transport: NasTransport, opts: ChunkerOptions) {
    this.transport = transport;
    if (!opts.stateDir) throw new Error('ChunkerOptions.stateDir 必填');
    this.opts = opts;
  }

  private statePath(localPath: string): string {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
    const hash = createHash('md5').update(localPath).digest('hex');
    return join(home, this.opts.stateDir, hash + '.json');
  }

  private async loadState(localPath: string): Promise<FileState | null> {
    try {
      const raw = await readFile(this.statePath(localPath), 'utf-8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private async saveState(state: FileState): Promise<void> {
    const fp = this.statePath(state.filePath);
    await mkdir(join(fp, '..'), { recursive: true });
    await writeFile(fp, JSON.stringify(state, null, 2), 'utf-8');
  }

  private async removeState(state: FileState): Promise<void> {
    await unlink(this.statePath(state.filePath)).catch(() => {});
  }

  private chunkRemote(base: string, index: number): string {
    return base + '.part' + String(index).padStart(4, '0');
  }

  async upload(localPath: string, remotePath: string): Promise<void> {
    let state = await this.loadState(localPath);
    if (!state) state = await this.buildState(localPath);

    // 已完成且远端清单存在 -> 校验整体哈希
    if (state.completed) {
      const ok = await this.verifyRemote(remotePath, state.completeHash);
      if (ok) return;
      // 远端不完整，清空重传
      state.chunks.forEach((c) => (c.uploaded = false));
      state.completed = false;
    }

    // 并发上传
    const queue: ChunkState[] = state.chunks.filter((c) => !c.uploaded);
    let active = 0;
    let done = 0;
    let error: Error | null = null;

    await new Promise<void>((resolve, reject) => {
      const spawn = (): void => {
        if (error) return;
        while (queue.length > 0 && active < this.opts.concurrency) {
          const chunk = queue.shift()!;
          active++;
          this.uploadOne(state!, chunk, remotePath)
            .then(() => {
              active--;
              done++;
              if (queue.length === 0 && active === 0) resolve();
              else spawn();
            })
            .catch((e: Error) => {
              error = e;
              reject(e);
            });
        }
      };
      spawn();
    });

    // 写清单，标记完成
    const manifest: ChunkManifest = {
      chunks: state.chunks.map((c, i) => this.chunkRemote(remotePath, i).split('/').pop()!),
      completeHash: state.completeHash,
    };
    await this.transport.putBuffer(
      Buffer.from(JSON.stringify(manifest, null, 2)),
      remotePath + '.chunk-manifest.json',
      { mkdirs: true },
    );
    state.completed = true;
    await this.saveState(state);
    await this.removeState(state);
  }

  private async uploadOne(state: FileState, chunk: ChunkState, remotePath: string): Promise<void> {
    const remote = this.chunkRemote(remotePath, chunk.index);
    const rs = await this.transport.stat(remote);

    if (rs && rs.size === chunk.size) {
      // 大小一致，视为已完成（若要求严格可再拉哈希，代价较高）
      chunk.uploaded = true;
      await this.saveState(state);
      return;
    }

    if (rs) {
      // 残块，删除后重传
      await this.transport.delete(remote);
    }

    const fh = await open(state.filePath, 'r');
    let fd: Uint8Array;
    try {
      const tmp = Buffer.alloc(chunk.size);
      await fh.read(tmp, 0, chunk.size, chunk.offset);
      fd = new Uint8Array(tmp);
    } finally { await fh.close(); }
    const actual = createHash('sha256').update(fd).digest('hex');
    if (actual !== chunk.hash) {
      throw new Error(`分块 ${chunk.index} 哈希不一致，源文件可能已被修改，请重新扫描`);
    }

    await this.transport.putBuffer(fd, remote, { mkdirs: true });
    chunk.uploaded = true;
    await this.saveState(state);
  }

  private async buildState(localPath: string): Promise<FileState> {
    const { size: totalSize } = await statSync(localPath) as any;
    const size = Number(totalSize);
    const chunkSize = this.opts.chunkSize;
    const num = Math.ceil(size / chunkSize);
    const chunks: ChunkState[] = [];

    for (let i = 0; i < num; i++) {
      const offset = i * chunkSize;
      const len = Math.min(chunkSize, size - offset);
      const fhB = await open(localPath, 'r');
      let buf: Uint8Array;
      try {
        const tmp = Buffer.alloc(len);
        await fhB.read(tmp, 0, len, offset);
        buf = new Uint8Array(tmp);
      } finally { await fhB.close(); }
      chunks.push({
        index: i,
        offset,
        size: len,
        hash: createHash('sha256').update(buf).digest('hex'),
        uploaded: false,
      });
    }

    const full = await readFile(localPath);
    const completeHash = createHash('sha256').update(full).digest('hex');

    const state: FileState = { filePath: localPath, totalSize: size, chunks, completeHash, completed: false };
    await this.saveState(state);
    return state;
  }

  private async verifyRemote(remotePath: string, expected: string): Promise<boolean> {
    try {
      const buf = await this.transport.getBuffer(remotePath);
      const actual = createHash('sha256').update(buf).digest('hex');
      return actual === expected;
    } catch {
      return false;
    }
  }
}
