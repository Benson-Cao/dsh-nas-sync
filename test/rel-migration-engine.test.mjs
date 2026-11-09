/**
 * 0.6.0 / 收尾①：会话 rel 迁移的引擎级端到端验收。
 *
 * 用真实 Engine + 真实 Store + 内存传输，验证两阶段迁移不是「只有纯函数」：
 *   · 预演不写任何东西；
 *   · confirm 才复制对象、写 bidmap 与标记，旧对象仍在；
 *   · 标记存在后重复执行不会二次复制；
 *   · 配置写了 canonical 但没标记时自动降级 legacy（fail-closed）；
 *   · 同 sid 不同内容时整批拒绝。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const { Engine } = await import('../dist-test/engine.mjs');
const { Store } = await import('../dist-test/config.mjs');
const { Crypto } = await import('../dist-test/crypto.mjs');
const { MIGRATION_MARKER_PATH } = await import('../dist-test/rel-migration.mjs');

const PASS = 'rel-migration-pass';
const SALT = Buffer.alloc(16, 7);
const SID = 'sid-0001-aaaa-bbbb';
const SEG = '--C-Users-Administrator-wstest--';
const FILE = 'session.v1.jsonl.zstd';
const LEGACY = `sessions/${SEG}/${SID}/${FILE}`;
const CANON = `sessions/by-id/${SID}/v1/${FILE}`;
const MANIFEST = '/dsh/manifests/peer.json';

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
      const isDir = this.dirs.has(full) || [...this.blobs.keys()].some((p) => p.startsWith(full + '/'));
      return { name: n, type: isDir ? 'dir' : 'file', mtime: Date.now(), size: 0 };
    });
  }
  async mkdir(dir) { this.dirs.add(dir.replace(/\/+$/, '')); }
  async getBuffer(p) { const b = this.blobs.get(p); if (!b) throw new Error('404 ' + p); return b; }
  async putBuffer(b, p, opts) {
    this.blobs.set(p, Buffer.from(b));
    if (opts?.mkdirs) {
      const segs = p.split('/').filter(Boolean); segs.pop();
      let acc = '';
      for (const s of segs) { acc += '/' + s; this.dirs.add(acc); }
    }
  }
  async stat(p) { const b = this.blobs.get(p); return b ? { mtime: Date.now(), size: b.length } : null; }
  async etag(p) {
    const b = this.blobs.get(p);
    return b ? 'e-' + createHash('sha256').update(b).digest('hex').slice(0, 16) : null;
  }
  async putIfMatch(b, p, expect, opts) {
    const cur = await this.etag(p);
    if (cur !== expect) return { ok: false, etag: cur, reason: 'conflict' };
    await this.putBuffer(b, p, opts);
    return { ok: true, etag: await this.etag(p) };
  }
  async delete(p) { this.blobs.delete(p); }
  async deleteTree(p) {
    for (const k of [...this.blobs.keys()]) if (k === p || k.startsWith(p + '/')) this.blobs.delete(k);
  }
  async rename(a, b) {
    if (!this.blobs.has(a)) throw new Error('404 ' + a);
    this.blobs.set(b, this.blobs.get(a)); this.blobs.delete(a);
  }
  async test() { return true; }
}

function config(extra = {}) {
  return {
    type: 'webdav',
    webdav: { url: 'https://nas.invalid/dav', username: '', password: '', remotePath: '' },
    mountRoot: '', passphrase: PASS,
    autoSync: { enabled: false, mode: 'mirror', intervalMin: 30 },
    chunkThreshold: 100 * 1024 * 1024, chunkSize: 50 * 1024 * 1024,
    concurrency: 4, includeSensitive: false, retentionDays: 30,
    syncScope: {
      sessions: true, workspaces: true, workspaceFiles: true, customFolders: true,
      sessionTitles: true, attachments: true, skills: true, profiles: false,
      settings: false, pluginPatch: false,
    },
    skillFilter: [], customFolders: [],
    ...extra,
  };
}

async function fixture(opts = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-relmig-'));
  process.env.DSH_HOME_TEST = home;
  mkdirSync(join(home, 'nas-sync'), { recursive: true });
  const transport = new MemTransport();
  const entries = opts.entries ?? [
    { rel: LEGACY, mtime: 1000, size: 8, hash: 'h-session', device: 'win32:PC' },
    { rel: 'attachments/a.txt', mtime: 1000, size: 4, hash: 'h-attach', device: 'win32:PC' },
  ];
  const enc = await Crypto.encrypt(
    new TextEncoder().encode(JSON.stringify(entries)), PASS, SALT,
  );
  await transport.putBuffer(enc, MANIFEST, { mkdirs: true });
  await transport.putBuffer(Buffer.from('SESSION-BYTES'), '/dsh/' + LEGACY, { mkdirs: true });
  const store = new Store();
  const engine = new Engine({ transport, store, config: config(opts.config) });
  return { home, transport, store, engine, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test('预演：返回可执行计划，但不写标记 / bidmap / canonical 对象', async () => {
  const fx = await fixture();
  try {
    const view = await fx.engine.sessionRelPlan();
    assert.equal(view.valid, true);
    assert.equal(view.mode, 'legacy');
    assert.equal(view.effectiveMode, 'legacy');
    assert.equal(view.migrated, false);
    assert.equal(view.plan.mappings.length, 1);
    assert.equal(view.plan.mappings[0].canonicalRel, CANON);
    assert.equal(view.plan.untouched, 1);

    const dry = await fx.engine.migrateSessionRels();
    assert.equal(dry.ok, true);
    assert.equal(dry.dryRun, true);
    assert.equal(dry.copied, 0);
    assert.equal(fx.transport.blobs.has(MIGRATION_MARKER_PATH), false);
    assert.equal(fx.transport.blobs.has('/dsh/bidmap.json'), false);
    assert.equal(fx.transport.blobs.has('/dsh/' + CANON), false);
  } finally { fx.cleanup(); }
});

test('确认执行：复制对象 + 写 bidmap 与标记，旧对象保留，重复执行幂等', async () => {
  const fx = await fixture();
  try {
    const run = await fx.engine.migrateSessionRels({ confirm: true });
    assert.equal(run.ok, true, run.hint + ' / ' + run.errors.join(';'));
    assert.equal(run.dryRun, false);
    assert.equal(run.copied, 1);
    assert.equal(run.skippedChunks.length, 0);
    assert.ok(run.marker && run.marker.migrated === 1);
    assert.ok(run.marker.keepLegacyUntil > Date.now(), '旧对象保留期内不得被 GC');
    assert.equal(fx.transport.blobs.get('/dsh/' + CANON).toString(), 'SESSION-BYTES');
    assert.equal(fx.transport.blobs.has('/dsh/' + LEGACY), true, '旧对象只复制不删除');
    const bid = JSON.parse(fx.transport.blobs.get('/dsh/bidmap.json').toString());
    assert.equal(bid.entries.length, 1);
    assert.equal(bid.entries[0].sid, SID);
    assert.equal(bid.entries[0].canonicalRel, CANON);

    const again = await fx.engine.migrateSessionRels({ confirm: true });
    assert.equal(again.alreadyDone, true);
    assert.equal(again.copied, 0);
  } finally { fx.cleanup(); }
});

test('fail-closed：配置写 canonical 但没有迁移标记时自动降级 legacy', async () => {
  const fx = await fixture({ config: { sessionRelMode: 'canonical' } });
  try {
    const view = await fx.engine.sessionRelPlan();
    assert.equal(view.mode, 'canonical');
    assert.equal(view.effectiveMode, 'legacy', '标记缺失不得切主链');
    assert.equal(view.migrated, false);
  } finally { fx.cleanup(); }
});

test('有标记后 canonical 生效：本机清单里的会话 rel 投影成 by-id 空间', async () => {
  const fx = await fixture({ config: { sessionRelMode: 'canonical' } });
  try {
    // 本机真实文件仍落在 cwd 编码目录下
    const dir = join(fx.home, 'sessions', SEG, SID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, FILE), 'SESSION-BYTES');
    mkdirSync(join(fx.home, 'attachments'), { recursive: true });
    writeFileSync(join(fx.home, 'attachments', 'a.txt'), 'abcd');
    const first = await fx.engine.migrateSessionRels({ confirm: true });
    assert.equal(first.ok, true);

    const view = await fx.engine.sessionRelPlan();
    assert.equal(view.effectiveMode, 'canonical');
    assert.equal(view.migrated, true);
    const { local } = await fx.engine.scan();
    assert.ok(local.some((e) => e.rel === CANON), '本机会话清单应投影到 canonical：'
      + JSON.stringify(local.map((e) => e.rel)));
    assert.equal(local.some((e) => e.rel === LEGACY), false);
    assert.ok(local.some((e) => e.rel === 'attachments/a.txt'), '非会话 rel 不受影响');
  } finally { fx.cleanup(); }
});

test('同名不同内容：计划校验失败，confirm 也不写任何东西', async () => {
  const PH_SEG = '--data-user-0-com-dsh-harness-files-home-wstest--';
  const entries = [
    { rel: LEGACY, mtime: 1000, size: 8, hash: 'hash-A', device: 'win32:PC' },
    { rel: `sessions/${PH_SEG}/${SID}/${FILE}`, mtime: 1000, size: 8, hash: 'hash-B', device: 'android:PHONE' },
  ];
  const fx = await fixture({ entries });
  try {
    const view = await fx.engine.sessionRelPlan();
    assert.equal(view.valid, false);
    assert.equal(view.plan.collisions.length, 1);
    const run = await fx.engine.migrateSessionRels({ confirm: true });
    assert.equal(run.ok, false);
    assert.equal(run.copied, 0);
    assert.equal(fx.transport.blobs.has(MIGRATION_MARKER_PATH), false);
  } finally { fx.cleanup(); }
});
