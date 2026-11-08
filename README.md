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
  读取方（下载）会按清单重组并校验整体 sha256。
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
