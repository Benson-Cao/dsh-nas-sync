import { build } from 'esbuild';

/**
 * dsh-nas-sync 打包脚本：
 *  - 宿主服务（@deepseek-ai/*）保持 external，由引擎提供；
 *  - webdav / tweetnacl / scrypt-js 全部打进单文件；
 *  - banner 注入 createRequire，修复 CJS 依赖（path-posix 等）在
 *    ESM 输出里的 "Dynamic require of util is not supported"。
 */
await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outfile: 'dist/index.js',
  external: ['@deepseek-ai/*'],
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  legalComments: 'none',
  logLevel: 'info',
});
