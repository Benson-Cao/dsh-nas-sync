// src/sync/portable.ts
import * as zlib from "node:zlib";
import { readdir, readFile, writeFile, mkdir, stat, rename, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import * as os from "node:os";

// scripts/_test-home-paths-stub.mjs
function resolveDshHome() {
  return process.env.DSH_HOME_TEST || process.env.DSH_HOME || "/tmp/dsh-test-home";
}

// src/paths.ts
function dshHome() {
  return resolveDshHome();
}

// src/sync/portable.ts
var zstdImpl = zlib;
var zstdCompress = zstdImpl.zstdCompressSync ?? null;
var zstdDecompress = zstdImpl.zstdDecompressSync ?? null;
var WORKSPACE_REGISTRY_REL = "storages/workspace.json";
var WORKSPACES_DIR = "nassyncworkspaces";
var WORKSPACE_FILES_PREFIX = "workspaces";
var SESSION_FILE_RE = /^session\.v\d+\.jsonl\.zstd$/;
var SESSION_REL_RE = /^sessions\/[^/]+\/[^/]+\/session\.v\d+\.jsonl\.zstd$/;
function isSessionRel(rel) {
  return SESSION_REL_RE.test(rel);
}
function isWorkspaceRegistryRel(rel) {
  return rel === WORKSPACE_REGISTRY_REL;
}
function workspaceRegistryReady(home = dshHome()) {
  try {
    const p = join(home, "storages", "workspace.json");
    if (!existsSync(p)) return false;
    const d = JSON.parse(readFileSync(p, "utf-8"));
    const ids = d?.global?.workspaceIds;
    if (!Array.isArray(ids) || ids.length === 0) return false;
    if (d?.global?.initialized === false) return false;
    return true;
  } catch {
    return false;
  }
}
function safeName(p) {
  if (typeof p !== "string" || p.length === 0) return "workspace";
  const parts = p.split(/[\\/]+/).filter(Boolean);
  const base = parts.length > 0 ? parts[parts.length - 1] : "";
  const cleaned = base.replace(/[<>:"|?*\u0000-\u001f]/g, "_").replace(/-+/g, "_").replace(/[. ]+$/, "");
  return cleaned.length > 0 ? cleaned : "workspace";
}
function mapRemotePath(remotePath, home = dshHome()) {
  if (typeof remotePath === "string" && remotePath.length > 0) {
    try {
      if (existsSync(remotePath)) return { local: remotePath, mapped: false };
    } catch {
    }
  }
  return { local: join(home, WORKSPACES_DIR, safeName(remotePath)), mapped: true };
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
    parsed = JSON.parse(await readFile(join(home, WORKSPACE_REGISTRY_REL), "utf8"));
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
    names = await readdir(join(home, WORKSPACES_DIR));
  } catch {
    names = [];
  }
  for (const name of names) {
    if (name.startsWith(".")) continue;
    await push("", name, join(home, WORKSPACES_DIR, name));
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
    const full = join(dir, name);
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
function customFolderLocalOf(rel, folders) {
  const prefix = CUSTOM_FOLDERS_PREFIX + "/";
  if (!rel.startsWith(prefix)) return null;
  const rest = rel.slice(prefix.length);
  if (rest.length === 0) return null;
  const slash = rest.indexOf("/");
  const name = slash === -1 ? rest : rest.slice(0, slash);
  const sub = slash === -1 ? "" : rest.slice(slash + 1);
  const folder = folders.find((f) => f.name === name);
  if (!folder || folder.path.length === 0) return null;
  if (sub.split("/").some((seg) => seg === ".." || seg === "")) return null;
  return { local: sub.length === 0 ? folder.path : join(folder.path, sub), folder };
}
async function* walkCustomFolder(folder, maxBytes = DEFAULT_MAX_FILE_BYTES) {
  yield* walkInto(folder.path, customFolderRelOf(folder.name), 0, maxBytes);
}
var ZSTD_MAGIC = 4247762216;
function zstdFrameEnd(buf, start) {
  if (buf.length - start < 8) throw new Error("zstd: \u7F13\u51B2\u533A\u8FC7\u77ED");
  if (buf.readUInt32LE(start) !== ZSTD_MAGIC) throw new Error("zstd: magic \u4E0D\u5339\u914D");
  let p = start + 4;
  const fhd = buf[p];
  p += 1;
  const fcsFlag = fhd >> 6;
  const singleSegment = fhd >> 5 & 1;
  const hasChecksum = fhd >> 2 & 1;
  const dictFlag = fhd & 3;
  if (singleSegment === 0) p += 1;
  p += [0, 1, 2, 4][dictFlag] ?? 0;
  const fcsSize = fcsFlag === 0 ? singleSegment === 1 ? 1 : 0 : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8;
  p += fcsSize;
  for (; ; ) {
    if (p + 3 > buf.length) throw new Error("zstd: block header \u8D8A\u754C");
    const bh = buf[p] | buf[p + 1] << 8 | buf[p + 2] << 16;
    p += 3;
    const last = bh & 1;
    const type = bh >> 1 & 3;
    const size = bh >>> 3;
    if (type === 3) throw new Error("zstd: \u4FDD\u7559 block \u7C7B\u578B");
    p += type === 1 ? 1 : size;
    if (p > buf.length) throw new Error("zstd: block \u8D8A\u754C");
    if (last === 1) break;
  }
  if (hasChecksum === 1) p += 4;
  if (p > buf.length) throw new Error("zstd: checksum \u8D8A\u754C");
  return p;
}
function decodeFirstFrame(buf) {
  if (zstdDecompress === null) return null;
  try {
    const end = zstdFrameEnd(buf, 0);
    return zstdDecompress(buf.subarray(0, end)).toString("utf8");
  } catch {
    return null;
  }
}
function readHeaderCwd(buf) {
  const text = decodeFirstFrame(buf);
  if (text === null) return null;
  const nl = text.indexOf("\n");
  const headLine = nl === -1 ? text : text.slice(0, nl);
  let header;
  try {
    header = JSON.parse(headLine);
  } catch {
    return null;
  }
  if (typeof header !== "object" || header === null) return null;
  const h = header;
  if (h["type"] !== "session" || typeof h["cwd"] !== "string") return null;
  return { header: h, rest: nl === -1 ? "" : text.slice(nl) };
}
function rewriteSessionCwd(buf, home = dshHome()) {
  if (zstdCompress === null) return null;
  const parsed = readHeaderCwd(buf);
  if (!parsed) return null;
  const { local, mapped } = mapRemotePath(parsed.header["cwd"], home);
  if (!mapped) return null;
  let end;
  try {
    end = zstdFrameEnd(buf, 0);
  } catch {
    return null;
  }
  parsed.header["cwd"] = local;
  const headFrame = zstdCompress(Buffer.from(JSON.stringify(parsed.header) + parsed.rest, "utf8"));
  return { buf: Buffer.concat([headFrame, buf.subarray(end)]), dir: local };
}
function sessionCwdOf(buf) {
  const parsed = readHeaderCwd(buf);
  return parsed && typeof parsed.header["cwd"] === "string" ? parsed.header["cwd"] : null;
}
function dedupeWorkspaceSessions(local) {
  const tables = local?.["tables"];
  const workspaces = tables?.["workspaces"];
  if (!workspaces || typeof workspaces !== "object") return 0;
  const globals = local["global"] ?? {};
  const listed = globals["workspaceIds"];
  const ids = Object.keys(workspaces);
  const order = [];
  if (Array.isArray(listed)) {
    for (const id of listed) if (typeof id === "string" && ids.includes(id)) order.push(id);
  }
  for (const id of ids) if (!order.includes(id)) order.push(id);
  const seen = /* @__PURE__ */ new Set();
  let removed = 0;
  for (const id of order) {
    const w = workspaces[id];
    const raw = w?.["sessionIds"];
    if (!Array.isArray(raw)) continue;
    const keep = [];
    const within = /* @__PURE__ */ new Set();
    for (const s of raw) {
      const sid = typeof s === "string" ? s : String(s);
      if (seen.has(sid) || within.has(sid)) {
        removed += 1;
        continue;
      }
      seen.add(sid);
      within.add(sid);
      keep.push(sid);
    }
    w["sessionIds"] = keep;
  }
  return removed;
}
function normalizeWorkspaceRegistry(local) {
  const tables = local?.["tables"];
  const workspaces = tables?.["workspaces"];
  if (!workspaces || typeof workspaces !== "object") {
    return { merged: 0, removed: 0, orderFixed: 0 };
  }
  const globals = local["global"] ?? (local["global"] = {});
  const listed = globals["workspaceIds"];
  const ids = [];
  if (Array.isArray(listed)) {
    for (const id of listed) {
      if (typeof id === "string" && workspaces[id] && !ids.includes(id)) ids.push(id);
    }
  }
  for (const id of Object.keys(workspaces)) if (!ids.includes(id)) ids.push(id);
  const isMapped = (p) => typeof p === "string" && p.includes(WORKSPACES_DIR);
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (x) => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    return r;
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  const byTitle = /* @__PURE__ */ new Map();
  const byPath = /* @__PURE__ */ new Map();
  for (const id of ids) {
    const w = workspaces[id];
    const title = String(w?.["title"] ?? "").trim().toLowerCase();
    const path = w?.["path"];
    if (title) {
      const prev = byTitle.get(title);
      if (prev) union(prev, id);
      else byTitle.set(title, id);
    }
    if (typeof path === "string") {
      const prev = byPath.get(path);
      if (prev) union(prev, id);
      else byPath.set(path, id);
    }
  }
  const groups = /* @__PURE__ */ new Map();
  for (const id of ids) {
    const root = find(id);
    const arr = groups.get(root) ?? [];
    arr.push(id);
    groups.set(root, arr);
  }
  const keep = [];
  let merged = 0;
  for (const [, members] of groups) {
    const keeper = members[0];
    keep.push(keeper);
    if (members.length < 2) continue;
    const real = members.find((m) => !isMapped(workspaces[m]["path"]));
    if (real && real !== keeper) {
      workspaces[keeper]["path"] = workspaces[real]["path"];
    }
    const seen = /* @__PURE__ */ new Set();
    const sessionIds = [];
    for (const m of members) {
      const raw = workspaces[m]["sessionIds"];
      if (!Array.isArray(raw)) continue;
      for (const s of raw) {
        const sid = typeof s === "string" ? s : String(s);
        if (!seen.has(sid)) {
          seen.add(sid);
          sessionIds.push(sid);
        }
      }
    }
    workspaces[keeper]["sessionIds"] = sessionIds;
    for (const m of members.slice(1)) {
      delete workspaces[m];
      merged += 1;
    }
  }
  const oldIds = Array.isArray(listed) ? listed : [];
  const orderChanged = oldIds.length !== keep.length || oldIds.some((id, i) => id !== keep[i]);
  globals["workspaceIds"] = keep;
  const orderFixed = (orderChanged ? 1 : 0) + merged;
  if (typeof globals["defaultWorkspaceId"] !== "string" || !keep.includes(globals["defaultWorkspaceId"])) {
    globals["defaultWorkspaceId"] = keep[0] ?? null;
  }
  globals["initialized"] = true;
  globals["archivedSessionIds"] ??= [];
  globals["pinnedSessionIds"] ??= [];
  const removed = dedupeWorkspaceSessions(local);
  return { merged, removed, orderFixed };
}
async function repairWorkspaceRegistry(home = dshHome()) {
  const localPath = join(home, WORKSPACE_REGISTRY_REL);
  let text;
  try {
    text = await readFile(localPath, "utf8");
  } catch {
    return { merged: 0, removed: 0, orderFixed: 0 };
  }
  let local;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return { merged: 0, removed: 0, orderFixed: 0 };
    local = parsed;
  } catch {
    return { merged: 0, removed: 0, orderFixed: 0 };
  }
  const result = normalizeWorkspaceRegistry(local);
  if (result.merged === 0 && result.removed === 0 && result.orderFixed === 0) return result;
  const tmp = localPath + ".nas-sync.tmp";
  await writeFile(tmp, JSON.stringify(local, null, 2) + "\n");
  await rename(tmp, localPath);
  return result;
}
async function mergeWorkspaceRegistry(remoteText, home = dshHome()) {
  let remote;
  try {
    remote = JSON.parse(remoteText);
  } catch {
    return { added: 0, remapped: 0, total: 0, deduped: 0 };
  }
  const localPath = join(home, WORKSPACE_REGISTRY_REL);
  let local;
  try {
    const parsed = JSON.parse(await readFile(localPath, "utf8"));
    local = typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    local = {};
  }
  local["unit"] ??= { name: "workspace", version: 2 };
  local["global"] ??= { initialized: true };
  const globals = local["global"];
  globals["workspaceIds"] ??= [];
  globals["archivedSessionIds"] ??= [];
  globals["pinnedSessionIds"] ??= [];
  local["tables"] ??= {};
  const tables = local["tables"];
  tables["workspaces"] ??= {};
  const workspaces = tables["workspaces"];
  const remoteWorkspaces = remote?.["tables"]?.["workspaces"] ?? {};
  let added = 0;
  let remapped = 0;
  for (const [id, raw] of Object.entries(remoteWorkspaces)) {
    const rw = raw ?? {};
    const existing = workspaces[id];
    if (existing !== void 0) {
      const set = new Set(Array.isArray(existing["sessionIds"]) ? existing["sessionIds"] : []);
      for (const s of Array.isArray(rw["sessionIds"]) ? rw["sessionIds"] : []) set.add(String(s));
      existing["sessionIds"] = [...set];
      const currentPath = existing["path"];
      const badPath = typeof currentPath !== "string" || currentPath.length === 0 || !existsSync(currentPath);
      if (badPath) {
        const m2 = mapRemotePath(currentPath ?? rw["path"], home);
        await mkdir(m2.local, { recursive: true });
        existing["path"] = m2.local;
        remapped += 1;
      }
      if (!globals["workspaceIds"].includes(id)) globals["workspaceIds"].push(id);
      continue;
    }
    const m = mapRemotePath(rw["path"], home);
    await mkdir(m.local, { recursive: true });
    workspaces[id] = {
      ...rw,
      path: m.local,
      sessionIds: Array.isArray(rw["sessionIds"]) ? [...rw["sessionIds"]] : []
    };
    if (!globals["workspaceIds"].includes(id)) globals["workspaceIds"].push(id);
    added += 1;
  }
  globals["initialized"] ??= true;
  if (!globals["defaultWorkspaceId"] && globals["workspaceIds"].length > 0) {
    globals["defaultWorkspaceId"] = globals["workspaceIds"][0];
  }
  const norm = normalizeWorkspaceRegistry(local);
  const deduped = norm.removed + norm.merged;
  await mkdir(join(home, "storages"), { recursive: true });
  const tmp = localPath + ".nas-sync.tmp";
  await writeFile(tmp, JSON.stringify(local, null, 2) + "\n");
  await rename(tmp, localPath);
  return { added, remapped, total: Object.keys(workspaces).length, deduped };
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
function devicePlatform(device) {
  if (!device) return "";
  const i = device.indexOf(":");
  return i === -1 ? device : device.slice(0, i);
}
function encodeCwd(p) {
  const ascii = p.replace(
    /[^\x20-\x7e]/g,
    (c) => "~" + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")
  );
  const body = ascii.replace(/[\\/:]+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
  return "--" + body + "--";
}
function platformMismatch(p) {
  if (typeof p !== "string" || p.length === 0) return true;
  const looksWindows = /^[A-Za-z]:[\\/]/.test(p);
  const looksPosix = p.startsWith("/");
  if (process.platform === "win32") return looksPosix && !looksWindows;
  return looksWindows;
}
async function repairSessionCwd(home = dshHome()) {
  const root = join(home, "sessions");
  let workspaceDirs;
  try {
    workspaceDirs = await readdir(root);
  } catch {
    return { fixed: 0, scanned: 0 };
  }
  let fixed = 0;
  let scanned = 0;
  for (const dir of workspaceDirs) {
    if (!dir.startsWith("--")) continue;
    const wdir = join(root, dir);
    let sessionDirs;
    try {
      sessionDirs = await readdir(wdir);
    } catch {
      continue;
    }
    for (const sid of sessionDirs) {
      const sdir = join(wdir, sid);
      let files;
      try {
        files = await readdir(sdir);
      } catch {
        continue;
      }
      for (const name of files) {
        if (!SESSION_FILE_RE.test(name)) continue;
        const file = join(sdir, name);
        let buf;
        try {
          buf = await readFile(file);
        } catch {
          continue;
        }
        scanned += 1;
        const out = rewriteSessionCwd(buf, home);
        if (!out) continue;
        await mkdir(out.dir, { recursive: true });
        const wantDir = encodeCwd(out.dir);
        const target = join(root, wantDir, sid, name);
        if (target === file) {
          await writeFile(file, out.buf);
          fixed += 1;
          continue;
        }
        await mkdir(join(root, wantDir, sid), { recursive: true });
        await writeFile(target, out.buf);
        try {
          await rm(sdir, { recursive: true, force: true });
        } catch {
        }
        fixed += 1;
      }
    }
  }
  return { fixed, scanned };
}
async function dedupeSessionDirs(home = dshHome()) {
  const root = join(home, "sessions");
  const result = { scanned: 0, duplicates: 0, isolated: 0 };
  let projectDirs;
  try {
    projectDirs = (await readdir(root)).filter((d) => d.startsWith("--"));
  } catch {
    return result;
  }
  const preferred = /* @__PURE__ */ new Set();
  try {
    const reg = JSON.parse(await readFile(join(home, WORKSPACE_REGISTRY_REL), "utf8"));
    const table = reg?.tables?.workspaces ?? {};
    for (const w of Object.values(table)) {
      if (typeof w?.path === "string") preferred.add(encodeCwd(w.path));
    }
  } catch {
  }
  const bySid = /* @__PURE__ */ new Map();
  for (const dir of projectDirs) {
    const wdir = join(root, dir);
    let sessionDirs;
    try {
      sessionDirs = await readdir(wdir);
    } catch {
      continue;
    }
    for (const sid of sessionDirs) {
      let files;
      try {
        files = await readdir(join(wdir, sid));
      } catch {
        continue;
      }
      if (!files.some((f) => SESSION_FILE_RE.test(f))) continue;
      result.scanned += 1;
      if (!bySid.has(sid)) bySid.set(sid, []);
      bySid.get(sid).push({ dir, hasLock: files.includes("session.lock") });
    }
  }
  const rank = (e) => preferred.has(e.dir) ? 0 : e.hasLock ? 1 : 2;
  let quarantine = "";
  for (const [sid, entries] of bySid) {
    if (entries.length < 2) continue;
    result.duplicates += 1;
    const sorted = [...entries].sort(
      (a, b) => rank(a) - rank(b) || a.dir.localeCompare(b.dir)
    );
    for (const loser of sorted.slice(1)) {
      if (!quarantine) {
        quarantine = join(home, ".suspect-quarantine", "sessions-dup-" + Date.now());
        await mkdir(quarantine, { recursive: true });
      }
      try {
        await mkdir(join(quarantine, loser.dir), { recursive: true });
        await rename(join(root, loser.dir, sid), join(quarantine, loser.dir, sid));
        result.isolated += 1;
      } catch {
      }
    }
  }
  return result;
}
export {
  CUSTOM_FOLDERS_PREFIX,
  DEFAULT_MAX_FILE_BYTES,
  WORKSPACES_DIR,
  WORKSPACE_FILES_PREFIX,
  WORKSPACE_REGISTRY_REL,
  collectWorkspaceDirs,
  customFolderLocalOf,
  customFolderRelOf,
  dedupeSessionDirs,
  dedupeWorkspaceSessions,
  devicePlatform,
  encodeCwd,
  isElectronAsarPath,
  isSessionRel,
  isWorkspaceRegistryRel,
  mapRemotePath,
  mergeWorkspaceRegistry,
  normalizeWorkspaceRegistry,
  platformMismatch,
  repairSessionCwd,
  repairWorkspaceRegistry,
  rewriteSessionCwd,
  selfDevice,
  sessionCwdOf,
  walkCustomFolder,
  walkWorkspaceFiles,
  workspaceRegistryReady,
  workspaceRelOf
};
