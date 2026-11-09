/**
 * 0.6.0 / P4：插件包体 CAS 装配清单的纯函数契约。
 *
 * 锁住三条语义：按平台分包、合并与读入顺序无关、GC 只删没人引用的对象。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  assemblyKey, currentTarget, isValidObjectHash, buildAssemblies, mergeAssemblies,
  recordsForTarget, missingTargets, pluginObjectPath, unreferencedObjectPaths,
} = await import('../dist-test/plugin-objects.mjs');

const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);
const H3 = 'c'.repeat(64);
const WIN = 'win32/x64/node-127';
const AND = 'android/arm64/node-127';

const rec = (over = {}) => ({
  name: 'dsh-nas-sync', version: '0.6.0', target: WIN,
  objectHash: H1, size: 1000, device: 'win32:PC', ...over,
});

test('assemblyKey / currentTarget：主键与目标串格式稳定', () => {
  assert.equal(assemblyKey('dsh-nas-sync', '0.6.0'), 'dsh-nas-sync@0.6.0');
  assert.equal(currentTarget('android', 'arm64', 127), 'android/arm64/node-127');
});

test('isValidObjectHash：只认 sha256 hex，挡住路径注入', () => {
  assert.equal(isValidObjectHash(H1), true);
  assert.equal(isValidObjectHash(H1.toUpperCase()), true);
  assert.equal(isValidObjectHash('../../etc/passwd'), false);
  assert.equal(isValidObjectHash('abc'), false);
  assert.equal(isValidObjectHash(null), false);
});

test('buildAssemblies：按包名@版本聚合，同一包不同平台各占一个 target', () => {
  const a = buildAssemblies([
    rec(),
    rec({ target: AND, objectHash: H2, size: 900, device: 'android:PHONE' }),
    rec({ name: 'other', version: '1.0.0', objectHash: H3, size: 10 }),
  ]);
  assert.equal(a.length, 2);
  const main = a.find((x) => x.name === 'dsh-nas-sync');
  assert.deepEqual(Object.keys(main.targets).sort(), [AND, WIN].sort());
  assert.equal(main.targets[WIN].objectHash, H1);
  assert.equal(main.targets[AND].objectHash, H2);
});

test('buildAssemblies：同 target 冲突取 size 更大的，非法指纹丢弃', () => {
  const a = buildAssemblies([
    rec({ objectHash: H1, size: 10 }),
    rec({ objectHash: H2, size: 20 }),
    rec({ objectHash: '../evil', size: 9999 }),
  ]);
  assert.equal(a[0].targets[WIN].objectHash, H2);
});

test('mergeAssemblies：多端合并结果与读入顺序无关', () => {
  const pc = buildAssemblies([rec()]);
  const phone = buildAssemblies([rec({ target: AND, objectHash: H2, size: 900, device: 'android:PHONE' })]);
  const one = mergeAssemblies([pc, phone]);
  const two = mergeAssemblies([phone, pc]);
  assert.deepEqual(one, two);
  assert.deepEqual(Object.keys(one[0].targets).sort(), [AND, WIN].sort());
});

test('recordsForTarget / missingTargets：本机只拿自己平台的对象', () => {
  const a = buildAssemblies([rec(), rec({ name: 'win-only', version: '1.0.0', objectHash: H3, size: 5 })]);
  assert.deepEqual(recordsForTarget(a, WIN).map((r) => r.name), ['dsh-nas-sync', 'win-only']);
  assert.deepEqual(recordsForTarget(a, AND), []);
  const missing = missingTargets(a, AND);
  assert.equal(missing.length, 2);
  assert.deepEqual(missing[0].availableOn, [WIN]);
});

test('pluginObjectPath：两级散列，非法指纹抛错', () => {
  assert.equal(pluginObjectPath(H1), '/dsh/objects/aa/' + H1);
  assert.throws(() => pluginObjectPath('nope'));
});

test('unreferencedObjectPaths：只删没有装配清单引用的对象', () => {
  const a = buildAssemblies([rec()]);
  assert.deepEqual(unreferencedObjectPaths(a, [H1, H2]), ['/dsh/objects/bb/' + H2]);
  assert.deepEqual(unreferencedObjectPaths(a, [H1]), []);
  assert.deepEqual(unreferencedObjectPaths(a, ['bad']), []);
});
