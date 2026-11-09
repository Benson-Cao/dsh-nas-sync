/**
 * 离线单测用的 @deepseek-ai/schemastery 替身。
 *
 * `src/config.ts` 里 schema 只在模块加载时**构造**（`z.object(...)` 那一串），
 * `Store` 本身一行都不用 z。单测只关心 Store 的持久化/迁移行为，所以给一个
 * 「怎么链式调用都返回自身」的 Proxy 就够了，不需要实现真正的校验器。
 */
const anySchema = new Proxy(function () {}, {
  get(_target, prop) {
    if (prop === Symbol.toPrimitive) return () => '';
    if (prop === 'then') return undefined; // 别被当成 thenable
    return anySchema;
  },
  apply() { return anySchema; },
  construct() { return anySchema; },
});

export default anySchema;
