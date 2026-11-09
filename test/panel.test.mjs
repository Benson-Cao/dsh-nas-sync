/**
 * 面板静态契约测试（0.5.9 面板入口补齐）。
 *
 * 诚实边界：client.js 是 `window.__ModuleLoader__.load` 的手写模块，需要宿主的
 * React / DOM / 注入 token 才能真渲染，这里**没有**挂载 React，也不是 E2E。
 * 这组用例只锁一层最容易静默回归的契约：新 UI 必须真的接上 0.5.9 的三个
 * HTTP 端点、必须带二次确认、必须把 safety 状态呈现出来、旧 host 上必须隐藏。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'client.js'), 'utf8');

test('client.js 语法合法', () => {
  execFileSync(process.execPath, ['--check', join(root, 'client.js')], { stdio: 'pipe' });
});

test('回收站 / 屏蔽面板接上了 0.5.9 的三个端点', () => {
  assert.match(src, /c\.call\('\/removed'\)/, '缺少 GET /removed');
  assert.match(src, /c\.call\('\/ignored'\)/, '缺少 GET /ignored');
  assert.match(src, /c\.call\('\/removed\/restore'/, '缺少 POST /removed/restore');
  assert.match(src, /action: 'add'/, '缺少添加屏蔽');
  assert.match(src, /action: 'remove'/, '缺少撤销屏蔽');
});

test('中英文案都有回收站条目', () => {
  assert.match(src, /recoverySection: '回收站与本机屏蔽'/);
  assert.match(src, /recoverySection: 'Removed & local ignores'/);
  assert.match(src, /recoveryConfirmRestore: '再点一次确认'/);
  assert.match(src, /recoveryConfirmRestore: 'Click again to confirm'/);
});

test('恢复需二次确认，且 legacy / 无元数据记录不给恢复按钮', () => {
  assert.match(src, /restoreArm !== key/, '缺少两步确认守卫');
  assert.match(src, /e\.restorable\s*\?\s*h\('button'/, 'restorable=false 仍渲染了恢复按钮');
  assert.match(src, /t\('recoveryLegacy'\)/, '缺少「仅手工」提示');
});

test('/status 的 safety 被呈现，而不是只存在后端', () => {
  assert.match(src, /safety && safety\.destructiveBlocked/, '缺少 fail-closed 警告');
  assert.match(src, /manifestTrustFailed/, '缺少清单不可信警告');
  assert.match(src, /ignored && ignored\.error/, '缺少屏蔽清单错误呈现');
});

test('旧版 host 没有这些端点时整张卡片隐藏', () => {
  assert.match(src, /if \(!removed && !ignored && !safety\) return null/);
});
