/**
 * 0.6.0 / P3：分块断点续传的块级校验与残块清理。
 *
 * 审查里点名的洞：「只比块大小不比块 hash」「残块不清理」「旧清单兼容」。
 * 这里用内存传输把上传 / 下载 / 重传三条路径都跑一遍。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const { Chunker } = await import('../dist-test/chunker.mjs');

class Mem {
  constructor() { this.blobs = new Map(); this.puts = 0; this.deletes = []; }
  async stat(p) {
    const b = this.blobs.get(p);
    return b ? { mtime: Date.now(), size: b.length } : null;
  }
  async getBuffer(p) {
    const b = this.blobs.get(p);
    if (!b) throw new Error('404 ' + p);
    return new Uint8Array(b);
  }
  async putBuffer(b, p) { this.blobs.set(p, Buffer.from(b)); this.puts++; }
  async delete(p) { this.blobs.delete(p); this.deletes.push(p); }
}

const sha = (u8) => createHash('sha256').update(u8).digest('hex');
const REMOTE = '/dsh/big/session.bin';
const opts = { chunkSize: 4, concurrency: 2 };
const cipher = (n) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) & 0xff);

test('upload 写入 chunkHashes，download 逐块校验后可完整还原密文', async () => {
  const m = new Mem();
  const c = new Chunker(m, opts);
  const data = cipher(10); // 3 块：4 + 4 + 2
  await c.upload(data, sha(data), data.length, REMOTE);

  const manifest = JSON.parse(m.blobs.get(REMOTE + '.chunk-manifest.json').toString('utf8'));
  assert.equal(manifest.chunks.length, 3);
  assert.equal(manifest.chunkHashes.length, 3);
  assert.equal(manifest.chunkHashes[0], sha(data.subarray(0, 4)));
  assert.equal(manifest.chunkHashes[2], sha(data.subarray(8)));

  const out = await c.download(REMOTE);
  assert.deepEqual(Array.from(out.cipher), Array.from(data));
  assert.equal(out.manifest.plainHash, sha(data));
});

test('某块被换掉但大小不变 → download 明确报「第 N 块损坏」，不再只说解密失败', async () => {
  const m = new Mem();
  const c = new Chunker(m, opts);
  const data = cipher(10);
  await c.upload(data, sha(data), data.length, REMOTE);

  // 模拟 NAS 上半截写 / 被别的内容覆盖，长度刻意保持一致
  m.blobs.set(REMOTE + '.part0001', Buffer.from([9, 9, 9, 9]));
  await assert.rejects(
    () => c.download(REMOTE),
    (e) => /分块校验失败/.test(e.message) && /第 1 块/.test(e.message),
  );
});

test('旧版清单没有 chunkHashes → 仍可下载（升级不把历史分块判成损坏）', async () => {
  const m = new Mem();
  const c = new Chunker(m, opts);
  const data = cipher(10);
  await c.upload(data, sha(data), data.length, REMOTE);

  const legacy = JSON.parse(m.blobs.get(REMOTE + '.chunk-manifest.json').toString('utf8'));
  delete legacy.chunkHashes;
  m.blobs.set(REMOTE + '.chunk-manifest.json', Buffer.from(JSON.stringify(legacy)));
  m.blobs.set(REMOTE + '.part0001', Buffer.from([9, 9, 9, 9])); // 坏块，但旧清单无从校验

  const out = await c.download(REMOTE);
  assert.equal(out.cipher.length, 10, '退回整体校验，仍能拼出数据');
  assert.equal(out.manifest.chunkHashes, undefined);
});

test('内容变小（块数减少）→ 上一版多出来的残块被清理', async () => {
  const m = new Mem();
  const c = new Chunker(m, opts);
  const big = cipher(14); // 4 块
  await c.upload(big, sha(big), big.length, REMOTE);
  assert.ok(m.blobs.has(REMOTE + '.part0003'));

  const small = cipher(6); // 2 块
  await c.upload(small, sha(small), small.length, REMOTE);
  assert.equal(m.blobs.has(REMOTE + '.part0002'), false);
  assert.equal(m.blobs.has(REMOTE + '.part0003'), false);
  assert.ok(m.deletes.includes(REMOTE + '.part0002'));

  const manifest = JSON.parse(m.blobs.get(REMOTE + '.chunk-manifest.json').toString('utf8'));
  assert.equal(manifest.chunks.length, 2);
  assert.equal(manifest.chunkHashes.length, 2);
});

test('断点续传：内容 hash 与块 hash 全一致时不再重传，并给旧清单补上块 hash', async () => {
  const m = new Mem();
  const c = new Chunker(m, opts);
  const data = cipher(10);

  // 手工造一份「没有 chunkHashes 的旧清单 + 完整块」
  for (let i = 0; i < 3; i++) {
    const off = i * 4;
    m.blobs.set(REMOTE + '.part' + String(i).padStart(4, '0'), Buffer.from(data.subarray(off, Math.min(off + 4, 10))));
  }
  m.blobs.set(REMOTE + '.chunk-manifest.json', Buffer.from(JSON.stringify({
    chunks: ['big.part0000', 'big.part0001', 'big.part0002'],
    plainHash: sha(data), plainSize: 10,
  })));
  const before = m.puts;
  await c.upload(data, sha(data), data.length, REMOTE);
  assert.equal(m.puts, before + 1, '只补写清单，不重传任何块');

  const manifest = JSON.parse(m.blobs.get(REMOTE + '.chunk-manifest.json').toString('utf8'));
  assert.equal(manifest.chunkHashes.length, 3);
});

test('内容变了但每块大小不变 → 强制覆盖，清单 hash 与实际字节一致', async () => {
  const m = new Mem();
  const c = new Chunker(m, opts);
  const a = cipher(10);
  await c.upload(a, sha(a), a.length, REMOTE);

  const b = Uint8Array.from({ length: 10 }, (_, i) => (i * 13 + 5) & 0xff);
  await c.upload(b, sha(b), b.length, REMOTE);

  const out = await c.download(REMOTE);
  assert.deepEqual(Array.from(out.cipher), Array.from(b), 'NAS 上必须是新内容的字节');
  const manifest = JSON.parse(m.blobs.get(REMOTE + '.chunk-manifest.json').toString('utf8'));
  assert.equal(manifest.chunkHashes[0], sha(b.subarray(0, 4)));
});

test('cleanup() 删掉全部残块与清单，返回删除数', async () => {
  const m = new Mem();
  const c = new Chunker(m, opts);
  const data = cipher(10);
  await c.upload(data, sha(data), data.length, REMOTE);
  const n = await c.cleanup(REMOTE);
  assert.ok(n >= 4, '3 块 + 1 清单');
  assert.equal(m.blobs.has(REMOTE + '.part0000'), false);
  assert.equal(m.blobs.has(REMOTE + '.chunk-manifest.json'), false);
});
