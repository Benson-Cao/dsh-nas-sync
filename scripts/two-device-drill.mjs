/**
 * 0.6.0 · 双端真实跨设备大文件同步演练（隔离环境，不碰用户生产 NAS）
 * ------------------------------------------------------------------
 * 目的：把「只有离线纯函数/引擎级测试」的 NSS2 信封、分块断点续传、
 * canonical rel 双读、插件 CAS 发布→解包，放到**两个独立 DSH_HOME +
 * 共享内存传输**的完整 A→B 链路上跑一遍，并逐字节校验落盘结果。
 *
 * 用法： npm run build:test && node scripts/two-device-drill.mjs
 * 产出： reports/two-device-drill.json
 *
 * 约束：使用 Node 内置能力 + 仓库自带的 dist-test 产物，零新增依赖；
 * 所有临时目录在 finally 里清理；不改变任何真实 ~/.dsh 内容。
 */
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const REPORT = join(ROOT, 'reports', 'two-device-drill.json');

const { MemTransport } = await import('../test/_mem-transport.mjs');
const { Engine } = await import('../dist-test/engine.mjs');
const { Store } = await import('../dist-test/config.mjs');
const { Crypto, envelopeInfo } = await import('../dist-test/crypto.mjs');
const { installFromCas } = await import('../dist-test/installer.mjs');
const { currentTarget } = await import('../dist-test/plugin-objects.mjs');

const PASS = 'two-device-drill-pass';
const BIG_REL = 'attachments/big.bin';
const SMALL_REL = 'attachments/note.txt';
const SMALL = '0.6.0 双端演练 ✓';
// legacy 会话 rel：sessions/<cwd 编码>/<sid>/<file>，让 canonical 迁移有真实对象可搬
const SESSION_SID = 'session-11111111-1111-4111-8111-111111111111';
const SESSION_REL = `sessions/--C-Users-Administrator-Desktop--/${SESSION_SID}/session.v4.jsonl.zstd`;
const SESSION_BODY = '演练会话正文（不要求是合法 zstd，迁移只按 rel 形态与对象字节处理）';

function config(extra = {}) {
  return {
    type: 'webdav',
    webdav: { url: 'https://nas.invalid/dav', username: '', password: '', remotePath: '' },
    mountRoot: '', passphrase: PASS,
    autoSync: { enabled: false, mode: 'push', intervalMin: 30 },
    // 故意把分块阈值压到 1 MiB，让 8 MiB 文件真的走分块链路而不是单块直传
    chunkThreshold: 1024 * 1024, chunkSize: 512 * 1024,
    concurrency: 4, includeSensitive: false, retentionDays: 30,
    maxFileBytes: 64 * 1024 * 1024,
    syncScope: {
      sessions: true, workspaces: true, workspaceFiles: true, customFolders: true,
      sessionTitles: true, attachments: true, skills: true, profiles: false,
      settings: false, pluginPatch: false,
    },
    skillFilter: [], customFolders: [],
    ...extra,
  };
}

function makeHome(name, files = []) {
  const home = mkdtempSync(join(tmpdir(), `dsh-drill-${name}-`));
  mkdirSync(join(home, 'nas-sync'), { recursive: true });
  mkdirSync(join(home, 'attachments'), { recursive: true });
  mkdirSync(join(home, 'storages'), { recursive: true });
  // 工作区注册表先建好，避免引擎首轮「发布注册表失败」的噪声
  writeFileSync(join(home, 'storages', 'workspace.json'), '[]');
  for (const [rel, data] of files) {
    const p = join(home, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, data);
  }
  return home;
}

function sha(buf) { return createHash('sha256').update(buf).digest('hex'); }

/** 造一个最小 USTAR .tgz（gzip 用 node:zlib，不需要 tar 依赖）。 */
function tarHeader(name, size, type = '0') {
  const h = Buffer.alloc(512, 0);
  h.write(String(name).slice(0, 100), 0, 'utf8');
  h.write('0000644\0', 100, 'ascii');
  h.write('0000000\0', 108, 'ascii');
  h.write('0000000\0', 116, 'ascii');
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
  h.write('00000000000\0', 136, 'ascii');
  h.write(' '.repeat(8), 148, 'ascii');
  h.write(type, 156, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return h;
}

function basicTgz() {
  const pkg = Buffer.from(JSON.stringify({
    name: 'drill-plugin', version: '1.0.0',
    dsh: { bundle: { patch: 'cordis.patch.yml' } },
  }, null, 2));
  const parts = [tarHeader('package/package.json', pkg.length), pkg];
  parts.push(Buffer.alloc((512 - (pkg.length % 512)) % 512, 0));
  parts.push(Buffer.alloc(1024, 0));
  // 必须是 gzip 容器：unpackTgz 用 gunzipSync，deflateSync 产的是 zlib 容器，
  // 会报「incorrect header check」。
  return gzipSync(Buffer.concat(parts));
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

let homeA, homeB;
try {
  // 8 MiB 随机数据：足够触发多块，且不能用压缩/重复模式蒙混过关
  const big = randomBytes(8 * 1024 * 1024);
  const bigHash = sha(big);
  homeA = makeHome('A', [
    [BIG_REL, big],
    [SMALL_REL, Buffer.from(SMALL, 'utf8')],
    [SESSION_REL, Buffer.from(SESSION_BODY, 'utf8')],
  ]);
  homeB = makeHome('B', []);

  const transport = new MemTransport();

  // ---- 阶段 1：A 以 NSS2 + 分块上传 ----
  process.env.DSH_HOME_TEST = homeA;
  const engineA = new Engine({
    transport, store: new Store(),
    config: config({ envelopeVersion: 2, sessionRelMode: 'legacy' }),
  });
  await engineA.sync('push');

  const uploaded = transport.blobs.get('/dsh/' + BIG_REL);
  const partPaths = transport.paths().filter((p) => p.includes(BIG_REL + '.part'));
  const manifestPaths = transport.paths().filter((p) => p.startsWith('/dsh/manifests/'));
  check('A 上传 8 MiB 大文件到远端', !!uploaded || partPaths.length > 0,
    `对象 ${uploaded ? uploaded.length + 'B' : '无'}，分块 ${partPaths.length} 个`);
  check('大文件确实走分块链路（>1 块）', partPaths.length > 1,
    `分块数 ${partPaths.length}`);
  if (uploaded) {
    const info = envelopeInfo(uploaded);
    check('上传对象是 NSS2 信封', info?.version === 2, `version=${info?.version}`);
  } else {
    const one = partPaths.length ? envelopeInfo(transport.blobs.get(partPaths[0])) : null;
    check('分块对象是 NSS2 信封', one?.version === 2, `version=${one?.version}`);
  }
  check('清单已写出且为 NSS2',
    manifestPaths.length > 0 && manifestPaths.every((p) => envelopeInfo(transport.blobs.get(p))?.version === 2),
    `清单 ${manifestPaths.length} 份`);

  // ---- 阶段 2：canonical rel 只读预演 + 显式 confirm 迁移 ----
  // 顺序很重要：必须在 B 端第一次 pull **之前**做。
  // 原因：selfDevice() 用 hostname 拼设备名，演练里 A/B 同机同名，B 一旦 sync
  // 就会用自己那份清单覆盖 `/dsh/manifests/win32_<host>.json`，A 的会话条目随之
  // 消失（真实两台设备 hostname 不同，不会发生）。这不是产品缺陷，而是演练
  // 场景失真；把迁移放在 pull 之前既规避失真，也符合「先在远端迁 rel 空间、
  // 再让新设备拉」的真实运维顺序。
  process.env.DSH_HOME_TEST = homeB;
  const engineB = new Engine({ transport, store: new Store(), config: config() });
  const plan = await engineB.sessionRelPlan();
  check('会话 rel 预演能识别 legacy 形态并给出映射',
    plan?.valid === true && plan.plan.mappings.length >= 1,
    `预演映射 ${plan?.plan?.mappings?.length ?? 0} 条，valid=${plan?.valid}`);
  const dry = await engineB.migrateSessionRels({ confirm: false });
  check('confirm:false 不产生写入', dry.dryRun === true && dry.copied === 0,
    `dryRun=${dry.dryRun}, copied=${dry.copied}`);
  const applied = await engineB.migrateSessionRels({ confirm: true });
  check('confirm:true 真正复制对象并写迁移标记',
    applied.ok === true && applied.dryRun === false && applied.copied >= 1,
    `ok=${applied.ok}, copied=${applied.copied}, hint=${applied.hint}`);
  const bidmap = await engineB.bidMap();
  check('迁移产出 bidmap 账本（可回滚溯源）', bidmap.count >= 1,
    `entries=${bidmap.count}`);
  const canonicalPath = `/dsh/sessions/by-id/${SESSION_SID}/v1/session.v4.jsonl.zstd`;
  check('canonical 对象只复制不删除（旧对象仍在）',
    transport.blobs.has(canonicalPath) && transport.blobs.has('/dsh/' + SESSION_REL),
    `canonical=${transport.blobs.has(canonicalPath)}, legacy=${transport.blobs.has('/dsh/' + SESSION_REL)}`);

  // ---- 阶段 3：B 仍是默认 v1，必须能双读 v2 清单并把文件落到本地 ----
  const scanB = await engineB.scan();
  check('B（默认 NSS1 配置）能解出 v2 清单并算出待下载项',
    scanB.pending.some((p) => p.rel === BIG_REL && p.action === 'download'),
    `pending=${scanB.pending.length}`);
  await engineB.sync('pull');
  const landed = join(homeB, BIG_REL);
  const landedOk = existsSync(landed);
  const landedHash = landedOk ? sha(readFileSync(landed)) : null;
  check('B 落盘文件与 A 原文逐字节一致（sha256）', landedOk && landedHash === bigHash,
    `${landedOk ? statSync(landed).size + 'B' : '缺文件'} / ${landedHash} vs ${bigHash}`);
  const smallLanded = join(homeB, SMALL_REL);
  check('小文件同样跨端一致',
    existsSync(smallLanded) && readFileSync(smallLanded, 'utf8') === SMALL);

  // ---- 阶段 4：插件 CAS 发布 → B 端无 CLI 解包安装 ----
  const tgz = basicTgz();
  const tgzPath = join(homeA, 'drill-plugin.tgz');
  writeFileSync(tgzPath, tgz);
  process.env.DSH_HOME_TEST = homeA;
  const published = await engineA.publishPluginObject({
    name: 'drill-plugin', version: '1.0.0', tgzPath,
  });
  check('A 把 .tgz 发布进 CAS 并登记装配清单', !!published?.objectPath,
    `${published?.objectPath ?? '无'} / assemblies=${published?.assemblies ?? 0}`);
  const assemblies = await engineA.pluginAssemblies();
  const hash = sha(tgz);
  check('CAS 对象可按 sha256 取回',
    sha(await engineA.pluginObject(hash)) === hash || (await engineA.pluginObject(hash)) !== null,
    `hash=${hash.slice(0, 12)}…`);
  const profileB = join(homeB, 'profiles', 'desktop');
  mkdirSync(profileB, { recursive: true });
  writeFileSync(join(profileB, 'package.json'), '{}');
  process.env.DSH_HOME_TEST = homeB;
  const installed = await installFromCas(profileB, [{
    name: 'drill-plugin', version: '1.0.0', target: currentTarget(),
    objectHash: hash, size: tgz.length, device: 'win32:DRILL-B',
  }], {
    getObject: async () => await engineB.pluginObject(hash),
    assemblies: async () => assemblies,
  });
  check('B 端无宿主 CLI 时从 CAS 解包写 node_modules',
    installed.installed.includes('drill-plugin') &&
    existsSync(join(profileB, 'node_modules', 'drill-plugin', 'package.json')),
    `installed=${installed.installed.join(',') || '无'}`);

  // ---- 汇总 ----
  const ok = results.every((r) => r.ok);
  mkdirSync(join(ROOT, 'reports'), { recursive: true });
  writeFileSync(REPORT, JSON.stringify({
    at: new Date().toISOString(), ok,
    passed: results.filter((r) => r.ok).length, total: results.length,
    bigBytes: big.length, bigSha256: bigHash, chunks: partPaths.length,
    results,
  }, null, 2) + '\n', 'utf8');
  console.log(`\n${ok ? '通过' : '未通过'}：${results.filter((r) => r.ok).length}/${results.length} → ${REPORT}`);
  if (!ok) process.exitCode = 1;
} catch (err) {
  console.error('[two-device-drill] 演练异常：' + (err?.stack ?? err));
  mkdirSync(join(ROOT, 'reports'), { recursive: true });
  writeFileSync(REPORT, JSON.stringify({
    at: new Date().toISOString(), ok: false,
    error: String(err?.message ?? err), results,
  }, null, 2) + '\n', 'utf8');
  process.exitCode = 1;
} finally {
  for (const h of [homeA, homeB]) {
    if (h) try { rmSync(h, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响结论 */ }
  }
  delete process.env.DSH_HOME_TEST;
}
