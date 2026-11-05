/**
 * dsh-nas-sync · 加密层（r2 重写）
 * ----------------------------------
 * 格式：magic "NSS1"(4) | salt(16) | nonce(24) | secretbox(mac32+cipher)
 *
 * r1 的两个致命问题已修：
 *   1. scrypt N=32768 每文件派生一次 → 手机上每个文件卡 1~2 秒。
 *      现在 salt 固定（存 Store 并写入文件头），密钥按 (passphrase,salt) 缓存，
 *      整个进程只派生一次。
 *   2. salt 原来只存本地 → 换机器无法解密。现在 salt 进文件头，跨机可恢复。
 *
 * secretbox 自带 Poly1305 MAC（encrypt-then-MAC 语义）；
 * 文件头 magic 用于区分「未加密残留 / 格式错误」并给出可读错误。
 */

import nacl from 'tweetnacl';
import { scrypt } from 'scrypt-js';
import { randomBytes } from 'node:crypto';

const SALT_LEN = 16;
const NONCE_LEN = 24;
const MAGIC = new Uint8Array([0x4e, 0x53, 0x53, 0x31]); // "NSS1"
const HEADER_LEN = MAGIC.length + SALT_LEN + NONCE_LEN;

const keyCache = new Map<string, Uint8Array>();

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<Uint8Array> {
  const cacheKey = passphrase + '|' + Buffer.from(salt).toString('hex');
  const hit = keyCache.get(cacheKey);
  if (hit) return hit;
  const key = await scrypt(
    new TextEncoder().encode(passphrase),
    salt,
    32768, 8, 1, 32,
  );
  keyCache.set(cacheKey, key);
  return key;
}

function isEncrypted(blob: Uint8Array): boolean {
  if (blob.length < HEADER_LEN + 16) return false;   // 16 = secretbox MAC
  for (let i = 0; i < MAGIC.length; i++) {
    if (blob[i] !== MAGIC[i]) return false;
  }
  return true;
}

export class Crypto {
  static async encrypt(data: Uint8Array, passphrase: string, salt: Uint8Array): Promise<Uint8Array> {
    if (!passphrase) throw new Error('未配置加密口令（设置里填写 passphrase 后重试）');
    const key = await deriveKey(passphrase, salt);
    const nonce = randomBytes(NONCE_LEN);
    const box = nacl.secretbox(data, nonce, key);
    const out = new Uint8Array(HEADER_LEN + box.length);
    out.set(MAGIC, 0);
    out.set(salt, MAGIC.length);
    out.set(nonce, MAGIC.length + SALT_LEN);
    out.set(box, HEADER_LEN);
    return out;
  }

  static async decrypt(blob: Uint8Array, passphrase: string): Promise<Uint8Array> {
    if (!isEncrypted(blob)) {
      throw new Error('不是 NAS 同步的加密文件（缺少 NSS1 头）：远端数据可能来自旧版本或已损坏');
    }
    const salt = blob.slice(MAGIC.length, MAGIC.length + SALT_LEN);
    const nonce = blob.slice(MAGIC.length + SALT_LEN, HEADER_LEN);
    const box = blob.slice(HEADER_LEN);
    const key = await deriveKey(passphrase, salt);
    const plain = nacl.secretbox.open(box, nonce, key);
    if (!plain) throw new Error('解密失败：口令错误或文件已损坏');
    return plain;
  }
}
