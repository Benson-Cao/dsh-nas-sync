/**
 * 0.6.0 / 收尾②：NSS2 信封、AAD 绑定、流式分块加密。
 * 重点不是「能加解密」，而是「篡改/重排/截断一定被检测到」以及
 * 「NSS1 历史密文在开启 v2 后仍然可读」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  Crypto, envelopeInfo, sealStream, openStream, clearKeyCache,
} = await import('../dist-test/crypto.mjs');

const PASS = 'crypto-test-pass';
const SALT = Buffer.alloc(16, 3);
const DATA = new TextEncoder().encode('会话正文：中文 + emoji 🧪 + \0 字节');

async function collect(gen) {
  const out = [];
  for await (const x of gen) out.push(x);
  return out;
}

test('NSS1 仍是默认写入格式，且与 0.5.9 的双读兼容', async () => {
  const enc = await Crypto.encrypt(DATA, PASS, SALT);
  assert.equal(new TextDecoder().decode(enc.slice(0, 4)), 'NSS1');
  assert.deepEqual(await Crypto.decrypt(enc, PASS), DATA);
  assert.equal(envelopeInfo(enc).version, 1);
  assert.equal(envelopeInfo(enc).aad, '');
  assert.equal(envelopeInfo(enc).saltHex, SALT.toString('hex'));
});

test('NSS2 往返，头部可读出版本与 AAD', async () => {
  const aad = 'dsh-nas-sync|session:sid-123';
  const enc = await Crypto.encryptV2(DATA, PASS, SALT, aad);
  assert.equal(new TextDecoder().decode(enc.slice(0, 4)), 'NSS2');
  const info = envelopeInfo(enc);
  assert.equal(info.version, 2);
  assert.equal(info.aad, aad);
  assert.equal(info.saltHex, SALT.toString('hex'));
  assert.deepEqual(await Crypto.decrypt(enc, PASS), DATA, '解密不需要调用方传 aad');
});

test('双读：同一个口令下 NSS1 与 NSS2 密文都能解开', async () => {
  const a = await Crypto.encrypt(DATA, PASS, SALT);
  const b = await Crypto.encryptV2(DATA, PASS, SALT, 'manifest');
  assert.deepEqual(await Crypto.decrypt(a, PASS), DATA);
  assert.deepEqual(await Crypto.decrypt(b, PASS), DATA);
  clearKeyCache();
  assert.deepEqual(await Crypto.decrypt(b, PASS), DATA, '清缓存后仍可解');
});

test('AAD 参与密钥分离：同明文不同 AAD 密文不同，篡改 AAD 必失败', async () => {
  const a = await Crypto.encryptV2(DATA, PASS, SALT, 'rel:attachments/a.txt');
  const b = await Crypto.encryptV2(DATA, PASS, SALT, 'rel:attachments/b.txt');
  assert.notDeepEqual(a, b);

  const tampered = Uint8Array.from(a);
  // AAD 起始偏移：magic4 + ver1 + salt16 + nonce24 + len4 = 49
  tampered[49] = tampered[49] === 0x61 ? 0x62 : 0x61;
  await assert.rejects(() => Crypto.decrypt(tampered, PASS), /解密失败|头损坏/);
});

test('口令错误 / 密文损坏 / 非法头部都给出可读错误', async () => {
  const enc = await Crypto.encryptV2(DATA, PASS, SALT, 'x');
  await assert.rejects(() => Crypto.decrypt(enc, 'wrong-pass'), /解密失败/);
  await assert.rejects(() => Crypto.decrypt(new Uint8Array([1, 2, 3]), PASS), /缺少 NSS1\/NSS2 头/);
  const cut = Uint8Array.from(enc.slice(0, 60));
  await assert.rejects(() => Crypto.decrypt(cut, PASS), /损坏|头损坏|解密失败/);
});

test('sealStream/openStream 多块往返，顺序与内容完全一致', async () => {
  const parts = [
    new TextEncoder().encode('第一块'),
    new Uint8Array([0, 1, 2, 255]),
    new TextEncoder().encode('第三块，稍长一点，用来验证边界'),
  ];
  const frames = await collect(sealStream(parts, PASS, SALT, 'file:big.bin'));
  assert.equal(frames.length, 3);
  assert.deepEqual(frames.map((f) => f.index), [0, 1, 2]);
  assert.deepEqual(frames.map((f) => f.final), [false, false, true]);
  const plain = await collect(openStream(frames.map((f) => f.blob), PASS));
  assert.equal(plain.length, 3);
  for (let i = 0; i < parts.length; i++) assert.deepEqual(plain[i], parts[i]);
});

test('重排 / 截断 / 多余帧 / 篡改任意一帧都会被拒绝', async () => {
  const parts = [new TextEncoder().encode('A'), new TextEncoder().encode('B'), new TextEncoder().encode('C')];
  const frames = (await collect(sealStream(parts, PASS, SALT, 'x'))).map((f) => f.blob);

  await assert.rejects(
    async () => collect(openStream([frames[0], frames[2], frames[1]], PASS)),
    /序号不连续/,
  );
  await assert.rejects(
    async () => collect(openStream(frames.slice(0, 2), PASS)),
    /缺少 final 帧/,
  );
  await assert.rejects(
    async () => collect(openStream([...frames, frames[2]], PASS)),
    /final 帧之后还有多余帧/,
  );
  const bad = Uint8Array.from(frames[1]);
  bad[bad.length - 1] ^= 0x01;
  await assert.rejects(
    async () => collect(openStream([frames[0], bad, frames[2]], PASS)),
    /篡改/,
  );
});

test('空输入不产生帧，openStream 也不报错', async () => {
  const frames = await collect(sealStream([], PASS, SALT));
  assert.equal(frames.length, 0);
  const out = await collect(openStream([], PASS));
  assert.equal(out.length, 0);
});

test('流式帧的 AAD 绑定 baseAad：改帧内 AAD 会导致 MAC 失败', async () => {
  const frames = (await collect(sealStream([new TextEncoder().encode('payload')], PASS, SALT, 'abc'))).map((f) => f.blob);
  const bad = Uint8Array.from(frames[0]);
  // AAD 起始偏移：magic5 + salt16 + nonce24 + index4 + final1 + len2 = 52
  bad[52] = bad[52] === 0x61 ? 0x7a : 0x61;
  await assert.rejects(async () => collect(openStream([bad], PASS)), /篡改/);
});
