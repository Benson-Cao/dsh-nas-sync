# language: zh-CN
# 面板无障碍与配置脱敏（G9 / G7）
Feature: 破坏性操作对读屏可见，配置视图不泄露口令

  @REQ-017 @G9
  # @impl client.js:1046 aria-live; client.js:1198 aria-label 组; client.js:1483 恢复按钮 aria-label; client.js:1485 aria-pressed; client.js:870 两步确认
  Scenario: 恢复两步确认的状态对读屏可见，且中英文案齐全
    Given 用户在「回收站与本机屏蔽」卡片看到一条可恢复记录
    And 所有配置类输入框都有 aria-label，分类 / 技能复选框由 label 包裹
    When 用户第一次点「恢复」
    Then 按钮进入待确认态，aria-pressed 为 true，aria-label 变成「再点一次确认」
    When 异步结果返回
    Then 成功进 aria-live="polite" 的 status，失败进 aria-live="assertive" 的 alert
    And 中文与英文案都覆盖回收站 / 屏蔽入口
    And 不引入正 tabIndex、把 onClick 挂在 div 上这类反模式
    And legacy / 无元数据记录不提供恢复按钮

  @REQ-018 @G7
  # @impl src/bridge.ts:87 publicConfig; src/bridge.ts:366 GET /config; src/config.ts:375 Store 拆分凭据
  Scenario: 配置视图只回脱敏布尔量，不回显口令
    Given 配置里设置了 WebDAV 密码与同步口令短语
    And 口令类字段被拆到独立 0600 的 credentials.json，salt 独立存 salt.hex
    When 调 GET /config 与 GET /status
    Then 响应里 passwordSet 为 true、passphraseSet 为 true
    And 响应全文不含 password / passphrase 明文字段
    And configKeys 含 sessionRelMode / envelopeVersion / scanCacheEnabled / scanCacheTtlHours
    And 任何 required:false 的工具参数都不会让宿主 defineTool() 注册失败
