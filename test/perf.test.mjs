/**
 * 0.6.0 / 收尾⑤：性能基线。
 *
 * 目标是「发现数量级退化」，不是微基准：阈值给得宽（单项 3 秒），
 * 输出实测耗时供趋势对比。慢机器上若确实超阈值，请先确认是不是算法
 * 退化，而不是随手把阈值调大。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { gzipSync } from 'node:zlib';

const { mergeDeviceManifests } = await import('../dist-test/manifest.mjs');
const { makeEvent, mergeEventLogs, buildTombstones } = await import('../dist-test/events.mjs');
const { configFingerprint } = await import('../dist-test/scan-cache.mjs');
const { unpackTgz } = await import('../dist-test/tgz.mjs');

const LIMIT_MS = 3000;

function timed(label, fn) {
  const t0 = performance.now();
  const value = fn();
  const ms = performance.now() - t0;
  console.log(`  [perf] ${label}: ${ms.toFixed(1)} ms`);
  return { value, ms };
}

const entries = (n, device) => Array.from({ length: n }, (_, i) => ({
  rel: 'attachments/f' + i + '-' + device, mtime: 1000 + i, size: i,
  hash: 'h'.repeat(64), device,
}));

const events = (n, device) => Array.from({ length: n }, (_, i) => makeEvent({
  device, seq: i + 1, ts: 1_700_000_000_000 + i,
  key: 'rel:attachments/f' + i, rel: 'attachments/f' + i,
  op: i % 5 === 0 ? 'delete' : 'upsert',
}));

test('清单合并：3 台设备 × 5000 条仍在毫秒级', () => {
  const { value, ms } = timed('mergeDeviceManifests(3×5000)', () =>
    mergeDeviceManifests([entries(5000, 'a'), entries(5000, 'b'), entries(5000, 'c')]));
  assert.equal(value.length, 15000);
  assert.ok(ms < LIMIT_MS, '耗时 ' + ms.toFixed(1) + ' ms 超过 ' + LIMIT_MS);
});

test('事件流合并 / 墓碑构建：3 台设备 × 1000 事件', () => {
  const parts = [events(1000, 'a'), events(1000, 'b'), events(1000, 'c')];
  const m = timed('mergeEventLogs(3×1000)', () => mergeEventLogs(parts));
  assert.ok(m.value.length >= 1000);
  assert.ok(m.ms < LIMIT_MS);
  const t = timed('buildTombstones(3000)', () => buildTombstones(m.value));
  assert.ok(Array.isArray(t.value));
  assert.ok(t.ms < LIMIT_MS);
});

test('配置指纹：1000 次计算不随调用次数退化', () => {
  const { ms } = timed('configFingerprint × 1000', () => {
    for (let i = 0; i < 1000; i++) {
      configFingerprint({
        scope: { sessions: true, attachments: i % 2 === 0 },
        includeSensitive: false, skillFilter: ['a', 'b'],
        customFolders: [{ name: 'x', path: '/x' }],
        maxFileBytes: 64 * 1024 * 1024, sessionRelMode: 'legacy',
      });
    }
    return null;
  });
  assert.ok(ms < LIMIT_MS);
});

test('tgz 解包：1000 个小文件的包体不出现二次方退化', () => {
  const BLOCK = 512;
  function head(name, size) {
    const h = Buffer.alloc(BLOCK, 0);
    h.write(name, 0, 'utf8');
    h.write('0000644\0', 100, 'ascii');
    h.write('0000000\0', 108, 'ascii');
    h.write('0000000\0', 116, 'ascii');
    h.write(size.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
    h.write('00000000000\0', 136, 'ascii');
    h.write('        ', 148, 'ascii');
    h.write('0', 156, 'ascii');
    h.write('ustar\0', 257, 'ascii');
    h.write('00', 263, 'ascii');
    let sum = 0; for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
    return h;
  }
  const blocks = [];
  for (let i = 0; i < 1000; i++) {
    const data = Buffer.from('x'.repeat(64));
    blocks.push(head('package/f' + i + '.txt', data.length), data,
      Buffer.alloc((BLOCK - data.length % BLOCK) % BLOCK));
  }
  blocks.push(Buffer.alloc(1024));
  const gz = new Uint8Array(gzipSync(Buffer.concat(blocks)));
  const { value, ms } = timed('unpackTgz(1000 files)', () => unpackTgz(gz));
  assert.equal(value.entries.length, 1000);
  assert.ok(ms < LIMIT_MS, '耗时 ' + ms.toFixed(1) + ' ms');
});
