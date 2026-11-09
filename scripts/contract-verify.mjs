/**
 * 0.6.0 · 数据契约验证（零依赖）
 * ---------------------------------
 * 0.5.8 审查报告 G6 要求「4 个跨设备共享结构有 schema + golden 快照 + 版本矩阵」。
 * 本脚本用仓库自带的 JSON Schema 子集校验器，把这件事做成确定性检查：
 *
 *   1. contracts/golden/*.valid.json   → 必须通过对应 schema
 *   2. contracts/golden/*.invalid.json → 必须被对应 schema 拒绝（反向验证）
 *   3. contracts/versions/*.json       → 每个 case 按 kind 判定
 *        · kind=schema：用指定 schema 校验 data，expect 为 pass / fail
 *        · kind=compat：rule=absent（字段必须都不在）/ present（必须都在）/ types（类型锁定）
 *
 * 只用 Node 内置能力，不引 ajv。支持的 schema 关键字就是本仓库实际用到的子集：
 * type / required / properties / additionalProperties / items / enum / pattern /
 * minimum / maximum / minLength / maxLength / minItems / maxItems。
 *
 * 用法： node scripts/contract-verify.mjs
 * 产出： reports/contract-report.json（每条 case 的 PASS/FAIL 与原因）
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SCHEMA_DIR = join(ROOT, 'contracts', 'schemas');
const GOLDEN_DIR = join(ROOT, 'contracts', 'golden');
const VERSION_DIR = join(ROOT, 'contracts', 'versions');
const REPORT = join(ROOT, 'reports', 'contract-report.json');

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

/** JSON 值的类型名（与 schema 的 type 取值对齐；null 单列）。 */
function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isFinite(v) ? 'number' : 'non-finite';
  return typeof v;
}

/**
 * 校验一个值是否符合 schema。返回错误数组（空数组 = 通过）。
 * 纯函数：不读文件、不打日志，便于单测。
 */
export function validate(value, schema, path = '$') {
  const errs = [];
  if (!schema || typeof schema !== 'object') return [{ path, msg: 'schema 不是对象' }];

  if (schema.type) {
    const want = Array.isArray(schema.type) ? schema.type : [schema.type];
    const got = typeOf(value);
    // 整数在 JSON Schema 里也是 number；这里不做 integer 区分
    if (!want.includes(got)) {
      errs.push({ path, msg: `类型应为 ${want.join('|')}，实际 ${got}` });
      return errs;
    }
  }

  if (schema.enum && !schema.enum.some((x) => JSON.stringify(x) === JSON.stringify(value))) {
    errs.push({ path, msg: `取值不在枚举内：${JSON.stringify(value)}` });
  }

  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errs.push({ path, msg: `不匹配 pattern ${schema.pattern}：${JSON.stringify(value)}` });
    }
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errs.push({ path, msg: `长度 ${value.length} < ${schema.minLength}` });
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      errs.push({ path, msg: `长度 ${value.length} > ${schema.maxLength}` });
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errs.push({ path, msg: `值 ${value} < minimum ${schema.minimum}` });
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errs.push({ path, msg: `值 ${value} > maximum ${schema.maximum}` });
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errs.push({ path, msg: `元素数 ${value.length} < minItems ${schema.minItems}` });
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      errs.push({ path, msg: `元素数 ${value.length} > maxItems ${schema.maxItems}` });
    }
    if (schema.items) {
      value.forEach((v, i) => errs.push(...validate(v, schema.items, `${path}[${i}]`)));
    }
  }

  if (typeOf(value) === 'object') {
    for (const k of schema.required ?? []) {
      if (!(k in value)) errs.push({ path, msg: `缺少必填字段 ${k}` });
    }
    const props = schema.properties ?? {};
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) {
        errs.push(...validate(v, props[k], `${path}.${k}`));
      } else if (schema.additionalProperties === false) {
        errs.push({ path, msg: `不允许的额外字段 ${k}` });
      }
    }
  }

  return errs;
}

/** compat 规则：字段缺失 / 存在 / 类型锁定。 */
export function checkCompat(c, data) {
  const errs = [];
  const fields = c.fields ?? [];
  if (c.rule === 'absent') {
    for (const f of fields) {
      if (data && Object.prototype.hasOwnProperty.call(data, f)) {
        errs.push({ path: '$.' + f, msg: `该版本不应出现字段 ${f}` });
      }
    }
  } else if (c.rule === 'present') {
    for (const f of fields) {
      if (!data || !Object.prototype.hasOwnProperty.call(data, f)) {
        errs.push({ path: '$.' + f, msg: `该版本必须包含字段 ${f}` });
      }
    }
  } else if (c.rule === 'types') {
    for (const [f, want] of Object.entries(c.types ?? {})) {
      if (!data || !Object.prototype.hasOwnProperty.call(data, f)) continue; // 可选字段不强制存在
      const got = typeOf(data[f]);
      if (got !== want) errs.push({ path: '$.' + f, msg: `字段 ${f} 应为 ${want}，实际 ${got}` });
    }
  } else {
    errs.push({ path: '$', msg: '未知 compat 规则：' + String(c.rule) });
  }
  return errs;
}

function main() {
  const schemas = new Map();
  for (const f of readdirSync(SCHEMA_DIR).filter((n) => n.endsWith('.json'))) {
    schemas.set(f, readJson(join(SCHEMA_DIR, f)));
  }

  const results = [];
  const push = (r) => results.push(r);

  // ---- 1. golden 正向 / 反向 ----
  for (const f of readdirSync(GOLDEN_DIR).filter((n) => n.endsWith('.json')).sort()) {
    const m = /^(.+)\.(valid|invalid)\.json$/.exec(f);
    if (!m) { push({ id: 'golden/' + f, ok: false, errors: ['文件名不符合 <name>.valid|invalid.json'] }); continue; }
    const [, name, want] = m;
    const schema = schemas.get(name + '.schema.json');
    if (!schema) { push({ id: 'golden/' + f, ok: false, errors: ['找不到 schema：' + name + '.schema.json'] }); continue; }
    const data = readJson(join(GOLDEN_DIR, f));
    const errs = validate(data, schema);
    const pass = want === 'valid' ? errs.length === 0 : errs.length > 0;
    push({
      id: 'golden/' + f, kind: 'golden', ok: pass,
      expectAccept: want === 'valid',
      errors: errs.map((e) => e.path + ' ' + e.msg),
      reason: pass ? '' : (want === 'valid' ? '合法样例被误拒' : '非法样例被放过（假阴性）'),
    });
  }

  // ---- 2. 版本矩阵 ----
  for (const f of readdirSync(VERSION_DIR).filter((n) => n.endsWith('.json')).sort()) {
    const doc = readJson(join(VERSION_DIR, f));
    for (const c of doc.cases ?? []) {
      let errs = [];
      if (c.kind === 'schema') {
        const schema = schemas.get(c.schema);
        if (!schema) { errs = [{ path: '$', msg: '找不到 schema：' + c.schema }]; }
        else errs = validate(c.data, schema);
      } else if (c.kind === 'compat') {
        errs = checkCompat(c, c.data);
      } else {
        errs = [{ path: '$', msg: '未知 kind：' + String(c.kind) }];
      }
      const accepted = errs.length === 0;
      const ok = c.expect === 'pass' ? accepted : !accepted;
      push({
        id: doc.version + '/' + (c.id ?? '(no-id)'),
        kind: c.kind, ok, expect: c.expect,
        errors: errs.map((e) => e.path + ' ' + e.msg),
        reason: ok ? '' : `期望 ${c.expect}，实际 ${accepted ? 'pass' : 'fail'}`,
      });
    }
  }

  const failed = results.filter((r) => !r.ok);
  const out = {
    at: new Date().toISOString(),
    ok: failed.length === 0,
    schemas: schemas.size,
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    results,
  };
  mkdirSync(join(ROOT, 'reports'), { recursive: true });
  writeFileSync(REPORT, JSON.stringify(out, null, 2) + '\n', 'utf8');

  console.log('=== 契约验证 ===');
  console.log(`  schema ${schemas.size} 份，用例 ${results.length} 条，通过 ${out.passed}，失败 ${failed.length}`);
  for (const f of failed) console.log('  ✗ ' + f.id + ' — ' + (f.reason || f.errors.join('; ')));
  console.log('  报告：' + REPORT);
  if (failed.length) process.exitCode = 1;
}

// 作为脚本直接跑时才执行；被单测 import 时只导出纯函数
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
