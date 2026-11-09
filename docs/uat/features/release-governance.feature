# language: zh-CN
# 发版治理、需求追溯与覆盖率（G10 / G11 / G13 / G5）
Feature: 发版有冒烟门禁、可追溯的需求 ID、按模块覆盖率与回滚记录

  @REQ-020 @G10 @G13
  # @impl scripts/smoke.mjs; src/bridge.ts:37 BRIDGE_PREFIX; src/bridge.ts:201-439 分派分支; src/index.ts:233-1061 工具注册
  Scenario: 发版冒烟检查 dist 语法、三端 md5、端点清单与工具数
    Given 发版前已构建出 dist/index.js
    When 执行 "node scripts/smoke.mjs"
    Then 用 node --check 校验 dist/index.js 语法合法
    And 关键端点清单（/status /events /rel-migration /plugins /ignored /removed 等）齐全
    And src/index.ts 里 name 为 nas_* 的工具注册数恒为 21
    And reports/smoke.json 的 overall 不为 "FAIL"
    And 三端部署 md5 未提供时该项记为 SKIP 并明确列出，不冒充 PASS

  @REQ-021 @G11
  # @impl docs/requirements.md; docs/uat/features/*.feature; test/uat.test.mjs
  Scenario: 每个场景反查唯一需求 ID，每条需求至少一个场景
    Given docs/requirements.md 里有 24 条 REQ-xxx 需求
    When 遍历 docs/uat/features/*.feature 的全部场景
    Then 每个场景有且仅有一个 @REQ-xxx 标签
    And 每个 @REQ-xxx 都能在需求表里查到唯一一行
    And 每个场景带 @impl 文件:行号 标注
    And 每条需求至少对应一个场景，覆盖矩阵无空格

  @REQ-023 @G13
  # @impl docs/release-checklist.md; CHANGELOG.md; .github/workflows/ci.yml; docs/uat/uat-evidence.md
  Scenario: 发版 checklist 逐项打勾且含回滚与 tag 规则
    Given 0.6.0 的 ci#2 在 ubuntu-latest / Node 22 上 10 步全绿
    And 真机 E2E 实测 pendingCount 为 0、conflictCount 为 0
    When 逐项核对 docs/release-checklist.md
    Then 双方部署 hash 一致性有证据路径
    And pending / conflicts 归零有 reports/device-e2e.json 佐证
    And 回滚步骤写明可还原的旧 dist/index.js 来源
    And tag 命名规则为 v<major>.<minor>.<patch>
    And CHANGELOG 注明日期 2026-11-09 与 commit 06403ec / 756f7d9

  @REQ-024 @G5
  # @impl scripts/coverage-modules.mjs; reports/coverage.txt; reports/coverage-modules.json
  Scenario: 覆盖率按模块单列并标出零覆盖模块，门槛不擅自改动
    Given npm run coverage 已产出 reports/coverage.txt（all files 行 73.56%）
    When 执行 "node scripts/coverage-modules.mjs"
    Then reports/coverage-modules.json 列出 src/sync/ 下全部 .ts 模块的行 / 分支覆盖率
    And 未被报告收录或行覆盖率为 0 的模块单独进 zeroCoverageModules
    And gate.minLines 仍为 40，与 scripts/coverage.mjs 一致
    And 不修改 scripts/coverage.mjs，也不把门槛改成 G5 要求的 80%
