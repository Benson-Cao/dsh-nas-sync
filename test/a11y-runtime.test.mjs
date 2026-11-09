/**
 * a11y-runtime 的运行时单元测试（0.6.0 / G8-G9）
 * ------------------------------------------------
 * 覆盖 7 条规则各自的正例与反例、WCAG 对比度已知值、sRGB 伽马校正、
 * 假阳性防护（clean 快照必须 0 违规）、纯函数确定性，以及 CLI 端到端出报告。
 *
 * 只跑本文件即可，不需要 dist-test/，也不依赖任何 npm 依赖：
 *   node --test test/a11y-runtime.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RULES, SEVERITIES, DEMO_SNAPSHOT,
  parseColor, relativeLuminance, contrastRatio, fontSizePx, isBold,
  accessibleName, isInteractive, isFocusable, flattenNodes,
  scan, runSelfCheck,
} from '../scripts/a11y-runtime.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/a11y-runtime.mjs', import.meta.url));
const ratio = (fg, bg) => contrastRatio(parseColor(fg), parseColor(bg));
const rulesOf = (report) => report.violations.map((v) => v.rule);
const has = (report, rule) => report.violations.some((v) => v.rule === rule);
const snap = (...nodes) => ({ nodes });

// ---------------------------------------------------------------------------
// 元数据 / 颜色基础
// ---------------------------------------------------------------------------
test('规则表恰好 7 条，严重级取值受控', () => {
  assert.equal(Object.keys(RULES).length, 7);
  assert.deepEqual(Object.keys(RULES), ['A11Y-01', 'A11Y-02', 'A11Y-03', 'A11Y-04', 'A11Y-05', 'A11Y-06', 'A11Y-07']);
  for (const r of Object.values(RULES)) assert.ok(SEVERITIES.includes(r.severity));
});

test('parseColor 支持 3/4/6/8 位 hex、rgb()/rgba()、具名色；非法输入返回 null', () => {
  assert.deepEqual(parseColor('#fff'), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseColor('#000000'), { r: 0, g: 0, b: 0, a: 1 });
  assert.deepEqual(parseColor('#777'), { r: 119, g: 119, b: 119, a: 1 });
  assert.equal(parseColor('#1f6feb').b, 235);
  assert.equal(parseColor('#00000080').a, 128 / 255);
  assert.deepEqual(parseColor('rgb(0, 0, 255)'), { r: 0, g: 0, b: 255, a: 1 });
  assert.equal(parseColor('rgba(0,0,0,0.5)').a, 0.5);
  assert.equal(parseColor('rgba(100%, 0%, 0%, 50%)').r, 255);
  assert.equal(parseColor('white').r, 255);
  assert.equal(parseColor('transparent'), null);
  assert.equal(parseColor('currentcolor'), null);
  assert.equal(parseColor('hsl(0,0%,0%)'), null);
  assert.equal(parseColor(undefined), null);
});

test('relativeLuminance：黑=0、白=1', () => {
  assert.equal(relativeLuminance(parseColor('#000000')), 0);
  assert.equal(relativeLuminance(parseColor('#ffffff')), 1);
});

test('sRGB 伽马校正确实生效：#777 亮度约 0.1845，而非线性的 0.4667', () => {
  const lum = relativeLuminance(parseColor('#777777'));
  assert.ok(Math.abs(lum - 0.1845) < 0.002, '实际 ' + lum);
  assert.ok(lum < 0.25, '必须明显低于未做伽马校正的 0.4667');
});

test('对比度已知值：黑底白字 21:1，且与前后景顺序无关', () => {
  assert.ok(Math.abs(ratio('#000000', '#ffffff') - 21) < 1e-9);
  assert.ok(Math.abs(ratio('#ffffff', '#000000') - 21) < 1e-9);
});

test('对比度已知值：#777 对白 4.48:1（低于 4.5 门槛）', () => {
  const r = ratio('#777777', '#ffffff');
  assert.equal(r.toFixed(2), '4.48');
  assert.ok(r < 4.5);
});

test('fontSizePx / isBold：px、pt、rem、纯数字与粗体判定', () => {
  assert.equal(fontSizePx({ fontSize: '16px' }), 16);
  assert.equal(fontSizePx({ fontSize: 16 }), 16);
  assert.ok(Math.abs(fontSizePx({ fontSize: '18pt' }) - 24) < 1e-9); // 18pt = 24px
  assert.equal(fontSizePx({ fontSize: '1.5rem' }), 24);
  assert.equal(fontSizePx({}), null);
  assert.equal(isBold({ fontWeight: 700 }), true);
  assert.equal(isBold({ fontWeight: 'bold' }), true);
  assert.equal(isBold({ fontWeight: '600' }), false);
  assert.equal(isBold({}), false);
});

// ---------------------------------------------------------------------------
// A11Y-01 交互元素可访问名
// ---------------------------------------------------------------------------
test('A11Y-01 反例：无名的 button 报违规', () => {
  const r = scan(snap({ id: 'b', tag: 'button' }));
  assert.ok(has(r, 'A11Y-01'));
  assert.equal(r.violations[0].severity, 'critical');
});

test('A11Y-01 正例：aria-label / 文本 / label / aria-labelledby / title / value 均可作为名', () => {
  const cases = [
    { id: 'a', tag: 'button', ariaLabel: '保存' },
    { id: 'b', tag: 'button', text: '保存' },
    { id: 'c', tag: 'button', label: { text: '保存' } },
    { id: 'd', tag: 'button', title: '保存' },
    { id: 'e', tag: 'input', attributes: { type: 'submit' }, value: '提交' },
  ];
  const withLabelledBy = [
    { id: 'lbl', tag: 'span', text: '目标地址' },
    { id: 'f', tag: 'button', ariaLabelledBy: 'lbl' },
  ];
  for (const n of cases) {
    const r = scan(snap(n));
    assert.equal(r.summary.violations, 0, '不应违规：' + n.id + ' → ' + JSON.stringify(rulesOf(r)));
  }
  const r2 = scan(snap(...withLabelledBy));
  assert.equal(r2.summary.violations, 0, JSON.stringify(rulesOf(r2)));
});

test('accessibleName 优先级：aria-label 覆盖 text，aria-labelledby 可解析引用', () => {
  assert.deepEqual(accessibleName({ ariaLabel: '甲', text: '乙' }, new Map()), { name: '甲', source: 'aria-label' });
  const byId = new Map([['x', { text: '引用文本' }]]);
  assert.deepEqual(accessibleName({ ariaLabelledBy: 'x' }, byId), { name: '引用文本', source: 'aria-labelledby' });
  assert.equal(accessibleName({ tag: 'button' }, new Map()).name, '');
});

test('A11Y-01 假阳性防护：input[type=hidden] 不是交互元素，不要求可访问名', () => {
  const r = scan(snap({ id: 'h', tag: 'input', attributes: { type: 'hidden' } }));
  assert.equal(r.summary.violations, 0, JSON.stringify(rulesOf(r)));
  assert.equal(isInteractive({ tag: 'input', attributes: { type: 'hidden' }, role: '', interactive: undefined, tabIndex: null }), false);
});

// ---------------------------------------------------------------------------
// A11Y-02 live region
// ---------------------------------------------------------------------------
test('A11Y-02 反例：role=alert / role=status 缺 aria-live 各报一条', () => {
  const r = scan(snap(
    { id: 'a', tag: 'div', role: 'alert', text: '失败' },
    { id: 's', tag: 'div', role: 'status', text: '完成' },
  ));
  assert.equal(r.violations.filter((v) => v.rule === 'A11Y-02').length, 2);
});

test('A11Y-02 反例：aria-live=off 等同于关闭，也要报', () => {
  const r = scan(snap({ id: 'a', tag: 'div', role: 'alert', text: 'x', attributes: { 'aria-live': 'off' } }));
  assert.ok(has(r, 'A11Y-02'));
});

test('A11Y-02 正例：polite / assertive 均通过，普通 div 不受约束', () => {
  const r = scan(snap(
    { id: 'a', tag: 'div', role: 'alert', text: 'x', attributes: { 'aria-live': 'assertive' } },
    { id: 's', tag: 'div', role: 'status', text: 'x', attributes: { 'aria-live': 'polite' } },
    { id: 'p', tag: 'div', text: '普通文本' },
  ));
  assert.equal(r.summary.violations, 0, JSON.stringify(rulesOf(r)));
});

// ---------------------------------------------------------------------------
// A11Y-03 正 tabIndex
// ---------------------------------------------------------------------------
test('A11Y-03 反例：tabIndex=3（以及字符串 "5"）报违规', () => {
  const r = scan(snap(
    { id: 'a', tag: 'button', text: 'A', tabIndex: 3 },
    { id: 'b', tag: 'button', text: 'B', attributes: { tabindex: '5' } },
  ));
  assert.equal(r.violations.filter((v) => v.rule === 'A11Y-03').length, 2);
  assert.equal(r.violations.find((v) => v.rule === 'A11Y-03').detail.tabIndex, 3);
});

test('A11Y-03 正例：0 / -1 / 未设置 都不报', () => {
  const r = scan(snap(
    { id: 'a', tag: 'button', text: 'A', tabIndex: 0 },
    { id: 'b', tag: 'button', text: 'B', tabIndex: -1 },
    { id: 'c', tag: 'button', text: 'C' },
    { id: 'd', tag: 'button', text: 'D', attributes: { tabindex: '-1' } },
  ));
  assert.equal(r.summary.violations, 0, JSON.stringify(rulesOf(r)));
});

// ---------------------------------------------------------------------------
// A11Y-04 图片 alt
// ---------------------------------------------------------------------------
test('A11Y-04 反例：img 与 input[type=image] 缺 alt 报违规', () => {
  const r = scan(snap(
    { id: 'i1', tag: 'img' },
    { id: 'i2', tag: 'div', role: 'img' },
    { id: 'i3', tag: 'input', attributes: { type: 'image' }, value: 'go' },
  ));
  assert.equal(r.violations.filter((v) => v.rule === 'A11Y-04').length, 3);
});

test('A11Y-04 正例：alt="" 是合法的装饰图，alt 非空也通过', () => {
  const r = scan(snap(
    { id: 'd', tag: 'img', alt: '' },
    { id: 'l', tag: 'img', alt: 'NAS 图标' },
  ));
  assert.equal(r.summary.violations, 0, JSON.stringify(rulesOf(r)));
});

// ---------------------------------------------------------------------------
// A11Y-05 颜色对比度
// ---------------------------------------------------------------------------
test('A11Y-05 反例：#777 对白 4.48:1 报违规，且 expected/actual/severity 齐全', () => {
  const r = scan(snap({ id: 'p', tag: 'p', text: '灰色说明',
    style: { color: '#777777', backgroundColor: '#ffffff', fontSize: '16px' } }));
  const v = r.violations.find((x) => x.rule === 'A11Y-05');
  assert.ok(v, '必须命中 A11Y-05');
  assert.equal(v.severity, 'serious');
  assert.match(v.expected, /4\.5:1/);
  assert.match(v.actual, /4\.48:1/);
  assert.equal(v.detail.threshold, 4.5);
  assert.equal(v.detail.ratio, 4.48);
});

test('A11Y-05 正例：黑底白字 21:1 不报；黑字白底同样通过', () => {
  const r = scan(snap(
    { id: 'a', tag: 'p', text: 'A', style: { color: '#ffffff', backgroundColor: '#000000', fontSize: '16px' } },
    { id: 'b', tag: 'p', text: 'B', style: { color: '#000000', backgroundColor: '#ffffff', fontSize: '16px' } },
  ));
  assert.equal(r.summary.violations, 0, JSON.stringify(rulesOf(r)));
  assert.equal(r.summary.contrastChecked, 2);
});

test('A11Y-05 大字阈值 3:1：24px 或粗体 19px 下 #777 对白不报违规', () => {
  const r = scan(snap(
    { id: 'big', tag: 'p', text: '大标题',
      style: { color: '#777777', backgroundColor: '#ffffff', fontSize: '24px' } },
    { id: 'bold', tag: 'p', text: '粗体标题',
      style: { color: '#777777', backgroundColor: '#ffffff', fontSize: '19px', fontWeight: 'bold' } },
  ));
  assert.equal(r.summary.violations, 0, JSON.stringify(rulesOf(r)));
  assert.equal(r.summary.contrastChecked, 2);
});

test('A11Y-05 假阳性防护：缺颜色 / 背景半透明 / 无文本 一律跳过而不报违规', () => {
  const r = scan(snap(
    { id: 'a', tag: 'p', text: '没给颜色' },
    { id: 'b', tag: 'p', text: '半透明背景', style: { color: '#000000', backgroundColor: 'rgba(255,255,255,0.5)' } },
    { id: 'c', tag: 'div', style: { color: '#777777', backgroundColor: '#ffffff' } },
    { id: 'd', tag: 'p', text: '颜色非法', style: { color: 'not-a-color', backgroundColor: '#ffffff' } },
  ));
  assert.equal(r.summary.violations, 0, JSON.stringify(rulesOf(r)));
  assert.equal(r.summary.contrastChecked, 0);
});

test('A11Y-05 半透明前景按 alpha 合成到不透明背景后再判定（rgba(0,0,0,.5) 对白约 3.98:1 → 违规）', () => {
  const r = scan(snap({ id: 'p', tag: 'p', text: '半透明黑字',
    style: { color: 'rgba(0,0,0,0.5)', backgroundColor: '#ffffff', fontSize: '16px' } }));
  assert.ok(has(r, 'A11Y-05'));
  assert.ok(r.violations[0].detail.ratio > 3.9 && r.violations[0].detail.ratio < 4.1);
});

// ---------------------------------------------------------------------------
// A11Y-06 表单控件可见 label
// ---------------------------------------------------------------------------
test('A11Y-06 反例：只有 aria-label、label 文本为空、label 不可见、label 未关联 都报违规', () => {
  const r = scan(snap(
    { id: 'a', tag: 'input', ariaLabel: '地址' },
    { id: 'b', tag: 'input', label: { text: '', forMatches: true, visible: true } },
    { id: 'c', tag: 'input', label: { text: '备注', forMatches: true, visible: false } },
    { id: 'd', tag: 'select', ariaLabel: '选项', label: { text: '选项', visible: true } },
    { id: 'e', tag: 'textarea', ariaLabel: '备注' },
  ));
  assert.equal(r.violations.filter((v) => v.rule === 'A11Y-06').length, 5, JSON.stringify(rulesOf(r)));
});

test('A11Y-06 正例：label[for] 关联 / label 包裹 / hidden 与 submit 免检', () => {
  const r = scan(snap(
    { id: 'a', tag: 'input', label: { text: 'WebDAV 地址', forMatches: true, visible: true } },
    { id: 'b', tag: 'input', attributes: { type: 'checkbox' }, label: { text: '自动同步', wrapsControl: true, visible: true } },
    { id: 'c', tag: 'input', attributes: { type: 'hidden' } },
    { id: 'd', tag: 'input', attributes: { type: 'submit' }, value: '提交' },
  ));
  assert.equal(r.summary.violations, 0, JSON.stringify(rulesOf(r)));
});

// ---------------------------------------------------------------------------
// A11Y-07 焦点顺序不含隐藏元素
// ---------------------------------------------------------------------------
test('A11Y-07 反例：display:none 仍可聚焦、aria-hidden=true 仍可聚焦 各报违规', () => {
  const r = scan(snap(
    { id: 'a', tag: 'button', text: 'A', focusable: true, style: { display: 'none' } },
    { id: 'b', tag: 'button', text: 'B', focusable: true, attributes: { 'aria-hidden': 'true' } },
  ));
  assert.equal(r.violations.filter((v) => v.rule === 'A11Y-07').length, 2, JSON.stringify(rulesOf(r)));
});

test('A11Y-07 反例：祖先被隐藏，children 里的可聚焦按钮继承 hidden 后报违规', () => {
  const r = scan(snap({
    id: 'wrap', tag: 'div', style: { display: 'none' },
    children: [{ id: 'inner', tag: 'button', text: '隐藏按钮', focusable: true }],
  }));
  assert.ok(has(r, 'A11Y-07'));
  const flat = flattenNodes([{ id: 'wrap', tag: 'div', style: { display: 'none' },
    children: [{ id: 'inner', tag: 'button', text: 'x', focusable: true }] }]);
  assert.equal(flat.find((n) => n.id === 'inner').ancestorHidden, true);
});

test('A11Y-07 正例：隐藏但显式 focusable=false 且无正 tabindex 的元素不在焦点序，不报', () => {
  const r = scan(snap({ id: 'a', tag: 'button', text: 'A', hidden: true, focusable: false }));
  assert.equal(r.summary.violations, 0, JSON.stringify(rulesOf(r)));
  assert.deepEqual(r.focusOrder, []);
  assert.equal(isFocusable({ disabled: false, focusable: false, interactive: undefined, tabIndex: null }, true), false);
});

test('焦点顺序按 order 升序输出，且不含隐藏元素（正常面板 0 违规）', () => {
  const r = scan(snap(
    { id: 'A', tag: 'button', text: 'A', order: 5 },
    { id: 'B', tag: 'button', text: 'B', order: 1 },
    { id: 'C', tag: 'button', text: 'C', order: 3 },
    { id: 'H', tag: 'button', text: 'H', order: 2, hidden: true, focusable: false },
  ));
  assert.equal(r.summary.violations, 0, JSON.stringify(rulesOf(r)));
  assert.deepEqual(r.focusOrder, ['B', 'C', 'A']);
});

// ---------------------------------------------------------------------------
// 综合：假阳性防护 / 纯函数 / 报告结构 / 输入校验
// ---------------------------------------------------------------------------
test('假阳性防护：内置 clean 面板 0 违规、passed=true、7 条规则计数全 0', () => {
  const r = scan(DEMO_SNAPSHOT);
  assert.equal(r.summary.violations, 0, JSON.stringify(r.violations));
  assert.equal(r.summary.passed, true);
  assert.ok(Object.values(r.summary.byRule).every((n) => n === 0));
  assert.equal(r.summary.interactive, 3);
  assert.equal(r.summary.focusOrderLength, 3);
});

test('纯函数确定性：同一输入两次 scan 深度相等，且不修改入参', () => {
  const input = snap(
    { id: 'a', tag: 'button' },
    { id: 'b', tag: 'img' },
    { id: 'c', tag: 'p', text: 'x', style: { color: '#777', backgroundColor: '#fff', fontSize: '16px' } },
  );
  const before = JSON.stringify(input);
  const r1 = scan(input);
  const r2 = scan(input);
  assert.deepStrictEqual(r1, r2);
  assert.equal(JSON.stringify(input), before, 'scan 不得改入参');
  assert.equal(r1.violations.length, 3);
});

test('违规结构完整：rule / ruleName / wcag / severity / element / expected / actual / detail 全有', () => {
  const r = scan(snap({ id: 'bad', tag: 'button' }));
  const v = r.violations[0];
  for (const k of ['rule', 'ruleName', 'wcag', 'severity', 'element', 'expected', 'actual', 'detail']) {
    assert.ok(k in v, '缺字段 ' + k);
  }
  assert.equal(v.element, 'bad');
  assert.equal(v.rule, 'A11Y-01');
});

test('输入校验：nodes 非数组 / snapshot 为 null 时 inputValid=false 且不误报违规', () => {
  const a = scan({ nodes: 'oops' });
  const b = scan(null);
  for (const r of [a, b]) {
    assert.equal(r.inputValid, false);
    assert.ok(r.inputErrors.length > 0);
    assert.equal(r.violations.length, 0);
    assert.equal(r.summary.passed, false);
  }
});

test('runSelfCheck：clean 快照 0 违规，7 个破坏性用例全部命中目标规则', () => {
  const sc = runSelfCheck();
  assert.equal(sc.cleanViolations, 0);
  assert.equal(sc.cleanPassed, true);
  assert.equal(sc.cases.length, 7);
  assert.ok(sc.cases.every((c) => c.ok), JSON.stringify(sc.cases));
  assert.equal(sc.allMatched, true);
});

// ---------------------------------------------------------------------------
// CLI 端到端：确实能出 reports/*.json
// ---------------------------------------------------------------------------
function runCli(snapshot, extraArgs) {
  const dir = mkdtempSync(join(tmpdir(), 'a11y-rt-'));
  try {
    const inputPath = join(dir, 'snap.json');
    const outPath = join(dir, 'report.json');
    const args = [SCRIPT, '--out=' + outPath];
    if (snapshot !== undefined) {
      writeFileSync(inputPath, JSON.stringify(snapshot), 'utf8');
      args.push(inputPath);
    }
    if (extraArgs) args.push(...extraArgs);
    const run = spawnSync(process.execPath, args, { encoding: 'utf8' });
    const report = readFileSync(outPath, 'utf8');
    return { status: run.status, stdout: run.stdout, stderr: run.stderr, json: JSON.parse(report) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('CLI：无参数自检模式写报告（mode=self-check、0 违规、退出码 0）', () => {
  const r = runCli(undefined);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.mode, 'self-check');
  assert.equal(r.json.summary.violations, 0);
  assert.equal(r.json.selfCheck.allMatched, true);
});

test('CLI：违规快照写报告且退出码 1；--no-gate 后退出码 0', () => {
  const bad = snap({ id: 'b', tag: 'button' });
  const r1 = runCli(bad);
  assert.equal(r1.status, 1);
  assert.ok(r1.json.violations.some((v) => v.rule === 'A11Y-01'));
  const r2 = runCli(bad, ['--no-gate']);
  assert.equal(r2.status, 0);
  assert.equal(r2.json.summary.violations, 1);
});

test('CLI：输入文件不存在时优雅 skipped，不抛未捕获异常、退出码 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a11y-rt-skip-'));
  try {
    const outPath = join(dir, 'report.json');
    const run = spawnSync(process.execPath, [SCRIPT, join(dir, 'no-such.json'), '--out=' + outPath], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, '');
    const j = JSON.parse(readFileSync(outPath, 'utf8'));
    assert.equal(j.status, 'skipped');
    assert.equal(j.violations.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
