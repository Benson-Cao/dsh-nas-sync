/**
 * Store 持久化 / 迁移的离线单测（0.5.9）
 *
 * 这是本轮风险最高的一处改动：store.json 里装着加密口令与 scrypt salt，
 * 一旦迁移写错，用户的 NAS 同步会直接失联、历史密文再也解不开。
 * 因此用真实的 `new Store()` 在临时 $DSH_HOME 上跑一遍「老格式 → 新格式 → 重启」。
 *
 * 断言只检查「字段是否存在/是否相等」，**不打印任何口令值**。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { Store } = await import('../dist-test/config.mjs');

const SALT = '0123456789abcdef0123456789abcdef';
const PASS = 'P-SECRET-DO-NOT-LOG';
const WD_PASS = 'W-SECRET-DO-NOT-LOG';

function legacyState() {
  return {
    saltHex: SALT,
    snapshot: { lastSyncTime: 111, phase: 'scanning', running: true, pendingCount: 3 },
    pendingFiles: [{ rel: 'sessions/a/s1/session.v4.jsonl.zstd' }],
    conflicts: [],
    localManifest: [{ rel: 'x', size: 1 }],
    userConfig: {
      type: 'webdav',
      passphrase: PASS,
      webdav: { url: 'https://nas.example/dav', username: 'u', password: WD_PASS },
      autoSync: { enabled: true, intervalMin: 5 },
    },
    sessionImports: {
      'sessions/x/sid/session.v4.jsonl.zstd': {
        remoteHash: 'h', localRel: 'r', localHash: 'l', originalCwd: '/p', missingRounds: 1,
      },
    },
  };
}

/** 每个用例一个独立 $DSH_HOME；paths.ts 的替身从 DSH_HOME_TEST 读取。 */
function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-store-'));
  const dir = join(home, 'nas-sync');
  const prev = process.env.DSH_HOME_TEST;
  process.env.DSH_HOME_TEST = home;
  try { return fn(home, dir); }
  finally {
    if (prev === undefined) delete process.env.DSH_HOME_TEST;
    else process.env.DSH_HOME_TEST = prev;
  }
}

function writeLegacy(dir, state) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'store.json'), JSON.stringify(state, null, 2), 'utf8');
}

test('0.5.9 老格式迁移：口令拆走、salt 独立、其它字段一个不丢', () => {
  withHome((_home, dir) => {
    const state = legacyState();
    writeLegacy(dir, state);

    const store = new Store();

    // 内存态：口令还在，配置层才能正常连 NAS
    assert.equal(store.userConfig.passphrase, PASS);
    assert.equal(store.userConfig.webdav.password, WD_PASS);
    assert.equal(store.userConfig.webdav.url, 'https://nas.example/dav');
    assert.equal(store.userConfig.autoSync.intervalMin, 5);
    // salt：老 store.json 里的值被搬到独立文件
    assert.equal(store.saltHex, SALT);
    assert.equal(readFileSync(join(dir, 'salt.hex'), 'utf8').trim(), SALT);
    // 僵尸态清理与逐字段恢复
    assert.equal(store.snapshot.running, false);
    assert.equal(store.snapshot.phase, 'idle');
    assert.equal(store.snapshot.lastSyncTime, 111);
    assert.deepEqual(store.sessionImports, state.sessionImports);
    assert.deepEqual(store.pendingFiles, state.pendingFiles);
    assert.deepEqual(store.localManifest, state.localManifest);

    // 落盘：store.json 里不能再出现任何口令值
    const raw = readFileSync(join(dir, 'store.json'), 'utf8');
    assert.ok(!raw.includes(PASS), 'store.json 仍含 passphrase');
    assert.ok(!raw.includes(WD_PASS), 'store.json 仍含 webdav.password');
    const creds = JSON.parse(readFileSync(join(dir, 'credentials.json'), 'utf8'));
    assert.equal(creds.passphrase, PASS);
    assert.equal(creds.webdav.password, WD_PASS);

    // 再构造一次 = 模拟 DSH 重启，配置与 salt 必须原样回来
    const restarted = new Store();
    assert.equal(restarted.userConfig.passphrase, PASS);
    assert.equal(restarted.userConfig.webdav.password, WD_PASS);
    assert.equal(restarted.saltHex, SALT);
    assert.deepEqual(restarted.sessionImports, state.sessionImports);
    assert.equal(restarted.lastError, null);
  });
});

test('0.5.9 store.json 损坏：salt 仍可恢复、凭据不丢、留证且显式报错', () => {
  withHome((_home, dir) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'salt.hex'), SALT + '\n', 'utf8');
    writeFileSync(join(dir, 'credentials.json'), JSON.stringify({ passphrase: PASS, webdav: { password: WD_PASS } }), 'utf8');
    writeFileSync(join(dir, 'store.json'), '{ 半截 JSON', 'utf8');

    const store = new Store();
    assert.equal(store.saltHex, SALT, 'store.json 坏了也不能丢 salt');
    assert.equal(store.userConfig.passphrase, PASS);
    assert.equal(store.userConfig.webdav.password, WD_PASS);
    assert.ok(store.lastError && store.lastError.includes('状态文件损坏'), '必须显式报错，不能静默吞掉');
    assert.ok(
      readdirSync(dir).some((n) => n.startsWith('store.json.corrupt-')),
      '坏文件必须留一份副本',
    );
    // 重写后 store.json 恢复可解析
    assert.doesNotThrow(() => JSON.parse(readFileSync(join(dir, 'store.json'), 'utf8')));
  });
});

test('0.5.9 单个字段类型不对不牵连其它字段（不再整份重置）', () => {
  withHome((_home, dir) => {
    const state = legacyState();
    state.snapshot = 'oops';   // 合法 JSON，但字段类型错
    writeLegacy(dir, state);

    const store = new Store();
    assert.equal(store.snapshot.phase, 'idle');   // 该项退回默认值
    assert.equal(store.userConfig.passphrase, PASS);
    assert.deepEqual(store.sessionImports, state.sessionImports, '其它字段不该被一起清空');
    assert.deepEqual(store.pendingFiles, state.pendingFiles);
    assert.equal(store.saltHex, SALT);
  });
});

test('0.5.9 save() 反复调用不产生临时文件、凭据文件不反复重写', () => {
  withHome((_home, dir) => {
    writeLegacy(dir, legacyState());
    const store = new Store();
    const credPath = join(dir, 'credentials.json');
    const before = readFileSync(credPath, 'utf8');
    for (let i = 0; i < 15; i++) {
      store.snapshot.pendingCount = i;
      store.save();
    }
    assert.equal(readFileSync(credPath, 'utf8'), before, '凭据未变化就不该重写');
    assert.deepEqual(
      readdirSync(dir).filter((n) => n.includes('.tmp-')),
      [],
    );
    assert.ok(existsSync(join(dir, 'store.json')));
    assert.equal(JSON.parse(readFileSync(join(dir, 'store.json'), 'utf8')).snapshot.pendingCount, 14);
  });
});
