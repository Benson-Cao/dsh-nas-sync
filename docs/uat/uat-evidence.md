# dsh-nas-sync 0.6.0 · UAT 证据清单与 2026-11-09 实测结果

> 对应审查报告 **G11（每条断言有 PASS/FAIL 与证据）** 与 **G13（发版记录可追溯）**。
> 本文件分两部分：第 1 节是「本机可自动采集的证据清单模板」（发版时逐项跑、逐项贴结果）；
> 第 2 节是 **2026-11-09 已经真实采集到的结果**，全部数值直接取自
> `reports/device-e2e.json`（真机 CDP E2E 的原始输出），**没有补写、没有推测、没有编造**。
> 第 3 节列出「本次未采集」项，不把它们写成 PASS。

## 1. 本机可自动采集的证据清单（模板）

「自动化程度」一列区分：`全自动` = 一条命令产出结构化 JSON；`半自动` = 脚本产出数据但判定
需人确认；`人工` = 必须真人操作 / 物理设备，脚本不得代填。

| 证据 ID | 对应任务 / 需求 | 采集命令 | 产出路径 | 自动化程度 | 判定标准 | 本次状态 |
|---|---|---|---|---|---|---|
| E01 | T01 / REQ-001 | `node --test test/uat.test.mjs` | `reports/coverage.txt` 的 UAT-1 | 全自动 | `ok 229` 通过，文件移入 `removed/` | 已采集（自动化层） |
| E02 | T01 / REQ-001 | `node scripts/device-e2e.sh`（需物理设备 + `adb forward`） | `reports/device-e2e.json` | 半自动 | `status.ok===true` 且 `safety` 存在 | 已采集，见第 2 节 |
| E03 | T02 / REQ-006 | 同上，`/removed` 分节 | `reports/device-e2e.json.removed` | 半自动 | `http:200` 且 `ok:true` | 已采集，见第 2 节 |
| E04 | T02 / REQ-007 | `node --test test/engine.test.mjs`（含「回收 → 枚举 → 恢复」） | `reports/coverage.txt` 的 ok49 | 全自动 | `ok 49` 通过 | 已采集（自动化层） |
| E05 | T03 / REQ-008 | `node scripts/recovery-drill.mjs` | `reports/recovery-drill.json` | 全自动 | `result==="PASS"`，含 `recoveryTimeMs` / `recoveryPoint` / `frameCount` | 本次新增，已实跑 |
| E06 | T04 / REQ-002 / REQ-004 | `node --test test/fault-injection.test.mjs test/delete-propagation.test.mjs` | `reports/coverage.txt` 的 ok95/ok96/ok98、ok34-36 | 全自动 | 注入后零回收、事件流不可信 | 已采集（自动化层） |
| E07 | T05 / REQ-005 | `node --test test/uat.test.mjs`（UAT-3） | `reports/coverage.txt` 的 ok231 | 全自动 | 零删除、`excludedCount===10` | 已采集（自动化层） |
| E08 | T06 / REQ-009 | `node --test test/uat.test.mjs`（UAT-4） | `reports/coverage.txt` 的 ok232 | 全自动 | `pendingIntents` 重启后仍在 | 已采集（自动化层） |
| E09 | T07 / REQ-010 | `node --test test/engine.test.mjs`（Q05 实测） | `reports/coverage.txt` 的 ok50 | 全自动 | 屏蔽清单损坏 fail-closed | 已采集（自动化层） |
| E10 | T08 / REQ-011 / REQ-012 | `node --test test/chunker.test.mjs test/exclusions.test.mjs` | `reports/coverage.txt` 的 ok14-20、ok92-94 | 全自动 | 「第 N 块损坏」、排除规则一致 | 已采集（自动化层） |
| E11 | T09 / REQ-013 / REQ-014 | `node --test test/rel-migration.test.mjs test/crypto.test.mjs`；真机 `GET /rel-migration` | `reports/device-e2e.json.relMigration` | 半自动 | `mode=legacy`、`valid=true` | 已采集，见第 2 节 |
| E12 | T10 / REQ-015 / REQ-016 | `node --test test/scan-cache.test.mjs test/plugin-cas.test.mjs`；真机 `GET /plugins` | `reports/device-e2e.json.safety.scanCache` / `.plugins` | 半自动 | 缓存统计可读、`casAssemblies` 有值 | 已采集（端点级），双端大文件实跑未采集 |
| E13 | T11 / REQ-017 | 人工：屏幕阅读器 / TalkBack / 键盘 Tab / 200% 缩放 | 人工记录（本文件第 3 节） | 人工 | 严重 / 关键违规 = 0 | **未采集** |
| E14 | T12 / REQ-018 | 真机 `GET /status` / `GET /config` | `reports/device-e2e.json.status.configKeys` | 半自动 | 无 `passphrase` / `password` 明文字段 | 已采集，见第 2 节 |
| E15 | T13 / REQ-019 | `node --test test/safety.test.mjs`（ok210/211）、`test/engine.test.mjs`（ok51/53） | `reports/coverage.txt` | 全自动 | 路径穿越被过滤 | 已采集（自动化层） |
| E16 | T14 / REQ-020 / REQ-023 | `node scripts/smoke.mjs`；核对 `ci#2`；`docs/release-checklist.md` | `reports/smoke.json` | 半自动 | `overall!=="FAIL"`，三端 md5 若 `SKIP` 须补实值 | 本次新增，已实跑（三端实值见第 3 节） |
| E17 | T15 / REQ-023 | 人工：还原旧 `dist/index.js` → 重启 → 再恢复 0.6.0 | 人工记录 | 人工 | 两端可正常回到 0.6.0 | **未采集** |
| E18 | T16 / REQ-024 | `node scripts/coverage-modules.mjs` | `reports/coverage-modules.json` | 全自动 | 列出全部 `src/sync/*.ts` 并标零覆盖模块 | 本次新增，已实跑 |

采集命令统一在仓库根目录执行；`reports/*.json` 为脚本原始输出，禁止手工编辑数值。

## 2. 2026-11-09 真机 E2E 实测结果（数据源：`reports/device-e2e.json`）

采集时间：`at = "2026-11-09T07:24:06.151Z"`（UTC；本地 +0800 即 15:24）。
采集方式：`scripts/device-e2e.sh` + `scripts/device-e2e.mjs`，物理设备
`192.168.0.100:5555`，页面上下文注入 `x-nas-sync-token`，前缀 `prefix = "/nas-sync-api"`。

### 2.1 总体门禁

| 字段 | 实测值 | 判定 |
|---|---|---|
| `ok` | `true` | PASS |
| `failures` | `[]`（空数组） | PASS |
| `tokenPresent` | `true` | PASS（页面已注入 token，对应 P4） |
| `prefix` | `"/nas-sync-api"` | 记录 |

### 2.2 `/status`

| 字段 | 实测值 | 判定 |
|---|---|---|
| `http` | `200` | PASS |
| `ok` | `true` | PASS |
| `hasSafety` | `true` | PASS（跑的是 0.6.0 bundle，对应 P2 的配置字段已在） |
| `storeError` | `null` | PASS（状态文件无异常） |

`safety` 子对象：

| 字段 | 实测值 |
|---|---|
| `ignoredFileError` | `null` |
| `manifestTrustFailed` | `[]` |
| `destructiveBlocked` | `false` |
| `eventStream.trusted` | `true` |
| `eventStream.events` | `0` |
| `eventStream.tombstones` | `0` |
| `eventStream.failed` | `[]` |
| `eventStream.gaps` | `0` |
| `eventStream.published` | `0` |
| `eventStream.lastError` | `null` |
| `scanCache.enabled` | `true` |
| `scanCache.hits` | `0` |
| `scanCache.misses` | `163` |
| `scanCache.changed` | `0` |
| `scanCache.expired` | `0` |
| `scanCache.invalidated` | `false` |
| `scanCache.warning` | `null` |

> 判读：`misses=163 / hits=0` 说明本次采集时缓存未命中、按全量重算（冷启动后的首轮属预期），
> 不是缺陷；`invalidated=false` 且 `warning=null` 说明缓存文件本身没坏。此处只照抄数值，
> 不把「缓存命中率」写成达标。

`snapshot` 子对象：

| 字段 | 实测值 | 判定 |
|---|---|---|
| `lastSyncTime` | `1794208029853` | 记录 |
| `phase` | `"scanning"` | 记录（采集瞬间处于扫描阶段） |
| `progress.total` | `0` | 记录 |
| `progress.done` | `0` | 记录 |
| `progress.errors` | `0` | PASS |
| `pendingCount` | `0` | **PASS（对应发版 checklist 的 pending 归零）** |
| `conflictCount` | `0` | **PASS（对应发版 checklist 的 conflicts 归零）** |
| `running` | `false` | PASS |

`configKeys`（17 个，全部照抄）：

```
type, webdav, mountRoot, passphraseSet, autoSync, includeSensitive, syncScope,
skillFilter, chunkThreshold, chunkSize, concurrency, retentionDays, maxFileBytes,
sessionRelMode, envelopeVersion, scanCacheEnabled, scanCacheTtlHours
```

> 判读：含 `passphraseSet`（布尔量），**不含** `passphrase` / `password` 明文字段 →
> REQ-018 在真机端点级成立；含 0.6.0 新增的 `sessionRelMode` / `envelopeVersion` /
> `scanCacheEnabled` / `scanCacheTtlHours` → P2 的「新 bundle 已加载」在手机端成立。

### 2.3 其余端点

| 端点 | 字段与实测值 | 判定 |
|---|---|---|
| `/events?limit=20` | `http:200, ok:true, trusted:true, count:0, tombstones:0` | PASS（事件流可信，无待消费删除） |
| `/rel-migration` | `http:200, ok:true, mode:"legacy", effectiveMode:"legacy", valid:true, mappings:55` | PASS（默认仍是 legacy，55 条为只读预演映射，未写 marker → P5 成立） |
| `/plugins` | `http:200, ok:true, canInstall:false, casAssemblies:0` | PASS（端点可用；装配清单为空，符合默认未切生产模式） |
| `/ignored` | `http:200, ok:true, ids:[]` | PASS（屏蔽清单为空、无错误） |
| `/removed` | `http:200, ok:true, count:0` | PASS（回收站为空，本次没有破坏性回收发生） |

### 2.4 由真机数据可直接支撑的验收结论

- **P3（pending/conflicts 归零）**：`pendingCount=0` / `conflictCount=0` / `running=false` → PASS。
- **P4（token + 六端点 200）**：`tokenPresent=true` 且 `/status` `/events` `/rel-migration`
  `/plugins` `/ignored` `/removed` 全部 `http:200` → PASS。
- **P5（默认 legacy、未改写线上数据）**：`relMigration.mode=legacy`、`effectiveMode=legacy`、
  `valid=true` → PASS。
- **P6（配置不回显口令）**：`configKeys` 含 `passphraseSet` 而无口令明文字段 → PASS。
- **REQ-010 / REQ-015 / REQ-016 的端点级观测**：`ignoredFileError=null`、
  `scanCache.*` 可读、`plugins.ok=true` → 端点级 PASS，但不等于运行时 / 双端实跑已验证。

### 2.5 真机数据**不能**支撑的结论（明确排除）

- 不能证明「一端删除另一端也删」真实发生过：本次 `events.count=0`、`removed.count=0`，
  采集窗口内没有任何删除或回收事件。该结论只由 `test/uat.test.mjs` / 
  `scripts/recovery-drill.mjs` 在离线层证明。
- 不能证明 NSS2 / canonical rel / 插件 CAS 的双端真实同步：`envelopeVersion` 与
  `sessionRelMode` 都是默认值，`casAssemblies=0`。
- 不能证明无障碍达标：本次采集不含屏幕阅读器 / TalkBack / 键盘可达性数据。
- 不能证明 PC 端已加载 0.6.0：真机 E2E 只覆盖手机 WebView；PC 宿主进程未重启（第 13.1 节）。

## 3. 本次未采集 / 待人工补齐（不得写成 PASS）

| 编号 | 缺什么 | 谁补 | 关联任务 / 需求 |
|---|---|---|---|
| N01 | 真实用户 R2/R3 的 UAT 操作记录与签字 | 业务方 / 维护者 | T01、T05、T06 / REQ-001、REQ-005、REQ-009 |
| N02 | 读屏用户 R4 的 axe-core / WCAG 2.1 AA / TalkBack / 键盘 Tab / 200% 缩放实扫 | 业务方 | T11 / REQ-017 |
| N03 | 三端（源码 / PC / 手机）`client.js`、`dist/index.js`、`package.json` 的**发版当刻** md5 实值 | 发布人（R1） | E16 / REQ-020、REQ-023 |
| N04 | PC 宿主进程完全重启后的 `/events` 与 `/rel-migration` 200 记录 | 发布人（R1） | P2 / REQ-023 |
| N05 | 一次真实回滚演练记录（还原旧 bundle → 重启 → 恢复 0.6.0） | 发布人（R1） | T15 / REQ-023 |
| N06 | 双端真实跨设备大文件同步（含 NSS2 密文 / canonical rel / 插件 CAS 发布→解包） | 维护者 | T10 / REQ-013、REQ-014、REQ-016 |
| N07 | APK 重新打包（`assets/dsh-nas-sync/` 仍是 r170 产物） | 发布人 | 修复说明第 13.1 节 |
| N08 | G14 外部材料：环境分布、宿主 / WebView 版本、WCAG 目标等级 | 业务方 | `docs/uat/uat-plan.md` 第 7 节 |

> 证据使用原则：脚本产出的 `reports/*.json` 是**原始输出**，人只负责把它抄进本表并写判读，
> 不得为了让结论好看而改数值；「未采集」项在未补齐前一律保持 `待采集`，不参与整体出口判定。
