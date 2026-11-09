# language: zh-CN
# 屏蔽同步与 fail-closed（G1 / G2）
Feature: 屏蔽意图全局事件化，断网不丢，清单损坏不许回收

  @REQ-009 @G1
  # @impl src/sync/engine.ts:736 ignoreSession; src/sync/engine.ts:1461 消费 ignore/unignore; src/config.ts:375 Store.pendingIntents
  Scenario: 断网时点屏蔽，操作不能丢且能同步到对端
    Given 用户点击「屏蔽这条会话」，sid 为 "sid-uat-1"
    And 此刻 NAS 完全不可达，所有 putBuffer / putIfMatch 写都抛错
    When 检查 Store 与屏蔽清单
    Then pendingIntents 里有一条 op 为 ignore、sid 为 "sid-uat-1" 的意图
    And 重新 new Store() 后该意图仍在（进程重启不丢）
    And listIgnoredSessions().ids 包含 "sid-uat-1"
    Given 对端发布一条 ignore 事件且位点已推进
    When 本机消费一轮事件
    Then 本机屏蔽清单出现该 sid
    And 同一条事件不会因位点推进被重复回放

  @REQ-010 @G2
  # @impl src/sync/engine.ts:762 加载与 fail-closed; src/sync/state-file.ts:98 readJsonFile; src/sync/engine.ts:330 safetyStatus
  Scenario: 屏蔽清单写坏且无备份时本轮不做任何回收
    Given ignored-sessions.json 被写成坏 JSON，且没有可用的 .bak
    And 本轮存在一条本可被回收的会话
    When 跑一轮 scan()
    Then 本轮跳过全部回收动作，removed/ 零新增
    And 损坏文件被留证为 .corrupt-* 副本
    And /status 的 safety.ignoredFileError 非空
    And 破坏性删除传播被禁用
