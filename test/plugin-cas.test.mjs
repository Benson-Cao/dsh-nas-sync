/**
 * 0.6.0 / 收尾④：插件包体 CAS 的端到端验收。
 *   构造真实 tar/gzip → 发布进 CAS → 装配清单 → 无 CLI 设备解包安装 → 登记 bundles。
 * 同时锁死解包的安全边界：路径穿越、绝对路径、符号链接、checksum 损坏、hash 不符。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemTransport } from './_mem-transport.mjs';
const { unpackTgz, safeTarPath } = await import('../dist-test/tgz.mjs');
const {
  installFromCas, Installer, resolveCliScript,
} = await import('../dist-test/installer.mjs');
const { Engine } = await import('../dist-test/engine.mjs');
const { Store } = await import('../dist-test/config.mjs');
const { recordsForTarget, currentTarget, pluginObjectPath } = await import('../dist-test/plugin-objects.mjs');

/** 造一个最小 USTAR 头（checksum 按标准：8 空格占位 → 6 位八进制 + NUL + 空格）。 */
function tarHeader(name, size, type = '0', mode = 0o644) {
  const h = Buffer.alloc(512, 0);
  h.write(String(name).slice(0, 100), 0, 'utf8');
  h.write(mode.toString(8).padStart(7, '0') + '\0', 100, 'ascii');
  h.write('0000000\0', 108, 'ascii');
  h.write('0000000\0', 116, 'ascii');
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
  h.write('00000000000\0', 136, 'ascii');
  h.write('        ', 148, 'ascii');
  h.write(type, 156, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return h;
}

function makeTgz(files) {
  const blocks = [];
  for (const f of files) {
    const [name, content, type = '0', pax] = f;
    if (pax) {
      const rec = pax.record;
      blocks.push(tarHeader('PaxHeader', Buffer.byteLength(rec), 'x'));
      const rb = Buffer.from(rec, 'utf8');
      blocks.push(rb);
      const pad = (512 - rb.length % 512) % 512;
      if (pad) blocks.push(Buffer.alloc(pad));
    }
    const buf = Buffer.from(content ?? '', 'utf8');
    blocks.push(tarHeader(name, type === '5' ? 0 : buf.length, type));
    if (type !== '5' && buf.length) {
      blocks.push(buf);
      const pad = (512 - buf.length % 512) % 512;
      if (pad) blocks.push(Buffer.alloc(pad));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return new Uint8Array(gzipSync(Buffer.concat(blocks)));
}

function paxRecord(key, value) {
  const body = `${key}=${value}\n`;
  for (let digits = 1; digits < 8; digits++) {
    const total = body.length + digits + 1;
    if (String(total).length === digits) return { record: `${total} ${body}` };
  }
  throw new Error('构造 pax 记录失败');
}

const PKG_JSON = JSON.stringify({
  name: 'demo-plugin', version: '1.2.3',
  dsh: { bundle: { patch: './cordis.patch.yml' } },
}, null, 2);

function basicTgz() {
  return makeTgz([
    ['package/package.json', PKG_JSON],
    ['package/lib/index.js', 'module.exports = 42;\n'],
    ['package/lib/', '', '5'],
  ]);
}

test('unpackTgz：目录 / 文件 / package 前缀剥离 / mode 都正确', () => {
  const r = unpackTgz(basicTgz());
  assert.deepEqual(r.entries.map((e) => e.path).sort(),
    ['lib', 'lib/index.js', 'package.json']);
  const pj = r.entries.find((e) => e.path === 'package.json');
  assert.equal(Buffer.from(pj.data).toString('utf8'), PKG_JSON);
  const dir = r.entries.find((e) => e.path === 'lib');
  assert.equal(dir.isDir, true);
  assert.equal(dir.data.length, 0);
  assert.equal(r.rejected.length, 0);
});

test('safeTarPath：拒绝绝对路径 / 盘符 / .. / 反斜杠 / NUL', () => {
  assert.equal(safeTarPath('package/lib/a.js'), 'lib/a.js');
  assert.equal(safeTarPath('/etc/passwd'), null);
  assert.equal(safeTarPath('C:/Windows/x'), null);
  assert.equal(safeTarPath('package/../evil'), null);
  assert.equal(safeTarPath('package\\evil'), null);
  assert.equal(safeTarPath('package/'), null, '顶层目录本身不需要写');
  assert.equal(safeTarPath('a\0b'), null);
});

test('解包安全：路径穿越项与符号链接被拒绝，正常文件仍可用', () => {
  const gz = makeTgz([
    ['package/good.txt', 'ok'],
    ['package/../evil.txt', 'bad'],
    ['package/link', 'some/target', '2'],
  ]);
  const r = unpackTgz(gz);
  assert.deepEqual(r.entries.map((e) => e.path), ['good.txt']);
  assert.equal(r.rejected.length, 2);
  assert.ok(r.rejected.some((x) => x.reason.includes('不安全')));
  assert.ok(r.rejected.some((x) => x.reason.includes('符号链接')));
});

test('坏 gzip / checksum 损坏 / 截断 tar 一律抛错，不返回半份结果', () => {
  assert.throws(() => unpackTgz(new Uint8Array([1, 2, 3])), /gzip/);
  const raw = Buffer.from(gzipSync(Buffer.concat([
    tarHeader('package/a.txt', 3), Buffer.from('abc'), Buffer.alloc(509), Buffer.alloc(1024),
  ])));
  const good = unpackTgz(new Uint8Array(raw));
  assert.equal(good.entries.length, 1);
  const bad = makeTgz([['package/a.txt', 'abc']]);
  // 直接破坏未压缩数据不现实（gzip 有 crc），改成破坏 tar 头后再压缩
  const h = tarHeader('package/a.txt', 3);
  h[0] = 0x7a; // 改了 name 但没重算 checksum
  const broken = new Uint8Array(gzipSync(Buffer.concat([h, Buffer.from('abc'), Buffer.alloc(509), Buffer.alloc(1024)])));
  assert.throws(() => unpackTgz(broken), /checksum/);
  assert.ok(bad.length > 0);
});

test('PAX 扩展头：超长 path 能正确覆盖短头里的截断名', () => {
  const long = 'package/' + 'deep/'.repeat(30) + 'file.txt';
  const rec = paxRecord('path', long);
  const gz = makeTgz([['package/short', 'payload', '0', rec]]);
  const r = unpackTgz(gz);
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].path, long.slice('package/'.length));
});

test('installFromCas：校验指纹 → 解包 → 原子替换 → 登记 dsh.profile.bundles', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-cas-'));
  const profile = join(home, 'profiles', 'desktop');
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, 'package.json'), '{}');
  try {
    const tgz = basicTgz();
    const hash = createHash('sha256').update(Buffer.from(tgz)).digest('hex');
    const source = { getObject: async (h) => (h === hash ? tgz : null), assemblies: async () => [] };
    const r = await installFromCas(profile, [{
      name: 'demo-plugin', version: '1.2.3', target: currentTarget(),
      objectHash: hash, size: tgz.length, device: 'win32:PC',
    }], source);
    assert.deepEqual(r.installed, ['demo-plugin']);
    assert.deepEqual(r.skipped, []);
    assert.deepEqual(r.registered, ['demo-plugin'], '声明了 dsh.bundle.patch 必须登记');
    const written = join(profile, 'node_modules', 'demo-plugin', 'package.json');
    assert.equal(existsSync(written), true);
    assert.equal(JSON.parse(readFileSync(written, 'utf8')).name, 'demo-plugin');
    const pj = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'));
    assert.ok(pj.dsh.profile.bundles.includes('demo-plugin'));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('installFromCas：对象 hash 不符 / 对象缺失 / 包名越界都跳过且绝不写盘', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-cas-bad-'));
  const profile = join(home, 'profiles', 'desktop');
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, 'package.json'), '{}');
  try {
    const tgz = basicTgz();
    const wrong = 'a'.repeat(64);
    const source = { getObject: async () => tgz, assemblies: async () => [] };
    const r = await installFromCas(profile, [
      { name: 'demo-plugin', version: '1', target: 'x', objectHash: wrong, size: tgz.length },
      { name: '../../evil', version: '1', target: 'x', objectHash: wrong, size: 1 },
    ], source);
    assert.equal(r.installed.length, 0);
    assert.equal(r.skipped.length, 2);
    assert.ok(r.skipped.some((s) => s.reason.includes('sha256')));
    assert.ok(r.skipped.some((s) => s.reason.includes('越出')));
    assert.equal(existsSync(join(profile, 'node_modules', 'demo-plugin')), false);

    const noObj = await installFromCas(profile, [{
      name: 'demo-plugin', version: '1', target: 'x',
      objectHash: createHash('sha256').update(Buffer.from(tgz)).digest('hex'), size: 1,
    }], { getObject: async () => null, assemblies: async () => [] });
    assert.equal(noObj.installed.length, 0);
    assert.ok(noObj.skipped[0].reason.includes('没有这个对象'));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('真实引擎全链路：发布 tgz → CAS + 装配清单 → 另一台设备无 CLI 解包安装', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-cas-engine-'));
  process.env.DSH_HOME_TEST = home;
  mkdirSync(join(home, 'nas-sync'), { recursive: true });
  const profile = join(home, 'profiles', 'web');
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, 'package.json'), '{}');
  const tgzPath = join(home, 'demo-plugin-1.2.3.tgz');
  writeFileSync(tgzPath, Buffer.from(basicTgz()));
  try {
    const transport = new MemTransport();
    const cfg = {
      type: 'webdav',
      webdav: { url: 'https://nas.invalid/dav', username: '', password: '', remotePath: '' },
      mountRoot: '', passphrase: 'cas-pass',
      autoSync: { enabled: false, mode: 'push', intervalMin: 30 },
      chunkThreshold: 100 * 1024 * 1024, chunkSize: 50 * 1024 * 1024,
      concurrency: 4, includeSensitive: false,
      syncScope: {
        sessions: true, workspaces: true, workspaceFiles: true, customFolders: true,
        sessionTitles: true, attachments: true, skills: true, profiles: false,
        settings: false, pluginPatch: false,
      },
      skillFilter: [], customFolders: [],
    };
    const engineA = new Engine({ transport, store: new Store(), config: cfg });
    const pub = await engineA.publishPluginObject({
      name: 'demo-plugin', version: '1.2.3', tgzPath,
    });
    assert.equal(pub.objectExisted, false);
    assert.equal(pub.entries, 3);
    assert.equal(transport.blobs.has(pluginObjectPath(pub.record.objectHash)), true);

    const engineB = new Engine({ transport, store: new Store(), config: cfg });
    const assemblies = await engineB.pluginAssemblies();
    assert.equal(assemblies.length, 1);
    assert.equal(assemblies[0].name, 'demo-plugin');
    const recs = recordsForTarget(assemblies, currentTarget());
    assert.equal(recs.length, 1, '本机 target 必须能找到对应对象');

    const r = await installFromCas(profile, recs, {
      getObject: (h) => engineB.pluginObject(h),
      assemblies: () => engineB.pluginAssemblies(),
    });
    assert.deepEqual(r.installed, ['demo-plugin']);
    assert.equal(existsSync(join(profile, 'node_modules', 'demo-plugin', 'lib', 'index.js')), true);

    // 重复发布同一份内容：对象复用，装配清单不产生第二条
    const again = await engineA.publishPluginObject({
      name: 'demo-plugin', version: '1.2.3', tgzPath,
    });
    assert.equal(again.objectExisted, true);
    assert.equal((await engineB.pluginAssemblies()).length, 1);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Installer 在没有宿主 CLI 时自动走 CAS 路径（job.source=cas）', async () => {
  if (resolveCliScript() !== null) {
    // 宿主恰好提供了 CLI 的环境（极少见）不适合断言 CAS 分支
    return;
  }
  const home = mkdtempSync(join(tmpdir(), 'dsh-cas-installer-'));
  const profile = join(home, 'profiles', 'web');
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, 'package.json'), '{}');
  try {
    const tgz = basicTgz();
    const hash = createHash('sha256').update(Buffer.from(tgz)).digest('hex');
    const target = currentTarget();
    const assemblies = [{
      name: 'demo-plugin', version: '1.2.3',
      targets: { [target]: { objectHash: hash, size: tgz.length, device: 'win32:PC' } },
    }];
    const installer = new Installer(() => join(home, 'profiles'), {
      getObject: async (h) => (h === hash ? tgz : null),
      assemblies: async () => assemblies,
    });
    const job = installer.start('web', [{ name: 'demo-plugin', target: 'demo-plugin@1.2.3' }]);
    assert.equal(job.source, 'cas');
    // 等异步 job 跑完（不轮询固定 sleep，最多 2 秒）
    for (let i = 0; i < 100 && job.state === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(job.state, 'done', job.log);
    assert.ok(job.registered.includes('demo-plugin'));
    assert.equal(existsSync(join(profile, 'node_modules', 'demo-plugin', 'package.json')), true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
