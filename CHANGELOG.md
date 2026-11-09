# 变更记录

## 0.6.0 — 2026-11-09

对应提交：`06403ec`（主体）、`756f7d9`（CI 修复）。真机包：`30.112.0 / r231`。

### Added

- **事件驱动删除传播**：`/dsh/events/<设备>/<分片>.jsonl` 只追加事件日志，
  `(device, seq)` + 稳定主键 + 自校验签名；读端合并分片 → 回放 → 墓碑 →
  对端按墓碑把本地文件移进回收站（可恢复），30 天后才真删远端对象。
  覆盖全部 10 个同步分类，不再只覆盖会话镜像。
- **删除三道防线**（`safety.ts`，fail-closed）：事件流任一分片读失败 / 签名坏 /
  `seq` 缺口 → 整轮禁止按事件删除；本机「上轮有本轮无」要过六道闸；删除只移进回收站。
- **canonical rel 双读**：`sessions/by-id/<sid>/vN/<file>` 与旧 cwd 编码 rel 并存，
  `sessionRelMode = legacy | shadow | canonical`，默认 `legacy`；读侧永远双空间归并，
  `canonical` 缺 `/dsh/migration.json` 时自动降级。
- **NSS2 信封**：`"NSS2" | ver | salt | nonce | aadLen | aad | secretbox`，AAD 绑定稳定主键；
  `sealStream()` / `openStream()` 的 `NSS2C` 帧绑定 `(aad, index, final)`，防重排 / 复制 / 截断。
  解密永远双读，历史密文不会失效。
- **增量扫描缓存**：`$DSH_HOME/nas-sync/scan-cache.json`，按 `mtimeMs/ctimeMs/size`
  三元组命中即跳过 `readFile` 与 sha256；配置指纹变化整表失效，坏缓存降级全量扫描。
- **插件包体 CAS**：包体按 sha256 存 `/dsh/objects/<前2位>/<sha>`，装配清单按
  `包名@版本 + 平台/架构/Node ABI` 记账；无宿主 CLI 的手机端零依赖解 USTAR / PAX /
  GNU longname `.tgz` 写 `node_modules`（临时目录 + 原子重命名 + 失败回滚）。
- **新增工具**：`nas_list_events`、`nas_confirm_delete`、`nas_session_rel_migrate`、
  `nas_publish_plugin_object`（总计 21 个）。
- **新增端点**：`GET /events`、`GET /events/status`、`POST /events/delete`、
  `GET|POST /rel-migration`、`POST /plugins/publish`。
- **质量资产**：`contracts/`（5 份 JSON Schema + 5 组 golden + 4 版版本矩阵）、
  `scripts/contract-verify.mjs`、`scripts/two-device-drill.mjs`、
  `scripts/a11y-runtime.mjs`、`scripts/device-e2e.{sh,mjs}`、CI Node 20/22 矩阵。

### Changed

- `scan()` 并发保护：并发调用复用同一轮结果，异常后解锁（不再可能出现两轮扫描
  互相覆盖 `pendingFiles`）。
- 工作区同名撞车：`loadWorkspaceDirs()` 不再静默改写映射，保留先到者并把冲突
  记进 `workspaceCollisions` + 日志。
- `npm test` 改为 `node --test` 自动发现，新增测试文件不再需要手工维护列表。
- 分块层逐块 sha256 校验；内容变化时强制覆盖并清理多余 `.partNNNN`。
- 排除规则统一到 `src/sync/exclusions.ts`；64 MiB 硬跳过改为可配置 `maxFileBytes`。

### Fixed

- **插件整体不激活**（真机 E2E 发现）：`nas_session_rel_migrate` 的 `confirm` 与
  `nas_publish_plugin_object` 的 `version` 写成 `required: false`，宿主 `defineTool()`
  的 schema 编译器抛 `JsonSchemaError: parameters.confirm.required must be true when
  present`，导致整个 bundle 未注册（页面无 token、所有 `/nas-sync-api/*` 404）。
  改为省略 `required`，并在 `test/api-contract.test.mjs` 加静态契约锁死。
- 墓碑 key/rel 不一致导致的误删。
- 断点续传在「块大小相同但内容变化」时跳过覆盖。
- CI `setup-node` 开 `cache:'npm'` 但仓库无 lock 文件导致 5 秒内失败。

### Security

- 凭据从 `store.json` 拆到 0600 的 `credentials.json`（仍为明文，系统 keyring 待宿主接口）。
- `keyCache` 不再用明文口令做 Map key，改为口令 sha256 + salt。
- HTTP 桥新端点使用标准状态码（400 / 401 / 409），错误不再一律 200。
- 远端 rel 进文件系统前做安全过滤（`isSafeRel`），拒绝 `..` / 分隔符 / 非法清单名。
- `security-audit.mjs`：5 条静态规则 + `npm audit --omit=dev`，high/medium 0。
