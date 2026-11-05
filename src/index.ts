/**
 * dsh-nas-sync · 插件主入口（Host 半）
 * ------------------------------------
 * 注册内容：
 *  - 设置命名空间 nas-sync（客户端半通过同名 key 绑定）
 *  - 工具：nas_sync_status / nas_sync_subscribe / nas_pending_files_page
 *          nas_get_conflicts / nas_resolve_conflict / nas_sync
 *          nas_stop_sync / nas_test / nas_try_merge / nas_get_file_diff
 */

import { definePlugin } from '@deepseek-ai/dsh-core';
import { installSettingsSection } from '@deepseek-ai/dsh-settings';
import { createTransport } from './nas/index.js';
import { Engine } from './sync/engine.js';
import { mergeThreeWay, diffLines, isMergeable } from './sync/merger.js';
import { ConfigSchema, NS_NAS_SYNC, Store, loadConfig, updateConfig, type NasSyncConfig } from './config.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ConflictItem, ConflictPage, DiffLine, MergeResult, PageResult, PendingFile, PendingPage, SyncSnapshot } from './data/models.js';

export default definePlugin({
  name: 'nas-sync',
  setup(ctx) {
    const profileDir = ctx.profile?.dataDir ?? join(process.env.HOME ?? '', '.dsh/profiles', 'web');
    const store = new Store(profileDir);

    let config: NasSyncConfig = loadConfig();
    let engine: Engine | null = null;

    const rebuildEngine = (): Engine => {
      const transport = createTransport(config);
      engine = new Engine({ transport, store, config });
      return engine;
    };
    rebuildEngine();

    // ---- 设置命名空间（Host 半） ----
    installSettingsSection(ctx, {
      namespace: NS_NAS_SYNC,
      schema: ConfigSchema,
      current: config,
      onSave: async (next) => {
        updateConfig(next as NasSyncConfig);
        config = next as NasSyncConfig;
        rebuildEngine();
        store.save();
      },
    });

    // ---- nas_sync_status：完整快照（兼容旧调用方） ----
    ctx.registerTool('nas_sync_status', async (): Promise<{
      lastSyncTime: number | null;
      progress: SyncSnapshot['progress'];
      pendingFiles: PendingFile[];
      conflicts: ConflictItem[];
    }> => {
      await ensureScanned();
      return {
        lastSyncTime: store.snapshot.lastSyncTime,
        progress: store.snapshot.progress,
        pendingFiles: store.pendingFiles,
        conflicts: store.conflicts,
      };
    });

    // ---- nas_sync_subscribe：轻量快照，客户端定时轮询 ----
    ctx.registerTool('nas_sync_subscribe', async (): Promise<SyncSnapshot> => {
      await ensureScanned();
      return store.snapshot;
    });

    // ---- nas_pending_files_page：分页（默认 50 条） ----
    ctx.registerTool('nas_pending_files_page', async (args: Record<string, string>): Promise<PendingPage> => {
      await ensureScanned();
      const page = Math.max(1, Number(args.page ?? 1));
      const pageSize = Math.min(200, Math.max(1, Number(args.pageSize ?? 50)));
      const start = (page - 1) * pageSize;
      return {
        items: store.pendingFiles.slice(start, start + pageSize),
        total: store.pendingFiles.length,
        page,
        pageSize,
      };
    });

    // ---- nas_get_conflicts：分页 ----
    ctx.registerTool('nas_get_conflicts', async (args: Record<string, string>): Promise<ConflictItem[]> => {
      await ensureScanned();
      const page = Math.max(1, Number(args?.page ?? 1));
      const pageSize = Math.min(200, Math.max(1, Number(args?.pageSize ?? 50)));
      const start = (page - 1) * pageSize;
      return store.conflicts.slice(start, start + pageSize);
    });

    // ---- nas_resolve_conflict ----
    ctx.registerTool('nas_resolve_conflict', async (args: Record<string, string>): Promise<{ success: boolean }> => {
      if (!engine) engine = rebuildEngine();
      await engine.resolve(args.file, args.resolution as any);
      return { success: true };
    });

    // ---- nas_sync ----
    ctx.registerTool('nas_sync', async (args: Record<string, string>): Promise<{ pushed: number; pulled: number; conflicts: number }> => {
      if (!engine) engine = rebuildEngine();
      return engine.sync((args.mode as any) ?? 'mirror');
    });

    // ---- nas_stop_sync ----
    ctx.registerTool('nas_stop_sync', async (): Promise<{ stopped: boolean }> => {
      if (engine?.isRunning()) {
        engine.stop();
        return { stopped: true };
      }
      return { stopped: false };
    });

    // ---- nas_test ----
    ctx.registerTool('nas_test', async (): Promise<boolean> => {
      try {
        const t = createTransport(config);
        return await t.test();
      } catch {
        return false;
      }
    });

    // ---- nas_try_merge：三路合并 ----
    ctx.registerTool('nas_try_merge', async (args: Record<string, string>): Promise<MergeResult> => {
      const rel = args.file;
      if (!isMergeable(rel)) return { success: false, reason: '该文件类型不支持自动合并' };

      const home = process.env.HOME ?? '';
      const localPath = join(home, '.dsh', rel);
      let local: string;
      try {
        local = (await readFile(localPath)).toString('utf-8');
      } catch {
        return { success: false, reason: '本地文件不存在' };
      }

      let remote: string;
      try {
        const t = createTransport(config);
        const enc = await t.getBuffer('/dsh/' + rel);
        // 复用引擎解密逻辑
        const { Crypto } = await import('./sync/crypto.js');
        remote = new TextDecoder().decode(await Crypto.decrypt(enc, config.passphrase));
      } catch (e) {
        return { success: false, reason: '无法读取远程版本：' + (e as Error).message };
      }

      // base：上一次成功同步时的本地内容，若无可退化成空串
      let base = '';
      const snapBase = store.snapshot.lastSyncTime;
      if (snapBase) {
        try {
          const t = createTransport(config);
          const enc = await t.getBuffer('/dsh/' + rel + '.base');
          const { Crypto } = await import('./sync/crypto.js');
          base = new TextDecoder().decode(await Crypto.decrypt(enc, config.passphrase));
        } catch {
          base = '';
        }
      }

      return mergeThreeWay(base, local, remote);
    });

    // ---- nas_get_file_diff：行级 diff ----
    ctx.registerTool('nas_get_file_diff', async (args: Record<string, string>): Promise<DiffLine[]> => {
      const rel = args.file;
      const home = process.env.HOME ?? '';
      let local = '';
      try {
        local = (await readFile(join(home, '.dsh', rel))).toString('utf-8');
      } catch {
        /* 本地不存在 */
      }
      let remote = '';
      try {
        const t = createTransport(config);
        const { Crypto } = await import('./sync/crypto.js');
        const enc = await t.getBuffer('/dsh/' + rel);
        remote = new TextDecoder().decode(await Crypto.decrypt(enc, config.passphrase));
      } catch {
        /* 远端不存在 */
      }
      return diffLines(local.split(/\r?\n/), remote.split(/\r?\n/));
    });

    // ---- 自动同步定时器 ----
    let timer: ReturnType<typeof setInterval> | null = null;
    const schedule = (): void => {
      if (timer) clearInterval(timer);
      if (config.autoSync?.enabled && config.autoSync.intervalMin > 0) {
        timer = setInterval(() => {
          if (engine && !engine.isRunning()) {
            engine.sync(config.autoSync!.mode).catch((e: Error) => {
              ctx.logger.warn('[nas-sync] 自动同步失败：' + e.message);
            });
          }
        }, config.autoSync.intervalMin * 60_000);
      }
    };
    schedule();

    // 配置变更后重设定时器
    ctx.on('settings-changed', schedule);

    ctx.logger.info('[nas-sync] 已加载，传输方式：' + config.type);

    // ---- 内部：确保扫描过一次，避免空列表 ----
    let scanned = false;
    async function ensureScanned(): Promise<void> {
      if (scanned) return;
      if (!engine) engine = rebuildEngine();
      try {
        await engine['scan']();
      } catch (e) {
        ctx.logger.warn('[nas-sync] 预扫描失败：' + (e as Error).message);
      }
      scanned = true;
    }
  },
});

export { NS_NAS_SYNC } from './config.js';
export type { NasSyncConfig } from './config.js';
