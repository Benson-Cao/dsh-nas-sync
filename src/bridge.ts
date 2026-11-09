/**
 * dsh-nas-sync · Web UI HTTP 桥（B 方案）
 * ----------------------------------------
 *   - 往页面注入 boot token：**两条通道都要走**，见下
 *   - ctx.webServer.register({ kind:'prefix', path, handler(req,res) }) 注册路由
 *   - 客户端带 x-nas-sync-token 头，timingSafeEqual 校验
 * 客户端面板（client.js）通过本桥读写同步状态/配置/冲突。
 *
 * ── 为什么必须走两条通道（真机踩坑） ──────────────────────────────
 * dsh-host-webserver 的 index 注入有**两种渲染器**，共用一张 table：
 *
 *   1. served form：`dsh web` 类服务端在响应 index.html 时调
 *      `renderIndex(html)` = `applyIndexTaps(renderIndexInjections(html, rows))`
 *      —— 结构化 row 和 tapIndex 都会生效。
 *   2. static / Electron desktop：不渲染服务端 HTML，而是把同一张 table
 *      作为 **boot payload** 发给页面，由页面侧解释器消费。
 *      **这条路上只有结构化 row，`tapIndex` 的裸字符串变换完全不生效。**
 *
 * 早先只注册了 tapIndex，于是桌面端表现成：插件列表里有、设置页也能渲染出
 * 面板，但 `window.__DSH_NAS_SYNC_TOKEN__` 永远是 undefined，面板一直卡在
 * 「页面没有拿到请求令牌」。tapIndex 是官方注释里明确的「escape hatch」，
 * 不是跨两种部署形态的通用通道。
 *
 * 结论：结构化 row 走主路（两种形态都覆盖），tapIndex 保留作服务端兜底；
 * 两者注入的值完全相同，重复注入是幂等的，不会互相干扰。
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import type { Store } from './config.js';
import type { Engine } from './sync/engine.js';
import type { NasSyncConfig } from './config.js';
import { listSkills } from './sync/scanner.js';
import { dshHome } from './paths.js';
import { Installer, resolveCliScript } from './sync/installer.js';

export const BRIDGE_PREFIX = '/nas-sync-api';

/** 请求体上限（0.5.9）：这些都是控制类接口，256 KB 足够，避免无界缓冲打爆内存。 */
const MAX_BODY_BYTES = 256 * 1024;

function sendJson(res: any, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function ok(res: any, value: unknown): void {
  sendJson(res, 200, { ok: true, value });
}

/**
 * 0.6.0：新增 `status` 参数，让新端点能用真实 HTTP 状态码。
 *
 * 默认仍是 200 —— 已部署的 client.js 只按响应体 `{ok:false,error}` 判错、不看
 * res.ok，但宿主 webServer / 中间代理对非 2xx 可能有额外处理。保持旧端点不变，
 * 避免为了「语义更标准」把线上正在跑的面板弄成「HTTP 400」这种没有信息量的报错。
 */
function fail(res: any, code: string, message: string, status = 200): void {
  sendJson(res, status, { ok: false, error: { code, message } });
}

function tokenMatches(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string') return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** 注入到页面的 boot 全局脚本体（不含 <script> 标签）。 */
function bootGlobalsScript(token: string): string {
  return `window.__DSH_NAS_SYNC_TOKEN__=${JSON.stringify(token)};`
    + `window.__DSH_NAS_SYNC_PREFIX__=${JSON.stringify(BRIDGE_PREFIX)};`;
}

function injectBootGlobals(html: string, token: string): string {
  const payload = `<script>${bootGlobalsScript(token)}</script>`;
  const index = html.toLowerCase().lastIndexOf('</body>');
  if (index === -1) return html + payload;
  return html.slice(0, index) + payload + html.slice(index);
}

/** 脱敏后的配置视图（secret 字段只回是否已设置） */
export function publicConfig(cfg: NasSyncConfig): Record<string, unknown> {
  return {
    type: cfg.type,
    webdav: {
      url: cfg.webdav?.url ?? '',
      remotePath: cfg.webdav?.remotePath ?? '',
      username: cfg.webdav?.username ?? '',
      passwordSet: Boolean(cfg.webdav?.password),
    },
    mountRoot: cfg.mountRoot ?? '',
    passphraseSet: Boolean(cfg.passphrase),
    autoSync: cfg.autoSync,
    includeSensitive: cfg.includeSensitive,
    /** r3：分类勾选（面板据此渲染勾选框；顺序以 SYNC_CATEGORIES 为准） */
    syncScope: cfg.syncScope,
    /** 技能白名单；空数组 = 全部（面板把「全勾」也归一化成空数组） */
    skillFilter: cfg.skillFilter ?? [],
    chunkThreshold: cfg.chunkThreshold,
    chunkSize: cfg.chunkSize,
    concurrency: cfg.concurrency,
    /** 0.6.0 / P1：删除后回收副本保留天数（0 = 永久） */
    retentionDays: cfg.retentionDays ?? 30,
    /** 0.6.0 / P3：工作区/自定义文件夹单文件扫描上限 */
    maxFileBytes: cfg.maxFileBytes ?? 64 * 1024 * 1024,
    /** 0.6.0 / 收尾①：会话 rel 空间（默认 legacy，升级不改数据） */
    sessionRelMode: cfg.sessionRelMode ?? 'legacy',
    /** 0.6.0 / 收尾②：上传信封版本（1=NSS1 兼容，2=NSS2 带 AAD） */
    envelopeVersion: cfg.envelopeVersion ?? 1,
    /** 0.6.0 / 收尾③：增量扫描缓存开关与 TTL */
    scanCacheEnabled: cfg.scanCacheEnabled ?? true,
    scanCacheTtlHours: cfg.scanCacheTtlHours ?? 24,
  };
}

export interface BridgeDeps {
  getEngine(): Engine;
  getConfig(): NasSyncConfig;
  /** 修改配置（已做 schema 校验与持久化），失败时抛错 */
  patchConfig(patch: Record<string, unknown>): unknown;
  store: Store;
  ensureScanned(): Promise<void>;
}

export function createBridge(ctx: any, deps: BridgeDeps): void {
  const token = randomBytes(24).toString('base64url');
  // 插件安装任务：一次只允许跑一个 pnpm，避免两个进程抢 profile 的锁。
  // 0.6.0 / 收尾④：手机端没有宿主 CLI 时，Installer 会用这个对象源从 CAS 解包。
  const installer = new Installer(() => join(dshHome(), 'profiles'), {
    getObject: (hash) => deps.getEngine().pluginObject(hash),
    assemblies: () => deps.getEngine().pluginAssemblies(),
  });

  // 通道 1（主路）：结构化 index-inject。桌面端 boot payload 只认这个。
  // 官方用法见 @deepseek-ai/dsh-client-ui-theme：ctx.on('webserver/index-inject', …)。
  // 用 kind:'global' 而不是 kind:'script' —— 页面侧解释器对 global 直接赋值
  // （globalThis[name] = value），不创建 inline <script> 元素，既省掉转义
  // 也避开 CSP；两种渲染器（服务端 renderIndex / 桌面 boot payload）都支持它。
  if (typeof ctx.on === 'function') {
    ctx.on('webserver/index-inject', (table: any[]) => {
      table.push(
        { kind: 'global', name: '__DSH_NAS_SYNC_TOKEN__', value: token },
        { kind: 'global', name: '__DSH_NAS_SYNC_PREFIX__', value: BRIDGE_PREFIX },
      );
    }, { prepend: true });
  }

  // 通道 2（兜底）：服务端渲染 index.html 时的裸字符串变换。
  // 桌面端不会走这条路，但 `dsh web` 形态下它先于 boot 脚本执行，保留无害。
  ctx.effect(() => {
    if (typeof ctx.webServer?.tapIndex !== 'function') return () => {};
    const dispose = ctx.webServer.tapIndex((html: string) => injectBootGlobals(html, token));
    return typeof dispose === 'function' ? dispose : () => {};
  }, 'dsh-nas-sync: page boot token');

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: BRIDGE_PREFIX,
      handler: (req: any, res: any) => {
        if (!tokenMatches(req.headers['x-nas-sync-token'], token)) {
          sendJson(res, 401, { ok: false, error: { code: 'unauthorized', message: '页面令牌校验失败，请刷新页面后重试。' } });
          return;
        }
        return handle(req, res).catch((e: Error) => {
          try { fail(res, 'internal', e.message); } catch { /* 已结束 */ }
        });
      },
    });
    return typeof dispose === 'function' ? dispose : () => {};
  }, 'dsh-nas-sync: http bridge');

  async function handle(req: any, res: any): Promise<void> {
    const url = new URL(req.url || '/', 'http://localhost');
    const sub = url.pathname.length <= BRIDGE_PREFIX.length
      ? '/'
      : url.pathname.slice(BRIDGE_PREFIX.length).replace(/\/+$/, '') || '/';
    const method = (req.method || 'GET').toUpperCase();
    const engine = deps.getEngine();

    const readBody = async (): Promise<any> => {
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const c of req) {
        const buf = c as Buffer;
        total += buf.length;
        if (total > MAX_BODY_BYTES) throw new Error('请求体过大（上限 256 KB）');
        chunks.push(buf);
      }
      const raw = Buffer.concat(chunks).toString('utf-8');
      return raw ? JSON.parse(raw) : {};
    };

    try {
      // ---- 状态 ----
      if (sub === '/status' && method === 'GET') {
        await deps.ensureScanned();
        const s = deps.store.snapshot;
        return ok(res, {
          snapshot: {
            lastSyncTime: s.lastSyncTime,
            phase: s.phase,
            progress: s.progress,
            pendingCount: s.pendingCount,
            conflictCount: s.conflictCount,
            running: s.running,
          },
          config: publicConfig(deps.getConfig()),
          // 0.5.9：把「本轮为什么没做删除传播」「状态文件是否异常」显式暴露给面板
          safety: engine.safetyStatus(),
          storeError: deps.store.lastError,
          /**
           * 0.7.0：本机会话目录被同步动作改动过的单调纪元。
           * 页面侧（client.js）轮询它，值一变就调宿主自己的 `sessions.refresh()`
           * 重新拉 `session/list` —— 否则删掉的会话要等重启才从侧栏消失。
           */
          removalEpoch: engine.removalEpochValue(),
        });
      }

      // ---- 0.6.0 / P1：事件流回放 / 位点 / 手动确认删除 ----
      if (sub === '/events' && method === 'GET') {
        const raw = Number(url.searchParams.get('limit') ?? 100);
        const limit = Math.max(1, Math.min(1000, Number.isFinite(raw) ? raw : 100));
        try {
          return ok(res, await engine.listEvents(limit));
        } catch (e) {
          // 远端不可达不该让面板报错：明确标成不可信空流，而不是假装没有事件
          return ok(res, {
            events: [], trusted: false, tombstones: [], cursors: {},
            error: (e as Error).message,
          });
        }
      }
      if (sub === '/events/status' && method === 'GET') {
        return ok(res, {
          safety: engine.safetyStatus(),
          cursors: { ...deps.store.deviceCursors },
          retentionDays: deps.getConfig().retentionDays ?? 30,
        });
      }
      if (sub === '/events/delete' && method === 'POST') {
        const body = await readBody();
        const rel = String(body?.rel ?? '').trim();
        if (!rel) return fail(res, 'bad-request', '缺少 rel（要删除的相对路径）', 400);
        const r = await engine.confirmDelete(rel);
        // 事件流不可信时是**业务阻断**，不是请求格式错：用 409 让调用方一眼看出
        if (!r.published) return fail(res, 'blocked', r.reason, 409);
        return ok(res, { rel, published: true });
      }

      // ---- 0.6.0 / 收尾①：会话 rel 空间迁移（两阶段，默认只读预演） ----
      if (sub === '/rel-migration' && method === 'GET') {
        return ok(res, await engine.sessionRelPlan());
      }
      if (sub === '/rel-migration' && method === 'POST') {
        const body = await readBody();
        // 必须显式 true 才写；字符串 / 数字 / 缺字段一律当作预演，防误触。
        const confirm = body?.confirm === true;
        const r = await engine.migrateSessionRels({ confirm });
        if (!r.ok) return fail(res, 'migration-blocked', r.hint, 409);
        return ok(res, r);
      }

      // ---- 技能列表（面板渲染「每个技能一个勾选框」用） ----
      // 名字必须来自设备上真实的 skills/ 目录，前端不能写死。
      // 不带文件内容，只 stat，所以再大的技能树也不会卡住面板。
      if (sub === '/skills' && method === 'GET') {
        return ok(res, { skills: await listSkills() });
      }

      // ---- 来源设备 ----
      // 面板在分类/自定义文件夹旁标 💻/📱 用。数据来自远端清单里记录的
      // 「最后上传者」，所以首次同步前是空的（前端按"未知"处理即可）。
      if (sub === '/devices' && method === 'GET') {
        try {
          const r = await engine.sourceDevices();
          return ok(res, { self: r.self, byPrefix: r.byPrefix, byWorkspace: r.byWorkspace });
        } catch (e) {
          // 远端不可达不该让面板报错，返回空统计即可
          return ok(res, { self: '', byPrefix: {}, byWorkspace: {}, error: (e as Error).message });
        }
      }

      // ---- 连接测试 ----
      if (sub === '/test' && method === 'POST') {
        try {
          engine.checkReady();
          const { createTransport } = await import('./nas/index.js');
          const okTest = await createTransport(deps.getConfig()).test();
          return ok(res, { connected: okTest === true, message: null });
        } catch (e) {
          return ok(res, { connected: false, message: (e as Error).message });
        }
      }

      // ---- 同步 ----
      if (sub === '/sync' && method === 'POST') {
        const body = await readBody();
        const mode = body.mode === 'push' || body.mode === 'pull' ? body.mode : 'mirror';
        const r = await engine.sync(mode);
        return ok(res, { ...r, errors: deps.store.snapshot.progress.errors });
      }
      if (sub === '/stop' && method === 'POST') {
        if (engine.isRunning()) { engine.stop(); return ok(res, { stopped: true }); }
        return ok(res, { stopped: false });
      }

      // ---- 待同步 ----
      if (sub === '/pending' && method === 'GET') {
        await deps.ensureScanned();
        const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
        const pageSize = Math.min(200, Math.max(1, Number(url.searchParams.get('pageSize') ?? 50)));
        const start = (page - 1) * pageSize;
        return ok(res, {
          items: deps.store.pendingFiles.slice(start, start + pageSize),
          total: deps.store.pendingFiles.length,
          page,
          pageSize,
        });
      }

      // ---- 冲突 ----
      if (sub === '/conflicts' && method === 'GET') {
        await deps.ensureScanned();
        return ok(res, { items: deps.store.conflicts });
      }
      if (sub === '/resolve' && method === 'POST') {
        const body = await readBody();
        if (!body.file || !['local', 'remote', 'skip'].includes(body.resolution)) {
          return fail(res, 'bad_request', '需要 file 与 resolution(local|remote|skip)');
        }
        await engine.resolve(body.file, body.resolution);
        return ok(res, { resolved: body.file });
      }
      if (sub === '/skip' && method === 'POST') {
        const body = await readBody();
        if (!body.file) return fail(res, 'bad_request', '需要 file');
        // 只移出待办：与 /resolve(skip) 区分开，后者要求文件确实在冲突列表里。
        await engine.skipPending(body.file);
        return ok(res, { skipped: body.file });
      }
      if (sub === '/merge' && method === 'POST') {
        const body = await readBody();
        const fs = await import('node:fs/promises');
        const { localOf } = await import('./paths.js');
        const { mergeThreeWay } = await import('./sync/merger.js');
        let localText = '';
        try {
          localText = await fs.readFile(localOf(body.file), 'utf-8');
        } catch {
          return fail(res, 'no_local', '本地文件不存在：' + body.file);
        }
        const remoteText = await engine.readRemoteText(body.file);
        if (remoteText === null) return fail(res, 'no_remote', '远端不存在该文件');
        const baseText = await engine.readBaseText(body.file).catch(() => '');
        const result = mergeThreeWay(baseText, localText, remoteText);
        if (body.apply && result.success && result.mergedContent !== undefined) {
          const p = localOf(body.file);
          await fs.mkdir(p.slice(0, p.lastIndexOf('/')), { recursive: true });
          await fs.writeFile(p, result.mergedContent, 'utf-8');
        }
        return ok(res, result);
      }

      // ---- 配置 ----
      if (sub === '/config' && method === 'GET') {
        return ok(res, publicConfig(deps.getConfig()));
      }
      if (sub === '/config' && method === 'POST') {
        const body = await readBody();
        if (!body.config || typeof body.config !== 'object') {
          return fail(res, 'bad_request', 'config 必须是对象');
        }
        const next = deps.patchConfig(body.config) as NasSyncConfig;
        return ok(res, { config: publicConfig(next) });
      }

      // ---- 插件对账 / 安装（0.4.0）----
      // 插件的包体不走同步，只同步装配清单，所以「对端装了、本机没装」要靠这里补齐。
      if (sub === '/plugins' && method === 'GET') {
        const want = url.searchParams.get('target') || undefined;
        const audit = await deps.getEngine().auditPlugins(want);
        const assemblies = await deps.getEngine().pluginAssemblies();
        return ok(res, {
          ...audit,
          // 没有 CLI 也未必不能装：只要 CAS 里有本平台的对象就能解包安装
          canInstall: resolveCliScript() !== null || assemblies.length > 0,
          casAssemblies: assemblies.length,
          running: installer.running(),
        });
      }
      if (sub === '/plugins/install' && method === 'POST') {
        const body = await readBody();
        const profile = String(body?.profile || '');
        const items = Array.isArray(body?.items) ? body.items : [];
        if (!profile) return fail(res, 'bad_request', 'profile 不能为空');
        const clean = items
          .filter((i: any) => i && typeof i.name === 'string' && typeof i.target === 'string')
          .map((i: any) => ({ name: i.name, target: i.target }));
        const job = installer.start(profile, clean);
        return ok(res, job);
      }
      if (sub === '/plugins/publish' && method === 'POST') {
        const body = await readBody();
        const name = String(body?.name || '').trim();
        const version = String(body?.version || '').trim();
        const tgzPath = String(body?.tgzPath || '').trim();
        if (!name || !tgzPath) {
          return fail(res, 'bad_request', '需要 name 与 tgzPath（本机 .tgz 路径）', 400);
        }
        try {
          return ok(res, await deps.getEngine().publishPluginObject({ name, version, tgzPath }));
        } catch (e) {
          return fail(res, 'publish_failed', (e as Error).message, 409);
        }
      }
      if (sub === '/plugins/install' && method === 'GET') {
        const id = url.searchParams.get('id') || '';
        const job = installer.get(id);
        if (!job) return fail(res, 'not_found', '没有这个安装任务');
        return ok(res, job);
      }

      // ---- 回收目录 / 本机屏蔽清单（0.5.9）----
      // 0.5.8 的 README 承诺「回收目录随时捞回来」，但既没有枚举也没有恢复入口；
      // 屏蔽清单也只能靠手写 JSON。这里把两者做成真正可用的用户路径。
      if (sub === '/removed' && method === 'GET') {
        return ok(res, { items: engine.listRemovedSessions(), root: join(dshHome(), 'nas-sync', 'removed') });
      }
      if (sub === '/removed/restore' && method === 'POST') {
        const body = await readBody();
        const key = String(body?.key ?? body?.id ?? body?.rel ?? '').trim();
        if (!key) return fail(res, 'bad_request', 'key 不能为空（回收记录 id 或原始 rel）');
        return ok(res, await engine.restoreRemovedSession(key));
      }
      if (sub === '/ignored' && method === 'GET') {
        return ok(res, engine.listIgnoredSessions());
      }
      if (sub === '/ignored' && method === 'POST') {
        const body = await readBody();
        const sid = String(body?.sessionId ?? '').trim();
        const action = String(body?.action ?? 'remove');
        if (!sid) return fail(res, 'bad_request', 'sessionId 不能为空');
        if (action === 'add') {
          await engine.ignoreSession(sid);
          return ok(res, { sessionId: sid, ignored: true });
        }
        if (action === 'remove') {
          return ok(res, { sessionId: sid, ignored: false, removed: engine.unignoreSession(sid) });
        }
        return fail(res, 'bad_request', 'action 只能是 add 或 remove');
      }

      return fail(res, 'not_found', '未知端点: ' + method + ' ' + sub);
    } catch (e) {
      return fail(res, 'internal', (e as Error).message);
    }
  }
}
