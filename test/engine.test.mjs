/**
 * Engine 破坏性路径的离线集成测试（0.5.9）
 *
 * 审查报告 Q02：「删除传播 / 屏蔽清单 / 移目录 / 改注册表的破坏性路径零自动化覆盖」。
 * 这里用真实的 Engine + 真实 Store + 假 WebDAV 传输，在临时 $DSH_HOME 上跑
 * `scan()`，验证「什么时候绝对不能搬文件」以及「什么时候才允许搬、搬完能不能恢复」。
 *
 * 全程只在 mkdtemp 出来的目录里写文件，不碰用户真实的 ~/.dsh。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { Engine } = await import('../dist-test/engine.mjs');
const { Store } = await import('../dist-test/config.mjs');
const { Crypto } = await import('../dist-test/crypto.mjs');

const PASS = 'engine-test-pass';
const REMOTE_REL = 'sessions/--data-user-0-wstest--/session-aa35e064/session.v4.jsonl.zstd';
const LOCAL_REL = 'sessions/--C-Users-wstest--/session-aa35e064/session.v4.jsonl.zstd';
const SID = 'session-aa35e064';

/** 只实现 readRemoteManifest() 会用到的三个方法。 */
class FakeTransport {
  constructor() { this.blobs = new Map(); }
  async list(dir) {
    if (dir !== '/dsh/manifests') return [];
    return [...this.blobs.keys()]
      .filter((p) => p.startsWith('/dsh/manifests/') && p.endsWith('.json'))
      .map((p) => ({ name: p.slice('/dsh/manifests/'.length), type: 'file' }));
  }
  async getBuffer(p) {
    const b = this.blobs.get(p);
    if (!b) throw new Error('404 ' + p);
    return b;
  }
  async putBuffer(b, p) { this.blobs.set(p, Buffer.from(b)); }
  async remove(p) { this.blobs.delete(p); }
  async test() { return true; }
}

function baseConfig() {
  const all = {
    sessions: true, workspaces: true, workspaceFiles: true, customFolders: true,
    sessionTitles: true, attachments: true, skills: true, profiles: false,
    settings: false, pluginPatch: false,
  };
  return {
    type: 'webdav',
    webdav: { url: 'https://nas.invalid/dav', username: '', password: '', remotePath: '' },
    mountRoot: '', passphrase: PASS,
    autoSync: { enabled: false, mode: 'mirror', intervalMin: 30 },
    chunkThreshold: 100 * 1024 * 1024,
    chunkSize: 50 * 1024 * 1024,
    concurrency: 4,
    includeSensitive: false,
    syncScope: all,
    skillFilter: [],
    customFolders: [],
  };
}

/** 建好一个临时 home：一个本地会话镜像 + 一条 sessionImports 记录。 */
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-engine-'));
  const dir = join(home, 'nas-sync');
  const prev = process.env.DSH_HOME_TEST;
  process.env.DSH_HOME_TEST = home;
  mkdirSync(dir, { recursive: true });
  const localAbs = join(home, LOCAL_REL);
  mkdirSync(join(localAbs, '..'), { recursive: true });
  writeFileSync(localAbs, Buffer.from('local session mirror'));

  const store = new Store();
  store.sessionImports[REMOTE_REL] = {
    remoteHash: 'h', localRel: LOCAL_REL, localHash: 'l',
    originalCwd: '/data/user/0/wstest', missingRounds: 0,
  };
  store.save();
  const config = baseConfig();
  const transport = new FakeTransport();
  const engine = new Engine({ transport, store, config });
  return {
    home, dir, store, engine, transport, localAbs,
    dispose() {
      if (prev === undefined) delete process.env.DSH_HOME_TEST;
      else process.env.DSH_HOME_TEST = prev;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

async function putManifest(fx, name, entries) {
  const enc = await Crypto.encrypt(
    new TextEncoder().encode(JSON.stringify(entries)), PASS, fx.store.salt(),
  );
  fx.transport.putBuffer(enc, '/dsh/manifests/' + name);
}

/** 让某一「份」清单读不成：放一段解密必然失败的字节。 */
function putBrokenManifest(fx, name) {
  fx.transport.putBuffer(Buffer.from('not-a-valid-NSS1-file'), '/dsh/manifests/' + name);
}

test('Q02/Q01 实测：3 份清单坏 1 份时，跑 4 轮也不许搬走本机会话', async () => {
  const fx = fixture();
  try {
    putBrokenManifest(fx, 'android_localhost.json');
    await putManifest(fx, 'win32_Benson.json', []);
    await putManifest(fx, 'third.json', []);

    for (let i = 0; i < 4; i++) await fx.engine.scan();

    assert.ok(existsSync(fx.localAbs), '清单不全时本机会话必须原样留着');
    assert.ok(fx.store.sessionImports[REMOTE_REL], '导入账不能被销掉');
    assert.equal(fx.engine.safetyStatus().destructiveBlocked, false);
    assert.ok(fx.engine.safetyStatus().manifestTrustFailed.includes('android_localhost.json'));
  } finally { fx.dispose(); }
});

test('Q02 实测：清单全部读成时，第一轮不搬、第二轮才搬进回收目录', async () => {
  const fx = fixture();
  try {
    await putManifest(fx, 'win32_Benson.json', []);

    await fx.engine.scan();
    assert.ok(existsSync(fx.localAbs), '第一轮只记数，不能搬');
    assert.equal(fx.store.sessionImports[REMOTE_REL].missingRounds, 1);

    await fx.engine.scan();
    assert.ok(!existsSync(fx.localAbs), '连续第二轮可信缺失才回收');
    assert.equal(fx.store.sessionImports[REMOTE_REL], undefined, '账要销掉，否则下轮会被当新文件上传');

    const list = fx.engine.listRemovedSessions();
    assert.equal(list.length, 1);
    assert.equal(list[0].rel, LOCAL_REL);
    assert.equal(list[0].sessionId, SID);
    assert.equal(list[0].reason, 'remote-deleted');
    assert.equal(list[0].restorable, true);
  } finally { fx.dispose(); }
});

test('Q02 实测：中间夹一轮清单不可信，连续计数必须归零重来', async () => {
  const fx = fixture();
  try {
    await putManifest(fx, 'win32_Benson.json', []);
    await fx.engine.scan();
    assert.equal(fx.store.sessionImports[REMOTE_REL].missingRounds, 1);

    // 第二轮：其中一份读失败
    putBrokenManifest(fx, 'android_localhost.json');
    await fx.engine.scan();
    assert.equal(fx.store.sessionImports[REMOTE_REL].missingRounds, 0);
    assert.ok(existsSync(fx.localAbs));

    // 第三轮恢复可信：只能算「新一轮的第 1 次」，不能回收
    fx.transport.remove('/dsh/manifests/android_localhost.json');
    await fx.engine.scan();
    assert.equal(fx.store.sessionImports[REMOTE_REL].missingRounds, 1);
    assert.ok(existsSync(fx.localAbs), '这就是 0.5.8 会误删的场景');
  } finally { fx.dispose(); }
});

test('Q03 实测：回收 → 枚举 → 恢复，文件回到原处且可再次扫描', async () => {
  const fx = fixture();
  try {
    await putManifest(fx, 'win32_Benson.json', []);
    await fx.engine.scan();
    await fx.engine.scan();
    assert.ok(!existsSync(fx.localAbs));

    const [item] = fx.engine.listRemovedSessions();
    const r = await fx.engine.restoreRemovedSession(item.id);
    assert.equal(r.rel, LOCAL_REL);
    assert.ok(existsSync(fx.localAbs), '恢复后文件必须真的回到原目录');
    assert.equal(readFileSync(fx.localAbs, 'utf8'), 'local session mirror');
    // 恢复会顺带撤销屏蔽，下一轮不会立刻被搬走
    assert.deepEqual(fx.engine.listIgnoredSessions().ids, []);
    assert.equal(fx.engine.listRemovedSessions().length, 0);
  } finally { fx.dispose(); }
});

test('Q05 实测：屏蔽清单写坏时 fail-closed，本轮不做任何回收', async () => {
  const fx = fixture();
  try {
    // 构造一个「损坏且无 .bak」的屏蔽清单
    writeFileSync(join(fx.dir, 'ignored-sessions.json'), '{ 手滑写坏', 'utf8');
    await putManifest(fx, 'win32_Benson.json', []);

    // 即便清单可信、即便连跑两轮，也不能搬文件
    await fx.engine.scan();
    await fx.engine.scan();
    assert.ok(existsSync(fx.localAbs));
    assert.equal(fx.engine.safetyStatus().destructiveBlocked, true);
    assert.ok(fx.engine.safetyStatus().ignoredFileError?.includes('屏蔽清单损坏'));
    assert.ok(readdirSync(fx.dir).some((n) => n.startsWith('ignored-sessions.json.corrupt-')));
  } finally { fx.dispose(); }
});

test('Q04 实测：远端清单里的 ../ 与绝对 rel 被过滤，不会落盘到家目录之外', async () => {
  const fx = fixture();
  try {
    const evil = [
      '../../PWNED.json',
      '/tmp/PWNED.json',
      'sessions/../PWNED.json',
      'C:/Windows/PWNED.json',
      'sessions/%2e%2e/PWNED.json',
    ];
    await putManifest(fx, 'win32_Benson.json', evil.map((rel) => ({ rel, hash: 'x', size: 1, mtime: 1 })));
    const { pending } = await fx.engine.scan();
    assert.deepEqual(
      pending.filter((p) => String(p.rel).includes('PWNED')),
      [],
      '危险 rel 不能进待下载列表',
    );
    assert.ok(!existsSync(join(fx.home, 'PWNED.json')));
  } finally { fx.dispose(); }
});

async function putManifestAt(fx, fullPath, entries) {
  const enc = await Crypto.encrypt(
    new TextEncoder().encode(JSON.stringify(entries)), PASS, fx.store.salt(),
  );
  fx.transport.putBuffer(enc, fullPath);
}

test('回归实测：_legacy.json 读成空清单时仍回落到旧单份 /dsh/manifest.json', async () => {
  const fx = fixture();
  try {
    // 迁移后的 _legacy.json 是合法但空的；0.5.8 会继续看老路径，0.5.9 必须保持
    await putManifestAt(fx, '/dsh/manifests/_legacy.json', []);
    await putManifestAt(fx, '/dsh/manifest.json', [
      { rel: REMOTE_REL, hash: 'h2', size: 10, mtime: 2 },
    ]);
    await fx.engine.scan();
    assert.equal(
      fx.store.sessionImports[REMOTE_REL].missingRounds, 0,
      '旧格式清单里还有这条原文，绝不能被当成「对端删了」开始数缺失轮次',
    );
    assert.ok(existsSync(fx.localAbs));
  } finally { fx.dispose(); }
});

test('Q04 实测：目录列举里伪造的 ../ 清单名被过滤，不参与远端读取', async () => {
  const fx = fixture();
  try {
    await putManifestAt(fx, '/dsh/manifests/../evil.json', [
      { rel: '../../PWNED.json', hash: 'x', size: 1, mtime: 1 },
    ]);
    await fx.engine.scan();
    assert.ok(existsSync(fx.localAbs));
    assert.ok(
      fx.engine.safetyStatus().manifestTrustFailed.length > 0,
      '没有任何可信清单时，必须显式标成不可信而不是「空清单也算读成」',
    );
  } finally { fx.dispose(); }
});
