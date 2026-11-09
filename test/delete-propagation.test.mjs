/**
 * 0.6.0 / P1：删除传播的端到端验收。
 *
 * 用户的核心诉求是「一端删除，另外一端也删除」。这里用**真实 Engine + 真实 Store**
 * 加一个内存 WebDAV 替身，验证整条链路：
 *   事件日志 → 完整性闸门 → 墓碑 → 本地回收（可恢复）→ 位点。
 *
 * 同时锁死三条不能退化的防线：
 *   · 事件流损坏 / 有缺口 → 一个文件都不许动；
 *   · 配置变更（关分类）、清单读失败、批量消失 → 不许发 delete 事件；
 *   · 删除是移进回收站并写 meta，不是硬删。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const { Engine } = await import('../dist-test/engine.mjs');
const { Store } = await import('../dist-test/config.mjs');
const { makeEvent, serializeEventLog, eventLogFileOf } = await import('../dist-test/events.mjs');
const {
  computeLocalDeletes, eventStreamAllowsDeletes, normalizeRetentionDays,
} = await import('../dist-test/safety.mjs');

const TS = 1_700_000_000_000;
const PEER = 'android:PHONE';
const REL = 'attachments/a.txt';

/** 内存传输：覆盖事件日志需要的方法，并如实实现 etag / CAS / 递归删 / rename。 */
class MemTransport {
  constructor() { this.blobs = new Map(); this.dirs = new Set(); }

  async list(dir) {
    const prefix = dir.replace(/\/+$/, '') + '/';
    const names = new Set();
    for (const p of [...this.blobs.keys(), ...this.dirs]) {
      if (!p.startsWith(prefix)) continue;
      const head = p.slice(prefix.length).split('/')[0];
      if (head) names.add(head);
    }
    return [...names].sort().map((n) => {
      const full = prefix + n;
      const isDir = this.dirs.has(full) ||
        [...this.blobs.keys()].some((p) => p.startsWith(full + '/'));
      return { name: n, type: isDir ? 'dir' : 'file', mtime: Date.now(), size: 0 };
    });
  }
  async mkdir(dir) { this.dirs.add(dir.replace(/\/+$/, '')); }
  async getBuffer(p) {
    const b = this.blobs.get(p);
    if (!b) throw new Error('404 ' + p);
    return b;
  }
  async putBuffer(b, p, opts) {
    this.blobs.set(p, Buffer.from(b));
    if (opts?.mkdirs) {
      const segs = p.split('/').filter(Boolean);
      segs.pop();
      let acc = '';
      for (const s of segs) { acc += '/' + s; this.dirs.add(acc); }
    }
  }
  async stat(p) {
    const b = this.blobs.get(p);
    return b ? { mtime: Date.now(), size: b.length } : null;
  }
  async etag(p) {
    const b = this.blobs.get(p);
    return b ? 'e-' + createHash('sha256').update(b).digest('hex').slice(0, 16) : null;
  }
  async putIfMatch(b, p, expectEtag, opts) {
    const cur = await this.etag(p);
    if (cur !== expectEtag) return { ok: false, etag: cur, reason: 'conflict' };
    await this.putBuffer(b, p, opts);
    return { ok: true, etag: await this.etag(p) };
  }
  async delete(p) { this.blobs.delete(p); }
  async deleteTree(p) {
    for (const k of [...this.blobs.keys()]) {
      if (k === p || k.startsWith(p + '/')) this.blobs.delete(k);
    }
  }
  async rename(a, b) {
    if (!this.blobs.has(a)) throw new Error('404 ' + a);
    this.blobs.set(b, this.blobs.get(a));
    this.blobs.delete(a);
  }
  async test() { return true; }
}

function baseConfig() {
  return {
    type: 'webdav',
    webdav: { url: 'https://nas.invalid/dav', username: '', password: '', remotePath: '' },
    mountRoot: '', passphrase: 'delete-propagation-pass',
    autoSync: { enabled: false, mode: 'mirror', intervalMin: 30 },
    chunkThreshold: 100 * 1024 * 1024,
    chunkSize: 50 * 1024 * 1024,
    concurrency: 4,
    includeSensitive: false,
    retentionDays: 30,
    syncScope: {
      sessions: true, workspaces: true, workspaceFiles: true, customFolders: true,
      sessionTitles: true, attachments: true, skills: true, profiles: false,
      settings: false, pluginPatch: false,
    },
    skillFilter: [],
    customFolders: [],
  };
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-delete-'));
  process.env.DSH_HOME_TEST = home;
  mkdirSync(join(home, 'attachments'), { recursive: true });
  mkdirSync(join(home, 'nas-sync'), { recursive: true });
  writeFileSync(join(home, 'attachments', 'a.txt'), 'hello from peer');
  const transport = new MemTransport();
  const store = new Store();
  const engine = new Engine({ transport, store, config: baseConfig() });
  return { home, transport, store, engine };
}

function cleanup(fx) {
  delete process.env.DSH_HOME_TEST;
  rmSync(fx.home, { recursive: true, force: true });
}

function peerDelete(over = {}) {
  return makeEvent({
    device: PEER, seq: 1, ts: TS, key: 'rel:' + REL, rel: REL,
    op: 'delete', ...over,
  });
}

function putEvents(fx, events, extraLine = '') {
  const text = serializeEventLog(events) + extraLine;
  fx.transport.blobs.set(eventLogFileOf(PEER, 0), Buffer.from(text));
  fx.transport.dirs.add('/dsh/events/' + PEER.replace(/[^A-Za-z0-9._-]/g, '_'));
  fx.transport.dirs.add('/dsh/events');
}

/* --------------------------------------------------- 引擎级：对端删除 → 本地回收 */

test('一端发 delete 事件，另一端 scan() 把文件移进回收站并写 meta（不硬删）', async () => {
  const fx = fixture();
  try {
    putEvents(fx, [peerDelete()]);
    const { local } = await fx.engine.scan();

    assert.equal(existsSync(join(fx.home, 'attachments', 'a.txt')), false, '原文件应已被搬走');
    assert.ok(!local.some((e) => e.rel === REL), '不该再出现在本地清单里');

    const removed = fx.engine.listRemovedSessions();
    const hit = removed.find((r) => r.rel === REL);
    assert.ok(hit, '回收站里应有这条记录');
    assert.match(hit.reason, /event-delete/);
    assert.equal(hit.restorable, true);

    const root = join(fx.home, 'nas-sync', 'removed');
    const batch = readdirSync(root)[0];
    const meta = JSON.parse(readFileSync(join(root, batch, hit.id + '.meta.json'), 'utf8'));
    assert.equal(meta.rel, REL);
    assert.match(meta.reason, /event-delete/);
    assert.equal(fx.engine.safetyStatus().eventStream.trusted, true);
  } finally { cleanup(fx); }
});

test('事件流有一行坏 JSON → 整轮不可信，一个文件都不许动（fail-closed）', async () => {
  const fx = fixture();
  try {
    putEvents(fx, [peerDelete()], '{broken json\n');
    const { local } = await fx.engine.scan();
    assert.equal(existsSync(join(fx.home, 'attachments', 'a.txt')), true);
    assert.ok(local.some((e) => e.rel === REL));
    const s = fx.engine.safetyStatus().eventStream;
    assert.equal(s.trusted, false);
    assert.ok(s.failed.length > 0);
    assert.ok(s.lastError);
  } finally { cleanup(fx); }
});

test('事件 seq 有缺口 → 同样禁用删除，避免「缺的那条恰好是删除证据」', async () => {
  const fx = fixture();
  try {
    putEvents(fx, [peerDelete(), peerDelete({ seq: 3, key: 'rel:attachments/b.txt', rel: 'attachments/b.txt' })]);
    await fx.engine.scan();
    assert.equal(existsSync(join(fx.home, 'attachments', 'a.txt')), true);
    const s = fx.engine.safetyStatus().eventStream;
    assert.equal(s.trusted, false);
    assert.ok(s.gaps > 0);
  } finally { cleanup(fx); }
});

test('ignore 事件会同步到对端的屏蔽清单（屏蔽清单全局事件化）', async () => {
  const fx = fixture();
  try {
    const ign = makeEvent({ device: PEER, seq: 1, ts: TS, key: 'session:s1', op: 'ignore' });
    putEvents(fx, [ign]);
    await fx.engine.scan();
    assert.ok(fx.engine.listIgnoredSessions().ids.includes('s1'));
    assert.equal(existsSync(join(fx.home, 'attachments', 'a.txt')), true, 'ignore 不该删文件');
  } finally { cleanup(fx); }
});

test('本机 confirmDelete 发布事件后，日志 / 墓碑 / 位点都落盘，且可被 listEvents 读回', async () => {
  const fx = fixture();
  try {
    const r = await fx.engine.confirmDelete('attachments/a.txt');
    assert.equal(r.published, true);

    const shards = [...fx.transport.blobs.keys()]
      .filter((p) => p.startsWith('/dsh/events/') && /^\d{6}\.jsonl$/.test(p.split('/').pop()));
    assert.equal(shards.length, 1, '应只写一片本机日志');

    const snap = await fx.engine.listEvents();
    assert.equal(snap.trusted, true);
    assert.ok(snap.events.some((e) => e.op === 'delete' && e.rel === 'attachments/a.txt'));
    assert.ok(snap.tombstones.some((t) => t.key === 'rel:attachments/a.txt'));
    assert.ok(Object.keys(snap.cursors).length > 0);
    assert.ok(fx.transport.blobs.has('/dsh/tombstones.json'));
  } finally { cleanup(fx); }
});

test('位点推进后，同一条 delete 事件不会被重复回放', async () => {
  const fx = fixture();
  try {
    putEvents(fx, [peerDelete()]);
    await fx.engine.scan();
    assert.equal(existsSync(join(fx.home, 'attachments', 'a.txt')), false);

    // 模拟用户把文件恢复了（或从回收站还原），此时不应再被历史事件搬走
    writeFileSync(join(fx.home, 'attachments', 'a.txt'), 'restored by user');

    // 发布一条本机事件会把位点推进到「对端 seq=1 已处理」
    await fx.engine.confirmDelete('attachments/other.txt');
    const snap = await fx.engine.listEvents();
    assert.equal(snap.cursors[PEER], 1);

    await fx.engine.scan();
    assert.equal(
      existsSync(join(fx.home, 'attachments', 'a.txt')), true,
      '位点已过的历史事件不能重复回收',
    );
  } finally { cleanup(fx); }
});

/* --------------------------------------------- 纯函数：删除判据的六道闸 */

const base = (n) => Array.from({ length: n }, (_, i) => ({ rel: 'attachments/f' + i }));

test('computeLocalDeletes：可信 + 在启用分类内 → 正常产出删除候选', () => {
  const d = computeLocalDeletes({
    baseline: base(10), fresh: base(9), enabledPrefixes: ['attachments'],
    eventTrusted: true, manifestTrusted: true,
  });
  assert.deepEqual(d.rels, ['attachments/f9']);
  assert.equal(d.blocked, false);
});

test('computeLocalDeletes：事件流 / 清单不可信、首轮无基线 → 整批拒绝', () => {
  const args = { baseline: base(3), fresh: base(2), enabledPrefixes: ['attachments'], manifestTrusted: true, eventTrusted: false };
  assert.equal(computeLocalDeletes(args).blocked, true);
  assert.equal(computeLocalDeletes({ ...args, eventTrusted: true, manifestTrusted: false }).blocked, true);
  assert.equal(computeLocalDeletes({ ...args, eventTrusted: true, baseline: [] }).blocked, true);
});

test('computeLocalDeletes：关掉分类勾选不能变成「把对端该分类全删光」', () => {
  const d = computeLocalDeletes({
    baseline: base(10), fresh: [], enabledPrefixes: ['sessions'],
    eventTrusted: true, manifestTrusted: true,
  });
  assert.deepEqual(d.rels, []);
  assert.equal(d.excludedCount, 10);
});

test('computeLocalDeletes：批量消失（条数 / 比例超阈）整批拒绝', () => {
  const d = computeLocalDeletes({
    baseline: base(10), fresh: base(2), enabledPrefixes: ['attachments'],
    eventTrusted: true, manifestTrusted: true,
  });
  assert.equal(d.blocked, true, '消失 8/10 超过 0.5 比例上限');
  assert.match(d.reason, /比例/);
  const many = computeLocalDeletes({
    baseline: base(200), fresh: base(100), enabledPrefixes: ['attachments'],
    eventTrusted: true, manifestTrusted: true,
  });
  assert.equal(many.blocked, true, '消失 100 条超过默认 50 条的绝对上限');
  assert.match(many.reason, /超过上限/);
});

test('computeLocalDeletes：排除集合 / 运行时垃圾 / 不安全 rel 都不进候选', () => {
  const d = computeLocalDeletes({
    baseline: [
      { rel: 'attachments/a' }, { rel: 'attachments/b' },
      { rel: 'sessions/x/s1/f' }, { rel: '../evil' },
    ],
    fresh: [], enabledPrefixes: ['attachments', 'sessions'],
    eventTrusted: true, manifestTrusted: true,
    excluded: new Set(['attachments/b']),
    isIgnorable: (r) => r.startsWith('sessions/'),
    maxRatio: 1,
  });
  assert.deepEqual(d.rels, ['attachments/a']);
  assert.equal(d.excludedCount, 3);
});

test('eventStreamAllowsDeletes / normalizeRetentionDays：口径稳定', () => {
  assert.equal(eventStreamAllowsDeletes(null).allowed, false);
  assert.equal(eventStreamAllowsDeletes({ trusted: true, failed: [], gaps: [] }).allowed, true);
  const bad = eventStreamAllowsDeletes({ trusted: false, failed: ['a'], gaps: [{ device: 'x', from: 1, to: 2 }] });
  assert.equal(bad.allowed, false);
  assert.match(bad.reason, /读失败|缺口/);
  assert.equal(normalizeRetentionDays(undefined), 30);
  assert.equal(normalizeRetentionDays(-1), 30);
  assert.equal(normalizeRetentionDays(0), 0);
  assert.equal(normalizeRetentionDays(99999), 3650);
});
