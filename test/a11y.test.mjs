/**
 * 0.6.0 / 收尾⑤：面板无障碍静态契约。
 *
 * 诚实边界：这是**源码级**契约，不是 axe / 读屏软件实测。它锁住的是
 * 「一旦被删掉，读屏用户立刻失去信息」的那几个属性；渲染层与焦点顺序由
 * scripts/device-e2e.mjs 在真机 WebView 里补验。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';

const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

test('面板 bundle 语法合法（改动 client.js 后不能只靠肉眼）', () => {
  assert.doesNotThrow(() => new Script(src, { filename: 'client.js' }));
});

test('异步结果进入 live region：成功 status / 失败 alert，且带 aria-live', () => {
  assert.match(src, /role: msg\.kind === 'err' \? 'alert' : 'status'/);
  assert.match(src, /'aria-live': msg\.kind === 'err' \? 'assertive' : 'polite'/);
  assert.match(src, /'data-nas-msg': msg\.kind/);
});

test('所有配置类输入框都有 aria-label，不只靠 placeholder', () => {
  const labels = [
    "'aria-label': t('cfgUrl')",
    "'aria-label': t('cfgMount')",
    "'aria-label': t('cfgRemote')",
    "'aria-label': t('cfgUser')",
    "'aria-label': t('cfgPass')",
    "'aria-label': t('cfgPassphrase')",
    "'aria-label': t('cfgCustomFolderName')",
    "'aria-label': t('cfgCustomFolderPath')",
    "'aria-label': t('recoveryIgnorePlaceholder')",
  ];
  for (const l of labels) assert.ok(src.includes(l), '缺少可访问名：' + l);
  assert.ok((src.match(/'aria-label':/g) || []).length >= labels.length);
});

test('破坏性操作：恢复按钮两步确认的状态对读屏可见', () => {
  assert.match(src, /'aria-pressed': restoreArm === e\.id/);
  assert.match(src, /'aria-label': \(restoreArm === e\.id \? t\('recoveryConfirmRestore'\)/);
  assert.match(src, /if \(restoreArm !== key\)/);
  assert.match(src, /recoveryConfirmRestore/);
  assert.match(src, /e\.restorable\s*\?\s*h\('button'/, '旧记录不能给恢复按钮');
});

test('分类 / 技能复选框由 label 包裹（隐式关联），仍有 data-* 供 E2E 定位', () => {
  assert.match(src, /h\('label'[\s\S]{0,240}h\('input', \{ type: 'checkbox', 'data-scope'/);
  assert.match(src, /'data-skill': name/);
  assert.match(src, /'data-recovery-sid': '1'/);
});

test('不引入常见反模式：正 tabIndex、把 onClick 挂在 div 上', () => {
  assert.ok(!/tabIndex:\s*[1-9]/.test(src), '不要手工打乱焦点顺序');
  assert.ok(!/h\('div'[^\n]{0,200}onClick:/.test(src), 'div 不该当按钮用');
  assert.ok(!/\.innerHTML\s*=/.test(src), '面板不许直接写 innerHTML');
});

test('中英文案都覆盖回收站 / 屏蔽入口，避免一半语言缺文案', () => {
  for (const key of [
    'recoverySection', 'recoveryHint', 'recoveryRestored', 'recoveryIgnoreAdd',
    'recoveryConfirmRestore', 'recoveryIgnorePlaceholder',
  ]) {
    const hits = (src.match(new RegExp('\\b' + key + '\\s*:', 'g')) || []).length;
    assert.ok(hits >= 2, key + ' 应同时在 zh / en 里定义（实际 ' + hits + ' 处）');
  }
});
