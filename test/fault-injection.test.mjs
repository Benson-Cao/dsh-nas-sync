/**
 * 0.6.0 / 收尾⑤：故障注入。
 *
 * 删不掉／传不上去都只是「这轮不收敛」，最坏的是「把读失败当成删库信号」。
 * 所以这里注入的每一类故障，验收重点都不是「有没有优雅报错」，而是
 * **本地用户数据一个字节都不许动**，以及破坏性动作被 fail-closed 挡住。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemTransport } from './_mem-transport.mjs';
const { Engine } = await import('../dist-test/engine.mjs');
const { Store } = await import('../dist-test/config.mjs');
const { Crypto } = await import('../dist-test/crypto.mjs');
const { pluginObjectPath } = await import('../dist-test/plugin-objects.mjs');

const PASS = 'fault-pass';
const REL = 'attachments/a.txt';
const FILE_TEXT = 'do not lose me';

function config() {
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
  };
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-fault-'));
  process.env.DSH_HOME_TEST = home;
  mkdirSync(join(home, 'nas-sync'), { recursive: true });
  mkdirSync(join(home, 'attachments'), { recursive: true });
  writeFileSync(join(home, 'attachments', 'a.txt'), FILE_TEXT);
  const transport = new MemTransport();
  return {
    home, transport,
    engine: new Engine({ transport, store: new Store(), config: config() }),
    file: join(home, 'attachments', 'a.txt'),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

/** 小工具：造一个只有一个文件的合法 .tgz */
function oneFileTgz() {
  const B = 512;
  const h = Buffer.alloc(B, 0);
  const data = Buffer.from('{"name":"x","version":"1.0.0"}');
  h.write('package/package.json', 0, 'utf8');
  h.write('0000644\0', 100, 'ascii');
  h.write('0000000\0', 108, 'ascii');
  h.write('0000000\0', 116, 'ascii');
  h.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
  h.write('00000000000\0', 136, 'ascii');
  h.write('        ', 148, 'ascii');
  h.write('0', 156, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  let sum = 0; for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return Buffer.from(gzipSync(Buffer.concat([
    h, data, Buffer.alloc((B - data.length % B) % B), Buffer.alloc(1024),
  ])));
}

async function putManifest(fx, entries) {
  const enc = await Crypto.encrypt(
    new TextEncoder().encode(JSON.stringify(entries)), PASS, Buffer.alloc(16, 7),
  );
  await fx.transport.putBuffer(enc, '/dsh/manifests/peer.json', { mkdirs: true });
}

test('注入：事件流目录 list 失败 → 不可信，本地文件原地不动', async () => {
  const fx = fixture();
  try {
    await putManifest(fx, [{ rel: REL, mtime: 1, size: 1, hash: 'a'.repeat(64), device: 'peer' }]);
    fx.transport.faults.set('list', (_n, [dir]) =>
      dir.includes('/dsh/events') ? new Error('NAS offline') : null);
    await fx.engine.scan();
    assert.equal(existsSync(fx.file), true);
    assert.equal(fx.engine.safetyStatus().eventStream.trusted, false);
  } finally { fx.cleanup(); }
});

test('注入：某份设备清单 getBuffer 失败 → 禁止删除传播，不许回收文件', async () => {
  const fx = fixture();
  try {
    await putManifest(fx, [{ rel: REL, mtime: 1, size: 1, hash: 'a'.repeat(64), device: 'peer' }]);
    fx.transport.faults.set('getBuffer', (_n, [p]) =>
      p.includes('/dsh/manifests/') ? new Error('half-written manifest') : null);
    await fx.engine.scan();
    assert.equal(existsSync(fx.file), true);
    assert.equal(fx.engine.listRemovedSessions().length, 0);
    assert.ok(fx.engine.safetyStatus().manifestTrustFailed.length > 0);
  } finally { fx.cleanup(); }
});

test('注入：所有远端写失败 → confirmDelete 不发布、文件不动', async () => {
  const fx = fixture();
  try {
    fx.transport.faults.set('putBuffer', new Error('read-only NAS'));
    fx.transport.faults.set('putIfMatch', new Error('read-only NAS'));
    let r;
    try {
      r = await fx.engine.confirmDelete(REL);
    } catch {
      r = { published: false };
    }
    assert.equal(r.published, false);
    assert.equal(existsSync(fx.file), true);
    assert.equal(fx.engine.listRemovedSessions().length, 0);
  } finally { fx.cleanup(); }
});

test('注入：事件分片读到半截 → 完整性判据报错且一个文件都不删', async () => {
  const fx = fixture();
  try {
    const PEER = 'android:PHONE';
    const { makeEvent, serializeEventLog, eventLogFileOf } = await import('../dist-test/events.mjs');
    const ev = makeEvent({
      device: PEER, seq: 1, ts: 1_700_000_000_000,
      key: 'rel:' + REL, rel: REL, op: 'delete',
    });
    fx.transport.blobs.set(
      eventLogFileOf(PEER, 0),
      Buffer.from(serializeEventLog([ev]) + '{"device":"android:PHONE","seq":2'),
    );
    fx.transport.dirs.add('/dsh/events/' + PEER.replace(/[^A-Za-z0-9._-]/g, '_'));
    fx.transport.dirs.add('/dsh/events');
    await fx.engine.scan();
    assert.equal(existsSync(fx.file), true);
    assert.equal(fx.engine.safetyStatus().eventStream.trusted, false);
  } finally { fx.cleanup(); }
});

test('注入：装配清单 CAS 持续冲突 → 发布明确失败，但对象已写入可重跑', async () => {
  const fx = fixture();
  try {
    const tgzPath = join(fx.home, 'x.tgz');
    writeFileSync(tgzPath, oneFileTgz());
    // 让 putIfMatch 永远返回冲突；putBuffer 仍可用（对象能写进去）
    fx.transport.putIfMatch = async () => ({ ok: false, etag: 'conflict', reason: 'conflict' });
    await assert.rejects(
      () => fx.engine.publishPluginObject({ name: 'x', version: '1.0.0', tgzPath }),
      /并发冲突|重试 3 次/,
    );
    const objectPaths = fx.transport.paths().filter((p) => p.startsWith('/dsh/objects/'));
    assert.equal(objectPaths.length, 1, '对象应已写入 CAS，重跑可复用，不会留孤儿');
    assert.ok(objectPaths[0].startsWith('/dsh/objects/'));
    assert.match(objectPaths[0], /\/[0-9a-f]{64}$/);
  } finally { fx.cleanup(); }
});
