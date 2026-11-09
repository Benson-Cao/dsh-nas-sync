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
  ['src/sync/events.ts', 'dist-test/events.mjs'],
  ['src/sync/plugins.ts', 'dist-test/plugins.mjs'],
  ['src/sync/safety.ts', 'dist-test/safety.mjs'],
  ['src/sync/state-file.ts', 'dist-test/state-file.mjs'],
  ['src/sync/crypto.ts', 'dist-test/crypto.mjs'],
  ['src/sync/chunker.ts', 'dist-test/chunker.mjs'],
  ['src/sync/exclusions.ts', 'dist-test/exclusions.mjs'],
  ['src/sync/plugin-objects.ts', 'dist-test/plugin-objects.mjs'],
  ['src/sync/rel-migration.ts', 'dist-test/rel-migration.mjs'],
  ['src/sync/scan-cache.ts', 'dist-test/scan-cache.mjs'],
  ['src/sync/tgz.ts', 'dist-test/tgz.mjs'],
  ['src/sync/installer.ts', 'dist-test/installer.mjs'],
  ['src/config.ts', 'dist-test/config.mjs'],
  ['src/sync/engine.ts', 'dist-test/engine.mjs'],
];

for (const [entry, outfile] of entries) {
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile,
    // 覆盖率报告要把 dist-test 里的行映射回 src/*.ts，否则只能看到打包产物。
    sourcemap: 'linked',
    external: ['@deepseek-ai/*'],
    alias: {
      '@deepseek-ai/dsh-home-paths': './scripts/_test-home-paths-stub.mjs',
      '@deepseek-ai/schemastery': './scripts/_test-schemastery-stub.mjs',
    },
    // tweetnacl 是 CJS，打进 ESM 产物后会留下 `require('crypto')`；
    // 与 scripts/build.mjs 一样注入 createRequire，否则 engine 单测一 import 就炸。
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
    logLevel: 'warning',
  });
  console.log('  ✓ ' + outfile);
}
