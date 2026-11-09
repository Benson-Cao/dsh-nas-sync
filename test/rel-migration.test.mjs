/**
 * 收尾① · 会话 rel 迁移纯函数契约测试
 * 不碰 fs / 网络：只验证「计划 → 校验 → 双读 → 单写 → 账本」这条链。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isLegacySessionRel, isCanonicalSessionRel, legacyCwdSegment,
  legacyRelToCanonical, canonicalRelToLocal, planRelMigration, validateRelPlan,
  rewriteManifestForMode, mergeDualRead, buildMigrationMarker, legacyProtected,
  bidMapFromPlan, MIGRATION_MARKER_PATH,
} from '../dist-test/rel-migration.mjs';

const PC_SEG = '--C-Users-Administrator-wstest--';
const PH_SEG = '--data-user-0-com-dsh-harness-files-home-wstest--';
const SID = '1f6a2c90-aaaa-bbbb-cccc-1234567890ab';
const FILE = 'session.v1.jsonl.zstd';
const PC_REL = `sessions/${PC_SEG}/${SID}/${FILE}`;
const PH_REL = `sessions/${PH_SEG}/${SID}/${FILE}`;
const CANON = `sessions/by-id/${SID}/v1/${FILE}`;

const e = (rel, hash = 'h1', extra = {}) => ({ rel, mtime: 1000, size: 12, hash, ...extra });

test('rel 形态识别：legacy / canonical / 非会话互不混淆', () => {
  assert.equal(isLegacySessionRel(PC_REL), true);
  assert.equal(isLegacySessionRel(PH_REL), true);
  assert.equal(isLegacySessionRel(CANON), false);
  assert.equal(isCanonicalSessionRel(CANON), true);
  assert.equal(isCanonicalSessionRel(PC_REL), false);
  assert.equal(isLegacySessionRel('attachments/a.png'), false);
  assert.equal(isCanonicalSessionRel('sessions/by-id/x/notv/file'), false);
  assert.equal(legacyCwdSegment(PC_REL), PC_SEG);
  assert.equal(legacyCwdSegment(CANON), null);
});

test('legacy → canonical 按 sid 归一键，两端不同 cwd 得到同一个目标', () => {
  assert.equal(legacyRelToCanonical(PC_REL), CANON);
  assert.equal(legacyRelToCanonical(PH_REL), CANON);
  assert.equal(legacyRelToCanonical(PC_REL, 3), `sessions/by-id/${SID}/v3/${FILE}`);
  assert.equal(legacyRelToCanonical('attachments/a.png'), null);
});

test('canonical → 本地落地必须换成本机 cwd 编码，不能照抄远端段', () => {
  assert.equal(canonicalRelToLocal(CANON, PH_SEG), PH_REL);
  assert.equal(canonicalRelToLocal(CANON, PC_SEG), PC_REL);
  assert.equal(canonicalRelToLocal(PC_REL, PH_SEG), null);
  assert.equal(canonicalRelToLocal(CANON, ''), null);
  const escaped = canonicalRelToLocal(CANON, '../evil');
  assert.ok(escaped && !escaped.includes('..') && !escaped.includes('/../'),
    '传入恶意 cwd 段时不得产生路径穿越：' + escaped);
  assert.ok(escaped.endsWith(SID + '/' + FILE));
});

test('planRelMigration：两端同 sid 不同 cwd 合并成一条映射，且与输入顺序无关', () => {
  const entries = [
    e(PC_REL, 'same', { device: 'win32:PC' }),
    e(PH_REL, 'same', { device: 'android:PHONE' }),
    e('attachments/a.png'),
  ];
  const a = planRelMigration(entries, { now: 1000 });
  const b = planRelMigration([...entries].reverse(), { now: 1000 });
  assert.deepEqual(a.mappings, b.mappings, '计划必须与输入顺序无关');
  assert.equal(a.mappings.length, 1);
  assert.equal(a.mappings[0].canonicalRel, CANON);
  assert.equal(a.mappings[0].device, 'android:PHONE', '同 hash 取设备名字典序最小，保证稳定');
  assert.equal(a.untouched, 1);
  assert.equal(a.alreadyCanonical, 0);
  assert.equal(a.collisions.length, 0);
});

test('planRelMigration：同名不同内容必须列为冲突，绝不自动挑一份', () => {
  const entries = [e(PC_REL, 'hash-A'), e(PH_REL, 'hash-B')];
  const plan = planRelMigration(entries, { now: 1 });
  assert.equal(plan.mappings.length, 0);
  assert.equal(plan.collisions.length, 1);
  assert.deepEqual(plan.collisions[0].legacyRels, [PC_REL, PH_REL].sort());
  const v = validateRelPlan(plan);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((x) => x.includes('人工裁决')));
  assert.ok(v.errors.some((x) => x.includes('没有需要迁移')));
});

test('validateRelPlan：空计划 / 非法 rel / 路径穿越全部挡住', () => {
  assert.equal(validateRelPlan({ mappings: [], collisions: [], skipped: [] }).ok, false);
  const bad = planRelMigration([e(PC_REL)], { now: 1 });
  bad.mappings[0].canonicalRel = 'sessions/../evil';
  assert.equal(validateRelPlan(bad).ok, false);
  const good = planRelMigration([e(PC_REL)], { now: 1 });
  assert.equal(validateRelPlan(good).ok, true);
});

test('rewriteManifestForMode：legacy 字节不变，shadow 双写，canonical 只留新空间', () => {
  const entries = [e(PC_REL), e('attachments/a.png')];
  const plan = planRelMigration(entries, { now: 1 });
  assert.deepEqual(rewriteManifestForMode(entries, 'legacy', plan), entries);
  const shadow = rewriteManifestForMode(entries, 'shadow', plan);
  assert.deepEqual(shadow.map((x) => x.rel).sort(), [PC_REL, CANON, 'attachments/a.png'].sort());
  assert.equal(shadow.find((x) => x.rel === CANON).hash, 'h1', '副本只是别名，内容指纹相同');
  const canon = rewriteManifestForMode(entries, 'canonical', plan);
  assert.deepEqual(canon.map((x) => x.rel).sort(), [CANON, 'attachments/a.png'].sort());
  assert.equal(canon.some((x) => x.rel === PC_REL), false);
});

test('mergeDualRead：两个空间按 sid 归并，不重复计数，canonical 优先', () => {
  const merged = mergeDualRead([
    e(PC_REL, 'old', { mtime: 1000 }),
    e(PH_REL, 'old', { mtime: 1100 }),
    e(CANON, 'new', { mtime: 2000 }),
    e('attachments/a.png'),
  ]);
  assert.equal(merged.length, 2, '三条会话别名只应留一条');
  assert.equal(merged.find((x) => x.rel === CANON).hash, 'new');
  assert.ok(merged.some((x) => x.rel === 'attachments/a.png'));
  const onlyLegacy = mergeDualRead([e(PC_REL), e(PH_REL)]);
  assert.equal(onlyLegacy.length, 2, '尚无 canonical 时保留两条 legacy，不丢数据');
});

test('marker 与保留窗口：窗口内禁止删旧对象', () => {
  const plan = planRelMigration([e(PC_REL)], { now: 1000 });
  const marker = buildMigrationMarker(plan, 'win32:PC', 1000, 30);
  assert.equal(marker.migrated, 1);
  assert.equal(marker.fromMode, 'legacy');
  assert.equal(marker.keepLegacyUntil, 1000 + 30 * 86_400_000);
  assert.equal(legacyProtected(marker, 1001), true);
  assert.equal(legacyProtected(marker, 1000 + 31 * 86_400_000), false);
  assert.equal(legacyProtected(null, 1000), false);
  assert.equal(MIGRATION_MARKER_PATH, '/dsh/migration.json');
});

test('bidMapFromPlan：每条映射给出本机落地 rel 与原始 cwd 溯源', () => {
  const plan = planRelMigration([e(PC_REL, 'h1')], { now: 1 });
  const map = bidMapFromPlan(plan, () => PH_SEG);
  assert.equal(map.length, 1);
  assert.equal(map[0].sid, SID);
  assert.equal(map[0].canonicalRel, CANON);
  assert.equal(map[0].localRel, PH_REL, '本机落地用本机 cwd 段');
  assert.equal(map[0].originalCwd, PC_SEG, '溯源保留来源 cwd 段');
  assert.equal(map[0].hash, 'h1');
});
