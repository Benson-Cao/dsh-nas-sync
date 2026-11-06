/**
 * portable.ts 的离线单测。
 *
 * 覆盖 0.3.2 ~ 0.3.5 里改过的「状态收敛」纯函数 —— 这几版全是在动注册表归一、
 * 会话目录去重、会话头 cwd 改写，以前没有一条测试，只能靠真机踩。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as zlib from 'node:zlib';

import {
  encodeCwd,
  normalizeWorkspaceRegistry,
  dedupeWorkspaceSessions,
  dedupeSessionDirs,
  workspaceRegistryReady,
  rewriteSessionCwd,
  platformMismatch,
} from '../dist-test/portable.mjs';

function home() {
  return mkdtempSync(join(tmpdir(), 'dsh-portable-'));
}

test('encodeCwd：包在 -- 里、不含路径分隔符', () => {
  const enc = encodeCwd('/data/user/0/com.dsh.harness/files/home/wstest');
  assert.ok(enc.startsWith('--') && enc.endsWith('--'), enc);
  assert.ok(!/[\\/:]/.test(enc), enc);
  // 非 ASCII 走 ~XXXX 转义
  const cn = encodeCwd('/a/胎教Agent');
  assert.ok(cn.includes('~'), cn);
});

test('platformMismatch：按本机平台判定原始 cwd', () => {
  if (process.platform === 'win32') {
    assert.equal(platformMismatch('/data/user/0/x'), true);
    assert.equal(platformMismatch('C:\\Users\\x\\wstest'), false);
  } else {
    assert.equal(platformMismatch('C:\\Users\\x\\wstest'), true);
    assert.equal(platformMismatch('/data/user/0/x'), false);
  }
  assert.equal(platformMismatch(''), true);
});

test('workspaceRegistryReady：0.3.5 条件式守卫的判据', () => {
  const h = home();
  // 1) 完全没有注册表 → 新机器首次同步，必须放行
  assert.equal(workspaceRegistryReady(h), false);

  // 2) 有文件但表为空 → 仍不可用
  mkdirSync(join(h, 'storages'), { recursive: true });
  writeFileSync(join(h, 'storages', 'workspace.json'), JSON.stringify({ global: { workspaceIds: [] }, tables: { workspaces: {} } }));
  assert.equal(workspaceRegistryReady(h), false);

  // 3) initialized 明确为 false → 不可用
  writeFileSync(
    join(h, 'storages', 'workspace.json'),
    JSON.stringify({ global: { workspaceIds: ['w1'], initialized: false }, tables: { workspaces: { w1: {} } } }),
  );
  assert.equal(workspaceRegistryReady(h), false);

  // 4) 正常注册表 → 可用
  writeFileSync(
    join(h, 'storages', 'workspace.json'),
    JSON.stringify({ global: { workspaceIds: ['w1'], initialized: true }, tables: { workspaces: { w1: {} } } }),
  );
  assert.equal(workspaceRegistryReady(h), true);
});

test('normalizeWorkspaceRegistry：同名同 path 合并 + session 去重', () => {
  const reg = {
    global: { workspaceIds: ['w1', 'w2'], defaultWorkspaceId: 'w2', initialized: true },
    tables: {
      workspaces: {
        w1: { id: 'w1', title: 'wstest', path: 'C:/x/wstest', sessionIds: ['s1', 's2'] },
        w2: { id: 'w2', title: 'wstest', path: 'C:/x/wstest', sessionIds: ['s2', 's3'] },
      },
    },
  };
  const r = normalizeWorkspaceRegistry(reg);
  assert.equal(r.merged, 1, JSON.stringify(r));
  assert.equal(Object.keys(reg.tables.workspaces).length, 1);
  assert.deepEqual(reg.tables.workspaces.w1.sessionIds.sort(), ['s1', 's2', 's3']);
  assert.deepEqual(reg.global.workspaceIds, ['w1']);
  // default 被合并掉时必须重指到还活着的那个
  assert.equal(reg.global.defaultWorkspaceId, 'w1');
});

test('dedupeWorkspaceSessions：同一 session 被两个工作区记账', () => {
  const reg = {
    global: { workspaceIds: ['a', 'b'] },
    tables: {
      workspaces: {
        a: { id: 'a', title: 'A', path: 'C:/a', sessionIds: ['s1', 's2'] },
        b: { id: 'b', title: 'B', path: 'C:/b', sessionIds: ['s2', 's3'] },
      },
    },
  };
  const removed = dedupeWorkspaceSessions(reg);
  assert.equal(removed, 1, JSON.stringify(reg.tables.workspaces));
  const all = [...reg.tables.workspaces.a.sessionIds, ...reg.tables.workspaces.b.sessionIds];
  assert.equal(all.filter((s) => s === 's2').length, 1);
});

test('rewriteSessionCwd：只重写第 0 帧，后续帧逐字节保留', () => {
  const h = home();
  const head = JSON.stringify({ type: 'session', id: 's-1', cwd: 'C:\\no-such-dir-9f3a' }) + '\n';
  const frame0 = zlib.zstdCompressSync(Buffer.from(head, 'utf8'));
  const frame1 = zlib.zstdCompressSync(Buffer.from('{"n":1}\n', 'utf8'));
  const frame2 = zlib.zstdCompressSync(Buffer.from('{"n":2}\n', 'utf8'));
  const buf = Buffer.concat([frame0, frame1, frame2]);

  const out = rewriteSessionCwd(buf, h);
  assert.ok(out, '应返回改写结果');
  assert.ok(out.dir.includes('nassyncworkspaces') || out.dir.includes('workspaces'), out.dir);

  // 尾帧必须原样（这是 0.3.1 踩过的坑：整文件重压会把历史截成只剩表头）
  const tail = Buffer.concat([frame1, frame2]);
  assert.deepEqual(out.buf.subarray(out.buf.length - tail.length), tail);

  // 改后的第 0 帧能解回新 cwd
  const text0 = zlib.zstdDecompressSync(out.buf).toString('utf8');
  const header = JSON.parse(text0.split('\n')[0]);
  assert.equal(header.cwd, out.dir);
  assert.equal(header.type, 'session');
});

test('rewriteSessionCwd：cwd 本机已存在时不动', () => {
  const h = home();
  const local = join(h, 'real-workspace');
  mkdirSync(local, { recursive: true });
  const head = JSON.stringify({ type: 'session', id: 's-2', cwd: local }) + '\n';
  const buf = zlib.zstdCompressSync(Buffer.from(head, 'utf8'));
  assert.equal(rewriteSessionCwd(buf, h), null);
});

test('dedupeSessionDirs：同一 sid 落在两个 project 目录 → 隔离副本', async () => {
  const h = home();
  const sid = '2fdb1986-6097-4337-bc10-1f42acec576e';
  const a = join(h, 'sessions', '--data-user-0-files-home-wstest--', sid);
  const b = join(h, 'sessions', '--data-user-0-files-home-.dsh-nassyncworkspaces-wstest--', sid);
  for (const d of [a, b]) {
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'session.v4.jsonl.zstd'), 'x');
  }
  const r = await dedupeSessionDirs(h);
  assert.equal(r.duplicates, 1, JSON.stringify(r));
  assert.equal(r.isolated, 1, JSON.stringify(r));
  // 无注册表、无 lock 时按字典序保留：--data-user-0-files-home-.dsh... 更小
  assert.ok(existsSync(a) || existsSync(b), '至少留一份');
  const kept = existsSync(a) ? a : b;
  const dropped = kept === a ? b : a;
  assert.equal(existsSync(dropped), false, '副本应已移走');

  // 幂等：再跑一次不应继续隔离
  const r2 = await dedupeSessionDirs(h);
  assert.equal(r2.duplicates, 0, JSON.stringify(r2));
});

test('dedupeSessionDirs：没有 sessions 目录时安全返回', async () => {
  const h = home();
  const r = await dedupeSessionDirs(h);
  assert.deepEqual(r, { scanned: 0, duplicates: 0, isolated: 0 });
});
