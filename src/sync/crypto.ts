/**
 * dsh-nas-sync · 加密层
 * ----------------------
 * 方案：scrypt 派生 32 字节密钥 -> NaCl secretbox (XSalsa20-Poly1305) 加密
 *      -> HMAC 已内置于 secretbox，此处再对密文做一次 hash 作为防篡改校验
 *        与传输完整性双重保险。
 *
 * 格式：salt(16) | nonce(24) | mac(32) | ciphertext
 */

import nacl from 'tweetnacl';
import scrypt from 'scrypt-js';
import { randomBytes, createHash } from 'node:crypto';

const SALT_LEN = 16;
const NONCE_LEN = 24;
const MAC_LEN = 32;

export class Crypto {
  static async deriveKey(passphrase: string, salt: Uint8Array): Promise<Uint8Array> {
    return scrypt.scrypt(
      Buffer.from(passphrase, 'utf-8'),
      salt,
      32768,
      8,
      1,
      32,
    );
  }

  static async encrypt(data: Uint8Array, passphrase: string): Promise<Uint8Array> {
    if (!passphrase) throw new Error('未配置加密口令，无法加密');
    const salt = randomBytes(SALT_LEN);
    const nonce = randomBytes(NONCE_LEN);
    const key = await Crypto.deriveKey(passphrase, salt);
    const cipher = nacl.secretbox(data, nonce, key);
    const mac = createHash('sha256').update(cipher).digest();
    const out = new Uint8Array(SALT_LEN + NONCE_LEN + MAC_LEN + cipher.length);
    out.set(salt, 0);
    out.set(nonce, SALT_LEN);
    out.set(mac, SALT_LEN + NONCE_LEN);
    out.set(cipher, SALT_LEN + NONCE_LEN + MAC_LEN);
    return out;
  }

  static async decrypt(blob: Uint8Array, passphrase: string): Promise<Uint8Array> {
    if (blob.length < SALT_LEN + NONCE_LEN + MAC_LEN + 1) {
      throw new Error('加密数据格式错误');
    }
    const salt = blob.slice(0, SALT_LEN);
    const nonce = blob.slice(SALT_LEN, SALT_LEN + NONCE_LEN);
    const mac = blob.slice(SALT_LEN + NONCE_LEN, SALT_LEN + NONCE_LEN + MAC_LEN);
    const cipher = blob.slice(SALT_LEN + NONCE_LEN + MAC_LEN);

    const expected = createHash('sha256').update(cipher).digest();
    if (!nacl.verify(mac, expected)) {
      throw new Error('数据校验失败：口令错误或文件已损坏');
    }

    const key = await Crypto.deriveKey(passphrase, salt);
    const plain = nacl.secretbox.open(cipher, nonce, key);
    if (!plain) throw new Error('解密失败，请检查加密口令');
    return plain;
  }
}
