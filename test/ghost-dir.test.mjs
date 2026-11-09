/**
 * 0.6.3：已删会话留下的空目录 → 必须清掉。
 *
 * 真机现象：手机删会话 → 电脑端文件进了回收站、`workspace.json` 也清了，
 * 侧栏那条还在（点开报错）。原因是 `sessions/<编码>/<sid>/` 目录本身还在，
 * 宿主按目录列举会话。这里锁死清理函数的三个边界：只删空目录、只删已删 sid、
 * 太新的目录不碰（可能正在写）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { pruneEmptySessionDirs } = await import('../dist-test/portable.mjs');

const ENC = '--data-user-0-com.dsh.harness-files-home-wstest--';
const OLD = 'session-44444444-4444-4444-8444-444444444444';
const OLD_WITH_FILE = 'session-55555555-5555-4555-8555-555555555555';
const ALIVE = 'session-66666666-6666-4666-8666-666666666666';
const FRESH = 'session-77777777-7777-4777-8777-777777777777';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-ghost-dir-'));
  const base = join(home, 'sessions', ENC);
  for (const sid of [OLD, OLD_WITH_FILE, ALIVE, FRESH]) mkdirSync(join(base, sid), { recursive: true });
  writeFileSync(join(base, OLD_WITH_FILE, 'session.v4.jsonl.zstd'), 'x');
  writeFileSync(join(base, ALIVE, 'session.v4.jsonl.zstd'), 'y');
  // 除了 FRESH，其余目录都改成 10 分钟前（跨过 120s 的抢跑保护）
  const past = new Date(Date.now() - 10 * 60_000);
  for (const sid of [OLD, OLD_WITH_FILE, ALIVE]) utimesSync(join(base, sid), past, past);
  mkdirSync(join(home, 'sessions', '.sessions-trash'), { recursive: true });
  return { home, base };
}

test('空目录 + 已删 sid + 够旧 → 删；有文件 / 未删 / 太新 一律保留', async () => {
  const { home, base } = fixture();
  try {
    const dead = new Set([OLD, OLD_WITH_FILE, FRESH]);
    const removed = await pruneEmptySessionDirs(dead, home, { minAgeMs: 120_000 });

    assert.deepEqual(removed, [ENC + '/' + OLD], '只该删掉那一个又空又旧又已删的目录');
    assert.equal(existsSync(join(base, OLD)), false, '空目录必须消失（否则侧栏留幽灵）');
    assert.equal(existsSync(join(base, OLD_WITH_FILE)), true, '还有残留文件的目录不能删');
    assert.equal(existsSync(join(base, ALIVE)), true, '没被删的会话一根毫毛都不动');
    assert.equal(existsSync(join(base, FRESH)), true, '刚动过的目录不碰（可能正在写）');
    assert.equal(existsSync(join(home, 'sessions', '.sessions-trash')), true, '回收站目录永远不碰');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('已删集合为空 → 一个目录都不扫（不做无用 IO，也不冒险）', async () => {
  const { home, base } = fixture();
  try {
    assert.deepEqual(await pruneEmptySessionDirs(new Set(), home), []);
    assert.equal(existsSync(join(base, OLD)), true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
