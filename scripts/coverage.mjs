/**
 * 覆盖率门禁（0.6.0 / 收尾⑤）
 * --------------------------------
 * 用 Node 22 内置的 `--experimental-test-coverage`，不引入 c8/nyc 之类的依赖。
 * 测试跑的是 esbuild 产物 `dist-test/*.mjs`，build-test.mjs 会生成 linked
 * source map，Node 会把行映射回 `src/*.ts`，所以报告里的百分比是源码口径。
 *
 * 用法：
 *   node scripts/coverage.mjs                 # 默认门槛 40% 行覆盖率
 *   node scripts/coverage.mjs --min=60       # 提高门槛
 *   node scripts/coverage.mjs --no-gate      # 只报告不设门禁
 *
 * 门槛说明：单测里有相当比例是「静态契约 / 端到端场景」，它们不逐行执行 UI
 * 与传输层，所以 40% 是趋势基线而不是质量结论；要看具体缺口请读报告里
 * 每个文件的行覆盖率，别只看 all files 这一个数字。
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const minArg = args.find((a) => a.startsWith('--min='));
const MIN = minArg ? Number(minArg.slice(6)) : 40;
const NO_GATE = args.includes('--no-gate');

const testFiles = readdirSync('test')
  .filter((f) => f.endsWith('.test.mjs'))
  .map((f) => join('test', f))
  .sort();

const run = spawnSync(
  process.execPath,
  ['--test', '--experimental-test-coverage', '--enable-source-maps', ...testFiles],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);
const out = (run.stdout ?? '') + (run.stderr ?? '');
process.stdout.write(out);

mkdirSync('reports', { recursive: true });
writeFileSync('reports/coverage.txt', out, 'utf8');

if (run.status !== 0) {
  console.error('[coverage] 测试未全部通过，覆盖率报告不作为通过依据。');
  process.exit(run.status || 1);
}

// Node 22 覆盖率表的汇总行形如：
//   all files                    |   72.34 |    61.11 |   70.00 |
const m = /all files[^\n|]*\|\s*([\d.]+)\s*\|/.exec(out);
if (!m) {
  console.error('[coverage] 没能从输出中解析出 all files 行；请检查 Node 版本与 reports/coverage.txt');
  process.exit(NO_GATE ? 0 : 2);
}
const pct = Number(m[1]);
console.log(`[coverage] 行覆盖率 ${pct.toFixed(2)}%（门槛 ${MIN}%）`);
if (!NO_GATE && pct < MIN) {
  console.error(`[coverage] 低于门槛 ${MIN}%，请补测试或用 --no-gate 明确豁免。`);
  process.exit(1);
}
