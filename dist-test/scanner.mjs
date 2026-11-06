// src/sync/scanner.ts
import { readdir as readdir2, stat as stat2, readFile as readFile2 } from "node:fs/promises";
import { statSync } from "node:fs";
import { join as join3, resolve as resolve2 } from "node:path";
import { createHash } from "node:crypto";

// scripts/_test-home-paths-stub.mjs
function resolveDshHome() {
  return process.env.DSH_HOME_TEST || process.env.DSH_HOME || "/tmp/dsh-test-home";
}

// src/paths.ts
import { join, relative } from "node:path";
function dshHome() {
  return resolveDshHome();
}
function localOf(rel) {
  if (rel.includes("..") || rel.startsWith("/")) {
    throw new Error("\u975E\u6CD5\u7684\u76F8\u5BF9\u8DEF\u5F84: " + rel);
  }
  return join(dshHome(), rel);
}
function relFromRemote(remote) {
  if (!remote.startsWith("/dsh/")) throw new Error("\u8FDC\u7AEF\u8DEF\u5F84\u5FC5\u987B\u4EE5 /dsh/ \u5F00\u5934: " + remote);
  const rel = remote.slice("/dsh/".length);
  if (rel.includes("..") || rel.length === 0) throw new Error("\u975E\u6CD5\u7684\u8FDC\u7AEF\u8DEF\u5F84: " + remote);
  return rel;
}

// src/config.ts
import z from "@deepseek-ai/schemastery";
var DEFAULT_SYNC_SCOPE = {
  /** sessions/ 会话记录本体（聊天内容，不含凭据） */
  sessions: true,
  /** storages/workspace.json 工作区注册表（缺了它，同步过来的会话只能落到「未分组」） */
  workspaces: true,
  /**
   * 工作区**目录内容**（源码等）。rel 空间统一挂在 `workspaces/<名字>/` 下，
   * 手机与电脑的工作区绝对路径不同，但折算后落到同一前缀，所以两端不会错位。
   */
  workspaceFiles: true,
  /** 用户自己加的任意目录（配置里的 customFolders 映射表），与工作区文件并列 */
  customFolders: true,
  /** session-titles.json 会话标题索引（很小，但缺了列表会没名字） */
  sessionTitles: true,
  /** attachments/ 图片与文件 */
  attachments: true,
  /** skills/ 自定义技能 */
  skills: true,
  /** profiles/ 插件与 Profile 配置（可能含插件凭据） */
  profiles: false,
  /** settings.yaml 主设置（可能含 API Key 明文） */
  settings: false,
  /** cordis.patch.yml 插件装配层 */
  pluginPatch: false
};
var NasSyncSchema = z.object({
  type: z.union(["webdav", "mount"]).default("webdav"),
  webdav: z.object({
    url: z.string().default(""),
    /** NAS 端共享文件夹名或子路径（如 /dsh-sync、/home/DSH备份）；空 = 根目录 */
    remotePath: z.string().default(""),
    username: z.string().default(""),
    password: z.string().role("secret").default("")
  }).default({ url: "", remotePath: "", username: "", password: "" }),
  mountRoot: z.string().default(""),
  /** 加密口令：所有上传内容用 scrypt(secretbox) 加密，必填 */
  passphrase: z.string().role("secret").default(""),
  autoSync: z.object({
    enabled: z.boolean().default(false),
    mode: z.union(["push", "pull", "mirror"]).default("push"),
    intervalMin: z.number().min(1).max(1440).default(30)
  }).default({ enabled: false, mode: "push", intervalMin: 30 }),
  /** 超过该字节的文件走分块上传，默认 100 MiB */
  chunkThreshold: z.number().min(1024).default(100 * 1024 * 1024),
  /** 分块大小，默认 50 MiB */
  chunkSize: z.number().min(1024).default(50 * 1024 * 1024),
  /** 上传并发数 */
  concurrency: z.number().min(1).max(16).default(4),
  /** 已选分类**内部**是否连凭据文件（.credentials 等）一起同步，默认 false */
  includeSensitive: z.boolean().default(false),
  /** r3：按分类勾选同步内容（未列出的键走 DEFAULT_SYNC_SCOPE） */
  syncScope: z.object({
    sessions: z.boolean().default(DEFAULT_SYNC_SCOPE.sessions),
    workspaces: z.boolean().default(DEFAULT_SYNC_SCOPE.workspaces),
    workspaceFiles: z.boolean().default(DEFAULT_SYNC_SCOPE.workspaceFiles),
    customFolders: z.boolean().default(DEFAULT_SYNC_SCOPE.customFolders),
    sessionTitles: z.boolean().default(DEFAULT_SYNC_SCOPE.sessionTitles),
    attachments: z.boolean().default(DEFAULT_SYNC_SCOPE.attachments),
    skills: z.boolean().default(DEFAULT_SYNC_SCOPE.skills),
    profiles: z.boolean().default(DEFAULT_SYNC_SCOPE.profiles),
    settings: z.boolean().default(DEFAULT_SYNC_SCOPE.settings),
    pluginPatch: z.boolean().default(DEFAULT_SYNC_SCOPE.pluginPatch)
  }).default({ ...DEFAULT_SYNC_SCOPE }),
  /**
   * 技能白名单：只同步 `skills/` 下**这些一级目录名**。
   *
   * 语义上「空数组 = 全部」而不是「空 = 一个都不要」：
   * ① 默认配置（老版本没有这个键）必须表现为「照旧全同步」，否则升级即静默丢数据；
   * ② 用户勾满所有技能时归一化成空数组，将来新增的技能会自动纳入，不用回头再勾。
   * 想表达「一个技能都不同步」，把 `syncScope.skills` 关掉即可，不必用空列表表达。
   */
  skillFilter: z.array(z.string()).default([]),
  /**
   * 自定义文件夹：**每台机器各自维护**的「名字 → 本机路径」映射表。
   *
   * 为什么不是「两端同一个绝对路径」：手机和电脑的盘符/目录结构天然不同，
   * 要求一致等于把这个功能限制成同机备份。所以用 `name` 当跨设备的稳定标识
   * （rel 前缀 `custom-folders/<name>/`），`path` 只在本机有意义 ——
   * 同一份远端数据，在电脑上落到 `D:\Projects\foo`、在手机上落到别的目录都行。
   *
   * 上传：扫 `path` 目录，rel 记作 `custom-folders/<name>/…`
   * 下载：按 rel 里的 `<name>` 查出本机 `path`，落到那里（见 engine 的 resolveLocal）
   */
  customFolders: z.array(z.object({
    name: z.string(),
    path: z.string()
  })).default([])
});

// src/sync/portable.ts
import * as zlib from "node:zlib";
import { readdir, readFile, writeFile, mkdir, stat, rename, rm } from "node:fs/promises";
import { join as join2, resolve, sep } from "node:path";
import * as os from "node:os";
var zstdImpl = zlib;
var zstdCompress = zstdImpl.zstdCompressSync ?? null;
var zstdDecompress = zstdImpl.zstdDecompressSync ?? null;
var WORKSPACE_REGISTRY_REL = "storages/workspace.json";
var WORKSPACES_DIR = "nassyncworkspaces";
var WORKSPACE_FILES_PREFIX = "workspaces";
function safeName(p) {
  if (typeof p !== "string" || p.length === 0) return "workspace";
  const parts = p.split(/[\\/]+/).filter(Boolean);
  const base = parts.length > 0 ? parts[parts.length - 1] : "";
  const cleaned = base.replace(/[<>:"|?*\u0000-\u001f]/g, "_").replace(/-+/g, "_").replace(/[. ]+$/, "");
  return cleaned.length > 0 ? cleaned : "workspace";
}
function workspaceRelOf(dirPath) {
  return `${WORKSPACE_FILES_PREFIX}/${safeName(dirPath)}`;
}
function isUnsafeWorkspaceRoot(dir, home) {
  let norm;
  let h;
  try {
    norm = resolve(dir);
    h = resolve(home);
  } catch {
    return true;
  }
  if (norm === h || h === norm || h.startsWith(norm.endsWith(sep) ? norm : norm + sep)) return true;
  const segs = norm.split(/[\\/]+/).filter((s) => s.length > 0);
  return segs.length <= 1;
}
async function collectWorkspaceDirs(home = dshHome()) {
  const out = [];
  const seenDir = /* @__PURE__ */ new Set();
  const seenRel = /* @__PURE__ */ new Set();
  const push = async (id, title, dir) => {
    if (typeof dir !== "string" || dir.length === 0) return;
    if (isUnsafeWorkspaceRoot(dir, home)) return;
    let st;
    try {
      st = await stat(dir);
    } catch {
      return;
    }
    if (!st.isDirectory()) return;
    const abs = resolve(dir);
    const rel = workspaceRelOf(abs);
    if (seenDir.has(abs) || seenRel.has(rel)) return;
    seenDir.add(abs);
    seenRel.add(rel);
    out.push({ id, title, dir: abs, rel });
  };
  let parsed;
  try {
    parsed = JSON.parse(await readFile(join2(home, WORKSPACE_REGISTRY_REL), "utf8"));
  } catch {
    parsed = null;
  }
  const spaces = parsed?.["tables"]?.["workspaces"] ?? {};
  for (const [id, w] of Object.entries(spaces)) {
    const title = typeof w?.["title"] === "string" ? w["title"] : "";
    await push(id, title, w?.["path"]);
  }
  let names = [];
  try {
    names = await readdir(join2(home, WORKSPACES_DIR));
  } catch {
    names = [];
  }
  for (const name of names) {
    if (name.startsWith(".")) continue;
    await push("", name, join2(home, WORKSPACES_DIR, name));
  }
  return out;
}
var WORKSPACE_SKIP_DIRS = /* @__PURE__ */ new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "__pycache__",
  ".venv",
  "venv",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "nas-sync"
]);
var DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
function isElectronAsarPath(p) {
  return /\.asar$/i.test(p);
}
async function* walkWorkspaceFiles(ws, maxBytes = DEFAULT_MAX_FILE_BYTES) {
  yield* walkInto(ws.dir, ws.rel, 0, maxBytes);
}
async function* walkInto(dir, relBase, depth, maxBytes) {
  if (depth > 24) return;
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const full = join2(dir, name);
    let st;
    try {
      st = await stat(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (WORKSPACE_SKIP_DIRS.has(name)) continue;
      yield* walkInto(full, `${relBase}/${name}`, depth + 1, maxBytes);
      continue;
    }
    if (!st.isFile()) continue;
    if (isElectronAsarPath(full)) continue;
    if (st.size > maxBytes) continue;
    if (name.endsWith(".base") || name.endsWith(".chunk-manifest.json") || name.endsWith(".lock")) continue;
    yield { rel: `${relBase}/${name}`, file: full };
  }
}
var CUSTOM_FOLDERS_PREFIX = "custom-folders";
function customFolderRelOf(name) {
  return `${CUSTOM_FOLDERS_PREFIX}/${name}`;
}
async function* walkCustomFolder(folder, maxBytes = DEFAULT_MAX_FILE_BYTES) {
  yield* walkInto(folder.path, customFolderRelOf(folder.name), 0, maxBytes);
}
function selfDevice() {
  let host = "";
  try {
    host = os.hostname();
  } catch {
  }
  const clean = host.replace(/[^\w.-]/g, "").slice(0, 24) || "device";
  const plat = process.platform === "linux" && (process.env.ANDROID_ROOT || process.env.ANDROID_DATA) ? "android" : process.platform;
  return plat + ":" + clean;
}

// src/sync/scanner.ts
var SYNC_CATEGORIES = [
  { key: "sessions", localDir: "sessions", label: "\u4F1A\u8BDD\u8BB0\u5F55", desc: "sessions/ \u4E0B\u7684\u5BF9\u8BDD\u5185\u5BB9", sensitive: false },
  { key: "workspaces", localDir: "storages/workspace.json", label: "\u5DE5\u4F5C\u533A\u6E05\u5355", desc: "\u4FA7\u680F\u7684\u5DE5\u4F5C\u533A/\u6587\u4EF6\u5939\u540D\u4E0E\u4F1A\u8BDD\u5F52\u5C5E\uFF1B\u62C9\u53D6\u65F6\u5408\u5E76\u5E76\u81EA\u52A8\u6620\u5C04\u8DEF\u5F84", sensitive: false },
  /**
   * 注意：这一项的 localDir 只是「名义前缀」，实际扫的是注册表里每个工作区的真实目录
   * （手机上它们在 $DSH_HOME 之外），见 Scanner#manifestOfWorkspaceFiles。
   * 但 rel 空间一律记作 `workspaces/<名字>/…`，因此拉取端不需要任何特殊处理。
   */
  { key: "workspaceFiles", localDir: "workspaces", label: "\u5DE5\u4F5C\u533A\u6587\u4EF6", desc: "\u6BCF\u4E2A\u5DE5\u4F5C\u533A\u76EE\u5F55\u91CC\u7684\u6E90\u7801\u7B49\u6587\u4EF6\uFF08\u8DF3\u8FC7 node_modules\u3001.git \u7B49\uFF09", sensitive: false },
  { key: "customFolders", localDir: "custom-folders", label: "\u81EA\u5B9A\u4E49\u6587\u4EF6\u5939", desc: "\u989D\u5916\u6307\u5B9A\u7684\u4EFB\u610F\u76EE\u5F55\uFF0C\u540D\u5B57\u76F8\u540C\u5373\u5BF9\u5E94\u540C\u4E00\u4EFD\u6570\u636E\uFF0C\u672C\u673A\u8DEF\u5F84\u5404\u81EA\u8BBE\u7F6E", sensitive: false },
  { key: "sessionTitles", localDir: "session-titles.json", label: "\u4F1A\u8BDD\u6807\u9898", desc: "\u4F1A\u8BDD\u5217\u8868\u7684\u6807\u9898\u7D22\u5F15", sensitive: false },
  { key: "attachments", localDir: "attachments", label: "\u9644\u4EF6", desc: "attachments/ \u56FE\u7247\u4E0E\u6587\u4EF6\uFF0C\u901A\u5E38\u6700\u5927", sensitive: false },
  { key: "skills", localDir: "skills", label: "\u6280\u80FD", desc: "skills/ \u81EA\u5B9A\u4E49\u6280\u80FD", sensitive: false },
  { key: "profiles", localDir: "profiles", label: "Profile \u4E0E\u63D2\u4EF6", desc: "profiles/ \u63D2\u4EF6\u914D\u7F6E\uFF0C\u53EF\u80FD\u542B\u63D2\u4EF6\u51ED\u636E", sensitive: true },
  { key: "settings", localDir: "settings.yaml", label: "\u4E3B\u8BBE\u7F6E", desc: "settings.yaml\uFF0C\u53EF\u80FD\u542B API Key \u660E\u6587", sensitive: true },
  { key: "pluginPatch", localDir: "cordis.patch.yml", label: "\u63D2\u4EF6\u8865\u4E01", desc: "cordis.patch.yml \u63D2\u4EF6\u88C5\u914D\u5C42", sensitive: true }
];
function categoryByKey(key) {
  return SYNC_CATEGORIES.find((c) => c.key === key);
}
var DEFAULT_RULES = SYNC_CATEGORIES.filter((c) => DEFAULT_SYNC_SCOPE[c.key]).map((c) => ({ key: c.key, localDir: c.localDir, sensitive: c.sensitive }));
var SENSITIVE_NAMES = [".credentials.yaml", ".credentials", ".env", ".token"];
async function* walkFiles(dir) {
  let names;
  try {
    names = await readdir2(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const full = join3(dir, name);
    let st;
    try {
      st = await stat2(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "nas-sync") continue;
      yield* walkFiles(full);
    } else {
      if (name.endsWith(".base") || name.endsWith(".chunk-manifest.json")) continue;
      if (name.endsWith(".lock")) continue;
      yield full;
    }
  }
}
var Scanner = class {
  includeSensitive;
  rules;
  scope;
  skillFilter;
  customFolders;
  maxFileBytes;
  /**
   * @param opts.scope            分类勾选（缺省 = DEFAULT_SYNC_SCOPE）
   * @param opts.includeSensitive 已选分类**内部**是否连凭据文件一起同步
   * @param opts.skillFilter      技能白名单（空 = 全部，见 config.ts 的语义说明）
   * @param opts.customFolders    自定义文件夹映射表（名字 + 本机路径）
   * @param opts.maxFileBytes     单文件上限，超过直接跳过（见 portable.ts 的说明）
   * @param opts.rules            直接指定规则（测试用；给了就不看 scope）
   */
  constructor(opts = {}) {
    this.includeSensitive = opts.includeSensitive ?? false;
    this.scope = { ...DEFAULT_SYNC_SCOPE, ...opts.scope ?? {} };
    this.skillFilter = opts.skillFilter ?? [];
    this.customFolders = opts.customFolders ?? [];
    this.maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.rules = opts.rules ?? this.rulesFromScope();
  }
  /** 勾选的分类 → 规则表。注意：这里**不**用 includeSensitive 过滤整体分类。 */
  rulesFromScope() {
    return SYNC_CATEGORIES.filter((c) => this.scope[c.key] !== false).map((c) => ({ key: c.key, localDir: c.localDir, sensitive: c.sensitive }));
  }
  /** 当前生效的规则（只读，供状态/日志展示）。 */
  activeRules() {
    return this.rules.map((r) => ({ ...r }));
  }
  isSensitive(rel) {
    const base = rel.split("/").pop() ?? "";
    if (SENSITIVE_NAMES.some((s) => base === s)) return true;
    return rel.startsWith("profiles/") && SENSITIVE_NAMES.some((s) => base.endsWith(s));
  }
  /**
   * 技能白名单判定（实现见模块级 skillAllowed）。
   */
  skillAllowed(rel) {
    return skillAllowed(rel, this.skillFilter);
  }
  async *walk(dir) {
    yield* walkFiles(dir);
  }
  async buildManifest() {
    const base = dshHome();
    const out = [];
    for (const rule of this.rules) {
      if (rule.key === "workspaceFiles") {
        out.push(...await this.manifestOfWorkspaceFiles(base));
        continue;
      }
      if (rule.key === "customFolders") {
        out.push(...await this.manifestOfCustomFolders());
        continue;
      }
      const local = resolve2(base, rule.localDir);
      let st;
      try {
        st = await stat2(local);
      } catch {
        continue;
      }
      if (st.isFile()) {
        const rel = rule.localDir;
        if (!this.includeSensitive && this.isSensitive(rel)) continue;
        out.push(await this.toEntry(local, rel));
        continue;
      }
      for await (const file of this.walk(local)) {
        const rel = file.slice(base.length + 1).split(/[\\/]/).join("/");
        if (!this.includeSensitive && this.isSensitive(rel)) continue;
        if (!this.skillAllowed(rel)) continue;
        out.push(await this.toEntry(file, rel));
      }
    }
    return out;
  }
  /**
   * 「工作区文件」的清单。
   *
   * 工作区的真实目录来自 `storages/workspace.json`，不是 `$DSH_HOME/workspaces`
   * —— 手机上的工作区在 home 之外的 `/data/.../home/wstest`。两端都折算成
   * `workspaces/<名字>/…` 这个 rel 前缀，所以拉取端 localOf(rel) 天然落到
   * 合并清单时映射出来的同一目录，无需引擎特判。
   */
  async manifestOfWorkspaceFiles(base) {
    const out = [];
    let dirs;
    try {
      dirs = await collectWorkspaceDirs(base);
    } catch {
      return out;
    }
    for (const ws of dirs) {
      try {
        for await (const f of walkWorkspaceFiles(ws)) {
          if (!this.includeSensitive && this.isSensitive(f.rel)) continue;
          out.push(await this.toEntry(f.file, f.rel));
        }
      } catch {
      }
    }
    return out;
  }
  /**
   * 「自定义文件夹」的清单。
   *
   * 目录来自配置里的映射表（`name → 本机 path`），本机没有这个目录就跳过 ——
   * 典型场景是另一台机器刚配好映射、还没把文件拉下来，此时不该报错。
   */
  async manifestOfCustomFolders() {
    const out = [];
    for (const folder of this.customFolders) {
      let st;
      try {
        st = await stat2(folder.path);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      try {
        for await (const f of walkCustomFolder(folder, this.maxFileBytes)) {
          if (!this.includeSensitive && this.isSensitive(f.rel)) continue;
          out.push(await this.toEntry(f.file, f.rel));
        }
      } catch {
      }
    }
    return out;
  }
  async toEntry(file, rel) {
    const s = statSync(file);
    const buf = await readFile2(file);
    return {
      rel,
      mtime: s.mtimeMs,
      size: s.size,
      hash: createHash("sha256").update(buf).digest("hex"),
      // 扫描到即认为「本机拥有/上传了它」。engine 写远端清单时会用「内容没变就
      // 保留原来源」的规则把它改回真正的上传方，所以这里填本机是安全的。
      device: selfDevice()
    };
  }
};
function countByCategory(entries) {
  const stats = {};
  for (const c of SYNC_CATEGORIES) stats[c.key] = { files: 0, bytes: 0 };
  stats.__unknown = { files: 0, bytes: 0 };
  for (const e of entries) {
    const hit = SYNC_CATEGORIES.filter((c) => e.rel === c.localDir || e.rel.startsWith(c.localDir + "/")).sort((a, b) => b.localDir.length - a.localDir.length)[0];
    const bucket = stats[hit ? hit.key : "__unknown"];
    bucket.files += 1;
    bucket.bytes += e.size;
  }
  return stats;
}
async function summarizeCategories(opts) {
  const scope = { ...DEFAULT_SYNC_SCOPE, ...opts.scope };
  const out = {};
  for (const c of SYNC_CATEGORIES) out[c.key] = { files: 0, bytes: 0 };
  const sc = new Scanner({ scope, includeSensitive: opts.includeSensitive, skillFilter: opts.skillFilter, customFolders: opts.customFolders });
  for (const rule of sc.activeRules()) {
    if (rule.key === "workspaceFiles") {
      try {
        for (const ws of await collectWorkspaceDirs(dshHome())) {
          for await (const f of walkWorkspaceFiles(ws)) {
            try {
              const fs2 = await stat2(f.file);
              out[rule.key].files += 1;
              out[rule.key].bytes += fs2.size;
            } catch {
            }
          }
        }
      } catch {
      }
      continue;
    }
    if (rule.key === "customFolders") {
      for (const folder of opts.customFolders ?? []) {
        try {
          for await (const f of walkCustomFolder(folder)) {
            const s = await stat2(f.file);
            out[rule.key].files += 1;
            out[rule.key].bytes += s.size;
          }
        } catch {
        }
      }
      continue;
    }
    const local = resolve2(dshHome(), rule.localDir);
    let st;
    try {
      st = await stat2(local);
    } catch {
      continue;
    }
    if (st.isFile()) {
      out[rule.key].files += 1;
      out[rule.key].bytes += st.size;
      continue;
    }
    for await (const f of walkFiles(local)) {
      const rel = f.slice(dshHome().length + 1).split(/[\\/]/).join("/");
      if (!skillAllowed(rel, opts.skillFilter ?? [])) continue;
      try {
        const fs2 = await stat2(f);
        out[rule.key].files += 1;
        out[rule.key].bytes += fs2.size;
      } catch {
      }
    }
  }
  return out;
}
function skillAllowed(rel, filter) {
  if (!filter || filter.length === 0) return true;
  const parts = rel.split("/");
  if (parts[0] !== "skills" || parts.length < 2) return true;
  return filter.includes(parts[1]);
}
async function listSkills() {
  const dir = resolve2(dshHome(), "skills");
  let names;
  try {
    names = await readdir2(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const full = join3(dir, name);
    let st;
    try {
      st = await stat2(full);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    let files = 0;
    let bytes = 0;
    for await (const f of walkFiles(full)) {
      try {
        const s = await stat2(f);
        files += 1;
        bytes += s.size;
      } catch {
      }
    }
    out.push({ name, files, bytes });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
function remoteToLocal(remote) {
  return localOf(relFromRemote(remote));
}
export {
  DEFAULT_RULES,
  SYNC_CATEGORIES,
  Scanner,
  categoryByKey,
  countByCategory,
  listSkills,
  remoteToLocal,
  skillAllowed,
  summarizeCategories,
  walkFiles
};
