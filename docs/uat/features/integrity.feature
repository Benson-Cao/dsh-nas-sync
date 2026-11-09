# language: zh-CN
# 分块校验、排除规则与路径安全（G10 / G4）
Feature: 传输内容可校验，排除规则有单一真源，远端 rel 不越界

  @REQ-011 @G10
  # @impl src/sync/chunker.ts:84 upload; src/sync/chunker.ts:182 download; src/sync/chunker.ts:212 cleanup
  Scenario: 逐块 sha256 校验、强制覆盖与残块清理
    Given 一个大文件被切成多块，upload 写出的清单含 chunkHashes[]
    When 下载端逐块校验后还原密文
    Then 还原出的密文 sha256 与上传前一致
    Given 某一块被替换但字节数不变
    When 再次下载
    Then 明确报「第 N 块损坏」，而不是笼统说解密失败
    Given 内容变小导致块数减少
    When 重新上传
    Then 上一版多出来的残块被清理清单
    And 旧版清单没有 chunkHashes 时仍能下载，不把历史分块判成损坏

  @REQ-012 @G10
  # @impl src/sync/exclusions.ts:17 SKIP_DIR_NAMES; src/sync/exclusions.ts:46 isIgnoredRelPath; src/sync/scanner.ts:92 isIgnoredRel
  Scenario: scanner 与共享排除规则完全一致，正常用户内容不被误排除
    Given 扫描遇到 .plugin-manager / .bak / .cache 等运行时垃圾目录
    When scanner 用 isIgnoredRel() 判定
    Then 判定结果与 src/sync/exclusions.ts 的共享规则完全一致
    And 这些运行时垃圾不进本地清单，也不进远端清单
    And 名称为 "notes.txt" / "my.session.jsonl" 的正常用户内容不被误排除

  @REQ-019 @G4
  # @impl src/sync/safety.ts:18 isSafeRel; src/paths.ts:18 localOf; src/sync/manifest.ts:83 mergeDeviceManifests
  Scenario Outline: 远端 rel 的路径穿越被三层过滤
    Given 远端清单里出现一条 <可疑 rel>
    When 清单合并过滤、downloadEntry() 入口、resolveLocal() 依次校验
    Then isSafeRel() 返回 false
    And 该条目不落盘到 $DSH_HOME 之外
    And 目录列举里伪造的 ../ 清单名不参与远端读取

    Examples:
      | 可疑 rel |
      | ../outside.txt |
      | /etc/passwd |
      | C:/Windows/win.ini |
      | sessions/x/%2e%2e/escape |
      | sessions/x/../../etc/passwd |
      | sessions/x/seg. |
