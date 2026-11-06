// src/sync/manifest.ts
function mergeManifestDevices(fresh, prev) {
  const old = new Map(prev.map((e) => [e.rel, e]));
  return fresh.map((e) => {
    const before = old.get(e.rel);
    return before && before.device && before.hash === e.hash ? { ...e, device: before.device } : e;
  });
}
function mergeManifestPreserving(fresh, prevRemote, baseline) {
  const merged = mergeManifestDevices(fresh, prevRemote);
  const seen = new Set(merged.map((e) => e.rel));
  const had = new Set(baseline.map((e) => e.rel));
  for (const e of prevRemote) {
    if (seen.has(e.rel) || had.has(e.rel)) continue;
    merged.push(e);
  }
  return merged;
}
export {
  mergeManifestDevices,
  mergeManifestPreserving
};
