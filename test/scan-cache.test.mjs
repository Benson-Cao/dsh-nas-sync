/**
 * 0.6.0 / 收尾③：增量扫描缓存。
 * 锁死五道失效判据，并用真实 Engine 验证「第二轮真的不再 readFile」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemTransport } from './_mem-transport.mjs';
const {
  configFingerprint, shouldReuse, isCacheEntryValid, ScanCacheSession,
  loadScanCache, saveScanCache, scanCachePath, SCAN_CACHE_VERSION,
} = await import('../dist-test/scan-cache.mjs');
const { Engine } = await import('../dist-test/engine.mjs');
const { Store } = await import('../dist-test/config.mjs');

const FP = 'f'.repeat(64);
const NOW = 1_700_000_000_000;
const STAT = { mtimeMs: 1000, ctimeMs: 1100, size: 12 };
const entry = (over = {}) => ({ ...STAT, hash: 'a'.repeat(64), at: NOW - 1000, ...over });
const policy = (over = {}) => ({
  scope: { sessions: true, attachments: true },
  includeSensitive: false, skillFilter: [], customFolders: [],
  maxFileBytes: 64 * 1024 * 1024, sessionRelMode: 'legacy', ...over,
});

test('configFingerprint：同一配置稳定，任一影响扫描结果的字段变化都要变', () => {
  assert.equal(configFingerprint(policy()), configFingerprint(policy()));
  assert.notEqual(configFingerprint(policy()), configFingerprint(policy({ includeSensitive: true })));
  assert.notEqual(configFingerprint(policy()), configFingerprint(policy({ maxFileBytes: 1000 })));
  assert.notEqual(configFingerprint(policy()), configFingerprint(policy({ sessionRelMode: 'canonical' })));
  assert.notEqual(configFingerprint(policy()), configFingerprint(policy({ skillFilter: ['a'] })));
  // 键顺序 / 数组顺序不该影响指纹
  assert.equal(
    configFingerprint(policy({ scope: { attachments: true, sessions: true } })),
    configFingerprint(policy()),
  );
});

test('shouldReuse：五道判据逐条生效（策略 / 三条 stat / TTL / hash 合法性）', () => {
  const base = { now: NOW, ttlMs: 3600_000, samePolicy: true };
  assert.equal(shouldReuse(entry(), STAT, base), true);
  assert.equal(shouldReuse(undefined, STAT, base), false, '没有上轮记录');
  assert.equal(shouldReuse(entry(), STAT, { ...base, samePolicy: false }), false, '配置变了整表失效');
  assert.equal(shouldReuse(entry(), { ...STAT, mtimeMs: 1001 }, base), false);
  assert.equal(shouldReuse(entry(), { ...STAT, ctimeMs: 1101 }, base), false, 'ctime 变了要重算');
  assert.equal(shouldReuse(entry(), { ...STAT, size: 13 }, base), false);
  assert.equal(shouldReuse(entry(), STAT, { ...base, now: NOW + 3600_000 }), false, 'TTL 到期');
  assert.equal(shouldReuse(entry({ hash: 'not-a-hash' }), STAT, base), false);
  assert.equal(isCacheEntryValid(entry({ hash: 'x' })), false);
  assert.equal(isCacheEntryValid(entry()), true);
});

test('ScanCacheSession：命中 / 重算 / prune / snapshot 与统计一致', () => {
  const prev = { version: SCAN_CACHE_VERSION, fingerprint: FP, entries: { 'a.txt': entry() } };
  const s = new ScanCacheSession(prev, { fingerprint: FP, ttlMs: 3600_000, now: NOW });
  assert.equal(s.lookup('a.txt', STAT), 'a'.repeat(64));
  assert.equal(s.stats.hits, 1);
  assert.equal(s.lookup('a.txt', { ...STAT, size: 99 }), null);
  assert.equal(s.stats.changed, 1);
  s.record('a.txt', { ...STAT, size: 99 }, 'b'.repeat(64));
  s.record('b.txt', STAT, 'c'.repeat(64));
  s.prune(['a.txt']);
  const snap = s.snapshot();
  assert.equal(snap.fingerprint, FP);
  assert.deepEqual(Object.keys(snap.entries).sort(), ['a.txt']);
  assert.equal(snap.entries['a.txt'].hash, 'b'.repeat(64));
});

test('指纹不匹配 / 版本不对 / 缓存损坏：整表作废并标记 invalidated', () => {
  const prev = { version: SCAN_CACHE_VERSION, fingerprint: 'other', entries: { 'a.txt': entry() } };
  const s = new ScanCacheSession(prev, { fingerprint: FP, ttlMs: 3600_000, now: NOW });
  assert.equal(s.stats.invalidated, true);
  assert.equal(s.lookup('a.txt', STAT), null);
  assert.equal(Object.keys(s.snapshot().entries).length, 0);
  const s2 = new ScanCacheSession(null, { fingerprint: FP, ttlMs: 1000, now: NOW });
  assert.equal(s2.stats.invalidated, false, '首次没有缓存不算「失效」');
});

test('load / save：原子落盘可读回；坏 JSON 明确报 corrupted 而不是静默当空', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-scancache-'));
  process.env.DSH_HOME_TEST = home;
  mkdirSync(join(home, 'nas-sync'), { recursive: true });
  try {
    const path = scanCachePath();
    assert.equal(loadScanCache(path).missing, true);
    const data = { version: SCAN_CACHE_VERSION, fingerprint: FP, entries: { 'x': entry() } };
    saveScanCache(data, path);
    assert.equal(existsSync(path), true);
    assert.equal(existsSync(path + '.tmp-' + process.pid), false, '临时文件不应残留');
    const loaded = loadScanCache(path);
    assert.equal(loaded.corrupted, false);
    assert.equal(loaded.data.fingerprint, FP);

    writeFileSync(path, '{ this is not json');
    const bad = loadScanCache(path);
    assert.equal(bad.corrupted, true);
    assert.equal(bad.data, null);
    assert.ok(bad.quarantinedTo, '坏文件应留备份');

    writeFileSync(path, JSON.stringify({ version: SCAN_CACHE_VERSION, fingerprint: FP, entries: [] }));
    assert.equal(loadScanCache(path).corrupted, true, 'entries 是数组按坏数据处理');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 真实 Engine：缓存确实省掉了 readFile
// ---------------------------------------------------------------------------

function engineConfig(extra = {}) {
  return {
    type: 'webdav',
    webdav: { url: 'https://nas.invalid/dav', username: '', password: '', remotePath: '' },
    mountRoot: '', passphrase: 'scan-cache-pass',
    autoSync: { enabled: false, mode: 'push', intervalMin: 30 },
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

test('真实引擎：第二轮扫描命中缓存；改文件后该条重算且 hash 更新', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-scanengine-'));
  process.env.DSH_HOME_TEST = home;
  mkdirSync(join(home, 'nas-sync'), { recursive: true });
  mkdirSync(join(home, 'attachments'), { recursive: true });
  const file = join(home, 'attachments', 'note.txt');
  writeFileSync(file, 'version one');
  try {
    const transport = new MemTransport();
    const engine = new Engine({ transport, store: new Store(), config: engineConfig() });

    const first = await engine.scan();
    assert.ok(first.local.some((e) => e.rel === 'attachments/note.txt'));
    const s1 = engine.safetyStatus().scanCache;
    assert.equal(s1.enabled, true);
    assert.equal(s1.hits, 0, '第一轮必然全 miss');
    assert.ok(s1.misses > 0);
    assert.equal(existsSync(scanCachePath()), true, '缓存应落盘');
    const hash1 = first.local.find((e) => e.rel === 'attachments/note.txt').hash;

    const second = await engine.scan();
    const s2 = engine.safetyStatus().scanCache;
    assert.ok(s2.hits > 0, '第二轮应命中缓存，实际 ' + JSON.stringify(s2));
    assert.equal(second.local.find((e) => e.rel === 'attachments/note.txt').hash, hash1);

    // 改写文件（内容 + size 都变），缓存必须判出变化并重算
    writeFileSync(file, 'version two, definitely longer than before');
    const third = await engine.scan();
    const hash3 = third.local.find((e) => e.rel === 'attachments/note.txt').hash;
    assert.notEqual(hash3, hash1, '内容变了 hash 必须跟着变');
    assert.ok(engine.safetyStatus().scanCache.changed > 0);

    // 新引擎读同一份缓存：命中，且指纹一致
    const engine2 = new Engine({ transport, store: new Store(), config: engineConfig() });
    await engine2.scan();
    assert.ok(engine2.safetyStatus().scanCache.hits > 0, '缓存跨进程（重启）仍应生效');

    // 配置变了 → 整表失效
    const engine3 = new Engine({
      transport, store: new Store(), config: engineConfig({ includeSensitive: true }),
    });
    await engine3.scan();
    assert.equal(engine3.safetyStatus().scanCache.invalidated, true);

    // 关掉缓存 → 不再启用
    const engine4 = new Engine({
      transport, store: new Store(), config: engineConfig({ scanCacheEnabled: false }),
    });
    await engine4.scan();
    assert.equal(engine4.safetyStatus().scanCache.enabled, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('缓存损坏时引擎显式告警，但仍能完成扫描（降级为全量重算）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-scanbad-'));
  process.env.DSH_HOME_TEST = home;
  mkdirSync(join(home, 'nas-sync'), { recursive: true });
  mkdirSync(join(home, 'attachments'), { recursive: true });
  writeFileSync(join(home, 'attachments', 'note.txt'), 'ok');
  writeFileSync(scanCachePath(), '{ broken');
  try {
    const engine = new Engine({
      transport: new MemTransport(), store: new Store(), config: engineConfig(),
    });
    const { local } = await engine.scan();
    assert.ok(local.some((e) => e.rel === 'attachments/note.txt'));
    const s = engine.safetyStatus().scanCache;
    assert.ok(s.warning && s.warning.includes('损坏'), '必须告警而不是静默：' + JSON.stringify(s));
    assert.equal(s.hits, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
