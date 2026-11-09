/**
 * portable.ts 的离线单测。
 *
 * 覆盖 0.3.2 ~ 0.3.5 里改过的「状态收敛」纯函数 —— 这几版全是在动注册表归一、
 * 会话目录去重、会话头 cwd 改写，以前没有一条测试，只能靠真机踩。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
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
  rewriteSessionCwdTo,
  platformMismatch,
  mergeWorkspaceRegistry,
  registryCovers,
  registerSessionForRel,
  unregisterSessionFromRel,
  localIsStaleSnapshot,
  sessionHeaderIdentity,
  zstdCapabilities,
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

test('rewriteSessionCwdTo：改回原机器路径，尾帧原样，已是目标值则返回 null', () => {
  const head = JSON.stringify({ type: 'session', id: 's-3', cwd: 'C:\\Users\\me\\nassyncworkspaces\\鲸鱼宠物' }) + '\n';
  const frame0 = zlib.zstdCompressSync(Buffer.from(head, 'utf8'));
  const frame1 = zlib.zstdCompressSync(Buffer.from('{"n":1}\n', 'utf8'));
  const buf = Buffer.concat([frame0, frame1]);

  const phoneCwd = '/data/user/0/com.dsh.harness/files/home/鲸鱼宠物';
  const back = rewriteSessionCwdTo(buf, phoneCwd);
  assert.ok(back, '应返回改写结果');
  // 尾帧逐字节保留（同 zstd 多帧限制：整文件重压会把历史截成只剩表头）
  assert.deepEqual(back.subarray(back.length - frame1.length), frame1);
  const text0 = zlib.zstdDecompressSync(back).toString('utf8');
  assert.equal(JSON.parse(text0.split('\n')[0]).cwd, phoneCwd);
  // 已经是目标值 → 不需要改写
  assert.equal(rewriteSessionCwdTo(back, phoneCwd), null);
});

test('localIsStaleSnapshot：本机是旧快照 → true，历史分叉 → false', () => {
  const head = (cwd) => zlib.zstdCompressSync(Buffer.from(JSON.stringify({ type: 'session', id: 's-9', cwd }) + '\n', 'utf8'));
  const ev = (n) => zlib.zstdCompressSync(Buffer.from('{"seq":' + n + '}\n', 'utf8'));

  // 手机原文：4 帧；本机镜像：同样 3 帧尾 + 改写过的表头（更早的快照）
  const remote = Buffer.concat([head('/data/user/0/x/wstest'), ev(1), ev(2), ev(3)]);
  const localStale = Buffer.concat([head('C:\\Users\\x\\wstest'), ev(1), ev(2)]);
  assert.equal(localIsStaleSnapshot(localStale, remote), true);

  // 只有表头的老快照也算（实测 aa35e064：本机 562B 表头 / 远端 579570B）
  assert.equal(localIsStaleSnapshot(head('C:\\Users\\x\\wstest'), remote), true);

  // 本机更多帧 = 本机跑在前面，不是旧快照
  const localAhead = Buffer.concat([head('C:\\Users\\x'), ev(1), ev(2), ev(3), ev(4)]);
  assert.equal(localIsStaleSnapshot(localAhead, remote), false);

  // 同一位置帧内容不同 = 两端各自继续过，绝不能覆盖
  const localForked = Buffer.concat([head('C:\\Users\\x'), ev(1), ev(9)]);
  assert.equal(localIsStaleSnapshot(localForked, remote), false);

  // 表头相同（未改写的同平台副本）也允许，属于幂等覆盖
  assert.equal(localIsStaleSnapshot(Buffer.concat([head('/data/user/0/x/wstest'), ev(1)]), remote), true);
});

test('0.5.9 localIsStaleSnapshot：单帧必须核首帧身份，不能无条件判旧快照', () => {
  const head = (cwd, id = 's-9', rest = '') => zlib.zstdCompressSync(
    Buffer.from(JSON.stringify({ type: 'session', id, cwd }) + '\n' + rest, 'utf8'));
  const ev = (n) => zlib.zstdCompressSync(Buffer.from('{"seq":' + n + '}\n', 'utf8'));
  const remote = Buffer.concat([head('/data/user/0/x/wstest'), ev(1)]);

  // 同一条会话、只差 cwd：仍然允许判为旧快照（保住 0.5.8 修 aa35e064 的能力）
  assert.equal(localIsStaleSnapshot(head('C:\\Users\\x\\wstest'), remote), true);

  // 0.5.8 的 bug：本地只有 1 帧时 for(i=1..0) 不执行，直接 return true。
  // 下面三种「其实不是同一条会话」的情况都必须挡住。
  const otherHeader = zlib.zstdCompressSync(Buffer.from(
    JSON.stringify({ type: 'session', id: 's-9', cwd: 'C:\\Users\\x\\wstest', createdAt: 999 }) + '\n', 'utf8'));
  assert.equal(localIsStaleSnapshot(otherHeader, remote), false);
  assert.equal(localIsStaleSnapshot(head('C:\\Users\\x\\wstest', 'another-session'), remote), false);
  assert.equal(localIsStaleSnapshot(head('C:\\Users\\x\\wstest', 's-9', '{"hello":1}\n'), remote), false);

  // 多帧历史分叉依旧拒绝（回归 0.5.8 的原语义）
  assert.equal(
    localIsStaleSnapshot(Buffer.concat([head('C:\\Users\\x\\wstest'), ev(9)]), remote), false);
});

test('0.5.9 sessionHeaderIdentity：忽略 cwd，其余字段与首帧正文逐字比较', () => {
  const mk = (cwd, extra = {}) => zlib.zstdCompressSync(Buffer.from(
    JSON.stringify({ cwd, id: 's-1', type: 'session', ...extra }) + '\n{"e":1}\n', 'utf8'));
  assert.equal(sessionHeaderIdentity(mk('/phone/wstest')), sessionHeaderIdentity(mk('C:\\pc\\wstest')));
  // key 顺序不同不影响
  const reordered = zlib.zstdCompressSync(Buffer.from(
    '{"type":"session","id":"s-1","cwd":"/phone/wstest"}\n{"e":1}\n', 'utf8'));
  assert.equal(sessionHeaderIdentity(mk('/phone/wstest')), sessionHeaderIdentity(reordered));
  assert.notEqual(sessionHeaderIdentity(mk('/phone/wstest', { v: 2 })), sessionHeaderIdentity(mk('/phone/wstest')));
  assert.equal(sessionHeaderIdentity(Buffer.from('not-a-zstd-frame')), null);
  assert.equal(typeof zstdCapabilities().compress, 'boolean');
});

test('unregisterSessionFromRel：摘掉登记，清单里没有则返回 false', async () => {
  const h = home();
  const wsDir = join(h, 'nassyncworkspaces', 'wstest');
  mkdirSync(wsDir, { recursive: true });
  mkdirSync(join(h, 'storages'), { recursive: true });
  const enc = encodeCwd(wsDir);
  const reg = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, defaultWorkspaceId: 'w1', workspaceIds: ['w1'], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: { workspaces: { w1: { path: wsDir, title: 'wstest', sessionIds: ['keep-me', 'drop-me'], createdAt: '', updatedAt: '' } } },
  };
  writeFileSync(join(h, 'storages', 'workspace.json'), JSON.stringify(reg, null, 2));

  const rel = 'sessions/' + enc + '/drop-me/session.v4.jsonl.zstd';
  assert.equal(await unregisterSessionFromRel(rel, h), true);
  const after = JSON.parse(readFileSync(join(h, 'storages', 'workspace.json'), 'utf8'));
  assert.deepEqual(after.tables.workspaces.w1.sessionIds, ['keep-me']);
  // 幂等：再摘一次没有变化
  assert.equal(await unregisterSessionFromRel(rel, h), false);
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

// ---------------------------------------------------------------------------
// 0.5.5：本机注册表已可用时，远端注册表仍要合并且把旧退化落点搬正
// ---------------------------------------------------------------------------

/** 造一个「本机已有 2 个工作区 + 一份已下到 workspaces/<名字> 的工作区文件」的家目录。 */
function homeWithSyncedWorkspaces(whaleFiles = 3) {
  const h = home();
  mkdirSync(join(h, 'storages'), { recursive: true });
  mkdirSync(join(h, 'nassyncworkspaces', 'wstest'), { recursive: true });
  const desktop = join(h, 'Desktop', '胎教Agent');
  mkdirSync(desktop, { recursive: true });
  writeFileSync(join(h, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      defaultWorkspaceId: 'id-wstest',
      workspaceIds: ['id-wstest', 'id-taijiao'],
      archivedSessionIds: [],
      pinnedSessionIds: [],
    },
    tables: {
      workspaces: {
        'id-wstest': {
          path: join(h, 'nassyncworkspaces', 'wstest'),
          title: 'wstest', sessionIds: ['s1'], createdAt: 'x', updatedAt: 'x',
        },
        'id-taijiao': {
          path: desktop, title: '胎教Agent', sessionIds: ['s2'], createdAt: 'x', updatedAt: 'x',
        },
      },
    },
  }, null, 2));

  const legacy = join(h, 'workspaces', '鲸鱼宠物');
  mkdirSync(join(legacy, 'src'), { recursive: true });
  for (let i = 0; i < whaleFiles; i++) writeFileSync(join(legacy, 'f' + i + '.txt'), String(i));
  return { h, desktop, legacy };
}

const REMOTE_REGISTRY = JSON.stringify({
  unit: { name: 'workspace', version: 2 },
  global: {
    initialized: true,
    defaultWorkspaceId: 'id-whale',
    workspaceIds: ['id-whale', 'id-taijiao', 'id-wstest'],
    archivedSessionIds: [],
    pinnedSessionIds: [],
  },
  tables: {
    workspaces: {
      'id-whale': {
        path: '/data/user/0/com.dsh.harness/files/home/鲸鱼宠物',
        title: '鲸鱼宠物', sessionIds: ['s9', 's10'], createdAt: 'x', updatedAt: 'x',
      },
      'id-taijiao': {
        path: '/data/user/0/com.dsh.harness/files/home/.dsh/nassyncworkspaces/胎教Agent',
        title: '胎教Agent', sessionIds: ['s2', 's3'], createdAt: 'x', updatedAt: 'x',
      },
      'id-wstest': {
        path: '/data/user/0/com.dsh.harness/files/home/wstest',
        title: 'wstest', sessionIds: ['s1'], createdAt: 'x', updatedAt: 'x',
      },
    },
  },
});

test('mergeWorkspaceRegistry：本机已有注册表也合并，新增工作区并搬正旧落点', async () => {
  const { h, desktop, legacy } = homeWithSyncedWorkspaces();
  const r = await mergeWorkspaceRegistry(REMOTE_REGISTRY, h);
  assert.equal(r.added, 1, JSON.stringify(r));

  const reg = JSON.parse(readFileSync(join(h, 'storages', 'workspace.json'), 'utf8'));
  const whale = reg.tables.workspaces['id-whale'];
  assert.ok(whale, '应新增鲸鱼宠物');
  assert.equal(whale.path, join(h, 'nassyncworkspaces', '鲸鱼宠物'));
  assert.deepEqual(whale.sessionIds, ['s9', 's10']);
  // 文件跟着搬家，一个不落
  assert.equal(existsSync(legacy), false, '旧落点应已清空');
  assert.equal(readdirSync(whale.path).filter((f) => f.endsWith('.txt')).length, 3);
  // 本机条目一律不动
  assert.equal(reg.tables.workspaces['id-wstest'].path, join(h, 'nassyncworkspaces', 'wstest'));
  assert.equal(reg.tables.workspaces['id-taijiao'].path, desktop);
  assert.deepEqual(reg.tables.workspaces['id-taijiao'].sessionIds, ['s2', 's3'], '只并集归属');
});

test('mergeWorkspaceRegistry：内容没变化时不写盘（不刷 mtime）', async () => {
  const { h } = homeWithSyncedWorkspaces();
  await mergeWorkspaceRegistry(REMOTE_REGISTRY, h);
  const p = join(h, 'storages', 'workspace.json');
  const before = statSync(p).mtimeMs;
  const r = await mergeWorkspaceRegistry(REMOTE_REGISTRY, h);
  assert.deepEqual([r.added, r.remapped, r.deduped], [0, 0, 0]);
  assert.equal(statSync(p).mtimeMs, before, '无变化不该重写注册表');
});

test('mergeWorkspaceRegistry：本机屏蔽的会话在合并时被过滤（0.5.8）', async () => {
  const { h } = homeWithSyncedWorkspaces();
  // 远端的鲸鱼宠物带着 s9/s10，本机明确不要 s10
  await mergeWorkspaceRegistry(REMOTE_REGISTRY, h, new Set(['s10']));
  const p = join(h, 'storages', 'workspace.json');
  const reg = JSON.parse(readFileSync(p, 'utf8'));
  assert.deepEqual(reg.tables.workspaces['id-whale'].sessionIds, ['s9']);

  // 下一轮远端又把 s10 并回来，仍应被挡在门外，且不重复刷盘
  const before = statSync(p).mtimeMs;
  await mergeWorkspaceRegistry(REMOTE_REGISTRY, h, new Set(['s10']));
  const after = JSON.parse(readFileSync(p, 'utf8'));
  assert.deepEqual(after.tables.workspaces['id-whale'].sessionIds, ['s9']);
  assert.equal(statSync(p).mtimeMs, before, '过滤后内容没变就不该重写');
});

test('registryCovers：远端已覆盖本机 → 不发布；本机有远端缺的 → 发布', () => {
  const local = JSON.stringify({
    tables: { workspaces: { a: { title: 'wstest', sessionIds: ['s1'] } } },
  });
  const remoteSame = JSON.stringify({
    tables: { workspaces: { b: { title: 'wstest', sessionIds: ['s1', 's2'] } } },
  });
  // 远端同一标题下会话更多 → 本机没有新东西，不该发布（否则两台机器会互相盖回去）
  assert.equal(registryCovers(remoteSame, local), true);
  // 本机多一个远端没有的标题 → 必须发布
  const localExtra = JSON.stringify({
    tables: { workspaces: { a: { title: '新工作区', sessionIds: [] } } },
  });
  assert.equal(registryCovers(remoteSame, localExtra), false);
  // 同一标题但本机有远端缺的会话归属 → 也必须发布
  const localMoreSessions = JSON.stringify({
    tables: { workspaces: { a: { title: 'wstest', sessionIds: ['s1', 's7'] } } },
  });
  assert.equal(registryCovers(remoteSame, localMoreSessions), false);
  // 解析不了远端 → 别冒险覆盖
  assert.equal(registryCovers('not json', local), true);
});

// ---------------------------------------------------------------------------
// 0.5.7：同步进来的会话必须登记到工作区，否则侧栏看不到
// ---------------------------------------------------------------------------

test('registerSessionForRel：把会话登记到对应工作区（幂等、散装目录不登记）', async () => {
  const h = home();
  const ws = join(h, 'nassyncworkspaces', '鲸鱼宠物');
  mkdirSync(ws, { recursive: true });
  mkdirSync(join(h, 'storages'), { recursive: true });
  writeFileSync(join(h, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, defaultWorkspaceId: 'w1', workspaceIds: ['w1'], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: { workspaces: { w1: { path: ws, title: '鲸鱼宠物', sessionIds: [], createdAt: 'x', updatedAt: 'x' } } },
  }, null, 2));

  const sid = 'session-bd10402b-112e-4079-8f3e-e3600e221594';
  const rel = ['sessions', encodeCwd(ws), sid, 'session.v4.jsonl.zstd'].join('/');
  assert.equal(await registerSessionForRel(rel, h), true);

  const reg = JSON.parse(readFileSync(join(h, 'storages', 'workspace.json'), 'utf8'));
  assert.deepEqual(reg.tables.workspaces.w1.sessionIds, [sid]);
  // 幂等：第二次不再写
  assert.equal(await registerSessionForRel(rel, h), false);

  // 散装目录（不在注册表里的工作区）不登记
  const stray = ['sessions', encodeCwd('/data/user/0/other/home'), 'session-x', 'session.v4.jsonl.zstd'].join('/');
  assert.equal(await registerSessionForRel(stray, h), false);
});
