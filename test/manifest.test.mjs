/**
 * 远端清单合并的单测。
 *
 * 这里锁的是 0.3.4 → 0.3.5 的行为变化：
 *   0.3.4 无脑补回「远端有、本地没有」的条目 → 本机删掉的文件下一轮被复活；
 *   0.3.5 改成按基线判定：对端新增的才补，本机删掉的不补。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MANIFESTS_DIR,
  manifestFileOf,
  mergeDeviceManifests,
  mergeManifestDevices,
  mergeManifestPreserving,
  ownManifestEntries,
} from '../dist-test/manifest.mjs';

const e = (rel, hash = 'h-' + rel) => ({ rel, mtime: 1, size: 1, hash });

test('mergeManifestPreserving：对端新增的条目要补回（否则对端数据收不到）', () => {
  const fresh = [e('sessions/a')];
  const prev = [e('sessions/a'), e('sessions/from-pc')];
  const out = mergeManifestPreserving(fresh, prev, []);
  assert.deepEqual(out.map((x) => x.rel).sort(), ['sessions/a', 'sessions/from-pc']);
});

test('mergeManifestPreserving：本机删掉的条目不补回（0.3.4 的复活 bug）', () => {
  const fresh = [e('sessions/a')];
  const prev = [e('sessions/a'), e('sessions/i-deleted')];
  const baseline = [e('sessions/a'), e('sessions/i-deleted')];
  const out = mergeManifestPreserving(fresh, prev, baseline);
  assert.deepEqual(out.map((x) => x.rel), ['sessions/a']);
});

test('mergeManifestPreserving：本地内容优先于远端旧条目', () => {
  const fresh = [{ rel: 'a', mtime: 9, size: 9, hash: 'new' }];
  const prev = [{ rel: 'a', mtime: 1, size: 1, hash: 'old' }];
  const out = mergeManifestPreserving(fresh, prev, []);
  assert.equal(out.length, 1);
  assert.equal(out[0].hash, 'new');
  assert.equal(out[0].mtime, 9);
});

test('mergeManifestDevices：内容没变就保留原来源设备', () => {
  const fresh = [{ ...e('a'), device: 'android:PHONE' }];
  const prev = [{ ...e('a'), device: 'win32:PC' }];
  const out = mergeManifestDevices(fresh, prev);
  assert.equal(out[0].device, 'win32:PC');
});

test('mergeManifestDevices：内容变了就归给本机', () => {
  const fresh = [{ rel: 'a', mtime: 2, size: 2, hash: 'changed', device: 'android:PHONE' }];
  const prev = [{ rel: 'a', mtime: 1, size: 1, hash: 'old', device: 'win32:PC' }];
  const out = mergeManifestDevices(fresh, prev);
  assert.equal(out[0].device, 'android:PHONE');
});


/* ---------- 0.3.6：清单按设备拆分 ---------- */

test('manifestFileOf：设备名安全化，落在 /dsh/manifests/', () => {
  assert.equal(manifestFileOf('win32:DESKTOP-ABC'), MANIFESTS_DIR + '/win32_DESKTOP-ABC.json');
  assert.ok(manifestFileOf('').endsWith('/_unknown.json'));
  const evil = manifestFileOf('../../etc/passwd');
  assert.ok(!evil.includes('..'), evil);
  assert.ok(evil.startsWith(MANIFESTS_DIR + '/'), evil);
});

test('mergeDeviceManifests：多份按 rel 合并', () => {
  const a = [e('x'), e('y')];
  const b = [e('y'), e('z')];
  const out = mergeDeviceManifests([a, b]);
  assert.deepEqual(out.map((x) => x.rel).sort(), ['x', 'y', 'z']);
});

test('mergeDeviceManifests：hash 不同取 mtime 更新的（远端最新版本）', () => {
  const a = [{ rel: 'x', mtime: 1, size: 1, hash: 'old', device: 'a' }];
  const b = [{ rel: 'x', mtime: 9, size: 9, hash: 'new', device: 'b' }];
  assert.equal(mergeDeviceManifests([a, b])[0].hash, 'new');
  assert.equal(mergeDeviceManifests([b, a])[0].hash, 'new');
});

test('mergeDeviceManifests：hash 相同取 device 字典序更小的（与读入顺序无关）', () => {
  const a = [{ rel: 'x', mtime: 1, size: 1, hash: 'h', device: 'win32:Z' }];
  const b = [{ rel: 'x', mtime: 2, size: 2, hash: 'h', device: 'android:A' }];
  assert.equal(mergeDeviceManifests([a, b])[0].device, 'android:A');
  assert.equal(mergeDeviceManifests([b, a])[0].device, 'android:A');
});

test('ownManifestEntries：只写本轮 push 成功 + 之前已确认且哈希未变的', () => {
  const fresh = [e('pushed'), e('already'), e('never-uploaded')];
  const prevOwn = [e('already')];
  const out = ownManifestEntries(fresh, prevOwn, new Set(['pushed']));
  assert.deepEqual(out.map((x) => x.rel).sort(), ['already', 'pushed']);
  assert.ok(!out.some((x) => x.rel === 'never-uploaded'));
});

test('ownManifestEntries：本地改了但没传成功 → 不写（不制造幽灵条目）', () => {
  const fresh = [{ rel: 'x', mtime: 9, size: 9, hash: 'changed' }];
  const prevOwn = [{ rel: 'x', mtime: 1, size: 1, hash: 'old' }];
  assert.equal(ownManifestEntries(fresh, prevOwn, new Set()).length, 0);
});
