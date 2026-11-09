/**
 * 0.6.0 / P3：排除规则统一。
 *
 * 0.5.9 里 scanner.ts 与 portable.ts 各有一份跳过集合，且互不一致。这里锁住
 * 「两边现在用的是同一把尺子」，防止将来又长出第三份副本。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { SKIP_DIR_NAMES, isSkippedDirName, isIgnoredFileName, isIgnoredRelPath } =
  await import('../dist-test/exclusions.mjs');
const { isIgnoredRel } = await import('../dist-test/scanner.mjs');

test('并集覆盖两边原有条目：工作区专属与普通分类专属的目录都在', () => {
  // 原来只在 portable.ts 的 WORKSPACE_SKIP_DIRS
  for (const d of ['.git', '.svn', '.hg', '__pycache__', '.venv', 'venv', '.next', '.nuxt', '.turbo', 'dsh-nas-sync']) {
    assert.ok(SKIP_DIR_NAMES.has(d), '缺少工作区侧条目：' + d);
  }
  // 原来只在 scanner.ts 的 SKIP_DIRS
  for (const d of ['node_modules', 'nas-sync', '.plugin-manager', '.cache', '.compile-cache']) {
    assert.ok(SKIP_DIR_NAMES.has(d), '缺少普通分类侧条目：' + d);
  }
});

test('scanner 的 isIgnoredRel 与共享规则完全一致', () => {
  const samples = [
    'sessions/a/f', 'attachments/a.png', 'node_modules/x/index.js',
    '.git/HEAD', '.plugin-manager/logs/x.log', 'workspaces/w/.next/build.js',
    'dsh-nas-sync/vendor/p.tgz', 'skills/k/SKILL.md',
    'a/x.session.base', 'a/x.chunk-manifest.json', 'a/x.lock', 'a/x.bak-2026', 'a/x.nassync-bak',
  ];
  for (const rel of samples) assert.equal(isIgnoredRel(rel), isIgnoredRelPath(rel), rel);
});

test('isSkippedDirName / isIgnoredFileName 的边界', () => {
  assert.equal(isSkippedDirName('node_modules'), true);
  assert.equal(isSkippedDirName('node_modules2'), false);
  assert.equal(isSkippedDirName(''), false);
  assert.equal(isIgnoredFileName('a.base'), true);
  assert.equal(isIgnoredFileName('a.lock'), true);
  assert.equal(isIgnoredFileName('a.bak-1'), true);
  assert.equal(isIgnoredFileName('a.txt'), false);
  assert.equal(isIgnoredFileName(''), false);
});

test('正常用户内容不被误排除', () => {
  for (const rel of [
    'sessions/--C-Users-Admin/s1/session.v4.jsonl.zstd',
    'attachments/2026/photo.png',
    'skills/my-skill/SKILL.md',
    'workspaces/demo/src/main.ts',
    'custom-folders/notes/todo.md',
  ]) {
    assert.equal(isIgnoredRelPath(rel), false, rel);
  }
});

test('0.6.0 / 收尾②：DSH 会话回收站不参与同步', () => {
  // 回收站位于 sessions/.sessions-trash/，落在 sessions 分类的扫描前缀内。
  // 不排除的话，一端删会话会被同步成「对端多了两个新文件」，删除意图反而丢失。
  assert.ok(SKIP_DIR_NAMES.has('.sessions-trash'), '回收站目录必须进跳过集合');
  assert.equal(
    isIgnoredRelPath('sessions/.sessions-trash/2026-11-09T10-52-22.155Z---enc---session-a/manifest.json'),
    true,
  );
  assert.equal(
    isIgnoredRelPath('sessions/.sessions-trash/2026-11-09T10-52-22.155Z---enc---session-a/session.v4.jsonl.zstd.trash'),
    true,
  );
  // 正常会话路径不能被误伤（删除判定必须还能看到它）
  assert.equal(isIgnoredRelPath('sessions/--enc--/session-a/session.v4.jsonl.zstd'), false);
});
