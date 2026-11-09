# language: zh-CN
# 回收恢复与演练（G3 / G12）
Feature: 删除是移进回收站，且能按 meta 逐字节恢复

  Background:
    Given 一个隔离的临时 $DSH_HOME 与独立的 removed/ 根
    And 会话文件形如 "sessions/<cwd编码>/<sid>/session.v4.jsonl.zstd"

  @REQ-006 @G3
  # @impl src/sync/engine.ts:2484 retireLocalSession; src/sync/engine.ts:2514 meta 写入; src/sync/engine.ts:1400 retireGeneric
  Scenario: 回收是移进 removed/ 并写 meta，不是硬删
    Given 本地有一条会话 rel "sessions/--C-Users-wstest--/session-aa35e064/session.v4.jsonl.zstd"
    When 以原因 "event-delete:android" 回收这条会话
    Then 原路径不存在，但文件没有消失
    And removed/<时间戳>/ 下出现以 rel 双下划线编码命名的目录
    And 旁边有同名的 ".meta.json"，字段含 rel / remoteRel / sessionId / retiredAt / reason / trashDir
    And meta.rel 等于原始 rel，meta.reason 等于传入原因

  @REQ-007 @G3
  # @impl src/sync/engine.ts:2534 listRemovedSessions; src/sync/engine.ts:2585 restoreRemovedSession; src/sync/engine.ts:2599 目标已存在判据
  Scenario: 枚举后按 meta 恢复，目标已存在时拒绝覆盖
    Given removed/ 里有一条带 meta 的记录，id 为 "sessions__--C-Users-wstest--__session-aa35e064__session.v4.jsonl.zstd"
    And 原始 rel 对应的会话目录当前不存在
    When 用该 rel 调用恢复
    Then 文件回到原始 rel 对应的目录
    And 侧栏重新登记该会话，本机屏蔽被撤销
    And 对应的 ".meta.json" 被清理
    Given removed/ 里有同一条记录，但原始 rel 对应的目录已被重新创建
    When 再次调用恢复
    Then 抛出「目标目录已存在，拒绝覆盖」错误
    And removed/ 里的回收副本与 meta 都保持原样

  @REQ-008 @G3
  # @impl src/sync/portable.ts:571 sessionFrameOffsets; scripts/recovery-drill.mjs buildSessionZstd / zstdFrameEnd
  Scenario: 恢复后文件逐字节一致且 zstd 帧尾与帧数一致
    Given 原会话文件含 3 个 zstd 帧，记录其 sha256 与 zstdFrameEnd() 十六进制
    When 执行 "node scripts/recovery-drill.mjs" 走完「本地 → removed/ → 按 meta 恢复」
    Then reports/recovery-drill.json 的 result 为 "PASS"
    And 恢复后文件 sha256 与原文件相同
    And 恢复后 frameCount 与原文件相同且无截断
    And 恢复后 zstdFrameEnd 与原文件逐字节相同
    And 任一帧被篡改时校验为 FAIL

  @REQ-022 @G12
  # @impl scripts/recovery-drill.mjs runDrill; reports/recovery-drill.json
  Scenario: 演练记录含恢复时长与目标恢复点
    Given 一次完整恢复演练已跑完
    When 读 reports/recovery-drill.json
    Then 含 recoveryTimeMs（恢复时长，>= 0）
    And 含 recoveryPoint，至少带 rel / retiredAt / reason / sessionId（目标恢复点）
    And 含 frameCount（帧数）
    And 含 result 为 "PASS" 或 "FAIL"
    And 报告可重复生成，多次运行不依赖上一次的临时目录
