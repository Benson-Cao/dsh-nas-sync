/**
 * state-file.ts 的离线单测（0.5.9）
 *
 * 针对 0.5.8 审查报告里 Q05/Q06：
 *   · 屏蔽清单写坏/读坏 → 静默清空（fail-open）；
 *   · store.json 非原子写 → 进程被杀留半截 JSON；
 *   · 解析失败整份重置 → 连 scrypt salt 一起丢。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readJsonFile, readTextFile, writeJsonAtomic, writeTextAtomic, writeBackup,
} from '../dist-test/state-file.mjs';

function sandbox() {
  return mkdtempSync(join(tmpdir(), 'dsh-state-file-'));
}

test('writeJsonAtomic：内容完整、同目录无临时文件残留', () => {
  const d = sandbox();
  const p = join(d, 'nested', 'state.json');
  writeJsonAtomic(p, { a: 1, cn: '胎教Agent' });
  assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), { a: 1, cn: '胎教Agent' });
  assert.deepEqual(readdirSync(join(d, 'nested')), ['state.json']);
  // 反复覆盖不累积垃圾，且始终是可解析的完整 JSON
  for (let i = 0; i < 20; i++) writeJsonAtomic(p, { a: i, pad: 'x'.repeat(5000) });
  assert.equal(JSON.parse(readFileSync(p, 'utf8')).a, 19);
  assert.deepEqual(readdirSync(join(d, 'nested')), ['state.json']);
  assert.ok(p.endsWith('state.json'));
});

test('writeJsonAtomic：文件权限尽力收紧到 0600（POSIX）', () => {
  if (process.platform === 'win32') return; // Windows 的 chmod 语义不同，跳过
  const d = sandbox();
  const p = join(d, 'secret.json');
  writeJsonAtomic(p, { passphrase: 'never-log-me' });
  assert.equal(statSync(p).mode & 0o777, 0o600);
  assert.equal(statSync(d).mode & 0o777, 0o700);
});

test('readJsonFile：区分「不存在」与「损坏」，损坏时留备份副本', () => {
  const d = sandbox();
  const p = join(d, 'ignored-sessions.json');

  const missing = readJsonFile(p);
  assert.equal(missing.missing, true);
  assert.equal(missing.corrupted, false);
  assert.equal(missing.data, null);

  writeFileSync(p, '["session-a", "session-b"]', 'utf8');
  assert.deepEqual(readJsonFile(p).data, ['session-a', 'session-b']);

  writeFileSync(p, '["session-a",  <-- 手滑写坏了', 'utf8');
  const broken = readJsonFile(p);
  assert.equal(broken.corrupted, true);
  assert.equal(broken.missing, false);
  assert.equal(broken.data, null);
  assert.ok(broken.quarantinedTo && existsSync(broken.quarantinedTo), '坏文件必须留证');
  assert.match(readFileSync(broken.quarantinedTo, 'utf8'), /手滑写坏了/);
  // 原件仍在，调用方可以决定从 .bak 恢复还是 fail-closed
  assert.ok(existsSync(p));
});

test('fail-closed 恢复链：主文件损坏时以 .bak 为准，主文件缺失时自动回填', () => {
  const d = sandbox();
  const p = join(d, 'ignored-sessions.json');
  const ids = ['session-a', 'session-b', 'session-c'];
  writeJsonAtomic(p, ids);
  assert.equal(writeBackup(p), true);
  assert.deepEqual(JSON.parse(readFileSync(p + '.bak', 'utf8')), ids);

  // 主文件被写坏：应从备份拿到完整集合，而不是空集合
  writeFileSync(p, '{not json', 'utf8');
  const fromBak = readJsonFile(p + '.bak').data;
  assert.deepEqual(fromBak, ids);
  writeJsonAtomic(p, fromBak); // 模拟 loadIgnoredFile() 的自愈写回
  assert.deepEqual(readJsonFile(p).data, ids);

  // 主文件被误删：同样从备份恢复
  rmSync(p);
  assert.equal(readJsonFile(p).missing, true);
  assert.deepEqual(readJsonFile(p + '.bak').data, ids);
});

test('writeTextAtomic：salt.hex 独立持久化，读回可校验', () => {
  const d = sandbox();
  const p = join(d, 'salt.hex');
  assert.equal(readTextFile(p).missing, true);
  const salt = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  writeTextAtomic(p, salt + '\n');
  assert.equal(readTextFile(p).data.trim(), salt);
  // 覆盖写入不会残留半个 salt
  writeTextAtomic(p, salt.toUpperCase() + '\n');
  assert.equal(readTextFile(p).data.trim(), salt.toUpperCase());
  assert.deepEqual(readdirSync(d), ['salt.hex']);
});

test('只读校验：本测试不写入真实 $DSH_HOME', () => {
  // 状态文件工具一律要求显式路径；这里确认异常路径不会隐式创建目录
  const d = sandbox();
  const r = readJsonFile(join(d, 'nope', 'x.json'));
  assert.equal(r.missing, true);
  assert.equal(existsSync(join(d, 'nope')), false);
});
