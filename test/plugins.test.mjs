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
  deviceClassOfProfile,
  pluginDeviceClass,
  minVersionOf,
  declaredPluginNames,
  toTarballSpec,
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

// ---- 各自最优：平台专属插件不跨平台建议安装 ----

test('deviceClassOfProfile：档名推断设备类别', () => {
  assert.equal(deviceClassOfProfile('desktop'), 'desktop');
  assert.equal(deviceClassOfProfile('web'), 'mobile');
  assert.equal(deviceClassOfProfile('acp'), 'cli');
  assert.equal(deviceClassOfProfile('whatever'), 'unknown');
  assert.equal(deviceClassOfProfile(''), 'unknown');
});

test('pluginDeviceClass：从包名读平台归属', () => {
  assert.equal(pluginDeviceClass('dsh-web-mobile'), 'mobile');
  assert.equal(pluginDeviceClass('dsh-desktop-tray'), 'desktop');
  assert.equal(pluginDeviceClass('dsh-cli-theme'), 'cli');
  assert.equal(pluginDeviceClass('dsh-context'), null);
  assert.equal(pluginDeviceClass('dsh-nas-sync'), null);
});

test('各自最优：电脑上不装手机的竖屏适配', () => {
  const remote = [{ profile: 'web', deps: { 'dsh-web-mobile': '3.2.1' }, bundles: [] }];
  const gaps = diffPlugins({}, remote, { targetProfile: 'desktop' });
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].status, 'missing'); // 仍然报出来，不是悄悄隐藏
  assert.equal(gaps[0].installable, false);
  assert.equal(gaps[0].target, null);
  assert.equal(gaps[0].reason, 'platform');
  assert.equal(gaps[0].foreignPlatform, 'mobile');
});

test('各自最优：手机上照样装竖屏适配', () => {
  const remote = [{ profile: 'web', deps: { 'dsh-web-mobile': '3.2.1' }, bundles: [] }];
  const gaps = diffPlugins({}, remote, { targetProfile: 'web' });
  assert.equal(gaps[0].installable, true);
  assert.equal(gaps[0].target, 'dsh-web-mobile@3.2.1');
  assert.equal(gaps[0].reason, null);
});

test('各自最优：通用插件不受平台过滤影响', () => {
  const remote = [{ profile: 'web', deps: { 'dsh-context': '0.82.0' }, bundles: [] }];
  const gaps = diffPlugins({}, remote, { targetProfile: 'desktop' });
  assert.equal(gaps[0].installable, true);
  assert.equal(gaps[0].platform, null);
});

test('各自最优：设备类别未知时不过滤（宁多报不漏报）', () => {
  const remote = [{ profile: 'weird', deps: { 'dsh-web-mobile': '3.2.1' }, bundles: [] }];
  const gaps = diffPlugins({}, remote, { targetProfile: 'weird-2' });
  assert.equal(gaps[0].installable, true);
});

test('各自最优：allowPlatform 可显式放行', () => {
  const remote = [{ profile: 'web', deps: { 'dsh-web-mobile': '3.2.1' }, bundles: [] }];
  const gaps = diffPlugins({}, remote, { targetProfile: 'desktop', allowPlatform: ['dsh-web-mobile'] });
  assert.equal(gaps[0].installable, true);
});

// ---- 版本够用判定：两端各自最优，本机装得更新不算「不符」 ----

test('minVersionOf：常见范围取下界', () => {
  assert.deepEqual(minVersionOf('^0.82.1'), [0, 82, 1]);
  assert.deepEqual(minVersionOf('~2.6.1'), [2, 6, 1]);
  assert.deepEqual(minVersionOf('0.82.0'), [0, 82, 0]);
  assert.deepEqual(minVersionOf('>=0.2.1-rc.5 <0.3.0'), [0, 2, 1]);
  assert.equal(minVersionOf('latest'), null);
  assert.equal(minVersionOf('1.0.0 - 2.0.0'), null);
});

test('各自最优：已装版本满足 ^ 范围 → 不报 outdated（否则会触发降级）', () => {
  const gaps = diffPlugins({ 'dsh-context': '0.82.1' }, [
    { profile: 'desktop', deps: { 'dsh-context': '^0.82.1' }, bundles: [] },
  ]);
  assert.equal(gaps.length, 0);
});

test('各自最优：本机比清单更新 → 保留本机版本，不降级', () => {
  const gaps = diffPlugins({ 'dsh-context': '0.82.1' }, [
    { profile: 'web', deps: { 'dsh-context': '0.82.0' }, bundles: [] },
  ]);
  assert.equal(gaps.length, 0);
});

test('版本确实落后 → 仍然报 outdated', () => {
  const gaps = diffPlugins({ 'dsh-context': '0.80.0' }, [
    { profile: 'desktop', deps: { 'dsh-context': '^0.82.1' }, bundles: [] },
  ]);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].status, 'outdated');
});

test('预发布版本按三元组比对，不会误报', () => {
  const gaps = diffPlugins({ 'dsh-media-desk': '2.6.1' }, [
    { profile: 'web', deps: { 'dsh-media-desk': '2.6.1' }, bundles: [] },
  ]);
  assert.equal(gaps.length, 0);
});

test('latest 这类 tag 装了就算满足', () => {
  const gaps = diffPlugins({ x: '1.0.0' }, [{ profile: 'desktop', deps: { x: 'latest' }, bundles: [] }]);
  assert.equal(gaps.length, 0);
});

// ---- 已装清单口径：只认 profile 声明的插件，不认 node_modules 里的一堆依赖 ----

test('declaredPluginNames：内置 bundle 不列出来', () => {
  const names = declaredPluginNames({
    '@deepseek-ai/dsh-base': '*',
    '@deepseek-ai/dsh-web-app': '*',
    'dsh-context': '^0.82.1',
    'dsh-nas-sync': 'git+https://github.com/Benson-Cao/dsh-nas-sync.git',
  });
  assert.deepEqual(names, ['dsh-context', 'dsh-nas-sync']);
});

test('declaredPluginNames：不按名字猜插件，scoped 包照样算', () => {
  const names = declaredPluginNames({
    '@acme/dsh-theme': '1.0.0',
    'dsh-guizang-design': '0.1.4',
    'weird-name': '2.0.0',
  });
  assert.deepEqual(names, ['@acme/dsh-theme', 'dsh-guizang-design', 'weird-name']);
});

test('declaredPluginNames：空依赖不炸', () => {
  assert.deepEqual(declaredPluginNames({}), []);
});

// ---- 仓库地址 → tarball 地址：手机没有 git 也能装 ----

test('toTarballSpec：git+https 转成 archive 地址', () => {
  assert.equal(
    toTarballSpec('git+https://github.com/Benson-Cao/dsh-nas-sync.git'),
    'https://github.com/Benson-Cao/dsh-nas-sync/archive/HEAD.tar.gz',
  );
});

test('toTarballSpec：带 .git / 不带 .git / 结尾斜杠都一样处理', () => {
  const want = 'https://github.com/u/r/archive/HEAD.tar.gz';
  assert.equal(toTarballSpec('https://github.com/u/r'), want);
  assert.equal(toTarballSpec('https://github.com/u/r.git'), want);
  assert.equal(toTarballSpec('https://github.com/u/r/'), want);
  assert.equal(toTarballSpec('https://www.github.com/u/r'), want);
});

test('toTarballSpec：#ref 变成对应版本/分支', () => {
  assert.equal(
    toTarballSpec('git+https://github.com/u/r.git#v0.4.4'),
    'https://github.com/u/r/archive/v0.4.4.tar.gz',
  );
});

test('toTarballSpec：ssh 形式也认', () => {
  const want = 'https://github.com/u/r/archive/HEAD.tar.gz';
  assert.equal(toTarballSpec('git@github.com:u/r.git'), want);
  assert.equal(toTarballSpec('git+ssh://git@github.com/u/r.git'), want);
});

test('toTarballSpec：非 GitHub / 非 git 一律不动', () => {
  assert.equal(toTarballSpec('dsh-context@0.82.0'), null);
  assert.equal(toTarballSpec('https://gitlab.com/u/r.git'), null);
  assert.equal(toTarballSpec('link:/data/user/0/x'), null);
  assert.equal(toTarballSpec(''), null);
});

test('配到手机档：git 依赖自动改用 tarball', () => {
  const remote = [{ profile: 'web', deps: { 'dsh-nas-sync': 'git+https://github.com/u/r.git' }, bundles: [] }];
  const gaps = diffPlugins({}, remote, { targetProfile: 'web' });
  assert.equal(gaps[0].target, 'https://github.com/u/r/archive/HEAD.tar.gz');
  assert.equal(gaps[0].installable, true);
  assert.ok(installCommand('web', gaps[0].target).includes('/archive/HEAD.tar.gz'));
});

test('配到电脑档：git 依赖保持原样（能跟踪分支）', () => {
  const remote = [{ profile: 'web', deps: { 'dsh-nas-sync': 'git+https://github.com/u/r.git' }, bundles: [] }];
  const gaps = diffPlugins({}, remote, { targetProfile: 'desktop' });
  assert.equal(gaps[0].target, 'git+https://github.com/u/r.git');
});
