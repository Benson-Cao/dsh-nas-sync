# 兼容性矩阵（COMPAT）

> 依据：0.6.0 的实际运行记录 + `engines` 声明。每一格都写「结论 + 证据」，没有证据的
> 一律标「未实测」，不拿推测当支持。

## 1. 运行时

| 运行时 | 结论 | 依据 |
|---|---|---|
| Node **22.x** | ✅ 支持（基线） | 本仓库所有脚本、`npm run verify`、GitHub Actions matrix 均以 22 为基线 |
| Node **24.x** | ✅ 支持（CI 实测） | CI matrix `node: ['22','24']`；手机端 Termux 就是 24.18.0 |
| Node **20.x** | ❌ 不支持 | 与 `engines.node >=22.15.0` 冲突；ci#5 实测 20 上单测失败、22 绿，test runner 行为有差异 |
| Node **18.x** | ❌ 不支持 | 缺 `node --test` 的自动发现与 `--experimental-test-coverage`；`WebSocket` 全局也未稳定 |
| Android Termux Node **24.18.0** | ✅ 实测通过 | 真机 `com.dsh.harness` 内置 runtime，`reports/device-e2e.json` `ok:true` |

`engines.node` 定为 `>=22.15.0` 的原因：15 是 `node --test` 稳定支持目录/glob 发现的分界，
低于它 CI 与本地会跑出不同的用例集合（本地绿、CI 红），比直接拒绝更糟。

## 2. 宿主与平台

| 宿主 / 平台 | 结论 | 依据 |
|---|---|---|
| DSH Desktop（Windows，`0.2.1-rc.5`） | ✅ 支持 | PC 宿主实测：`store.json` 出现 `deviceCursors` / `pendingIntents`，`/nas-sync-api/*` 无 token 返 401 |
| DSH Phone（Android，WebView） | ✅ 支持 | 真机 E2E 六端点全 200；`report/device-e2e.json` |
| Linux（Ubuntu latest，CI） | ✅ 支持 | GitHub Actions `ci#2` 10 步全绿 |
| macOS | ⚠️ 未实测 | 代码里只有 `win32` / `android` 分支被实跑；`darwin` 走通用 POSIX 路径 |

## 3. 传输后端

| 后端 | 结论 | 依据 |
|---|---|---|
| WebDAV（`webdav@5.x`） | ✅ 支持 | PC / 手机都在用；`If-Match` CAS 与 `MOVE` 原子重命名已实现 |
| 本地挂载（SMB / NFS 挂到盘符或目录） | ✅ 支持 | `mount.ts`；临时文件 + 原子 rename，单测覆盖 |
| 不支持 WebDAV PATCH 的 NAS | ✅ 支持 | 分块方案是「清单 + 独立分块文件」，不依赖 PATCH |

## 4. 路径形态（`encodeCwd` 相关）

| 形态 | 结论 | 依据 |
|---|---|---|
| `C:\Users\x\Desktop\项目`（盘符 + 中文） | ✅ 实测 | 真机会话目录名 `--C-Users-Administrator-Desktop-~80CE~6559Agent--` |
| 含空格路径 | ✅ 实测 | `D:\Dw phone\...` 全流程在用 |
| `~` 展开 / 相对路径 | ✅ 归一化 | `resolve()` 后处理，`test/encode-cwd.test.mjs` |
| UNC（`\\server\share`） | ⚠️ 未实测 | 代码未特殊处理，可能产生非法目录名 |
| emoji / `*?"<>|` | ✅ 拒绝或转义 | `safeName()` 白名单，测试覆盖 |
| 超长路径（>240 字符） | ⚠️ 未实测 | Windows MAX_PATH 限制，长路径需系统开关 |

## 5. 显示与语言

| 项 | 结论 | 依据 |
|---|---|---|
| 1080×2400（手机） | ✅ 实测 | 真机截图 + CDP 几何测量 |
| 桌面 1.5× 缩放 | ✅ 实测 | PC 宿主 `--device-scale-factor=1.5` |
| 系统字体 200% | ⚠️ 未实测 | 脚本 `scripts/a11y-runtime.mjs` 可判定溢出，真机尚未执行 |
| `zh-CN` | ✅ 实测 | 面板中英文案齐全，`test/a11y.test.mjs` 锁死两套文案 |
| 其他语言 | ⚠️ 未实测 | 目前只有 zh-CN / en 两套字符串 |

## 6. 已知不兼容

- **Node 18 及以下**：不支持（见 §1）。
- **同名工作区**：两个不同路径的目录基名相同会抢同一个 rel 前缀。后到者被跳过
  （不会互相覆盖），冲突会写进日志与 `workspaceCollisions`，但**不会自动改名**。
- **同名主机**：设备标识是 `平台:主机名`，两台同名主机会共用同一份设备清单，
  后写覆盖前写。真实多机部署请保证主机名不同。
