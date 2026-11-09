# 发版清单

> 每次发版逐项打勾并填证据路径。空着的项就是没验证，不许口头通过。
> 本文件同时是 0.6.0 的实录。

## 0.6.0（2026-11-09）

### 一、代码与构建

- [x] `npm run build` 通过，`dist/index.js` 已入库（git 依赖必须带产物）
- [x] `npm test` 全绿：**297 / 297**
- [x] `npm run verify:contracts` 通过：5 份 schema、33 条用例
- [x] `npm run coverage` 行覆盖率 **73.56%**（门槛 40%），报告 `reports/coverage.txt`
- [x] `npm run mutation` 10 / 10 全杀死，报告 `reports/mutation.json`
- [x] `npm run audit:security` high 0 / medium 0，报告 `reports/security-audit.json`
- [x] `git status` 干净，`ahead/behind = 0/0`

### 二、双方部署一致性

| 位置 | 文件 | md5 |
|---|---|---|
| 源码 | `client.js` | `b6d4a65e509a7606028021d0f3209e9f` |
| 源码 | `dist/index.js` | `5efb713991abbfe674d1978335d5aa73` |
| 源码 | `package.json` | `73ad7a88b626aad7fca7e1cfd367060b` |
| PC 宿主 | 同上三件 | 三端一致 |
| 手机（`files/home/wstest/dsh-nas-sync`） | 同上三件 | 三端一致 |
| APK assets（`assets/dsh-nas-sync/`） | 同上三件 | 与源码一致 |

- [x] APK 内 `assets/dsh-nas-sync/` 三件套 md5 与源码一致（`unzip -p … | md5sum`）
- [x] APK `versionCode=1129` / `versionName=30.112.0`（`aapt dump badging`）
- [x] 内置插件戳推到 `r231-nas060`，装机冷启动后落地戳为该值
- [x] 手机安装成功（`adb install -r` → `Success`）
- [x] PC 宿主重启后 `store.json` 出现 `deviceCursors` / `pendingIntents`
- [x] PC 宿主 `/nas-sync-api/status` 无 token 返 **401**（桥已注册）

### 三、运行时验收

- [x] 真机 E2E：`reports/device-e2e.json` `ok:true, failures:[]`，六端点全 200
- [x] 双端演练：`reports/two-device-drill.json` **15 / 15**（8 MiB 分块 17 块、
      NSS2、双读、canonical 迁移、CAS 解包）
- [x] 契约报告：`reports/contract-report.json` 33 / 33
- [x] 无障碍运行时扫描：`reports/a11y-runtime.json`
- [ ] 系统字体 200% 溢出检查：脚本已就绪（`scripts/a11y-runtime.mjs` 可判定），
      真机尚未执行
- [ ] TalkBack 全程可达：需要人工操作，尚无记录

### 四、数据安全

- [x] 远端 pending / conflicts 归零（`/status` 快照 `pendingCount=0`、`conflictCount=0`）
- [x] 迁移默认值未被改动：`sessionRelMode=legacy`、`envelopeVersion=1`
- [x] 生产 NAS 只做只读预演，未执行 `confirm:true`（旧对象一个字节没动）
- [x] 备份：`/d/work/pc-*-before-060.*`、手机 `*.bak060`、`/d/work/apk-r231-backup/`

### 五、CI

- [x] `ci#2` 在 ubuntu-latest / Node 22 上 10 步全绿
- [x] Node 20 / 22 矩阵（本次新增）
- [ ] 连续 3 次 push 全绿：目前只有 1 次，第 2、3 次随 tag 推送产生

### 六、回滚

1. **插件回滚**：把三件套换回 `/d/work/pc-*-before-060.*` 与手机 `*.bak060`，
   重启宿主；APK 回滚需重装上一版（`versionCode` 必须 ≥ 当前值，否则系统拒绝降级）。
2. **rel 迁移回滚**：`sessionRelMode` 改回 `legacy` 即可继续用旧 rel；canonical 对象
   与 bidmap 留着不影响；旧对象在 `retentionDays` 内受 GC 保护。
3. **信封回滚**：`envelopeVersion` 改回 `1` 只影响**新写入**；已写的 NSS2 文件仍能
   双读解开，不需要迁移。
4. **扫描缓存回滚**：删掉 `$DSH_HOME/nas-sync/scan-cache.json`，下一轮自动全量重算。

### 七、tag 命名

`v<major>.<minor>.<patch>`，与 `package.json` 的 `version` 一致；本次为 `v0.6.0`。
