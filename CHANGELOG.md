# 变更记录

## 0.7.0 — 2026-11-09

两件事：墓碑裁决换成**向量时钟**，以及**对端删除落地后侧栏自己刷新**（不用重启）。

### 1. 向量时钟取代墙钟 LWW

0.6.x 用 `ts`（本机墙钟）裁决同一 key 上 upsert 与 delete 谁赢。后果很直白：
**谁的钟快谁赢**。手机钟偏快两分钟，手机上的 upsert 就能盖掉电脑上的 delete——
删除被「伪复活」，与因果顺序无关。

- `models.ts`：新增 `VersionVector = Record<device, maxSeq>`；`SyncEvent.obs?`
  （发送方在写入这条事件时**已经看到**的各设备最大 seq）；`Tombstone.vc?`。
- `events.ts`：新增 `canonicalVector()` / `normalizeVector()` / `vectorClockOf()` /
  `dominates()` / `compareCausally()`（`after|before|concurrent|equal`）/
  `pickWinner()` / `stableTieBreak()` / `isContentOp()`。
- 裁决规则：
  - `a` 支配 `b` → `a` 赢（因果上更晚，这是唯一合法的「复活」）；
  - 互不支配（并发）→ **delete 赢**；
  - 两者 `obs` 都缺（旧事件）→ 退回原来的 `ts` 比较；
  - 仍打平 → `stableTieBreak()`（device 字典序 + seq），保证各端收敛到同一赢家。
- `buildTombstones()` 从「顺序扫、逐条比」重写为**按 key 归组 + 一次性裁决**。
  原来的实现依赖事件遍历顺序，同一批事件换个顺序可能得出不同墓碑——这是收敛性
  的隐患，现在裁决与顺序无关（有回归用例锁死）。
- `buildTombstones(events, { previous })`：事件日志被 GC、或某个分片读失败时，
  不能因此把删除忘掉。`previous` 里的墓碑若没有被因果上更晚的 upsert 真正复活，
  继续保留。
- `engine.ts`：新增 `causalFrontier()`，直接从 `eventStream` 算「别的设备最大 seq」。
  **不用 `deviceCursors`** —— 它是上一轮提交后的位点，落后于刚读进来的事件，用它
  会把自己刚发的事件算成并发。全部 5 处 `makeEvent()` 都带上 `obs`。
- 旧墓碑（无 `vc`）仍按 `e.ts > t.deletedAt` 兜底，升级不需要清墓碑缓存。

#### 关键互操作取舍：`obs` 不进签名

`SIG_KEYS` **不含** `obs`。若纳入签名，0.6.x 读端算出的哈希与新端不同 →
`verifyEvent()` 判成篡改 → `badSignatures` 非空 → 整轮事件流被判不可信 → **旧端
会直接关掉删除传播**。这不划算：新旧端混跑时，让旧端保持「能用但没有向量时钟
优势」远好于让它彻底失灵。回归用例：同一条事件带不带 `obs`，`sig` 必须完全一致。

### 2. 侧栏「已删会话」不用重启就消失

宿主的侧栏列表是它自己 `session/list` 拉来的**客户端缓存**，之后只跟着 Host 推的
`session/created` / `session/disposed` 更新。插件在宿主背后把会话目录搬进
`nas-sync/removed/`，宿主并不知情 → 那一行一直挂着，必须重启（重新拉 list）。

- `engine.ts`：新增 `removalEpoch` 计数器 + `removalEpochValue()` / `bumpRemovalEpoch()`。
  三个地方会 `+1`：`retireLocalSession()`（本机退场或按墓碑退场）、
  `pruneEmptySessionDirs` 真清掉目录、`restoreRemovedSession()`（恢复也算目录变了）。
- `bridge.ts`：`/status` 返回 `removalEpoch`。
- `client.js`：新增 `lookupService()` + `startSessionListAutoRefresh(ctx)`。每 4 秒拉一次
  `/status`，`removalEpoch` 变了就调宿主 `sessions.refresh()`（内部即
  `manager.refreshList()`，重新拉 `session/list`）。首轮只记基线不刷新，否则每次
  开页面都白拉一次；`document.visibilityState === 'hidden'` 时跳过。
- **为什么不写进 `inject`**：cordis 的 `inject` 缺服务会让**整个插件**停在 pending，
  连设置面板都不再注册。刷新只是锦上添花，绝不能因为宿主版本没这个服务就把面板
  弄没。所以运行时软查找（`ctx.get()` / `ctx[name]` / `ctx.root[name]` /
  `ctx.reflect.get()`），找不到就静静跳过。

### 测试

319 条全绿（新增 10 条：向量规范化与签名无关、0.6.x 老事件仍通过校验、
`dominates` / `compareCausally` 语义、**钟快不再作弊**、真复活、`buildTombstones`
顺序无关、`pickWinner` 并发收敛、旧墓碑墙钟兜底、新墓碑拒绝伪复活）。


## 0.6.3 — 2026-11-09

修「侧栏幽灵条目」：删除传播打通之后，本机 `sessions/<cwd编码>/<sid>/` 的**空目录**
还留着，宿主按目录枚举会话，于是侧栏里那条会话点得开、点开就报错。

- `portable.ts`：新增 `pruneEmptySessionDirs(deletedSids, home, opts)`。三个边界——
  ① 只删**空**目录（有残留文件一律不碰）；② 只删 session id 在「已删集合」里的
  目录（集合来自墓碑 `session:` 键 + 本机 DSH 回收站）；③ `mtime` 在 120 秒内的
  不碰，避免和正在进行的写入抢跑。`.sessions-trash` 以 `.` 开头，单独跳过。
- `engine.ts`：`scanOnce()` 里 `stripTrashed(local)` 之后调用它，清理失败只记日志、
  不影响本轮同步。
- 回归用例：`test/ghost-dir.test.mjs` 锁死上述三个边界 + `.sessions-trash` 永不
  被碰 + 空集合不做 IO。

真机验证（电脑端，真实 `~/.dsh`）：造 2 个已删会话的空目录 → 同步一轮 →
日志 `[dsh-nas-sync] 清掉 2 个已删会话留下的空目录`，两个目录确实消失。


## 0.6.2 — 2026-11-09

修复 0.6.1 没修透的那一环：**回收站剔除只做在扫描阶段，发布阶段漏了**。

- `engine.ts`：抽出 `stripTrashed(list)`，`scanOnce()` 与 `sync()` 里发布前那次
  `scanner.buildManifest()` 都过同一道闸。上一版只在扫描处剔除，而 `publishEvents`
  的 `fresh` 是**另行重建**的清单，被删会话在里面依旧「还在」→ `computeLocalDeletes`
  算不出差异 → delete 事件一条也发不出来（真机：识别到 7 条回收站会话、发出 0 条）。
- 回归用例：`test/delete-propagation.test.mjs` 新增「会话进回收站 → 同步一轮必须
  发出 `key=session:<sid>` 的 delete 事件」，同时断言基线里不再残留该会话。


## 0.6.1 — 2026-11-09

对应真机问题：「手机端删一个会话 → 两端各点一次立即同步 → 电脑端那条会话还在」。

### Fixed

- **回收站参与同步把删除意图弄丢了**：DSH 的「删除会话」不删文件，只在
  `sessions/.sessions-trash/` 下留一条隐藏记录。该目录落在 `sessions` 分类的扫描
  前缀内，且不在排除表里，于是被当成普通会话文件 `upsert` 上去 —— 对端收到的是
  「多了两个新文件」，还会把回收站目录下载到自己机器上，污染本机回收站。
  现在 `.sessions-trash` 进入统一排除表（`exclusions.ts`）。
- **回收站判据按 cwd 编码拼接，跨端永远对不上**：原来用 `<cwd编码>/<sid>` 比对，
  而 cwd 编码两端必然不同（安卓 `data-user-0-...` / 电脑 `C-Users-Administrator-...`）。
  结果本机清单里那条 rel 剔不掉 → 「上一轮有、这一轮也有」→ `computeLocalDeletes`
  算不出消失 → **0 条 delete 事件**。改为按 sessionId 单键判定
  （新增 `listTrashedSessionIds()`），扫描剔除与 `publishEvents` 的镜像放行同时修正。
- **回收站副本被误当成会话主键**：`sessionIdFromRel()` 会把回收站目录名当 sid，
  产生 `session:2026-11-09T...---...` 这种永远对不上真会话的假键，污染事件流与墓碑。
  现在回收站路径一律回落到 `rel:` 空间。
- **删除后侧栏幽灵会话**：注册表合并是单调并集，远端每轮会把已删除的 sid 并回
  `sessionIds`。现在合并时把墓碑里的 sid 一并剔除；`retireLocalSession()` 同时清
  `storages/session_projcache/sessions/<sid>.json`。
- **恢复会被墓碑再删一次**：`restoreRemovedSession()` 补发一条更晚的 `upsert` 事件，
  撤销墓碑（否则恢复后下一轮又被隐藏/回收）。

### Changed

- `sync()` 在合并工作区注册表**之前**读一次事件流（同一轮 10 秒内复用，不多走网络），
  注册表剔除才能用上本轮最新的墓碑。

## 0.6.0 — 2026-11-09

对应提交：`06403ec`（主体）、`756f7d9`（CI 修复）。真机包：`30.112.0 / r231`。

### Added

- **事件驱动删除传播**：`/dsh/events/<设备>/<分片>.jsonl` 只追加事件日志，
  `(device, seq)` + 稳定主键 + 自校验签名；读端合并分片 → 回放 → 墓碑 →
  对端按墓碑把本地文件移进回收站（可恢复），30 天后才真删远端对象。
  覆盖全部 10 个同步分类，不再只覆盖会话镜像。
- **删除三道防线**（`safety.ts`，fail-closed）：事件流任一分片读失败 / 签名坏 /
  `seq` 缺口 → 整轮禁止按事件删除；本机「上轮有本轮无」要过六道闸；删除只移进回收站。
- **canonical rel 双读**：`sessions/by-id/<sid>/vN/<file>` 与旧 cwd 编码 rel 并存，
  `sessionRelMode = legacy | shadow | canonical`，默认 `legacy`；读侧永远双空间归并，
  `canonical` 缺 `/dsh/migration.json` 时自动降级。
- **NSS2 信封**：`"NSS2" | ver | salt | nonce | aadLen | aad | secretbox`，AAD 绑定稳定主键；
  `sealStream()` / `openStream()` 的 `NSS2C` 帧绑定 `(aad, index, final)`，防重排 / 复制 / 截断。
  解密永远双读，历史密文不会失效。
- **增量扫描缓存**：`$DSH_HOME/nas-sync/scan-cache.json`，按 `mtimeMs/ctimeMs/size`
  三元组命中即跳过 `readFile` 与 sha256；配置指纹变化整表失效，坏缓存降级全量扫描。
- **插件包体 CAS**：包体按 sha256 存 `/dsh/objects/<前2位>/<sha>`，装配清单按
  `包名@版本 + 平台/架构/Node ABI` 记账；无宿主 CLI 的手机端零依赖解 USTAR / PAX /
  GNU longname `.tgz` 写 `node_modules`（临时目录 + 原子重命名 + 失败回滚）。
- **新增工具**：`nas_list_events`、`nas_confirm_delete`、`nas_session_rel_migrate`、
  `nas_publish_plugin_object`（总计 21 个）。
- **新增端点**：`GET /events`、`GET /events/status`、`POST /events/delete`、
  `GET|POST /rel-migration`、`POST /plugins/publish`。
- **质量资产**：`contracts/`（5 份 JSON Schema + 5 组 golden + 4 版版本矩阵）、
  `scripts/contract-verify.mjs`、`scripts/two-device-drill.mjs`、
  `scripts/a11y-runtime.mjs`、`scripts/device-e2e.{sh,mjs}`、CI Node 20/22 矩阵。

### Changed

- `scan()` 并发保护：并发调用复用同一轮结果，异常后解锁（不再可能出现两轮扫描
  互相覆盖 `pendingFiles`）。
- 工作区同名撞车：`loadWorkspaceDirs()` 不再静默改写映射，保留先到者并把冲突
  记进 `workspaceCollisions` + 日志。
- `npm test` 改为 `node --test` 自动发现，新增测试文件不再需要手工维护列表。
- 分块层逐块 sha256 校验；内容变化时强制覆盖并清理多余 `.partNNNN`。
- 排除规则统一到 `src/sync/exclusions.ts`；64 MiB 硬跳过改为可配置 `maxFileBytes`。

### Fixed

- **插件整体不激活**（真机 E2E 发现）：`nas_session_rel_migrate` 的 `confirm` 与
  `nas_publish_plugin_object` 的 `version` 写成 `required: false`，宿主 `defineTool()`
  的 schema 编译器抛 `JsonSchemaError: parameters.confirm.required must be true when
  present`，导致整个 bundle 未注册（页面无 token、所有 `/nas-sync-api/*` 404）。
  改为省略 `required`，并在 `test/api-contract.test.mjs` 加静态契约锁死。
- 墓碑 key/rel 不一致导致的误删。
- 断点续传在「块大小相同但内容变化」时跳过覆盖。
- CI `setup-node` 开 `cache:'npm'` 但仓库无 lock 文件导致 5 秒内失败。

### Security

- 凭据从 `store.json` 拆到 0600 的 `credentials.json`（仍为明文，系统 keyring 待宿主接口）。
- `keyCache` 不再用明文口令做 Map key，改为口令 sha256 + salt。
- HTTP 桥新端点使用标准状态码（400 / 401 / 409），错误不再一律 200。
- 远端 rel 进文件系统前做安全过滤（`isSafeRel`），拒绝 `..` / 分隔符 / 非法清单名。
- `security-audit.mjs`：5 条静态规则 + `npm audit --omit=dev`，high/medium 0。
