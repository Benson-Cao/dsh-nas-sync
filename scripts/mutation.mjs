/**
 * 轻量变异测试（0.6.0 / 收尾⑤）
 * --------------------------------
 * 不引依赖：对 `dist-test/*.mjs` 的**一处关键判据**做字符串变异，重跑对应的
 * 测试文件；测试变红 = 这个变异被杀死，说明这条判据真的被断言覆盖。
 * 测试仍绿 = 有存活变异体，就是测试盲区，报告里会列出具体是哪一处。
 *
 * 为什么变异的是打包产物而不是 src：单测 import 的就是 dist-test，
 * 改产物才能立刻被看到；且脚本用 try/finally + exit 钩子保证**一定恢复**，
 * 不会把工作区源码改坏。运行前需先 `npm run build:test`（CI 里由 verify 保证）。
 *
 * 用法：
 *   node scripts/mutation.mjs              # 报告，存活变异体只警告
 *   node scripts/mutation.mjs --strict     # 有存活变异体就退出码 1
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const STRICT = process.argv.includes('--strict');

/** 每个 case 只改一处；`from` 找不到时标 skipped，不假装测过。 */
const CASES = [
  {
    name: '事件流：坏行必须判为不完整',
    file: 'dist-test/events.mjs', test: 'test/events.test.mjs',
    from: 'corrupted: badLines > 0', to: 'corrupted: false',
  },
  {
    name: '删除阈值：连续两轮才可回收',
    file: 'dist-test/safety.mjs', test: 'test/safety.test.mjs',
    from: 'return (rounds ?? 0) >= RETIRE_AFTER_MISSING_ROUNDS;', to: 'return false;',
  },
  {
    name: '事件流可信判据：不完整时禁止删除',
    file: 'dist-test/safety.mjs', test: 'test/delete-propagation.test.mjs',
    from: 'return { allowed: true, reason: null };',
    to: 'return { allowed: false, reason: null };',
  },
  {
    name: '扫描缓存：TTL 到期必须重算',
    file: 'dist-test/scan-cache.mjs', test: 'test/scan-cache.test.mjs',
    from: 'return opts.now - prev.at < Math.max(1, opts.ttlMs);', to: 'return true;',
  },
  {
    name: '插件装配：非法对象指纹必须丢弃',
    file: 'dist-test/plugin-objects.mjs', test: 'test/plugin-objects.test.mjs',
    from: 'if (!r || !r.name || !r.target || !isValidObjectHash(r.objectHash)) continue;',
    to: 'if (!r || !r.name || !r.target) continue;',
  },
  {
    name: '迁移校验：同名冲突必须挡住',
    file: 'dist-test/rel-migration.mjs', test: 'test/rel-migration.test.mjs',
    from: 'if (plan.collisions.length > 0) {', to: 'if (false) {',
  },
  {
    name: '清单写入：只写确认上传成功的条目',
    file: 'dist-test/manifest.mjs', test: 'test/manifest.test.mjs',
    from: 'if (pushedOk.has(e.rel)) return true;', to: 'if (false) return true;',
  },
  {
    name: 'tgz 解包：路径里的 .. 必须拒绝',
    file: 'dist-test/tgz.mjs', test: 'test/plugin-cas.test.mjs',
    from: 'if (parts.some((s) => s === "..")) return null;', to: 'if (false) return null;',
  },
  {
    name: 'NSS1 解密：必须返回明文而不是空',
    file: 'dist-test/crypto.mjs', test: 'test/crypto.test.mjs',
    from: 'return plain;', to: 'return new Uint8Array(0);',
  },
  {
    name: '排除规则：跳过目录集合必须生效',
    file: 'dist-test/exclusions.mjs', test: 'test/exclusions.test.mjs',
    from: 'return SKIP_DIR_NAMES.has(String(name || ""));', to: 'return false;',
  },
];

/** 退出时把所有改过的文件恢复，防止中断留下变异产物。 */
const originals = new Map();
function restoreAll() {
  for (const [file, text] of originals) {
    try { writeFileSync(file, text, 'utf8'); } catch { /* 尽力而为 */ }
  }
}
process.on('exit', restoreAll);
process.on('SIGINT', () => { restoreAll(); process.exit(130); });

const results = [];
for (const c of CASES) {
  if (!existsSync(c.file) || !existsSync(c.test)) {
    results.push({ ...c, status: 'skipped', reason: '产物或测试文件不存在（先跑 npm run build:test）' });
    continue;
  }
  const original = readFileSync(c.file, 'utf8');
  if (!original.includes(c.from)) {
    results.push({ ...c, status: 'skipped', reason: '产物里找不到变异锚点（源码可能已改，需更新脚本）' });
    continue;
  }
  originals.set(c.file, original);
  const mutated = original.replace(c.from, c.to);
  let status;
  try {
    writeFileSync(c.file, mutated, 'utf8');
    const run = spawnSync(process.execPath, ['--test', c.test], {
      encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120_000,
    });
    status = run.status === 0 ? 'survived' : 'killed';
    if (run.error) {
      results.push({ ...c, status: 'skipped', reason: '测试进程异常：' + String(run.error) });
      continue;
    }
  } finally {
    writeFileSync(c.file, original, 'utf8');
    originals.delete(c.file);
  }
  results.push({ ...c, status });
}

const killed = results.filter((r) => r.status === 'killed').length;
const survived = results.filter((r) => r.status === 'survived');
const skipped = results.filter((r) => r.status === 'skipped');
const rate = results.length ? (killed / (killed + survived.length)) * 100 : 0;

mkdirSync('reports', { recursive: true });
writeFileSync('reports/mutation.json', JSON.stringify({
  at: new Date().toISOString(), killed, survived: survived.length,
  skipped: skipped.length, killRate: Number(rate.toFixed(2)), results,
}, null, 2) + '\n', 'utf8');

console.log('\n=== 变异测试 ===');
for (const r of results) {
  const mark = r.status === 'killed' ? '✓ 杀死' : r.status === 'survived' ? '✗ 存活' : '- 跳过';
  console.log(`  ${mark}  ${r.name}${r.reason ? '（' + r.reason + '）' : ''}`);
}
console.log(`  杀死 ${killed} / ${killed + survived.length}，跳过 ${skipped.length}，kill rate ${rate.toFixed(1)}%`);
if (survived.length) console.log('  存活变异体 = 测试盲区，详见 reports/mutation.json');
if (skipped.length) console.log('  跳过的锚点需要更新 scripts/mutation.mjs，不能算作通过。');
if (STRICT && (survived.length > 0 || skipped.length > 0)) process.exit(1);
