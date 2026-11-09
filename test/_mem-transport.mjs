/**
 * 测试用内存 NAS 传输替身（共享给引擎级测试 / 故障注入测试）。
 *
 * 实现 NasTransport 的全部方法，包括 0.6.0 新增的可选能力
 * etag / putIfMatch(CAS) / deleteTree / rename，行为与真实 WebDAV 后端一致：
 *   · putIfMatch 在 etag 不匹配时返回 {ok:false}，不写；
 *   · deleteTree 递归删；rename 是原子的（同目录 move）。
 * 不实现方法级权限、超时与重试 —— 那些由各自的后端单测负责。
 */
import { createHash } from 'node:crypto';

export class MemTransport {
  constructor() {
    this.blobs = new Map();
    this.dirs = new Set();
    /** 方法名 → Error / 抛错函数，供故障注入测试用 */
    this.faults = new Map();
    this.calls = [];
  }

  _record(name, args) { this.calls.push({ name, args }); }

  _fault(name, args) {
    const f = this.faults.get(name);
    if (!f) return;
    if (typeof f === 'function') {
      const r = f(name, args);
      if (r) throw r;
      return;
    }
    throw f instanceof Error ? f : new Error('injected fault: ' + name);
  }

  async list(dir) {
    this._record('list', [dir]);
    this._fault('list', [dir]);
    const prefix = dir.replace(/\/+$/, '') + '/';
    const names = new Set();
    for (const p of [...this.blobs.keys(), ...this.dirs]) {
      if (!p.startsWith(prefix)) continue;
      const head = p.slice(prefix.length).split('/')[0];
      if (head) names.add(head);
    }
    return [...names].sort().map((n) => {
      const full = prefix + n;
      const isDir = this.dirs.has(full) ||
        [...this.blobs.keys()].some((p) => p.startsWith(full + '/'));
      return { name: n, type: isDir ? 'dir' : 'file', mtime: Date.now(), size: 0 };
    });
  }

  async mkdir(dir) {
    this._record('mkdir', [dir]);
    this._fault('mkdir', [dir]);
    this.dirs.add(dir.replace(/\/+$/, ''));
  }

  async getBuffer(p) {
    this._record('getBuffer', [p]);
    this._fault('getBuffer', [p]);
    const b = this.blobs.get(p);
    if (!b) throw new Error('404 ' + p);
    return b;
  }

  async putBuffer(b, p, opts) {
    this._record('putBuffer', [p]);
    this._fault('putBuffer', [p]);
    this.blobs.set(p, Buffer.from(b));
    if (opts?.mkdirs) {
      const segs = p.split('/').filter(Boolean);
      segs.pop();
      let acc = '';
      for (const s of segs) { acc += '/' + s; this.dirs.add(acc); }
    }
  }

  async stat(p) {
    this._record('stat', [p]);
    this._fault('stat', [p]);
    const b = this.blobs.get(p);
    return b ? { mtime: Date.now(), size: b.length } : null;
  }

  async etag(p) {
    this._record('etag', [p]);
    this._fault('etag', [p]);
    const b = this.blobs.get(p);
    return b ? 'e-' + createHash('sha256').update(b).digest('hex').slice(0, 16) : null;
  }

  async putIfMatch(b, p, expectEtag, opts) {
    this._record('putIfMatch', [p]);
    this._fault('putIfMatch', [p]);
    const cur = await this.etag(p);
    if (cur !== expectEtag) return { ok: false, etag: cur, reason: 'conflict' };
    await this.putBuffer(b, p, opts);
    return { ok: true, etag: await this.etag(p) };
  }

  async delete(p) {
    this._record('delete', [p]);
    this._fault('delete', [p]);
    this.blobs.delete(p);
  }

  async deleteTree(p) {
    this._record('deleteTree', [p]);
    this._fault('deleteTree', [p]);
    for (const k of [...this.blobs.keys()]) {
      if (k === p || k.startsWith(p + '/')) this.blobs.delete(k);
    }
  }

  async rename(a, b) {
    this._record('rename', [a, b]);
    this._fault('rename', [a, b]);
    if (!this.blobs.has(a)) throw new Error('404 ' + a);
    this.blobs.set(b, this.blobs.get(a));
    this.blobs.delete(a);
  }

  async test() {
    this._record('test', []);
    this._fault('test', []);
    return true;
  }

  /** 列出全部对象路径（测试断言用）。 */
  paths() { return [...this.blobs.keys()].sort(); }
}
