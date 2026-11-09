/**
 * 0.6.0 / 收尾⑤：接口契约矩阵（静态 + 一致性）。
 *
 * 目的不是「测 HTTP 能通」（那是真机 E2E 的事），而是锁住几类最容易漂移的
 * 契约：工具注册数、文档口径、端点方法、错误状态码、配置视图不泄露口令。
 * 这些一旦漂移，用户会看到「工具说支持、面板没有 / 文档说 19 个、代码 21 个」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');
const indexSrc = read('src/index.ts');
const bridgeSrc = read('src/bridge.ts');
const readme = read('README.md');

const tools = [...indexSrc.matchAll(/name:\s*'(nas_[a-z_]+)'/g)].map((m) => m[1]);
// 头部注释里也写了 `ctx.tools.register(...)` 作为用法示例，必须排除，
// 否则会把 21 个工具数成 22 个（0.5.9 审查里踩过同一个坑）。
const registered = indexSrc.split('\n').filter(
  (line) => !line.trim().startsWith('*') && line.includes('ctx.tools.register('),
).length;
const endpoints = [...bridgeSrc.matchAll(/sub === '(\/[^']+)' && method === '(GET|POST)'/g)]
  .map((m) => m[2] + ' ' + m[1]);

test('工具注册数：代码、注释、README 三处口径一致', () => {
  assert.equal(registered, 21, '实际注册的工具数');
  assert.equal(new Set(tools).size, 21, '工具名去重后应为 21');
  assert.equal(tools.length, registered, '每个 register 都要有唯一 nas_ 名称');
  const docCount = /共 \*\*(\d+) 个\*\*/.exec(readme);
  assert.ok(docCount, 'README 应写明工具总数');
  assert.equal(Number(docCount[1]), registered, 'README 工具数必须与代码一致');
  const headerCount = /工具清单（(\d+) 个/.exec(indexSrc);
  assert.ok(headerCount, 'index.ts 头部应写明工具数');
  assert.equal(Number(headerCount[1]), registered);
  for (const t of tools) {
    assert.ok(readme.includes('`' + t + '`'), 'README 缺少工具说明：' + t);
  }
});

test('HTTP 桥端点矩阵：关键端点与方法齐全，新增端点也在 README 有交代', () => {
  const must = [
    'GET /status', 'POST /sync', 'GET /pending', 'GET /conflicts',
    'GET /config', 'POST /config', 'GET /skills', 'GET /removed',
    'POST /removed/restore', 'GET /ignored', 'POST /ignored',
    'GET /events', 'GET /events/status', 'POST /events/delete',
    'GET /rel-migration', 'POST /rel-migration',
    'GET /plugins', 'POST /plugins/install', 'POST /plugins/publish',
  ];
  for (const e of must) assert.ok(endpoints.includes(e), '缺少端点：' + e);
  assert.ok(endpoints.length >= must.length);
  assert.equal(new Set(endpoints).size, endpoints.length, '端点+方法不能重复注册');
  for (const e of endpoints) assert.ok(/^(GET|POST) \//.test(e));
  assert.ok(readme.includes('/rel-migration'), 'README 应说明迁移端点');
});

test('错误契约：fail() 支持 HTTP 状态码，新端点的 4xx/409 不被写成 200', () => {
  assert.match(bridgeSrc, /function fail\([^)]*status = 200\)/);
  assert.match(bridgeSrc, /sendJson\(res, status,/);
  assert.match(bridgeSrc, /fail\(res, 'bad-request'[^\n]*400\)/);
  assert.match(bridgeSrc, /fail\(res, 'blocked'[^\n]*409\)/);
  assert.match(bridgeSrc, /fail\(res, 'migration-blocked'[^\n]*409\)/);
});

test('安全契约：配置视图只回 passthrough 布尔量，不回显口令', () => {
  assert.match(bridgeSrc, /passwordSet: Boolean\(cfg\.webdav\?\.password\)/);
  assert.match(bridgeSrc, /passphraseSet: Boolean\(cfg\.passphrase\)/);
  assert.ok(!/password:\s*cfg\.webdav\?\.password/.test(bridgeSrc), '不能回显 WebDAV 密码');
  assert.ok(!/passphrase:\s*cfg\.passphrase/.test(bridgeSrc), '不能回显加密口令');
  // 凭据拆分：store.json 里不许再出现明文口令
  const cfgSrc = read('src/config.ts');
  assert.match(cfgSrc, /splitSecrets\(/);
  assert.match(cfgSrc, /credentials\.json/);
});

test('工具参数 schema：可选参数只能省略 required，不能写 false', () => {
  // 真机事故：0.6.0 首次部署到手机时，nas_session_rel_migrate 写了
  // `confirm: { type:'boolean', required:false }`，宿主的 dsh-tools schema
  // 编译器抛 JsonSchemaError「parameters.confirm.required must be true when
  // present」，导致 nas-sync 整个 bundle 没激活：页面没有 token、所有
  // /nas-sync-api/* 都是 404。离线单测不会 import 宿主 defineTool，
  // 所以这条静态契约是唯一能拦住它的地方。
  // 注释里会引用这条报错原文（含 `required: false` 字样），必须先剥掉注释行，
  // 否则测试会被自己的说明文字误伤。
  const codeOnly = indexSrc.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
  const values = (src) => (src.match(/required:\s*([^,\n}]+)/g) || [])
    .map((s) => s.replace(/^required:\s*/, '').trim());
  const bad = values(codeOnly).filter((v) => v !== 'true');
  assert.deepEqual(bad, [], '参数 schema 里出现非 true 的 required：' + bad.join(' | '));
  assert.ok(values(codeOnly).length > 0, '至少要覆盖到一些必填参数，避免正则失效');
  // 构建产物也要过一遍，防止手写 dist 或构建器改写后把 false 带回去。
  let dist = '';
  try { dist = read('dist/index.js'); } catch { /* CI 未跑 build 时跳过产物层 */ }
  // esbuild 默认保留源码注释，dist 里同样会带上上面那段说明文字，照样剥掉。
  const distCode = dist.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
  const badDist = values(distCode).filter((v) => v !== 'true');
  assert.deepEqual(badDist, [], 'dist/index.js 里有非 true 的 required：' + badDist.join(' | '));
});

test('迁移契约：apply 必须显式 confirm，默认只读预演', () => {
  assert.match(bridgeSrc, /body\?\.confirm === true/);
  assert.match(bridgeSrc, /engine\.migrateSessionRels\(\{ confirm \}\)/);
  const mig = read('src/sync/rel-migration.ts');
  assert.match(mig, /validateRelPlan/);
  assert.match(mig, /keepLegacyUntil/);
  const engine = read('src/sync/engine.ts');
  assert.match(engine, /if \(!opts\.confirm\)/, 'apply 前必须有预演短路');
  assert.match(engine, /legacyHold && isLegacySessionRel\(rel\)\]? continue|if \(legacyHold && isLegacySessionRel\(rel\)\) continue/);
});
