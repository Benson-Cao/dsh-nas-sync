# dsh-nas-sync — DeepSeek Harness NAS 同步插件

通过 WebDAV 或本地挂载（SMB / NFS）把 Harness 的会话、配置、附件、Profile、Skills
同步到 NAS，支持**分块断点续传**、**加密快照**、**冲突检测与合并**、**Compose 设置页**。

## 目录结构

```
dsh-nas-sync/
├── package.json              # dsh.bundle / dsh.client 声明 + 依赖
├── cordis.patch.yml          # bundle patch 层：把服务 insert 进 Loader 树
├── dist/index.js             # ⚠️ 已构建产物（约 810 KB，必须入库，见下文）
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
    │   └── portable.ts       #   跨设备可移植：工作区清单合并 / 工作区文件 / 会话 cwd 改写
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
| `retentionDays` | **0.6.0** 删除后回收副本保留天数，默认 30，`0` = 永久保留；到期才真删远端对象 |
| `maxFileBytes` | **0.6.0** 工作区 / 自定义文件夹单文件扫描上限，默认 64 MiB（此前是写死的硬跳过，配置改不动） |
| `sessionRelMode` | **0.6.0** 会话 rel 空间：`legacy`（默认，0.5.9 行为）/ `shadow`（双写）/ `canonical`（按 sid 主链）。读侧永远双空间归并，可回滚 |
| `envelopeVersion` | **0.6.0** 上传密文格式：`1` = NSS1（默认，兼容旧端）/ `2` = NSS2（带版本与 AAD）。解密永远双读，改这个数字不会让历史密文失效 |
| `scanCacheEnabled` / `scanCacheTtlHours` | **0.6.0** 增量扫描缓存开关与 TTL（默认开 / 24 小时）。配置指纹变化整表失效，mtime/ctime/size 任一变化单条重算 |
| `retentionDays`（迁移） | 迁移标记里的旧对象保留期也复用它，期内 GC 会跳过 legacy 会话对象 |

## 4. Host 半暴露的工具

共 **21 个**（与 `src/index.ts` 中 `ctx.tools.register` 实际注册数一致，0.6.0 收尾校准）。

| 工具 | 用途 |
|---|---|
| `nas_sync_status` | 完整快照（兼容旧调用方） |
| `nas_sync_subscribe` | 轻量快照，客户端 3s 轮询 |
| `nas_sync_scope` | 查看 / 设置同步分类勾选 |
| `nas_pending_files_page` | 待同步文件分页 |
| `nas_get_conflicts` | 冲突列表分页 |
| `nas_resolve_conflict` | 解决单条冲突（local/remote/skip） |
| `nas_skip_pending` | 把待同步文件移出待办 |
| `nas_plugin_audit` | 插件对账（只读，不安装） |
| `nas_sync` | 触发同步（push/pull/mirror） |
| `nas_stop_sync` | 中断同步（AbortController） |
| `nas_test` | 连通性自检 |
| `nas_set_config` | 修改并持久化运行期配置 |
| `nas_try_merge` | 三路合并（文本文件） |
| `nas_get_file_diff` | 行级 diff 预览 |
| `nas_list_removed` | **0.5.9** 列出回收目录里的会话（只读） |
| `nas_restore_session` | **0.5.9** 把回收的会话恢复回原处并重新登记侧栏 |
| `nas_manage_ignored` | **0.5.9** 查看 / 添加 / 撤销屏蔽（0.6.0 起会作为事件同步到对端） |
| `nas_list_events` | **0.6.0** 查看事件流、完整性判据、墓碑与各设备位点（排查删除传播首选） |
| `nas_confirm_delete` | **0.6.0** 手动发布一条 delete 事件；事件流不完整时拒绝执行 |
| `nas_session_rel_migrate` | **0.6.0** 会话 rel 空间迁移；默认只读预演，`confirm:true` 才复制对象、写 bidmap 与标记 |
| `nas_publish_plugin_object` | **0.6.0** 把本机 `.tgz` 包体发布进 CAS，并登记当前平台的装配清单 |

对应的 HTTP 桥端点：`GET /nas-sync-api/removed`、`POST /nas-sync-api/removed/restore`、
`GET|POST /nas-sync-api/ignored`，以及 0.6.0 新增的 `GET /nas-sync-api/events`、
`GET /nas-sync-api/events/status`、`POST /nas-sync-api/events/delete`、
`GET|POST /nas-sync-api/rel-migration`、`POST /nas-sync-api/plugins/publish`
（均需页面注入的 `x-nas-sync-token`）。

**面板入口（0.5.9 面板补齐）**：设置 → NAS 同步 →「回收站与本机屏蔽」卡片，
可以枚举回收记录并恢复（`restorable` 为 false 的旧记录只展示不给按钮，恢复需点两次确认）、
查看/添加/撤销本机屏蔽，并直接显示 `/status` 的 `safety`（屏蔽清单异常、设备清单读不全时
会红条说明「本轮为什么没做删除传播」）。0.5.8 及更早的 host 没有这三个端点，整张卡片自动隐藏。

### 4.1 事件驱动删除传播（0.6.0）

0.5.9 的删除传播靠「远端清单里这条连续两轮消失」推断，只覆盖 `sessionImports` 里的
跨平台会话镜像和本机屏蔽会话 —— **附件、技能、工作区文件删了对端毫无感知**。
0.6.0 改为显式事件日志：

- 每台设备只往 `/dsh/events/<设备>/<分片>.jsonl` 追加不可变事件（`upsert` / `delete` /
  `ignore` / `unignore` / `plugin-install` / `plugin-uninstall`），各写各的分片，不会互相覆盖；
- 事件带 `(device, seq)`、`ts`、稳定主键 `key` 和自校验签名 `sig`。会话按 **sessionId**
  归键（两端 cwd 编码不同、rel 永远不等，按 sid 才能对上），插件按
  `name@platform/abi` 归键，其余按 rel；
- 读端合并全部分片 → 按时序回放 → 生成墓碑（删除优先，默认保留 30 天）；
  `/dsh/tombstones.json` 是可重建的缓存，`/dsh/cursors/<设备>.json` 记本机处理位点；
- 一端删除 → 对端按墓碑把本地文件**移进回收站并写 meta**（不是硬删），30 天后
  `gcRemoteObjects()` 才真删远端对象与分块残块；
- 屏蔽清单全局事件化：一端 `ignoreSession()` 记一条待发布意图，下一轮同步广播，
  升级前已有的存量屏蔽不会补发历史事件。

**三道误删防线**（`src/sync/safety.ts`，均可离线单测）：

1. 事件流只要有一片读失败、一条签名不对、或某台设备 `seq` 有缺口 → 整轮禁止按事件删除；
2. 本机「上一轮有、这一轮没有」要过六道闸才敢发 delete 事件：事件流可信、远端清单可信、
   基线非空、rel 安全且落在**启用分类**内、条数 ≤ 50、消失比例 ≤ 0.5。
   关掉一个分类勾选**不会**变成「把对端该分类全删光」；
3. 删除只移进回收站，`nas_list_removed` / `nas_restore_session` 可恢复。

排障顺序：`nas_list_events` 先看 `trusted` 与 `gaps`，再看有没有 delete 事件、
`cursors` 推进到哪；`/status` 的 `safety.eventStream` 也会给出本轮为什么没做删除传播。

### 4.2 迁移窗口已落地的能力（0.6.0 收尾）

第 11 节修复说明里曾列为「需要独立迁移窗口、本轮刻意未做」的五项，现已全部实现，
但**默认都不改变线上已有字节**，通过模式开关 / 双读单写 / 显式确认来避免迁移风险：

| 能力 | 落点 | 默认行为 |
|---|---|---|
| canonical rel 会话主键 | `src/sync/rel-migration.ts`、`engine.ts` 的 `sessionRelPlan()` / `migrateSessionRels()` | `sessionRelMode='legacy'`（0.5.9 行为）。读侧永远双空间归并，`canonical` 缺 `/dsh/migration.json` 时自动降级 legacy；只有 `confirm:true` 才复制对象、写 `/dsh/bidmap.json` 与 marker，旧对象**只复制不删除**；同名不同 hash 整批拒绝 |
| 插件 CAS 解包写 `node_modules` | `src/sync/tgz.ts`、`installer.ts` 的 `installFromCas()` / `startCas()` | CLI 优先；无 CLI（手机端）自动从 `/dsh/objects/<sha前2位>/<sha>` 校验后零依赖解 USTAR/PAX/GNU longname `.tgz`，临时目录 + 原子重命名 + 失败回滚。拒绝路径穿越、符号/硬链接、设备文件与解压炸弹 |
| NSS2 信封 + 流式分块加密 | `src/sync/crypto.ts`、`engine.ts` 的 `seal()` | `envelopeVersion=1`（NSS1）继续写，兼容旧端；设成 `2` 才写带版本 + AAD 的 NSS2。`decrypt()` 永远双读，历史密文不会失效；`sealStream()` / `openStream()` 用 `NSS2C` 帧绑定 `(aad, index, final)`，防重排 / 复制 / 截断 / 篡改 |
| 增量扫描缓存 | `src/sync/scan-cache.ts`、`scanner.ts` 的 `toEntry()` | 默认开、TTL 24h（`$DSH_HOME/nas-sync/scan-cache.json`）。按 `mtimeMs/ctimeMs/size` 三元组命中即跳过 `readFile` + sha256；配置指纹变化整表失效，坏缓存降级为全量扫描并告警 |
| 完整质量体系 | `.github/workflows/ci.yml`、`scripts/coverage.mjs` / `mutation.mjs` / `security-audit.mjs` / `device-e2e.*`、`test/*` | `npm run verify` = build + 297 单测 + 覆盖率（门槛 40%，实测 74.48%）+ 10 个变异体全杀死 + SAST/SCA（high/medium 0）+ 契约 33/33。真机 E2E 已在物理设备上实跑通过（`reports/device-e2e.json`：`ok:true`、6 个端点全 200），可复跑 `npm run device:e2e` |

仍诚实保留的边界：**凭据仍拆在 0600 的 `credentials.json` 里但为明文**，真正的系统
keyring 需要宿主接口；`scan()` 仍无并发锁；`DefaultBridge` 仍是骨架；工作区文件按目录
基名做 rel 前缀，同名工作区会撞车。这些不因本轮收尾而消失。

## 5. 同步规则

- **按分类勾选**（`syncScope`，面板上有勾选框）：

  | 键 | 内容 | 默认 |
  |---|---|---|
  | `sessions` | `sessions/` 会话正文 | 开 |
  | `workspaces` | `storages/workspace.json` 工作区清单（侧栏的文件夹名与归属） | 开 |
  | `workspaceFiles` | 每个工作区**目录内容**（源码等），跳过 `node_modules` / `.git` | 开 |
  | `customFolders` | 用户自己指定的任意目录（映射表见 5.2） | 开 |
  | `sessionTitles` | `session-titles.json` 标题索引 | 开 |
  | `attachments` | `attachments/` 图片与文件 | 开 |
  | `skills` | `skills/` 自定义技能（可再按名字细分） | 开 |
  | `profiles` | `profiles/` 插件与 Profile | 关（敏感） |
  | `settings` | `settings.yaml` | 关（敏感） |
  | `pluginPatch` | `cordis.patch.yml` | 关（敏感） |

**关键技术点**：

- 映射目录叫 **`nassyncworkspaces`**，两个约束都踩过坑：
  ① 不能用 `workspaces/`——dsh 自己也把它当工作区根；
  ② **不能含连字符**——dsh 的会话目录名是 cwd 的编码（`-` 代表路径分隔符），
  `nas-sync-workspaces` 解码时会被拆成 `nas/sync/workspaces`，会话全掉进「未分组」。
- `workspace.path` 必须与会话 `header.cwd` **逐字符相同**（连斜杠方向都要一致），
  否则 dsh 判定「不属于该工作区」。
- 改了 `cwd` 就必须**同时迁移会话目录名**（`encodeCwd(cwd)`），否则 dsh 会自己
  "修复"成 `--旧cwd-新cwd--` 这种畸形目录。
- 会话列表由 **`storages/workspace.json` 的 sessionIds** 决定，dsh 不会主动扫
  `sessions/` 目录；另外还叠了一层 `session_projcache` 和前端 WebView 缓存，
  数据改完后必须一起清，否则界面不刷新。

- **明确排除**：`.credentials.yaml`、`.env`、`.token`、`node_modules/`、`.git/`、缓存、
  **`.asar`**（Electron 会把任何 `.asar` 当归档解析，构建产物放目录里会刷屏报错）、
  **超过 64 MiB 的单文件**（整块读入加密会拖死宿主，大文件请走 `attachments` 分类）
- **判变**：`mtime + size + sha256` 三元组
- **加密**：scrypt 派生密钥 → NaCl secretbox（encrypt-then-MAC）
- **断点续传**：远端分块 `<base>.partNNNN`，清单 `<base>.chunk-manifest.json`；
  大小匹配即视为已完成，大小不匹配则删残块重传
- **冲突**：两端 mtime 均晚于上次成功同步且 hash 不同 → 进入冲突列表
- **路径**：全部以 `~/.dsh` 相对路径存储，换机器可恢复

### 5.1 跨设备：工作区名与「会话不能续用」

会话头和工作区清单里存的都是**绝对路径**，直接搬到另一台设备会撞两堵墙：

1. 缺 `storages/workspace.json` → 侧栏工作区名全丢，同步来的会话落进「未分组」。
2. 会话头 `cwd` 固化了原机器路径（手机上是
   `/data/user/0/com.dsh.harness/files/home/wstest`）→ 打开就报
   `本轮运行失败：working-directory does not exist`。
   而 dsh **拒绝「换一个 cwd 打开已有会话」**（`ApiSessionCwdConflict`），
   调用方临时指定 cwd 无效，只能改写记录本身。

本插件在**落地时**处理：

- 工作区清单**只合并不覆盖**：本地已有 id 保留 path/title、只并 `sessionIds`，
  绝不抹掉本机自己的 `default-workspace`。
- **0.3.4 起再收一道**：本机注册表已可用时，`storages/workspace.json` **只上传、
  不下载合并** —— 双向 mirror 每轮拉注册表会把对端的工作区归属合进来，反复改写
  `default` / `path` / `sessionIds`。**0.3.5 起这是条件式的**：新机器首次同步
  （本机还没有可用注册表）仍然放行合并，否则侧栏工作区名会全丢。
- **0.5.5 修正上一版把「合并」也一起挡掉了的坑**：只要本机注册表可用，远端注册表
  就永不合并，于是手机上新加的工作区在电脑上永远不出现 —— 它那几十个文件确实下
  来了，但落在 `$DSH_HOME/workspaces/<名字>`（`resolveLocal` 查不到映射时的退化
  落点），既不在侧栏、也不在 `nassyncworkspaces/` 的扫描范围里，用户看到的就是
  「什么都没同步过来」。现在的规则：
  - **每轮同步开头**先拉远端注册表**合并**（只加不改，本地 path/title 一律保留）；
  - 合并后只有「本机有、远端缺」的标题或会话归属才**发布**一次（`registryCovers()`
    判定）。注册表是单文件、两端工作区 id 又天然不同，按哈希差异发布会让两台机器
    每轮互相盖回去 —— 5 分钟一次的无用上传；
  - 注册表**不进差集**，所以面板不会永远显示「待同步 1 项」；
  - 新增工作区落地时，若同名目录已在 `$DSH_HOME/workspaces/<名字>` 有实物，先
    **搬**到 `nassyncworkspaces/<名字>` 再登记：不重下一遍，也不留一份谁都看不见的垃圾。
- 远端绝对路径在本机不存在时，映射到 `$DSH_HOME/nassyncworkspaces/<名字>` 并 `mkdir`。
- 会话文件落地时改写表头 `cwd` 为映射后的路径；每轮同步结束再做一次幂等修复。
- **跨平台会话（0.5.6 起可以下地）**：判定看**原始 cwd**（不是映射后的路径）。
  0.3.4~0.5.5 是一刀切丢弃 —— 因为改写后的本地副本和远端原文永久不同字节，
  mirror 每轮都会「再下一次 + 再传一份」，和本机权威目录撞出同 id 双份
  （实测 11 份，被收尾的 `dedupeSessionDirs()` 反复隔离）。
  现在只要目标工作区**在本机已经有目录**就导入：
  - 落地时把 `cwd` 改成本机映射路径，目录名随之变成 `sessions/<本机cwd编码>/`；
  - 记一笔 `store.sessionImports`（远端原文 hash / 本地副本 rel / cwd），于是
    远端原文没变就**不再重复下载**，本地这份也不参与上传（它是镜像）；
  - 在本机接着聊（副本内容变了）→ `flushSessionImports()` 把 `cwd` 改回
    **原机器的路径**、按原 rel 回传，并把新指纹写回对端清单 —— 对端才会知道
    「远端变了」而去下载；
  - 没有落脚点（手机上 `.dsh` 之内的散装目录）仍然跳过：硬造一个空目录只会得到
    一个「打得开但模型跑不动」的幽灵会话。
  - 提醒：同一会话在两边**同时**继续仍然是一份文件，后写者覆盖（与普通文件同步一致）。
- **0.5.7 起会话还要「登记」才算同步完成**：dsh 侧栏按 `workspace.json` 里
  `sessionIds` 渲染，**不是**扫 `sessions/` 目录。实测证据：`Desktop\胎教Agent`
  目录里 3 个会话文件都在，侧栏只显示 2 个 —— 缺的那个正是注册表没登记的。
  所以落地后 `registerSessionForRel()` 立即补登记，每轮同步收尾再补齐一遍。
- **0.5.8 修两件事**：

  | 问题 | 现象 | 修法 |
  |---|---|---|
  | 字节哈希守卫挡住「更新更全的远端」 | 电脑上那条会话永远停在 562 字节的表头快照，手机已经 579570 字节 | `localIsStaleSnapshot()`：两端第 1..n 帧逐字节相同 = 本地只是更早的快照，允许覆盖（`B站UP主沐白若风` 即此例） |
  | 对端删了会话，本机反而把它传回去 | 手机上删掉的会话在电脑上反复复活 | 远端清单连续两轮都没有这条原文 → `retireImport()` 把本地镜像移进 `$DSH_HOME/nas-sync/removed/<时间戳>/`、清 `sessionIds`、销账 |

  删除传播有三重保险，因为「清单里没有」和「清单读失败」在数据上长得一模一样。
  **0.5.9 收紧了前两条**（0.5.8 的「至少一份」与「累计两轮」都不足以防误删）：
  ① 本轮**每一份**设备清单都解密成功（`evaluateManifestTrust()`），任何一份读失败
     整轮禁用删除传播；空清单算读成；
  ② `advanceMissingRounds()` 实现严格**连续两轮**：中间夹一轮不可信、或本轮又出现，
     计数立刻归零；
  ③ 回收是**移进回收目录**而不是硬删。0.5.9 起 `nas_list_removed` /
     `nas_restore_session` 可以真正枚举并恢复（0.5.8 只是口头承诺「随时捞回来」）。

- **0.5.9 修的全栈审查发现**（详见 `dsh-nas-sync-0.5.8-审查报告.md` 的 P0 条目）：

  | 问题 | 0.5.8 的行为 | 0.5.9 的修法 |
  |---|---|---|
  | 读到 1 份 / 共 3 份清单就当「清单可信」 | 另 2 份里的会话会被当成「对端删了」，两轮后回收 | `evaluateManifestTrust()`：必须全部读成 |
  | `missingRounds` 在不可信轮不复位 | 「连续两轮」实为「累计两轮」 | 纯函数 `advanceMissingRounds()`，任何打断归零 |
  | 本地只有 1 帧时 `localIsStaleSnapshot()` 直接 `return true` | 任何单帧会话都被当旧快照覆盖 | 新增 `sessionHeaderIdentity()`：忽略 cwd 比对首帧身份 |
  | 远端 `rel` 未校验即进文件系统路径 | `../` / 绝对路径可被诱导读写 | `isSafeRel()` 卡在清单合并、下载入口与 `resolveLocal()` 三层 |
  | `ignored-sessions.json` 写坏就静默清空 | 屏蔽被撤销，撤掉的会话复活 | 原子写 + `.bak` 自动恢复 + 无备份时 fail-closed 并禁用本轮回收 |
  | `store.json` 非原子写、解析失败整份重置 | 半截 JSON；连 scrypt salt 一起丢，历史密文解不开 | 原子写 0600；salt 独立存 `salt.hex`；逐字段恢复不整份重置 |
  | 口令类字段整份明文写在 `store.json` | 排障贴一次状态文件就泄密 | 拆到独立 0600 文件 `credentials.json`，自动从老格式迁移（**仍是明文，不是加密；keyring 迁移列为后续项**） |
  | Node 版本契约 18/20/22 三方冲突 | 低版本 zstd 降级静默失效，跨平台会话永远导不进来 | `engines.node >= 22.15.0`、构建 target 对齐、加载时 `zstdCapabilities()` 显式告警 |

> **只想让某条会话「不到这台机器」怎么办**：那是**单侧**需求，不是删除。
> 编辑 `$DSH_HOME/nas-sync/ignored-sessions.json`，写一个 sessionId 数组即可：
>
> ```json
> ["session-23009990-3a0e-42b1-a5f5-071147fe3dac"]
> ```
>
> **0.5.9 起不必手写文件**：设置面板「NAS 同步 → 回收站与本机屏蔽」可直接查看、
> 添加、撤销屏蔽，并恢复回收的会话；脚本侧用 `nas_manage_ignored`（`action: list|add|remove`）
> 或 `GET|POST /nas-sync-api/ignored`。插件每轮扫描开头重读这个文件：命中的会话
> **不下载、不上传**，本地已有的副本连同 `sessionIds` 登记一起移进 `nas-sync/removed/`。
> 远端原文不动，手机上的那份照旧。
>
> 写盘走原子写并同步刷新 `.bak`。文件损坏时**不会**静默清空：优先从 `.bak` 恢复；
> 连备份都不可用就置错误位、本轮禁用全部回收动作，并在 `/status` 的 `safety` 里报出来，
> 坏文件另存 `.corrupt-<时间戳>` 留证。
> 按 **sessionId** 而不是路径记 —— 同一条会话在 NAS 上可能有两份 rel（手机原文
> `sessions/--data-user-…` 和本机镜像曾被传上去的 `sessions/--C-Users-…`），
> 按路径记会漏掉另一半，会话照样被拉回来。
>
> 过滤同时卡在**注册表合并**里（`mergeWorkspaceRegistry` 的第三参）：否则远端注册表
> 每轮都会把这些 id 并回 `sessionIds`，侧栏留下一排「文件没了、点开报错」的幽灵条目。
> 只有「本机原本真的少了一条」才算变化并写盘 —— 远端并进来又立刻被挡掉属于净零变化，
> 不能让 `workspace.json` 每 5 分钟被重写一次。

> **为什么映射到 `~/.dsh/nassyncworkspaces/`**：它仍在 `$DSH_HOME` 之内，于是
> 「工作区文件」可以当成 rel 前缀 `workspaces/` 的普通分类来同步；同时手机上的
> `/data/.../home/wstest` 与电脑上的 `~/.dsh/nassyncworkspaces/wstest` 在 rel 空间里
> 收敛成同一个 `workspaces/wstest/`，两端算法一致就不会错位。
> 名字里刻意不带连字符（`-` 是 dsh 会话目录名里的路径分隔符）。

> **⚠️ 会话文件是「多帧追加」的 zstd**：每写一批记录就 append 一个 frame。
> Node 的 `zstdDecompressSync` / `createZstdDecompress()` **都只解第一帧**（实测：
> 一个 2035 字节、13 帧、共 2789 字节内容的会话文件，只拿到 224 字节表头）。
> 所以「整文件解开 → 改 → 整文件压缩」会把历史截成只剩表头。
> 正确做法是解析帧边界、**只重写第 0 帧**，后续帧逐字节保留 —— 见
> `src/sync/portable.ts` 的 `zstdFrameEnd()`。



### 5.2 插件：只同步「装配清单」，不搬包体

`profiles/<profile>/node_modules/` 里的插件**永远不会被同步** ——
`Scanner` 的 `walkFiles()` 遇到 `node_modules` 直接跳过。跨设备过去的只有：

```
profiles/<p>/package.json        pnpm-lock.yaml       cordis.yml
profiles/<p>/cordis.patch.yml    pnpm-workspace.yaml
```

所以典型现象是：另一端 `package.json` 里明明列着插件、插件列表却是空的。
原因有三条，缺一不可地阻止「插件自己跑过去」：

1. 包体在 `node_modules` 里，扫描器跳过；
2. 就算搬过去也没用 —— 手机是 `web` profile、电脑是 `desktop` profile，两套独立插件集；
3. 包体含平台相关产物（手机那份 109 MB，含 `playwright-core`、`puppeteer`），
   安卓的解压到 Windows 上跑不起来。

**补齐用「插件对账」**（0.4.0）：面板 → 插件对账 → 对账，它会拿
「远端各 profile 的 dependencies」减去「本机**选定 profile 的实际安装**」，
列出缺的插件并调宿主自己的 CLI 安装：

```
dsh plugin --profile <profile> add <包>@<版本>
```

几个刻意的设计：

- 比的是**实际安装**（`node_modules` 里有没有），不是本机 `package.json` ——
  后者也会被同步过来，拿清单比清单永远相等，看不出「清单到了包没装」。
- 不按 profile 同名对比：手机 `web` 对电脑 `desktop`，同名比永远比不出东西；
  默认优先取**当前正在跑的档**（读 `process.argv` 里 `bin.js` 后的档名），
  认不出来才退回「声明插件最多」的那个。
- 「本机已装」列表的口径是 profile 的 **dependencies**，不是 `node_modules` 目录：
  pnpm 是 hoisted 布局，目录里混着几百个传递依赖（`ansi-styles`、`@types/node`…），
  照目录列会把 5 个插件淹成 134 行包名。内置 `@deepseek-ai/*` 一律不列。
- `link:` / `file:` / `workspace:` 依赖指向对端本机路径，装不了，只展示不给按钮；
  `git+` 依赖已装即算满足（spec 是来源不是版本，拿它比版本号会永远不相等）。
- **手机上 git 依赖自动改走 tarball**：手机运行时里没有 git，`git+https://` 必然失败；
  目标档判为 mobile 时把 `https://github.com/<u>/<r>[#ref]` 改写成
  `https://github.com/<u>/<r>/archive/<ref|HEAD>.tar.gz` —— pnpm 走普通 HTTPS 下载，
  全程不碰 git。电脑档保留 git 形式，便于跟踪分支更新。
- **各自最优**：两端不追求同一套插件。平台专属的差集（如手机的 `dsh-web-mobile`）
  照样列出来，但标成「平台专属，本机不装」、不给安装按钮，也不进「全部安装」。
  设备类别从 profile 名（`desktop` / `web` / `acp`）与包名（`-mobile` / `-desktop` /
  `-cli`）推断，任一方认不出就完全不过滤 —— 宁可多报一条，不悄悄漏掉该装的。
  需要强装时在 `diffPlugins` 传 `allowPlatform` 放行。
- 版本按**范围下界**比大小：本机装得比清单要求更新算满足，不会为了「对齐」把本机
  降级（手机 0.82.0 不会把电脑的 0.82.1 拉回去）；`latest` 这类 tag 装了就算满足。
- 装完会把声明了 `dsh.bundle.patch` 的包登记进 `dsh.profile.bundles`
  （CLI 只转交 pnpm，不改这段声明），否则「装上了但不加载」。
- 手机端没有宿主 CLI，面板退化成只给命令、不代装。

### 5.3 自定义文件夹：每台机器各自映射

工作区文件只覆盖「工作区」这一种目录。要同步别的目录（比如 `D:\Projects`），
加一条**自定义文件夹**：

```json
{ "name": "projects", "path": "D:\\Projects" }
```

- `name` 是**跨设备的稳定标识**，决定远端 rel 前缀 `custom-folders/<name>/`。
- `path` 只在本机有意义 —— 另一台机器配 `{ "name": "projects", "path": "/srv/projects" }`
  也能对上同一份数据。这就是为什么不做「两端同一个绝对路径」：手机和电脑的
  盘符/目录结构天然不同，要求一致等于把功能限制成同机备份。
- 面板上「同步内容」勾选 `自定义文件夹` 后会出现编辑区，可增删条目；
  也可以调 `nas_sync_scope` 传 `customFolders`（整表替换，`[]` = 清空）。

安全约束（`normalizeCustomFolders` + `customFolderLocalOf`）：
`name` 会清掉路径分隔符与 Windows 非法字符（否则 `../x` 能写到 rel 空间之外）；
重名只保留第一条；下载时 rel 里出现 `..` 或空段直接拒绝。

### 5.4 文件夹来源设备标记

面板里「同步内容」的每个分类、以及「自定义文件夹」的每一行，会显示一个来源设备
emoji（💻 Windows / 📱 Android / 🖥️ macOS / 🐧 Linux）。**本机不显示**——自己传的
数据标自己的图标没有信息量。

实现要点：

- `ManifestEntry.device` 记录每个文件**最后上传的设备**（`平台:主机名`，如
  `win32:Benson` / `android:V2458A`）。
- 写远端清单时用「**内容哈希没变就保留原来源**」合并，否则每次同步都会把来源
  刷成本机，等于没记（见 `engine.sync()` 收尾）。
- `GET /devices` 按 rel 前缀统计来源，前端据此渲染；首次同步前清单里没有
  `device`，标记留空而不是显示「未知」。
- 旧版清单没有 `device` 字段，读到时按未知忽略，同步不受影响。

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
| 同步完成，但侧栏还是「未分组」、工作区名没有 | 没勾 `workspaces`（工作区清单不在白名单里，`storages/workspace.json` 根本不会传） | 面板勾上「工作区清单」再同步一次 |
| 同步来的会话一打开就报 `working-directory does not exist` | 会话头 `cwd` 是原机器绝对路径，本机没有该目录；而 dsh 拒绝换 cwd 打开老会话 | 见 5.1，落地时自动改写 cwd；已下地的旧文件跑一轮同步会被幂等修复 |
| 工作区目录里明明有文件，`workspaceFiles` 却是 0 | 该工作区的 `path` 在本机不存在（清单先到、文件没到），或 path 被设成了家目录 / 盘符根（安全策略拒绝同步） | 正常现象；等清单与目录就位，或把工作区指到具体子目录 |
| `debug.log` 里刷 `Failed to parse header from ...xxx.asar` | 目录里有 `.asar`（asar 打包产物）。Electron 会把任何 `.asar` 路径当归档解析，`stat`/`read` 各触发一次 | 0.2.5 起自动跳过 `.asar`；同时建议把构建产物移出工作区（动辄上百 MB） |
| 有文件没被同步，也没有报错 | 超过 64 MiB 单文件上限，或落在 `node_modules`/`.git`/`.asar` 里 | 是刻意跳过的；大文件请放进 `attachments` 分类 |
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
  读取方（下载）按清单重组，**0.6.0 起逐块校验密文 sha256**（坏块直接报到块序号），
  再校验整体明文 sha256。旧清单没有 `chunkHashes` 时退回整体校验，升级不会把历史
  分块判成损坏。内容变小后会主动清理多余的 `.partNNNN` 残块。
- 会话在不同设备上的 rel 永远不相等（目录名是 cwd 编码）。0.6.0 的删除/屏蔽事件
  按 sessionId 归并解决跨端对齐。0.6.0 已提供 canonical rel
  （`sessions/by-id/<sid>/vN/<file>`）的双读 + `sessionRelMode` 模式开关 + `confirm:true`
  迁移编排，但**默认仍是 legacy**：旧 rel 的线上对象不动，切换要管理员显式执行
  `nas_session_rel_migrate` 并写 `/dsh/migration.json` 才生效（见 4.2），不是升级即变。
- 行级 diff 用 LCS，超大文件（>5000 行级对比单元）会退化为“整段标为变更”，
  避免 UI 卡顿。
- 三路合并的 base 来自上一次成功同步时的备份（`<file>.base`），首次同步无 base，
  退化为两路对比。
- 自动同步定时器在配置变更后重建；间隔小于 1 分钟会被强制拉到 1 分钟。
- `bridge.ts` 的 `DefaultBridge` 是骨架，**必须由宿主实现替换**，不可直接使用。
- **工作区文件以目录基名做 rel 前缀**（`workspaces/<基名>`）。两个不同路径的工作区
  恰好同名（如 `/a/demo` 与 `/b/demo`）时，会在 rel 空间撞到一起、文件互相覆盖。
  这是刻意换取的简单性：换成 id 前缀就得在两端维护一份映射表，反而更容易错位。
- **工作区无法映射回原路径**：从手机同步来的工作区在电脑上一律落在
  `$DSH_HOME/workspaces/<名字>`，不会散落到 `Documents/` 之类的位置（那样风险更大）。
  想放到别处，同步后在工作区设置里改 path 即可，后续同步不会覆盖已有条目的 path。

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
