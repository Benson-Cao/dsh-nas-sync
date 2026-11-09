# language: zh-CN
# 0.6.0 迁移窗口五项（G5 / G6 / G12）
# 这五项默认都不改写线上已有字节；「已实现」不等于「双端真实跑过」。
Feature: 迁移窗口能力具备但默认 legacy，升级不需要双端停机

  @REQ-013 @G6 @G11
  # @impl src/sync/rel-migration.ts:285 mergeDualRead; src/sync/rel-migration.ts:253 rewriteManifestForMode; src/sync/engine.ts:1842 sessionRelPlan; src/sync/engine.ts:1865 migrateSessionRels
  Scenario: canonical rel 读侧双归并，默认 legacy，apply 必须显式 confirm
    Given 两端同一 sid 的 cwd 编码不同，一个在 legacy 空间、一个在 canonical 空间
    When 读侧归并清单
    Then mergeDualRead() 按 sid 归并且不重复计数，canonical 优先
    Given 配置 sessionRelMode 为 canonical 但 NAS 上没有 /dsh/migration.json
    When 调 GET /rel-migration
    Then effectiveMode 自动降级为 "legacy"，valid 为 true
    Given 用户调 POST /rel-migration 且不带 confirm
    When 处理该请求
    Then 只返回只读预演计划，不复制对象、不写 bidmap、不写 marker
    And 同名不同 hash 的映射整批列为冲突，绝不自动挑一份

  @REQ-014 @G6
  # @impl src/sync/crypto.ts:198 Crypto.decrypt 双读; src/sync/crypto.ts:251 sealStream; src/sync/crypto.ts:303 openStream; src/sync/crypto.ts:120 envelopeInfo
  Scenario: NSS2 双读单写，历史 NSS1 密文不失效
    Given envelopeVersion 缺省或为 1
    When 引擎加密一段明文
    Then 写出的是 NSS1，与 0.5.9 逐字节兼容
    Given envelopeVersion 设为 2
    When 引擎加密同一段明文
    Then 写出带头版本与 AAD 的 NSS2，且同明文不同 AAD 的密文不同
    When decrypt() 分别解 NSS1 与 NSS2 密文
    Then 同一个口令下两种密文都能解开（永远双读）
    And sealStream/openStream 拒绝重排 / 截断 / 多余帧 / 篡改任意一帧

  @REQ-015 @G12
  # @impl src/sync/scan-cache.ts:63 configFingerprint; src/sync/scan-cache.ts:90 shouldReuse; src/sync/scan-cache.ts:118 ScanCacheSession; src/sync/scan-cache.ts:206 loadScanCache
  Scenario: 扫描缓存命中跳过 sha256，指纹变化整表失效，坏缓存降级
    Given 扫描缓存默认开启、TTL 24h，落在 $DSH_HOME/nas-sync/scan-cache.json
    And 某文件的 (mtimeMs, ctimeMs, size) 三元组未变
    When 第二轮扫描
    Then shouldReuse() 为 true，跳过 readFile 与 sha256
    Given 任一影响扫描结果的配置字段变化
    When 校验配置指纹
    Then configFingerprint() 改变，整表作废并标记 invalidated
    Given 缓存文件是坏 JSON
    When 引擎加载缓存
    Then 显式告警并降级为全量重算，仍能完成扫描

  @REQ-016 @G10
  # @impl src/sync/plugin-objects.ts:46 buildAssemblies; src/sync/plugin-objects.ts:110 pluginObjectPath; src/sync/tgz.ts:131 safeTarPath; src/sync/tgz.ts:143 unpackTgz; src/sync/installer.ts:144 installFromCas
  Scenario: 插件 CAS 按平台寻址，无 CLI 端零依赖解包且拒绝越界
    Given 一台设备发布了 .tgz 包体，对象按 sha256 两级散列落在 /dsh/objects/
    When 装配清单聚合
    Then 按 "包名@版本" + "平台/架构/Node ABI" 各占一个 target
    Given 手机端没有宿主 CLI
    When 走 installFromCas() 安装
    Then 先校验对象 sha256，不符 / 缺失 / 包名越界一律跳过且绝不写盘
    And 解 USTAR / PAX / GNU longname 用临时目录 + 原子重命名 + 失败回滚
    And 路径穿越 / 盘符 / 反斜杠 / NUL / 符号链接 / 硬链接 / 解压炸弹都被拒绝
