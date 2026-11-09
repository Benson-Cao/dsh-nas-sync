/**
 * 静态安全审计 + 依赖审计（0.6.0 / 收尾⑤）
 * ----------------------------------------
 * SAST 的轻量落地：不引入第三方扫描器，用一组针对本项目真实风险的规则扫
 * `src/**` / `client.js` / `scripts/*.mjs`，再跑 `npm audit --omit=dev`。
 * 这是「门禁」不是「证明安全」：只覆盖下面这几类已知模式，不能替代 DAST、
 * 依赖深度审计与人工评审，报告里会明确写出覆盖范围。
 *
 * 用法：
 *   node scripts/security-audit.mjs              # 发现 high 就退出码 1
 *   node scripts/security-audit.mjs --no-gate    # 只出报告
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const NO_GATE = process.argv.includes('--no-gate');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'dist' || name === 'dist-test' || name === '.git') continue;
      walk(p, out);
    } else if (/\.(ts|js|mjs)$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

const files = [
  ...walk('src'),
  'client.js',
  ...readdirSync('scripts').filter((f) => f.endsWith('.mjs') && f !== 'security-audit.mjs')
    .map((f) => join('scripts', f)),
].filter((f) => {
  try { readFileSync(f); return true; } catch { return false; }
});

const RULES = [
  {
    id: 'dynamic-code', severity: 'high',
    re: /\beval\s*\(|new\s+Function\s*\(/,
    why: '动态执行字符串，NAS 上的对象或面板输入可能借此变成代码',
  },
  {
    id: 'hardcoded-secret', severity: 'high',
    re: /(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"][A-Za-z0-9_\-+/=]{12,}['"]/i,
    why: '疑似硬编码凭据；口令只能来自配置 / 凭据文件',
  },
  {
    id: 'command-interpolation', severity: 'high',
    re: /\b(?:spawn|exec|execSync|spawnSync)\s*\([^)]*\$\{/,
    why: '把模板字符串插进外部命令参数，存在命令注入风险',
  },
  {
    id: 'inner-html', severity: 'medium',
    re: /\.innerHTML\s*=/,
    why: '直接写 innerHTML 会绕过 React 的转义，需确认内容可信',
  },
  {
    id: 'plain-http', severity: 'medium',
    re: /['"`]http:\/\/(?!127\.0\.0\.1|localhost|0\.0\.0\.0|example\.com|nas\.invalid)/i,
    why: '明文 HTTP 地址；WebDAV 凭据会在链路上裸奔',
  },
];

const findings = [];
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    // 跳过纯注释行，减少「规则说明文字」造成的误报
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
    for (const rule of RULES) {
      if (rule.re.test(line)) {
        findings.push({
          rule: rule.id, severity: rule.severity, file, line: i + 1,
          snippet: trimmed.slice(0, 160), why: rule.why,
        });
      }
    }
  });
}

// ---- 依赖审计（SCA）：离线/无网络时明确记 skipped，不假装通过 ----
let sca = { status: 'skipped', reason: '', vulnerabilities: {} };
const audit = spawnSync('npm', ['audit', '--omit=dev', '--json'], {
  encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60_000, shell: true,
});
if (audit.error || audit.timedOut) {
  sca.reason = 'npm audit 不可用（离线 / 超时）：' + String(audit.error?.message ?? 'timeout');
} else {
  try {
    const j = JSON.parse(audit.stdout || '{}');
    sca.status = 'ok';
    sca.vulnerabilities = j?.metadata?.vulnerabilities ?? {};
    const high = (sca.vulnerabilities.high ?? 0) + (sca.vulnerabilities.critical ?? 0);
    if (high > 0) {
      findings.push({
        rule: 'dependency-vulnerability', severity: 'high', file: 'package.json', line: 0,
        snippet: `high/critical 依赖漏洞 ${high} 个`, why: '需升级依赖或评估是否可达',
      });
    }
  } catch {
    sca.reason = 'npm audit 输出不是合法 JSON（可能未登录私有源）';
  }
}

const high = findings.filter((f) => f.severity === 'high');
const medium = findings.filter((f) => f.severity === 'medium');
const report = {
  at: new Date().toISOString(),
  coverage: '静态规则（5 类）+ npm audit --omit=dev；不含 DAST / 运行时渗透 / 人工评审',
  scannedFiles: files.length, rules: RULES.map((r) => r.id),
  high: high.length, medium: medium.length,
  sca, findings,
};
mkdirSync('reports', { recursive: true });
writeFileSync('reports/security-audit.json', JSON.stringify(report, null, 2) + '\n', 'utf8');

console.log('=== 安全审计 ===');
console.log(`  扫描 ${files.length} 个文件，${RULES.length} 条静态规则`);
console.log(`  high ${high.length} / medium ${medium.length}；依赖审计 ${sca.status}`
  + (sca.reason ? '（' + sca.reason + '）' : ''));
for (const f of findings) {
  console.log(`  [${f.severity}] ${f.rule} ${f.file}:${f.line} — ${f.snippet}`);
}
console.log('  详见 reports/security-audit.json');
if (!NO_GATE && high.length > 0) {
  console.error('[security-audit] 存在 high 级别问题，门禁不通过。');
  process.exit(1);
}
