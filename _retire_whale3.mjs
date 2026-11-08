/**
 * 一次性：电脑端撤掉「鲸鱼宠物」的 3 个会话（2 个空壳 + 数据库同步问题），
 * 并写入 importIgnores 让插件以后不再把它们拉回来。
 *
 * 为什么不能只删文件：远端原文还在 NAS/手机上，下一轮扫描立刻判定
 * 「远端有、本地无」→ 又下载回来。必须同时记一条本机屏蔽。
 */
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { unregisterSessionFromRel, encodeCwd } from './dist-test/portable.mjs';

const HOME = 'C:/Users/Administrator/.dsh';
const PHONE_ENC = '--data-user-0-com.dsh.harness-files-home-~9CB8~9C7C~5BA0~7269--';
const OK_DIR = join(HOME, 'nassyncworkspaces', '鲸鱼宠物');
const PC_ENC = encodeCwd(OK_DIR);
const STAMP = 'manual-20261108-whale';

const SIDS = [
  'session-23009990-3a0e-42b1-a5f5-071147fe3dac', // 空壳
  'session-45b8fb6b-60d5-4adb-b78b-9479ecbe2cae', // 空壳
  'session-bd10402b-112e-4079-8f3e-e3600e221594', // 数据库同步问题
];
const FILE = 'session.v4.jsonl.zstd';

// ① 屏蔽清单
const storePath = join(HOME, 'nas-sync', 'store.json');
const store = JSON.parse(readFileSync(storePath, 'utf8'));
store.importIgnores = store.importIgnores ?? {};
const now = new Date().toISOString();
for (const sid of SIDS) {
  const remoteRel = `sessions/${PHONE_ENC}/${sid}/${FILE}`;
  store.importIgnores[remoteRel] = now;
  if (store.sessionImports?.[remoteRel]) delete store.sessionImports[remoteRel];
}
writeFileSync(storePath + '.manual.tmp', JSON.stringify(store, null, 2));
copyFileSync(storePath + '.manual.tmp', storePath);
console.log('① 已写入屏蔽清单，条目数', Object.keys(store.importIgnores).length);

// ② 本地会话搬去回收目录（不硬删）
const trashRoot = join(HOME, 'nas-sync', 'removed', STAMP);
mkdirSync(trashRoot, { recursive: true });
for (const sid of SIDS) {
  const dir = join(HOME, 'sessions', PC_ENC, sid);
  if (!existsSync(dir)) {
    console.log('  - 本地没有，跳过', sid);
    continue;
  }
  renameSync(dir, join(trashRoot, sid));
  console.log('  - 已回收', sid);
}

// ③ 清登记
for (const sid of SIDS) {
  const localRel = `sessions/${PC_ENC}/${sid}/${FILE}`;
  const ok = await unregisterSessionFromRel(localRel, HOME);
  console.log('  - 清登记', sid, ok ? 'ok' : '（本来就没登记）');
}
