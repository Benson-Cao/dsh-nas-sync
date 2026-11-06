/**
 * build-test.mjs —— 为离线单测生成 `dist-test/*.mjs`。
 *
 * 为什么要脚本而不是手敲 esbuild：改了源码忘了重建，测试就会拿旧产物骗自己
 * （0.3.4 之前就是这样，"测试通过"其实测的是上一版）。所以固定成一条命令：
 *   node scripts/build-test.mjs
 *
 * 两个关键点：
 *   1. `external: ['@deepseek-ai/*']` —— 宿主服务不在单测环境里。
 *   2. `alias` 把 `@deepseek-ai/dsh-home-paths` 指到本地替身 —— 这是 0.3.4
 *      之前 `npm test` 直接 ERR_MODULE_NOT_FOUND 的原因。
 */
import { build } from 'esbuild';

const entries = [
  ['src/sync/scanner.ts', 'dist-test/scanner.mjs'],
  ['src/sync/portable.ts', 'dist-test/portable.mjs'],
  ['src/sync/manifest.ts', 'dist-test/manifest.mjs'],
];

for (const [entry, outfile] of entries) {
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    outfile,
    external: ['@deepseek-ai/*'],
    alias: {
      '@deepseek-ai/dsh-home-paths': './scripts/_test-home-paths-stub.mjs',
    },
    logLevel: 'warning',
  });
  console.log('  ✓ ' + outfile);
}
