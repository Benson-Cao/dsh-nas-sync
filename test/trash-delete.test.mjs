/**
 * DSH 回收站 → 同步删除判据（2026-11-09 真机问题回归）
 * ----------------------------------------------------
 * 真机事实：DSH 的「删除会话」不删文件，只在 `sessions/.sessions-trash/` 下建一个
 * `<ISO>---<cwd编码>---<sid>/` 目录来隐藏会话。插件旧判据（文件消失才算删）因此
 * 永远不成立，delete 事件发不出去，另一端一直留着会话。
 *
 * 这里锁死三件事：
 *   1. 目录名解析只认完整形态，坏的必须返回 null（宁可少删不可误删）
 *   2. 列表函数只在真的有 trash 目录时返回键
 *   3. 引擎扫描必须把被 trash 的会话从本轮清单里剔除（这是发出 delete 的前提）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemTransport } from './_mem-transport.mjs';
const { parseTrashDirName, listTrashedSessionKeys } = await import('../dist-test/portable.mjs');
const { Engine } = await import('../dist-test/engine.mjs');
const { Store } = await import('../dist-test/config.mjs');

const ENC = '--C-Users-Administrator-.dsh-nassyncworkspaces-wstest--';
// DSH 写进回收站目录名的是**去掉两端 `--`** 的 cwd 编码（真机实测格式）
const TRASH_ENC = ENC.replace(/^--/, '').replace(/--$/, '');
const SID = 'session-11111111-1111-4111-8111-111111111111';

test('parseTrashDirName：完整形态能解析出 cwd 编码与 sid', () => {
  const r = parseTrashDirName('2026-11-09T10-52-22.155Z---' + TRASH_ENC + '---' + SID);
  assert.ok(r);
  assert.equal(r.enc, TRASH_ENC);
  assert.equal(r.sid, SID);
  assert.ok(r.at > 0, '时间戳应能解析');
});

test('parseTrashDirName：缺段 / 非 session 前缀一律返回 null（不误删）', () => {
  assert.equal(parseTrashDirName('2026-11-09T10-52-22.155Z---' + ENC), null);
  assert.equal(parseTrashDirName('not-a-trash-dir'), null);
  assert.equal(parseTrashDirName('2026-11-09T10-52-22.155Z---x---not-a-session'), null);
  assert.equal(parseTrashDirName(''), null);
});

test('listTrashedSessionKeys：没有回收站目录时返回空集合而不是抛错', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-trash-none-'));
  try {
    const set = await listTrashedSessionKeys(home);
    assert.equal(set.size, 0);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('listTrashedSessionKeys：只收完整解析成功的条目', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-trash-list-'));
  try {
    const trash = join(home, 'sessions', '.sessions-trash');
    mkdirSync(trash, { recursive: true });
    mkdirSync(join(trash, '2026-11-09T10-52-22.155Z---' + TRASH_ENC + '---' + SID));
    mkdirSync(join(trash, 'random-junk'));
    const set = await listTrashedSessionKeys(home);
    assert.equal(set.size, 1);
    assert.ok(set.has(TRASH_ENC + '/' + SID));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

function config() {
  return {
    type: 'webdav',
    webdav: { url: 'https://nas.invalid/dav', username: '', password: '', remotePath: '' },
    mountRoot: '', passphrase: 'trash-pass',
    autoSync: { enabled: false, mode: 'push', intervalMin: 30 },
    chunkThreshold: 100 * 1024 * 1024, chunkSize: 50 * 1024 * 1024,
    concurrency: 4, includeSensitive: false, retentionDays: 30,
    syncScope: {
      sessions: true, workspaces: true, workspaceFiles: true, customFolders: true,
      sessionTitles: true, attachments: true, skills: true, profiles: false,
      settings: false, pluginPatch: false,
    },
    skillFilter: [], customFolders: [],
  };
}

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-trash-scan-'));
  mkdirSync(join(home, 'nas-sync'), { recursive: true });
  mkdirSync(join(home, 'storages'), { recursive: true });
  writeFileSync(join(home, 'storages', 'workspace.json'), JSON.stringify({
    tables: { workspaces: { w1: { id: 'w1', title: 'wstest', path: 'C:\\x\\wstest', sessionIds: [SID] } } },
  }));
  const dir = join(home, 'sessions', ENC, SID);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), 'body-not-really-zstd');
  return home;
}

test('引擎扫描：被 trash 的会话要从本轮清单剔除（否则 delete 事件永远发不出）', async () => {
  const home = makeHome();
  process.env.DSH_HOME_TEST = home;
  try {
    const engine = new Engine({ transport: new MemTransport(), store: new Store(), config: config() });
    const before = await engine.scan();
    assert.ok(before.local.some((e) => e.rel.includes(SID)), '未被 trash 时应正常扫到');

    // 模拟 DSH 的删除动作：建一条回收站记录（文件保持不动）
    mkdirSync(join(home, 'sessions', '.sessions-trash', '2026-11-09T10-52-22.155Z---' + TRASH_ENC + '---' + SID), { recursive: true });

    const after = await engine.scan();
    assert.equal(after.local.some((e) => e.rel.includes(SID)), false, '被 trash 后不应再出现在清单里');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('引擎扫描：恢复（删掉 trash 记录）后会话要重新出现', async () => {
  const home = makeHome();
  process.env.DSH_HOME_TEST = home;
  try {
    const trashDir = join(home, 'sessions', '.sessions-trash', '2026-11-09T10-52-22.155Z---' + TRASH_ENC + '---' + SID);
    mkdirSync(trashDir, { recursive: true });
    const engine = new Engine({ transport: new MemTransport(), store: new Store(), config: config() });
    assert.equal((await engine.scan()).local.some((e) => e.rel.includes(SID)), false);

    rmSync(trashDir, { recursive: true, force: true });
    assert.ok((await engine.scan()).local.some((e) => e.rel.includes(SID)), '恢复后应重新扫到');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('引擎扫描：跨端回收站记录（cwd 编码不同、sid 相同）也必须剔除', async () => {
  // 真机场景：手机删会话 → 回收站记录的编码是 `data-user-0-...`，
  // 而电脑上这条会话的 rel 编码是 `C-Users-Administrator-...`。
  // 旧实现拼 `<编码>/<sid>` 必定对不上，剔除静默失效，delete 事件永远发不出去。
  const home = makeHome();
  process.env.DSH_HOME_TEST = home;
  try {
    const engine = new Engine({ transport: new MemTransport(), store: new Store(), config: config() });
    assert.ok((await engine.scan()).local.some((e) => e.rel.includes(SID)), '未被 trash 时应正常扫到');

    const androidEnc = 'data-user-0-com.dsh.harness-files-home-~9CB8~9C7C~5BA0~7269';
    assert.notEqual(androidEnc, TRASH_ENC, '这个用例的前提就是两端编码不同');
    mkdirSync(
      join(home, 'sessions', '.sessions-trash', '2026-11-09T11-23-34.331Z---' + androidEnc + '---' + SID),
      { recursive: true },
    );

    const after = await engine.scan();
    assert.equal(
      after.local.some((e) => e.rel.includes(SID)),
      false,
      '按 sid 判定后仍必须剔除（这是发出 delete 事件的前提）',
    );
  } finally { rmSync(home, { recursive: true, force: true }); }
});
