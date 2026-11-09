/**
 * dsh-nas-sync · 加密层（0.6.0 / 收尾②：NSS2 + AAD + 流式分块）
 * ------------------------------------------------------------------
 * 两种信封，解密侧永远**双读**：
 *
 *   NSS1（0.5.9 兼容，默认写入）
 *     "NSS1" | salt(16) | nonce(24) | secretbox(mac32+cipher)
 *
 *   NSS2（显式把 envelopeVersion 设为 2 才写入）
 *     "NSS2" | ver(1) | salt(16) | nonce(24) | aadLen(4BE) | aad | secretbox
 *
 * AAD 是「绑定但不保密」的附加认证数据：它写进文件头（明文），同时通过
 * HMAC 密钥分离参与 secretbox 的密钥派生。于是：
 *   · 调用方**不需要**在解密时重新算出同一个 aad —— 从头部读即可。
 *     这一点很关键：跨平台会话落地时 rel 会被改写，若 aad 由调用方按 rel
 *     推算，对端就会永远解不开；
 *   · 任何人篡改头部的 aad / ver / 密文，Poly1305 校验都会失败；
 *   · 同一个口令在不同域（清单 / 文件 / 不同会话）派生出不同子密钥，
 *     一份密文不能挪到另一个 rel 下冒充。
 *
 * 为什么不用 AES-GCM：宿主是 Node/Electron，tweetnacl 已经在依赖里且手机端
 * 表现稳定；secretbox + HMAC 密钥分离在「无外部 AAD 参数的 AEAD」上是标准做法，
 * 不需要新增依赖，也不会改变 NSS1 的既有密文。
 *
 * r2 时期修过的两点仍然保留：salt 固定并写进文件头（跨机可解）、
 * 密钥按 (passphrase,salt) 缓存（scrypt 整个进程只派生一次）。
 * 0.6.0 又补一点：缓存键不再用**明文口令**做 Map key，改成口令的 sha256，
 * 并暴露 clearKeyCache() 供测试 / 修改口令后清缓存。
 */

import nacl from 'tweetnacl';
import { scrypt } from 'scrypt-js';
import { randomBytes, createHmac, createHash } from 'node:crypto';

const SALT_LEN = 16;
const NONCE_LEN = 24;
const MAGIC_V1 = new Uint8Array([0x4e, 0x53, 0x53, 0x31]); // "NSS1"
const MAGIC_V2 = new Uint8Array([0x4e, 0x53, 0x53, 0x32]); // "NSS2"
const MAGIC_CHUNK = new Uint8Array([0x4e, 0x53, 0x53, 0x32, 0x43]); // "NSS2C"
const HEADER_V1_LEN = MAGIC_V1.length + SALT_LEN + NONCE_LEN;
const HEADER_V2_MIN = MAGIC_V2.length + 1 + SALT_LEN + NONCE_LEN + 4;
const MAC_LEN = 16;

/** 信封版本。1 = 0.5.9 兼容格式（默认），2 = 带版本/AAD 的 NSS2。 */
export type EnvelopeVersion = 1 | 2;

export interface EncryptOptions {
  version?: EnvelopeVersion;
  /** 附加认证数据；建议传稳定主键而不是会随落地改写的 rel */
  aad?: string;
}

export interface EnvelopeInfo {
  version: EnvelopeVersion;
  aad: string;
  saltHex: string;
}

/** 已派生主密钥的缓存。键是口令哈希 + salt，绝不存明文口令。 */
const keyCache = new Map<string, Uint8Array>();

export function clearKeyCache(): void {
  keyCache.clear();
}

function cacheKey(passphrase: string, salt: Uint8Array): string {
  const passHash = createHash('sha256').update(passphrase, 'utf8').digest('hex');
  return passHash + '|' + Buffer.from(salt).toString('hex');
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<Uint8Array> {
  const ck = cacheKey(passphrase, salt);
  const hit = keyCache.get(ck);
  if (hit) return hit;
  const key = await scrypt(
    new TextEncoder().encode(passphrase),
    salt,
    32768, 8, 1, 32,
  );
  keyCache.set(ck, key);
  return key;
}

/** 密钥分离：把 AAD / 域 / 序号绑进子密钥，任何改动都会让 MAC 校验失败。 */
function subKey(master: Uint8Array, domain: string, aad: string): Uint8Array {
  return new Uint8Array(
    createHmac('sha256', Buffer.from(master))
      .update('dsh-nas-sync\0' + domain + '\0' + aad, 'utf8')
      .digest(),
  );
}

function writeU32BE(out: Uint8Array, at: number, value: number): void {
  out[at] = (value >>> 24) & 0xff;
  out[at + 1] = (value >>> 16) & 0xff;
  out[at + 2] = (value >>> 8) & 0xff;
  out[at + 3] = value & 0xff;
}

function readU32BE(buf: Uint8Array, at: number): number {
  return ((buf[at] << 24) | (buf[at + 1] << 16) | (buf[at + 2] << 8) | buf[at + 3]) >>> 0;
}

function writeU16BE(out: Uint8Array, at: number, value: number): void {
  out[at] = (value >>> 8) & 0xff;
  out[at + 1] = value & 0xff;
}

function readU16BE(buf: Uint8Array, at: number): number {
  return ((buf[at] << 8) | buf[at + 1]) >>> 0;
}

function matches(blob: Uint8Array, magic: Uint8Array): boolean {
  if (blob.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) if (blob[i] !== magic[i]) return false;
  return true;
}

/** 探测信封版本与 AAD；不是合法信封返回 null（不抛错，便于状态面板显示）。 */
export function envelopeInfo(blob: Uint8Array): EnvelopeInfo | null {
  if (!blob || blob.length < HEADER_V1_LEN + MAC_LEN) return null;
  if (matches(blob, MAGIC_V1)) {
    return {
      version: 1,
      aad: '',
      saltHex: Buffer.from(blob.slice(MAGIC_V1.length, MAGIC_V1.length + SALT_LEN)).toString('hex'),
    };
  }
  if (matches(blob, MAGIC_V2) && blob.length >= HEADER_V2_MIN + MAC_LEN) {
    const at = MAGIC_V2.length + 1 + SALT_LEN + NONCE_LEN;
    const aadLen = readU32BE(blob, at);
    // 防止伪造长度把 slice 指到别的内存 / 产生巨大字符串
    if (aadLen < 0 || aadLen > 4096 || at + 4 + aadLen + MAC_LEN > blob.length) return null;
    const aadBytes = blob.slice(at + 4, at + 4 + aadLen);
    return {
      version: 2,
      aad: new TextDecoder().decode(aadBytes),
      saltHex: Buffer.from(blob.slice(MAGIC_V2.length + 1, MAGIC_V2.length + 1 + SALT_LEN)).toString('hex'),
    };
  }
  return null;
}

export class Crypto {
  /**
   * 加密。默认写 NSS1 —— 升级到 0.6.0 不会让还在跑 0.5.9 的对端读不懂清单。
   * 只有 `envelopeVersion=2` 时引擎才传 `{version:2, aad}` 写 NSS2。
   */
  static async encrypt(
    data: Uint8Array,
    passphrase: string,
    salt: Uint8Array,
    opts: EncryptOptions = {},
  ): Promise<Uint8Array> {
    if (!passphrase) throw new Error('未配置加密口令（设置里填写 passphrase 后重试）');
    if (salt.length !== SALT_LEN) throw new Error('salt 必须是 16 字节');
    const key = await deriveKey(passphrase, salt);
    const nonce = new Uint8Array(randomBytes(NONCE_LEN));

    if ((opts.version ?? 1) === 1) {
      const box = nacl.secretbox(data, nonce, key);
      const out = new Uint8Array(HEADER_V1_LEN + box.length);
      out.set(MAGIC_V1, 0);
      out.set(salt, MAGIC_V1.length);
      out.set(nonce, MAGIC_V1.length + SALT_LEN);
      out.set(box, HEADER_V1_LEN);
      return out;
    }

    const aadBytes = new TextEncoder().encode(String(opts.aad ?? ''));
    if (aadBytes.length > 4096) throw new Error('AAD 过长（上限 4096 字节）');
    const box = nacl.secretbox(data, nonce, subKey(key, 'NSS2', String(opts.aad ?? '')));
    // HEADER_V2_MIN 已含 aadLen 的 4 字节，别再加一次 —— 多出来的 4 个尾随零
    // 会被 secretbox.open 当成密文的一部分，MAC 校验必然失败。
    const head = HEADER_V2_MIN;
    const out = new Uint8Array(head + aadBytes.length + box.length);
    out.set(MAGIC_V2, 0);
    out[MAGIC_V2.length] = 2;
    out.set(salt, MAGIC_V2.length + 1);
    out.set(nonce, MAGIC_V2.length + 1 + SALT_LEN);
    // 帧布局：magic | ver | salt | nonce | aadLen(4) | aad | box
    const lenAt = MAGIC_V2.length + 1 + SALT_LEN + NONCE_LEN;
    const aadAt = head;   // == lenAt + 4
    writeU32BE(out, lenAt, aadBytes.length);
    out.set(aadBytes, aadAt);
    out.set(box, aadAt + aadBytes.length);
    return out;
  }

  /** 便捷入口：显式加密成 NSS2。 */
  static async encryptV2(
    data: Uint8Array, passphrase: string, salt: Uint8Array, aad = '',
  ): Promise<Uint8Array> {
    return Crypto.encrypt(data, passphrase, salt, { version: 2, aad });
  }

  /** 解密 NSS1 / NSS2。AAD 从头部读，调用方不需要（也不应该）再传一遍。 */
  static async decrypt(blob: Uint8Array, passphrase: string): Promise<Uint8Array> {
    if (!passphrase) throw new Error('未配置加密口令（设置里填写 passphrase 后重试）');
    if (matches(blob, MAGIC_V1)) {
      const salt = blob.slice(MAGIC_V1.length, MAGIC_V1.length + SALT_LEN);
      const nonce = blob.slice(MAGIC_V1.length + SALT_LEN, HEADER_V1_LEN);
      const box = blob.slice(HEADER_V1_LEN);
      const key = await deriveKey(passphrase, salt);
      const plain = nacl.secretbox.open(box, nonce, key);
      if (!plain) throw new Error('解密失败：口令错误或文件已损坏（NSS1）');
      return plain;
    }
    if (matches(blob, MAGIC_V2)) {
      const info = envelopeInfo(blob);
      if (!info) throw new Error('NSS2 头损坏（AAD 长度越界或文件被截断）');
      const verAt = MAGIC_V2.length;
      if (blob[verAt] !== 2) throw new Error('不支持的 NSS2 版本：' + blob[verAt]);
      const saltAt = verAt + 1;
      const nonceAt = saltAt + SALT_LEN;
      const lenAt = nonceAt + NONCE_LEN;
      const aadLen = readU32BE(blob, lenAt);
      const aadAt = lenAt + 4;
      const aad = new TextDecoder().decode(blob.slice(aadAt, aadAt + aadLen));
      const salt = blob.slice(saltAt, saltAt + SALT_LEN);
      const nonce = blob.slice(nonceAt, nonceAt + NONCE_LEN);
      const box = blob.slice(aadAt + aadLen);
      const key = await deriveKey(passphrase, salt);
      const plain = nacl.secretbox.open(box, nonce, subKey(key, 'NSS2', aad));
      if (!plain) throw new Error('解密失败：口令错误、AAD 被篡改或文件已损坏（NSS2）');
      return plain;
    }
    throw new Error('不是 NAS 同步的加密文件（缺少 NSS1/NSS2 头）：远端数据可能来自旧版本或已损坏');
  }
}

// ---------------------------------------------------------------------------
// 流式分块加密（0.6.0 / 收尾②）
// ---------------------------------------------------------------------------

/** 一帧自包含：带 salt、序号、final 标志与 baseAad，不依赖跨帧状态即可解开。 */
export interface SealedChunkFrame {
  index: number;
  final: boolean;
  aad: string;
  blob: Uint8Array;
}

const CHUNK_FIXED = MAGIC_CHUNK.length + SALT_LEN + NONCE_LEN + 4 + 1 + 2;

/**
 * 把一串明文块逐块封装。每块单独 secretbox，避免把整个大文件读进内存；
 * 子密钥绑定 `(baseAad, index, final)`，所以重排、复制、截断任意一帧都会被
 * openStream() 拒绝（序号必须严格从 0 递增，且恰好出现一次 final）。
 */
export async function* sealStream(
  source: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  passphrase: string,
  salt: Uint8Array,
  baseAad = '',
): AsyncGenerator<SealedChunkFrame> {
  if (!passphrase) throw new Error('未配置加密口令');
  if (salt.length !== SALT_LEN) throw new Error('salt 必须是 16 字节');
  const key = await deriveKey(passphrase, salt);
  const aadBytes = new TextEncoder().encode(baseAad);
  if (aadBytes.length > 4096) throw new Error('AAD 过长（上限 4096 字节）');
  let index = 0;
  let pending: Uint8Array | null = null;
  let done = false;
  const iter = (source as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]
    ? (source as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
    : (source as Iterable<Uint8Array>)[Symbol.iterator]();

  while (true) {
    let cur: Uint8Array | null = pending;
    pending = null;
    const next = await (iter as AsyncIterator<Uint8Array>).next();
    if (next.done) {
      done = true;
    } else {
      pending = new Uint8Array(next.value);
    }
    if (cur === null) {
      if (done) break;              // 空输入：一帧都不发
      continue;                     // 拿第一块
    }
    const final = done;
    const nonce = new Uint8Array(randomBytes(NONCE_LEN));
    const bound = baseAad + '|' + index + '|' + (final ? 1 : 0);
    const box = nacl.secretbox(cur, nonce, subKey(key, 'NSS2C', bound));
    const out = new Uint8Array(CHUNK_FIXED + aadBytes.length + box.length);
    let at = 0;
    out.set(MAGIC_CHUNK, at); at += MAGIC_CHUNK.length;
    out.set(salt, at); at += SALT_LEN;
    out.set(nonce, at); at += NONCE_LEN;
    writeU32BE(out, at, index); at += 4;
    out[at] = final ? 1 : 0; at += 1;
    writeU16BE(out, at, aadBytes.length); at += 2;
    out.set(aadBytes, at); at += aadBytes.length;
    out.set(box, at);
    yield { index, final, aad: baseAad, blob: out };
    index++;
    if (final) break;
  }
}

/** 解开一串帧；任何序号错乱 / 截断 / 篡改 / 口令错误都抛错，绝不返回半份明文。 */
export async function* openStream(
  frames: Iterable<Uint8Array | SealedChunkFrame> | AsyncIterable<Uint8Array | SealedChunkFrame>,
  passphrase: string,
): AsyncGenerator<Uint8Array> {
  if (!passphrase) throw new Error('未配置加密口令');
  let expect = 0;
  let sawFinal = false;
  const iter = (frames as AsyncIterable<any>)[Symbol.asyncIterator]
    ? (frames as AsyncIterable<any>)[Symbol.asyncIterator]()
    : (frames as Iterable<any>)[Symbol.iterator]();
  for await (const item of iter as AsyncIterable<any>) {
    if (sawFinal) throw new Error('流式解密失败：final 帧之后还有多余帧');
    const blob: Uint8Array = item instanceof Uint8Array ? item : item?.blob;
    if (!blob || !matches(blob, MAGIC_CHUNK) || blob.length < CHUNK_FIXED + MAC_LEN) {
      throw new Error('流式解密失败：不是合法的 NSS2C 帧');
    }
    let at = MAGIC_CHUNK.length;
    const salt = blob.slice(at, at + SALT_LEN); at += SALT_LEN;
    const nonce = blob.slice(at, at + NONCE_LEN); at += NONCE_LEN;
    const index = readU32BE(blob, at); at += 4;
    const finalFlag = blob[at]; at += 1;
    const aadLen = readU16BE(blob, at); at += 2;
    if (index !== expect) {
      throw new Error(`流式解密失败：帧序号不连续（期望 ${expect}，实际 ${index}）`);
    }
    if (aadLen > 4096 || at + aadLen + MAC_LEN > blob.length) {
      throw new Error('流式解密失败：AAD 长度越界或帧被截断');
    }
    const baseAad = new TextDecoder().decode(blob.slice(at, at + aadLen)); at += aadLen;
    const box = blob.slice(at);
    if (finalFlag !== 0 && finalFlag !== 1) throw new Error('流式解密失败：非法 final 标志');
    const key = await deriveKey(passphrase, salt);
    const bound = baseAad + '|' + index + '|' + finalFlag;
    const plain = nacl.secretbox.open(box, nonce, subKey(key, 'NSS2C', bound));
    if (!plain) throw new Error('流式解密失败：口令错误或第 ' + index + ' 帧被篡改');
    yield plain;
    if (finalFlag === 1) sawFinal = true;
    expect++;
  }
  if (!sawFinal && expect > 0) throw new Error('流式解密失败：缺少 final 帧（数据被截断）');
}
