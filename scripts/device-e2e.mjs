/**
 * 真机 E2E 的 CDP 执行器（0.6.0 / 收尾⑤）
 * ------------------------------------------
 * 由 device-e2e.sh 在建立 `adb forward tcp:9222 …` 之后调用。
 * 用 Node 22 内置的 fetch / WebSocket，不需要 puppeteer 之类的依赖。
 *
 * 它在**真实 WebView 页面上下文**里调用 HTTP 桥（带页面注入的 token），
 * 因此验证的是「插件真的装进去了、桥真的活着、面板真能取到数据」，
 * 而不是 dist-test 里那一堆纯函数。
 */
import { writeFileSync, mkdirSync } from 'node:fs';

const PORT = process.env.CDP_PORT || '9222';
const BASE = `http://127.0.0.1:${PORT}`;

async function jsonList() {
  const r = await fetch(BASE + '/json/list', { headers: { host: '127.0.0.1' } });
  if (!r.ok) throw new Error('/json/list HTTP ' + r.status);
  return r.json();
}

const EXPR = `(async () => {
  const token = window.__DSH_NAS_SYNC_TOKEN__;
  const prefix = window.__DSH_NAS_SYNC_PREFIX__ || '/nas-sync-api';
  const call = async (path, opts) => {
    const o = opts || {};
    const r = await fetch(prefix + path, {
      method: o.method || 'GET',
      headers: { 'x-nas-sync-token': token, 'content-type': 'application/json' },
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
    });
    return { http: r.status, json: await r.json().catch(() => null) };
  };
  const out = { at: new Date().toISOString(), tokenPresent: typeof token === 'string' && token.length > 0, prefix };
  const st = await call('/status');
  const sv = st.json && st.json.value;
  out.status = { http: st.http, ok: !!(st.json && st.json.ok), hasSafety: !!(sv && sv.safety),
    safety: sv && sv.safety ? sv.safety : null, storeError: sv && sv.storeError != null ? sv.storeError : null,
    snapshot: sv && sv.snapshot ? sv.snapshot : null,
    configKeys: sv && sv.config ? Object.keys(sv.config) : [] };
  const ev = await call('/events?limit=20');
  const evv = ev.json && ev.json.value;
  out.events = { http: ev.http, ok: !!(ev.json && ev.json.ok), trusted: evv ? evv.trusted : null,
    count: evv && Array.isArray(evv.events) ? evv.events.length : null,
    tombstones: evv && Array.isArray(evv.tombstones) ? evv.tombstones.length : null };
  const rm = await call('/rel-migration');
  const rmv = rm.json && rm.json.value;
  out.relMigration = { http: rm.http, ok: !!(rm.json && rm.json.ok),
    mode: rmv ? rmv.mode : null, effectiveMode: rmv ? rmv.effectiveMode : null,
    valid: rmv ? rmv.valid : null, mappings: rmv && rmv.plan ? rmv.plan.mappings.length : null };
  const pl = await call('/plugins');
  out.plugins = { http: pl.http, ok: !!(pl.json && pl.json.ok),
    canInstall: pl.json && pl.json.value ? pl.json.value.canInstall : null,
    casAssemblies: pl.json && pl.json.value ? pl.json.value.casAssemblies : null };
  const ig = await call('/ignored');
  out.ignored = { http: ig.http, ok: !!(ig.json && ig.json.ok),
    ids: ig.json && ig.json.value && Array.isArray(ig.json.value.ids) ? ig.json.value.ids : null };
  const rd = await call('/removed');
  const items = rd.json && rd.json.value && Array.isArray(rd.json.value.items) ? rd.json.value.items : [];
  out.removed = { http: rd.http, ok: !!(rd.json && rd.json.ok), count: items.length };
  return out;
})()`;

async function main() {
  let targets = [];
  for (let i = 0; i < 10; i++) {
    try {
      targets = await jsonList();
      if (targets.some((t) => t.type === 'page' && /3080/.test(t.url || ''))) break;
    } catch { /* WebView 还没起来 */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  const page = targets.find((t) => t.type === 'page' && /3080/.test(t.url || '') && t.webSocketDebuggerUrl);
  if (!page) {
    throw new Error('找不到 DSH 页面 target（URL 含 3080）。确认应用已在前台且 WebView 未被冻结。');
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let seq = 0;
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = (e) => reject(new Error('CDP WebSocket 连接失败：' + String(e?.message ?? e)));
    setTimeout(() => reject(new Error('CDP WebSocket 连接超时')), 10_000);
  });
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(String(ev.data)); } catch { return; }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const cmd = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.delete(id)) reject(new Error('CDP 超时：' + method)); }, 30_000);
  });

  const res = await cmd('Runtime.evaluate', {
    expression: EXPR, awaitPromise: true, returnByValue: true,
  });
  ws.close();
  if (res.error) throw new Error('CDP 错误：' + JSON.stringify(res.error));
  const val = res.result?.result?.value;
  if (res.result?.exceptionDetails) {
    throw new Error('页面脚本异常：' + JSON.stringify(res.result.exceptionDetails));
  }
  if (!val || typeof val !== 'object') throw new Error('页面没有返回结构化结果');

  // 门禁：这些是真机 E2E 必须成立的最小事实
  const failures = [];
  if (!val.tokenPresent) failures.push('页面没有注入 x-nas-sync-token');
  if (!val.status.ok) failures.push('/status 未返回 ok');
  if (!val.status.hasSafety) failures.push('/status 缺 safety（跑的不是 0.6.0 bundle）');
  if (val.status.storeError) failures.push('storeError 非空：' + val.status.storeError);
  if (!val.events.ok) failures.push('/events 不可用');
  if (!val.relMigration.ok) failures.push('/rel-migration 不可用');
  if (!val.plugins.ok) failures.push('/plugins 不可用');
  if (!val.ignored.ok) failures.push('/ignored 不可用');
  if (!val.removed.ok) failures.push('/removed 不可用');

  mkdirSync('reports', { recursive: true });
  writeFileSync('reports/device-e2e.json', JSON.stringify({ ok: failures.length === 0, failures, ...val }, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({ ok: failures.length === 0, failures, ...val }, null, 2));
  if (failures.length) process.exit(1);
}

main().catch((err) => {
  console.error('[device-e2e] ' + (err?.stack ?? err));
  process.exit(1);
});
