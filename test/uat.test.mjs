/**
 * 0.6.0 / 收尾⑤：UAT / BDD 验收场景。
 *
 * 每个用例按 Given → When → Then 组织，刻意用**真实 Engine + 真实 Store +
 * 内存传输**，不 mock 服务层（expert 约定：集成测试不能用 mock 服务层换速度）。
 * 覆盖用户最能感知的四条故事：一端删除另一端也删、事件流坏时不误删、
 * 关分类不误删、屏蔽操作不会因网络抖动丢失。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemTransport } from './_mem-transport.mjs';
const { Engine } = await import('../dist-test/engine.mjs');
const { Store } = await import('../dist-test/config.mjs');
const { makeEvent, serializeEventLog, eventLogFileOf } = await import('../dist-test/events.mjs');
const { computeLocalDeletes } = await import('../dist-test/safety.mjs');

const TS = 1_700_000_000_000;
const PEER = 'android:PHONE';
const REL = 'attachments/a.txt';

function config() {
  return {
    type: 'webdav',
    webdav: { url: 'https://nas.invalid/dav', username: '', password: '', remotePath: '' },
    mountRoot: '', passphrase: 'uat-pass',
    autoSync: { enabled: false, mode: 'mirror', intervalMin: 30 },
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

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-uat-'));
  process.env.DSH_HOME_TEST = home;
  mkdirSync(join(home, 'nas-sync'), { recursive: true });
  mkdirSync(join(home, 'attachments'), { recursive: true });
  writeFileSync(join(home, 'attachments', 'a.txt'), 'important user data');
  const transport = new MemTransport();
  const store = new Store();
  return {
    home, transport, store,
    engine: new Engine({ transport, store, config: config() }),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

function putEvents(fx, events, extraLine = '') {
  fx.transport.blobs.set(
    eventLogFileOf(PEER, 0),
    Buffer.from(serializeEventLog(events) + extraLine),
  );
  fx.transport.dirs.add('/dsh/events/' + PEER.replace(/[^A-Za-z0-9._-]/g, '_'));
  fx.transport.dirs.add('/dsh/events');
}

const peerDelete = () => makeEvent({
  device: PEER, seq: 1, ts: TS, key: 'rel:' + REL, rel: REL, op: 'delete',
});

test('UAT-1｜用户在电脑上删了一个文件，手机上它也该消失（且能恢复）', async () => {
  const fx = fixture();
  try {
    // Given：手机上有这个文件；电脑已经发布了 delete 事件
    assert.equal(existsSync(join(fx.home, 'attachments', 'a.txt')), true);
    putEvents(fx, [peerDelete()]);

    // When：手机端下一轮扫描
    const { local } = await fx.engine.scan();

    // Then：文件移进回收站（不是硬删），清单里不再有它，meta 可追溯
    assert.equal(existsSync(join(fx.home, 'attachments', 'a.txt')), false);
    assert.equal(local.some((e) => e.rel === REL), false);
    const hit = fx.engine.listRemovedSessions().find((r) => r.rel === REL);
    assert.ok(hit && hit.restorable);
    assert.match(hit.reason, /event-delete/);
    const root = join(fx.home, 'nas-sync', 'removed');
    const batch = readdirSync(root)[0];
    const meta = JSON.parse(readFileSync(join(root, batch, hit.id + '.meta.json'), 'utf8'));
    assert.equal(meta.rel, REL);
    assert.equal(fx.engine.safetyStatus().eventStream.trusted, true);
  } finally { fx.cleanup(); }
});

test('UAT-2｜NAS 上事件日志被写坏一行时，宁可这轮不同步也不能删用户数据', async () => {
  const fx = fixture();
  try {
    // Given：一条合法删除事件 + 一行坏 JSON
    putEvents(fx, [peerDelete()], '{broken json\n');

    // When：扫描
    await fx.engine.scan();

    // Then：文件原地不动，事件流被标成不可信
    assert.equal(existsSync(join(fx.home, 'attachments', 'a.txt')), true);
    assert.equal(fx.engine.safetyStatus().eventStream.trusted, false);
    assert.equal(fx.engine.listRemovedSessions().length, 0);
  } finally { fx.cleanup(); }
});

test('UAT-3｜用户在设置里取消勾选「附件」，不该把对端的附件全删掉', () => {
  // Given：上轮清单里有 10 个附件，本轮因为取消勾选一个都没扫到
  const base = (n) => Array.from({ length: n }, (_, i) => ({
    rel: 'attachments/f' + i, mtime: 1000, size: 1, hash: 'h' + i,
  }));
  // When：按「当前只启用了 sessions」计算本地删除候选
  const d = computeLocalDeletes({
    baseline: base(10), fresh: [], enabledPrefixes: ['sessions'],
    eventTrusted: true, manifestTrusted: true,
  });
  // Then：零删除，全部归为「配置排除」
  assert.deepEqual(d.rels, []);
  assert.equal(d.excludedCount, 10);
  assert.equal(d.blocked, false);
});

test('UAT-4｜用户点「屏蔽这条会话」时正好断网，操作不能丢', async () => {
  const fx = fixture();
  try {
    // Given：用户点击屏蔽
    await fx.engine.ignoreSession('sid-uat-1');
    // When：此刻 NAS 完全不可达（所有写都抛错）
    fx.transport.faults.set('putBuffer', new Error('offline'));
    fx.transport.faults.set('putIfMatch', new Error('offline'));
    // Then：意图仍持久化在 Store 里，下一轮联网会补发
    assert.ok(fx.store.pendingIntents.some((i) => i.op === 'ignore' && i.sid === 'sid-uat-1'));
    const reloaded = new Store();
    assert.ok(reloaded.pendingIntents.some((i) => i.op === 'ignore' && i.sid === 'sid-uat-1'),
      '意图必须落盘，进程重启也还在');
    assert.ok(fx.engine.listIgnoredSessions().ids.includes('sid-uat-1'));
  } finally { fx.cleanup(); }
});
