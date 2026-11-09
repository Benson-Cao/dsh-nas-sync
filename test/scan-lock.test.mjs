/**
 * 0.6.0 收尾 · scan() 并发保护
 * ----------------------------
 * 0.5.9 审查 C 系列：「scan() 无锁且带回收副作用」。自动同步定时器、面板刷新、
 * 工具调用三方并发时会互相覆盖 pendingFiles，并可能对同一文件算出不同的
 * 「本地有 / 无」结论。修法是 in-flight 去重：并发第二个调用复用同一轮结果。
 *
 * 这里锁死三条不能退化的行为：
 *   1. 并发两次 scan 必须是同一个 Promise 结果（同一轮）；
 *   2. 一轮结束后必须解锁，下一轮是新的扫描；
 *   3. 一轮抛错也要解锁，不能永久锁死。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemTransport } from './_mem-transport.mjs';
const { Engine } = await import('../dist-test/engine.mjs');
const { Store } = await import('../dist-test/config.mjs');

function config(extra = {}) {
  return {
    type: 'webdav',
    webdav: { url: 'https://nas.invalid/dav', username: '', password: '', remotePath: '' },
    mountRoot: '', passphrase: 'scan-lock-pass',
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

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-scanlock-'));
  mkdirSync(join(home, 'nas-sync'), { recursive: true });
  mkdirSync(join(home, 'attachments'), { recursive: true });
  mkdirSync(join(home, 'storages'), { recursive: true });
  writeFileSync(join(home, 'storages', 'workspace.json'), '[]');
  writeFileSync(join(home, 'attachments', 'a.txt'), 'scan lock');
  return home;
}

test('并发两次 scan 复用同一轮结果（不会扫两遍）', async () => {
  const home = makeHome();
  process.env.DSH_HOME_TEST = home;
  try {
    const engine = new Engine({ transport: new MemTransport(), store: new Store(), config: config() });
    const [r1, r2] = await Promise.all([engine.scan(), engine.scan()]);
    assert.equal(r1, r2, '并发调用必须拿到同一个对象（同一轮）');
    assert.ok(r1.local.some((e) => e.rel === 'attachments/a.txt'));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('三个并发调用同样只跑一轮', async () => {
  const home = makeHome();
  process.env.DSH_HOME_TEST = home;
  try {
    const engine = new Engine({ transport: new MemTransport(), store: new Store(), config: config() });
    const all = await Promise.all([engine.scan(), engine.scan(), engine.scan()]);
    assert.equal(new Set(all).size, 1, '三个结果必须是同一个对象');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('一轮结束后解锁：串行两次是两轮不同结果', async () => {
  const home = makeHome();
  process.env.DSH_HOME_TEST = home;
  try {
    const engine = new Engine({ transport: new MemTransport(), store: new Store(), config: config() });
    const r1 = await engine.scan();
    const r2 = await engine.scan();
    assert.notEqual(r1, r2, '串行调用必须是两轮');
    assert.equal(r1.pending.length, r2.pending.length, '内容应一致');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('扫描抛错后必须解锁，下一轮仍可执行', async () => {
  const home = makeHome();
  process.env.DSH_HOME_TEST = home;
  try {
    const transport = new MemTransport();
    const engine = new Engine({ transport, store: new Store(), config: config() });
    // 注入一次失败：让清单目录列举抛错（readRemoteManifest 会吞掉并降级，
    // 这里改成让 buildManifest 阶段失败 —— 删掉 attachments 目录并让它不可读）
    const originalBuild = engine.scanner.buildManifest.bind(engine.scanner);
    let failOnce = true;
    engine.scanner.buildManifest = async () => {
      if (failOnce) { failOnce = false; throw new Error('注入的构建失败'); }
      return originalBuild();
    };
    await assert.rejects(() => engine.scan(), /注入的构建失败/);
    const ok = await engine.scan();
    assert.ok(Array.isArray(ok.local), '失败一轮之后必须还能再扫');
    assert.ok(ok.local.some((e) => e.rel === 'attachments/a.txt'));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('并发期间抛错：所有等待者都收到同一个错误，之后仍可恢复', async () => {
  const home = makeHome();
  process.env.DSH_HOME_TEST = home;
  try {
    const engine = new Engine({ transport: new MemTransport(), store: new Store(), config: config() });
    const originalBuild = engine.scanner.buildManifest.bind(engine.scanner);
    let failOnce = true;
    engine.scanner.buildManifest = async () => {
      if (failOnce) { failOnce = false; throw new Error('并发失败'); }
      return originalBuild();
    };
    const results = await Promise.allSettled([engine.scan(), engine.scan()]);
    assert.equal(results.filter((r) => r.status === 'rejected').length, 2, '两个等待者都该失败');
    const ok = await engine.scan();
    assert.ok(Array.isArray(ok.local), '失败后必须解锁');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
