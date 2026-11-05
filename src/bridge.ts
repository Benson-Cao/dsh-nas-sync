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
import type { Store } from './config.js';
import type { Engine } from './sync/engine.js';
import type { NasSyncConfig } from './config.js';
import { listSkills } from './sync/scanner.js';

export const BRIDGE_PREFIX = '/nas-sync-api';

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

function fail(res: any, code: string, message: string): void {
  sendJson(res, 200, { ok: false, error: { code, message } });
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
      for await (const c of req) chunks.push(c as Buffer);
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
        });
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
          return ok(res, { self: r.self, byPrefix: r.byPrefix });
        } catch (e) {
          // 远端不可达不该让面板报错，返回空统计即可
          return ok(res, { self: '', byPrefix: {}, error: (e as Error).message });
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

      return fail(res, 'not_found', '未知端点: ' + method + ' ' + sub);
    } catch (e) {
      return fail(res, 'internal', (e as Error).message);
    }
  }
}
