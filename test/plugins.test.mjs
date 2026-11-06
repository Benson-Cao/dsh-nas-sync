/**
 * 插件对账的纯逻辑测试。
 *
 * 这一层最容易出错、也最容易被误判成「功能没生效」：
 * 拿本机清单比远端清单永远相等（清单本身也会被同步过去），
 * 必须比「本机实际装了没有」。下面的用例就是钉这一点。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  depKind,
  parseProfilePackage,
  installTarget,
  installCommand,
  diffPlugins,
} from '../dist-test/plugins.mjs';

test('depKind：常见 spec 分类', () => {
  assert.equal(depKind('0.82.0'), 'registry');
  assert.equal(depKind('^3.2.1'), 'registry');
  assert.equal(depKind('latest'), 'registry');
  assert.equal(depKind('git+https://github.com/a/b.git'), 'git');
  assert.equal(depKind('link:/data/user/0/x/y'), 'link');
  assert.equal(depKind('file:../x'), 'file');
  assert.equal(depKind('workspace:*'), 'workspace');
  assert.equal(depKind('https://x/y.tgz'), 'tarball');
  assert.equal(depKind(''), 'other');
});

test('parseProfilePackage：正常 package.json', () => {
  const r = parseProfilePackage(
    JSON.stringify({
      dependencies: { a: '1.0.0', b: 'link:/x' },
      dsh: { profile: { bundles: ['x', 'y'] } },
    }),
  );
  assert.deepEqual(r.deps, { a: '1.0.0', b: 'link:/x' });
  assert.deepEqual(r.bundles, ['x', 'y']);
});

test('parseProfilePackage：坏 JSON 不抛，返回 null', () => {
  assert.equal(parseProfilePackage('{ not json'), null);
  assert.equal(parseProfilePackage('null'), null);
});

test('installTarget：只有 registry / git 能自动装', () => {
  assert.equal(installTarget('dsh-context', '0.82.0'), 'dsh-context@0.82.0');
  assert.equal(installTarget('dsh-context', '^3.2.1'), 'dsh-context@^3.2.1');
  assert.equal(installTarget('x', 'git+https://g/x.git'), 'git+https://g/x.git');
  assert.equal(installTarget('x', 'link:/data/user/0/x'), null);
  assert.equal(installTarget('x', 'file:../x'), null);
});

test('installCommand：与 dsh CLI 的实际用法一致', () => {
  assert.equal(installCommand('desktop', 'dsh-context@0.82.0'), 'dsh plugin --profile desktop add dsh-context@0.82.0');
});

test('diffPlugins：本机没装 → missing，且可安装', () => {
  const gaps = diffPlugins({}, [{ profile: 'desktop', deps: { 'dsh-context': '0.82.0' }, bundles: [] }]);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].status, 'missing');
  assert.equal(gaps[0].installable, true);
  assert.equal(gaps[0].target, 'dsh-context@0.82.0');
});

test('diffPlugins：装了就对齐，不误报', () => {
  const gaps = diffPlugins({ 'dsh-context': '0.82.0' }, [{ profile: 'desktop', deps: { 'dsh-context': '0.82.0' }, bundles: [] }]);
  assert.equal(gaps.length, 0);
});

test('diffPlugins：版本不符 → outdated，仍可安装（升级）', () => {
  const gaps = diffPlugins({ 'dsh-context': '0.80.0' }, [{ profile: 'desktop', deps: { 'dsh-context': '0.82.0' }, bundles: [] }]);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].status, 'outdated');
  assert.equal(gaps[0].localVersion, '0.80.0');
});

test('diffPlugins：link 依赖已装就不算问题（两端路径本就不同）', () => {
  const gaps = diffPlugins({ 'dsh-nas-sync': '0.3.9' }, [{ profile: 'web', deps: { 'dsh-nas-sync': 'link:/data/user/0/com.dsh.harness/files/home/wstest/dsh-nas-sync' }, bundles: [] }]);
  assert.equal(gaps.length, 0);
});

test('diffPlugins：link 依赖没装 → missing 但不可安装', () => {
  const gaps = diffPlugins({}, [{ profile: 'web', deps: { 'dsh-nas-sync': 'link:/data/user/0/x' }, bundles: [] }]);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].installable, false);
  assert.equal(gaps[0].target, null);
  assert.equal(gaps[0].command, '');
});

test('diffPlugins：不按 profile 同名比（手机 web → 本机 desktop 也算缺）', () => {
  const gaps = diffPlugins({}, [{ profile: 'web', deps: { a: '1.0.0', b: '2.0.0' }, bundles: [] }]);
  assert.equal(gaps.length, 2);
  assert.ok(gaps.every((g) => g.status === 'missing' && g.profile === 'web'));
});

test('diffPlugins：多个 profile 列同一依赖只报一次', () => {
  const gaps = diffPlugins({}, [
    { profile: 'web', deps: { a: '1.0.0' }, bundles: [] },
    { profile: 'desktop', deps: { a: '1.0.0' }, bundles: [] },
  ]);
  assert.equal(gaps.length, 1);
});

test('diffPlugins：git 依赖已装即算满足（spec 是来源不是版本）', () => {
  const gaps = diffPlugins({ 'dsh-nas-sync': '0.4.0' }, [
    { profile: 'desktop', deps: { 'dsh-nas-sync': 'git+https://github.com/Benson-Cao/dsh-nas-sync.git' }, bundles: [] },
  ]);
  assert.equal(gaps.length, 0);
});

test('diffPlugins：内置 @deepseek-ai 包不参与对账', () => {
  const gaps = diffPlugins({}, [{ profile: 'desktop', deps: { '@deepseek-ai/dsh-base': '1.0.0', x: '1.0.0' }, bundles: [] }]);
  assert.deepEqual(gaps.map((g) => g.name), ['x']);
});

test('diffPlugins：missing 排在 outdated 前面，顺序稳定', () => {
  const gaps = diffPlugins({ b: '1.0.0' }, [{ profile: 'desktop', deps: { b: '2.0.0', a: '1.0.0', c: '1.0.0' }, bundles: [] }]);
  assert.deepEqual(gaps.map((g) => g.name), ['a', 'c', 'b']);
  assert.equal(gaps[2].status, 'outdated');
});
