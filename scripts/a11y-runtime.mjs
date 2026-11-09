/**
 * a11y-runtime.mjs —— 零依赖运行时无障碍扫描器（0.6.0 / 审查报告 G8-G9）
 * ============================================================================
 * 定位：把 0.5.8 之前只有「静态文本契约」(test/a11y.test.mjs) 的无障碍检查，
 * 补成「吃 DOM 快照 → 出结构化报告」的可判定子集实现。它不是 axe，也不替代
 * 读屏软件实测；它覆盖的是 WCAG 2.1 AA 里**可以纯函数判定**的 7 条规则。
 *
 * 诚实边界（务必读）：
 *   - 规则 A11Y-02「role=alert|status 必须显式 aria-live」比规范更严：ARIA 里
 *     role=alert 隐含 aria-live=assertive、role=status 隐含 polite。本规则是对齐
 *     项目既有静态契约（test/a11y.test.mjs）的**加严项**，不是 WCAG 字面要求。
 *   - 规则 A11Y-06「表单控件必须有关联的可见 label」同样是加严项：aria-label
 *     能满足规则 A11Y-01（可访问名），但**不**满足本规则（可见标签）。刻意分开。
 *   - 对比度只判「快照里同时给出前景色与不透明背景色且有文本」的节点；拿不到
 *     颜色/背景透明的节点一律 skip 而不是报违规，避免假阳性。
 *   - 规则 A11Y-07 判的是「隐藏元素仍留在焦点顺序里」这一**配置错误**（例如
 *     display:none 的元素还带 tabindex=0、aria-hidden=true 的按钮仍可聚焦、
 *     祖先被隐藏而子孙仍被标记 focusable）。真实浏览器里 display:none 元素本就
 *     不可聚焦，所以快照必须用 focusable / tabIndex 如实反映"它还在 tab 序里"。
 *
 * ---------------------------------------------------------------------------
 * 【输入：DOM 快照 JSON 结构 v1】—— 由 scripts/a11y-device.mjs 抓真机生成，
 *   也可人工/测试构造。字段全部可选（缺失即按安全默认值处理，不报违规）。
 *
 * {
 *   "meta": { "selector": "#nas-sync", "source": "cdp", ... },  // 仅透传，不参与判定
 *   "nodes": [                       // 必填：数组，深度优先顺序
 *     {
 *       "id": "btn-save",           // 唯一标识；缺失自动补 node-<下标>，报告里当"元素"
 *       "tag": "button",            // 小写标签名，默认 "div"
 *       "role": "button",           // 显式 role（也可放 attributes.role）
 *       "interactive": true,        // 强制标记交互元素；显式 false 可免除 A11Y-01
 *       "focusable": true,          // 强制标记可聚焦；显式 false 可移出焦点顺序
 *       "hidden": false,            // 元素自身被隐藏
 *       "ancestorHidden": false,    // 祖先链有隐藏元素（children 会自动继承）
 *       "disabled": false,
 *       "order": 2,                 // DOM 顺序，用于生成焦点顺序；默认按数组下标
 *       "text": "保存",             // 可见文本（已扁平，不含子节点的重复文本）
 *       "ariaLabel": "",            // 也可 attributes["aria-label"]
 *       "ariaLabelledBy": "",       // 也可 attributes["aria-labelledby"]，空格分隔 id
 *       "labelledByText": "",       // 离线快照里预先解析好的 aria-labelledby 目标文本
 *       "value": "",                // input 的 value（submit/button 类按钮的可见名）
 *       "title": "",                // title 属性
 *       "alt": "",                  // img 的 alt；空串=装饰图=合法；**字段缺失**=违规
 *       "label": {                  // 关联 label（A11Y-06 用）
 *         "text": "WebDAV 地址",
 *         "forMatches": true,       // label[for] === 控件 id
 *         "wrapsControl": false,    // 控件被 <label> 包裹（隐式关联）
 *         "visible": true           // 默认 true
 *       },
 *       "tabIndex": 0,              // 解析后的数字（也可 attributes["tabindex"]）；
 *                                   // null/缺失=未设置，正数触发 A11Y-03
 *       "attributes": {             // 原始属性，键小写；与上面的顶层字段互补，
 *         "aria-live": "polite",    // 顶层字段优先
 *         "type": "checkbox",
 *         "aria-hidden": "false",
 *         "hidden": "",
 *         "tabindex": "-1"
 *       },
 *       "style": {                  // 计算样式（只需这几项）
 *         "color": "#ffffff",
 *         "backgroundColor": "#1f6feb",
 *         "fontSize": "16px",       // 支持 px / pt / rem / em（根字号按 16px）/ 纯数字
 *         "fontWeight": "600",      // 数字或 bold/normal
 *         "display": "block",
 *         "visibility": "visible"
 *       },
 *       "children": [ ...同结构，可嵌套；scanner 会先扁平化并继承 hidden... ]
 *     }
 *   ]
 * }
 *
 * ---------------------------------------------------------------------------
 * 【规则表】
 *   A11Y-01 交互元素必须有可访问名        WCAG 4.1.2 / 2.4.6      critical
 *   A11Y-02 role=alert|status 有 aria-live WCAG 4.1.3（项目加严） serious
 *   A11Y-03 不得使用正 tabIndex           WCAG 2.4.3              serious
 *   A11Y-04 图片必须有 alt 属性           WCAG 1.1.1              serious
 *   A11Y-05 文本颜色对比度达标            WCAG 1.4.3              serious
 *   A11Y-06 表单控件有可见 label          WCAG 1.3.1/3.3.2（加严） serious
 *   A11Y-07 焦点顺序不含被隐藏元素        WCAG 2.4.3 / 4.1.2      critical
 *
 * ---------------------------------------------------------------------------
 * 【用法】
 *   node scripts/a11y-runtime.mjs                         # 内置自检快照 → reports/a11y-runtime.json
 *   node scripts/a11y-runtime.mjs reports/a11y-snapshot.json
 *   node scripts/a11y-runtime.mjs --stdin < snap.json
 *   node scripts/a11y-runtime.mjs snap.json --out=reports/x.json --no-gate
 *
 *   退出码：0=无违规/已跳过/--no-gate；1=有违规；2=输入 JSON 解析失败。
 *   报告**不含时间戳**，保证同一输入可重复、可 diff；scan() 是确定性纯函数。
 *
 * 【纯函数保证】scan(snapshot) 不读时间、不读随机数、不做 I/O、不改入参；
 *   相同输入恒得相同报告。I/O 只在 main() 里，且仅在直接执行本文件时运行。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// 规则元数据（固定顺序，保证违规列表确定性）
// ---------------------------------------------------------------------------
export const RULES = Object.freeze({
  'A11Y-01': { name: '交互元素必须有可访问名', wcag: '4.1.2 Name, Role, Value (A) / 2.4.6 Headings and Labels (AA)', severity: 'critical' },
  'A11Y-02': { name: 'role=alert|status 必须显式声明 aria-live', wcag: '4.1.3 Status Messages (AA)，项目级加严', severity: 'serious' },
  'A11Y-03': { name: '不得使用正 tabIndex', wcag: '2.4.3 Focus Order (A)', severity: 'serious' },
  'A11Y-04': { name: '图片必须有 alt 属性', wcag: '1.1.1 Non-text Content (A)', severity: 'serious' },
  'A11Y-05': { name: '文本颜色对比度达标', wcag: '1.4.3 Contrast (Minimum) (AA)', severity: 'serious' },
  'A11Y-06': { name: '表单控件必须有关联的可见 label', wcag: '1.3.1 / 3.3.2 / 4.1.2，项目级加严', severity: 'serious' },
  'A11Y-07': { name: '焦点顺序不得包含被隐藏元素', wcag: '2.4.3 Focus Order (A) / 4.1.2', severity: 'critical' },
});

export const SEVERITIES = Object.freeze(['critical', 'serious', 'moderate', 'minor']);

const INTERACTIVE_TAGS = new Set(['button', 'input', 'select', 'textarea', 'summary']);
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'switch', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'tab', 'combobox', 'listbox', 'option', 'slider', 'spinbutton',
  'textbox', 'searchbox', 'treeitem', 'gridcell',
]);
const FORM_CONTROL_TYPES_SKIP = new Set(['hidden', 'submit', 'reset', 'button', 'image']);

// ---------------------------------------------------------------------------
// 颜色 / 对比度：WCAG 2.1 相对亮度 + sRGB 伽马校正
// ---------------------------------------------------------------------------
const NAMED_COLORS = Object.freeze({
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000',
  blue: '#0000ff', gray: '#808080', grey: '#808080', silver: '#c0c0c0',
  yellow: '#ffff00', orange: '#ffa500',
});

/**
 * 解析 CSS 颜色字符串 → { r, g, b, a }（通道 0..255，a 0..1）；无法解析返回 null。
 * 支持 #rgb / #rgba / #rrggbb / #rrggbbaa / rgb() / rgba() / 少量具名色。
 * transparent / currentcolor / inherit / 未知格式一律返回 null（由调用方 skip）。
 */
export function parseColor(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim().toLowerCase();
  if (!s) return null;
  if (NAMED_COLORS[s]) s = NAMED_COLORS[s];
  if (s === 'transparent' || s === 'currentcolor' || s === 'inherit' || s === 'initial' || s === 'unset') return null;

  const clamp255 = (v) => Math.min(255, Math.max(0, v));
  const clampA = (v) => Math.min(1, Math.max(0, v));

  if (s[0] === '#') {
    const hex = s.slice(1);
    if (!/^[0-9a-f]+$/.test(hex)) return null;
    if (hex.length === 3 || hex.length === 4) {
      const r = parseInt(hex[0] + hex[0], 16);
      const g = parseInt(hex[1] + hex[1], 16);
      const b = parseInt(hex[2] + hex[2], 16);
      const a = hex.length === 4 ? parseInt(hex[3] + hex[3], 16) / 255 : 1;
      return { r, g, b, a: clampA(a) };
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
      return { r: clamp255(r), g: clamp255(g), b: clamp255(b), a: clampA(a) };
    }
    return null;
  }

  const m = /^rgba?\(([^)]*)\)$/.exec(s);
  if (m) {
    const parts = m[1].split(',').map((x) => x.trim()).filter(Boolean);
    if (parts.length < 3) return null;
    const ch = (v) => {
      const n = Number.parseFloat(v);
      if (!Number.isFinite(n)) return null;
      return v.endsWith('%') ? (n / 100) * 255 : n;
    };
    const r = ch(parts[0]);
    const g = ch(parts[1]);
    const b = ch(parts[2]);
    if (r === null || g === null || b === null) return null;
    let a = 1;
    if (parts.length >= 4) {
      const av = parts[3];
      const an = Number.parseFloat(av);
      if (!Number.isFinite(an)) return null;
      a = av.endsWith('%') ? an / 100 : an;
    }
    return { r: clamp255(r), g: clamp255(g), b: clamp255(b), a: clampA(a) };
  }
  return null;
}

/** sRGB 单通道伽马校正（WCAG 2.1 用 0.03928 阈值；0.04045 为 sRGB 修订值，二者结果等价到小数点后多位）。 */
function linearize(channel) {
  const cs = channel / 255;
  return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
}

/** WCAG 相对亮度 L ∈ [0,1]。 */
export function relativeLuminance(color) {
  return 0.2126 * linearize(color.r) + 0.7152 * linearize(color.g) + 0.0722 * linearize(color.b);
}

/** 把半透明前景合成到不透明背景上（背景半透明则返回 null，交给调用方 skip）。 */
function compositeOver(fg, bg) {
  if (bg.a < 1) return null;
  const a = fg.a;
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
    a: 1,
  };
}

/** WCAG 对比度比值 ∈ [1,21]，与前后景顺序无关。 */
export function contrastRatio(fg, bg) {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** 字号 → px；pt 按 96/72 换算，rem/em 按根字号 16px 约定。无法解析返回 null。 */
export function fontSizePx(style) {
  const v = style && style.fontSize;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string') return null;
  const m = /^\s*([+-]?[\d.]+)\s*(px|pt|rem|em)?\s*$/i.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  const unit = (m[2] || 'px').toLowerCase();
  if (unit === 'pt') return n * (96 / 72);
  if (unit === 'rem' || unit === 'em') return n * 16;
  return n;
}

/** 是否粗体：数字 >= 700 或 bold/bolder。 */
export function isBold(style) {
  const w = style && style.fontWeight;
  if (typeof w === 'number') return w >= 700;
  if (typeof w !== 'string') return false;
  const s = w.trim().toLowerCase();
  if (s === 'bold' || s === 'bolder') return true;
  if (s === 'normal' || s === 'lighter') return false;
  const n = Number(s);
  return Number.isFinite(n) && n >= 700;
}

/**
 * WCAG「大字」定义：>= 24px，或 >= 18.66px(14pt) 且粗体。
 * 大字阈值 3:1，普通文本 4.5:1。字号缺失时按 16px 普通文本处理（安全侧）。
 */
function largeTextInfo(style) {
  const px = fontSizePx(style);
  const bold = isBold(style);
  const effective = px === null ? 16 : px;
  const large = effective >= 24 || (bold && effective >= 18.66);
  return { px: effective, bold, large, threshold: large ? 3 : 4.5 };
}

// ---------------------------------------------------------------------------
// 快照归一化 / 扁平化
// ---------------------------------------------------------------------------
function str(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

function parseTabIndex(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function normalizeLabel(l) {
  if (!l || typeof l !== 'object' || Array.isArray(l)) return null;
  return {
    text: str(l.text),
    forMatches: l.forMatches === true,
    wrapsControl: l.wrapsControl === true,
    visible: l.visible !== false,
  };
}

function normalizeNode(raw, index, inheritedHidden) {
  const n = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const attributes = n.attributes && typeof n.attributes === 'object' && !Array.isArray(n.attributes)
    ? n.attributes : {};
  const get = (top, key) => (n[top] !== undefined ? n[top] : attributes[key]);
  const tag = str(get('tag', 'tag')).toLowerCase() || 'div';

  return {
    id: str(get('id', 'id')) || ('node-' + index),
    tag,
    role: str(get('role', 'role')).toLowerCase(),
    interactive: typeof n.interactive === 'boolean' ? n.interactive : undefined,
    focusable: typeof n.focusable === 'boolean' ? n.focusable : undefined,
    disabled: n.disabled === true || attributes.disabled === true || attributes.disabled === '' || attributes.disabled === 'disabled',
    hidden: n.hidden === true || attributes.hidden === true || attributes.hidden === '' || attributes.hidden === 'hidden',
    ancestorHidden: inheritedHidden === true || n.ancestorHidden === true,
    order: Number.isFinite(n.order) ? n.order : index,
    text: typeof n.text === 'string' ? n.text : '',
    ariaLabel: str(get('ariaLabel', 'aria-label')),
    ariaLabelledBy: str(get('ariaLabelledBy', 'aria-labelledby')),
    labelledByText: str(n.labelledByText),
    value: str(get('value', 'value')),
    title: str(get('title', 'title')),
    alt: get('alt', 'alt'), // 保留 undefined，用于区分「无 alt 属性」与「alt=""」
    label: normalizeLabel(n.label),
    tabIndex: parseTabIndex(get('tabIndex', 'tabindex')),
    attributes,
    style: n.style && typeof n.style === 'object' && !Array.isArray(n.style) ? n.style : {},
  };
}

function nodeHidden(n) {
  if (n.hidden === true || n.ancestorHidden === true) return true;
  if (str(n.attributes['aria-hidden']).toLowerCase() === 'true') return true;
  const s = n.style || {};
  if (s.display === 'none') return true;
  if (s.visibility === 'hidden' || s.visibility === 'collapse') return true;
  return false;
}

/** 深度优先扁平化 children，并把祖先 hidden 继承给后代。返回归一化后的新数组（不改入参）。 */
export function flattenNodes(nodes) {
  const out = [];
  let index = 0;
  const walk = (list, parentHidden) => {
    for (const raw of list) {
      const n = normalizeNode(raw, index, parentHidden);
      index += 1;
      const hidden = nodeHidden(n);
      n.hidden = hidden;
      out.push(n);
      const children = raw && typeof raw === 'object' && Array.isArray(raw.children) ? raw.children : null;
      if (children) walk(children, hidden);
    }
  };
  walk(Array.isArray(nodes) ? nodes : [], false);
  return out;
}

// ---------------------------------------------------------------------------
// 语义判定
// ---------------------------------------------------------------------------
export function isInteractive(n) {
  if (typeof n.interactive === 'boolean') return n.interactive;
  if (INTERACTIVE_ROLES.has(n.role)) return true;
  if (n.tag === 'a') return n.attributes.href !== undefined;
  if (INTERACTIVE_TAGS.has(n.tag)) {
    // hidden 输入不进入无障碍树，也不该要求可访问名（否则是典型假阳性）
    if (n.tag === 'input' && str(n.attributes.type).toLowerCase() === 'hidden') return false;
    return true;
  }
  if (n.attributes && n.attributes.onclick !== undefined) return true;
  if (typeof n.tabIndex === 'number' && n.tabIndex >= 0) return true;
  return false;
}

export function isFocusable(n, interactive) {
  if (n.disabled === true) return false;
  if (n.focusable === true) return true;
  if (n.focusable === false) return false;
  if (interactive) return true;
  if (typeof n.tabIndex === 'number' && n.tabIndex >= 0) return true;
  return false;
}

function needsVisibleLabel(n) {
  if (n.tag !== 'input' && n.tag !== 'select' && n.tag !== 'textarea') return false;
  if (n.tag === 'input') {
    const t = str(n.attributes.type).toLowerCase() || 'text';
    if (FORM_CONTROL_TYPES_SKIP.has(t)) return false;
  }
  if (n.hidden) return false; // 隐藏控件交给 A11Y-07，避免双重报错
  return true;
}

/** 简化版 accname：按优先级取第一个非空来源。返回 { name, source }。 */
export function accessibleName(n, byId) {
  const pick = (s) => str(s).trim();
  let v = pick(n.ariaLabel);
  if (v) return { name: v, source: 'aria-label' };

  if (pick(n.ariaLabelledBy)) {
    let t = pick(n.labelledByText);
    if (!t && byId instanceof Map) {
      t = n.ariaLabelledBy.trim().split(/\s+/).map((id) => {
        const target = byId.get(id);
        if (!target) return '';
        return pick(target.text) || pick(target.ariaLabel) || pick(target.value);
      }).filter(Boolean).join(' ');
    }
    if (t) return { name: t, source: 'aria-labelledby' };
  }

  v = pick(n.label && n.label.text);
  if (v) return { name: v, source: 'label' };
  v = pick(n.text);
  if (v) return { name: v, source: 'text' };
  v = pick(n.value);
  if (v) return { name: v, source: 'value' };
  v = pick(n.title);
  if (v) return { name: v, source: 'title' };
  if ((n.role === 'img' || n.tag === 'img' || (n.tag === 'input' && str(n.attributes.type).toLowerCase() === 'image'))) {
    v = pick(n.alt);
    if (v) return { name: v, source: 'alt' };
  }
  return { name: '', source: 'none' };
}

function hasAlt(n) {
  return n.alt !== undefined && n.alt !== null;
}

// ---------------------------------------------------------------------------
// 纯函数扫描器
// ---------------------------------------------------------------------------
/**
 * scan(snapshot) → 结构化报告。**确定性纯函数**：无时间/随机/I/O，不改入参。
 * 违规按规则固定顺序（A11Y-01..07）、节点输入顺序产出，保证可 diff。
 */
export function scan(snapshot) {
  const inputErrors = [];
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    inputErrors.push('snapshot 必须是对象');
  } else if (!Array.isArray(snapshot.nodes)) {
    inputErrors.push('snapshot.nodes 必须是数组');
  }

  const nodes = flattenNodes(snapshot && snapshot.nodes);
  const byId = new Map();
  for (const n of nodes) if (!byId.has(n.id)) byId.set(n.id, n);

  const violations = [];
  const push = (rule, element, expected, actual, detail) => {
    const meta = RULES[rule];
    violations.push({
      rule,
      ruleName: meta.name,
      wcag: meta.wcag,
      severity: meta.severity,
      element,
      expected,
      actual,
      detail: detail && typeof detail === 'object' ? detail : {},
    });
  };

  // A11Y-01 交互元素可访问名（隐藏元素跳过，交由 A11Y-07 处理）
  for (const n of nodes) {
    if (!isInteractive(n) || n.hidden) continue;
    const r = accessibleName(n, byId);
    if (!r.name) {
      push('A11Y-01', n.id,
        '交互元素必须有非空可访问名（aria-label / aria-labelledby / 关联 label / 可见文本 / value / title）',
        '可访问名为空；已尝试 aria-label、aria-labelledby、label.text、text、value、title、alt 均无有效文本',
        { tag: n.tag, role: n.role, ariaLabelledBy: n.ariaLabelledBy });
    }
  }

  // A11Y-02 role=alert|status 必须有 aria-live（项目加严）
  for (const n of nodes) {
    if (n.role !== 'alert' && n.role !== 'status') continue;
    const live = str(n.attributes['aria-live']).trim().toLowerCase();
    if (!live || live === 'off') {
      push('A11Y-02', n.id,
        'role=alert 或 role=status 的元素必须显式声明 aria-live（polite / assertive）',
        'aria-live ' + (live ? '= "' + live + '"（等于关闭）' : '属性缺失'),
        { role: n.role, ariaLive: live });
    }
  }

  // A11Y-03 无正 tabIndex
  for (const n of nodes) {
    if (typeof n.tabIndex === 'number' && n.tabIndex > 0) {
      push('A11Y-03', n.id,
        '不得使用正 tabIndex（改用 DOM 顺序或 tabindex="0"）',
        'tabIndex = ' + n.tabIndex,
        { tabIndex: n.tabIndex });
    }
  }

  // A11Y-04 图片有 alt（空串合法=装饰图；字段缺失违规）
  for (const n of nodes) {
    const isImg = n.tag === 'img' || n.role === 'img'
      || (n.tag === 'input' && str(n.attributes.type).toLowerCase() === 'image');
    if (!isImg || hasAlt(n)) continue;
    push('A11Y-04', n.id,
      '图片元素必须带 alt 属性（纯装饰可用 alt=""）',
      'alt 属性缺失',
      { tag: n.tag, role: n.role });
  }

  // A11Y-05 颜色对比度（sRGB 伽马校正 + WCAG 相对亮度）
  let contrastChecked = 0;
  let contrastSkipped = 0;
  for (const n of nodes) {
    const hasText = typeof n.text === 'string' && n.text.trim().length > 0;
    if (!hasText) { continue; }
    const s = n.style || {};
    if (s.color === undefined || s.backgroundColor === undefined) { contrastSkipped += 1; continue; }
    const fgRaw = parseColor(s.color);
    const bg = parseColor(s.backgroundColor);
    if (!fgRaw || !bg || fgRaw.a === 0 || bg.a < 1) { contrastSkipped += 1; continue; }
    const fg = fgRaw.a < 1 ? compositeOver(fgRaw, bg) : fgRaw;
    if (!fg) { contrastSkipped += 1; continue; }
    const ratio = contrastRatio(fg, bg);
    const info = largeTextInfo(s);
    contrastChecked += 1;
    if (ratio < info.threshold - 1e-9) {
      push('A11Y-05', n.id,
        (info.large ? '大字文本' : '普通文本') + '对比度必须 >= ' + info.threshold + ':1',
        round2(ratio) + ':1（前景 ' + String(s.color) + ' / 背景 ' + String(s.backgroundColor)
          + ' / 字号 ' + round2(info.px) + 'px / 粗体 ' + info.bold + '）',
        { ratio: round2(ratio), foreground: String(s.color), background: String(s.backgroundColor),
          fontSizePx: round2(info.px), bold: info.bold, largeText: info.large, threshold: info.threshold });
    }
  }

  // A11Y-06 表单控件有可见 label（aria-label 不满足本规则）
  for (const n of nodes) {
    if (!needsVisibleLabel(n)) continue;
    const l = n.label;
    const ok = !!l && !!l.text.trim() && l.visible && (l.forMatches || l.wrapsControl);
    if (!ok) {
      push('A11Y-06', n.id,
        '表单控件必须有关联且可见的 <label>（label[for] 指向控件 或 控件被 label 包裹），且标签文本非空',
        l
          ? 'label 存在但 ' + (!l.text.trim() ? '文本为空' : !l.visible ? '不可见' : '未建立关联（forMatches/wrapsControl 均为 false）')
          : '没有关联 label（仅 aria-label 不算可见标签）',
        { tag: n.tag, type: str(n.attributes.type), ariaLabel: n.ariaLabel, label: l });
    }
  }

  // A11Y-07 焦点顺序不含被隐藏元素
  const focusables = nodes.filter((n) => isFocusable(n, isInteractive(n)));
  const focusOrder = focusables
    .slice()
    .sort((a, b) => a.order - b.order) // Array.prototype.sort 自 ES2019 起稳定
    .map((n) => n.id);
  const orderedFocusables = focusables.slice().sort((a, b) => a.order - b.order);
  for (const n of orderedFocusables) {
    if (n.hidden) {
      push('A11Y-07', n.id,
        '焦点顺序中不得包含被隐藏元素（display:none / visibility:hidden / hidden / aria-hidden / 祖先隐藏）',
        '元素被隐藏但仍留在焦点顺序（focusable=' + String(n.focusable) + '，tabIndex=' + String(n.tabIndex) + '）',
        { hidden: true, ancestorHidden: n.ancestorHidden, focusable: n.focusable, tabIndex: n.tabIndex });
    }
  }

  const bySeverity = {};
  for (const s of SEVERITIES) bySeverity[s] = 0;
  const byRule = {};
  for (const id of Object.keys(RULES)) byRule[id] = 0;
  for (const v of violations) {
    bySeverity[v.severity] = (bySeverity[v.severity] || 0) + 1;
    byRule[v.rule] = (byRule[v.rule] || 0) + 1;
  }

  return {
    schemaVersion: '1.0.0',
    tool: 'a11y-runtime',
    profile: 'WCAG 2.1 AA 可判定子集（7 条规则）',
    meta: snapshot && snapshot.meta && typeof snapshot.meta === 'object' ? snapshot.meta : null,
    inputValid: inputErrors.length === 0,
    inputErrors,
    summary: {
      nodes: nodes.length,
      interactive: nodes.filter((n) => isInteractive(n)).length,
      focusOrderLength: focusOrder.length,
      contrastChecked,
      contrastSkipped,
      violations: violations.length,
      bySeverity,
      byRule,
      passed: inputErrors.length === 0 && violations.length === 0,
    },
    focusOrder,
    violations,
  };
}

// ---------------------------------------------------------------------------
// 内置自检快照与自检用例（无真机时也能产出一份真实、可读、可 diff 的报告）
// ---------------------------------------------------------------------------
/** 完全合规的示例面板（0 违规）；用于「假阳性防护」与默认自检。 */
export const DEMO_SNAPSHOT = Object.freeze({
  meta: { selector: '#nas-sync', source: 'builtin-self-check', note: '内置自检演示快照，非真机数据' },
  nodes: [
    { id: 'nas-root', tag: 'section', role: 'region', ariaLabel: 'NAS 同步设置', order: 0 },
    { id: 'cfg-url', tag: 'input', order: 1, ariaLabel: 'WebDAV 地址',
      label: { text: 'WebDAV 地址', forMatches: true, visible: true }, attributes: { type: 'text' } },
    { id: 'btn-save', tag: 'button', text: '保存', tabIndex: 0, order: 2,
      style: { color: '#ffffff', backgroundColor: '#1f6feb', fontSize: '16px', fontWeight: '600' } },
    { id: 'logo', tag: 'img', alt: '', order: 3 },
    { id: 'msg-ok', tag: 'div', role: 'status', text: '已同步', order: 4, attributes: { 'aria-live': 'polite' } },
    { id: 'msg-err', tag: 'div', role: 'alert', text: '网络不可达', order: 5, attributes: { 'aria-live': 'assertive' } },
    { id: 'chk-auto', tag: 'input', order: 6, ariaLabel: '启用自动同步',
      label: { text: '启用自动同步', wrapsControl: true, visible: true }, attributes: { type: 'checkbox' } },
  ],
});

/** 每条规则一个「故意破坏」的最小快照，验证扫描器确实会触发该规则。 */
const SELF_CHECK_FIXTURES = [
  { rule: 'A11Y-01', label: '无名的 button', node: { id: 'x1', tag: 'button' } },
  { rule: 'A11Y-02', label: 'role=alert 缺 aria-live', node: { id: 'x2', tag: 'div', role: 'alert', text: '失败' } },
  { rule: 'A11Y-03', label: '正 tabIndex', node: { id: 'x3', tag: 'button', text: '下一步', tabIndex: 3 } },
  { rule: 'A11Y-04', label: 'img 无 alt', node: { id: 'x4', tag: 'img' } },
  { rule: 'A11Y-05', label: '#777 对白底 4.48:1', node: { id: 'x5', tag: 'p', text: '灰色说明',
    style: { color: '#777777', backgroundColor: '#ffffff', fontSize: '16px' } } },
  { rule: 'A11Y-06', label: 'input 只有 aria-label', node: { id: 'x6', tag: 'input', ariaLabel: '地址' } },
  { rule: 'A11Y-07', label: 'display:none 仍可聚焦', node: { id: 'x7', tag: 'button', text: '隐藏', focusable: true,
    style: { display: 'none' } } },
];

/** 返回自检结果（同样纯函数），供 main() 写进报告，证明 7 条规则都活着。 */
export function runSelfCheck() {
  const clean = scan(DEMO_SNAPSHOT);
  const cases = SELF_CHECK_FIXTURES.map((f) => {
    const r = scan({ nodes: [f.node] });
    const fired = r.violations.some((v) => v.rule === f.rule);
    return { rule: f.rule, label: f.label, fired, ok: fired };
  });
  return {
    description: 'clean 快照必须 0 违规；每个故意破坏的快照必须命中目标规则',
    cleanViolations: clean.summary.violations,
    cleanPassed: clean.summary.passed,
    cases,
    allMatched: clean.summary.passed && cases.every((c) => c.ok),
  };
}

// ---------------------------------------------------------------------------
// CLI（仅在直接执行本文件时运行；import 不会触发 I/O）
// ---------------------------------------------------------------------------
function usage() {
  return [
    '用法：node scripts/a11y-runtime.mjs [快照.json] [选项]',
    '',
    '  无参数            使用内置自检快照（clean，0 违规）+ 7 条规则自检',
    '  快照.json         扫描指定 DOM 快照 JSON',
    '  --stdin           从标准输入读快照 JSON',
    '  --out=<路径>      报告输出路径，默认 reports/a11y-runtime.json',
    '  --no-gate         有违规也返回退出码 0（只报告不设门禁）',
    '  --help            显示本帮助',
    '',
    '输入 DOM 快照结构见本文件顶部注释。',
  ].join('\n');
}

function writeReport(outPath, data) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(usage() + '\n');
    return;
  }
  const noGate = args.includes('--no-gate');
  const outArg = args.find((a) => a.startsWith('--out='));
  const outPath = outArg ? outArg.slice('--out='.length) : 'reports/a11y-runtime.json';
  const useStdin = args.includes('--stdin');
  const positional = args.filter((a) => !a.startsWith('--'));

  let snapshot;
  let mode;
  let source;

  if (useStdin) {
    snapshot = JSON.parse(readFileSync(0, 'utf8'));
    mode = 'stdin';
    source = 'stdin';
  } else if (positional.length > 0) {
    const p = positional[0];
    if (!existsSync(p)) {
      writeReport(outPath, {
        schemaVersion: '1.0.0', tool: 'a11y-runtime', mode: 'file', source: p,
        status: 'skipped', reason: '输入快照不存在：' + p,
        summary: { violations: 0, passed: true }, violations: [],
      });
      process.stdout.write('[a11y-runtime] 跳过：输入快照不存在 ' + p + '\n');
      return;
    }
    snapshot = JSON.parse(readFileSync(p, 'utf8'));
    mode = 'file';
    source = p;
  } else {
    snapshot = DEMO_SNAPSHOT;
    mode = 'self-check';
    source = '内置自检快照';
  }

  const report = scan(snapshot);
  const output = { mode, source, ...report };
  if (mode === 'self-check') output.selfCheck = runSelfCheck();
  writeReport(outPath, output);

  const s = report.summary;
  process.stdout.write('[a11y-runtime] mode=' + mode + ' 节点=' + s.nodes
    + ' 交互=' + s.interactive + ' 焦点序=' + s.focusOrderLength
    + ' 对比度已检=' + s.contrastChecked + '(跳过 ' + s.contrastSkipped + ')'
    + ' 违规=' + s.violations + ' passed=' + s.passed + '\n');
  if (output.selfCheck) {
    process.stdout.write('[a11y-runtime] 自检 allMatched=' + output.selfCheck.allMatched
      + '（clean 违规 ' + output.selfCheck.cleanViolations + '）\n');
  }
  process.stdout.write('[a11y-runtime] 报告 → ' + outPath + '\n');

  if (!s.passed && !noGate) process.exitCode = 1;
}

const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write('[a11y-runtime] ' + (err && err.stack ? err.stack : String(err)) + '\n');
    process.exitCode = 2;
  });
}
