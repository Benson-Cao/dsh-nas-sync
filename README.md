# dsh-nas-sync — DeepSeek Harness NAS 同步插件

通过 WebDAV 或本地挂载（SMB / NFS）把 Harness 的会话、配置、附件、Profile、Skills
同步到 NAS，支持**分块断点续传**、**加密快照**、**冲突检测与合并**、**Compose 设置页**。

## 目录结构

```
dsh-nas-sync/
├── package.json              # dsh.bundle 声明 + 依赖
├── cordis.patch.yml          # Host 半：只挂服务
├── tsconfig.json             # Host 半编译
├── tsconfig.client.json      # 客户端半编译（桥接层）
└── src/
    ├── index.ts              # 插件主入口：注册工具 + 设置命名空间
    ├── config.ts             # 配置 schema / store / namespace
    ├── data/models.ts        # 跨层数据模型
    ├── nas/                  # 传输层：transport / webdav / mount
    ├── sync/                 # 同步引擎：scanner / crypto / chunker / engine / merger
    └── client/               # 客户端半（Compose）
        ├── bridge.ts               # RPC 桥接口（需宿主实现）
        ├── SyncViewModel.ts       # 状态 + 动作
        ├── index.ts               # 注册 settings.section 插槽
        └── components/
            ├── SyncStatusPanel.kt.source      # 主设置页
            ├── PendingFilesSheet.kt.source    # 待同步文件面板
            ├── ConflictDetailDialog.kt.source # 冲突处理弹窗
            └── NasSyncConfigSheet.kt.source   # 配置表单
```

## 1. 安装（web profile）

```bash
cd dsh-nas-sync
pnpm install
pnpm build                       # 输出 dist/index.js + dist/client.js

dsh plugin --profile web add "link:$PWD"
```

桌面版（Electron）**不能用 CLI 装**到 desktop profile，会报
`profile "desktop" is managed exclusively by the Electron application`，
请在 App 内「设置 → 插件 → 添加插件」填本地目录。

验证：

```bash
ls ~/.dsh/profiles/web/node_modules/dsh-nas-sync   # 依赖已链接
dsh --profile web --dump-config | grep nas-sync     # 配置层已挂载
```

> 关键：`package.json` 里的 `dsh.bundle.patch` 必须指向
> `cordis.patch.yml`，否则插件只是普通 npm 依赖，**不会挂载、不会生效**。

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
| 插件列表里没有 | bundle 没进 `dsh.profile.bundles` | 重跑 `dsh plugin add` 看报错 |
| 列表有但不挂载 | `package.json` 缺 `dsh.bundle.patch` | 补声明后重装 |
| 设置页没入口 | namespace 两端不一致 | Host `nas-sync` vs Client `key: nas-sync` |
| 密码框明文 | schema 没加 `role('secret')` | 补上，重启 |
| 桌面端装不上 | 用 CLI 装 desktop | 改用 App 内插件面板 |
| Compose 改了没生效 | Cordis 模块缓存 | 完全退出进程重开，不是关窗口 |

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

本仓库只含插件自身源码，不包含 DeepSeek Harness 宿主、Android 壳或任何官方
npm 包代码。它作为一个独立 Cordis 插件通过 `cordis.patch.yml` 挂载，需要
宿主提供 `@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery`、
`@deepseek-ai/dsh-home-paths` 三个 peer 依赖，以及 `bridge.ts` 里那套 RPC 实现。

许可：MIT（见 [LICENSE](LICENSE)）。

相关项目：

- 手机端宿主 APK：[`dsh-phone`](https://github.com/Benson-Cao/dsh-phone)
- 侧栏弹层交互补丁：[`dsh-web-mobile-phone-patch`](https://github.com/Benson-Cao/dsh-web-mobile-phone-patch)

> ⚠️ 同步涉及凭据（WebDAV 账号密码、加密口令）。`.gitignore` 已排除
> `.env` / `.credentials.yaml` / `*.token` / `*.bak` / 分块临时文件。
> 提交前请再确认一次没有把真实 NAS 地址或密钥写进示例配置。
> 加密快照的口令一旦丢失无法恢复，请自行离线保管。
