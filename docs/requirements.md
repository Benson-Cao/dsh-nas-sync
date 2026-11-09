# dsh-nas-sync · 需求追溯表（0.6.0）

> 对应 `dsh-nas-sync-0.5.8-审查报告.md` 的 **G11（UAT / BDD / 需求追溯）**。
> 每条需求一个唯一 ID，标注「需求描述 / 来源 / 实现文件:行号 / 自动化验证用例 / 当前状态」；
> `docs/uat/features/*.feature` 的每个场景用 `@REQ-xxx` 反查到本表，`@impl` 标注实现位置。
>
> 口径说明：
> - 「来源」写审查报告 G 编号或用户原话；0.5.9 / 0.6.0 的修复说明节号只作为补充说明，不冒充审查编号。
> - 「实现文件:行号」以 2026-11-09 的 `06403ec` / `756f7d9` 源码为准，行号随源码漂移需复核。
> - 「当前状态」只有四种取值：`已实现·已自动化验证` / `已实现·静态契约验证` /
>   `已实现·双端实跑未验证` / `本次补齐·已实跑` / `本次补齐·待接入`。「已实现」不等于「已在双端真实跑过」。

## 1. 总表

| ID | 需求描述 | 来源 | 实现文件:行号 | 自动化验证用例 | 当前状态 |
|---|---|---|---|---|---|
| REQ-001 | 一端删除（会话 / 附件 / 插件等全部 10 个分类）后，另一端下一轮同步把对应内容移进回收站，而不是继续保留或上传回去 | 用户诉求「一端删除另一端也删除」；G1、G4 | `src/sync/engine.ts:1422`（`applyRemoteDeletes`）、`src/sync/engine.ts:1997`（`scan`）、`src/sync/engine.ts:1481`（`publishEvents`）、`src/sync/events.ts:455`（`applyEventsToManifest`） | `test/delete-propagation.test.mjs`、`test/uat.test.mjs` UAT-1、`reports/coverage.txt` ok34/ok206 | 已实现·已自动化验证 |
| REQ-002 | 设备清单的判据必须「每一份都读成」才可信；读失败（`null`）与读到空清单（`[]`）严格区分，N 份坏 1 份时禁止任何回收 | G2（P0）；0.5.9 修复说明 Q01-a | `src/sync/safety.ts:60`（`evaluateManifestTrust`）、`src/sync/engine.ts:665`（全部读成才允许回收） | `test/safety.test.mjs`、「3 份清单坏 1 份时跑 4 轮也不许搬走本机会话」（`reports/coverage.txt` ok46/ok212/ok214） | 已实现·已自动化验证 |
| REQ-003 | 「连续两轮缺失」必须是严格连续：中间夹一轮不可信、条目又出现、脏数据都要把计数归零，不能累计成两轮 | G2（P0）；0.5.9 修复说明 Q01-b | `src/sync/safety.ts:70`（`RETIRE_AFTER_MISSING_ROUNDS = 2`）、`src/sync/safety.ts:89`（`advanceMissingRounds`）、`src/sync/safety.ts:98`（`shouldRetire`） | `test/safety.test.mjs`、ok47「第一轮不搬、第二轮才搬」、ok48「中间夹一轮不可信必须归零」、ok213 | 已实现·已自动化验证 |
| REQ-004 | 事件流出现坏 JSON / 坏签名 / seq 缺口 / 读失败时，整轮判为不可信并 fail-closed：一个本地文件都不许动 | G2、G10 防复发；用户诉求「宁可这轮不同步也不能删用户数据」 | `src/sync/events.ts:286`（`validateEventStream`）、`src/sync/events.ts:533`（`parseEventLog`）、`src/sync/safety.ts:119`（`eventStreamAllowsDeletes`）、`src/sync/engine.ts:1424`（闸口） | `test/events.test.mjs`（ok70-72）、`test/fault-injection.test.mjs`（ok95/98）、`test/uat.test.mjs` UAT-2、ok35/ok36 | 已实现·已自动化验证 |
| REQ-005 | 取消勾选某个分类、批量消失（条数 / 比例超阈）、排除集合内的 rel、运行时垃圾、不安全 rel 一律不进删除候选 | G10 防复发；`test/uat.test.mjs` UAT-3 对应的用户诉求 | `src/sync/safety.ts:173`（`computeLocalDeletes`）、`src/sync/safety.ts:130`（`DeleteCandidateInput`） | `test/delete-propagation.test.mjs`（ok40-45）、`test/uat.test.mjs` UAT-3 | 已实现·已自动化验证 |
| REQ-006 | 删除一律「移进回收站」而非硬删：会话目录搬入 `removed/<时间戳>/` 并写 `<id>.meta.json`，记录原始 rel / 远端 rel / 原因 / 时间 | G3（P0）；0.5.9 修复说明 Q03 | `src/sync/engine.ts:2484`（`retireLocalSession`，meta 在 `:2514`）、`src/sync/engine.ts:1400`（`retireGeneric`，meta 在 `:1415`）、`src/sync/engine.ts:2469`（`removedRoot`） | `test/engine.test.mjs`「回收 → 枚举 → 恢复」、`test/uat.test.mjs` UAT-1（ok229）、`scripts/recovery-drill.mjs`（本次新增） | 已实现·已自动化验证 |
| REQ-007 | 回收记录可枚举、可按 id 或原始 rel 恢复；恢复时重新登记侧栏、撤销屏蔽、目标目录已存在时拒绝覆盖；无 meta 的 legacy 目录不给自动恢复 | G3；0.5.9 修复说明 Q03 | `src/sync/engine.ts:2534`（`listRemovedSessions`）、`src/sync/engine.ts:2585`（`restoreRemovedSession`，目标已存在判据在 `:2599`）、`src/bridge.ts:427`（`GET /removed`）、`src/bridge.ts:430`（`POST /removed/restore`） | `test/engine.test.mjs`（ok49）、`test/panel.test.mjs`（ok114）、`test/recovery-drill.test.mjs`（本次新增） | 已实现·已自动化验证 |
| REQ-008 | 一次人工恢复演练后，恢复出的文件与原文件 **sha256 逐字节一致**，且 zstd **帧尾 / 帧数一致、无截断** | G3 验收口径「移回后帧数与原文件 `zstdFrameEnd()` 一致」；G12 | `src/sync/portable.ts:571`（`sessionFrameOffsets`，帧边界口径）；`scripts/recovery-drill.mjs`（本次新增演练与断言） | `test/recovery-drill.test.mjs`（本次新增，≥6 例）、`reports/recovery-drill.json`（本次实跑） | 本次补齐·已实跑 |
| REQ-009 | 屏蔽（ignore）/ 撤销屏蔽（unignore）全局事件化：对端 ignore 事件会同步到本机屏蔽清单，位点避免重复回放；断网 / 写失败时意图落盘，进程重启也不丢 | 用户诉求「点屏蔽这条会话时正好断网，操作不能丢」；G1 | `src/sync/engine.ts:1461`（消费 `ignore` / `unignore`）、`src/sync/engine.ts:736`（`ignoreSession`）、`src/sync/engine.ts:837`（`unignoreSession`）、`src/config.ts:375`（`Store.pendingIntents`） | `test/events.test.mjs`（ok37/ok38/ok79）、`test/uat.test.mjs` UAT-4、`test/fault-injection.test.mjs`（ok97） | 已实现·已自动化验证 |
| REQ-010 | 屏蔽清单损坏且无可用备份时 fail-closed：本轮禁用全部回收动作，错误经 `safetyStatus()` 暴露到 `/status` | 0.5.9 修复说明 Q05；G2 | `src/sync/engine.ts:762`（加载与 fail-closed）、`src/sync/state-file.ts:98`（`readJsonFile`，坏文件留证）、`src/sync/engine.ts:330`（`safetyStatus`）、`src/bridge.ts:201`（`GET /status`） | `test/state-file.test.mjs`（ok226）、`test/engine.test.mjs`（ok50「屏蔽清单写坏时 fail-closed」）、`reports/device-e2e.json` 的 `safety.ignoredFileError:null` | 已实现·已自动化验证 |
| REQ-011 | 分块上传写 `chunkHashes[]`，下载逐块 sha256 校验；某块被换掉但大小不变要报「第 N 块损坏」；内容变化强制覆盖；变小时清理残块；旧清单无 `chunkHashes` 仍可下载 | G10 防复发；0.6.0 第 11 节 P3 | `src/sync/chunker.ts:84`（`upload`）、`src/sync/chunker.ts:182`（`download`）、`src/sync/chunker.ts:212`（`cleanup`） | `test/chunker.test.mjs`（ok14-20，含「第 N 块损坏」「旧版清单仍可下载」） | 已实现·已自动化验证 |
| REQ-012 | 扫描排除规则单一真源：`scanner.ts` 与 `portable.ts` 两份不一致的集合合并进 `exclusions.ts`，scanner 侧与共享规则完全一致；正常用户内容不被误排除 | 0.6.0 第 11 节 P3；G10 防复发 | `src/sync/exclusions.ts:17`（`SKIP_DIR_NAMES`）、`src/sync/exclusions.ts:46`（`isIgnoredRelPath`）、`src/sync/scanner.ts:92`（`isIgnoredRel`） | `test/exclusions.test.mjs`（ok92-94，含「scanner 的 isIgnoredRel 与共享规则完全一致」） | 已实现·已自动化验证 |
| REQ-013 | canonical rel 会话主键：读侧永远双空间归并（`mergeDualRead`），默认 `legacy` 不改线上字节；`canonical` 但缺 `/dsh/migration.json` 时自动降级；`apply` 必须显式 `confirm:true`，默认只读预演；旧对象保留窗口内不删 | 0.6.0 第 12 节①；G6、G11 | `src/sync/rel-migration.ts:285`（`mergeDualRead`）、`src/sync/rel-migration.ts:253`（`rewriteManifestForMode`）、`src/sync/rel-migration.ts:188`（`validateRelPlan`）、`src/sync/engine.ts:1842`（`sessionRelPlan`）、`src/sync/engine.ts:1865`（`migrateSessionRels`）、`src/config.ts:86`（`sessionRelMode`）、`src/bridge.ts:252`（`GET /rel-migration`） | `test/rel-migration.test.mjs`（ok195-209）、`test/rel-migration-engine.test.mjs`、`test/api-contract.test.mjs`（ok13「apply 必须显式 confirm」）、`reports/device-e2e.json` 的 `relMigration.mode=legacy` | 已实现·双端实跑未验证 |
| REQ-014 | NSS2 信封 + 流式分块：`envelopeVersion=1` 仍写 NSS1，`=2` 才写带版本 / AAD 的 NSS2；`decrypt()` 永远双读，历史密文不失效；`sealStream` / `openStream` 的帧绑定 `(aad, index, final)`，拒绝重排 / 截断 / 多余帧 / 篡改 | 0.6.0 第 12 节②；G6 | `src/sync/crypto.ts:198`（`Crypto.decrypt` 双读）、`src/sync/crypto.ts:144`（`Crypto.seal`）、`src/sync/crypto.ts:251`（`sealStream`）、`src/sync/crypto.ts:303`（`openStream`）、`src/sync/crypto.ts:120`（`envelopeInfo`）、`src/sync/engine.ts:2182`（`seal` 接入） | `test/crypto.test.mjs`（ok25-33）、`test/envelope-engine.test.mjs`（ok54/55）、`test/api-contract.test.mjs` | 已实现·双端实跑未验证 |
| REQ-015 | 增量扫描缓存：默认开、TTL 24h；`(mtimeMs, ctimeMs, size)` 三元组命中即跳过 `readFile` 与 sha256；配置指纹变化整表失效；TTL / stat 变化 / hash 非法 / 缓存损坏单条重算并降级全量扫描 + 告警 | 0.6.0 第 12 节③；G12 | `src/sync/scan-cache.ts:63`（`configFingerprint`）、`src/sync/scan-cache.ts:90`（`shouldReuse`）、`src/sync/scan-cache.ts:118`（`ScanCacheSession`）、`src/sync/scan-cache.ts:206`（`loadScanCache`）、`src/sync/scanner.ts:129`（`Scanner.toEntry` 接入） | `test/scan-cache.test.mjs`（ok216-222）、`reports/device-e2e.json` 的 `safety.scanCache` | 已实现·已自动化验证 |
| REQ-016 | 插件 CAS：装配清单按 `包名@版本 + 平台/架构/ABI` 聚合；对象按 sha256 两级散列寻址；无宿主 CLI 的手机端从 CAS 校验 sha256 后零依赖解 `.tgz`，临时目录 + 原子重命名 + 失败回滚；拒绝路径穿越 / 符号链接 / 解压炸弹 | 0.6.0 第 11 节 P4、第 12 节④；G10 | `src/sync/plugin-objects.ts:46`（`buildAssemblies`）、`src/sync/plugin-objects.ts:110`（`pluginObjectPath`）、`src/sync/tgz.ts:131`（`safeTarPath`）、`src/sync/tgz.ts:143`（`unpackTgz`）、`src/sync/installer.ts:144`（`installFromCas`）、`src/sync/engine.ts:1617`（`publishPluginObject`）、`src/index.ts:1061`（`nas_publish_plugin_object`） | `test/plugin-objects.test.mjs`、`test/plugin-cas.test.mjs`（ok121-137、ok126、ok128）、`reports/device-e2e.json` 的 `plugins.casAssemblies:0` | 已实现·双端实跑未验证 |
| REQ-017 | 面板无障碍：异步结果进 `aria-live` live region；所有配置类输入框有 `aria-label`；破坏性恢复两步确认的状态用 `aria-pressed` 对读屏可见；分类 / 技能复选框由 label 包裹；中英文案都覆盖回收站 / 屏蔽入口 | G9 | `client.js:1046`（`aria-live`）、`client.js:1198`（`aria-label` 组）、`client.js:1483`（`aria-label` 两步确认）、`client.js:1485`（`aria-pressed`）、`client.js:870`（两步确认）、`client.js:191`（中文案）、`client.js:336`（英文案） | `test/a11y.test.mjs`（ok2-8）、`test/panel.test.mjs`（ok111-116） | 已实现·静态契约验证 |
| REQ-018 | HTTP 桥的配置视图只回脱敏布尔量（`passwordSet` / `passphraseSet`），绝不回显口令 / 口令短语 / WebDAV 密码明文 | G7（安全）；0.5.9 修复说明 Q06 | `src/bridge.ts:87`（`publicConfig`）、`src/bridge.ts:366`（`GET /config` 调用 `publicConfig`）、`src/config.ts:375`（`Store` 把口令拆到独立 0600 文件） | `test/api-contract.test.mjs`（ok11「配置视图只回 passthrough 布尔量，不回显口令」）、`reports/device-e2e.json` 的 `configKeys`（含 `passphraseSet`，不含 `passphrase` / `password`） | 已实现·已自动化验证 |
| REQ-019 | 远端 rel 进文件系统前三层校验：`isSafeRel()` 卡清单合并过滤、`downloadEntry()` 入口、`resolveLocal()` 纵深；`..` / 绝对路径 / 盘符 / 编码穿越 / 控制字符一律拒绝 | 0.5.9 修复说明 Q04；G4 | `src/sync/safety.ts:18`（`isSafeRel`）、`src/paths.ts:18`（`localOf`）、`src/sync/manifest.ts:83`（`mergeDeviceManifests` 过滤） | `test/safety.test.mjs`（ok210/ok211）、`test/engine.test.mjs`（ok51/ok53） | 已实现·已自动化验证 |
| REQ-020 | 发版冒烟：检查 `dist/index.js` 存在且 `node --check` 语法合法；三端部署 md5 一致性（参数 / 环境变量输入）；关键 HTTP 端点清单齐全；工具注册数恒为 21 | G10（关键路径冒烟脚本）、G13 | `scripts/smoke.mjs`（本次新增）、`src/bridge.ts:37`（`BRIDGE_PREFIX`）、`src/bridge.ts:201`-`:439`（21 个分派分支）、`src/index.ts:233`-`:1061`（21 个 `name: 'nas_*'` 注册） | `scripts/smoke.mjs` 实跑、`reports/smoke.json`（本次新增）、`test/api-contract.test.mjs`（ok8「工具注册数三处口径一致」） | 本次补齐·已实跑 |
| REQ-021 | 需求追溯 / BDD / UAT：需求 ID 表、`.feature` 打 `@REQ-xxx` 与 `@impl 文件:行号`、覆盖矩阵、真实用户验收计划与可自动采集的证据清单 | G11 | `docs/requirements.md`（本文件）、`docs/uat/uat-plan.md`、`docs/uat/uat-evidence.md`、`docs/uat/features/*.feature`（本次新增）、`test/uat.test.mjs`（已有 4 场景） | `docs/uat/features/*.feature` 反查脚本、`test/uat.test.mjs`（ok229-232） | 本次补齐·已实跑 |
| REQ-022 | 性能基线与恢复演练记录：负载模型可复现、SLO 有阈值、演练记录含 **恢复时长** 与 **目标恢复点**、帧数一致断言 | G12（性能 / 可靠性基线与演练）、G3 | `test/perf.test.mjs`（已有）、`scripts/recovery-drill.mjs`（本次新增）、`reports/recovery-drill.json`（本次新增） | `test/perf.test.mjs`（ok117-120）、`test/recovery-drill.test.mjs`（本次新增） | 本次补齐·已实跑 |
| REQ-023 | QA 流程与发版治理：CI 门禁、发版 checklist（双方部署 hash 一致性 / pending·conflicts 归零 / 回滚步骤 / tag 命名规则）、CHANGELOG、覆盖率按模块报告 | G13、G5 | `.github/workflows/ci.yml`（已有，ci#2 全绿）、`docs/release-checklist.md`、`CHANGELOG.md`、`scripts/coverage-modules.mjs`、`reports/coverage-modules.json`（本次新增） | `npm run verify`（232/232、覆盖率 73.56%、变异 10/10）、`ci#2` 10 步全绿 | 本次补齐·待接入（npm scripts / tag 由 team-lead 统一处理） |
| REQ-024 | 覆盖率按模块单列：`src/sync/*.ts` 逐个给行 / 分支覆盖率，标出零覆盖模块；**不擅自把 40% 门槛改成 80%** | G5（分支 ≥80% 且按模块单列、无模块为零）、G13 | `scripts/coverage-modules.mjs`（本次新增，只读 `reports/coverage.txt`，不改 `scripts/coverage.mjs`）、`reports/coverage-modules.json`（本次新增） | `scripts/coverage-modules.mjs` 实跑 | 本次补齐·已实跑 |

合计 **24 条需求**，`docs/uat/features/*.feature` 共 **24 个 Gherkin 场景**（每条需求恰好 1 个，场景的 `@REQ-xxx` 与本表 1:1 反查，见第 3 节覆盖矩阵）。

## 2. 逐条判定标准（把「已知限制」写成可判定断言）

按 G11 的要求，不写「待核实」，改写成「条件 → 操作 → 可判定断言」：

| ID | 条件 | 操作 | 可判定断言 |
|---|---|---|---|
| REQ-001 | 两端同一 NAS、事件流可信 | A 端 `nas_confirm_delete(rel)`，B 端跑一轮 `scan()` | B 端原路径不存在、`local` 清单不含该 rel、`listRemovedSessions()` 新增一条 `restorable:true` 且 `reason` 含 `event-delete` |
| REQ-002 | 3 份设备清单，其中 1 份读失败 | 连续跑 4 轮 `scan()` | 4 轮里 `removed/` 零新增，`eventStream.trusted` 或清单可信判据为 false |
| REQ-004 | 事件流追加一行坏 JSON | 跑一轮 `scan()` | 本地文件原地不动、`safetyStatus().eventStream.trusted === false`、`listRemovedSessions().length === 0` |
| REQ-008 | 会话文件含 N 个 zstd 帧 | `node scripts/recovery-drill.mjs` | 报告 `result === "PASS"`、恢复前后 `sha256` 相同、`frameCount` 相同、`zstdFrameEnd` 十六进制相同、`recoveryTimeMs >= 0` |
| REQ-013 | `sessionRelMode=canonical` 但无 `/dsh/migration.json` | 调 `GET /rel-migration` | `effectiveMode === "legacy"`，`valid === true`；`POST /rel-migration` 不带 `confirm` 时只返回预演计划、不写 marker |
| REQ-018 | 配置里设了口令与 WebDAV 密码 | 调 `GET /config` / `GET /status` | 响应里 `passwordSet === true`、`passphraseSet === true`，且全文不含口令明文 / `password` / `passphrase` 字段 |
| REQ-020 | 发版前 | `node scripts/smoke.mjs` | `reports/smoke.json` 的 `overall !== "FAIL"`，`checks` 中 `dist.syntax` / `endpoints` / `tools.count` 全 PASS；三端 md5 未提供时为 `SKIP` 并明确记录 |
| REQ-024 | 跑过 `npm run coverage` 后 | `node scripts/coverage-modules.mjs` | `reports/coverage-modules.json` 列出 `src/sync/` 全部 `.ts` 模块，`zeroCoverageModules` 单独成数组，`gate.minLines` 仍为 40 |

## 3. 需求 ↔ 场景覆盖矩阵

| 需求 ID | 对应 feature / 场景 |
|---|---|
| REQ-001 | `features/delete-propagation.feature` · 一端删除另一端移入回收站 |
| REQ-002 | `features/delete-propagation.feature` · N 份清单坏 1 份禁止回收 |
| REQ-003 | `features/delete-propagation.feature` · 严格连续两轮缺失才回收 |
| REQ-004 | `features/delete-propagation.feature` · 事件流坏一行整轮 fail-closed |
| REQ-005 | `features/delete-propagation.feature` · 关闭分类不误删对端 |
| REQ-006 | `features/recovery.feature` · 回收写 meta 而非硬删 |
| REQ-007 | `features/recovery.feature` · 枚举并按 meta 恢复 / 目标已存在拒绝覆盖 |
| REQ-008 | `features/recovery.feature` · 恢复后逐字节与 zstd 帧尾一致 |
| REQ-009 | `features/ignore-sync.feature` · 断网屏蔽意图不丢 / ignore 事件同步 |
| REQ-010 | `features/ignore-sync.feature` · 屏蔽清单损坏 fail-closed |
| REQ-011 | `features/integrity.feature` · 逐块校验与残块清理 |
| REQ-012 | `features/integrity.feature` · 排除规则单一真源 |
| REQ-013 | `features/migration-window.feature` · canonical 双读与默认 legacy |
| REQ-014 | `features/migration-window.feature` · NSS2 双读单写 |
| REQ-015 | `features/migration-window.feature` · 扫描缓存命中与失效 |
| REQ-016 | `features/migration-window.feature` · 插件 CAS 解包安全 |
| REQ-017 | `features/ui-security.feature` · 恢复两步确认对读屏可见 |
| REQ-018 | `features/ui-security.feature` · 配置视图不回显口令 |
| REQ-019 | `features/integrity.feature` · 远端 rel 路径穿越被过滤 |
| REQ-020 | `features/release-governance.feature` · 发版冒烟全绿 |
| REQ-021 | `features/release-governance.feature` · 每个场景反查唯一需求 ID |
| REQ-022 | `features/recovery.feature` · 演练记录含恢复时长与恢复点 |
| REQ-023 | `features/release-governance.feature` · 发版 checklist 与回滚 |
| REQ-024 | `features/release-governance.feature` · 覆盖率按模块单列并标零覆盖 |

## 4. 与 0.5.8 审查报告 G 编号的对应

| G 编号 | 审查报告标题 | 本表承接的需求 |
|---|---|---|
| G1 | 破坏性路径零自动化 | REQ-001、REQ-006、REQ-009 |
| G2 | 清单可信判据缺陷 | REQ-002、REQ-003、REQ-004、REQ-010 |
| G3 | 回收可恢复性无判据 | REQ-006、REQ-007、REQ-008、REQ-022 |
| G4 | 真实链路集成 / E2E | REQ-001、REQ-019 |
| G5 | 覆盖率 / 变异不可度量 | REQ-024 |
| G6 | 契约与版本矩阵 | REQ-013、REQ-014 |
| G7 | 接口 API 矩阵 | REQ-018 |
| G9 | 无障碍 | REQ-017 |
| G10 | 冒烟 / 回归 / 探索性 | REQ-005、REQ-011、REQ-012、REQ-016、REQ-020 |
| G11 | UAT / BDD / 需求追溯 | 全表（本文件）、REQ-021 |
| G12 | 性能 / 可靠性基线与演练 | REQ-008、REQ-015、REQ-022 |
| G13 | QA 流程与度量 | REQ-020、REQ-023 |
| G14 | 仓库外材料待索取 | 见 `docs/uat/uat-plan.md` 的「待业务方提供」小节，不冒充已通过 |
