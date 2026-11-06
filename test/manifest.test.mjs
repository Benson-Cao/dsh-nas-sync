/**
 * 远端清单合并的单测。
 *
 * 这里锁的是 0.3.4 → 0.3.5 的行为变化：
 *   0.3.4 无脑补回「远端有、本地没有」的条目 → 本机删掉的文件下一轮被复活；
 *   0.3.5 改成按基线判定：对端新增的才补，本机删掉的不补。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeManifestDevices, mergeManifestPreserving } from '../dist-test/manifest.mjs';

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
