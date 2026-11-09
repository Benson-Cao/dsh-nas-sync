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
  const home = makeHome([], {
    a: { path: 'D:/work/demo', title: 'demo' },
    b: { path: 'D:/other/demo', title: 'demo2' },
  });
  try {
    const got = await detectWorkspaceCollisions(home);
    assert.equal(got.length, 1);
    assert.equal(got[0].rel, 'workspaces/demo');
    assert.deepEqual(got[0].paths, ['D:/other/demo', 'D:/work/demo'].map((p) => p.replace(/\//g, '\\')).sort());
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('不同名工作区 → 无冲突', async () => {
  const home = makeHome([], {
    a: { path: 'D:/work/alpha' },
    b: { path: 'D:/work/beta' },
  });
  try {
    assert.deepEqual(await detectWorkspaceCollisions(home), []);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('同一路径写了两条记录 → 不算冲突（去重）', async () => {
  const home = makeHome([], {
    a: { path: 'D:/work/demo' },
    b: { path: 'D:/work/demo' },
  });
  try {
    assert.deepEqual(await detectWorkspaceCollisions(home), []);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('注册表与兜底目录同名 → 也算冲突（合并判定）', async () => {
  const home = makeHome(['demo'], { a: { path: 'D:/work/demo' } });
  try {
    const got = await detectWorkspaceCollisions(home);
    assert.equal(got.length, 1);
    assert.equal(got[0].paths.length, 2, '注册表路径 + $DSH_HOME/nassyncworkspaces/demo 都要出现');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('多组冲突按 rel 字典序返回（确定性）', async () => {
  const home = makeHome([], {
    a1: { path: 'D:/x/zeta' }, a2: { path: 'D:/y/zeta' },
    b1: { path: 'D:/x/alpha' }, b2: { path: 'D:/y/alpha' },
  });
  try {
    const got = await detectWorkspaceCollisions(home);
    assert.deepEqual(got.map((g) => g.rel), ['workspaces/alpha', 'workspaces/zeta']);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('注册表损坏 / 不存在 → 空数组而不是抛错', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-collide-bad-'));
  try {
    mkdirSync(join(home, 'storages'), { recursive: true });
    writeFileSync(join(home, 'storages', 'workspace.json'), '{not json');
    assert.deepEqual(await detectWorkspaceCollisions(home), []);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
