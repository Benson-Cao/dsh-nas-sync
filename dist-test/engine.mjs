var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __commonJS = (cb, mod) => function __require2() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// ../../dsh-nas-sync/node_modules/tweetnacl/nacl-fast.js
var require_nacl_fast = __commonJS({
  "../../dsh-nas-sync/node_modules/tweetnacl/nacl-fast.js"(exports, module) {
    (function(nacl2) {
      "use strict";
      var gf = function(init) {
        var i, r = new Float64Array(16);
        if (init) for (i = 0; i < init.length; i++) r[i] = init[i];
        return r;
      };
      var randombytes = function() {
        throw new Error("no PRNG");
      };
      var _0 = new Uint8Array(16);
      var _9 = new Uint8Array(32);
      _9[0] = 9;
      var gf0 = gf(), gf1 = gf([1]), _121665 = gf([56129, 1]), D = gf([30883, 4953, 19914, 30187, 55467, 16705, 2637, 112, 59544, 30585, 16505, 36039, 65139, 11119, 27886, 20995]), D2 = gf([61785, 9906, 39828, 60374, 45398, 33411, 5274, 224, 53552, 61171, 33010, 6542, 64743, 22239, 55772, 9222]), X = gf([54554, 36645, 11616, 51542, 42930, 38181, 51040, 26924, 56412, 64982, 57905, 49316, 21502, 52590, 14035, 8553]), Y = gf([26200, 26214, 26214, 26214, 26214, 26214, 26214, 26214, 26214, 26214, 26214, 26214, 26214, 26214, 26214, 26214]), I = gf([41136, 18958, 6951, 50414, 58488, 44335, 6150, 12099, 55207, 15867, 153, 11085, 57099, 20417, 9344, 11139]);
      function ts64(x, i, h, l) {
        x[i] = h >> 24 & 255;
        x[i + 1] = h >> 16 & 255;
        x[i + 2] = h >> 8 & 255;
        x[i + 3] = h & 255;
        x[i + 4] = l >> 24 & 255;
        x[i + 5] = l >> 16 & 255;
        x[i + 6] = l >> 8 & 255;
        x[i + 7] = l & 255;
      }
      function vn(x, xi, y, yi, n) {
        var i, d = 0;
        for (i = 0; i < n; i++) d |= x[xi + i] ^ y[yi + i];
        return (1 & d - 1 >>> 8) - 1;
      }
      function crypto_verify_16(x, xi, y, yi) {
        return vn(x, xi, y, yi, 16);
      }
      function crypto_verify_32(x, xi, y, yi) {
        return vn(x, xi, y, yi, 32);
      }
      function core_salsa20(o, p, k, c) {
        var j0 = c[0] & 255 | (c[1] & 255) << 8 | (c[2] & 255) << 16 | (c[3] & 255) << 24, j1 = k[0] & 255 | (k[1] & 255) << 8 | (k[2] & 255) << 16 | (k[3] & 255) << 24, j2 = k[4] & 255 | (k[5] & 255) << 8 | (k[6] & 255) << 16 | (k[7] & 255) << 24, j3 = k[8] & 255 | (k[9] & 255) << 8 | (k[10] & 255) << 16 | (k[11] & 255) << 24, j4 = k[12] & 255 | (k[13] & 255) << 8 | (k[14] & 255) << 16 | (k[15] & 255) << 24, j5 = c[4] & 255 | (c[5] & 255) << 8 | (c[6] & 255) << 16 | (c[7] & 255) << 24, j6 = p[0] & 255 | (p[1] & 255) << 8 | (p[2] & 255) << 16 | (p[3] & 255) << 24, j7 = p[4] & 255 | (p[5] & 255) << 8 | (p[6] & 255) << 16 | (p[7] & 255) << 24, j8 = p[8] & 255 | (p[9] & 255) << 8 | (p[10] & 255) << 16 | (p[11] & 255) << 24, j9 = p[12] & 255 | (p[13] & 255) << 8 | (p[14] & 255) << 16 | (p[15] & 255) << 24, j10 = c[8] & 255 | (c[9] & 255) << 8 | (c[10] & 255) << 16 | (c[11] & 255) << 24, j11 = k[16] & 255 | (k[17] & 255) << 8 | (k[18] & 255) << 16 | (k[19] & 255) << 24, j12 = k[20] & 255 | (k[21] & 255) << 8 | (k[22] & 255) << 16 | (k[23] & 255) << 24, j13 = k[24] & 255 | (k[25] & 255) << 8 | (k[26] & 255) << 16 | (k[27] & 255) << 24, j14 = k[28] & 255 | (k[29] & 255) << 8 | (k[30] & 255) << 16 | (k[31] & 255) << 24, j15 = c[12] & 255 | (c[13] & 255) << 8 | (c[14] & 255) << 16 | (c[15] & 255) << 24;
        var x0 = j0, x1 = j1, x2 = j2, x3 = j3, x4 = j4, x5 = j5, x6 = j6, x7 = j7, x8 = j8, x9 = j9, x10 = j10, x11 = j11, x12 = j12, x13 = j13, x14 = j14, x15 = j15, u;
        for (var i = 0; i < 20; i += 2) {
          u = x0 + x12 | 0;
          x4 ^= u << 7 | u >>> 32 - 7;
          u = x4 + x0 | 0;
          x8 ^= u << 9 | u >>> 32 - 9;
          u = x8 + x4 | 0;
          x12 ^= u << 13 | u >>> 32 - 13;
          u = x12 + x8 | 0;
          x0 ^= u << 18 | u >>> 32 - 18;
          u = x5 + x1 | 0;
          x9 ^= u << 7 | u >>> 32 - 7;
          u = x9 + x5 | 0;
          x13 ^= u << 9 | u >>> 32 - 9;
          u = x13 + x9 | 0;
          x1 ^= u << 13 | u >>> 32 - 13;
          u = x1 + x13 | 0;
          x5 ^= u << 18 | u >>> 32 - 18;
          u = x10 + x6 | 0;
          x14 ^= u << 7 | u >>> 32 - 7;
          u = x14 + x10 | 0;
          x2 ^= u << 9 | u >>> 32 - 9;
          u = x2 + x14 | 0;
          x6 ^= u << 13 | u >>> 32 - 13;
          u = x6 + x2 | 0;
          x10 ^= u << 18 | u >>> 32 - 18;
          u = x15 + x11 | 0;
          x3 ^= u << 7 | u >>> 32 - 7;
          u = x3 + x15 | 0;
          x7 ^= u << 9 | u >>> 32 - 9;
          u = x7 + x3 | 0;
          x11 ^= u << 13 | u >>> 32 - 13;
          u = x11 + x7 | 0;
          x15 ^= u << 18 | u >>> 32 - 18;
          u = x0 + x3 | 0;
          x1 ^= u << 7 | u >>> 32 - 7;
          u = x1 + x0 | 0;
          x2 ^= u << 9 | u >>> 32 - 9;
          u = x2 + x1 | 0;
          x3 ^= u << 13 | u >>> 32 - 13;
          u = x3 + x2 | 0;
          x0 ^= u << 18 | u >>> 32 - 18;
          u = x5 + x4 | 0;
          x6 ^= u << 7 | u >>> 32 - 7;
          u = x6 + x5 | 0;
          x7 ^= u << 9 | u >>> 32 - 9;
          u = x7 + x6 | 0;
          x4 ^= u << 13 | u >>> 32 - 13;
          u = x4 + x7 | 0;
          x5 ^= u << 18 | u >>> 32 - 18;
          u = x10 + x9 | 0;
          x11 ^= u << 7 | u >>> 32 - 7;
          u = x11 + x10 | 0;
          x8 ^= u << 9 | u >>> 32 - 9;
          u = x8 + x11 | 0;
          x9 ^= u << 13 | u >>> 32 - 13;
          u = x9 + x8 | 0;
          x10 ^= u << 18 | u >>> 32 - 18;
          u = x15 + x14 | 0;
          x12 ^= u << 7 | u >>> 32 - 7;
          u = x12 + x15 | 0;
          x13 ^= u << 9 | u >>> 32 - 9;
          u = x13 + x12 | 0;
          x14 ^= u << 13 | u >>> 32 - 13;
          u = x14 + x13 | 0;
          x15 ^= u << 18 | u >>> 32 - 18;
        }
        x0 = x0 + j0 | 0;
        x1 = x1 + j1 | 0;
        x2 = x2 + j2 | 0;
        x3 = x3 + j3 | 0;
        x4 = x4 + j4 | 0;
        x5 = x5 + j5 | 0;
        x6 = x6 + j6 | 0;
        x7 = x7 + j7 | 0;
        x8 = x8 + j8 | 0;
        x9 = x9 + j9 | 0;
        x10 = x10 + j10 | 0;
        x11 = x11 + j11 | 0;
        x12 = x12 + j12 | 0;
        x13 = x13 + j13 | 0;
        x14 = x14 + j14 | 0;
        x15 = x15 + j15 | 0;
        o[0] = x0 >>> 0 & 255;
        o[1] = x0 >>> 8 & 255;
        o[2] = x0 >>> 16 & 255;
        o[3] = x0 >>> 24 & 255;
        o[4] = x1 >>> 0 & 255;
        o[5] = x1 >>> 8 & 255;
        o[6] = x1 >>> 16 & 255;
        o[7] = x1 >>> 24 & 255;
        o[8] = x2 >>> 0 & 255;
        o[9] = x2 >>> 8 & 255;
        o[10] = x2 >>> 16 & 255;
        o[11] = x2 >>> 24 & 255;
        o[12] = x3 >>> 0 & 255;
        o[13] = x3 >>> 8 & 255;
        o[14] = x3 >>> 16 & 255;
        o[15] = x3 >>> 24 & 255;
        o[16] = x4 >>> 0 & 255;
        o[17] = x4 >>> 8 & 255;
        o[18] = x4 >>> 16 & 255;
        o[19] = x4 >>> 24 & 255;
        o[20] = x5 >>> 0 & 255;
        o[21] = x5 >>> 8 & 255;
        o[22] = x5 >>> 16 & 255;
        o[23] = x5 >>> 24 & 255;
        o[24] = x6 >>> 0 & 255;
        o[25] = x6 >>> 8 & 255;
        o[26] = x6 >>> 16 & 255;
        o[27] = x6 >>> 24 & 255;
        o[28] = x7 >>> 0 & 255;
        o[29] = x7 >>> 8 & 255;
        o[30] = x7 >>> 16 & 255;
        o[31] = x7 >>> 24 & 255;
        o[32] = x8 >>> 0 & 255;
        o[33] = x8 >>> 8 & 255;
        o[34] = x8 >>> 16 & 255;
        o[35] = x8 >>> 24 & 255;
        o[36] = x9 >>> 0 & 255;
        o[37] = x9 >>> 8 & 255;
        o[38] = x9 >>> 16 & 255;
        o[39] = x9 >>> 24 & 255;
        o[40] = x10 >>> 0 & 255;
        o[41] = x10 >>> 8 & 255;
        o[42] = x10 >>> 16 & 255;
        o[43] = x10 >>> 24 & 255;
        o[44] = x11 >>> 0 & 255;
        o[45] = x11 >>> 8 & 255;
        o[46] = x11 >>> 16 & 255;
        o[47] = x11 >>> 24 & 255;
        o[48] = x12 >>> 0 & 255;
        o[49] = x12 >>> 8 & 255;
        o[50] = x12 >>> 16 & 255;
        o[51] = x12 >>> 24 & 255;
        o[52] = x13 >>> 0 & 255;
        o[53] = x13 >>> 8 & 255;
        o[54] = x13 >>> 16 & 255;
        o[55] = x13 >>> 24 & 255;
        o[56] = x14 >>> 0 & 255;
        o[57] = x14 >>> 8 & 255;
        o[58] = x14 >>> 16 & 255;
        o[59] = x14 >>> 24 & 255;
        o[60] = x15 >>> 0 & 255;
        o[61] = x15 >>> 8 & 255;
        o[62] = x15 >>> 16 & 255;
        o[63] = x15 >>> 24 & 255;
      }
      function core_hsalsa20(o, p, k, c) {
        var j0 = c[0] & 255 | (c[1] & 255) << 8 | (c[2] & 255) << 16 | (c[3] & 255) << 24, j1 = k[0] & 255 | (k[1] & 255) << 8 | (k[2] & 255) << 16 | (k[3] & 255) << 24, j2 = k[4] & 255 | (k[5] & 255) << 8 | (k[6] & 255) << 16 | (k[7] & 255) << 24, j3 = k[8] & 255 | (k[9] & 255) << 8 | (k[10] & 255) << 16 | (k[11] & 255) << 24, j4 = k[12] & 255 | (k[13] & 255) << 8 | (k[14] & 255) << 16 | (k[15] & 255) << 24, j5 = c[4] & 255 | (c[5] & 255) << 8 | (c[6] & 255) << 16 | (c[7] & 255) << 24, j6 = p[0] & 255 | (p[1] & 255) << 8 | (p[2] & 255) << 16 | (p[3] & 255) << 24, j7 = p[4] & 255 | (p[5] & 255) << 8 | (p[6] & 255) << 16 | (p[7] & 255) << 24, j8 = p[8] & 255 | (p[9] & 255) << 8 | (p[10] & 255) << 16 | (p[11] & 255) << 24, j9 = p[12] & 255 | (p[13] & 255) << 8 | (p[14] & 255) << 16 | (p[15] & 255) << 24, j10 = c[8] & 255 | (c[9] & 255) << 8 | (c[10] & 255) << 16 | (c[11] & 255) << 24, j11 = k[16] & 255 | (k[17] & 255) << 8 | (k[18] & 255) << 16 | (k[19] & 255) << 24, j12 = k[20] & 255 | (k[21] & 255) << 8 | (k[22] & 255) << 16 | (k[23] & 255) << 24, j13 = k[24] & 255 | (k[25] & 255) << 8 | (k[26] & 255) << 16 | (k[27] & 255) << 24, j14 = k[28] & 255 | (k[29] & 255) << 8 | (k[30] & 255) << 16 | (k[31] & 255) << 24, j15 = c[12] & 255 | (c[13] & 255) << 8 | (c[14] & 255) << 16 | (c[15] & 255) << 24;
        var x0 = j0, x1 = j1, x2 = j2, x3 = j3, x4 = j4, x5 = j5, x6 = j6, x7 = j7, x8 = j8, x9 = j9, x10 = j10, x11 = j11, x12 = j12, x13 = j13, x14 = j14, x15 = j15, u;
        for (var i = 0; i < 20; i += 2) {
          u = x0 + x12 | 0;
          x4 ^= u << 7 | u >>> 32 - 7;
          u = x4 + x0 | 0;
          x8 ^= u << 9 | u >>> 32 - 9;
          u = x8 + x4 | 0;
          x12 ^= u << 13 | u >>> 32 - 13;
          u = x12 + x8 | 0;
          x0 ^= u << 18 | u >>> 32 - 18;
          u = x5 + x1 | 0;
          x9 ^= u << 7 | u >>> 32 - 7;
          u = x9 + x5 | 0;
          x13 ^= u << 9 | u >>> 32 - 9;
          u = x13 + x9 | 0;
          x1 ^= u << 13 | u >>> 32 - 13;
          u = x1 + x13 | 0;
          x5 ^= u << 18 | u >>> 32 - 18;
          u = x10 + x6 | 0;
          x14 ^= u << 7 | u >>> 32 - 7;
          u = x14 + x10 | 0;
          x2 ^= u << 9 | u >>> 32 - 9;
          u = x2 + x14 | 0;
          x6 ^= u << 13 | u >>> 32 - 13;
          u = x6 + x2 | 0;
          x10 ^= u << 18 | u >>> 32 - 18;
          u = x15 + x11 | 0;
          x3 ^= u << 7 | u >>> 32 - 7;
          u = x3 + x15 | 0;
          x7 ^= u << 9 | u >>> 32 - 9;
          u = x7 + x3 | 0;
          x11 ^= u << 13 | u >>> 32 - 13;
          u = x11 + x7 | 0;
          x15 ^= u << 18 | u >>> 32 - 18;
          u = x0 + x3 | 0;
          x1 ^= u << 7 | u >>> 32 - 7;
          u = x1 + x0 | 0;
          x2 ^= u << 9 | u >>> 32 - 9;
          u = x2 + x1 | 0;
          x3 ^= u << 13 | u >>> 32 - 13;
          u = x3 + x2 | 0;
          x0 ^= u << 18 | u >>> 32 - 18;
          u = x5 + x4 | 0;
          x6 ^= u << 7 | u >>> 32 - 7;
          u = x6 + x5 | 0;
          x7 ^= u << 9 | u >>> 32 - 9;
          u = x7 + x6 | 0;
          x4 ^= u << 13 | u >>> 32 - 13;
          u = x4 + x7 | 0;
          x5 ^= u << 18 | u >>> 32 - 18;
          u = x10 + x9 | 0;
          x11 ^= u << 7 | u >>> 32 - 7;
          u = x11 + x10 | 0;
          x8 ^= u << 9 | u >>> 32 - 9;
          u = x8 + x11 | 0;
          x9 ^= u << 13 | u >>> 32 - 13;
          u = x9 + x8 | 0;
          x10 ^= u << 18 | u >>> 32 - 18;
          u = x15 + x14 | 0;
          x12 ^= u << 7 | u >>> 32 - 7;
          u = x12 + x15 | 0;
          x13 ^= u << 9 | u >>> 32 - 9;
          u = x13 + x12 | 0;
          x14 ^= u << 13 | u >>> 32 - 13;
          u = x14 + x13 | 0;
          x15 ^= u << 18 | u >>> 32 - 18;
        }
        o[0] = x0 >>> 0 & 255;
        o[1] = x0 >>> 8 & 255;
        o[2] = x0 >>> 16 & 255;
        o[3] = x0 >>> 24 & 255;
        o[4] = x5 >>> 0 & 255;
        o[5] = x5 >>> 8 & 255;
        o[6] = x5 >>> 16 & 255;
        o[7] = x5 >>> 24 & 255;
        o[8] = x10 >>> 0 & 255;
        o[9] = x10 >>> 8 & 255;
        o[10] = x10 >>> 16 & 255;
        o[11] = x10 >>> 24 & 255;
        o[12] = x15 >>> 0 & 255;
        o[13] = x15 >>> 8 & 255;
        o[14] = x15 >>> 16 & 255;
        o[15] = x15 >>> 24 & 255;
        o[16] = x6 >>> 0 & 255;
        o[17] = x6 >>> 8 & 255;
        o[18] = x6 >>> 16 & 255;
        o[19] = x6 >>> 24 & 255;
        o[20] = x7 >>> 0 & 255;
        o[21] = x7 >>> 8 & 255;
        o[22] = x7 >>> 16 & 255;
        o[23] = x7 >>> 24 & 255;
        o[24] = x8 >>> 0 & 255;
        o[25] = x8 >>> 8 & 255;
        o[26] = x8 >>> 16 & 255;
        o[27] = x8 >>> 24 & 255;
        o[28] = x9 >>> 0 & 255;
        o[29] = x9 >>> 8 & 255;
        o[30] = x9 >>> 16 & 255;
        o[31] = x9 >>> 24 & 255;
      }
      function crypto_core_salsa20(out, inp, k, c) {
        core_salsa20(out, inp, k, c);
      }
      function crypto_core_hsalsa20(out, inp, k, c) {
        core_hsalsa20(out, inp, k, c);
      }
      var sigma = new Uint8Array([101, 120, 112, 97, 110, 100, 32, 51, 50, 45, 98, 121, 116, 101, 32, 107]);
      function crypto_stream_salsa20_xor(c, cpos, m, mpos, b, n, k) {
        var z2 = new Uint8Array(16), x = new Uint8Array(64);
        var u, i;
        for (i = 0; i < 16; i++) z2[i] = 0;
        for (i = 0; i < 8; i++) z2[i] = n[i];
        while (b >= 64) {
          crypto_core_salsa20(x, z2, k, sigma);
          for (i = 0; i < 64; i++) c[cpos + i] = m[mpos + i] ^ x[i];
          u = 1;
          for (i = 8; i < 16; i++) {
            u = u + (z2[i] & 255) | 0;
            z2[i] = u & 255;
            u >>>= 8;
          }
          b -= 64;
          cpos += 64;
          mpos += 64;
        }
        if (b > 0) {
          crypto_core_salsa20(x, z2, k, sigma);
          for (i = 0; i < b; i++) c[cpos + i] = m[mpos + i] ^ x[i];
        }
        return 0;
      }
      function crypto_stream_salsa20(c, cpos, b, n, k) {
        var z2 = new Uint8Array(16), x = new Uint8Array(64);
        var u, i;
        for (i = 0; i < 16; i++) z2[i] = 0;
        for (i = 0; i < 8; i++) z2[i] = n[i];
        while (b >= 64) {
          crypto_core_salsa20(x, z2, k, sigma);
          for (i = 0; i < 64; i++) c[cpos + i] = x[i];
          u = 1;
          for (i = 8; i < 16; i++) {
            u = u + (z2[i] & 255) | 0;
            z2[i] = u & 255;
            u >>>= 8;
          }
          b -= 64;
          cpos += 64;
        }
        if (b > 0) {
          crypto_core_salsa20(x, z2, k, sigma);
          for (i = 0; i < b; i++) c[cpos + i] = x[i];
        }
        return 0;
      }
      function crypto_stream(c, cpos, d, n, k) {
        var s = new Uint8Array(32);
        crypto_core_hsalsa20(s, n, k, sigma);
        var sn = new Uint8Array(8);
        for (var i = 0; i < 8; i++) sn[i] = n[i + 16];
        return crypto_stream_salsa20(c, cpos, d, sn, s);
      }
      function crypto_stream_xor(c, cpos, m, mpos, d, n, k) {
        var s = new Uint8Array(32);
        crypto_core_hsalsa20(s, n, k, sigma);
        var sn = new Uint8Array(8);
        for (var i = 0; i < 8; i++) sn[i] = n[i + 16];
        return crypto_stream_salsa20_xor(c, cpos, m, mpos, d, sn, s);
      }
      var poly1305 = function(key) {
        this.buffer = new Uint8Array(16);
        this.r = new Uint16Array(10);
        this.h = new Uint16Array(10);
        this.pad = new Uint16Array(8);
        this.leftover = 0;
        this.fin = 0;
        var t0, t1, t2, t3, t4, t5, t6, t7;
        t0 = key[0] & 255 | (key[1] & 255) << 8;
        this.r[0] = t0 & 8191;
        t1 = key[2] & 255 | (key[3] & 255) << 8;
        this.r[1] = (t0 >>> 13 | t1 << 3) & 8191;
        t2 = key[4] & 255 | (key[5] & 255) << 8;
        this.r[2] = (t1 >>> 10 | t2 << 6) & 7939;
        t3 = key[6] & 255 | (key[7] & 255) << 8;
        this.r[3] = (t2 >>> 7 | t3 << 9) & 8191;
        t4 = key[8] & 255 | (key[9] & 255) << 8;
        this.r[4] = (t3 >>> 4 | t4 << 12) & 255;
        this.r[5] = t4 >>> 1 & 8190;
        t5 = key[10] & 255 | (key[11] & 255) << 8;
        this.r[6] = (t4 >>> 14 | t5 << 2) & 8191;
        t6 = key[12] & 255 | (key[13] & 255) << 8;
        this.r[7] = (t5 >>> 11 | t6 << 5) & 8065;
        t7 = key[14] & 255 | (key[15] & 255) << 8;
        this.r[8] = (t6 >>> 8 | t7 << 8) & 8191;
        this.r[9] = t7 >>> 5 & 127;
        this.pad[0] = key[16] & 255 | (key[17] & 255) << 8;
        this.pad[1] = key[18] & 255 | (key[19] & 255) << 8;
        this.pad[2] = key[20] & 255 | (key[21] & 255) << 8;
        this.pad[3] = key[22] & 255 | (key[23] & 255) << 8;
        this.pad[4] = key[24] & 255 | (key[25] & 255) << 8;
        this.pad[5] = key[26] & 255 | (key[27] & 255) << 8;
        this.pad[6] = key[28] & 255 | (key[29] & 255) << 8;
        this.pad[7] = key[30] & 255 | (key[31] & 255) << 8;
      };
      poly1305.prototype.blocks = function(m, mpos, bytes) {
        var hibit = this.fin ? 0 : 1 << 11;
        var t0, t1, t2, t3, t4, t5, t6, t7, c;
        var d0, d1, d2, d3, d4, d5, d6, d7, d8, d9;
        var h0 = this.h[0], h1 = this.h[1], h2 = this.h[2], h3 = this.h[3], h4 = this.h[4], h5 = this.h[5], h6 = this.h[6], h7 = this.h[7], h8 = this.h[8], h9 = this.h[9];
        var r0 = this.r[0], r1 = this.r[1], r2 = this.r[2], r3 = this.r[3], r4 = this.r[4], r5 = this.r[5], r6 = this.r[6], r7 = this.r[7], r8 = this.r[8], r9 = this.r[9];
        while (bytes >= 16) {
          t0 = m[mpos + 0] & 255 | (m[mpos + 1] & 255) << 8;
          h0 += t0 & 8191;
          t1 = m[mpos + 2] & 255 | (m[mpos + 3] & 255) << 8;
          h1 += (t0 >>> 13 | t1 << 3) & 8191;
          t2 = m[mpos + 4] & 255 | (m[mpos + 5] & 255) << 8;
          h2 += (t1 >>> 10 | t2 << 6) & 8191;
          t3 = m[mpos + 6] & 255 | (m[mpos + 7] & 255) << 8;
          h3 += (t2 >>> 7 | t3 << 9) & 8191;
          t4 = m[mpos + 8] & 255 | (m[mpos + 9] & 255) << 8;
          h4 += (t3 >>> 4 | t4 << 12) & 8191;
          h5 += t4 >>> 1 & 8191;
          t5 = m[mpos + 10] & 255 | (m[mpos + 11] & 255) << 8;
          h6 += (t4 >>> 14 | t5 << 2) & 8191;
          t6 = m[mpos + 12] & 255 | (m[mpos + 13] & 255) << 8;
          h7 += (t5 >>> 11 | t6 << 5) & 8191;
          t7 = m[mpos + 14] & 255 | (m[mpos + 15] & 255) << 8;
          h8 += (t6 >>> 8 | t7 << 8) & 8191;
          h9 += t7 >>> 5 | hibit;
          c = 0;
          d0 = c;
          d0 += h0 * r0;
          d0 += h1 * (5 * r9);
          d0 += h2 * (5 * r8);
          d0 += h3 * (5 * r7);
          d0 += h4 * (5 * r6);
          c = d0 >>> 13;
          d0 &= 8191;
          d0 += h5 * (5 * r5);
          d0 += h6 * (5 * r4);
          d0 += h7 * (5 * r3);
          d0 += h8 * (5 * r2);
          d0 += h9 * (5 * r1);
          c += d0 >>> 13;
          d0 &= 8191;
          d1 = c;
          d1 += h0 * r1;
          d1 += h1 * r0;
          d1 += h2 * (5 * r9);
          d1 += h3 * (5 * r8);
          d1 += h4 * (5 * r7);
          c = d1 >>> 13;
          d1 &= 8191;
          d1 += h5 * (5 * r6);
          d1 += h6 * (5 * r5);
          d1 += h7 * (5 * r4);
          d1 += h8 * (5 * r3);
          d1 += h9 * (5 * r2);
          c += d1 >>> 13;
          d1 &= 8191;
          d2 = c;
          d2 += h0 * r2;
          d2 += h1 * r1;
          d2 += h2 * r0;
          d2 += h3 * (5 * r9);
          d2 += h4 * (5 * r8);
          c = d2 >>> 13;
          d2 &= 8191;
          d2 += h5 * (5 * r7);
          d2 += h6 * (5 * r6);
          d2 += h7 * (5 * r5);
          d2 += h8 * (5 * r4);
          d2 += h9 * (5 * r3);
          c += d2 >>> 13;
          d2 &= 8191;
          d3 = c;
          d3 += h0 * r3;
          d3 += h1 * r2;
          d3 += h2 * r1;
          d3 += h3 * r0;
          d3 += h4 * (5 * r9);
          c = d3 >>> 13;
          d3 &= 8191;
          d3 += h5 * (5 * r8);
          d3 += h6 * (5 * r7);
          d3 += h7 * (5 * r6);
          d3 += h8 * (5 * r5);
          d3 += h9 * (5 * r4);
          c += d3 >>> 13;
          d3 &= 8191;
          d4 = c;
          d4 += h0 * r4;
          d4 += h1 * r3;
          d4 += h2 * r2;
          d4 += h3 * r1;
          d4 += h4 * r0;
          c = d4 >>> 13;
          d4 &= 8191;
          d4 += h5 * (5 * r9);
          d4 += h6 * (5 * r8);
          d4 += h7 * (5 * r7);
          d4 += h8 * (5 * r6);
          d4 += h9 * (5 * r5);
          c += d4 >>> 13;
          d4 &= 8191;
          d5 = c;
          d5 += h0 * r5;
          d5 += h1 * r4;
          d5 += h2 * r3;
          d5 += h3 * r2;
          d5 += h4 * r1;
          c = d5 >>> 13;
          d5 &= 8191;
          d5 += h5 * r0;
          d5 += h6 * (5 * r9);
          d5 += h7 * (5 * r8);
          d5 += h8 * (5 * r7);
          d5 += h9 * (5 * r6);
          c += d5 >>> 13;
          d5 &= 8191;
          d6 = c;
          d6 += h0 * r6;
          d6 += h1 * r5;
          d6 += h2 * r4;
          d6 += h3 * r3;
          d6 += h4 * r2;
          c = d6 >>> 13;
          d6 &= 8191;
          d6 += h5 * r1;
          d6 += h6 * r0;
          d6 += h7 * (5 * r9);
          d6 += h8 * (5 * r8);
          d6 += h9 * (5 * r7);
          c += d6 >>> 13;
          d6 &= 8191;
          d7 = c;
          d7 += h0 * r7;
          d7 += h1 * r6;
          d7 += h2 * r5;
          d7 += h3 * r4;
          d7 += h4 * r3;
          c = d7 >>> 13;
          d7 &= 8191;
          d7 += h5 * r2;
          d7 += h6 * r1;
          d7 += h7 * r0;
          d7 += h8 * (5 * r9);
          d7 += h9 * (5 * r8);
          c += d7 >>> 13;
          d7 &= 8191;
          d8 = c;
          d8 += h0 * r8;
          d8 += h1 * r7;
          d8 += h2 * r6;
          d8 += h3 * r5;
          d8 += h4 * r4;
          c = d8 >>> 13;
          d8 &= 8191;
          d8 += h5 * r3;
          d8 += h6 * r2;
          d8 += h7 * r1;
          d8 += h8 * r0;
          d8 += h9 * (5 * r9);
          c += d8 >>> 13;
          d8 &= 8191;
          d9 = c;
          d9 += h0 * r9;
          d9 += h1 * r8;
          d9 += h2 * r7;
          d9 += h3 * r6;
          d9 += h4 * r5;
          c = d9 >>> 13;
          d9 &= 8191;
          d9 += h5 * r4;
          d9 += h6 * r3;
          d9 += h7 * r2;
          d9 += h8 * r1;
          d9 += h9 * r0;
          c += d9 >>> 13;
          d9 &= 8191;
          c = (c << 2) + c | 0;
          c = c + d0 | 0;
          d0 = c & 8191;
          c = c >>> 13;
          d1 += c;
          h0 = d0;
          h1 = d1;
          h2 = d2;
          h3 = d3;
          h4 = d4;
          h5 = d5;
          h6 = d6;
          h7 = d7;
          h8 = d8;
          h9 = d9;
          mpos += 16;
          bytes -= 16;
        }
        this.h[0] = h0;
        this.h[1] = h1;
        this.h[2] = h2;
        this.h[3] = h3;
        this.h[4] = h4;
        this.h[5] = h5;
        this.h[6] = h6;
        this.h[7] = h7;
        this.h[8] = h8;
        this.h[9] = h9;
      };
      poly1305.prototype.finish = function(mac, macpos) {
        var g = new Uint16Array(10);
        var c, mask, f, i;
        if (this.leftover) {
          i = this.leftover;
          this.buffer[i++] = 1;
          for (; i < 16; i++) this.buffer[i] = 0;
          this.fin = 1;
          this.blocks(this.buffer, 0, 16);
        }
        c = this.h[1] >>> 13;
        this.h[1] &= 8191;
        for (i = 2; i < 10; i++) {
          this.h[i] += c;
          c = this.h[i] >>> 13;
          this.h[i] &= 8191;
        }
        this.h[0] += c * 5;
        c = this.h[0] >>> 13;
        this.h[0] &= 8191;
        this.h[1] += c;
        c = this.h[1] >>> 13;
        this.h[1] &= 8191;
        this.h[2] += c;
        g[0] = this.h[0] + 5;
        c = g[0] >>> 13;
        g[0] &= 8191;
        for (i = 1; i < 10; i++) {
          g[i] = this.h[i] + c;
          c = g[i] >>> 13;
          g[i] &= 8191;
        }
        g[9] -= 1 << 13;
        mask = (c ^ 1) - 1;
        for (i = 0; i < 10; i++) g[i] &= mask;
        mask = ~mask;
        for (i = 0; i < 10; i++) this.h[i] = this.h[i] & mask | g[i];
        this.h[0] = (this.h[0] | this.h[1] << 13) & 65535;
        this.h[1] = (this.h[1] >>> 3 | this.h[2] << 10) & 65535;
        this.h[2] = (this.h[2] >>> 6 | this.h[3] << 7) & 65535;
        this.h[3] = (this.h[3] >>> 9 | this.h[4] << 4) & 65535;
        this.h[4] = (this.h[4] >>> 12 | this.h[5] << 1 | this.h[6] << 14) & 65535;
        this.h[5] = (this.h[6] >>> 2 | this.h[7] << 11) & 65535;
        this.h[6] = (this.h[7] >>> 5 | this.h[8] << 8) & 65535;
        this.h[7] = (this.h[8] >>> 8 | this.h[9] << 5) & 65535;
        f = this.h[0] + this.pad[0];
        this.h[0] = f & 65535;
        for (i = 1; i < 8; i++) {
          f = (this.h[i] + this.pad[i] | 0) + (f >>> 16) | 0;
          this.h[i] = f & 65535;
        }
        mac[macpos + 0] = this.h[0] >>> 0 & 255;
        mac[macpos + 1] = this.h[0] >>> 8 & 255;
        mac[macpos + 2] = this.h[1] >>> 0 & 255;
        mac[macpos + 3] = this.h[1] >>> 8 & 255;
        mac[macpos + 4] = this.h[2] >>> 0 & 255;
        mac[macpos + 5] = this.h[2] >>> 8 & 255;
        mac[macpos + 6] = this.h[3] >>> 0 & 255;
        mac[macpos + 7] = this.h[3] >>> 8 & 255;
        mac[macpos + 8] = this.h[4] >>> 0 & 255;
        mac[macpos + 9] = this.h[4] >>> 8 & 255;
        mac[macpos + 10] = this.h[5] >>> 0 & 255;
        mac[macpos + 11] = this.h[5] >>> 8 & 255;
        mac[macpos + 12] = this.h[6] >>> 0 & 255;
        mac[macpos + 13] = this.h[6] >>> 8 & 255;
        mac[macpos + 14] = this.h[7] >>> 0 & 255;
        mac[macpos + 15] = this.h[7] >>> 8 & 255;
      };
      poly1305.prototype.update = function(m, mpos, bytes) {
        var i, want;
        if (this.leftover) {
          want = 16 - this.leftover;
          if (want > bytes)
            want = bytes;
          for (i = 0; i < want; i++)
            this.buffer[this.leftover + i] = m[mpos + i];
          bytes -= want;
          mpos += want;
          this.leftover += want;
          if (this.leftover < 16)
            return;
          this.blocks(this.buffer, 0, 16);
          this.leftover = 0;
        }
        if (bytes >= 16) {
          want = bytes - bytes % 16;
          this.blocks(m, mpos, want);
          mpos += want;
          bytes -= want;
        }
        if (bytes) {
          for (i = 0; i < bytes; i++)
            this.buffer[this.leftover + i] = m[mpos + i];
          this.leftover += bytes;
        }
      };
      function crypto_onetimeauth(out, outpos, m, mpos, n, k) {
        var s = new poly1305(k);
        s.update(m, mpos, n);
        s.finish(out, outpos);
        return 0;
      }
      function crypto_onetimeauth_verify(h, hpos, m, mpos, n, k) {
        var x = new Uint8Array(16);
        crypto_onetimeauth(x, 0, m, mpos, n, k);
        return crypto_verify_16(h, hpos, x, 0);
      }
      function crypto_secretbox(c, m, d, n, k) {
        var i;
        if (d < 32) return -1;
        crypto_stream_xor(c, 0, m, 0, d, n, k);
        crypto_onetimeauth(c, 16, c, 32, d - 32, c);
        for (i = 0; i < 16; i++) c[i] = 0;
        return 0;
      }
      function crypto_secretbox_open(m, c, d, n, k) {
        var i;
        var x = new Uint8Array(32);
        if (d < 32) return -1;
        crypto_stream(x, 0, 32, n, k);
        if (crypto_onetimeauth_verify(c, 16, c, 32, d - 32, x) !== 0) return -1;
        crypto_stream_xor(m, 0, c, 0, d, n, k);
        for (i = 0; i < 32; i++) m[i] = 0;
        return 0;
      }
      function set25519(r, a) {
        var i;
        for (i = 0; i < 16; i++) r[i] = a[i] | 0;
      }
      function car25519(o) {
        var i, v, c = 1;
        for (i = 0; i < 16; i++) {
          v = o[i] + c + 65535;
          c = Math.floor(v / 65536);
          o[i] = v - c * 65536;
        }
        o[0] += c - 1 + 37 * (c - 1);
      }
      function sel25519(p, q, b) {
        var t, c = ~(b - 1);
        for (var i = 0; i < 16; i++) {
          t = c & (p[i] ^ q[i]);
          p[i] ^= t;
          q[i] ^= t;
        }
      }
      function pack25519(o, n) {
        var i, j, b;
        var m = gf(), t = gf();
        for (i = 0; i < 16; i++) t[i] = n[i];
        car25519(t);
        car25519(t);
        car25519(t);
        for (j = 0; j < 2; j++) {
          m[0] = t[0] - 65517;
          for (i = 1; i < 15; i++) {
            m[i] = t[i] - 65535 - (m[i - 1] >> 16 & 1);
            m[i - 1] &= 65535;
          }
          m[15] = t[15] - 32767 - (m[14] >> 16 & 1);
          b = m[15] >> 16 & 1;
          m[14] &= 65535;
          sel25519(t, m, 1 - b);
        }
        for (i = 0; i < 16; i++) {
          o[2 * i] = t[i] & 255;
          o[2 * i + 1] = t[i] >> 8;
        }
      }
      function neq25519(a, b) {
        var c = new Uint8Array(32), d = new Uint8Array(32);
        pack25519(c, a);
        pack25519(d, b);
        return crypto_verify_32(c, 0, d, 0);
      }
      function par25519(a) {
        var d = new Uint8Array(32);
        pack25519(d, a);
        return d[0] & 1;
      }
      function unpack25519(o, n) {
        var i;
        for (i = 0; i < 16; i++) o[i] = n[2 * i] + (n[2 * i + 1] << 8);
        o[15] &= 32767;
      }
      function A(o, a, b) {
        for (var i = 0; i < 16; i++) o[i] = a[i] + b[i];
      }
      function Z(o, a, b) {
        for (var i = 0; i < 16; i++) o[i] = a[i] - b[i];
      }
      function M(o, a, b) {
        var v, c, t0 = 0, t1 = 0, t2 = 0, t3 = 0, t4 = 0, t5 = 0, t6 = 0, t7 = 0, t8 = 0, t9 = 0, t10 = 0, t11 = 0, t12 = 0, t13 = 0, t14 = 0, t15 = 0, t16 = 0, t17 = 0, t18 = 0, t19 = 0, t20 = 0, t21 = 0, t22 = 0, t23 = 0, t24 = 0, t25 = 0, t26 = 0, t27 = 0, t28 = 0, t29 = 0, t30 = 0, b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3], b4 = b[4], b5 = b[5], b6 = b[6], b7 = b[7], b8 = b[8], b9 = b[9], b10 = b[10], b11 = b[11], b12 = b[12], b13 = b[13], b14 = b[14], b15 = b[15];
        v = a[0];
        t0 += v * b0;
        t1 += v * b1;
        t2 += v * b2;
        t3 += v * b3;
        t4 += v * b4;
        t5 += v * b5;
        t6 += v * b6;
        t7 += v * b7;
        t8 += v * b8;
        t9 += v * b9;
        t10 += v * b10;
        t11 += v * b11;
        t12 += v * b12;
        t13 += v * b13;
        t14 += v * b14;
        t15 += v * b15;
        v = a[1];
        t1 += v * b0;
        t2 += v * b1;
        t3 += v * b2;
        t4 += v * b3;
        t5 += v * b4;
        t6 += v * b5;
        t7 += v * b6;
        t8 += v * b7;
        t9 += v * b8;
        t10 += v * b9;
        t11 += v * b10;
        t12 += v * b11;
        t13 += v * b12;
        t14 += v * b13;
        t15 += v * b14;
        t16 += v * b15;
        v = a[2];
        t2 += v * b0;
        t3 += v * b1;
        t4 += v * b2;
        t5 += v * b3;
        t6 += v * b4;
        t7 += v * b5;
        t8 += v * b6;
        t9 += v * b7;
        t10 += v * b8;
        t11 += v * b9;
        t12 += v * b10;
        t13 += v * b11;
        t14 += v * b12;
        t15 += v * b13;
        t16 += v * b14;
        t17 += v * b15;
        v = a[3];
        t3 += v * b0;
        t4 += v * b1;
        t5 += v * b2;
        t6 += v * b3;
        t7 += v * b4;
        t8 += v * b5;
        t9 += v * b6;
        t10 += v * b7;
        t11 += v * b8;
        t12 += v * b9;
        t13 += v * b10;
        t14 += v * b11;
        t15 += v * b12;
        t16 += v * b13;
        t17 += v * b14;
        t18 += v * b15;
        v = a[4];
        t4 += v * b0;
        t5 += v * b1;
        t6 += v * b2;
        t7 += v * b3;
        t8 += v * b4;
        t9 += v * b5;
        t10 += v * b6;
        t11 += v * b7;
        t12 += v * b8;
        t13 += v * b9;
        t14 += v * b10;
        t15 += v * b11;
        t16 += v * b12;
        t17 += v * b13;
        t18 += v * b14;
        t19 += v * b15;
        v = a[5];
        t5 += v * b0;
        t6 += v * b1;
        t7 += v * b2;
        t8 += v * b3;
        t9 += v * b4;
        t10 += v * b5;
        t11 += v * b6;
        t12 += v * b7;
        t13 += v * b8;
        t14 += v * b9;
        t15 += v * b10;
        t16 += v * b11;
        t17 += v * b12;
        t18 += v * b13;
        t19 += v * b14;
        t20 += v * b15;
        v = a[6];
        t6 += v * b0;
        t7 += v * b1;
        t8 += v * b2;
        t9 += v * b3;
        t10 += v * b4;
        t11 += v * b5;
        t12 += v * b6;
        t13 += v * b7;
        t14 += v * b8;
        t15 += v * b9;
        t16 += v * b10;
        t17 += v * b11;
        t18 += v * b12;
        t19 += v * b13;
        t20 += v * b14;
        t21 += v * b15;
        v = a[7];
        t7 += v * b0;
        t8 += v * b1;
        t9 += v * b2;
        t10 += v * b3;
        t11 += v * b4;
        t12 += v * b5;
        t13 += v * b6;
        t14 += v * b7;
        t15 += v * b8;
        t16 += v * b9;
        t17 += v * b10;
        t18 += v * b11;
        t19 += v * b12;
        t20 += v * b13;
        t21 += v * b14;
        t22 += v * b15;
        v = a[8];
        t8 += v * b0;
        t9 += v * b1;
        t10 += v * b2;
        t11 += v * b3;
        t12 += v * b4;
        t13 += v * b5;
        t14 += v * b6;
        t15 += v * b7;
        t16 += v * b8;
        t17 += v * b9;
        t18 += v * b10;
        t19 += v * b11;
        t20 += v * b12;
        t21 += v * b13;
        t22 += v * b14;
        t23 += v * b15;
        v = a[9];
        t9 += v * b0;
        t10 += v * b1;
        t11 += v * b2;
        t12 += v * b3;
        t13 += v * b4;
        t14 += v * b5;
        t15 += v * b6;
        t16 += v * b7;
        t17 += v * b8;
        t18 += v * b9;
        t19 += v * b10;
        t20 += v * b11;
        t21 += v * b12;
        t22 += v * b13;
        t23 += v * b14;
        t24 += v * b15;
        v = a[10];
        t10 += v * b0;
        t11 += v * b1;
        t12 += v * b2;
        t13 += v * b3;
        t14 += v * b4;
        t15 += v * b5;
        t16 += v * b6;
        t17 += v * b7;
        t18 += v * b8;
        t19 += v * b9;
        t20 += v * b10;
        t21 += v * b11;
        t22 += v * b12;
        t23 += v * b13;
        t24 += v * b14;
        t25 += v * b15;
        v = a[11];
        t11 += v * b0;
        t12 += v * b1;
        t13 += v * b2;
        t14 += v * b3;
        t15 += v * b4;
        t16 += v * b5;
        t17 += v * b6;
        t18 += v * b7;
        t19 += v * b8;
        t20 += v * b9;
        t21 += v * b10;
        t22 += v * b11;
        t23 += v * b12;
        t24 += v * b13;
        t25 += v * b14;
        t26 += v * b15;
        v = a[12];
        t12 += v * b0;
        t13 += v * b1;
        t14 += v * b2;
        t15 += v * b3;
        t16 += v * b4;
        t17 += v * b5;
        t18 += v * b6;
        t19 += v * b7;
        t20 += v * b8;
        t21 += v * b9;
        t22 += v * b10;
        t23 += v * b11;
        t24 += v * b12;
        t25 += v * b13;
        t26 += v * b14;
        t27 += v * b15;
        v = a[13];
        t13 += v * b0;
        t14 += v * b1;
        t15 += v * b2;
        t16 += v * b3;
        t17 += v * b4;
        t18 += v * b5;
        t19 += v * b6;
        t20 += v * b7;
        t21 += v * b8;
        t22 += v * b9;
        t23 += v * b10;
        t24 += v * b11;
        t25 += v * b12;
        t26 += v * b13;
        t27 += v * b14;
        t28 += v * b15;
        v = a[14];
        t14 += v * b0;
        t15 += v * b1;
        t16 += v * b2;
        t17 += v * b3;
        t18 += v * b4;
        t19 += v * b5;
        t20 += v * b6;
        t21 += v * b7;
        t22 += v * b8;
        t23 += v * b9;
        t24 += v * b10;
        t25 += v * b11;
        t26 += v * b12;
        t27 += v * b13;
        t28 += v * b14;
        t29 += v * b15;
        v = a[15];
        t15 += v * b0;
        t16 += v * b1;
        t17 += v * b2;
        t18 += v * b3;
        t19 += v * b4;
        t20 += v * b5;
        t21 += v * b6;
        t22 += v * b7;
        t23 += v * b8;
        t24 += v * b9;
        t25 += v * b10;
        t26 += v * b11;
        t27 += v * b12;
        t28 += v * b13;
        t29 += v * b14;
        t30 += v * b15;
        t0 += 38 * t16;
        t1 += 38 * t17;
        t2 += 38 * t18;
        t3 += 38 * t19;
        t4 += 38 * t20;
        t5 += 38 * t21;
        t6 += 38 * t22;
        t7 += 38 * t23;
        t8 += 38 * t24;
        t9 += 38 * t25;
        t10 += 38 * t26;
        t11 += 38 * t27;
        t12 += 38 * t28;
        t13 += 38 * t29;
        t14 += 38 * t30;
        c = 1;
        v = t0 + c + 65535;
        c = Math.floor(v / 65536);
        t0 = v - c * 65536;
        v = t1 + c + 65535;
        c = Math.floor(v / 65536);
        t1 = v - c * 65536;
        v = t2 + c + 65535;
        c = Math.floor(v / 65536);
        t2 = v - c * 65536;
        v = t3 + c + 65535;
        c = Math.floor(v / 65536);
        t3 = v - c * 65536;
        v = t4 + c + 65535;
        c = Math.floor(v / 65536);
        t4 = v - c * 65536;
        v = t5 + c + 65535;
        c = Math.floor(v / 65536);
        t5 = v - c * 65536;
        v = t6 + c + 65535;
        c = Math.floor(v / 65536);
        t6 = v - c * 65536;
        v = t7 + c + 65535;
        c = Math.floor(v / 65536);
        t7 = v - c * 65536;
        v = t8 + c + 65535;
        c = Math.floor(v / 65536);
        t8 = v - c * 65536;
        v = t9 + c + 65535;
        c = Math.floor(v / 65536);
        t9 = v - c * 65536;
        v = t10 + c + 65535;
        c = Math.floor(v / 65536);
        t10 = v - c * 65536;
        v = t11 + c + 65535;
        c = Math.floor(v / 65536);
        t11 = v - c * 65536;
        v = t12 + c + 65535;
        c = Math.floor(v / 65536);
        t12 = v - c * 65536;
        v = t13 + c + 65535;
        c = Math.floor(v / 65536);
        t13 = v - c * 65536;
        v = t14 + c + 65535;
        c = Math.floor(v / 65536);
        t14 = v - c * 65536;
        v = t15 + c + 65535;
        c = Math.floor(v / 65536);
        t15 = v - c * 65536;
        t0 += c - 1 + 37 * (c - 1);
        c = 1;
        v = t0 + c + 65535;
        c = Math.floor(v / 65536);
        t0 = v - c * 65536;
        v = t1 + c + 65535;
        c = Math.floor(v / 65536);
        t1 = v - c * 65536;
        v = t2 + c + 65535;
        c = Math.floor(v / 65536);
        t2 = v - c * 65536;
        v = t3 + c + 65535;
        c = Math.floor(v / 65536);
        t3 = v - c * 65536;
        v = t4 + c + 65535;
        c = Math.floor(v / 65536);
        t4 = v - c * 65536;
        v = t5 + c + 65535;
        c = Math.floor(v / 65536);
        t5 = v - c * 65536;
        v = t6 + c + 65535;
        c = Math.floor(v / 65536);
        t6 = v - c * 65536;
        v = t7 + c + 65535;
        c = Math.floor(v / 65536);
        t7 = v - c * 65536;
        v = t8 + c + 65535;
        c = Math.floor(v / 65536);
        t8 = v - c * 65536;
        v = t9 + c + 65535;
        c = Math.floor(v / 65536);
        t9 = v - c * 65536;
        v = t10 + c + 65535;
        c = Math.floor(v / 65536);
        t10 = v - c * 65536;
        v = t11 + c + 65535;
        c = Math.floor(v / 65536);
        t11 = v - c * 65536;
        v = t12 + c + 65535;
        c = Math.floor(v / 65536);
        t12 = v - c * 65536;
        v = t13 + c + 65535;
        c = Math.floor(v / 65536);
        t13 = v - c * 65536;
        v = t14 + c + 65535;
        c = Math.floor(v / 65536);
        t14 = v - c * 65536;
        v = t15 + c + 65535;
        c = Math.floor(v / 65536);
        t15 = v - c * 65536;
        t0 += c - 1 + 37 * (c - 1);
        o[0] = t0;
        o[1] = t1;
        o[2] = t2;
        o[3] = t3;
        o[4] = t4;
        o[5] = t5;
        o[6] = t6;
        o[7] = t7;
        o[8] = t8;
        o[9] = t9;
        o[10] = t10;
        o[11] = t11;
        o[12] = t12;
        o[13] = t13;
        o[14] = t14;
        o[15] = t15;
      }
      function S(o, a) {
        M(o, a, a);
      }
      function inv25519(o, i) {
        var c = gf();
        var a;
        for (a = 0; a < 16; a++) c[a] = i[a];
        for (a = 253; a >= 0; a--) {
          S(c, c);
          if (a !== 2 && a !== 4) M(c, c, i);
        }
        for (a = 0; a < 16; a++) o[a] = c[a];
      }
      function pow2523(o, i) {
        var c = gf();
        var a;
        for (a = 0; a < 16; a++) c[a] = i[a];
        for (a = 250; a >= 0; a--) {
          S(c, c);
          if (a !== 1) M(c, c, i);
        }
        for (a = 0; a < 16; a++) o[a] = c[a];
      }
      function crypto_scalarmult(q, n, p) {
        var z2 = new Uint8Array(32);
        var x = new Float64Array(80), r, i;
        var a = gf(), b = gf(), c = gf(), d = gf(), e = gf(), f = gf();
        for (i = 0; i < 31; i++) z2[i] = n[i];
        z2[31] = n[31] & 127 | 64;
        z2[0] &= 248;
        unpack25519(x, p);
        for (i = 0; i < 16; i++) {
          b[i] = x[i];
          d[i] = a[i] = c[i] = 0;
        }
        a[0] = d[0] = 1;
        for (i = 254; i >= 0; --i) {
          r = z2[i >>> 3] >>> (i & 7) & 1;
          sel25519(a, b, r);
          sel25519(c, d, r);
          A(e, a, c);
          Z(a, a, c);
          A(c, b, d);
          Z(b, b, d);
          S(d, e);
          S(f, a);
          M(a, c, a);
          M(c, b, e);
          A(e, a, c);
          Z(a, a, c);
          S(b, a);
          Z(c, d, f);
          M(a, c, _121665);
          A(a, a, d);
          M(c, c, a);
          M(a, d, f);
          M(d, b, x);
          S(b, e);
          sel25519(a, b, r);
          sel25519(c, d, r);
        }
        for (i = 0; i < 16; i++) {
          x[i + 16] = a[i];
          x[i + 32] = c[i];
          x[i + 48] = b[i];
          x[i + 64] = d[i];
        }
        var x32 = x.subarray(32);
        var x16 = x.subarray(16);
        inv25519(x32, x32);
        M(x16, x16, x32);
        pack25519(q, x16);
        return 0;
      }
      function crypto_scalarmult_base(q, n) {
        return crypto_scalarmult(q, n, _9);
      }
      function crypto_box_keypair(y, x) {
        randombytes(x, 32);
        return crypto_scalarmult_base(y, x);
      }
      function crypto_box_beforenm(k, y, x) {
        var s = new Uint8Array(32);
        crypto_scalarmult(s, x, y);
        return crypto_core_hsalsa20(k, _0, s, sigma);
      }
      var crypto_box_afternm = crypto_secretbox;
      var crypto_box_open_afternm = crypto_secretbox_open;
      function crypto_box(c, m, d, n, y, x) {
        var k = new Uint8Array(32);
        crypto_box_beforenm(k, y, x);
        return crypto_box_afternm(c, m, d, n, k);
      }
      function crypto_box_open(m, c, d, n, y, x) {
        var k = new Uint8Array(32);
        crypto_box_beforenm(k, y, x);
        return crypto_box_open_afternm(m, c, d, n, k);
      }
      var K = [
        1116352408,
        3609767458,
        1899447441,
        602891725,
        3049323471,
        3964484399,
        3921009573,
        2173295548,
        961987163,
        4081628472,
        1508970993,
        3053834265,
        2453635748,
        2937671579,
        2870763221,
        3664609560,
        3624381080,
        2734883394,
        310598401,
        1164996542,
        607225278,
        1323610764,
        1426881987,
        3590304994,
        1925078388,
        4068182383,
        2162078206,
        991336113,
        2614888103,
        633803317,
        3248222580,
        3479774868,
        3835390401,
        2666613458,
        4022224774,
        944711139,
        264347078,
        2341262773,
        604807628,
        2007800933,
        770255983,
        1495990901,
        1249150122,
        1856431235,
        1555081692,
        3175218132,
        1996064986,
        2198950837,
        2554220882,
        3999719339,
        2821834349,
        766784016,
        2952996808,
        2566594879,
        3210313671,
        3203337956,
        3336571891,
        1034457026,
        3584528711,
        2466948901,
        113926993,
        3758326383,
        338241895,
        168717936,
        666307205,
        1188179964,
        773529912,
        1546045734,
        1294757372,
        1522805485,
        1396182291,
        2643833823,
        1695183700,
        2343527390,
        1986661051,
        1014477480,
        2177026350,
        1206759142,
        2456956037,
        344077627,
        2730485921,
        1290863460,
        2820302411,
        3158454273,
        3259730800,
        3505952657,
        3345764771,
        106217008,
        3516065817,
        3606008344,
        3600352804,
        1432725776,
        4094571909,
        1467031594,
        275423344,
        851169720,
        430227734,
        3100823752,
        506948616,
        1363258195,
        659060556,
        3750685593,
        883997877,
        3785050280,
        958139571,
        3318307427,
        1322822218,
        3812723403,
        1537002063,
        2003034995,
        1747873779,
        3602036899,
        1955562222,
        1575990012,
        2024104815,
        1125592928,
        2227730452,
        2716904306,
        2361852424,
        442776044,
        2428436474,
        593698344,
        2756734187,
        3733110249,
        3204031479,
        2999351573,
        3329325298,
        3815920427,
        3391569614,
        3928383900,
        3515267271,
        566280711,
        3940187606,
        3454069534,
        4118630271,
        4000239992,
        116418474,
        1914138554,
        174292421,
        2731055270,
        289380356,
        3203993006,
        460393269,
        320620315,
        685471733,
        587496836,
        852142971,
        1086792851,
        1017036298,
        365543100,
        1126000580,
        2618297676,
        1288033470,
        3409855158,
        1501505948,
        4234509866,
        1607167915,
        987167468,
        1816402316,
        1246189591
      ];
      function crypto_hashblocks_hl(hh, hl, m, n) {
        var wh = new Int32Array(16), wl = new Int32Array(16), bh0, bh1, bh2, bh3, bh4, bh5, bh6, bh7, bl0, bl1, bl2, bl3, bl4, bl5, bl6, bl7, th, tl, i, j, h, l, a, b, c, d;
        var ah0 = hh[0], ah1 = hh[1], ah2 = hh[2], ah3 = hh[3], ah4 = hh[4], ah5 = hh[5], ah6 = hh[6], ah7 = hh[7], al0 = hl[0], al1 = hl[1], al2 = hl[2], al3 = hl[3], al4 = hl[4], al5 = hl[5], al6 = hl[6], al7 = hl[7];
        var pos = 0;
        while (n >= 128) {
          for (i = 0; i < 16; i++) {
            j = 8 * i + pos;
            wh[i] = m[j + 0] << 24 | m[j + 1] << 16 | m[j + 2] << 8 | m[j + 3];
            wl[i] = m[j + 4] << 24 | m[j + 5] << 16 | m[j + 6] << 8 | m[j + 7];
          }
          for (i = 0; i < 80; i++) {
            bh0 = ah0;
            bh1 = ah1;
            bh2 = ah2;
            bh3 = ah3;
            bh4 = ah4;
            bh5 = ah5;
            bh6 = ah6;
            bh7 = ah7;
            bl0 = al0;
            bl1 = al1;
            bl2 = al2;
            bl3 = al3;
            bl4 = al4;
            bl5 = al5;
            bl6 = al6;
            bl7 = al7;
            h = ah7;
            l = al7;
            a = l & 65535;
            b = l >>> 16;
            c = h & 65535;
            d = h >>> 16;
            h = (ah4 >>> 14 | al4 << 32 - 14) ^ (ah4 >>> 18 | al4 << 32 - 18) ^ (al4 >>> 41 - 32 | ah4 << 32 - (41 - 32));
            l = (al4 >>> 14 | ah4 << 32 - 14) ^ (al4 >>> 18 | ah4 << 32 - 18) ^ (ah4 >>> 41 - 32 | al4 << 32 - (41 - 32));
            a += l & 65535;
            b += l >>> 16;
            c += h & 65535;
            d += h >>> 16;
            h = ah4 & ah5 ^ ~ah4 & ah6;
            l = al4 & al5 ^ ~al4 & al6;
            a += l & 65535;
            b += l >>> 16;
            c += h & 65535;
            d += h >>> 16;
            h = K[i * 2];
            l = K[i * 2 + 1];
            a += l & 65535;
            b += l >>> 16;
            c += h & 65535;
            d += h >>> 16;
            h = wh[i % 16];
            l = wl[i % 16];
            a += l & 65535;
            b += l >>> 16;
            c += h & 65535;
            d += h >>> 16;
            b += a >>> 16;
            c += b >>> 16;
            d += c >>> 16;
            th = c & 65535 | d << 16;
            tl = a & 65535 | b << 16;
            h = th;
            l = tl;
            a = l & 65535;
            b = l >>> 16;
            c = h & 65535;
            d = h >>> 16;
            h = (ah0 >>> 28 | al0 << 32 - 28) ^ (al0 >>> 34 - 32 | ah0 << 32 - (34 - 32)) ^ (al0 >>> 39 - 32 | ah0 << 32 - (39 - 32));
            l = (al0 >>> 28 | ah0 << 32 - 28) ^ (ah0 >>> 34 - 32 | al0 << 32 - (34 - 32)) ^ (ah0 >>> 39 - 32 | al0 << 32 - (39 - 32));
            a += l & 65535;
            b += l >>> 16;
            c += h & 65535;
            d += h >>> 16;
            h = ah0 & ah1 ^ ah0 & ah2 ^ ah1 & ah2;
            l = al0 & al1 ^ al0 & al2 ^ al1 & al2;
            a += l & 65535;
            b += l >>> 16;
            c += h & 65535;
            d += h >>> 16;
            b += a >>> 16;
            c += b >>> 16;
            d += c >>> 16;
            bh7 = c & 65535 | d << 16;
            bl7 = a & 65535 | b << 16;
            h = bh3;
            l = bl3;
            a = l & 65535;
            b = l >>> 16;
            c = h & 65535;
            d = h >>> 16;
            h = th;
            l = tl;
            a += l & 65535;
            b += l >>> 16;
            c += h & 65535;
            d += h >>> 16;
            b += a >>> 16;
            c += b >>> 16;
            d += c >>> 16;
            bh3 = c & 65535 | d << 16;
            bl3 = a & 65535 | b << 16;
            ah1 = bh0;
            ah2 = bh1;
            ah3 = bh2;
            ah4 = bh3;
            ah5 = bh4;
            ah6 = bh5;
            ah7 = bh6;
            ah0 = bh7;
            al1 = bl0;
            al2 = bl1;
            al3 = bl2;
            al4 = bl3;
            al5 = bl4;
            al6 = bl5;
            al7 = bl6;
            al0 = bl7;
            if (i % 16 === 15) {
              for (j = 0; j < 16; j++) {
                h = wh[j];
                l = wl[j];
                a = l & 65535;
                b = l >>> 16;
                c = h & 65535;
                d = h >>> 16;
                h = wh[(j + 9) % 16];
                l = wl[(j + 9) % 16];
                a += l & 65535;
                b += l >>> 16;
                c += h & 65535;
                d += h >>> 16;
                th = wh[(j + 1) % 16];
                tl = wl[(j + 1) % 16];
                h = (th >>> 1 | tl << 32 - 1) ^ (th >>> 8 | tl << 32 - 8) ^ th >>> 7;
                l = (tl >>> 1 | th << 32 - 1) ^ (tl >>> 8 | th << 32 - 8) ^ (tl >>> 7 | th << 32 - 7);
                a += l & 65535;
                b += l >>> 16;
                c += h & 65535;
                d += h >>> 16;
                th = wh[(j + 14) % 16];
                tl = wl[(j + 14) % 16];
                h = (th >>> 19 | tl << 32 - 19) ^ (tl >>> 61 - 32 | th << 32 - (61 - 32)) ^ th >>> 6;
                l = (tl >>> 19 | th << 32 - 19) ^ (th >>> 61 - 32 | tl << 32 - (61 - 32)) ^ (tl >>> 6 | th << 32 - 6);
                a += l & 65535;
                b += l >>> 16;
                c += h & 65535;
                d += h >>> 16;
                b += a >>> 16;
                c += b >>> 16;
                d += c >>> 16;
                wh[j] = c & 65535 | d << 16;
                wl[j] = a & 65535 | b << 16;
              }
            }
          }
          h = ah0;
          l = al0;
          a = l & 65535;
          b = l >>> 16;
          c = h & 65535;
          d = h >>> 16;
          h = hh[0];
          l = hl[0];
          a += l & 65535;
          b += l >>> 16;
          c += h & 65535;
          d += h >>> 16;
          b += a >>> 16;
          c += b >>> 16;
          d += c >>> 16;
          hh[0] = ah0 = c & 65535 | d << 16;
          hl[0] = al0 = a & 65535 | b << 16;
          h = ah1;
          l = al1;
          a = l & 65535;
          b = l >>> 16;
          c = h & 65535;
          d = h >>> 16;
          h = hh[1];
          l = hl[1];
          a += l & 65535;
          b += l >>> 16;
          c += h & 65535;
          d += h >>> 16;
          b += a >>> 16;
          c += b >>> 16;
          d += c >>> 16;
          hh[1] = ah1 = c & 65535 | d << 16;
          hl[1] = al1 = a & 65535 | b << 16;
          h = ah2;
          l = al2;
          a = l & 65535;
          b = l >>> 16;
          c = h & 65535;
          d = h >>> 16;
          h = hh[2];
          l = hl[2];
          a += l & 65535;
          b += l >>> 16;
          c += h & 65535;
          d += h >>> 16;
          b += a >>> 16;
          c += b >>> 16;
          d += c >>> 16;
          hh[2] = ah2 = c & 65535 | d << 16;
          hl[2] = al2 = a & 65535 | b << 16;
          h = ah3;
          l = al3;
          a = l & 65535;
          b = l >>> 16;
          c = h & 65535;
          d = h >>> 16;
          h = hh[3];
          l = hl[3];
          a += l & 65535;
          b += l >>> 16;
          c += h & 65535;
          d += h >>> 16;
          b += a >>> 16;
          c += b >>> 16;
          d += c >>> 16;
          hh[3] = ah3 = c & 65535 | d << 16;
          hl[3] = al3 = a & 65535 | b << 16;
          h = ah4;
          l = al4;
          a = l & 65535;
          b = l >>> 16;
          c = h & 65535;
          d = h >>> 16;
          h = hh[4];
          l = hl[4];
          a += l & 65535;
          b += l >>> 16;
          c += h & 65535;
          d += h >>> 16;
          b += a >>> 16;
          c += b >>> 16;
          d += c >>> 16;
          hh[4] = ah4 = c & 65535 | d << 16;
          hl[4] = al4 = a & 65535 | b << 16;
          h = ah5;
          l = al5;
          a = l & 65535;
          b = l >>> 16;
          c = h & 65535;
          d = h >>> 16;
          h = hh[5];
          l = hl[5];
          a += l & 65535;
          b += l >>> 16;
          c += h & 65535;
          d += h >>> 16;
          b += a >>> 16;
          c += b >>> 16;
          d += c >>> 16;
          hh[5] = ah5 = c & 65535 | d << 16;
          hl[5] = al5 = a & 65535 | b << 16;
          h = ah6;
          l = al6;
          a = l & 65535;
          b = l >>> 16;
          c = h & 65535;
          d = h >>> 16;
          h = hh[6];
          l = hl[6];
          a += l & 65535;
          b += l >>> 16;
          c += h & 65535;
          d += h >>> 16;
          b += a >>> 16;
          c += b >>> 16;
          d += c >>> 16;
          hh[6] = ah6 = c & 65535 | d << 16;
          hl[6] = al6 = a & 65535 | b << 16;
          h = ah7;
          l = al7;
          a = l & 65535;
          b = l >>> 16;
          c = h & 65535;
          d = h >>> 16;
          h = hh[7];
          l = hl[7];
          a += l & 65535;
          b += l >>> 16;
          c += h & 65535;
          d += h >>> 16;
          b += a >>> 16;
          c += b >>> 16;
          d += c >>> 16;
          hh[7] = ah7 = c & 65535 | d << 16;
          hl[7] = al7 = a & 65535 | b << 16;
          pos += 128;
          n -= 128;
        }
        return n;
      }
      function crypto_hash(out, m, n) {
        var hh = new Int32Array(8), hl = new Int32Array(8), x = new Uint8Array(256), i, b = n;
        hh[0] = 1779033703;
        hh[1] = 3144134277;
        hh[2] = 1013904242;
        hh[3] = 2773480762;
        hh[4] = 1359893119;
        hh[5] = 2600822924;
        hh[6] = 528734635;
        hh[7] = 1541459225;
        hl[0] = 4089235720;
        hl[1] = 2227873595;
        hl[2] = 4271175723;
        hl[3] = 1595750129;
        hl[4] = 2917565137;
        hl[5] = 725511199;
        hl[6] = 4215389547;
        hl[7] = 327033209;
        crypto_hashblocks_hl(hh, hl, m, n);
        n %= 128;
        for (i = 0; i < n; i++) x[i] = m[b - n + i];
        x[n] = 128;
        n = 256 - 128 * (n < 112 ? 1 : 0);
        x[n - 9] = 0;
        ts64(x, n - 8, b / 536870912 | 0, b << 3);
        crypto_hashblocks_hl(hh, hl, x, n);
        for (i = 0; i < 8; i++) ts64(out, 8 * i, hh[i], hl[i]);
        return 0;
      }
      function add(p, q) {
        var a = gf(), b = gf(), c = gf(), d = gf(), e = gf(), f = gf(), g = gf(), h = gf(), t = gf();
        Z(a, p[1], p[0]);
        Z(t, q[1], q[0]);
        M(a, a, t);
        A(b, p[0], p[1]);
        A(t, q[0], q[1]);
        M(b, b, t);
        M(c, p[3], q[3]);
        M(c, c, D2);
        M(d, p[2], q[2]);
        A(d, d, d);
        Z(e, b, a);
        Z(f, d, c);
        A(g, d, c);
        A(h, b, a);
        M(p[0], e, f);
        M(p[1], h, g);
        M(p[2], g, f);
        M(p[3], e, h);
      }
      function cswap(p, q, b) {
        var i;
        for (i = 0; i < 4; i++) {
          sel25519(p[i], q[i], b);
        }
      }
      function pack(r, p) {
        var tx = gf(), ty = gf(), zi = gf();
        inv25519(zi, p[2]);
        M(tx, p[0], zi);
        M(ty, p[1], zi);
        pack25519(r, ty);
        r[31] ^= par25519(tx) << 7;
      }
      function scalarmult(p, q, s) {
        var b, i;
        set25519(p[0], gf0);
        set25519(p[1], gf1);
        set25519(p[2], gf1);
        set25519(p[3], gf0);
        for (i = 255; i >= 0; --i) {
          b = s[i / 8 | 0] >> (i & 7) & 1;
          cswap(p, q, b);
          add(q, p);
          add(p, p);
          cswap(p, q, b);
        }
      }
      function scalarbase(p, s) {
        var q = [gf(), gf(), gf(), gf()];
        set25519(q[0], X);
        set25519(q[1], Y);
        set25519(q[2], gf1);
        M(q[3], X, Y);
        scalarmult(p, q, s);
      }
      function crypto_sign_keypair(pk, sk, seeded) {
        var d = new Uint8Array(64);
        var p = [gf(), gf(), gf(), gf()];
        var i;
        if (!seeded) randombytes(sk, 32);
        crypto_hash(d, sk, 32);
        d[0] &= 248;
        d[31] &= 127;
        d[31] |= 64;
        scalarbase(p, d);
        pack(pk, p);
        for (i = 0; i < 32; i++) sk[i + 32] = pk[i];
        return 0;
      }
      var L = new Float64Array([237, 211, 245, 92, 26, 99, 18, 88, 214, 156, 247, 162, 222, 249, 222, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 16]);
      function modL(r, x) {
        var carry, i, j, k;
        for (i = 63; i >= 32; --i) {
          carry = 0;
          for (j = i - 32, k = i - 12; j < k; ++j) {
            x[j] += carry - 16 * x[i] * L[j - (i - 32)];
            carry = Math.floor((x[j] + 128) / 256);
            x[j] -= carry * 256;
          }
          x[j] += carry;
          x[i] = 0;
        }
        carry = 0;
        for (j = 0; j < 32; j++) {
          x[j] += carry - (x[31] >> 4) * L[j];
          carry = x[j] >> 8;
          x[j] &= 255;
        }
        for (j = 0; j < 32; j++) x[j] -= carry * L[j];
        for (i = 0; i < 32; i++) {
          x[i + 1] += x[i] >> 8;
          r[i] = x[i] & 255;
        }
      }
      function reduce(r) {
        var x = new Float64Array(64), i;
        for (i = 0; i < 64; i++) x[i] = r[i];
        for (i = 0; i < 64; i++) r[i] = 0;
        modL(r, x);
      }
      function crypto_sign(sm, m, n, sk) {
        var d = new Uint8Array(64), h = new Uint8Array(64), r = new Uint8Array(64);
        var i, j, x = new Float64Array(64);
        var p = [gf(), gf(), gf(), gf()];
        crypto_hash(d, sk, 32);
        d[0] &= 248;
        d[31] &= 127;
        d[31] |= 64;
        var smlen = n + 64;
        for (i = 0; i < n; i++) sm[64 + i] = m[i];
        for (i = 0; i < 32; i++) sm[32 + i] = d[32 + i];
        crypto_hash(r, sm.subarray(32), n + 32);
        reduce(r);
        scalarbase(p, r);
        pack(sm, p);
        for (i = 32; i < 64; i++) sm[i] = sk[i];
        crypto_hash(h, sm, n + 64);
        reduce(h);
        for (i = 0; i < 64; i++) x[i] = 0;
        for (i = 0; i < 32; i++) x[i] = r[i];
        for (i = 0; i < 32; i++) {
          for (j = 0; j < 32; j++) {
            x[i + j] += h[i] * d[j];
          }
        }
        modL(sm.subarray(32), x);
        return smlen;
      }
      function unpackneg(r, p) {
        var t = gf(), chk = gf(), num = gf(), den = gf(), den2 = gf(), den4 = gf(), den6 = gf();
        set25519(r[2], gf1);
        unpack25519(r[1], p);
        S(num, r[1]);
        M(den, num, D);
        Z(num, num, r[2]);
        A(den, r[2], den);
        S(den2, den);
        S(den4, den2);
        M(den6, den4, den2);
        M(t, den6, num);
        M(t, t, den);
        pow2523(t, t);
        M(t, t, num);
        M(t, t, den);
        M(t, t, den);
        M(r[0], t, den);
        S(chk, r[0]);
        M(chk, chk, den);
        if (neq25519(chk, num)) M(r[0], r[0], I);
        S(chk, r[0]);
        M(chk, chk, den);
        if (neq25519(chk, num)) return -1;
        if (par25519(r[0]) === p[31] >> 7) Z(r[0], gf0, r[0]);
        M(r[3], r[0], r[1]);
        return 0;
      }
      function crypto_sign_open(m, sm, n, pk) {
        var i;
        var t = new Uint8Array(32), h = new Uint8Array(64);
        var p = [gf(), gf(), gf(), gf()], q = [gf(), gf(), gf(), gf()];
        if (n < 64) return -1;
        if (unpackneg(q, pk)) return -1;
        for (i = 0; i < n; i++) m[i] = sm[i];
        for (i = 0; i < 32; i++) m[i + 32] = pk[i];
        crypto_hash(h, m, n);
        reduce(h);
        scalarmult(p, q, h);
        scalarbase(q, sm.subarray(32));
        add(p, q);
        pack(t, p);
        n -= 64;
        if (crypto_verify_32(sm, 0, t, 0)) {
          for (i = 0; i < n; i++) m[i] = 0;
          return -1;
        }
        for (i = 0; i < n; i++) m[i] = sm[i + 64];
        return n;
      }
      var crypto_secretbox_KEYBYTES = 32, crypto_secretbox_NONCEBYTES = 24, crypto_secretbox_ZEROBYTES = 32, crypto_secretbox_BOXZEROBYTES = 16, crypto_scalarmult_BYTES = 32, crypto_scalarmult_SCALARBYTES = 32, crypto_box_PUBLICKEYBYTES = 32, crypto_box_SECRETKEYBYTES = 32, crypto_box_BEFORENMBYTES = 32, crypto_box_NONCEBYTES = crypto_secretbox_NONCEBYTES, crypto_box_ZEROBYTES = crypto_secretbox_ZEROBYTES, crypto_box_BOXZEROBYTES = crypto_secretbox_BOXZEROBYTES, crypto_sign_BYTES = 64, crypto_sign_PUBLICKEYBYTES = 32, crypto_sign_SECRETKEYBYTES = 64, crypto_sign_SEEDBYTES = 32, crypto_hash_BYTES = 64;
      nacl2.lowlevel = {
        crypto_core_hsalsa20,
        crypto_stream_xor,
        crypto_stream,
        crypto_stream_salsa20_xor,
        crypto_stream_salsa20,
        crypto_onetimeauth,
        crypto_onetimeauth_verify,
        crypto_verify_16,
        crypto_verify_32,
        crypto_secretbox,
        crypto_secretbox_open,
        crypto_scalarmult,
        crypto_scalarmult_base,
        crypto_box_beforenm,
        crypto_box_afternm,
        crypto_box,
        crypto_box_open,
        crypto_box_keypair,
        crypto_hash,
        crypto_sign,
        crypto_sign_keypair,
        crypto_sign_open,
        crypto_secretbox_KEYBYTES,
        crypto_secretbox_NONCEBYTES,
        crypto_secretbox_ZEROBYTES,
        crypto_secretbox_BOXZEROBYTES,
        crypto_scalarmult_BYTES,
        crypto_scalarmult_SCALARBYTES,
        crypto_box_PUBLICKEYBYTES,
        crypto_box_SECRETKEYBYTES,
        crypto_box_BEFORENMBYTES,
        crypto_box_NONCEBYTES,
        crypto_box_ZEROBYTES,
        crypto_box_BOXZEROBYTES,
        crypto_sign_BYTES,
        crypto_sign_PUBLICKEYBYTES,
        crypto_sign_SECRETKEYBYTES,
        crypto_sign_SEEDBYTES,
        crypto_hash_BYTES,
        gf,
        D,
        L,
        pack25519,
        unpack25519,
        M,
        A,
        S,
        Z,
        pow2523,
        add,
        set25519,
        modL,
        scalarmult,
        scalarbase
      };
      function checkLengths(k, n) {
        if (k.length !== crypto_secretbox_KEYBYTES) throw new Error("bad key size");
        if (n.length !== crypto_secretbox_NONCEBYTES) throw new Error("bad nonce size");
      }
      function checkBoxLengths(pk, sk) {
        if (pk.length !== crypto_box_PUBLICKEYBYTES) throw new Error("bad public key size");
        if (sk.length !== crypto_box_SECRETKEYBYTES) throw new Error("bad secret key size");
      }
      function checkArrayTypes() {
        for (var i = 0; i < arguments.length; i++) {
          if (!(arguments[i] instanceof Uint8Array))
            throw new TypeError("unexpected type, use Uint8Array");
        }
      }
      function cleanup(arr) {
        for (var i = 0; i < arr.length; i++) arr[i] = 0;
      }
      nacl2.randomBytes = function(n) {
        var b = new Uint8Array(n);
        randombytes(b, n);
        return b;
      };
      nacl2.secretbox = function(msg, nonce, key) {
        checkArrayTypes(msg, nonce, key);
        checkLengths(key, nonce);
        var m = new Uint8Array(crypto_secretbox_ZEROBYTES + msg.length);
        var c = new Uint8Array(m.length);
        for (var i = 0; i < msg.length; i++) m[i + crypto_secretbox_ZEROBYTES] = msg[i];
        crypto_secretbox(c, m, m.length, nonce, key);
        return c.subarray(crypto_secretbox_BOXZEROBYTES);
      };
      nacl2.secretbox.open = function(box, nonce, key) {
        checkArrayTypes(box, nonce, key);
        checkLengths(key, nonce);
        var c = new Uint8Array(crypto_secretbox_BOXZEROBYTES + box.length);
        var m = new Uint8Array(c.length);
        for (var i = 0; i < box.length; i++) c[i + crypto_secretbox_BOXZEROBYTES] = box[i];
        if (c.length < 32) return null;
        if (crypto_secretbox_open(m, c, c.length, nonce, key) !== 0) return null;
        return m.subarray(crypto_secretbox_ZEROBYTES);
      };
      nacl2.secretbox.keyLength = crypto_secretbox_KEYBYTES;
      nacl2.secretbox.nonceLength = crypto_secretbox_NONCEBYTES;
      nacl2.secretbox.overheadLength = crypto_secretbox_BOXZEROBYTES;
      nacl2.scalarMult = function(n, p) {
        checkArrayTypes(n, p);
        if (n.length !== crypto_scalarmult_SCALARBYTES) throw new Error("bad n size");
        if (p.length !== crypto_scalarmult_BYTES) throw new Error("bad p size");
        var q = new Uint8Array(crypto_scalarmult_BYTES);
        crypto_scalarmult(q, n, p);
        return q;
      };
      nacl2.scalarMult.base = function(n) {
        checkArrayTypes(n);
        if (n.length !== crypto_scalarmult_SCALARBYTES) throw new Error("bad n size");
        var q = new Uint8Array(crypto_scalarmult_BYTES);
        crypto_scalarmult_base(q, n);
        return q;
      };
      nacl2.scalarMult.scalarLength = crypto_scalarmult_SCALARBYTES;
      nacl2.scalarMult.groupElementLength = crypto_scalarmult_BYTES;
      nacl2.box = function(msg, nonce, publicKey, secretKey) {
        var k = nacl2.box.before(publicKey, secretKey);
        return nacl2.secretbox(msg, nonce, k);
      };
      nacl2.box.before = function(publicKey, secretKey) {
        checkArrayTypes(publicKey, secretKey);
        checkBoxLengths(publicKey, secretKey);
        var k = new Uint8Array(crypto_box_BEFORENMBYTES);
        crypto_box_beforenm(k, publicKey, secretKey);
        return k;
      };
      nacl2.box.after = nacl2.secretbox;
      nacl2.box.open = function(msg, nonce, publicKey, secretKey) {
        var k = nacl2.box.before(publicKey, secretKey);
        return nacl2.secretbox.open(msg, nonce, k);
      };
      nacl2.box.open.after = nacl2.secretbox.open;
      nacl2.box.keyPair = function() {
        var pk = new Uint8Array(crypto_box_PUBLICKEYBYTES);
        var sk = new Uint8Array(crypto_box_SECRETKEYBYTES);
        crypto_box_keypair(pk, sk);
        return { publicKey: pk, secretKey: sk };
      };
      nacl2.box.keyPair.fromSecretKey = function(secretKey) {
        checkArrayTypes(secretKey);
        if (secretKey.length !== crypto_box_SECRETKEYBYTES)
          throw new Error("bad secret key size");
        var pk = new Uint8Array(crypto_box_PUBLICKEYBYTES);
        crypto_scalarmult_base(pk, secretKey);
        return { publicKey: pk, secretKey: new Uint8Array(secretKey) };
      };
      nacl2.box.publicKeyLength = crypto_box_PUBLICKEYBYTES;
      nacl2.box.secretKeyLength = crypto_box_SECRETKEYBYTES;
      nacl2.box.sharedKeyLength = crypto_box_BEFORENMBYTES;
      nacl2.box.nonceLength = crypto_box_NONCEBYTES;
      nacl2.box.overheadLength = nacl2.secretbox.overheadLength;
      nacl2.sign = function(msg, secretKey) {
        checkArrayTypes(msg, secretKey);
        if (secretKey.length !== crypto_sign_SECRETKEYBYTES)
          throw new Error("bad secret key size");
        var signedMsg = new Uint8Array(crypto_sign_BYTES + msg.length);
        crypto_sign(signedMsg, msg, msg.length, secretKey);
        return signedMsg;
      };
      nacl2.sign.open = function(signedMsg, publicKey) {
        checkArrayTypes(signedMsg, publicKey);
        if (publicKey.length !== crypto_sign_PUBLICKEYBYTES)
          throw new Error("bad public key size");
        var tmp = new Uint8Array(signedMsg.length);
        var mlen = crypto_sign_open(tmp, signedMsg, signedMsg.length, publicKey);
        if (mlen < 0) return null;
        var m = new Uint8Array(mlen);
        for (var i = 0; i < m.length; i++) m[i] = tmp[i];
        return m;
      };
      nacl2.sign.detached = function(msg, secretKey) {
        var signedMsg = nacl2.sign(msg, secretKey);
        var sig = new Uint8Array(crypto_sign_BYTES);
        for (var i = 0; i < sig.length; i++) sig[i] = signedMsg[i];
        return sig;
      };
      nacl2.sign.detached.verify = function(msg, sig, publicKey) {
        checkArrayTypes(msg, sig, publicKey);
        if (sig.length !== crypto_sign_BYTES)
          throw new Error("bad signature size");
        if (publicKey.length !== crypto_sign_PUBLICKEYBYTES)
          throw new Error("bad public key size");
        var sm = new Uint8Array(crypto_sign_BYTES + msg.length);
        var m = new Uint8Array(crypto_sign_BYTES + msg.length);
        var i;
        for (i = 0; i < crypto_sign_BYTES; i++) sm[i] = sig[i];
        for (i = 0; i < msg.length; i++) sm[i + crypto_sign_BYTES] = msg[i];
        return crypto_sign_open(m, sm, sm.length, publicKey) >= 0;
      };
      nacl2.sign.keyPair = function() {
        var pk = new Uint8Array(crypto_sign_PUBLICKEYBYTES);
        var sk = new Uint8Array(crypto_sign_SECRETKEYBYTES);
        crypto_sign_keypair(pk, sk);
        return { publicKey: pk, secretKey: sk };
      };
      nacl2.sign.keyPair.fromSecretKey = function(secretKey) {
        checkArrayTypes(secretKey);
        if (secretKey.length !== crypto_sign_SECRETKEYBYTES)
          throw new Error("bad secret key size");
        var pk = new Uint8Array(crypto_sign_PUBLICKEYBYTES);
        for (var i = 0; i < pk.length; i++) pk[i] = secretKey[32 + i];
        return { publicKey: pk, secretKey: new Uint8Array(secretKey) };
      };
      nacl2.sign.keyPair.fromSeed = function(seed) {
        checkArrayTypes(seed);
        if (seed.length !== crypto_sign_SEEDBYTES)
          throw new Error("bad seed size");
        var pk = new Uint8Array(crypto_sign_PUBLICKEYBYTES);
        var sk = new Uint8Array(crypto_sign_SECRETKEYBYTES);
        for (var i = 0; i < 32; i++) sk[i] = seed[i];
        crypto_sign_keypair(pk, sk, true);
        return { publicKey: pk, secretKey: sk };
      };
      nacl2.sign.publicKeyLength = crypto_sign_PUBLICKEYBYTES;
      nacl2.sign.secretKeyLength = crypto_sign_SECRETKEYBYTES;
      nacl2.sign.seedLength = crypto_sign_SEEDBYTES;
      nacl2.sign.signatureLength = crypto_sign_BYTES;
      nacl2.hash = function(msg) {
        checkArrayTypes(msg);
        var h = new Uint8Array(crypto_hash_BYTES);
        crypto_hash(h, msg, msg.length);
        return h;
      };
      nacl2.hash.hashLength = crypto_hash_BYTES;
      nacl2.verify = function(x, y) {
        checkArrayTypes(x, y);
        if (x.length === 0 || y.length === 0) return false;
        if (x.length !== y.length) return false;
        return vn(x, 0, y, 0, x.length) === 0 ? true : false;
      };
      nacl2.setPRNG = function(fn) {
        randombytes = fn;
      };
      (function() {
        var crypto = typeof self !== "undefined" ? self.crypto || self.msCrypto : null;
        if (crypto && crypto.getRandomValues) {
          var QUOTA = 65536;
          nacl2.setPRNG(function(x, n) {
            var i, v = new Uint8Array(n);
            for (i = 0; i < n; i += QUOTA) {
              crypto.getRandomValues(v.subarray(i, i + Math.min(n - i, QUOTA)));
            }
            for (i = 0; i < n; i++) x[i] = v[i];
            cleanup(v);
          });
        } else if (typeof __require !== "undefined") {
          crypto = __require("crypto");
          if (crypto && crypto.randomBytes) {
            nacl2.setPRNG(function(x, n) {
              var i, v = crypto.randomBytes(n);
              for (i = 0; i < n; i++) x[i] = v[i];
              cleanup(v);
            });
          }
        }
      })();
    })(typeof module !== "undefined" && module.exports ? module.exports : self.nacl = self.nacl || {});
  }
});

// ../../dsh-nas-sync/node_modules/scrypt-js/scrypt.js
var require_scrypt = __commonJS({
  "../../dsh-nas-sync/node_modules/scrypt-js/scrypt.js"(exports, module) {
    "use strict";
    (function(root) {
      const MAX_VALUE = 2147483647;
      function SHA256(m) {
        const K = new Uint32Array([
          1116352408,
          1899447441,
          3049323471,
          3921009573,
          961987163,
          1508970993,
          2453635748,
          2870763221,
          3624381080,
          310598401,
          607225278,
          1426881987,
          1925078388,
          2162078206,
          2614888103,
          3248222580,
          3835390401,
          4022224774,
          264347078,
          604807628,
          770255983,
          1249150122,
          1555081692,
          1996064986,
          2554220882,
          2821834349,
          2952996808,
          3210313671,
          3336571891,
          3584528711,
          113926993,
          338241895,
          666307205,
          773529912,
          1294757372,
          1396182291,
          1695183700,
          1986661051,
          2177026350,
          2456956037,
          2730485921,
          2820302411,
          3259730800,
          3345764771,
          3516065817,
          3600352804,
          4094571909,
          275423344,
          430227734,
          506948616,
          659060556,
          883997877,
          958139571,
          1322822218,
          1537002063,
          1747873779,
          1955562222,
          2024104815,
          2227730452,
          2361852424,
          2428436474,
          2756734187,
          3204031479,
          3329325298
        ]);
        let h0 = 1779033703, h1 = 3144134277, h2 = 1013904242, h3 = 2773480762;
        let h4 = 1359893119, h5 = 2600822924, h6 = 528734635, h7 = 1541459225;
        const w = new Uint32Array(64);
        function blocks(p2) {
          let off = 0, len = p2.length;
          while (len >= 64) {
            let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7, u, i2, j, t1, t2;
            for (i2 = 0; i2 < 16; i2++) {
              j = off + i2 * 4;
              w[i2] = (p2[j] & 255) << 24 | (p2[j + 1] & 255) << 16 | (p2[j + 2] & 255) << 8 | p2[j + 3] & 255;
            }
            for (i2 = 16; i2 < 64; i2++) {
              u = w[i2 - 2];
              t1 = (u >>> 17 | u << 32 - 17) ^ (u >>> 19 | u << 32 - 19) ^ u >>> 10;
              u = w[i2 - 15];
              t2 = (u >>> 7 | u << 32 - 7) ^ (u >>> 18 | u << 32 - 18) ^ u >>> 3;
              w[i2] = (t1 + w[i2 - 7] | 0) + (t2 + w[i2 - 16] | 0) | 0;
            }
            for (i2 = 0; i2 < 64; i2++) {
              t1 = (((e >>> 6 | e << 32 - 6) ^ (e >>> 11 | e << 32 - 11) ^ (e >>> 25 | e << 32 - 25)) + (e & f ^ ~e & g) | 0) + (h + (K[i2] + w[i2] | 0) | 0) | 0;
              t2 = ((a >>> 2 | a << 32 - 2) ^ (a >>> 13 | a << 32 - 13) ^ (a >>> 22 | a << 32 - 22)) + (a & b ^ a & c ^ b & c) | 0;
              h = g;
              g = f;
              f = e;
              e = d + t1 | 0;
              d = c;
              c = b;
              b = a;
              a = t1 + t2 | 0;
            }
            h0 = h0 + a | 0;
            h1 = h1 + b | 0;
            h2 = h2 + c | 0;
            h3 = h3 + d | 0;
            h4 = h4 + e | 0;
            h5 = h5 + f | 0;
            h6 = h6 + g | 0;
            h7 = h7 + h | 0;
            off += 64;
            len -= 64;
          }
        }
        blocks(m);
        let i, bytesLeft = m.length % 64, bitLenHi = m.length / 536870912 | 0, bitLenLo = m.length << 3, numZeros = bytesLeft < 56 ? 56 : 120, p = m.slice(m.length - bytesLeft, m.length);
        p.push(128);
        for (i = bytesLeft + 1; i < numZeros; i++) {
          p.push(0);
        }
        p.push(bitLenHi >>> 24 & 255);
        p.push(bitLenHi >>> 16 & 255);
        p.push(bitLenHi >>> 8 & 255);
        p.push(bitLenHi >>> 0 & 255);
        p.push(bitLenLo >>> 24 & 255);
        p.push(bitLenLo >>> 16 & 255);
        p.push(bitLenLo >>> 8 & 255);
        p.push(bitLenLo >>> 0 & 255);
        blocks(p);
        return [
          h0 >>> 24 & 255,
          h0 >>> 16 & 255,
          h0 >>> 8 & 255,
          h0 >>> 0 & 255,
          h1 >>> 24 & 255,
          h1 >>> 16 & 255,
          h1 >>> 8 & 255,
          h1 >>> 0 & 255,
          h2 >>> 24 & 255,
          h2 >>> 16 & 255,
          h2 >>> 8 & 255,
          h2 >>> 0 & 255,
          h3 >>> 24 & 255,
          h3 >>> 16 & 255,
          h3 >>> 8 & 255,
          h3 >>> 0 & 255,
          h4 >>> 24 & 255,
          h4 >>> 16 & 255,
          h4 >>> 8 & 255,
          h4 >>> 0 & 255,
          h5 >>> 24 & 255,
          h5 >>> 16 & 255,
          h5 >>> 8 & 255,
          h5 >>> 0 & 255,
          h6 >>> 24 & 255,
          h6 >>> 16 & 255,
          h6 >>> 8 & 255,
          h6 >>> 0 & 255,
          h7 >>> 24 & 255,
          h7 >>> 16 & 255,
          h7 >>> 8 & 255,
          h7 >>> 0 & 255
        ];
      }
      function PBKDF2_HMAC_SHA256_OneIter(password, salt, dkLen) {
        password = password.length <= 64 ? password : SHA256(password);
        const innerLen = 64 + salt.length + 4;
        const inner = new Array(innerLen);
        const outerKey = new Array(64);
        let i;
        let dk = [];
        for (i = 0; i < 64; i++) {
          inner[i] = 54;
        }
        for (i = 0; i < password.length; i++) {
          inner[i] ^= password[i];
        }
        for (i = 0; i < salt.length; i++) {
          inner[64 + i] = salt[i];
        }
        for (i = innerLen - 4; i < innerLen; i++) {
          inner[i] = 0;
        }
        for (i = 0; i < 64; i++) outerKey[i] = 92;
        for (i = 0; i < password.length; i++) outerKey[i] ^= password[i];
        function incrementCounter() {
          for (let i2 = innerLen - 1; i2 >= innerLen - 4; i2--) {
            inner[i2]++;
            if (inner[i2] <= 255) return;
            inner[i2] = 0;
          }
        }
        while (dkLen >= 32) {
          incrementCounter();
          dk = dk.concat(SHA256(outerKey.concat(SHA256(inner))));
          dkLen -= 32;
        }
        if (dkLen > 0) {
          incrementCounter();
          dk = dk.concat(SHA256(outerKey.concat(SHA256(inner))).slice(0, dkLen));
        }
        return dk;
      }
      function blockmix_salsa8(BY, Yi, r, x, _X) {
        let i;
        arraycopy(BY, (2 * r - 1) * 16, _X, 0, 16);
        for (i = 0; i < 2 * r; i++) {
          blockxor(BY, i * 16, _X, 16);
          salsa20_8(_X, x);
          arraycopy(_X, 0, BY, Yi + i * 16, 16);
        }
        for (i = 0; i < r; i++) {
          arraycopy(BY, Yi + i * 2 * 16, BY, i * 16, 16);
        }
        for (i = 0; i < r; i++) {
          arraycopy(BY, Yi + (i * 2 + 1) * 16, BY, (i + r) * 16, 16);
        }
      }
      function R(a, b) {
        return a << b | a >>> 32 - b;
      }
      function salsa20_8(B, x) {
        arraycopy(B, 0, x, 0, 16);
        for (let i = 8; i > 0; i -= 2) {
          x[4] ^= R(x[0] + x[12], 7);
          x[8] ^= R(x[4] + x[0], 9);
          x[12] ^= R(x[8] + x[4], 13);
          x[0] ^= R(x[12] + x[8], 18);
          x[9] ^= R(x[5] + x[1], 7);
          x[13] ^= R(x[9] + x[5], 9);
          x[1] ^= R(x[13] + x[9], 13);
          x[5] ^= R(x[1] + x[13], 18);
          x[14] ^= R(x[10] + x[6], 7);
          x[2] ^= R(x[14] + x[10], 9);
          x[6] ^= R(x[2] + x[14], 13);
          x[10] ^= R(x[6] + x[2], 18);
          x[3] ^= R(x[15] + x[11], 7);
          x[7] ^= R(x[3] + x[15], 9);
          x[11] ^= R(x[7] + x[3], 13);
          x[15] ^= R(x[11] + x[7], 18);
          x[1] ^= R(x[0] + x[3], 7);
          x[2] ^= R(x[1] + x[0], 9);
          x[3] ^= R(x[2] + x[1], 13);
          x[0] ^= R(x[3] + x[2], 18);
          x[6] ^= R(x[5] + x[4], 7);
          x[7] ^= R(x[6] + x[5], 9);
          x[4] ^= R(x[7] + x[6], 13);
          x[5] ^= R(x[4] + x[7], 18);
          x[11] ^= R(x[10] + x[9], 7);
          x[8] ^= R(x[11] + x[10], 9);
          x[9] ^= R(x[8] + x[11], 13);
          x[10] ^= R(x[9] + x[8], 18);
          x[12] ^= R(x[15] + x[14], 7);
          x[13] ^= R(x[12] + x[15], 9);
          x[14] ^= R(x[13] + x[12], 13);
          x[15] ^= R(x[14] + x[13], 18);
        }
        for (let i = 0; i < 16; ++i) {
          B[i] += x[i];
        }
      }
      function blockxor(S, Si, D, len) {
        for (let i = 0; i < len; i++) {
          D[i] ^= S[Si + i];
        }
      }
      function arraycopy(src, srcPos, dest, destPos, length) {
        while (length--) {
          dest[destPos++] = src[srcPos++];
        }
      }
      function checkBufferish(o) {
        if (!o || typeof o.length !== "number") {
          return false;
        }
        for (let i = 0; i < o.length; i++) {
          const v = o[i];
          if (typeof v !== "number" || v % 1 || v < 0 || v >= 256) {
            return false;
          }
        }
        return true;
      }
      function ensureInteger(value, name) {
        if (typeof value !== "number" || value % 1) {
          throw new Error("invalid " + name);
        }
        return value;
      }
      function _scrypt(password, salt, N, r, p, dkLen, callback) {
        N = ensureInteger(N, "N");
        r = ensureInteger(r, "r");
        p = ensureInteger(p, "p");
        dkLen = ensureInteger(dkLen, "dkLen");
        if (N === 0 || (N & N - 1) !== 0) {
          throw new Error("N must be power of 2");
        }
        if (N > MAX_VALUE / 128 / r) {
          throw new Error("N too large");
        }
        if (r > MAX_VALUE / 128 / p) {
          throw new Error("r too large");
        }
        if (!checkBufferish(password)) {
          throw new Error("password must be an array or buffer");
        }
        password = Array.prototype.slice.call(password);
        if (!checkBufferish(salt)) {
          throw new Error("salt must be an array or buffer");
        }
        salt = Array.prototype.slice.call(salt);
        let b = PBKDF2_HMAC_SHA256_OneIter(password, salt, p * 128 * r);
        const B = new Uint32Array(p * 32 * r);
        for (let i = 0; i < B.length; i++) {
          const j = i * 4;
          B[i] = (b[j + 3] & 255) << 24 | (b[j + 2] & 255) << 16 | (b[j + 1] & 255) << 8 | (b[j + 0] & 255) << 0;
        }
        const XY = new Uint32Array(64 * r);
        const V = new Uint32Array(32 * r * N);
        const Yi = 32 * r;
        const x = new Uint32Array(16);
        const _X = new Uint32Array(16);
        const totalOps = p * N * 2;
        let currentOp = 0;
        let lastPercent10 = null;
        let stop = false;
        let state = 0;
        let i0 = 0, i1;
        let Bi;
        const limit = callback ? parseInt(1e3 / r) : 4294967295;
        const nextTick = typeof setImmediate !== "undefined" ? setImmediate : setTimeout;
        const incrementalSMix = function() {
          if (stop) {
            return callback(new Error("cancelled"), currentOp / totalOps);
          }
          let steps;
          switch (state) {
            case 0:
              Bi = i0 * 32 * r;
              arraycopy(B, Bi, XY, 0, Yi);
              state = 1;
              i1 = 0;
            case 1:
              steps = N - i1;
              if (steps > limit) {
                steps = limit;
              }
              for (let i = 0; i < steps; i++) {
                arraycopy(XY, 0, V, (i1 + i) * Yi, Yi);
                blockmix_salsa8(XY, Yi, r, x, _X);
              }
              i1 += steps;
              currentOp += steps;
              if (callback) {
                const percent10 = parseInt(1e3 * currentOp / totalOps);
                if (percent10 !== lastPercent10) {
                  stop = callback(null, currentOp / totalOps);
                  if (stop) {
                    break;
                  }
                  lastPercent10 = percent10;
                }
              }
              if (i1 < N) {
                break;
              }
              i1 = 0;
              state = 2;
            case 2:
              steps = N - i1;
              if (steps > limit) {
                steps = limit;
              }
              for (let i = 0; i < steps; i++) {
                const offset = (2 * r - 1) * 16;
                const j = XY[offset] & N - 1;
                blockxor(V, j * Yi, XY, Yi);
                blockmix_salsa8(XY, Yi, r, x, _X);
              }
              i1 += steps;
              currentOp += steps;
              if (callback) {
                const percent10 = parseInt(1e3 * currentOp / totalOps);
                if (percent10 !== lastPercent10) {
                  stop = callback(null, currentOp / totalOps);
                  if (stop) {
                    break;
                  }
                  lastPercent10 = percent10;
                }
              }
              if (i1 < N) {
                break;
              }
              arraycopy(XY, 0, B, Bi, Yi);
              i0++;
              if (i0 < p) {
                state = 0;
                break;
              }
              b = [];
              for (let i = 0; i < B.length; i++) {
                b.push(B[i] >> 0 & 255);
                b.push(B[i] >> 8 & 255);
                b.push(B[i] >> 16 & 255);
                b.push(B[i] >> 24 & 255);
              }
              const derivedKey = PBKDF2_HMAC_SHA256_OneIter(password, b, dkLen);
              if (callback) {
                callback(null, 1, derivedKey);
              }
              return derivedKey;
          }
          if (callback) {
            nextTick(incrementalSMix);
          }
        };
        if (!callback) {
          while (true) {
            const derivedKey = incrementalSMix();
            if (derivedKey != void 0) {
              return derivedKey;
            }
          }
        }
        incrementalSMix();
      }
      const lib = {
        scrypt: function(password, salt, N, r, p, dkLen, progressCallback) {
          return new Promise(function(resolve3, reject) {
            let lastProgress = 0;
            if (progressCallback) {
              progressCallback(0);
            }
            _scrypt(password, salt, N, r, p, dkLen, function(error, progress, key) {
              if (error) {
                reject(error);
              } else if (key) {
                if (progressCallback && lastProgress !== 1) {
                  progressCallback(1);
                }
                resolve3(new Uint8Array(key));
              } else if (progressCallback && progress !== lastProgress) {
                lastProgress = progress;
                return progressCallback(progress);
              }
            });
          });
        },
        syncScrypt: function(password, salt, N, r, p, dkLen) {
          return new Uint8Array(_scrypt(password, salt, N, r, p, dkLen));
        }
      };
      if (typeof exports !== "undefined") {
        module.exports = lib;
      } else if (typeof define === "function" && define.amd) {
        define(lib);
      } else if (root) {
        if (root.scrypt) {
          root._scrypt = root.scrypt;
        }
        root.scrypt = lib;
      }
    })(exports);
  }
});

// src/sync/engine.ts
import { readFile as readFile3, writeFile as writeFile2, mkdir as mkdir2, rm as rm2 } from "node:fs/promises";
import { stat as stat3 } from "node:fs/promises";
import { createHash as createHash2 } from "node:crypto";

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
import { existsSync, readFileSync } from "node:fs";
import { join as join2, resolve, sep } from "node:path";
import * as os from "node:os";
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
    const p = join2(home, "storages", "workspace.json");
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
  return { local: join2(home, WORKSPACES_DIR, safeName(remotePath)), mapped: true };
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
  return { local: sub.length === 0 ? folder.path : join2(folder.path, sub), folder };
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
  const localPath = join2(home, WORKSPACE_REGISTRY_REL);
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
  const localPath = join2(home, WORKSPACE_REGISTRY_REL);
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
  await mkdir(join2(home, "storages"), { recursive: true });
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
  const root = join2(home, "sessions");
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
    const wdir = join2(root, dir);
    let sessionDirs;
    try {
      sessionDirs = await readdir(wdir);
    } catch {
      continue;
    }
    for (const sid of sessionDirs) {
      const sdir = join2(wdir, sid);
      let files;
      try {
        files = await readdir(sdir);
      } catch {
        continue;
      }
      for (const name of files) {
        if (!SESSION_FILE_RE.test(name)) continue;
        const file = join2(sdir, name);
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
        const target = join2(root, wantDir, sid, name);
        if (target === file) {
          await writeFile(file, out.buf);
          fixed += 1;
          continue;
        }
        await mkdir(join2(root, wantDir, sid), { recursive: true });
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
  const root = join2(home, "sessions");
  const result = { scanned: 0, duplicates: 0, isolated: 0 };
  let projectDirs;
  try {
    projectDirs = (await readdir(root)).filter((d) => d.startsWith("--"));
  } catch {
    return result;
  }
  const preferred = /* @__PURE__ */ new Set();
  try {
    const reg = JSON.parse(await readFile(join2(home, WORKSPACE_REGISTRY_REL), "utf8"));
    const table = reg?.tables?.workspaces ?? {};
    for (const w of Object.values(table)) {
      if (typeof w?.path === "string") preferred.add(encodeCwd(w.path));
    }
  } catch {
  }
  const bySid = /* @__PURE__ */ new Map();
  for (const dir of projectDirs) {
    const wdir = join2(root, dir);
    let sessionDirs;
    try {
      sessionDirs = await readdir(wdir);
    } catch {
      continue;
    }
    for (const sid of sessionDirs) {
      let files;
      try {
        files = await readdir(join2(wdir, sid));
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
        quarantine = join2(home, ".suspect-quarantine", "sessions-dup-" + Date.now());
        await mkdir(quarantine, { recursive: true });
      }
      try {
        await mkdir(join2(quarantine, loser.dir), { recursive: true });
        await rename(join2(root, loser.dir, sid), join2(quarantine, loser.dir, sid));
        result.isolated += 1;
      } catch {
      }
    }
  }
  return result;
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
function skillAllowed(rel, filter) {
  if (!filter || filter.length === 0) return true;
  const parts = rel.split("/");
  if (parts[0] !== "skills" || parts.length < 2) return true;
  return filter.includes(parts[1]);
}

// src/sync/crypto.ts
var import_tweetnacl = __toESM(require_nacl_fast(), 1);
var import_scrypt_js = __toESM(require_scrypt(), 1);
import { randomBytes } from "node:crypto";
var SALT_LEN = 16;
var NONCE_LEN = 24;
var MAGIC = new Uint8Array([78, 83, 83, 49]);
var HEADER_LEN = MAGIC.length + SALT_LEN + NONCE_LEN;
var keyCache = /* @__PURE__ */ new Map();
async function deriveKey(passphrase, salt) {
  const cacheKey = passphrase + "|" + Buffer.from(salt).toString("hex");
  const hit = keyCache.get(cacheKey);
  if (hit) return hit;
  const key = await (0, import_scrypt_js.scrypt)(
    new TextEncoder().encode(passphrase),
    salt,
    32768,
    8,
    1,
    32
  );
  keyCache.set(cacheKey, key);
  return key;
}
function isEncrypted(blob) {
  if (blob.length < HEADER_LEN + 16) return false;
  for (let i = 0; i < MAGIC.length; i++) {
    if (blob[i] !== MAGIC[i]) return false;
  }
  return true;
}
var Crypto = class {
  static async encrypt(data, passphrase, salt) {
    if (!passphrase) throw new Error("\u672A\u914D\u7F6E\u52A0\u5BC6\u53E3\u4EE4\uFF08\u8BBE\u7F6E\u91CC\u586B\u5199 passphrase \u540E\u91CD\u8BD5\uFF09");
    const key = await deriveKey(passphrase, salt);
    const nonce = randomBytes(NONCE_LEN);
    const box = import_tweetnacl.default.secretbox(data, nonce, key);
    const out = new Uint8Array(HEADER_LEN + box.length);
    out.set(MAGIC, 0);
    out.set(salt, MAGIC.length);
    out.set(nonce, MAGIC.length + SALT_LEN);
    out.set(box, HEADER_LEN);
    return out;
  }
  static async decrypt(blob, passphrase) {
    if (!isEncrypted(blob)) {
      throw new Error("\u4E0D\u662F NAS \u540C\u6B65\u7684\u52A0\u5BC6\u6587\u4EF6\uFF08\u7F3A\u5C11 NSS1 \u5934\uFF09\uFF1A\u8FDC\u7AEF\u6570\u636E\u53EF\u80FD\u6765\u81EA\u65E7\u7248\u672C\u6216\u5DF2\u635F\u574F");
    }
    const salt = blob.slice(MAGIC.length, MAGIC.length + SALT_LEN);
    const nonce = blob.slice(MAGIC.length + SALT_LEN, HEADER_LEN);
    const box = blob.slice(HEADER_LEN);
    const key = await deriveKey(passphrase, salt);
    const plain = import_tweetnacl.default.secretbox.open(box, nonce, key);
    if (!plain) throw new Error("\u89E3\u5BC6\u5931\u8D25\uFF1A\u53E3\u4EE4\u9519\u8BEF\u6216\u6587\u4EF6\u5DF2\u635F\u574F");
    return plain;
  }
};

// src/sync/chunker.ts
var Chunker = class {
  transport;
  opts;
  constructor(transport, opts) {
    this.transport = transport;
    this.opts = opts;
  }
  chunkRemote(base, index) {
    return base + ".part" + String(index).padStart(4, "0");
  }
  /** 上传一段**已加密**的完整密文（含 NSS1 头）。plainHash 由调用方传入。 */
  async upload(cipher, plainHash, plainSize, remotePath) {
    const chunkSize = this.opts.chunkSize;
    const num = Math.max(1, Math.ceil(cipher.length / chunkSize));
    try {
      const prev = await this.transport.getBuffer(remotePath + ".chunk-manifest.json");
      const manifest2 = JSON.parse(new TextDecoder().decode(prev));
      if (manifest2.plainHash === plainHash) {
        let allOk = true;
        for (let i = 0; i < num; i++) {
          const remote = this.chunkRemote(remotePath, i);
          const st = await this.transport.stat(remote);
          const expect = i === num - 1 ? cipher.length - (num - 1) * chunkSize : chunkSize;
          if (!st || st.size !== expect) {
            allOk = false;
            break;
          }
        }
        if (allOk) return;
      }
    } catch {
    }
    const queue = [];
    for (let i = 0; i < num; i++) queue.push(i);
    let active = 0;
    let failed = null;
    await new Promise((resolve3, reject) => {
      const spawn = () => {
        if (failed) return;
        while (queue.length > 0 && active < this.opts.concurrency) {
          const i = queue.shift();
          active++;
          this.uploadOne(cipher, i, remotePath).then(() => {
            active--;
            if (queue.length === 0 && active === 0) resolve3();
            else spawn();
          }).catch((e) => {
            failed = e;
            reject(e);
          });
        }
      };
      spawn();
    });
    const manifest = {
      chunks: Array.from({ length: num }, (_, i) => this.chunkRemote(remotePath, i).split("/").pop()),
      plainHash,
      plainSize
    };
    await this.transport.putBuffer(
      new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
      remotePath + ".chunk-manifest.json",
      { mkdirs: true }
    );
  }
  async uploadOne(cipher, index, remotePath) {
    const remote = this.chunkRemote(remotePath, index);
    const offset = index * this.opts.chunkSize;
    const chunk = cipher.subarray(offset, Math.min(offset + this.opts.chunkSize, cipher.length));
    const st = await this.transport.stat(remote);
    if (st && st.size === chunk.length) return;
    await this.transport.putBuffer(chunk, remote, { mkdirs: true });
  }
  /** 下载：按清单拉全部块拼回密文。返回 { cipher, manifest }。 */
  async download(remotePath) {
    const manifestEnc = await this.transport.getBuffer(remotePath + ".chunk-manifest.json");
    const manifest = JSON.parse(new TextDecoder().decode(manifestEnc));
    const dir = remotePath.slice(0, remotePath.lastIndexOf("/") + 1);
    const parts = [];
    for (const c of manifest.chunks) {
      parts.push(await this.transport.getBuffer(dir + c));
    }
    const total = parts.reduce((s, p) => s + p.length, 0);
    const merged = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      merged.set(p, off);
      off += p.length;
    }
    return { cipher: merged, manifest };
  }
};

// src/sync/merger.ts
var MERGEABLE_EXT = [".yaml", ".yml", ".json", ".md", ".txt", ".csv", ".conf", ".toml"];
function isMergeable(path) {
  const ext = path.toLowerCase().split(".").pop();
  return ext !== void 0 && MERGEABLE_EXT.includes("." + ext);
}

// src/sync/engine.ts
import { join as join4 } from "node:path";
var MANIFEST_REMOTE = "/dsh/manifest.json";
var DEVICES_REMOTE = "/dsh/devices";
var deviceClaimFile = (device) => DEVICES_REMOTE + "/" + device.replace(/[^A-Za-z0-9._-]/g, "_") + ".json";
function sha256Hex(data) {
  return createHash2("sha256").update(data).digest("hex");
}
function prefixOf(rel) {
  const parts = rel.split("/");
  if (parts.length === 0 || !parts[0]) return "";
  if (parts[0] === "custom-folders" && parts[1]) return "custom-folders/" + parts[1];
  return parts[0];
}
function normalizeWorkspaceName(raw) {
  const s = String(raw || "").replace(/[（(][^）)]*[）)]/g, "").replace(/[_\s-]+/g, "").toLowerCase();
  if (s === "\u9ED8\u8BA4\u5DE5\u4F5C\u533A" || s === "defaultworkspace" || s === "default") return "defaultworkspace";
  return s;
}
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
var Engine = class {
  deps;
  scanner;
  chunker;
  running = false;
  abort = null;
  /** scan() 缓存的远端清单（resolve 时回写用） */
  remoteManifest = [];
  /**
   * rel → 本机绝对路径。
   *
   * 绝大多数分类就是 `localOf(rel)`（落在 $DSH_HOME 下）。**唯一例外是自定义文件夹**：
   * 它们的落点由本机配置的映射表决定（电脑上是 `D:\Projects\foo`、手机上可能是别的），
   * 所以必须先按 rel 里的 `<name>` 查表，查不到才回落到 $DSH_HOME。
   *
   * 所有读写路径一律过这里 —— 漏一处就会出现「上传扫的是配置目录、下载却写进 .dsh」
   * 这种一半对一半错的状态。
   */
  resolveLocal(rel) {
    const hit = customFolderLocalOf(rel, this.deps.config.customFolders ?? []);
    return hit ? hit.local : localOf(rel);
  }
  constructor(deps) {
    this.deps = deps;
    this.scanner = new Scanner({
      // r3：分类勾选决定同步哪些子树；includeSensitive 只管子树内部的凭据文件
      scope: deps.config.syncScope,
      includeSensitive: deps.config.includeSensitive,
      // 技能白名单（空 = 全部），只影响 skills/ 下的一级目录
      skillFilter: deps.config.skillFilter,
      // 自定义文件夹映射表：rel 里的名字 → 本机路径，全靠它
      customFolders: deps.config.customFolders
    });
    this.chunker = new Chunker(deps.transport, {
      chunkSize: deps.config.chunkSize,
      concurrency: deps.config.concurrency
    });
  }
  /**
   * 按「文件夹前缀」统计来源设备，供面板在分类/自定义文件夹旁标 emoji。
   *
   * 前缀口径与面板展示一致：
   *   · 分类级 → 该分类在 rel 空间的根（`sessions`、`attachments`、`custom-folders/<name>`…）
   *   · 自定义文件夹 → `custom-folders/<name>`
   *
   * 主数据是 `/dsh/devices/` 下每台设备各自的声明文件（互不覆盖）；
   * 远端清单里的 device 作为兼容兜底。旧条目没有 device 就忽略，不搅浑统计。
   *
   * @returns `{ self, byPrefix }`，`self` 是本机标识（前端据此隐藏本机 emoji）
   */
  async sourceDevices() {
    this.checkReady();
    if (this.remoteManifest.length === 0) {
      try {
        this.remoteManifest = await this.readRemoteManifest();
      } catch {
      }
    }
    const counters = /* @__PURE__ */ new Map();
    const wsCounters = /* @__PURE__ */ new Map();
    const bump = (prefix, device, n) => {
      let m = counters.get(prefix);
      if (!m) {
        m = /* @__PURE__ */ new Map();
        counters.set(prefix, m);
      }
      m.set(device, (m.get(device) ?? 0) + n);
    };
    try {
      const entries = await this.deps.transport.list(DEVICES_REMOTE);
      for (const entry of entries) {
        if (entry.type !== "file" || !entry.name.endsWith(".json")) continue;
        try {
          const raw = await this.deps.transport.getBuffer(DEVICES_REMOTE + "/" + entry.name);
          const claim = JSON.parse(new TextDecoder().decode(raw));
          if (!claim || typeof claim.device !== "string") continue;
          for (const [prefix, n] of Object.entries(claim.prefixes ?? {})) {
            const count = Number(n) || 0;
            if (count > 0) bump(prefix, claim.device, count);
          }
          for (const ws of claim.workspaces ?? []) {
            for (const rawName of [ws?.title, ws?.name]) {
              const key = normalizeWorkspaceName(String(rawName ?? ""));
              if (!key) continue;
              let m = wsCounters.get(key);
              if (!m) {
                m = /* @__PURE__ */ new Map();
                wsCounters.set(key, m);
              }
              m.set(claim.device, 1);
            }
          }
        } catch {
        }
      }
    } catch {
    }
    for (const e of this.remoteManifest) {
      if (!e.device) continue;
      const prefix = prefixOf(e.rel);
      if (prefix) bump(prefix, e.device, 1);
    }
    const byPrefix = {};
    for (const [prefix, m] of counters) {
      byPrefix[prefix] = [...m.entries()].map(([device, files]) => ({ device, files })).sort((a, b) => b.files - a.files);
    }
    const byWorkspace = {};
    for (const [key, m] of wsCounters) {
      byWorkspace[key] = [...m.entries()].map(([device, files]) => ({ device, files })).sort((a, b) => b.files - a.files);
    }
    return { self: selfDevice(), byPrefix, byWorkspace };
  }
  isRunning() {
    return this.running;
  }
  stop() {
    this.abort?.abort();
    this.deps.store.snapshot.phase = "idle";
    this.running = false;
  }
  /** 前置检查：缺 passphrase / 缺 NAS 地址时直接给出可读错误，而不是跑到一半失败。 */
  checkReady() {
    const c = this.deps.config;
    if (!c.passphrase) throw new Error("\u672A\u914D\u7F6E\u52A0\u5BC6\u53E3\u4EE4\uFF1A\u8BF7\u5148\u5728\u8BBE\u7F6E\u91CC\u586B\u5199 passphrase");
    if (c.type === "webdav") {
      if (!c.webdav?.url) throw new Error("\u672A\u914D\u7F6E WebDAV \u5730\u5740\uFF08type=webdav \u4F46 webdav.url \u4E3A\u7A7A\uFF09");
    } else if (!c.mountRoot) {
      throw new Error("\u672A\u914D\u7F6E NAS \u6302\u8F7D\u70B9 mountRoot\uFF08type=mount\uFF09");
    }
  }
  setPhase(p) {
    this.deps.store.snapshot.phase = p;
  }
  async readRemoteManifest() {
    try {
      const enc = await this.deps.transport.getBuffer(MANIFEST_REMOTE);
      const plain = await Crypto.decrypt(enc, this.deps.config.passphrase);
      const list = JSON.parse(new TextDecoder().decode(plain));
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }
  async writeRemoteManifest(entries) {
    const enc = await Crypto.encrypt(
      new TextEncoder().encode(JSON.stringify(entries, null, 2)),
      this.deps.config.passphrase,
      this.deps.store.salt()
    );
    await this.deps.transport.putBuffer(enc, MANIFEST_REMOTE, { mkdirs: true });
  }
  /**
   * 同步完成后写本机声明。明文即可 —— 里面只有目录名和计数，不是敏感数据；
   * 而且明文让 sourceDevices 不用解密就能读，面板刷新更快。
   */
  async writeDeviceClaim(fresh) {
    const prefixes = {};
    for (const e of fresh) {
      const p = prefixOf(e.rel);
      if (p) prefixes[p] = (prefixes[p] ?? 0) + 1;
    }
    const workspaces = [];
    try {
      const raw = JSON.parse(await readFile3(join4(dshHome(), "storages", "workspace.json"), "utf8"));
      for (const w of Object.values(raw?.tables?.workspaces ?? {})) {
        const title = String(w?.title ?? "").trim();
        const p = String(w?.path ?? "");
        const name = p.split(/[\\/]+/).filter(Boolean).pop() ?? "";
        if (title) workspaces.push({ title, name });
      }
    } catch {
    }
    const payload = JSON.stringify({
      device: selfDevice(),
      prefixes,
      workspaces,
      updatedAt: Date.now()
    });
    await this.deps.transport.putBuffer(
      new TextEncoder().encode(payload),
      deviceClaimFile(selfDevice()),
      { mkdirs: true }
    );
  }
  /** 拉取远端某文件并解密（自动识别分块/直传，分块时校验 plainHash）。不存在返回 null。 */
  async fetchRemotePlain(remote) {
    let cipher = null;
    let expectPlainHash = null;
    try {
      const r = await this.chunker.download(remote);
      cipher = r.cipher;
      expectPlainHash = r.manifest.plainHash;
    } catch {
      cipher = null;
    }
    if (!cipher) {
      try {
        cipher = await this.deps.transport.getBuffer(remote);
      } catch {
        return null;
      }
    }
    const plain = await Crypto.decrypt(cipher, this.deps.config.passphrase);
    if (expectPlainHash && sha256Hex(plain) !== expectPlainHash) {
      throw new Error("\u5206\u5757\u91CD\u7EC4\u6821\u9A8C\u5931\u8D25\uFF08plainHash \u4E0D\u5339\u914D\uFF09: " + remote);
    }
    return plain;
  }
  /** 把远端当前版本保存为 .base（三路合并的公共祖先）。失败不阻断主流程。 */
  async saveBase(rel) {
    try {
      const plain = await this.fetchRemotePlain("/dsh/" + rel);
      if (!plain) return;
      const enc = await Crypto.encrypt(plain, this.deps.config.passphrase, this.deps.store.salt());
      await this.deps.transport.putBuffer(enc, "/dsh/" + rel + ".base", { mkdirs: true });
    } catch {
    }
  }
  async scan() {
    this.checkReady();
    this.setPhase("scanning");
    const local = await this.scanner.buildManifest();
    const remote = await this.readRemoteManifest();
    this.remoteManifest = remote;
    const localMap = new Map(local.map((e) => [e.rel, e]));
    const remoteMap = new Map(remote.map((e) => [e.rel, e]));
    const pending = [];
    const conflicts = [];
    const last = this.deps.store.snapshot.lastSyncTime ?? 0;
    for (const [rel, le] of localMap) {
      const re = remoteMap.get(rel);
      if (!re) {
        pending.push({ rel, size: le.size, action: "upload" });
        continue;
      }
      if (le.hash === re.hash) continue;
      const localChanged = le.mtime > last;
      const remoteChanged = re.mtime > last;
      if (localChanged && remoteChanged) {
        conflicts.push({
          rel,
          localMtime: le.mtime,
          remoteMtime: re.mtime,
          localHash: le.hash,
          remoteHash: re.hash,
          mergeable: isMergeable(rel)
        });
      } else if (localChanged || le.mtime > re.mtime) {
        pending.push({ rel, size: le.size, action: "upload" });
      } else {
        pending.push({ rel, size: re.size, action: "download" });
      }
    }
    for (const [rel, re] of remoteMap) {
      if (!localMap.has(rel)) {
        pending.push({ rel, size: re.size, action: "download" });
      }
    }
    const order = (a) => a === "upload" ? 0 : 1;
    pending.sort((a, b) => order(a.action) - order(b.action) || a.size - b.size);
    this.deps.store.pendingFiles = pending;
    this.deps.store.conflicts = conflicts;
    this.deps.store.snapshot.pendingCount = pending.length;
    this.deps.store.snapshot.conflictCount = conflicts.length;
    this.deps.store.save();
    return { local, pending, conflicts };
  }
  async sync(mode) {
    if (this.running) throw new Error("\u540C\u6B65\u4EFB\u52A1\u6B63\u5728\u8FDB\u884C\u4E2D");
    this.checkReady();
    this.running = true;
    this.abort = new AbortController();
    try {
      const { pending } = await this.scan();
      const localMap = new Map((await this.scanner.buildManifest()).map((e) => [e.rel, e]));
      const remoteMap = new Map(this.remoteManifest.map((e) => [e.rel, e]));
      const total = pending.length;
      this.deps.store.snapshot.progress = { total, done: 0, errors: 0 };
      this.deps.store.snapshot.running = true;
      this.deps.store.save();
      let pushed = 0;
      let pulled = 0;
      let mergedRegistry = 0;
      let skippedDownload = 0;
      const remaining = new Set(pending);
      for (const item of pending) {
        if (this.abort.signal.aborted) break;
        try {
          if (mode === "push" && item.action !== "upload") continue;
          if (mode === "pull" && item.action !== "download") continue;
          if (item.action === "upload") {
            await this.pushFile(item.rel, item.size, remoteMap.get(item.rel)?.hash);
            pushed++;
          } else if (item.action === "download") {
            const outcome = await this.downloadEntry(item.rel);
            if (outcome === "written") pulled++;
            else if (outcome === "merged") mergedRegistry++;
            else skippedDownload++;
          }
          this.deps.store.snapshot.progress.done++;
          remaining.delete(item);
        } catch {
          this.deps.store.snapshot.progress.errors++;
        }
        this.deps.store.save();
      }
      if (!this.abort.signal.aborted) {
        try {
          const fix = await repairWorkspaceRegistry();
          if (fix.merged + fix.removed + fix.orderFixed > 0) {
            console.warn(
              "[dsh-nas-sync] \u6CE8\u518C\u8868\u5DF2\u6536\u655B\uFF1A\u5408\u5E76\u5DE5\u4F5C\u533A " + fix.merged + "\u3001\u6E05\u7406\u91CD\u590D session \u5F52\u5C5E " + fix.removed + "\u3001\u4FEE\u6B63\u987A\u5E8F " + fix.orderFixed
            );
          }
        } catch {
        }
        try {
          await repairSessionCwd();
        } catch {
        }
        try {
          const dedup = await dedupeSessionDirs();
          if (dedup.duplicates > 0) {
            console.warn(
              "[dsh-nas-sync] \u4F1A\u8BDD\u76EE\u5F55\u5DF2\u6536\u655B\uFF1A\u91CD\u590D session " + dedup.duplicates + "\u3001\u9694\u79BB\u526F\u672C " + dedup.isolated + "\uFF08\u4FDD\u7559\u5728 .suspect-quarantine\uFF09"
            );
          }
        } catch {
        }
      }
      if (!this.abort.signal.aborted) {
        const fresh = await this.scanner.buildManifest();
        const merged = mergeManifestPreserving(
          fresh,
          this.remoteManifest,
          this.deps.store.localManifest
        );
        await this.writeRemoteManifest(merged);
        this.deps.store.localManifest = fresh;
        this.remoteManifest = merged;
        try {
          await this.writeDeviceClaim(fresh);
        } catch {
        }
        this.deps.store.snapshot.lastSyncTime = Date.now();
        this.deps.store.pendingFiles = [...remaining];
        this.deps.store.snapshot.pendingCount = remaining.size;
      }
      return { pushed, pulled, mergedRegistry, skippedDownload, conflicts: this.deps.store.conflicts.length };
    } finally {
      this.running = false;
      this.deps.store.snapshot.running = false;
      this.setPhase("idle");
      this.deps.store.save();
    }
  }
  /** 上传单个文件（整体密文；大文件走分块）。remoteHash 存在且为可合并文本时先存 .base。 */
  async pushFile(rel, size, remoteHash) {
    this.setPhase("uploading");
    const localAbs = this.resolveLocal(rel);
    const remote = "/dsh/" + rel;
    if (isMergeable(rel) && remoteHash) {
      await this.saveBase(rel);
    }
    const data = await readFile3(localAbs);
    const plainHash = sha256Hex(data);
    const cipher = await Crypto.encrypt(data, this.deps.config.passphrase, this.deps.store.salt());
    if (size >= this.deps.config.chunkThreshold) {
      await this.chunker.upload(cipher, plainHash, size, remote);
    } else {
      await this.deps.transport.putBuffer(cipher, remote, { mkdirs: true });
    }
  }
  /** 下载单个文件并解密写盘。工作区注册表与会话头要额外处理，见各分支注释。 */
  async downloadEntry(rel) {
    this.setPhase("downloading");
    if (isWorkspaceRegistryRel(rel) && workspaceRegistryReady()) {
      return "skipped";
    }
    const plain = await this.fetchRemotePlain("/dsh/" + rel);
    if (!plain) throw new Error("\u8FDC\u7AEF\u4E0D\u5B58\u5728: " + rel);
    if (isWorkspaceRegistryRel(rel)) {
      await mergeWorkspaceRegistry(Buffer.from(plain).toString("utf8"));
      return "merged";
    }
    const localAbs = this.resolveLocal(rel);
    const cut = Math.max(localAbs.lastIndexOf("/"), localAbs.lastIndexOf("\\"));
    await mkdir2(localAbs.slice(0, cut), { recursive: true });
    if (isSessionRel(rel)) {
      const raw = Buffer.from(plain);
      const originalCwd = sessionCwdOf(raw);
      if (originalCwd && platformMismatch(originalCwd)) {
        console.warn("[dsh-nas-sync] \u8DF3\u8FC7\u5F02\u5E73\u53F0\u4F1A\u8BDD\uFF08\u539F\u59CB cwd=" + originalCwd + "\uFF09: " + rel);
        return "skipped";
      }
      const out = rewriteSessionCwd(raw);
      const localCwd = out ? out.dir : originalCwd ? mapRemotePath(originalCwd).local : null;
      if (localCwd) {
        await mkdir2(localCwd, { recursive: true });
        const parts = rel.split("/");
        const sid = parts[parts.length - 2] ?? "";
        const fileName = parts[parts.length - 1] ?? "";
        const wantDir = encodeCwd(localCwd);
        const targetRel = wantDir === parts[1] ? rel : ["sessions", wantDir, sid, fileName].join("/");
        const target = this.resolveLocal(targetRel);
        const cut2 = Math.max(target.lastIndexOf("/"), target.lastIndexOf("\\"));
        await mkdir2(target.slice(0, cut2), { recursive: true });
        await writeFile2(target, out ? out.buf : raw);
        if (target !== localAbs) {
          try {
            await rm2(localAbs.slice(0, cut), { recursive: true, force: true });
          } catch {
          }
        }
        return "written";
      }
      return "skipped";
    }
    await writeFile2(localAbs, plain);
    return "written";
  }
  /** 解决冲突：local = 推本地覆盖远端；remote = 拉远程覆盖本地；skip = 仅移出冲突列表。 */
  async resolve(rel, resolution) {
    this.checkReady();
    const c = this.deps.store.conflicts.find((x) => x.rel === rel);
    if (!c) throw new Error("\u51B2\u7A81\u8BB0\u5F55\u4E0D\u5B58\u5728\uFF1A" + rel);
    if (resolution === "local") {
      const localAbs = this.resolveLocal(rel);
      const st = await stat3(localAbs);
      await this.saveBase(rel);
      await this.pushFile(rel, st.size, c.remoteHash);
      const data = await readFile3(localAbs);
      this.remoteManifest = this.remoteManifest.filter((e) => e.rel !== rel);
      this.remoteManifest.push({
        rel,
        mtime: st.mtimeMs,
        size: st.size,
        hash: sha256Hex(data),
        // 本地版本胜出 = 本机上传，来源记为当前设备
        device: selfDevice()
      });
      await this.writeRemoteManifest(this.remoteManifest);
    } else if (resolution === "remote") {
      const outcome = await this.downloadEntry(rel);
      if (outcome === "skipped") {
        this.deps.store.conflicts = this.deps.store.conflicts.filter((x) => x.rel !== rel);
        this.deps.store.snapshot.conflictCount = this.deps.store.conflicts.length;
        this.deps.store.save();
        return;
      }
      const localAbs = this.resolveLocal(rel);
      const st = await stat3(localAbs);
      const data = await readFile3(localAbs);
      const prevDevice = this.remoteManifest.find((e) => e.rel === rel)?.device;
      this.remoteManifest = this.remoteManifest.filter((e) => e.rel !== rel);
      this.remoteManifest.push({
        rel,
        mtime: st.mtimeMs,
        size: st.size,
        hash: sha256Hex(data),
        device: prevDevice
      });
      await this.writeRemoteManifest(this.remoteManifest);
    }
    this.deps.store.conflicts = this.deps.store.conflicts.filter((x) => x.rel !== rel);
    this.deps.store.snapshot.conflictCount = this.deps.store.conflicts.length;
    this.deps.store.save();
  }
  /** 跳过某个待同步文件（从 pending 中移除，不影响远端）。 */
  async skipPending(rel) {
    this.deps.store.pendingFiles = this.deps.store.pendingFiles.filter((p) => p.rel !== rel);
    this.deps.store.snapshot.pendingCount = this.deps.store.pendingFiles.length;
    this.deps.store.save();
  }
  /** 读取远端某文件明文（供 try_merge / diff 工具复用）。 */
  async readRemoteText(rel) {
    this.checkReady();
    const plain = await this.fetchRemotePlain("/dsh/" + rel);
    return plain ? new TextDecoder().decode(plain) : null;
  }
  /** 读取远端 .base 明文（三路合并公共祖先）。 */
  async readBaseText(rel) {
    this.checkReady();
    const plain = await this.fetchRemotePlain("/dsh/" + rel + ".base");
    return plain ? new TextDecoder().decode(plain) : "";
  }
};
export {
  Engine,
  mergeManifestDevices,
  mergeManifestPreserving,
  normalizeWorkspaceName
};
