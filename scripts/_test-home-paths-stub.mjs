/**
 * 离线单测用的 @deepseek-ai/dsh-home-paths 替身。
 *
 * 为什么需要：`src/paths.ts` 直接 import 宿主的 `resolveDshHome()`，但单测
 * 不在 dsh 进程里跑，宿主包不存在 → 打包产物一 import 就 ERR_MODULE_NOT_FOUND
 * （0.3.4 之前 `npm test` 一直因为这个失败，被误认为是"测试本身坏了"）。
 *
 * 测试用例都显式把 `home` 传进 `portable.ts` 的函数，所以这里返回什么不影响
 * 断言；只求「能被解析、不抛错」。
 */
export function resolveDshHome() {
  return process.env.DSH_HOME_TEST || process.env.DSH_HOME || '/tmp/dsh-test-home';
}
