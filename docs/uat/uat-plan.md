# dsh-nas-sync 0.6.0 · 真实用户验收计划（UAT Plan）

> 对应审查报告 **G11（UAT / BDD / 需求追溯）** 与 **G14（仓库外材料待索取）**。
> 本计划与 `docs/uat/features/*.feature`（可自动化的 BDD 场景）、`test/uat.test.mjs`（4 个
> Given→When→Then 自动化场景）是互补关系：**自动化场景证明「逻辑对」，本计划证明「人真的能
> 用」**。自动化场景不能替代真实用户验收，本计划里的签字栏不得由脚本代填。

## 1. 角色

| 角色代号 | 角色 | 关注点 | 本轮是否到场 |
|---|---|---|---|
| R1 | 维护者 / 发布人 | 部署、配置、回滚、发版门禁、证据归档 | 是（2026-11-09 已完成部署与真机 E2E） |
| R2 | 普通用户（PC 主力） | 会话 / 附件跨端可见、删除能传播、误删能恢复 | 待安排（见第 7 节遗留） |
| R3 | 普通用户（手机主力） | 手机冷启动后生效、屏蔽 / 回收站入口、断网不丢操作 | 待安排 |
| R4 | 读屏用户（屏幕阅读器 / TalkBack） | live region、aria-label、两步确认状态、键盘可达 | 待安排 |
| R5 | NAS 管理员 | WebDAV 可达性、对象与清单写入、清理策略 | 待安排 |

## 2. 设备与环境

| 代号 | 设备 | 实际环境（已核实部分） | 用途 |
|---|---|---|---|
| D1 | Windows 11 PC | `DeepSeek Harness.exe` / `dsh-desktop-host`；Node ≥ 22.15.0 | 主操作端、发版端 |
| D2 | Android 手机（物理设备） | 无线 adb `192.168.0.100:5555`；设备 Node v24.18.0；WebView | 对端、真机 E2E |
| D3 | NAS / WebDAV | `/nas-sync-api` 前缀由页面注入 token；`/dsh/...` 远端命名空间 | 传输与共享状态 |
| D4 | GitHub Actions | `ubuntu-latest` / Node 22，`ci#2` 10 步全绿 | 远端质量门禁 |

> 待业务方补齐（G14）：Android / Windows 实际 WebView 版本、分辨率分布、时区与语言分布、
> `.kt.source` 是否已并入宿主编译链、WCAG 目标等级。这些不写「已核实」。

## 3. 前置条件

| # | 前置条件 | 判定方式 | 2026-11-09 状态 |
|---|---|---|---|
| P1 | 三端（源码 / PC / 手机）的 `client.js`、`dist/index.js`、`package.json` md5 一致，版本 0.6.0 | `node scripts/smoke.mjs` 的三端 md5 检查；修复说明第 12.3 节记录 `b6d4a65e…` / `5efb7139…` / `73ad7a88…` | 源码侧已一致；三端实值须在发版时重新由人提供（见第 7 节） |
| P2 | 两端 DSH 进程完全重启，新 bundle 已加载 | `/status` 的 `configKeys` 含 `sessionRelMode` / `envelopeVersion` / `scanCacheEnabled` / `scanCacheTtlHours` | 手机端已生效（`reports/device-e2e.json`）；PC 端宿主进程尚未重启（修复说明第 13.1 节） |
| P3 | `pendingCount === 0`、`conflictCount === 0`、`running === false` | `GET /status` 的 `snapshot` | **通过**：真机 E2E 实测三项为 0 / 0 / false |
| P4 | 页面注入 `x-nas-sync-token`，六个关键端点均 200 | `scripts/device-e2e.mjs` 的门禁 | **通过**：`tokenPresent:true`，全部 `http:200` |
| P5 | 默认仍是 legacy 生产模式，不改写线上数据 | `GET /rel-migration` 的 `mode` / `effectiveMode` | **通过**：`legacy` / `legacy`（真机 E2E `mappings:55` 为只读预演） |
| P6 | 口令已设置但配置视图不回显 | `GET /config` 只回 `passwordSet` / `passphraseSet` | **通过**：`configKeys` 含 `passphraseSet`，无口令字段 |
| P7 | 有可用回滚点（旧 `dist/index.js` 可还原） | `git show 7d9b498^:dist/index.js`、PC / 手机 `*.bak060` 备份 | 已具备（修复说明第 12.3 节） |

## 4. 任务清单

每条任务写清「角色 / 设备 / 操作 / 证据位置」。判定标准见第 5 节。

| 任务 ID | 对应需求 | 角色 | 设备 | 操作 | 证据位置 |
|---|---|---|---|---|---|
| T01 | REQ-001 | R2 | D1 → D2 | 在 PC 删一条会话，手机跑一轮同步，观察是否移入回收站且清单不再含该 rel | `docs/uat/uat-evidence.md` E01、E02 |
| T02 | REQ-006 / REQ-007 | R2 | D2 | 打开「回收站与本机屏蔽」卡片，查看条目（rel / 时间 / 原因 / 可恢复），点恢复并二次确认 | E03 / E04 |
| T03 | REQ-008 | R1 | D1 | `node scripts/recovery-drill.mjs`，核对 `reports/recovery-drill.json` 的 sha256 / 帧尾 / 帧数 | E05 |
| T04 | REQ-002 / REQ-004 | R1 | D1 | 人工把 NAS 上一份设备清单改坏 / 事件日志追加坏行，跑一轮观察是否零回收 | E06 |
| T05 | REQ-005 | R3 | D2 | 设置里取消勾选「附件」，跑一轮，确认对端附件没被删光 | E07 |
| T06 | REQ-009 | R3 | D2 | 断网状态下点「屏蔽这条会话」，恢复网络后跑一轮，确认屏蔽生效且未丢 | E08 |
| T07 | REQ-010 | R1 | D1 | 把 `ignored-sessions.json` 写坏且移走 `.bak`，观察 `/status.safety` 是否报错、本轮是否零回收 | E09 |
| T08 | REQ-011 / REQ-012 | R1 | D1 | 传一个大文件触发分块，中途换掉某块，确认报「第 N 块损坏」；检查运行时垃圾未被同步 | E10 |
| T09 | REQ-013 / REQ-014 | R1 | D1 | 只读预演 `nas_session_rel_migrate`；确认默认 legacy、NSS1 历史密文仍可解 | E11 |
| T10 | REQ-015 / REQ-016 | R1 | D1 | 连续两轮扫描看缓存命中；发布一个 `.tgz` 到 CAS 并在无 CLI 端解包 | E12 |
| T11 | REQ-017 | R4 | D1 / D2 | 开屏幕阅读器 / TalkBack，完整走一遍「配置 → 回收站 → 两步确认恢复」，键盘 Tab 全程可达 | E13（待采集） |
| T12 | REQ-018 | R1 | D1 | `GET /config` / `GET /status`，确认无口令明文 | E14 |
| T13 | REQ-019 | R1 | D3 | 在远端清单伪造 `../` / 绝对 rel，确认不落盘到家目录之外 | E15 |
| T14 | REQ-020 / REQ-023 | R1 | D1 / D4 | `node scripts/smoke.mjs`、核对 `ci#2`、逐项过 `docs/release-checklist.md` | E16 |
| T15 | REQ-023 | R1 | D1 | 演练一次回滚：还原旧 `dist/index.js` 并重启，再恢复 0.6.0 | E17（待采集） |
| T16 | REQ-024 | R1 | D1 | `node scripts/coverage-modules.mjs`，核对零覆盖模块清单 | E18 |

## 5. 判定标准

### 5.1 单条任务的判定

| 结论 | 条件 |
|---|---|
| PASS | 该任务全部可判定断言成立，且证据落在指定位置，采集时间 / 设备 / 操作人可追溯 |
| FAIL | 任一可判定断言不成立，或破坏性动作发生但无 `removed/` 记录 |
| BLOCKED | 前置条件 P1–P7 未满足（如 PC 宿主未重启），须先解除阻塞再判 |
| 待采集 | 需要真人 / 物理设备 / 外部材料，自动化脚本不得代填，也不得判 PASS |

### 5.2 本轮 UAT 的整体出口条件（G11 / G13）

1. T01–T16 全部有记录；`待采集` 项须逐条写明缺什么、谁补、何时补，**不得静默省略**。
2. `pendingCount === 0` 且 `conflictCount === 0`（P3）。
3. 发版冒烟 `reports/smoke.json` 的 `overall !== "FAIL"`，三端 md5 检查若为 `SKIP` 须由发布人补实值。
4. 恢复演练 `reports/recovery-drill.json` 的 `result === "PASS"`，且含恢复时长 / 目标恢复点 / 帧数。
5. 回滚步骤在 checklist 里被逐项确认过；tag 命名符合规则。
6. 任何 FAIL 都必须有对应的 `docs/requirements.md` 需求 ID 与缺陷记录，不允许「整体通过、个别忽略」。

## 6. 记录模板

```
任务 ID: T__
需求 ID: REQ-___
角色 / 设备: R_ / D_
执行时间(本地时区): YYYY-MM-DD HH:mm ±HH:MM
前置条件核对: P1..P7 → PASS / FAIL / BLOCKED
操作纪要: （逐步写实际点了的按钮、输入的命令）
断言逐条:
  A1 ... → PASS/FAIL
  A2 ... → PASS/FAIL
证据: 文件路径 / 截图编号 / 命令原始输出
异常与观察: （与预期不符的任何细节，含日志）
结论: PASS / FAIL / BLOCKED / 待采集
执行人签字: ________  复核人签字: ________
```

探索性测试另用 `docs/exploratory-charter.md` 的时间盒记录模板，不混进本表。

## 7. 本轮诚实边界（不冒充已完成）

- **真实用户（R2 / R3 / R4 / R5）未到场**：2026-11-09 完成的是维护者（R1）主导的
  部署、真机端点级 E2E 与自动化演练；T01、T05、T06、T11 等「真人操作」项仍为 `待采集`。
- **双端真实跨设备大文件同步未跑**：NSS2 密文 / canonical rel / 插件 CAS 全链路只有离线
  引擎级与真机端点级验证（修复说明第 12.4 节）。T10 的生产模式部分为 `待采集`。
- **PC 宿主进程未重启**（P2）：磁盘上的 0.6.0 产物尚未被加载，T01 在 PC 侧可能读到旧行为。
- **无障碍实扫未做**：`a11y.test.mjs` 是静态契约；axe-core / WCAG 2.1 AA / TalkBack /
  键盘 Tab / 200% 字体缩放均未完成，T11 为 `待采集`。
- **APK 未重新打包**：r171 APK 内仍是旧产物，重装或改 `BUNDLE_REV` 会回到旧版（修复说明第 13.1 节）。
- **G14 外部材料未齐**：真实用户环境分布、宿主 / WebView 版本矩阵、WCAG 目标等级待业务方提供。
