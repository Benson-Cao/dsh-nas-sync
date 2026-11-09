/**
 * 0.6.0 / 收尾②：真实引擎接入 NSS2 的验收。
 * 关键不是「能写 v2」，而是「v2 写出来的清单与文件，默认 v1 配置的另一台设备
 * 照样读得动」—— 也就是升级不需要双端同时切换（双读单写迁移期）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemTransport } from './_mem-transport.mjs';
const { Engine } = await import('../dist-test/engine.mjs');
const { Store } = await import('../dist-test/config.mjs');
const { Crypto, envelopeInfo } = await import('../dist-test/crypto.mjs');

const PASS = 'envelope-engine-pass';
const CONTENT = 'NSS2 端到端内容 ✓';
const REL = 'attachments/note.txt';

function config(extra = {}) {
  return {
    type: 'webdav',
    webdav: { url: 'https://nas.invalid/dav', username: '', password: '', remotePath: '' },
    mountRoot: '', passphrase: PASS,
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

function makeHome(withFile) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-envelope-'));
  process.env.DSH_HOME_TEST = home;
  mkdirSync(join(home, 'nas-sync'), { recursive: true });
  if (withFile) {
    mkdirSync(join(home, 'attachments'), { recursive: true });
    writeFileSync(join(home, 'attachments', 'note.txt'), CONTENT);
  }
  return home;
}

test('envelopeVersion=2：上传的文件与清单都是 NSS2，AAD 绑定稳定主键', async () => {
  const homeA = makeHome(true);
  const transport = new MemTransport();
  const engineA = new Engine({ transport, store: new Store(), config: config({ envelopeVersion: 2 }) });
  try {
    await engineA.sync('push');
    const fileBlob = transport.blobs.get('/dsh/' + REL);
    assert.ok(fileBlob, '文件应已上传到 /dsh/' + REL + '；实际对象：' + transport.paths().join(', '));
    const info = envelopeInfo(fileBlob);
    assert.equal(info.version, 2);
    assert.equal(info.aad, 'dsh-nas-sync|rel:' + REL);
    assert.equal(new TextDecoder().decode(await Crypto.decrypt(fileBlob, PASS)), CONTENT);

    const manifests = transport.paths().filter((p) => p.startsWith('/dsh/manifests/'));
    assert.ok(manifests.length > 0, '应写出设备清单');
    for (const p of manifests) {
      const m = envelopeInfo(transport.blobs.get(p));
      assert.equal(m.version, 2);
      assert.equal(m.aad, 'dsh-nas-sync|manifest');
    }

    // 另一台设备仍是默认 v1，但它能读 v2 的清单与文件（双读）
    const homeB = makeHome(false);
    const engineB = new Engine({ transport, store: new Store(), config: config() });
    const { pending } = await engineB.scan();
    assert.ok(
      pending.some((p) => p.rel === REL && p.action === 'download'),
      'v1 设备应能把 v2 清单解出来并算出待下载项：' + JSON.stringify(pending),
    );
    rmSync(homeB, { recursive: true, force: true });
  } finally {
    rmSync(homeA, { recursive: true, force: true });
  }
});

test('envelopeVersion 缺省 / =1：写出 NSS1，与 0.5.9 逐字节兼容', async () => {
  const home = makeHome(true);
  const transport = new MemTransport();
  const engine = new Engine({ transport, store: new Store(), config: config() });
  try {
    await engine.sync('push');
    const blob = transport.blobs.get('/dsh/' + REL);
    assert.ok(blob);
    assert.equal(new TextDecoder().decode(blob.slice(0, 4)), 'NSS1');
    assert.equal(envelopeInfo(blob).version, 1);
    assert.equal(new TextDecoder().decode(await Crypto.decrypt(blob, PASS)), CONTENT);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
