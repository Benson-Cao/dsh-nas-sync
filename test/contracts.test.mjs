/**
 * 0.6.0 · 契约校验器自身的单测
 * -----------------------------
 * 重点不是「仓库里的 golden 能过」（那是 scripts/contract-verify.mjs 的事），
 * 而是**校验器本身不能假阳性 / 假阴性**：
 *   · 合法数据被误拒 → 假阳性（冤枉）
 *   · 非法数据被放过 → 假阴性（更危险，契约形同虚设）
 * 所以每条规则都同时写正例与反例，并单独锁一条「反向验证必须真的红」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../', import.meta.url);
const { validate, checkCompat } = await import('../scripts/contract-verify.mjs');

const schema = (rel) => JSON.parse(readFileSync(new URL('contracts/schemas/' + rel, ROOT), 'utf8'));

test('type：数字 / 字符串 / 布尔 / 数组 / 对象 / null 都对得上', () => {
  assert.deepEqual(validate(1, { type: 'number' }), []);
  assert.deepEqual(validate('x', { type: 'string' }), []);
  assert.deepEqual(validate(true, { type: 'boolean' }), []);
  assert.deepEqual(validate([], { type: 'array' }), []);
  assert.deepEqual(validate({}, { type: 'object' }), []);
  assert.deepEqual(validate(null, { type: 'null' }), []);
  assert.equal(validate('1', { type: 'number' }).length, 1, '字符串数字必须被拒绝');
  assert.equal(validate(null, { type: 'object' }).length, 1, 'null 不是 object');
});

test('required：缺一个就报一个，且不重复报同一个字段', () => {
  const s = { type: 'object', required: ['a', 'b'] };
  assert.deepEqual(validate({ a: 1, b: 2 }, s), []);
  const errs = validate({ a: 1 }, s);
  assert.equal(errs.length, 1);
  assert.match(errs[0].msg, /b/);
  assert.equal(validate({}, s).length, 2, '两个都缺必须报两条');
});

test('additionalProperties:false 拒绝未声明字段（防契约漂移）', () => {
  const s = {
    type: 'object', additionalProperties: false,
    properties: { a: { type: 'number' } },
  };
  assert.deepEqual(validate({ a: 1 }, s), []);
  const errs = validate({ a: 1, b: 2 }, s);
  assert.equal(errs.length, 1);
  assert.match(errs[0].msg, /额外字段 b/);
});

test('enum：集合外取值必须拒绝，集合内必须通过', () => {
  const s = { type: 'string', enum: ['upsert', 'delete'] };
  assert.deepEqual(validate('delete', s), []);
  assert.equal(validate('remove', s).length, 1);
});

test('pattern：sha256 hex 与设备名两种真实形态', () => {
  const hash = { type: 'string', pattern: '^[0-9a-f]{64}$' };
  assert.deepEqual(validate('a'.repeat(64), hash), []);
  assert.equal(validate('A'.repeat(64), hash).length, 1, '大写 hex 不合法');
  assert.equal(validate('a'.repeat(63), hash).length, 1, '少一位不合法');

  const dev = { type: 'string', pattern: '^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+$' };
  assert.deepEqual(validate('win32:DESKTOP-ABC', dev), []);
  assert.equal(validate('win32DESKTOP', dev).length, 1, '缺冒号不合法');
});

test('minimum / maximum：边界值本身算合法', () => {
  const s = { type: 'number', minimum: 1, maximum: 10 };
  assert.deepEqual(validate(1, s), []);
  assert.deepEqual(validate(10, s), []);
  assert.equal(validate(0, s).length, 1);
  assert.equal(validate(11, s).length, 1);
});

test('items：数组逐个校验，错误路径带下标', () => {
  const s = { type: 'array', items: { type: 'number' } };
  assert.deepEqual(validate([1, 2, 3], s), []);
  const errs = validate([1, 'x', 3], s);
  assert.equal(errs.length, 1);
  assert.match(errs[0].path, /\[1\]/);
});

test('嵌套对象：错误路径能定位到具体字段', () => {
  const s = {
    type: 'object',
    properties: { webdav: { type: 'object', required: ['url'], properties: { url: { type: 'string' } } } },
  };
  const errs = validate({ webdav: { url: 123 } }, s);
  assert.equal(errs.length, 1);
  assert.equal(errs[0].path, '$.webdav.url');
});

test('compat/absent：多出的新字段必须被抓住', () => {
  assert.deepEqual(checkCompat({ rule: 'absent', fields: ['device'] }, { rel: 'a' }), []);
  const errs = checkCompat({ rule: 'absent', fields: ['device'] }, { rel: 'a', device: 'x' });
  assert.equal(errs.length, 1);
});

test('compat/present：缺字段必须被抓住', () => {
  assert.deepEqual(checkCompat({ rule: 'present', fields: ['rel'] }, { rel: 'a' }), []);
  assert.equal(checkCompat({ rule: 'present', fields: ['rel'] }, {}).length, 1);
});

test('compat/types：类型不符必须被抓，可选字段缺省不报错', () => {
  const c = { rule: 'types', types: { n: 'number', s: 'string' } };
  assert.deepEqual(checkCompat(c, { n: 1, s: 'x' }), []);
  assert.deepEqual(checkCompat(c, { n: 1 }), [], '缺省的可选字段不该报错');
  assert.equal(checkCompat(c, { n: '1' }).length, 1);
});

test('compat：未知规则必须失败而不是静默通过（fail-closed）', () => {
  const errs = checkCompat({ rule: 'whatever', fields: [] }, {});
  assert.equal(errs.length, 1);
  assert.match(errs[0].msg, /未知 compat 规则/);
});

test('真实 schema 反向验证：删掉必填字段必须变红', () => {
  const s = schema('sync-event.schema.json');
  const good = {
    v: 2, device: 'win32:PC', seq: 1, ts: 1, key: 'rel:x', op: 'upsert',
  };
  assert.deepEqual(validate(good, s), [], '最小合法事件应通过');
  const { seq, ...withoutSeq } = good;
  assert.equal(validate(withoutSeq, s).length, 1, '删掉 seq 必须被拒绝');
  assert.equal(validate({ ...good, op: 'rename' }, s).length, 1, '未知 op 必须被拒绝');
});

test('真实 schema 正向验证：golden 合法样例必须全部通过', () => {
  const pairs = ['sync-event', 'manifest-entry', 'store-state', 'plugin-assembly', 'config-view'];
  for (const name of pairs) {
    const s = schema(name + '.schema.json');
    const file = new URL('contracts/golden/' + name + '.valid.json', ROOT);
    assert.ok(existsSync(file), '缺少 golden：' + name + '.valid.json');
    const data = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(validate(data, s), [], name + ' 合法样例被误拒');
  }
});

test('真实 schema 反向验证：golden 非法样例必须全部被拒', () => {
  const pairs = ['sync-event', 'manifest-entry', 'store-state', 'plugin-assembly', 'config-view'];
  for (const name of pairs) {
    const s = schema(name + '.schema.json');
    const data = JSON.parse(readFileSync(new URL('contracts/golden/' + name + '.invalid.json', ROOT), 'utf8'));
    assert.ok(validate(data, s).length > 0, name + ' 非法样例被放过（假阴性）');
  }
});
