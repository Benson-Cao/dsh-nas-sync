/**
 * 0.6.0 收尾 · 工作区 rel 撞车检测
 * --------------------------------
 * rel 空间按目录基名挂载（`workspaces/<名字>`）。两个不同路径的同名工作区会抢
 * 同一个前缀：`collectWorkspaceDirs()` 已经会把后到的那个**跳过**（不互相覆盖），
 * 但跳得没有声音。这里锁死「跳过必须可见」：检测函数要确定性返回冲突组，
 * 顺序稳定、同一路径不重复计、注册表与兜底目录合并判定。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { detectWorkspaceCollisions } = await import('../dist-test/portable.mjs');

function makeHome(dirNames = [], registry = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-collide-'));
  mkdirSync(join(home, 'storages'), { recursive: true });
  // 兜底目录用的是 nassyncworkspaces（不是 workspaces —— dsh 自己会把后者当工作区根）
  mkdirSync(join(home, 'nassyncworkspaces'), { recursive: true });
  writeFileSync(join(home, 'storages', 'workspace.json'), JSON.stringify({
    tables: { workspaces: registry },
  }));
  for (const n of dirNames) {
    mkdirSync(join(home, 'nassyncworkspaces', n), { recursive: true });
  }
  return home;
}

test('不同路径同名工作区 → 报 1 组冲突且路径按字典序', async () => {
  // 必须用平台无关路径：写死 D:/work/demo 在 Linux runner 上会被 resolve 成
  // /home/runner/work/.../D:/work/demo，rel 基名虽然还是 demo，但期望值对不上，
  // CI 会红而本地绿。用两个不同父目录 + 同一个 basename 构造冲突。
  const base = mkdtempSync(join(tmpdir(), 'dsh-collide-paths-'));
  const p1 = join(base, 'ws-a', 'demo');
  const p2 = join(base, 'ws-b', 'demo');
  mkdirSync(p1, { recursive: true });
  mkdirSync(p2, { recursive: true });
  const home = makeHome([], { a: { path: p1, title: 'demo' }, b: { path: p2, title: 'demo2' } });
  try {
    const got = await detectWorkspaceCollisions(home);
    assert.equal(got.length, 1);
    assert.equal(got[0].rel, 'workspaces/demo');
    assert.deepEqual(got[0].paths, [p1, p2].sort());
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  }
});

test('不同名工作区 → 无冲突', async () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-collide-ok-'));
  const home = makeHome([], {
    a: { path: join(base, 'alpha') },
    b: { path: join(base, 'beta') },
  });
  mkdirSync(join(base, 'alpha'), { recursive: true });
  mkdirSync(join(base, 'beta'), { recursive: true });
  try {
    assert.deepEqual(await detectWorkspaceCollisions(home), []);
  } finally { rmSync(base, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test('同一路径写了两条记录 → 不算冲突（去重）', async () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-collide-same-'));
  const same = join(base, 'demo');
  mkdirSync(same, { recursive: true });
  const home = makeHome([], {
    a: { path: same },
    b: { path: same },
  });
  try {
    assert.deepEqual(await detectWorkspaceCollisions(home), []);
  } finally { rmSync(base, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test('注册表与兜底目录同名 → 也算冲突（合并判定）', async () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-collide-mix-'));
  const outside = join(base, 'demo');
  mkdirSync(outside, { recursive: true });
  const home = makeHome(['demo'], { a: { path: outside } });
  try {
    const got = await detectWorkspaceCollisions(home);
    assert.equal(got.length, 1);
    assert.equal(got[0].paths.length, 2, '注册表路径 + $DSH_HOME/nassyncworkspaces/demo 都要出现');
  } finally { rmSync(base, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test('多组冲突按 rel 字典序返回（确定性）', async () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-collide-multi-'));
  const home = makeHome([], {
    a1: { path: join(base, 'x', 'zeta') }, a2: { path: join(base, 'y', 'zeta') },
    b1: { path: join(base, 'x', 'alpha') }, b2: { path: join(base, 'y', 'alpha') },
  });
  try {
    const got = await detectWorkspaceCollisions(home);
    assert.deepEqual(got.map((g) => g.rel), ['workspaces/alpha', 'workspaces/zeta']);
  } finally { rmSync(base, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test('注册表损坏 / 不存在 → 空数组而不是抛错', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-collide-bad-'));
  try {
    mkdirSync(join(home, 'storages'), { recursive: true });
    writeFileSync(join(home, 'storages', 'workspace.json'), '{not json');
    assert.deepEqual(await detectWorkspaceCollisions(home), []);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
