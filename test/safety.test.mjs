/**
 * safety.ts 的离线单测（0.5.9）
 *
 * 针对 0.5.8 审查报告里 Q01/Q04 两条阻断级：
 *   · 「至少一份清单读成」被当成「全部读成」→ 可能误删本机会话；
 *   · 「连续两轮」被实现成「累计两轮」；
 *   · 远端 rel 未校验就进文件系统路径。
 * 这些全是纯判据，必须能脱离 Engine / NAS / 宿主单测。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isSafeRel, evaluateManifestTrust, advanceMissingRounds, shouldRetire,
  RETIRE_AFTER_MISSING_ROUNDS,
} from '../dist-test/safety.mjs';

test('isSafeRel：正常 rel 放行', () => {
  const good = [
    'storages/workspace.json',
    'sessions/--C-Users-Administrator-wstest--/session-aa35e064/session.v4.jsonl.zstd',
    'sessions/~9CB8~9C7C~5BA0~7269/sid/session.v4.jsonl.zstd',
    'workspaces/胎教Agent/notes/读我.md',
    'attachments/2026/11/a b (1).png',
  ];
  for (const rel of good) assert.equal(isSafeRel(rel), true, rel);
});

test('isSafeRel：路径穿越 / 绝对路径 / 编码穿越 / 控制字符一律拒绝', () => {
  const bad = [
    '', null, undefined, 42, {},
    '../secrets.txt',
    'sessions/../../etc/passwd',
    'sessions/./sid/session.v4.jsonl.zstd',
    '/etc/passwd',
    '\\UNC\\share\\x',
    'C:/Windows/System32/x',
    'D:\\data\\x',
    'sessions\\..\\..\\x',
    'sessions/%2e%2e/secrets',
    'sessions/foo%2fbar',
    'sessions/x\0y',
    'sessions/x\n/evil',
    'sessions/trailing./x',
    'sessions/trailing /x',
    'x'.repeat(1025),
  ];
  for (const rel of bad) assert.equal(isSafeRel(rel), false, String(rel));
});

test('evaluateManifestTrust：必须每一份都读成；空清单算读成', () => {
  assert.deepEqual(
    evaluateManifestTrust([
      { name: 'a.json', entries: [{ rel: 'x' }] },
      { name: 'b.json', entries: [] },
    ]),
    { trusted: true, failed: [], okCount: 2 },
  );
  const partial = evaluateManifestTrust([
    { name: 'a.json', entries: [{ rel: 'x' }] },
    { name: 'b.json', entries: null },
  ]);
  assert.equal(partial.trusted, false);
  assert.deepEqual(partial.failed, ['b.json']);
  assert.equal(partial.okCount, 1);
  assert.equal(evaluateManifestTrust([]).trusted, false, '一份清单都没有时绝不能据此删本地文件');
});

test('advanceMissingRounds：严格连续两轮，任何打断都归零', () => {
  const missing = (previous, trusted = true) => advanceMissingRounds({ trusted, present: false, previous });
  assert.equal(missing(undefined), 1);
  assert.equal(missing(1), 2);
  assert.equal(shouldRetire(missing(1)), true);
  assert.equal(RETIRE_AFTER_MISSING_ROUNDS, 2);
  // 不可信轮：0.5.8 在这里不复位，导致「可信缺 → 不可信 → 可信缺」也累计到 2
  assert.equal(missing(1, false), 0);
  // 本轮又出现了
  assert.equal(advanceMissingRounds({ trusted: true, present: true, previous: 1 }), 0);
  // 历史脏数据
  assert.equal(missing(NaN), 1);
  assert.equal(missing(-7), 1);
  assert.equal(missing(3.9), 4);
  assert.equal(shouldRetire(0), false);
  assert.equal(shouldRetire(undefined), false);
});

test('Q01 回归：N 份清单坏 1 份时，连续两轮缺失也不允许回收', () => {
  // 模拟设备清单：手机那份解密失败，PC 那份读成但不含目标会话
  const reads = [
    { name: 'android_localhost.json', entries: null },
    { name: 'win32_Benson.json', entries: [] },
  ];
  const trust = evaluateManifestTrust(reads);
  assert.equal(trust.trusted, false);

  let rounds = 0;
  for (let round = 1; round <= 4; round++) {
    rounds = advanceMissingRounds({ trusted: trust.trusted, present: false, previous: rounds });
    assert.equal(shouldRetire(rounds), false, '第 ' + round + ' 轮不该回收');
  }
  assert.equal(rounds, 0, '不可信轮必须持续把计数压回 0');
});

test('Q01 正例：全部读成时，第二轮可信缺失才允许回收', () => {
  const trust = evaluateManifestTrust([
    { name: 'a.json', entries: [] },
    { name: 'b.json', entries: [] },
  ]);
  assert.equal(trust.trusted, true);
  const r1 = advanceMissingRounds({ trusted: true, present: false, previous: undefined });
  assert.equal(shouldRetire(r1), false);
  const r2 = advanceMissingRounds({ trusted: true, present: false, previous: r1 });
  assert.equal(shouldRetire(r2), true);
  // 中间夹一轮不可信，必须重新开始数
  const reset = advanceMissingRounds({ trusted: false, present: false, previous: r1 });
  const after = advanceMissingRounds({ trusted: true, present: false, previous: reset });
  assert.equal(shouldRetire(after), false, '不可信轮打断后必须重新累计两轮');
});
