# language: zh-CN
# 删除传播与误删防线（G1 / G2 / G10）
# 每个场景用 @REQ-xxx 反查 docs/requirements.md；@impl 给出实现文件:行号。
Feature: 删除事件在两端传播，且任何不可信信号都不许误删

  Background:
    Given 两台设备连到同一 NAS，事件流初始为空且可信
    And 两端都运行 0.6.0 bundle，/events 与 /status 可用

  @REQ-001 @G1 @G4
  # @impl src/sync/engine.ts:1422 applyRemoteDeletes; src/sync/engine.ts:1997 scan; src/sync/events.ts:455 applyEventsToManifest
  Scenario: 一端删除，另一端把文件移进回收站而不是继续上传
    Given 手机上有 "attachments/a.txt"，清单里也有这条 rel
    And 电脑已发布一条 key 为 "rel:attachments/a.txt" 的 delete 事件
    When 手机端跑一轮 scan()
    Then "attachments/a.txt" 在原路径不存在
    And local 清单里不再含这条 rel
    And listRemovedSessions() 新增一条 restorable 为 true 的记录
    And 该记录的 reason 含 "event-delete"
    And safetyStatus().eventStream.trusted 为 true

  @REQ-002 @G2
  # @impl src/sync/safety.ts:60 evaluateManifestTrust; src/sync/engine.ts:665 全部读成才允许回收
  Scenario: N 份设备清单坏 1 份时，连续 4 轮也不许搬走本机会话
    Given 本轮读到 3 份设备清单，其中 "android_localhost.json" 读失败
    And 本机会话在可信基线里存在
    When 连续跑 4 轮 scan()
    Then removed/ 目录下零新增
    And 清单可信判据为 false
    And 本机会话文件仍在原处

  @REQ-003 @G2
  # @impl src/sync/safety.ts:89 advanceMissingRounds; src/sync/safety.ts:70 RETIRE_AFTER_MISSING_ROUNDS=2
  Scenario: 严格连续两轮缺失才回收，中间夹一轮不可信必须归零
    Given 全部清单读成，某个远端 rel 在第 1 轮缺失
    When 第 2 轮清单读成且该 rel 仍缺失
    Then 连续计数达到 2，该 rel 才被允许移进 removed/
    Given 第 1 轮缺失、第 2 轮清单读失败、第 3 轮又缺失
    When 检查连续计数
    Then 计数被不可信轮归零，为 1，不允许回收
    And 必须再连续一轮可信缺失才达到阈值

  @REQ-004 @G2 @G10
  # @impl src/sync/events.ts:286 validateEventStream; src/sync/safety.ts:119 eventStreamAllowsDeletes; src/sync/engine.ts:1424 闸口
  Scenario Outline: 事件流不完整时整轮 fail-closed，一个文件都不许动
    Given 事件日志里被注入 <损坏类型>
    When 跑一轮 scan()
    Then 本地文件原地不动
    And safetyStatus().eventStream.trusted 为 false
    And listRemovedSessions().length 为 0

    Examples:
      | 损坏类型 |
      | 一行坏 JSON |
      | 一行坏签名 |
      | 一个 seq 缺口 |
      | 分片读到半截 |

  @REQ-005 @G10
  # @impl src/sync/safety.ts:173 computeLocalDeletes
  Scenario: 取消勾选「附件」不该把对端的附件全删掉
    Given 上轮清单里有 10 个附件条目
    And 本轮只启用 sessions 分类，一个附件都没扫到
    When 计算本地删除候选
    Then 删除候选 rels 为空数组
    And excludedCount 为 10，全部归为「配置排除」
    And blocked 为 false，不触发批量消失保护
