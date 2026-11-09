/**
 * 0.6.0 / P0：事件日志、墓碑、设备位点、v2 清单的单测。
 *
 * 0.5.8 全栈审查里「删除传播没有任何单测」是阻断级问题之一。这里锁的是
 * 新协议的语义边界，尤其是三条**误删防线**：
 *   · 日志读失败 / 签名坏 / seq 有缺口 → 整轮不可信，禁止删除传播；
 *   · 删除优先但保留期内可复活、可恢复；
 *   · 会话按 sid 归并，两端 rel 不同也能命中同一条删除。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EVENTS_DIR, TOMBSTONES_FILE, CURSORS_DIR, OBJECTS_DIR, TRASH_DIR, BIDMAP_FILE,
  DEFAULT_RETENTION_DAYS, EVENT_SHARD_SIZE,
  eventLogFileOf, eventShardOf, cursorFileOf, objectPathOf, trashPathOf,
  canonicalSessionRel, sessionIdFromRel, stableKeyOf, pluginTarget,
  eventSignature, verifyEvent, makeEvent, eventId,
  compareEvents, sortEvents, dedupeEvents, mergeEventLogs, nextLocalSeq,
  validateEventStream, buildTombstones, mergeTombstones, isDeleted, collectGc, tombstoneTargets,
  advanceCursor, eventsSince, applyEventsToManifest, migrateV1ToEvents,
  parseEventLog, serializeEventLog, mergeBidMaps, bidMapLookup,
  canonicalVector, normalizeVector, vectorClockOf, dominates, compareCausally, pickWinner,
} from '../dist-test/events.mjs';

import {
  MANIFESTS_DIR, mergeV2Manifests, stripDeletedEntries,
  manifestEntryKey, toV2Manifest,
} from '../dist-test/manifest.mjs';

const TS = 1_700_000_000_000;
const DEV_A = 'win32:PC';
const DEV_B = 'android:PHONE';
const HASH = 'a'.repeat(64);
const ev = (over = {}) => makeEvent({
  device: DEV_A, seq: 1, ts: TS, key: 'rel:attachments/a.png',
  rel: 'attachments/a.png', hash: HASH, op: 'upsert', ...over,
});

/* ---------------------------------------------------------------- 路径常量 */

test('事件协议路径：分片 / 位点 / CAS 对象 / 回收副本都落在各自命名空间', () => {
  assert.equal(EVENTS_DIR, '/dsh/events');
  assert.equal(TOMBSTONES_FILE, '/dsh/tombstones.json');
  assert.equal(CURSORS_DIR, '/dsh/cursors');
  assert.equal(OBJECTS_DIR, '/dsh/objects');
  assert.equal(TRASH_DIR, '/dsh/trash');
  assert.equal(BIDMAP_FILE, '/dsh/bidmap.json');
  assert.equal(MANIFESTS_DIR, '/dsh/manifests');
  assert.equal(DEFAULT_RETENTION_DAYS, 30);
  assert.ok(EVENT_SHARD_SIZE > 0);

  assert.equal(eventLogFileOf(DEV_A, 0), '/dsh/events/win32_PC/000000.jsonl');
  assert.equal(cursorFileOf(DEV_A), '/dsh/cursors/win32_PC.json');
  const evil = eventLogFileOf('../../etc/passwd');
  assert.ok(evil.startsWith(EVENTS_DIR + '/'), evil);
  assert.ok(!evil.includes('..'), evil);
});

test('eventShardOf：按分片大小切，第 1 条在第 0 片，边界不越界', () => {
  assert.equal(eventShardOf(1), 0);
  assert.equal(eventShardOf(EVENT_SHARD_SIZE), 0);
  assert.equal(eventShardOf(EVENT_SHARD_SIZE + 1), 1);
  assert.equal(eventShardOf(0), 0, '脏数据也要落在第 0 片，不能算出负分片');
});

test('objectPathOf：只接受 sha256 hex，拒绝路径注入', () => {
  assert.equal(objectPathOf(HASH), '/dsh/objects/aa/' + HASH);
  assert.throws(() => objectPathOf('../../etc/passwd'));
  assert.throws(() => objectPathOf('abc'));
});

test('trashPathOf：按日期分桶且带时间戳，同名删除不互相覆盖', () => {
  const a = trashPathOf('session:s1', TS);
  const b = trashPathOf('session:s1', TS + 1);
  assert.ok(a.startsWith(TRASH_DIR + '/'));
  assert.notEqual(a, b);
  assert.ok(!a.includes('..'));
});

/* ------------------------------------------------------------ 稳定主键 / P2 */

test('stableKeyOf：同一会话在两端 rel 不同，但主键必须相同', () => {
  const pc = 'sessions/--C-Users-Admin/s1/session.v4.jsonl.zstd';
  const phone = 'sessions/--data-user-0-com-dsh/s1/session.v4.jsonl.zstd';
  assert.equal(stableKeyOf(pc), 'session:s1');
  assert.equal(stableKeyOf(phone), 'session:s1');
  assert.equal(stableKeyOf('attachments/a.png'), 'rel:attachments/a.png');
  assert.equal(stableKeyOf('x', { sid: 'forced' }), 'session:forced');
});

test('stableKeyOf：插件按平台/ABI 分包，不同平台是不同的 key', () => {
  const win = stableKeyOf('plugins/x', { plugin: { name: 'dsh-nas-sync', platform: 'win32/x64', abi: 127 } });
  const and = stableKeyOf('plugins/x', { plugin: { name: 'dsh-nas-sync', platform: 'android/arm64', abi: 127 } });
  assert.notEqual(win, and);
  assert.ok(win.includes('dsh-nas-sync'));
  assert.equal(pluginTarget('android', 'arm64', 127), 'android/arm64/node-127');
});

test('canonicalSessionRel / sessionIdFromRel：canonical rel 与旧 rel 都能抽到 sid', () => {
  const c = canonicalSessionRel('s1', 3);
  assert.equal(c, 'sessions/by-id/s1/v3');
  assert.equal(sessionIdFromRel(c), 's1');
  assert.equal(sessionIdFromRel('sessions/--C-Users-Admin/s1/session.v4.jsonl.zstd'), 's1');
  assert.equal(sessionIdFromRel('attachments/a.png'), null);
});

/* ------------------------------------------------------- 事件构造与防篡改 */

test('makeEvent 产出的事件能通过 verifyEvent，JSON 往返后依然有效', () => {
  const e = ev();
  assert.equal(verifyEvent(e), true);
  assert.equal(verifyEvent(JSON.parse(JSON.stringify(e))), true);
  assert.equal(e.v, 2);
  assert.match(e.sig, /^[0-9a-f]{64}$/);
});

test('verifyEvent：改内容 / 改版本 / 缺签名 / 非法 op 一律拒绝', () => {
  const e = ev();
  assert.equal(verifyEvent({ ...e, key: 'rel:tampered' }), false);
  assert.equal(verifyEvent({ ...e, hash: 'b'.repeat(64) }), false);
  assert.equal(verifyEvent({ ...e, v: 1 }), false);
  const noSig = { ...e };
  delete noSig.sig;
  assert.equal(verifyEvent(noSig), false);
  assert.equal(verifyEvent({ ...e, op: 'nuke', sig: e.sig }), false);
  assert.equal(verifyEvent(null), false);
});

test('eventSignature 与属性插入顺序无关（JSON.parse 回来字段顺序变了也能校验）', () => {
  const e = ev({ category: 'attachments' });
  const reordered = {};
  for (const k of [...Object.keys(e)].reverse()) reordered[k] = e[k];
  assert.equal(eventSignature(reordered), e.sig);
});

test('eventId 是 (device, seq)，两台设备同 seq 不冲突', () => {
  assert.equal(eventId(ev()), 'win32:PC:1');
  assert.notEqual(eventId(ev({ device: DEV_B })), eventId(ev()));
});

/* ------------------------------------------------------------ 排序与合并 */

test('compareEvents：ts 大者胜；同一毫秒 delete 优先于 upsert', () => {
  const up = ev({ op: 'upsert' });
  const del = ev({ seq: 2, op: 'delete' });
  assert.ok(compareEvents(up, del) < 0, '同 ts 时 upsert 应排在 delete 前面（后回放者胜）');
  assert.equal(sortEvents([del, up]).at(-1).op, 'delete');
  const later = ev({ seq: 3, ts: TS + 1, op: 'upsert' });
  assert.equal(sortEvents([up, del, later]).at(-1).op, 'upsert', '更晚的写入排在最后');
});

test('mergeEventLogs：去重 + 全局排序，与读入顺序无关', () => {
  const a1 = ev({ device: DEV_A, seq: 1 });
  const a2 = ev({ device: DEV_A, seq: 2, op: 'delete' });
  const b1 = ev({ device: DEV_B, seq: 1, ts: TS + 5 });
  const one = mergeEventLogs([[a1, a2], [b1], [a1]]);
  const two = mergeEventLogs([[b1], [a2, a1], [a1]]);
  assert.deepEqual(one.map(eventId), two.map(eventId));
  assert.equal(one.length, 3);
  assert.equal(one.at(-1).device, DEV_B);
  assert.equal(dedupeEvents([a1, a1, a2]).length, 2);
});

test('nextLocalSeq：只数自己设备的事件', () => {
  const events = [
    ev({ device: DEV_A, seq: 1 }), ev({ device: DEV_A, seq: 7 }),
    ev({ device: DEV_B, seq: 99 }),
  ];
  assert.equal(nextLocalSeq(events, DEV_A), 8);
  assert.equal(nextLocalSeq(events, DEV_B), 100);
  assert.equal(nextLocalSeq([], DEV_A), 1);
});

/* ------------------------------------------------- 完整性判据（fail-closed） */

test('validateEventStream：全部读成、签名有效、seq 连续 → 可信', () => {
  const a = [ev({ seq: 1 }), ev({ seq: 2, op: 'delete' })];
  const b = [ev({ device: DEV_B, seq: 1 })];
  const t = validateEventStream([{ name: 'a', events: a }, { name: 'b', events: b }]);
  assert.equal(t.trusted, true);
  assert.deepEqual(t.gaps, []);
  assert.deepEqual(t.badSignatures, []);
});

test('validateEventStream：读失败 / 坏签名 / seq 缺口 任一出现都不可信', () => {
  const a = [ev({ seq: 1 }), ev({ seq: 3 })];
  const nullRead = validateEventStream([{ name: 'a', events: a }, { name: 'b', events: null }]);
  assert.equal(nullRead.trusted, false);
  assert.ok(nullRead.failed.includes('b'));

  const gap = validateEventStream([{ name: 'a', events: a }]);
  assert.equal(gap.trusted, false);
  assert.deepEqual(gap.gaps, [{ device: DEV_A, from: 2, to: 2 }]);

  const tampered = { ...ev({ seq: 1 }), key: 'rel:hacked' };
  assert.equal(verifyEvent(tampered), false);
  const bad = validateEventStream([{ name: 'a', events: [tampered] }]);
  assert.equal(bad.trusted, false);
  assert.ok(bad.badSignatures.includes('win32:PC:1'));
});

test('validateEventStream：空日志分片算「读成」，不是失败', () => {
  assert.equal(validateEventStream([{ name: 'a', events: [] }]).trusted, true);
});

/* -------------------------------------------------------------- 墓碑 */

test('buildTombstones：delete 生成墓碑，默认保留 30 天，带回收副本路径', () => {
  const del = ev({ seq: 1, op: 'delete', key: 'session:s1', rel: 'sessions/x/s1/f' });
  const [t] = buildTombstones([del], { now: TS });
  assert.equal(t.key, 'session:s1');
  assert.equal(t.deletedAt, TS);
  assert.equal(t.expiresAt, TS + 30 * 24 * 3600 * 1000);
  assert.ok(t.trashRel.startsWith(TRASH_DIR));
  assert.equal(t.by, DEV_A);
});

test('buildTombstones：同一设备上 seq 更大的 upsert 属于「真复活」', () => {
  const del = ev({ seq: 1, op: 'delete', key: 'session:s1' });
  const revive = ev({ seq: 2, ts: TS + 1000, op: 'upsert', key: 'session:s1' });
  assert.equal(buildTombstones([del, revive]).length, 0);

  // 0.7.0：同毫秒不再靠「delete 优先」兜底，而是看**追加顺序**。
  // 同一设备里 seq 更大 = 后写（发布批次里 delete 总排在 upsert 之后，
  // 这条不变），所以 seq 更大的 upsert 同样是真复活。
  const sameMs = ev({ seq: 2, ts: TS, op: 'upsert', key: 'session:s1' });
  assert.equal(buildTombstones([del, sameMs]).length, 0);

  // 反过来：seq 更小的 upsert 在删除之前发生，删除必须留下
  const before = ev({ seq: 1, ts: TS, op: 'upsert', key: 'session:s1' });
  const laterDel = ev({ seq: 2, ts: TS, op: 'delete', key: 'session:s1' });
  assert.equal(buildTombstones([before, laterDel]).length, 1);
});

test('buildTombstones：retentionDays=0 表示永久保留', () => {
  const [t] = buildTombstones([ev({ op: 'delete', retentionDays: 0 })]);
  assert.equal(t.expiresAt, 0);
});

test('mergeTombstones：后写胜且与合并顺序无关', () => {
  const old = buildTombstones([ev({ device: DEV_A, seq: 1, ts: TS, op: 'delete', key: 'k' })]);
  const newer = buildTombstones([ev({ device: DEV_B, seq: 1, ts: TS + 10, op: 'delete', key: 'k' })]);
  assert.equal(mergeTombstones(old, newer)[0].by, DEV_B);
  assert.equal(mergeTombstones(newer, old)[0].by, DEV_B);
});

/* ------------------------------------------------- 向量时钟（0.7.0） */

test('版本向量：不进签名（保证 0.6.x 读端仍认这些事件），但自身要规范化', () => {
  const a = makeEvent({ device: DEV_A, seq: 1, ts: TS, key: 'k', op: 'delete', obs: { [DEV_A]: 1, [DEV_B]: 2 } });
  const b = makeEvent({ device: DEV_A, seq: 1, ts: TS, key: 'k', op: 'delete', obs: { [DEV_B]: 2, [DEV_A]: 1 } });
  assert.equal(a.sig, b.sig, '对象键顺序不同不能算出两个签名');
  assert.equal(canonicalVector({ [DEV_B]: 2, [DEV_A]: 1 }), canonicalVector({ [DEV_A]: 1, [DEV_B]: 2 }));
  assert.equal(canonicalVector({ [DEV_B]: 2, [DEV_A]: 1 }), `${DEV_B}:2,${DEV_A}:1`, '按设备名排序');

  // 关键互操作约束：obs 不进签名 → 同一个事件带不带 obs，签名完全一样。
  // 这样 0.6.x 的读端算出的哈希仍与新端一致，不会把新事件判成「被篡改」。
  const noObs = makeEvent({ device: DEV_A, seq: 1, ts: TS, key: 'k', op: 'delete' });
  const withObs = makeEvent({ device: DEV_A, seq: 1, ts: TS, key: 'k', op: 'delete', obs: { [DEV_B]: 9 } });
  assert.equal(noObs.sig, withObs.sig);
  assert.equal(noObs.obs, undefined);
  // 空 / 全零向量 → 不写进事件
  const emptyObs = makeEvent({ device: DEV_A, seq: 1, ts: TS, key: 'k', op: 'delete', obs: {} });
  assert.equal(emptyObs.obs, undefined);
  assert.equal(normalizeVector({ [DEV_A]: 0, [DEV_B]: NaN }), undefined);
});

test('0.6.x 的历史事件（无 obs）仍能通过校验 —— 升级不能把老日志判成损坏', () => {
  const legacy = { v: 2, device: DEV_A, seq: 4, ts: TS, key: 'session:s1', op: 'delete' };
  legacy.sig = eventSignature(legacy);
  assert.ok(verifyEvent(legacy));
  // 混进新事件一起回放也不影响
  const fresh = makeEvent({ device: DEV_B, seq: 1, ts: TS, key: 'session:s2', op: 'delete', obs: { [DEV_A]: 4 } });
  assert.deepEqual(buildTombstones([legacy, fresh]).map((t) => t.key), ['session:s1', 'session:s2']);
});

test('dominates / compareCausally：因果只看「有没有见过」，与时间戳无关', () => {
  assert.equal(dominates({ a: 3, b: 1 }, { a: 2, b: 1 }), true);
  assert.equal(dominates({ a: 2, b: 1 }, { a: 2, b: 1 }), false, '相等不算支配');
  assert.equal(dominates({ a: 2 }, { a: 3 }), false);

  const del = makeEvent({ device: DEV_A, seq: 5, ts: TS, key: 'k', op: 'delete' });
  const sawIt = makeEvent({ device: DEV_B, seq: 3, ts: TS, key: 'k', op: 'upsert', hash: HASH, obs: { [DEV_A]: 5 } });
  const blind = makeEvent({ device: DEV_B, seq: 3, ts: TS, key: 'k', op: 'upsert', hash: HASH });

  assert.equal(compareCausally(sawIt, del), 'after');
  assert.equal(compareCausally(del, sawIt), 'before');
  assert.equal(compareCausally(blind, del), 'concurrent');
  assert.equal(compareCausally(del, del), 'equal');
  assert.equal(vectorClockOf(sawIt)[DEV_B], 3, '自己的位置由 (device, seq) 补齐');
});

test('时钟偏快不再作弊：ts 大得多但没见过删除 → 并发 → 删除照样赢', () => {
  const del = makeEvent({ device: DEV_A, seq: 5, ts: TS, key: 'session:s1', op: 'delete' });
  // 手机时钟快了 5 分钟：ts 远大于删除，但它从没读过 A 的日志
  const skewed = makeEvent({
    device: DEV_B, seq: 3, ts: TS + 300_000, key: 'session:s1',
    rel: 'sessions/--PHONE/session-s1/f', hash: HASH, op: 'upsert',
  });
  assert.equal(compareCausally(skewed, del), 'concurrent');

  const [t] = buildTombstones([del, skewed]);
  assert.ok(t, '并发时 delete 胜 —— 这正是 0.6.x 按墙钟比较会误复活的地方');
  assert.equal(t.key, 'session:s1');
  assert.equal(t.by, DEV_A);
});

test('真复活：写入者确实见过那条删除，upsert 才赢得干净', () => {
  const del = makeEvent({ device: DEV_A, seq: 5, ts: TS, key: 'session:s1', op: 'delete' });
  const revive = makeEvent({
    device: DEV_B, seq: 3, ts: TS + 1, key: 'session:s1',
    rel: 'sessions/--PHONE/session-s1/f', hash: HASH, op: 'upsert', obs: { [DEV_A]: 5 },
  });
  assert.equal(compareCausally(revive, del), 'after');
  assert.equal(buildTombstones([del, revive]).length, 0);
});

test('buildTombstones 对输入顺序不敏感（可交换、可重放）', () => {
  const del = makeEvent({ device: DEV_A, seq: 5, ts: TS, key: 'session:s1', op: 'delete' });
  const up1 = makeEvent({ device: DEV_B, seq: 1, ts: TS + 10, key: 'session:s2', rel: 'r2', hash: HASH, op: 'upsert' });
  const up2 = makeEvent({ device: DEV_A, seq: 6, ts: TS + 20, key: 'session:s2', rel: 'r2', hash: HASH, op: 'upsert', obs: { [DEV_B]: 1 } });
  const a = buildTombstones([del, up1, up2]);
  const b = buildTombstones([up2, del, up1]);
  const c = buildTombstones([up1, up2, del]);
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
  assert.deepEqual(a.map((t) => t.key), ['session:s1']);
});

test('pickWinner：并发两条 delete 也收敛到同一条代表', () => {
  const d1 = makeEvent({ device: DEV_A, seq: 1, ts: TS, key: 'k', op: 'delete' });
  const d2 = makeEvent({ device: DEV_B, seq: 1, ts: TS + 5, key: 'k', op: 'delete' });
  assert.equal(pickWinner([d1, d2]).device, DEV_B);
  assert.equal(pickWinner([d2, d1]).device, DEV_B);
});

test('旧墓碑（无 vc）保留期兜底：仍按墙钟允许复活，升级前后行为一致', () => {
  const legacyTomb = {
    key: 'session:s1', deletedAt: TS, by: DEV_A, device: DEV_A, seq: 5, expiresAt: 0,
  };
  const later = makeEvent({ device: DEV_B, seq: 1, ts: TS + 1, key: 'session:s1', op: 'upsert', hash: HASH });
  assert.equal(buildTombstones([later], { previous: [legacyTomb] }).length, 0, '墙钟更晚 → 复活');

  const earlier = makeEvent({ device: DEV_B, seq: 1, ts: TS - 1, key: 'session:s1', op: 'upsert', hash: HASH });
  assert.equal(buildTombstones([earlier], { previous: [legacyTomb] }).length, 1, '墙钟更早 → 删除保留');
});

test('新墓碑（带 vc）拒绝「时钟偏快但没见过删除」的复活', () => {
  const del = makeEvent({ device: DEV_A, seq: 5, ts: TS, key: 'session:s1', op: 'delete' });
  const [tomb] = buildTombstones([del]);
  assert.deepEqual(tomb.vc, { [DEV_A]: 5 });

  const skewed = makeEvent({ device: DEV_B, seq: 9, ts: TS + 999_999, key: 'session:s1', op: 'upsert', hash: HASH });
  const kept = buildTombstones([], { previous: [tomb] });
  assert.equal(kept.length, 1, '本轮没有该 key 的事件 → 墓碑原样保留');
  assert.equal(buildTombstones([skewed], { previous: [tomb] }).length, 1, '并发 upsert 撤销不了带 vc 的墓碑');
});

test('tombstoneTargets：key 与 rel 不一致时只按 key 语义删，绝不误删无关文件', () => {
  const dirty = ev({ op: 'delete', key: 'session:s1', rel: 'attachments/a.png' });
  const [t] = buildTombstones([dirty], { now: TS });
  assert.equal(t.rel, 'attachments/a.png');
  assert.deepEqual(tombstoneTargets(t), { rels: [], sid: 's1' });

  const entries = [
    { rel: 'attachments/a.png', mtime: 1, size: 1, hash: 'h0' },
    { rel: 'sessions/--PC/s1/f', mtime: 1, size: 1, hash: 'h1' },
    { rel: 'sessions/--PC/s2/f', mtime: 1, size: 1, hash: 'h2' },
  ];
  assert.deepEqual(
    applyEventsToManifest(entries, [t], [dirty], TS + 1).map((e) => e.rel).sort(),
    ['attachments/a.png', 'sessions/--PC/s2/f'],
  );
  assert.deepEqual(
    stripDeletedEntries(entries, [t], TS + 1).map((e) => e.rel).sort(),
    ['attachments/a.png', 'sessions/--PC/s2/f'],
  );
});

test('isDeleted / collectGc：过期墓碑不再阻挡，并被 GC 挑出来', () => {
  const t = buildTombstones([ev({ op: 'delete', key: 'k' })], { now: TS })[0];
  assert.equal(isDeleted('k', [t], TS + 1), true);
  assert.equal(isDeleted('k', [t], t.expiresAt), false);
  assert.equal(isDeleted('nope', [t], TS + 1), false);
  assert.deepEqual(collectGc([t], t.expiresAt).map((x) => x.key), ['k']);
  assert.deepEqual(collectGc([t], TS + 1), []);
});

/* -------------------------------------------------------------- 位点 */

test('advanceCursor / eventsSince：位点只推进自己见过的位置，增量不重复回放', () => {
  const events = [
    ev({ device: DEV_A, seq: 1 }), ev({ device: DEV_A, seq: 2 }),
    ev({ device: DEV_B, seq: 1 }), ev({ device: DEV_B, seq: 2 }),
  ];
  const cur = advanceCursor(undefined, events, DEV_A, TS);
  const curB = advanceCursor(undefined, events, DEV_B, TS);
  assert.equal(cur.appliedSeq, 2);
  assert.equal(curB.appliedSeq, 2);
  const later = ev({ device: DEV_A, seq: 3 });
  assert.deepEqual(eventsSince([...events, later], [cur, curB]).map(eventId), ['win32:PC:3']);
  // 某台设备没有位点时必须回放它的全部事件，不能静默跳过
  assert.equal(eventsSince([...events, later], [cur]).length, 3);
  const advanced = advanceCursor(cur, [later], DEV_A, TS + 1);
  assert.equal(advanced.appliedSeq, 3);
});

/* ------------------------------------------- 应用到清单（跨路径删除的核心） */

test('applyEventsToManifest：会话墓碑按 sid 删，两端不同 rel 都命中', () => {
  const entries = [
    { rel: 'sessions/--C-Users-Admin/s1/session.v4.jsonl.zstd', mtime: 1, size: 10, hash: 'h1' },
    { rel: 'sessions/--data-user-0-phone/s1/session.v4.jsonl.zstd', mtime: 1, size: 10, hash: 'h2' },
    { rel: 'sessions/--C-Users-Admin/s2/session.v4.jsonl.zstd', mtime: 1, size: 10, hash: 'h3' },
    { rel: 'attachments/a.png', mtime: 1, size: 1, hash: 'h4' },
  ];
  const del = ev({ op: 'delete', key: 'session:s1' });
  const tombs = buildTombstones([del], { now: TS });
  const out = applyEventsToManifest(entries, tombs, [del], TS + 1);
  assert.deepEqual(out.map((e) => e.rel).sort(), [
    'attachments/a.png',
    'sessions/--C-Users-Admin/s2/session.v4.jsonl.zstd',
  ]);
});

test('applyEventsToManifest：被墓碑挡住的 upsert 不补回，未挡住的补回', () => {
  const del = ev({ seq: 1, op: 'delete', key: 'rel:attachments/a.png' });
  const blocked = ev({ seq: 2, ts: TS + 1, op: 'upsert', key: 'rel:attachments/a.png', rel: 'attachments/a.png', hash: HASH });
  const fresh = ev({ seq: 3, ts: TS + 1, op: 'upsert', key: 'rel:skills/k/SKILL.md', rel: 'skills/k/SKILL.md', hash: 'c'.repeat(64) });
  // 墓碑只由 delete 事件生成：把更晚的 upsert 也喂给 buildTombstones 会按
  // 「复活」语义把墓碑撤掉，那是另一条用例，不该混在这里。
  const tombs = buildTombstones([del], { now: TS });
  const out = applyEventsToManifest([], tombs, [del, blocked, fresh], TS + 1);
  assert.equal(out.length, 1);
  assert.equal(out[0].rel, 'skills/k/SKILL.md');
  assert.equal(out[0].hash, 'c'.repeat(64));
});

/* -------------------------------------------------------------- 迁移 / 序列化 */

test('migrateV1ToEvents：只补 upsert 基线，绝不凭空产生 delete', () => {
  const parts = [
    [{ rel: 'a', mtime: 1, size: 1, hash: 'h1' }],
    [{ rel: 'a', mtime: 1, size: 1, hash: 'h1' }, { rel: 'b', mtime: 1, size: 1, hash: 'h2' }],
  ];
  const events = migrateV1ToEvents(parts, DEV_A, TS);
  assert.equal(events.length, 2, '按 rel 去重');
  assert.ok(events.every((e) => e.op === 'upsert'));
  assert.deepEqual([...events.keys()].map((i) => events[i].seq), [1, 2]);
  assert.ok(events.every((e) => verifyEvent(e)));
});

test('parseEventLog：坏行计数并报 corrupted，不静默当空日志', () => {
  const good = ev();
  const text = serializeEventLog([good]) + '{"broken":\n' + JSON.stringify(ev({ seq: 2 })) + '\n';
  const p = parseEventLog(text);
  assert.equal(p.events.length, 2);
  assert.equal(p.badLines, 1);
  assert.equal(p.corrupted, true);
  assert.equal(parseEventLog(serializeEventLog([good])).corrupted, false);
  assert.equal(parseEventLog('').events.length, 0);
  assert.equal(parseEventLog('').corrupted, false);
});

test('parseEventLog：签名不对的行也计入坏行', () => {
  const tampered = { ...ev(), key: 'rel:hacked' };
  const p = parseEventLog(JSON.stringify(tampered) + '\n');
  assert.equal(p.events.length, 0);
  assert.equal(p.corrupted, true);
});

/* ------------------------------------------------------- manifest.ts 适配 */

test('manifestEntryKey：会话条目按 sid 归键', () => {
  assert.equal(manifestEntryKey({ rel: 'sessions/x/s1/f' }), 'session:s1');
  assert.equal(manifestEntryKey({ rel: 'attachments/a' }), 'rel:attachments/a');
});

test('mergeV2Manifests：软删除条目优先，v1 条目不会盖掉 v2 条目', () => {
  const v1 = [{ rel: 'x', mtime: 9, size: 9, hash: 'new' }];
  const v2 = [{ rel: 'x', mtime: 1, size: 1, hash: 'old', version: 2 }];
  assert.equal(mergeV2Manifests([v1, v2])[0].hash, 'old');
  const del = [{ rel: 'x', mtime: 1, size: 0, hash: '', deletedAt: TS, version: 2 }];
  assert.ok(mergeV2Manifests([v2, del])[0].deletedAt);
});

test('stripDeletedEntries：会话墓碑过滤掉两端不同 rel 的同 sid 条目', () => {
  const entries = [
    { rel: 'sessions/--PC/s1/f', mtime: 1, size: 1, hash: 'h1' },
    { rel: 'sessions/--PHONE/s1/f', mtime: 1, size: 1, hash: 'h2' },
    { rel: 'sessions/--PC/s2/f', mtime: 1, size: 1, hash: 'h3' },
  ];
  const tombs = buildTombstones([ev({ op: 'delete', key: 'session:s1' })], { now: TS });
  assert.deepEqual(stripDeletedEntries(entries, tombs, TS + 1).map((e) => e.rel), ['sessions/--PC/s2/f']);
});

test('stripDeletedEntries：墓碑过期后不再过滤（可恢复/复活）', () => {
  const entries = [{ rel: 'attachments/a', mtime: 1, size: 1, hash: 'h' }];
  const tombs = buildTombstones([ev({ op: 'delete', key: 'rel:attachments/a' })], { now: TS });
  assert.equal(stripDeletedEntries(entries, tombs, tombs[0].expiresAt + 1).length, 1);
});

test('toV2Manifest：补齐 version / device / cas，且不丢原字段', () => {
  const out = toV2Manifest([{ rel: 'a', mtime: 1, size: 2, hash: HASH }], DEV_A);
  assert.equal(out[0].version, 2);
  assert.equal(out[0].device, DEV_A);
  assert.equal(out[0].cas, HASH);
  assert.equal(out[0].hash, HASH);
});

/* ------------------------------------------------------------- BidMap / P2 */

test('mergeBidMaps：同 sid 取 version 大的，结果稳定可复现', () => {
  const a = [{ sid: 's1', canonicalRel: 'sessions/by-id/s1/v1', localRel: 'sessions/--PC/s1/f', version: 1 }];
  const b = [{ sid: 's1', canonicalRel: 'sessions/by-id/s1/v2', localRel: 'sessions/--PHONE/s1/f', version: 2 }];
  assert.equal(mergeBidMaps([a, b])[0].version, 2);
  assert.equal(mergeBidMaps([b, a])[0].version, 2);
  assert.equal(bidMapLookup(mergeBidMaps([a, b]), 's1').canonicalRel, 'sessions/by-id/s1/v2');
  assert.equal(bidMapLookup([], 'nope'), null);
});

test('0.6.0 / 收尾②：回收站副本没有会话身份，必须回落到 rel 空间', () => {
  const rel = 'sessions/.sessions-trash/2026-11-09T10-52-22.155Z---enc---session-11111111-1111-4111-8111-111111111111/session.v4.jsonl.zstd.trash';
  // 倒数第二段是回收站目录名，不是 sid；误抽会得到 `session:2026-11-09T...` 这种假键
  assert.equal(sessionIdFromRel(rel), null);
  assert.equal(stableKeyOf(rel), 'rel:' + rel);
  // 正常会话仍按 sid 归键
  assert.equal(
    sessionIdFromRel('sessions/--enc--/session-11111111-1111-4111-8111-111111111111/session.v4.jsonl.zstd'),
    'session-11111111-1111-4111-8111-111111111111',
  );
});
