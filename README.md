# dsh-nas-sync — DeepSeek Harness NAS 同步插件

通过 WebDAV 或本地挂载（SMB / NFS）把 Harness 的会话、配置、附件、Profile、Skills
同步到 NAS，支持**分块断点续传**、**加密快照**、**冲突检测与合并**、**Compose 设置页**。

## 目录结构

```
dsh-nas-sync/
├── package.json              # dsh.bundle / dsh.client 声明 + 依赖
├── cordis.patch.yml          # bundle patch 层：把服务 insert 进 Loader 树
├── dist/index.js             # ⚠️ 已构建产物（814 KB，必须入库，见下文）
├── client.js                 # 客户端半：window.__ModuleLoader__.load 手写模块
├── scripts/build.mjs         # esbuild 打包（esbuild → 单文件 ESM）
├── tsconfig.json             # Host 半类型检查
├── tsconfig.client.json      # 客户端半（Compose 桥接层）类型检查
└── src/
    ├── index.ts              # 插件主入口：注册工具 + 设置命名空间
    ├── config.ts             # 配置 schema / store / namespace
    ├── paths.ts              # ~/.dsh 路径解析
    ├── bridge.ts             # RPC 桥接口（需宿主实现）
    ├── data/models.ts        # 跨层数据模型
    ├── nas/                  # 传输层：transport / webdav / mount
    ├── sync/                 # 同步引擎：scanner / crypto / chunker / engine / merger
    └── client/               # 客户端半（Compose）
        ├── bridge.ts               # RPC 桥接口
        ├── SyncViewModel.ts       # 状态 + 动作
        ├── index.ts               # 注册 settings.section 插槽
        └── components/
            ├── SyncStatusPanel.kt.source      # 主设置页
            ├── PendingFilesSheet.kt.source    # 待同步文件面板
            ├── ConflictDetailDialog.kt.source # 冲突处理弹窗
            └── NasSyncConfigSheet.kt.source   # 配置表单
```

### 为什么 `dist/` 在仓库里而不是 `.gitignore`

本包**没有发布到 npm**，只能作为 git 依赖安装，而 pnpm / npm 从 git 安装时
**不会执行 `build` 脚本**（只会在有 `prepare` 时跑 `prepare`）。`package.json`
的 `main` 指向 `dist/index.js`，如果产物不在仓库里，装完必然
`Cannot find module`。因此 `dist/index.js` 是入库文件，重新构建后需要一并提交。

## 1. 安装

### 1.1 桌面端（Electron）— 推荐

直接填 Git 仓库地址，不需要 clone、不需要本地构建（`dist/` 已入库）：

```
设置 → 插件 → 添加插件 → 填 https://github.com/Benson-Cao/dsh-nas-sync
```

安装位置是 `~/.dsh/profiles/desktop`。装完**必须完全退出进程再重开**
（不是关窗口），Cordis 模块与 client bundle 才会重新组合。

### 1.2 web profile（CLI）

```bash
dsh plugin --profile web add "https://github.com/Benson-Cao/dsh-nas-sync"
```

或用本地目录（改代码调试时用这个，改完要自己 `pnpm build`）：

```bash
pnpm install --ignore-scripts
pnpm build                        # 输出 dist/index.js
dsh plugin --profile web add "link:$PWD"
```

> 桌面端**不能用 CLI 装**到 desktop profile，会报
> `profile "desktop" is managed exclusively by the Electron application`，
> 请走 1.1 的 App 内插件面板。

验证：

```bash
ls ~/.dsh/profiles/desktop/node_modules/dsh-nas-sync   # 依赖已链接
ls ~/.dsh/profiles/desktop/node_modules/dsh-nas-sync/dist/index.js
```

### 1.3 依赖约定（重要）

`@deepseek-ai/*` 是**宿主运行时提供的包，不在公共 npm 上**，因此：

- 它们只出现在 `peerDependencies`，且 `peerDependenciesMeta` 标 `optional: true`；
- 插件自己的 `dependencies` 仅有 `webdav` / `tweetnacl` / `scrypt-js`；
- `scripts/build.mjs` 用 esbuild 把这三个依赖**打进** `dist/index.js`，
  并把 `@deepseek-ai/*` 设为 `external` 交给宿主。

> 如果把 `@deepseek-ai/dsh-core` 之类写进 `dependencies`，`pnpm add` 会直接失败：
> `@deepseek-ai/dsh-core` 在 npm 上是 404，`@deepseek-ai/schemastery` 的版本序列
> 是 `3.18.x / 3.19.0`（没有 `0.2.0`）。报错信息常被 App 显示成
> “无法连接 github.com”，其实是版本解析失败，不是网络问题。

## 2. 接入 Compose 设置页

你的设置页已用 Compose 重写，接入只需两步：

### 2.1 把 Kotlin 源并入你的源码树

把 `src/client/components/*.kt.source` 复制为 `*.kt`，放入你项目
`app/src/main/kotlin/.../nassync/ui/` 下（与 `build.gradle` 的 source set 对齐），
补齐依赖：

```kotlin
implementation "androidx.compose.material3:material3:1.2.1"
implementation "androidx.compose.foundation:foundation:1.6.0"
```

### 2.2 实现 DshPluginBridge

`bridge.ts` 只定义接口，真实实现要调用你宿主的客户端 SDK，例如：

```kotlin
class HostBridge(private val scope: PluginScope) : DshPluginBridge {
    override suspend fun <T> callTool(name: String, args: Map<String, String>?): T =
        scope.callTool(name, args ?: emptyMap())

    override fun bindConfig(): NasSyncConfig =
        scope.bind("nas-sync")   // 与 Host 半 namespace 一致

    override suspend fun saveConfig() = scope.save()
}
```

### 2.3 注册

在客户端初始化处：

```kotlin
registerNasSyncUi(ctx, HostBridge(scope))
```

打开「设置 → 插件 → NAS 同步」即可看到状态面板。

> **两端配对规则**：Host 半 `settingsNamespace('nas-sync')` 与客户端半
> 插槽 `key: 'nas-sync'` 必须完全一致，DSH 靠它自动配对，无需改宿主源码。

## 3. 配置项

| 字段 | 说明 |
|---|---|
| `type` | `webdav` 或 `mount` |
| `webdav.url` / `username` / `password` | WebDAV 凭据，`password` 标 `role('secret')` |
| `mountRoot` | 本地挂载点，如 `/mnt/nas` |
| `passphrase` | 加密口令，标 `role('secret')`，不回显 |
| `autoSync` | 启用、模式（push/pull/mirror）、间隔分钟 |
| `chunkThreshold` | 超过此字节走分块，默认 100 MiB |
| `chunkSize` | 分块大小，默认 50 MiB |
| `concurrency` | 上传并发数，1–16 |
| `includeSensitive` | 同步 `.credentials.yaml`，默认 false，需二次确认 |

## 4. Host 半暴露的工具

| 工具 | 用途 |
|---|---|
| `nas_sync_status` | 完整快照（兼容旧调用方） |
| `nas_sync_subscribe` | 轻量快照，客户端 3s 轮询 |
| `nas_pending_files_page` | 待同步文件分页 |
| `nas_get_conflicts` | 冲突列表分页 |
| `nas_resolve_conflict` | 解决单条冲突（local/remote/skip） |
| `nas_sync` | 触发同步（push/pull/mirror） |
| `nas_stop_sync` | 中断同步（AbortController） |
| `nas_test` | 连通性自检 |
| `nas_try_merge` | 三路合并（文本文件） |
| `nas_get_file_diff` | 行级 diff 预览 |

## 5. 同步规则

- **白名单**：sessions、settings.yaml、attachments、profiles/web、skills
- **明确排除**：`.credentials.yaml`、`.env`、`.token`、`node_modules/`、缓存
- **判变**：`mtime + size + sha256` 三元组
- **加密**：scrypt 派生密钥 → NaCl secretbox（encrypt-then-MAC）
- **断点续传**：远端分块 `<base>.partNNNN`，清单 `<base>.chunk-manifest.json`；
  大小匹配即视为已完成，大小不匹配则删残块重传
- **冲突**：两端 mtime 均晚于上次成功同步且 hash 不同 → 进入冲突列表
- **路径**：全部以 `~/.dsh` 相对路径存储，换机器可恢复

## 6. 排错

| 现象 | 原因 | 修复 |
|---|---|---|
| 安装失败，报 `无法连接 github.com` / `HEAD ... error (500)` | 大概率**不是网络**。展开安装详情，看有没有 `ERR_PNPM_NO_MATCHING_VERSION` | 见 1.3，`@deepseek-ai/*` 必须是 peer 依赖 |
| 安装失败，报 `ERR_PNPM_NO_MATCHING_VERSION` | 把宿主包写进了 `dependencies` | 改成 `peerDependencies` + `optional: true` |
| 安装成功但 `Cannot find module ... dist/index.js` | 仓库里没有构建产物 | `pnpm build` 后把 `dist/` 一起提交 |
| 插件列表里没有 | bundle 没进 `dsh.profile.bundles` | 重跑 `dsh plugin add` 看报错 |
| 列表有但不挂载 | `package.json` 缺 `dsh.bundle.patch` | 补声明后重装 |
| 列表有、`cordis.patch.yml` 也指向了，仍然静默不生效 | patch 层**顶层写成了 map**（`services:` / 直接 `- id:`） | 必须写成 `- insert: [...]`，见下方说明 |
| 面板在桌面端只有 920px 宽，右侧空出一大块 | 原先 `client.js` 的 `S.root` 自己限了 `maxWidth: 920px`，而宿主的设置内容列又是「宽度随内容收缩」的 flex 子项，光放开自己不够 | 已改为 `width:100% + flex:1`，并在挂载时由 `widenHostColumn()` 放开宿主那一层的 `max-width` / `flex-grow`（卸载还原，<720px 不启用） |
| 面板能渲染出来，但一直显示「页面没有拿到请求令牌」 | 桌面端**只消费结构化 `index-inject`** 的 boot payload，`ctx.webServer.tapIndex` 在桌面端完全不生效 | 见下方「桌面端注入」 |
| 设置页没入口 | namespace 两端不一致，或 `dsh.client` 没被扫到 | Host `nas-sync` vs Client `key: nas-sync`；确认 patch 已 insert |
| 密码框明文 | schema 没加 `role('secret')` | 补上，重启 |
| 桌面端装不上 | 用 CLI 装 desktop | 改用 App 内插件面板 |
| Compose 改了没生效 | Cordis 模块缓存 | 完全退出进程重开，不是关窗口 |

### `cordis.patch.yml` 必须是 `insert` 形式

profile 的 root 层 `cordis.yml` 内容是空数组 `[]`。`applyEntryPatches` 的规则是：

- **带 `insert`** 的 patch → 把 `insert` 数组推进目标条目（无 id 时推进 root 数组）✅
- **不带 `insert`** 的 patch → 必须按 `id` 命中**已存在**的条目，否则 `warn` 后**静默跳过**

root 是 `[]`，所以直接的 `- id: ...` 写法永远插不进去 → 插件不进 Loader 树 →
`dsh-client-modules` 扫不到它的 `dsh.client` → 前端不组合 client bundle →
**界面上完全没有入口**。正确写法：

```yaml
- insert:
    - id: nas-sync
      name: dsh-nas-sync
```

### 桌面端注入：`tapIndex` 不生效，必须用结构化 row

`dsh-host-webserver` 的 index 注入有**两套渲染器，共用一张 table**：

| 形态 | 渲染方式 | `tapIndex` 生效？ |
|---|---|---|
| `dsh web`（服务端） | `renderIndex(html)` = `applyIndexTaps(renderIndexInjections(html, rows))` | ✅ |
| Electron 桌面端 | 不渲染服务端 HTML。`dsh-desktop-host` 在 `ready` 时把 `collectIndexInjections()` 通过 IPC 交给主进程，主进程 `serveWebDocument` 直接返回打包好的静态 `index.html`，row 再由**页面侧解释器**执行 | ❌ 完全不生效 |

所以插件若只注册 `ctx.webServer.tapIndex(...)`，桌面端症状是：插件在列表里、
面板也能渲染，但 `window.__DSH_NAS_SYNC_TOKEN__` 永远是 `undefined`，面板一直卡在
「页面没有拿到请求令牌」。

正确做法（照 `@deepseek-ai/dsh-client-ui-theme`）：

```ts
ctx.on('webserver/index-inject', (table) => {
  table.push(
    { kind: 'global', name: '__DSH_NAS_SYNC_TOKEN__', value: token },
    { kind: 'global', name: '__DSH_NAS_SYNC_PREFIX__', value: BRIDGE_PREFIX },
  );
}, { prepend: true });
```

> 优先用 `kind: 'global'` 而不是 `kind: 'script'`：页面侧解释器对 `global` 直接
> `globalThis[name] = value`，不创建 inline `<script>`，省掉转义也避开 CSP。
> 本插件两条通道都注册：结构化 row 走主路，`tapIndex` 作服务端兜底（幂等）。


## 7. 已知限制

- 分块合并采用“清单 + 独立分块文件”方案，**不依赖** NAS 支持 WebDAV PATCH；
  读取方（下载）会按清单重组并校验整体 sha256。
- 行级 diff 用 LCS，超大文件（>5000 行级对比单元）会退化为“整段标为变更”，
  避免 UI 卡顿。
- 三路合并的 base 来自上一次成功同步时的备份（`<file>.base`），首次同步无 base，
  退化为两路对比。
- 自动同步定时器在配置变更后重建；间隔小于 1 分钟会被强制拉到 1 分钟。
- `bridge.ts` 的 `DefaultBridge` 是骨架，**必须由宿主实现替换**，不可直接使用。

## 8. 开源与许可

本仓库只含插件自身源码与构建产物，不包含 DeepSeek Harness 宿主、Android 壳或任何
官方 npm 包代码。它作为一个独立 Cordis 插件通过 `cordis.patch.yml` 挂载，需要宿主
提供 `@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery`、
`@deepseek-ai/dsh-home-paths`、`@deepseek-ai/dsh-client-core` 四个 peer 依赖，
以及 `bridge.ts` 里那套 RPC 实现。

许可：MIT（见 [LICENSE](LICENSE)）。

相关项目：

- 手机端宿主 APK：[`dsh-phone`](https://github.com/Benson-Cao/dsh-phone)
- 侧栏弹层交互补丁：[`dsh-web-mobile-phone-patch`](https://github.com/Benson-Cao/dsh-web-mobile-phone-patch)

> ⚠️ 同步涉及凭据（WebDAV 账号密码、加密口令）。`.gitignore` 已排除
> `.env` / `.credentials.yaml` / `*.token` / `*.bak` / 分块临时文件。
> 提交前请再确认一次没有把真实 NAS 地址或密钥写进示例配置。
> 加密快照的口令一旦丢失无法恢复，请自行离线保管。
