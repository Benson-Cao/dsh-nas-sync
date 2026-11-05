/**
 * dsh-nas-sync · 客户端入口（Compose 侧）
 * ----------------------------------------
 * 向 DSH 设置页注册两个插槽：
 *  1. settings.section        —— NAS 同步主面板（状态 + 冲突 + 待同步入口）
 *  2. settings.section.detail —— 待同步文件管理 / 冲突详情（按宿主路由）
 *
 * 接入你现有的 Compose 工程时，把下方 register* 里的 composable 换成
 * 真实的 NasSyncSettingsPage / PendingFilesSheet / ConflictDetailDialog 即可。
 * 这里的默认实现仅做占位，保证编译通过。
 */

import type { DshClientContext } from '@deepseek-ai/dsh-client-core';
import type { DshPluginBridge } from './bridge.js';
import { DefaultBridge } from './bridge.js';

/**
 * 注册设置页 UI。
 * @param ctx       客户端上下文（提供 slots.register）
 * @param bridge    宿主实现的 RPC 桥，必须替换 DefaultBridge
 */
export function registerNasSyncUi(ctx: DshClientContext, bridge?: DshPluginBridge): void {
  const b: DshPluginBridge = bridge ?? new DefaultBridge();

  // 主面板
  ctx.slots.register(
    'settings.section',
    {
      key: 'nas-sync',
      title: 'NAS 同步',
      icon: 'storage',             // 按宿主 icon 枚举替换
      group: 'plugins',
      order: 100,
    },
    () => {
      // 真实实现：
      //   const vm = remember { SyncViewModel(b) }
      //   NasSyncSettingsPage(vm, onOpenPending = { ... }, onOpenConflict = { ... })
      return { kind: 'composable', name: 'NasSyncSettingsPage' };
    },
  );

  // 待同步文件面板（可作为子路由或独立弹层）
  ctx.slots.register(
    'settings.section.detail',
    {
      key: 'nas-sync-pending',
      parent: 'nas-sync',
      title: '待同步文件',
    },
    () => {
      // 真实实现：PendingFilesSheet(vm) { ... }
      return { kind: 'composable', name: 'PendingFilesSheet' };
    },
  );

  // 冲突详情面板
  ctx.slots.register(
    'settings.section.detail',
    {
      key: 'nas-sync-conflicts',
      parent: 'nas-sync',
      title: '冲突记录',
    },
    () => {
      // 真实实现：ConflictDetailDialog(item, vm) { ... }
      return { kind: 'composable', name: 'ConflictDetailDialog' };
    },
  );
}

export { SyncViewModel } from './SyncViewModel.js';
export type { DshPluginBridge } from './bridge.js';
export { DefaultBridge } from './bridge.js';
