/**
 * dsh-nas-sync · 插件主入口（r2 重写，对齐真实宿主 API）
 * -------------------------------------------------------
 * 真实插件形态（取证自 @deepseek-ai/dsh-tool-todo / dsh-agent-presets / dsh-settings）：
 *   export const name / inject / apply(ctx, config)，Config 可选。
 *   工具：ctx.tools.register(defineTool({ name, description, parameters, output:{schema,render}, execute }))
 *         —— parameters / output.schema 是「spec 对象」，不是 schemastery。
 *   设置：ctx.settings.register(ns, schema, { base }) -> SettingsScope{get/watch/update/replace}。
 *   定时：全局 setInterval + ctx.on('dispose') 清理（不依赖 timer 服务注入）。
 *
 * 工具清单（11 个）：
 *   nas_sync_status / nas_sync_subscribe / nas_sync_scope / nas_pending_files_page / nas_get_conflicts
 *   nas_resolve_conflict / nas_sync / nas_stop_sync / nas_test / nas_try_merge / nas_get_file_diff
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createTransport } from './nas/index.js';
import { Engine } from './sync/engine.js';
import { SYNC_CATEGORIES, summarizeCategories, listSkills } from './sync/scanner.js';
import { mergeThreeWay, diffLines, isMergeable } from './sync/merger.js';
import {
  NasSyncSchema, NS_NAS_SYNC, Store, parseNasSyncConfig,
  normalizeSyncScope, enabledScopeKeys, normalizeSkillFilter, normalizeCustomFolders,
  type NasSyncConfig, type SyncScopeKey,
} from './config.js';
import { localOf } from './paths.js';
import { createBridge } from './bridge.js';
import type { ConflictItem, DiffLine, MergeResult, PendingFile, SyncSnapshot } from './data/models.js';

export const name = 'dsh-nas-sync';
export const inject = ['tools', 'settings', 'webServer'];

/** 人类可读的体积（用于工具文本渲染，不进 schema）。 */
function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
/** 入口配置 schema（patch insert 的 config 层）；运行期配置走 settings 命名空间。 */
export const Config = NasSyncSchema;

// ---------------------------------------------------------------------------
// 工具输出 schema 复用块（spec 对象，非 schemastery）
// ---------------------------------------------------------------------------

const snapshotSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    lastSyncTime: { type: 'json', description: '上次成功同步的毫秒时间戳，或 null' },
    phase: { type: 'string', enum: ['idle', 'scanning', 'uploading', 'downloading', 'error'] },
    progress: {
      type: 'object',
      additionalProperties: false,
      properties: { total: { type: 'integer' }, done: { type: 'integer' }, errors: { type: 'integer' } },
    },
    pendingCount: { type: 'integer' },
    conflictCount: { type: 'integer' },
    running: { type: 'boolean' },
  },
} as const;

function snapshotValue(s: SyncSnapshot) {
  return {
    lastSyncTime: s.lastSyncTime ?? null,
    phase: s.phase,
    progress: { total: s.progress.total, done: s.progress.done, errors: s.progress.errors },
    pendingCount: s.pendingCount,
    conflictCount: s.conflictCount,
    running: s.running,
  } as any;
}

const pendingItemSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    rel: { type: 'string' },
    size: { type: 'integer' },
    action: { type: 'string', enum: ['upload', 'download', 'delete'] },
  },
} as const;

const conflictItemSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    rel: { type: 'string' },
    localMtime: { type: 'json' },
    remoteMtime: { type: 'json' },
    localHash: { type: 'string' },
    remoteHash: { type: 'string' },
    mergeable: { type: 'boolean' },
  },
} as const;

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

function apply(ctx: any, config: any): void {
  const log = (msg: string): void => {
    try { ctx.logger?.info?.(msg); } catch { console.log('[nas-sync] ' + msg); }
  };
  const warn = (msg: string): void => {
    try { ctx.logger?.warn?.(msg); } catch { console.warn('[nas-sync] ' + msg); }
  };

  const store = new Store();

  // ---- 配置（自管，不依赖宿主 settings 服务） ----
  // 优先级：schema 默认 < patch entry config（base） < store.json 里的用户层
  // 手机引擎 0.2.1-rc.5 的 ctx.settings 是 SettingsForms（UI 表单），没有旧版
  // SettingsProvider.register()；为了跨版本可用，配置由插件自己持久化。
  // 若宿主恰好提供旧版 register API 则顺带挂上（可选增强，失败不影响）。
  let cfg: NasSyncConfig = parseNasSyncConfig({ ...(config ?? {}), ...(store.userConfig ?? {}) });
  let engine = buildEngine(cfg);

  function buildEngine(next: NasSyncConfig): Engine {
    const transport = createTransport(next);
    return new Engine({ transport, store, config: next });
  }

  /** 更新配置（工具入口）：校验 → 持久化 → 重建引擎 → 重设定时器。二级对象（webdav/autoSync）做浅合并，避免未填字段被抹掉。 */
  function applyConfigPatch(patch: Record<string, unknown>): NasSyncConfig {
    const merged: Record<string, unknown> = { ...cfg };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (v && typeof v === 'object' && !Array.isArray(v) && merged[k] && typeof merged[k] === 'object') {
        merged[k] = { ...(merged[k] as Record<string, unknown>), ...(v as Record<string, unknown>) };
      } else {
        merged[k] = v;
      }
    }
    const next = parseNasSyncConfig(merged);
    // 持久化用户层（同样二级合并，保证未填的 secret 字段不丢）
    const prev = store.userConfig ?? {};
    const uc: Record<string, unknown> = { ...prev };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (v && typeof v === 'object' && !Array.isArray(v) && uc[k] && typeof uc[k] === 'object') {
        uc[k] = { ...(uc[k] as Record<string, unknown>), ...(v as Record<string, unknown>) };
      } else {
        uc[k] = v;
      }
    }
    store.userConfig = uc;
    store.save();
    cfg = next;
    engine = buildEngine(next);
    scheduleAutoSync();
    log('配置已更新并持久化（type=' + next.type + '）');
    return next;
  }

  // ---- Web UI HTTP 桥（侧栏面板的数据通道） ----
  createBridge(ctx, {
    getEngine: () => engine,
    getConfig: () => cfg,
    patchConfig: (patch) => applyConfigPatch(patch),
    store,
    ensureScanned,
  });

  // 可选增强：宿主有旧版 SettingsProvider（0.1.x）时挂命名空间，双写保持同步
  try {
    const scope = ctx.settings?.register?.(NS_NAS_SYNC, NasSyncSchema, { base: config ?? {} });
    if (scope && typeof scope.watch === 'function') {
      scope.watch((next: NasSyncConfig) => {
        cfg = next;
        engine = buildEngine(next);
        scheduleAutoSync();
      });
      log('宿主 settings 服务可用，已注册命名空间 ' + NS_NAS_SYNC);
    }
  } catch {
    warn('宿主 settings 服务不可用，改用自管配置（nas_set_config 工具修改）');
  }

  // ---- 懒扫描：状态类工具第一次调用时扫一次，避免空列表 ----
  let scanned = false;
  async function ensureScanned(): Promise<void> {
    if (scanned || engine.isRunning()) return;
    try {
      await engine.scan();
    } catch (e) {
      warn('预扫描失败：' + (e as Error).message);
    }
    scanned = true;
  }

  function snapshot(): SyncSnapshot {
    return store.snapshot;
  }

  // ---- 定时自动同步（全局 setInterval，dispose 清理） ----
  let timer: ReturnType<typeof setInterval> | null = null;
  function scheduleAutoSync(): void {
    if (timer) { clearInterval(timer); timer = null; }
    const auto = cfg.autoSync;
    if (auto?.enabled && auto.intervalMin > 0) {
      timer = setInterval(() => {
        if (engine.isRunning()) return;
        engine.sync(auto.mode).catch((e: Error) => warn('自动同步失败：' + e.message));
      }, auto.intervalMin * 60_000);
      log('自动同步已启用：每 ' + auto.intervalMin + ' 分钟（' + auto.mode + '）');
    }
  }
  ctx.on('dispose', () => {
    if (timer) { clearInterval(timer); timer = null; }
    engine.stop();
  });
  scheduleAutoSync();

  // ---- 工具注册 ----

  // 1. nas_sync_status：完整快照
  ctx.tools.register(defineTool({
    name: 'nas_sync_status',
    description: '查询 NAS 同步插件的完整状态快照：上次同步时间、当前阶段、进度、待同步数与冲突数。首次调用会触发一次扫描。',
    parameters: {},
    output: {
      schema: snapshotSchema,
      render: (_args: any, value: any) => [{
        type: 'text',
        text: `同步状态：${value.running ? '进行中(' + value.phase + ')' : '空闲'}，待同步 ${value.pendingCount} 项，冲突 ${value.conflictCount} 项，上次成功同步 ${value.lastSyncTime ? new Date(value.lastSyncTime).toLocaleString() : '从未'}。`,
      }],
    },
    async execute() {
      await ensureScanned();
      return snapshotValue(snapshot());
    },
  }));

  // 2. nas_sync_subscribe：轻量快照（客户端轮询用，语义同 status）
  ctx.tools.register(defineTool({
    name: 'nas_sync_subscribe',
    description: '获取 NAS 同步的轻量状态快照（与 nas_sync_status 相同结构，供轮询订阅）。',
    parameters: {},
    output: {
      schema: snapshotSchema,
      render: (_args: any, value: any) => [{
        type: 'text',
        text: `pending=${value.pendingCount} conflicts=${value.conflictCount} running=${value.running} phase=${value.phase}`,
      }],
    },
    async execute() {
      await ensureScanned();
      return snapshotValue(snapshot());
    },
  }));

  // 3. nas_sync_scope：分类勾选（查看 / 修改）—— r3 新增
  const scopeOutputSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      includeSensitive: { type: 'boolean' },
      enabled: { type: 'json' },
      skillFilter: { type: 'json' },
      customFolders: { type: 'json' },
      skills: { type: 'json' },
      totalFiles: { type: 'integer' },
      totalBytes: { type: 'integer' },
      categories: { type: 'json' },
      changed: { type: 'boolean' },
    },
  } as const;

  ctx.tools.register(defineTool({
    name: 'nas_sync_scope',
    // 分类清单从 SYNC_CATEGORIES 拼，不写死 —— 上一版这里漏掉了新增的「工作区」相关分类，
    // 工具说明与实际能力对不上，用户照着说明勾选会找不到。
    description: '查看或修改「按分类勾选同步内容」。'
      + `不带参数调用 = 只读查看：返回 ${SYNC_CATEGORIES.length} 个分类（`
      + SYNC_CATEGORIES.map((c) => `${c.key} ${c.label}`).join(' / ')
      + '）的勾选状态、'
      + '文件数与体积（体积按**全部**分类统计，不受当前勾选影响，便于判断关掉某项能省多少）。'
      + '传 set 则修改勾选（局部合并，如 {"attachments":false} 只关附件，其余不变）。'
      + 'includeSensitive 控制已选分类**内部**的凭据文件（.credentials.yaml 等）是否一起同步。'
      + '技能可再按名字细分：传 skillFilter（如 ["pdf","xlsx"]）只同步这几个技能；'
      + '传 [] 表示全部技能（也包含以后新增的）。不带 skillFilter 则保持原值。'
      + '自定义文件夹传 customFolders（如 [{"name":"projects","path":"D:\\\\Projects"}]）：'
      + 'name 是跨设备的稳定标识（rel 前缀 custom-folders/<name>/），path 只在本机生效，'
      + '所以两台机器可以同 name 不同路径；整表替换，传 [] 表示清空。',
    parameters: {
      set: { type: 'json', description: '要修改的分类键值，如 {"attachments": false, "skills": true}；省略=只查看' },
      includeSensitive: { type: 'boolean', description: '已选分类内部是否连凭据文件一起同步，默认保持原值' },
      skillFilter: { type: 'json', description: '技能白名单数组（只同步这些技能名）；传 [] = 全部技能；省略=不改' },
      customFolders: { type: 'json', description: '自定义文件夹映射表 [{name,path}]；整表替换；省略=不改' },
    },
    output: {
      schema: scopeOutputSchema,
      render: (_args: any, value: any) => {
        const lines = (value.categories ?? []).map((c: any) =>
          `${c.enabled ? '☑' : '☐'} ${c.label}（${c.key}）— ${c.files} 个 / ${fmtBytes(c.bytes)}${c.sensitive ? ' · 敏感' : ''}`);
        // 技能明细只在「技能」这一类被勾上时才有意义
        const skillsOn = (value.categories ?? []).some((c: any) => c.key === 'skills' && c.enabled);
        const skillLines = (skillsOn && (value.skills ?? []).length)
          ? '\n技能明细：\n' + value.skills
            .map((s: any) => `  ${s.enabled ? '☑' : '☐'} ${s.name} — ${s.files} 个 / ${fmtBytes(s.bytes)}`)
            .join('\n')
            + (value.skillFilter && value.skillFilter.length === 0 ? '\n  （白名单为空 = 全部技能都同步）' : '')
          : '';
        return [{
          type: 'text',
          text: (value.changed ? '已更新同步分类。\n' : '当前同步分类：\n')
            + lines.join('\n')
            + skillLines
            + `\n合计：${value.totalFiles} 个文件 / ${fmtBytes(value.totalBytes)}`
            + `\n分类内部凭据文件：${value.includeSensitive ? '同步' : '跳过'}`,
        }];
      },
    },
    async execute(args: any) {
      let changed = false;
      const patch: Record<string, unknown> = {};
      const set = args?.set;
      if (set && typeof set === 'object' && !Array.isArray(set)) {
        const clean: Record<string, boolean> = {};
        for (const [k, v] of Object.entries(set as Record<string, unknown>)) {
          if (!SYNC_CATEGORIES.some((c) => c.key === k)) {
            warn('忽略未知分类键：' + k);
            continue;
          }
          if (typeof v !== 'boolean') continue;
          clean[k] = v;
        }
        if (Object.keys(clean).length > 0) { patch.syncScope = clean; changed = true; }
      }
      if (typeof args?.includeSensitive === 'boolean') {
        patch.includeSensitive = args.includeSensitive;
        changed = true;
      }
      // 技能白名单：数组 = 只同步这些；[] = 全部（含以后新增）。
      // 传了但元素非法（非字符串）时退回「全部」而不是「一个都不要」——
      // 后者会静默停止同步技能，属于灾难性误操作。
      if (args?.skillFilter !== undefined) {
        patch.skillFilter = normalizeSkillFilter(args.skillFilter);
        changed = true;
      }
      // 自定义文件夹映射表：整表替换（不是合并）—— 删条目必须能表达出来
      if (args?.customFolders !== undefined) {
        patch.customFolders = normalizeCustomFolders(args.customFolders);
        changed = true;
      }
      if (changed) applyConfigPatch(patch);

      // 体积按「全部分类都勾上」统计，否则关掉的分类会显示 0，用户无法判断关掉它省了多少
      const allOn = Object.fromEntries(SYNC_CATEGORIES.map((c) => [c.key, true])) as Record<SyncScopeKey, boolean>;
      let summary: Record<string, { files: number; bytes: number }> = {};
      try {
        summary = await summarizeCategories({ scope: allOn, includeSensitive: cfg.includeSensitive, customFolders: cfg.customFolders });
      } catch (e) {
        warn('分类统计失败：' + (e as Error).message);
      }

      const categories = SYNC_CATEGORIES.map((c) => ({
        key: c.key,
        label: c.label,
        desc: c.desc,
        sensitive: c.sensitive,
        enabled: cfg.syncScope[c.key] !== false,
        files: summary[c.key]?.files ?? 0,
        bytes: summary[c.key]?.bytes ?? 0,
      }));
      const on = categories.filter((c) => c.enabled);

      // 技能明细：面板/工具都要「每个技能一行」。统计同样按全部技能算，
      // 否则被排除的技能显示 0 个文件，用户没法判断放它进来会多多少。
      let skillRows: any[] = [];
      try {
        const all = await listSkills();
        const filter = cfg.skillFilter ?? [];
        skillRows = all.map((s) => ({
          name: s.name,
          files: s.files,
          bytes: s.bytes,
          // 空白名单 = 全部勾上
          enabled: filter.length === 0 || filter.includes(s.name),
        }));
      } catch (e) {
        warn('技能列表读取失败：' + (e as Error).message);
      }

      return {
        includeSensitive: cfg.includeSensitive,
        enabled: enabledScopeKeys(normalizeSyncScope(cfg.syncScope)),
        skillFilter: cfg.skillFilter ?? [],
        customFolders: cfg.customFolders ?? [],
        skills: skillRows,
        totalFiles: on.reduce((n, c) => n + c.files, 0),
        totalBytes: on.reduce((n, c) => n + c.bytes, 0),
        categories,
        changed,
      } as any;
    },
  }));

  // 4. nas_pending_files_page：待同步分页
  ctx.tools.register(defineTool({
    name: 'nas_pending_files_page',
    description: '分页列出待同步文件清单（rel、大小、动作 upload/download）。',
    parameters: {
      page: { type: 'integer', description: '页码，从 1 开始，默认 1' },
      pageSize: { type: 'integer', description: '每页条数，默认 50，上限 200' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          page: { type: 'integer' },
          pageSize: { type: 'integer' },
          total: { type: 'integer' },
          items: { type: 'array', items: pendingItemSchema },
        },
      },
      render: (_args: any, value: any) => [{
        type: 'text',
        text: `待同步共 ${value.total} 项（第 ${value.page}/${Math.max(1, Math.ceil(value.total / value.pageSize))} 页）：\n` +
          value.items.map((i: PendingFile) => `  [${i.action}] ${i.rel} (${(i.size / 1024).toFixed(1)} KB)`).join('\n'),
      }],
    },
    async execute(args: any) {
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
    },
  }));

  // 4. nas_get_conflicts：冲突分页
  ctx.tools.register(defineTool({
    name: 'nas_get_conflicts',
    description: '分页列出同步冲突（两端同时变更且 hash 不同）。mergeable=true 的文本文件可用 nas_try_merge 自动合并。',
    parameters: {
      page: { type: 'integer', description: '页码，默认 1' },
      pageSize: { type: 'integer', description: '每页条数，默认 50，上限 200' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer' },
          items: { type: 'array', items: conflictItemSchema },
        },
      },
      render: (_args: any, value: any) => [{
        type: 'text',
        text: value.items.length === 0
          ? '当前没有冲突。'
          : `共 ${value.total} 个冲突：\n` + value.items.map((i: ConflictItem) =>
              `  ${i.rel}${i.mergeable ? '（可自动合并）' : ''} local=${new Date(i.localMtime).toLocaleString()} remote=${new Date(i.remoteMtime).toLocaleString()}`).join('\n'),
      }],
    },
    async execute(args: any) {
      await ensureScanned();
      const page = Math.max(1, Number(args.page ?? 1));
      const pageSize = Math.min(200, Math.max(1, Number(args.pageSize ?? 50)));
      const start = (page - 1) * pageSize;
      return { total: store.conflicts.length, items: store.conflicts.slice(start, start + pageSize) };
    },
  }));

  // 5. nas_resolve_conflict
  ctx.tools.register(defineTool({
    name: 'nas_resolve_conflict',
    description: '解决一个同步冲突：local=用本地覆盖远端（远端旧内容会先备份为 .base）；remote=用远端覆盖本地；skip=仅移出冲突列表。',
    parameters: {
      file: { type: 'string', required: true, description: '冲突文件的 rel 路径（相对 ~/.dsh）' },
      resolution: { type: 'string', required: true, enum: ['local', 'remote', 'skip'], description: '解决方式' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { success: { type: 'boolean' }, message: { type: 'json' } },
      },
      render: (_args: any, value: any) => [{
        type: 'text',
        text: value.success ? `冲突已解决（${_args.resolution}）：${_args.file}` : '解决失败：' + value.message,
      }],
    },
    async execute(args: any) {
      await engine.resolve(args.file, args.resolution);
      return { success: true, message: null };
    },
  }));

  // 6. nas_sync：执行一次同步
  ctx.tools.register(defineTool({
    name: 'nas_sync',
    description: '立即执行一次 NAS 同步。mode=push 只上传本地变更；pull 只下载远端变更；mirror 双向。大文件走分块断点续传，全程加密。',
    parameters: {
      mode: { type: 'string', enum: ['push', 'pull', 'mirror'], description: '同步方向，默认 mirror' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pushed: { type: 'integer' },
          pulled: { type: 'integer' },
          conflicts: { type: 'integer' },
          errors: { type: 'integer' },
        },
      },
      render: (_args: any, value: any) => [{
        type: 'text',
        text: `同步完成：上传 ${value.pushed} 项，下载 ${value.pulled} 项，失败 ${value.errors} 项，剩余冲突 ${value.conflicts} 个。`,
      }],
    },
    async execute(args: any) {
      const r = await engine.sync(args?.mode ?? 'mirror');
      return { pushed: r.pushed, pulled: r.pulled, conflicts: r.conflicts, errors: store.snapshot.progress.errors };
    },
  }));

  // 7. nas_stop_sync
  ctx.tools.register(defineTool({
    name: 'nas_stop_sync',
    description: '中止正在进行的同步任务（当前文件完成后停止）。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { stopped: { type: 'boolean' } },
      },
      render: (_args: any, value: any) => [{
        type: 'text',
        text: value.stopped ? '已发出停止信号。' : '当前没有正在进行的同步任务。',
      }],
    },
    async execute() {
      if (engine.isRunning()) {
        engine.stop();
        return { stopped: true };
      }
      return { stopped: false };
    },
  }));

  // 8. nas_test：连通性自检
  ctx.tools.register(defineTool({
    name: 'nas_test',
    description: '测试 NAS 连接（WebDAV 地址/凭据或挂载点）是否可用。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' }, message: { type: 'json' } },
      },
      render: (_args: any, value: any) => [{
        type: 'text',
        text: value.ok ? 'NAS 连接正常。' : 'NAS 连接失败：' + value.message,
      }],
    },
    async execute() {
      try {
        engine.checkReady();
        const ok = await createTransport(cfg).test();
        return { ok, message: ok ? null : (cfg.type === 'webdav' ? '无法访问 ' + cfg.webdav?.url : '挂载点不可用 ' + cfg.mountRoot) };
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
    },
  }));

  // 8.5 nas_set_config：修改并持久化配置（自管配置层）
  ctx.tools.register(defineTool({
    name: 'nas_set_config',
    description: '修改 NAS 同步配置并持久化（重启引擎后仍生效）。可改：type(webdav/mount)、webdav.{url,remotePath(共享文件夹),username,password}、mountRoot、passphrase(加密口令)、autoSync.{enabled,mode,intervalMin}、chunkThreshold、chunkSize、concurrency、includeSensitive、'
      + `syncScope.{${SYNC_CATEGORIES.map((c) => c.key).join(',')}}（分类勾选，二级合并）。传部分字段即可；只想改勾选请优先用 nas_sync_scope。`,
    parameters: {
      config: {
        type: 'object',
        required: true,
        additionalProperties: true,
        description: '要修改的配置字段（部分合并）',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          success: { type: 'boolean' },
          message: { type: 'json' },
          effective: { type: 'json' },
        },
      },
      render: (_args: any, value: any) => [{
        type: 'text',
        text: value.success ? '配置已更新并持久化：' + JSON.stringify(value.effective, null, 2) : '配置更新失败：' + value.message,
      }],
    },
    async execute(args: any) {
      try {
        if (!args.config || typeof args.config !== 'object') throw new Error('config 必须是对象');
        const next = applyConfigPatch(args.config);
        const shown: Record<string, unknown> = {
          type: next.type,
          webdavUrl: next.webdav?.url || null,
          mountRoot: next.mountRoot || null,
          passphrase: next.passphrase ? '***已设置***' : null,
          autoSync: next.autoSync,
          includeSensitive: next.includeSensitive,
        };
        return { success: true, message: null, effective: shown };
      } catch (e) {
        return { success: false, message: (e as Error).message, effective: null };
      }
    },
  }));

  // 9. nas_try_merge：三路合并
  ctx.tools.register(defineTool({
    name: 'nas_try_merge',
    description: '对一个可合并的文本冲突（yaml/json/md/txt 等）做三路合并：base=上次推送前备份的远端旧内容（.base）。apply=true 时把合并结果写回本地文件。',
    parameters: {
      file: { type: 'string', required: true, description: '冲突文件的 rel 路径（相对 ~/.dsh）' },
      apply: { type: 'boolean', description: '是否把合并结果写回本地文件，默认 false（只预览）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          success: { type: 'boolean' },
          hasConflicts: { type: 'json' },
          applied: { type: 'json' },
          reason: { type: 'json' },
          mergedContent: { type: 'json' },
        },
      },
      render: (_args: any, value: any) => {
        if (!value.success) return [{ type: 'text', text: '合并失败：' + value.reason }];
        const lines = String(value.mergedContent ?? '').split('\n');
        const preview = lines.slice(0, 60).join('\n') + (lines.length > 60 ? `\n...（共 ${lines.length} 行）` : '');
        return [{
          type: 'text',
          text: (value.hasConflicts ? '合并完成，存在未自动解决的冲突块（<<<<<<< local）' : '合并成功，无冲突')
            + (value.applied ? '，已写回本地文件。' : '，仅预览（apply=true 可写回）。') + '\n' + preview,
        }];
      },
    },
    async execute(args: any): Promise<MergeResult & { applied: boolean | null }> {
      const rel = args.file;
      if (!isMergeable(rel)) {
        return { success: false, applied: null, reason: '该文件类型不支持自动合并（仅 yaml/json/md/txt/csv/conf/toml）' };
      }
      let local: string;
      try {
        local = (await readFile(localOf(rel))).toString('utf-8');
      } catch {
        return { success: false, applied: null, reason: '本地文件不存在：' + rel };
      }
      let remote: string | null;
      try {
        remote = await engine.readRemoteText(rel);
      } catch (e) {
        return { success: false, applied: null, reason: '无法读取远程版本：' + (e as Error).message };
      }
      if (remote === null) return { success: false, applied: null, reason: '远端不存在该文件' };

      let base = '';
      try {
        base = await engine.readBaseText(rel);
      } catch { base = ''; }

      const result = mergeThreeWay(base, local, remote);
      let applied: boolean | null = null;
      if (args.apply && result.success && result.mergedContent !== undefined) {
        const p = localOf(rel);
        await mkdir(p.slice(0, p.lastIndexOf('/')), { recursive: true });
        await writeFile(p, result.mergedContent, 'utf-8');
        applied = true;
      }
      return {
        success: true,
        hasConflicts: result.hasConflicts ?? false,
        applied,
        reason: null,
        mergedContent: result.mergedContent ?? null,
      };
    },
  }));

  // 10. nas_get_file_diff：行级 diff
  ctx.tools.register(defineTool({
    name: 'nas_get_file_diff',
    description: '对比某个文件本地与远端版本的行级差异（远端不存在时只显示本地内容；本地不存在时同理）。',
    parameters: {
      file: { type: 'string', required: true, description: '文件 rel 路径（相对 ~/.dsh）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file: { type: 'string' },
          lines: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                type: { type: 'string', enum: ['same', 'add', 'remove', 'change'] },
                line: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args: any, value: any) => {
        const marks: Record<string, string> = { same: '  ', add: '+ ', remove: '- ', change: '! ' };
        const shown = value.lines.slice(0, 120);
        return [{
          type: 'text',
          text: `diff ${value.file}（${value.lines.length} 行，显示前 ${shown.length} 行）：\n` +
            shown.map((l: DiffLine) => marks[l.type] + l.line).join('\n'),
        }];
      },
    },
    async execute(args: any) {
      const rel = args.file;
      let local = '';
      try {
        local = (await readFile(localOf(rel))).toString('utf-8');
      } catch { /* 本地不存在 */ }
      let remote = '';
      try {
        remote = (await engine.readRemoteText(rel)) ?? '';
      } catch { /* 远端不存在 */ }
      const lines = diffLines(local.split(/\r?\n/), remote.split(/\r?\n/));
      return { file: rel, lines: lines.slice(0, 1000) };
    },
  }));

  log('插件已加载（name=' + name + '，type=' + cfg.type + '）');
}

export { NS_NAS_SYNC } from './config.js';
export type { NasSyncConfig } from './config.js';

export { apply };
