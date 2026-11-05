window.__ModuleLoader__.load({
  id: 'dsh-nas-sync',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useRef } = React;

    const NS = 'nas.sync';
    // 注意：旧 @local/dsh-plugin-nas 也注册 key/id 'nas-sync'，为避免 slot 冲突改用 '-tools' 后缀
    const PANEL_ID = 'nas-sync-tools';

    // ---- 同步内容分类（与服务端 SYNC_CATEGORIES 一一对应，顺序即展示顺序）----
    // 服务端是权威：这里只是为了渲染勾选框；对不上的键服务端会忽略并告警。
    const SCOPE_ORDER = ['sessions', 'workspaces', 'workspaceFiles', 'customFolders', 'sessionTitles', 'attachments', 'skills', 'profiles', 'settings', 'pluginPatch'];
    const SCOPE_DEFAULT = {
      sessions: true, workspaces: true, workspaceFiles: true, customFolders: true, sessionTitles: true, attachments: true, skills: true,
      profiles: false, settings: false, pluginPatch: false,
    };
    const SCOPE_SENSITIVE = { profiles: true, settings: true, pluginPatch: true };

    const zh = {
      panelLabel: 'NAS 同步',
      title: 'NAS 同步',
      subtitle: '把 DSH 的会话、附件、Skills 加密同步到你的 NAS（WebDAV）。',
      needRefresh: '页面没有拿到请求令牌，请退出本页重新进入。',
      refresh: '刷新',
      statusSection: '同步状态',
      lastSync: '上次成功同步',
      never: '从未',
      pending: '待同步',
      conflicts: '冲突',
      running: '进行中',
      idle: '空闲',
      phase: '阶段',
      syncNow: '立即同步',
      syncing: '同步中…',
      stop: '停止',
      testConnection: '测试连接',
      testing: '测试中…',
      connected: 'NAS 连接正常',
      notConnected: '连接失败',
      syncDone: '完成：上传 {pushed}，下载 {pulled}，失败 {errors}，冲突 {conflicts}',
      syncAbortedNote: '（已按要求的方向处理，其余项保留）',
      configSection: '配置',
      cfgType: '方式',
      cfgUrl: 'WebDAV 地址',
      cfgRemote: '远程目录（共享文件夹）',
      cfgRemoteHint: 'NAS 端的共享文件夹名或子路径，如 /dsh-sync 或 /home/DSH备份；留空使用根目录。fnOS/群晖需对该共享文件夹开启 WebDAV 访问。',
      cfgUser: '用户名',
      cfgPass: '密码',
      cfgMount: '挂载点（mount 方式）',
      cfgPassphrase: '加密口令',
      cfgPassphraseHint: '用于加密上传内容，两端必须一致；留空表示维持原值。',
      cfgAuto: '自动同步',
      cfgAutoOff: '关闭',
      cfgPush: '只上传',
      cfgPull: '只下载',
      cfgMirror: '双向',
      cfgInterval: '同步间隔',
      cfgIntervalCustom: '自定义',
      cfgIntervalUnit: '分钟',
      cfgScope: '同步内容',
      cfgScopeHint: '只同步勾选的内容。取消勾选后，已上传到 NAS 的旧文件不会被删除，只是不再参与同步。',
      scopeSensitive: '敏感',
      scopeAll: '全选',
      scopeNone: '全不选',
      skillsLoading: '正在读取技能…',
      skillsEmpty: '没有找到技能（skills/ 目录为空）',
      skillsHint: '只同步勾选的技能。全部勾上时按「全部技能」处理，以后新增的技能会自动包含。',
      skillsAllOn: '（当前 = 全部技能）',
      scopeSessions: '会话记录',
      scopeWorkspaces: '工作区清单',
      scopeWorkspaceFiles: '工作区文件',
      scopeCustomFolders: '自定义文件夹',
      cfgCustomFolders: '自定义文件夹',
      cfgCustomFoldersHint: '名字是两台设备之间的对应关系（同名 = 同一份数据）；路径只在本机生效，两台电脑可以不一样。',
      cfgCustomFolderAdd: '+ 添加文件夹',
      cfgCustomFolderName: '名字',
      cfgCustomFolderPath: '本机路径',
      cfgCustomFolderRemove: '移除',
      scopeSessionTitles: '会话标题',
      scopeAttachments: '附件',
      scopeSkills: '技能',
      scopeProfiles: 'Profile 与插件',
      scopeSettings: '主设置（settings.yaml）',
      scopePluginPatch: '插件补丁（cordis.patch.yml）',
      save: '保存配置',
      saving: '保存中…',
      saved: '已保存',
      pendingSection: '待同步文件',
      empty: '没有待同步的内容。',
      conflictSection: '冲突',
      noConflicts: '没有冲突。',
      keepLocal: '用本地',
      keepRemote: '用远端',
      skipItem: '跳过',
      tryMerge: '尝试合并',
      merged: '已合并写回本地',
      resolved: '已处理',
      error: '错误',
      unknownError: '未知错误',
      passwordKeep: '已设置（留空维持）',
      loadFail: '加载失败',
      // r172：配置首帧为空时的占位文案（见 PanelView 里的 !cfg 守卫）
      loadingCfg: '正在读取 NAS 配置…',
    };

    const en = {
      panelLabel: 'NAS Sync',
      title: 'NAS Sync',
      subtitle: 'Encrypt and sync DSH sessions, attachments and skills to your NAS (WebDAV).',
      needRefresh: 'Page token missing — please leave and reopen this panel.',
      refresh: 'Refresh',
      statusSection: 'Status',
      lastSync: 'Last successful sync',
      never: 'never',
      pending: 'Pending',
      conflicts: 'Conflicts',
      running: 'Running',
      idle: 'Idle',
      phase: 'Phase',
      syncNow: 'Sync now',
      syncing: 'Syncing…',
      stop: 'Stop',
      testConnection: 'Test connection',
      testing: 'Testing…',
      connected: 'NAS connected',
      notConnected: 'Connection failed',
      syncDone: 'Done: pushed {pushed}, pulled {pulled}, {errors} errors, {conflicts} conflicts',
      syncAbortedNote: '(processed in the chosen direction; the rest kept)',
      configSection: 'Configuration',
      cfgType: 'Transport',
      cfgUrl: 'WebDAV URL',
      cfgRemote: 'Remote folder (share)',
      cfgRemoteHint: 'Share name or subpath on your NAS, e.g. /dsh-sync. Leave empty for root. The share must allow WebDAV access on fnOS/Synology.',
      cfgUser: 'Username',
      cfgPass: 'Password',
      cfgMount: 'Mount root (mount mode)',
      cfgPassphrase: 'Encryption passphrase',
      cfgPassphraseHint: 'Encrypts uploads; must match on both devices. Leave empty to keep current.',
      cfgAuto: 'Auto sync',
      cfgAutoOff: 'Off',
      cfgPush: 'Push only',
      cfgPull: 'Pull only',
      cfgMirror: 'Mirror',
      cfgInterval: 'Sync interval',
      cfgIntervalCustom: 'Custom',
      cfgIntervalUnit: 'min',
      cfgScope: 'What to sync',
      cfgScopeHint: 'Only checked categories sync. Unchecking never deletes what is already on the NAS — it just stops being synced.',
      scopeSensitive: 'sensitive',
      scopeAll: 'All',
      scopeNone: 'None',
      skillsLoading: 'Loading skills…',
      skillsEmpty: 'No skills found (skills/ is empty)',
      skillsHint: 'Only checked skills sync. Checking all is treated as "all skills", so skills added later are included automatically.',
      skillsAllOn: '(currently = all skills)',
      scopeSessions: 'Sessions',
      scopeWorkspaces: 'Workspace list',
      scopeWorkspaceFiles: 'Workspace files',
      scopeCustomFolders: 'Custom folders',
      cfgCustomFolders: 'Custom folders',
      cfgCustomFoldersHint: 'Name links the two devices (same name = same data); the path is local only and may differ per machine.',
      cfgCustomFolderAdd: '+ Add folder',
      cfgCustomFolderName: 'Name',
      cfgCustomFolderPath: 'Local path',
      cfgCustomFolderRemove: 'Remove',
      scopeSessionTitles: 'Session titles',
      scopeAttachments: 'Attachments',
      scopeSkills: 'Skills',
      scopeProfiles: 'Profiles & plugins',
      scopeSettings: 'Main settings (settings.yaml)',
      scopePluginPatch: 'Plugin patch (cordis.patch.yml)',
      save: 'Save config',
      saving: 'Saving…',
      saved: 'Saved',
      pendingSection: 'Pending files',
      empty: 'Nothing to sync.',
      conflictSection: 'Conflicts',
      noConflicts: 'No conflicts.',
      keepLocal: 'Keep local',
      keepRemote: 'Keep remote',
      skipItem: 'Skip',
      tryMerge: 'Try merge',
      merged: 'Merged and written locally',
      resolved: 'Resolved',
      error: 'Error',
      unknownError: 'Unknown error',
      passwordKeep: 'Set (leave empty to keep)',
      loadFail: 'Load failed',
      loadingCfg: 'Loading NAS config…',
    };

    function makeT(dict) {
      return (key, params) => {
        let s = dict[key] || key;
        if (params) {
          for (const [k, v] of Object.entries(params)) s = s.split('{' + k + '}').join(String(v));
        }
        return s;
      };
    }

    function api() {
      const token = window.__DSH_NAS_SYNC_TOKEN__;
      const prefix = window.__DSH_NAS_SYNC_PREFIX__ || '/nas-sync-api';
      return {
        ready: typeof token === 'string' && token.length > 0,
        async call(path, options) {
          const o = options || {};
          const res = await fetch(prefix + path, {
            method: o.method || 'GET',
            headers: { 'x-nas-sync-token': token, 'content-type': 'application/json' },
            body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
          });
          const data = await res.json().catch(() => null);
          if (!data) throw new Error('HTTP ' + res.status);
          if (!data.ok) throw new Error((data.error && data.error.message) || 'error');
          return data.value;
        },
      };
    }

    const S = {
      // r4：桌面端把这一栏放进一个 shrink-to-fit 的 flex 列里，原先 920px 的
      // 上限会让右侧空出一大块（实测约占窗口 18%）。这里不再自己限宽，
      // 改为 100% + flex-grow 去吃满宿主给的可用宽度；真正的限宽祖先由
      // widenHostColumn() 在挂载时放开（可逆，见该函数注释）。
      root: { padding: '24px', width: '100%', maxWidth: 'none', margin: 0, flex: '1 1 auto', minWidth: 0, alignSelf: 'stretch', color: 'var(--dsw-alias-label-primary)', fontSize: '13px', lineHeight: 1.5, display: 'flex', flexDirection: 'column', gap: '16px', height: '100%', overflow: 'auto', boxSizing: 'border-box' },
      card: { background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '12px', padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px' },
      title: { margin: 0, fontSize: '16px', fontWeight: 600 },
      subtitle: { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' },
      section: { margin: 0, fontSize: '13px', fontWeight: 600 },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      stat: { display: 'flex', gap: '18px', flexWrap: 'wrap' },
      statItem: { display: 'flex', flexDirection: 'column', gap: '2px' },
      statNum: { fontSize: '18px', fontWeight: 600 },
      statLabel: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' },
      btn: { height: '28px', padding: '0 12px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer', fontSize: '12px' },
      btnPrimary: { background: 'var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-bg-base)', borderColor: 'var(--dsw-alias-brand-primary)' },
      btnDanger: { color: 'var(--dsw-alias-state-error-primary)', borderColor: 'var(--dsw-alias-state-error-primary)', background: 'transparent' },
      btnDisabled: { opacity: 0.5, cursor: 'default' },
      input: { height: '28px', padding: '0 8px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', fontSize: '12px', boxSizing: 'border-box', width: '100%' },
      field: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: '220px', flex: '1 1 220px' },
      label: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' },
      inputNarrow: { height: '28px', padding: '0 8px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', fontSize: '12px', boxSizing: 'border-box', width: '96px' },
      intervalCustomRow: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px' },
      cfBlock: { marginTop: '8px' },
      cfRow: { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' },
      cfName: { height: '28px', padding: '0 8px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', fontSize: '12px', boxSizing: 'border-box', width: '132px', flex: '0 0 auto' },
      cfPath: { height: '28px', padding: '0 8px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', fontSize: '12px', boxSizing: 'border-box', flex: '1 1 auto', minWidth: '0' },
      cfDel: { flex: '0 0 auto', width: '28px', height: '28px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l2)', background: 'none', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', font: 'inherit', fontSize: '14px', lineHeight: '1' },
      hint: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' },
      fileRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', padding: '6px 4px', borderBottom: '1px solid var(--dsw-alias-border-l1)', minHeight: '32px' },
      fileName: { fontFamily: 'monospace', fontSize: '12px', wordBreak: 'break-all', flex: 1 },
      badge: { fontSize: '11px', padding: '2px 8px', borderRadius: '999px', border: '1px solid var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-label-secondary)' },
      scopeList: { display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '2px' },
      scopeRow: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', cursor: 'pointer' },
      scopeHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' },
      scopeBtns: { display: 'flex', gap: '6px' },
      scopeBtn: { fontSize: '11px', lineHeight: '16px', padding: '1px 8px', borderRadius: '999px', border: '1px solid var(--dsw-alias-border-l2)', background: 'none', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', font: 'inherit' },
      skillGroup: { display: 'flex', flexDirection: 'column', gap: '4px' },
      skillList: { display: 'flex', flexDirection: 'column', gap: '4px', marginLeft: '22px', paddingLeft: '10px', borderLeft: '2px solid var(--dsw-alias-border-l1)' },
      skillRow: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', cursor: 'pointer' },
      skillMeta: { color: 'var(--dsw-alias-label-secondary)', fontSize: '11px' },
      // r174：自动同步的四选一平铺按钮（替代原生 select）
      segRow: { display: 'flex', gap: '6px', flexWrap: 'wrap' },
      seg: { height: '28px', padding: '0 12px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer', fontSize: '12px', font: 'inherit', whiteSpace: 'nowrap' },
      segOn: { background: 'var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-bg-base)', borderColor: 'var(--dsw-alias-brand-primary)' },
      // r174：「包含敏感文件」——框在左、字在右，水平一行。
      // 之前用的是 scopeRow 之外的自造 label，checkbox 被 flex 拉伸跑到右边甚至居中。
      checkRow: { display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '8px', fontSize: '12px', cursor: 'pointer', minWidth: '220px', flex: '1 1 220px' },
      // 宿主（DSH Web）里有针对裸 input 的全局样式，复选框会被撑成整行宽、看着像「跑到右边」。
      // 这里把尺寸和外观钉死，不再继承宿主。
      checkBox: { margin: 0, padding: 0, flex: '0 0 auto', width: '16px', height: '16px', minWidth: '16px', accentColor: 'var(--dsw-alias-brand-primary)', cursor: 'pointer' },
      badgeOk: { color: 'var(--dsw-alias-state-success-primary)', borderColor: 'var(--dsw-alias-state-success-primary)' },
      badgeErr: { color: 'var(--dsw-alias-state-error-primary)', borderColor: 'var(--dsw-alias-state-error-primary)' },
      msgErr: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px' },
      msgOk: { color: 'var(--dsw-alias-state-success-primary)', fontSize: '12px' },
    };

    function formatBytes(n) {
      if (!Number.isFinite(n)) return '';
      if (n < 1024) return n + ' B';
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
      return (n / 1024 / 1024).toFixed(1) + ' MB';
    }

    function fmtTime(ms) {
      if (!ms) return null;
      try { return new Date(ms).toLocaleString(); } catch { return String(ms); }
    }

    // ---- 桌面端加宽 -------------------------------------------------------
    // 宿主的设置页把内容列做成「宽度随内容收缩」的 flex 子项，所以我们把自己
    // 的 max-width 放开还不够 —— 真正卡宽度的是祖先节点。这里在挂载时向上找
    // 「第一个显式在限宽的祖先」和「第一个不会长开的 flex 祖先」，各放开一处，
    // 卸载时按原来的 inline 值原样还原。只在本面板显示期间生效，不碰其它设置页。
    // 窄屏（<720px）不启用，避免把手机端布局撑坏。
    function widenHostColumn(el) {
      const undo = [];
      let node = el.parentElement;

      for (let depth = 0; node && depth < 6; depth += 1) {
        const cs = window.getComputedStyle(node);
        const inline = node.style;
        const saved = {};
        let touched = false;

        // ① 显式 max-width（px / %）才是「限宽」；'none' 说明这层不背锅
        if (cs.maxWidth && cs.maxWidth !== 'none' && cs.maxWidth !== '0px') {
          saved.maxWidth = inline.maxWidth;
          inline.setProperty('max-width', 'none', 'important');
          touched = true;
        }

        // ② 是 flex 子项但不会长开 → 让它吃满剩下的横向空间
        const parent = node.parentElement;
        const parentDisplay = parent ? window.getComputedStyle(parent).display : '';
        if (parentDisplay.indexOf('flex') !== -1 && Number(cs.flexGrow) === 0) {
          saved.flexGrow = inline.flexGrow;
          saved.minWidth = inline.minWidth;
          inline.setProperty('flex-grow', '1', 'important');
          inline.setProperty('min-width', '0', 'important');
          touched = true;
        }

        if (touched) {
          undo.push([node, saved]);
          // 放开两处就够；再往上动会波及应用外壳
          if (undo.length >= 2) break;
        }
        node = node.parentElement;
      }

      return function restore() {
        for (let i = 0; i < undo.length; i += 1) {
          const target = undo[i][0];
          const saved = undo[i][1];
          if ('maxWidth' in saved) {
            if (saved.maxWidth) target.style.setProperty('max-width', saved.maxWidth);
            else target.style.removeProperty('max-width');
          }
          if ('flexGrow' in saved) {
            if (saved.flexGrow) target.style.setProperty('flex-grow', saved.flexGrow);
            else target.style.removeProperty('flex-grow');
          }
          if ('minWidth' in saved) {
            if (saved.minWidth) target.style.setProperty('min-width', saved.minWidth);
            else target.style.removeProperty('min-width');
          }
        }
      };
    }

    function PanelView({ t }) {
      const client = useRef(null);
      if (!client.current) client.current = api();
      const c = client.current;

      // 挂载时放开宿主那一层的限宽，卸载时还原（见 widenHostColumn 注释）
      const rootRef = useRef(null);
      useEffect(() => {
        const el = rootRef.current;
        if (!el || window.innerWidth < 720) return undefined;
        return widenHostColumn(el);
      }, []);

      const [snap, setSnap] = useState(null);
      const [cfg, setCfg] = useState(null);
      const [pending, setPending] = useState(null);
      const [conflicts, setConflicts] = useState(null);
      const [busy, setBusy] = useState('');
      const [msg, setMsg] = useState(null); // {kind:'ok'|'err', text}
      const [passDraft, setPassDraft] = useState('');
      const [passSet, setPassSet] = useState(false);
      // 设备上真实存在的技能名单（含体积），用于渲染「技能」下的子勾选框。
      // null = 还没拉到；[] = 拉到了但一个技能都没有。两者要区分开，否则会把
      // 「正在加载」误显示成「你没有装任何技能」。
      const [skills, setSkills] = useState(null);
      // 「自定义间隔」是纯视图状态：当前值不在预设档位里时，自动展开输入框。
      // 用独立 state 而不是把 intervalMin 置成 0/-1 之类的哨兵值 —— 哨兵会被
      // 一并 POST 到后端，触发 schema 的 min(1) 校验失败。
      const [customInterval, setCustomInterval] = useState(false);

      const refreshAll = useCallback(async () => {
        if (!c.ready) return;
        try {
          const st = await c.call('/status');
          setSnap(st.snapshot);
          setCfg(st.config);
          setPassSet(Boolean(st.config.passphraseSet));
          const pd = await c.call('/pending?page=1&pageSize=100');
          setPending(pd);
          const cf = await c.call('/conflicts');
          setConflicts(cf);
          // 技能名单单独拉：它只依赖磁盘上的 skills/ 目录，跟同步状态无关。
          // 失败不阻断整个刷新 —— 面板其它部分仍然可用，只是技能子列表空着。
          try {
            const sk = await c.call('/skills');
            setSkills(Array.isArray(sk && sk.skills) ? sk.skills : []);
          } catch (_) {
            setSkills([]);
          }
        } catch (e) {
          setMsg({ kind: 'err', text: t('loadFail') + '：' + e.message });
        }
      }, [c, t]);

      useEffect(() => { refreshAll(); }, [refreshAll]);
      useEffect(() => {
        const timer = setInterval(() => {
          if (!c.ready) return;
          c.call('/status').then((st) => { setSnap(st.snapshot); setCfg((prev) => prev || st.config); }).catch(() => {});
        }, 5000);
        return () => clearInterval(timer);
      }, [c]);

      if (!c.ready) {
        return h('div', { ref: rootRef, style: S.root }, h('div', { style: S.card, role: 'alert' }, t('needRefresh')));
      }

      // r172：配置还没到手时必须**停下**。下面整片配置区（以及紧随其后的
      // `cfg.syncScope` / `cfg.skillFilter`）直接读 cfg，而 cfg 的初值是 null ——
      // 少这道门，首帧渲染就抛 TypeError: Cannot read properties of null，
      // React 18 会把整棵树卸载 ⇒ 用户看到的就是「点 NAS 同步后整页白屏」。
      // 为什么 r170 才出现：这一版新加的「按分类勾选」在 render 函数体里
      // 先算了 syncScope（不是 JSX 里的条件分支），所以第一次渲染必崩。
      if (!cfg) {
        return h('div', { ref: rootRef, style: S.root }, h('div', { style: S.card }, t('loadingCfg')));
      }

      const running = Boolean(snap && snap.running);
      const phaseText = snap ? snap.phase : '…';

      async function doSync(mode) {
        setBusy('sync');
        setMsg(null);
        try {
          const r = await c.call('/sync', { method: 'POST', body: { mode } });
          setMsg({ kind: 'ok', text: t('syncDone', r) });
        } catch (e) {
          setMsg({ kind: 'err', text: e.message });
        }
        setBusy('');
        refreshAll();
      }
      async function doStop() {
        try { await c.call('/stop', { method: 'POST' }); } catch (e) { setMsg({ kind: 'err', text: e.message }); }
        refreshAll();
      }
      async function doTest() {
        setBusy('test');
        setMsg(null);
        try {
          const r = await c.call('/test', { method: 'POST' });
          if (r.connected) {
            setMsg({ kind: 'ok', text: t('connected') });
          } else {
            // 失败：显示完整失败 log（目标地址、底层错误）
            setMsg({ kind: 'err', text: t('notConnected') + '\n' + (r.message || t('unknownError')) });
          }
        } catch (e) {
          setMsg({ kind: 'err', text: t('notConnected') + '\n' + e.message });
        }
        setBusy('');
      }
      async function saveConfig() {
        setBusy('save');
        setMsg(null);
        try {
          const webdav = { url: cfg.webdav.url, remotePath: cfg.webdav.remotePath || '', username: cfg.webdav.username };
          if (cfg.webdav._pass) webdav.password = cfg.webdav._pass;
          const patch = {
            type: cfg.type,
            webdav,
            mountRoot: cfg.mountRoot,
            autoSync: cfg.autoSync,
            // includeSensitive 不再由面板提交：那个复选框已按用户要求移除。
            // 不提交 = 保持后端原值（默认 false），工具侧仍可显式设置，
            // 避免「界面上看不见但偷偷被翻成 true」这种情况。
            // 分类勾选：整对象提交（服务端做二级合并 + 归一化，缺键会回落默认值）
            syncScope: cfg.syncScope || SCOPE_DEFAULT,
            // 技能白名单：[] = 全部技能（含以后新增的）
            skillFilter: Array.isArray(cfg.skillFilter) ? cfg.skillFilter : [],
            // 自定义文件夹映射表：整表替换（服务端归一化，非法 name/path 会被丢掉）
            customFolders: Array.isArray(cfg.customFolders) ? cfg.customFolders : [],
          };
          if (passDraft) patch.passphrase = passDraft;
          await c.call('/config', { method: 'POST', body: { config: patch } });
          setMsg({ kind: 'ok', text: t('saved') });
          setPassDraft('');
        } catch (e) {
          setMsg({ kind: 'err', text: e.message });
        }
        setBusy('');
        refreshAll();
      }
      async function resolve(file, resolution) {
        setBusy('resolve:' + file);
        setMsg(null);
        try {
          await c.call('/resolve', { method: 'POST', body: { file, resolution } });
          setMsg({ kind: 'ok', text: t('resolved') + '：' + file });
        } catch (e) {
          setMsg({ kind: 'err', text: e.message });
        }
        setBusy('');
        refreshAll();
      }
      async function tryMerge(file) {
        setBusy('merge:' + file);
        setMsg(null);
        try {
          const r = await c.call('/merge', { method: 'POST', body: { file, apply: true } });
          if (r.success && !r.hasConflicts) setMsg({ kind: 'ok', text: t('merged') + '：' + file });
          else if (r.success) setMsg({ kind: 'err', text: '合并完成但仍有冲突块，请手动处理：' + file });
          else setMsg({ kind: 'err', text: r.reason || t('unknownError') });
        } catch (e) {
          setMsg({ kind: 'err', text: e.message });
        }
        setBusy('');
        refreshAll();
      }

      const setCfgField = (path, value) => {
        setCfg((prev) => {
          const next = JSON.parse(JSON.stringify(prev));
          const keys = path.split('.');
          let o = next;
          for (let i = 0; i < keys.length - 1; i++) {
            // 中间层可能不存在（旧 store 里没有 syncScope），必须补一个空对象再往下走
            if (o[keys[i]] == null || typeof o[keys[i]] !== 'object') o[keys[i]] = {};
            o = o[keys[i]];
          }
          o[keys[keys.length - 1]] = value;
          return next;
        });
      };

      // 一键全选/全不选：7 个复选框逐个点太烦。整对象替换（单段路径，setCfgField 直接赋值）。
      const setAllScope = (v) => {
        const all = {};
        for (const k of SCOPE_ORDER) all[k] = v;
        setCfgField('syncScope', all);
      };

      // ---- 自定义文件夹映射表（「自定义文件夹」分类下的第二层）----
      // 每行 = { name, path }。name 决定远端 rel 前缀，path 只在本机生效，
      // 所以两台机器同名不同路径也能对上（见 portable.ts 的 customFolderLocalOf）。
      const customFoldersNow = () => (Array.isArray(cfg.customFolders) ? cfg.customFolders : []);
      const updateCustomFolder = (index, key, value) => {
        const list = customFoldersNow().map((f, i) => (i === index ? Object.assign({}, f, { [key]: value }) : f));
        setCfgField('customFolders', list);
      };
      const addCustomFolder = () => {
        setCfgField('customFolders', customFoldersNow().concat([{ name: '', path: '' }]));
      };
      const removeCustomFolder = (index) => {
        setCfgField('customFolders', customFoldersNow().filter((_, i) => i !== index));
      };

      // ---- 技能白名单（「技能」分类下的第二层）----
      // 空白名单 = 全部技能，所以「当前选中的集合」要把这种情况展开成全部名字。
      const scopeNow = Object.assign({}, SCOPE_DEFAULT, cfg.syncScope || {});
      const skillNames = Array.isArray(skills) ? skills.map((s) => s.name) : [];
      const skillSel = (cfg.skillFilter && cfg.skillFilter.length) ? cfg.skillFilter : skillNames;
      const toggleSkill = (name, on) => {
        const next = on
          ? skillNames.filter((n) => n === name || skillSel.includes(n))
          : skillSel.filter((n) => n !== name);
        // 全勾时收敛成 []（= 全部技能），这样以后新装的技能会自动被同步，
        // 而不是把「当时那 7 个」冻成一份死名单。
        setCfgField('skillFilter', next.length === skillNames.length ? [] : next);
      };

      // ---- 自动同步模式（r174：原生 select → 平铺四按钮）----
      // 为什么不再用 <select>：这个面板是挂在宿主 App 的浮层里渲染的，WebView 的原生
      // 下拉弹层会被浮层/上层窗口吞掉，用户点开只看得见当前项、选不了别的（实拍截图）。
      // 平铺按钮把四个选项一次性摊在页面上，不依赖任何系统弹层。
      // 注意：UI 上是「四选一」，但存储仍是 enabled + mode 两个字段，
      // 所以「关闭」要落成 enabled:false，而不是往下塞一个 mode:'off'（服务端不认识）。
      const autoMode = (cfg.autoSync && cfg.autoSync.enabled)
        ? (cfg.autoSync.mode === 'pull' ? 'pull' : cfg.autoSync.mode === 'mirror' ? 'mirror' : 'push')
        : 'off';
      const setAutoMode = (v) => {
        const intervalMin = (cfg.autoSync && cfg.autoSync.intervalMin) || 30;
        setCfgField('autoSync', v === 'off'
          ? { enabled: false, mode: 'push', intervalMin }
          : { enabled: true, mode: v, intervalMin });
      };

      return h('div', { ref: rootRef, style: S.root },
        // 头部
        h('div', null,
          h('h2', { style: S.title }, t('title')),
          h('p', { style: S.subtitle }, t('subtitle')),
        ),

        // 状态卡
        h('div', { style: S.card },
          h('div', { style: S.row, style: Object.assign({}, S.row, { justifyContent: 'space-between' }) },
            h('h3', { style: S.section }, t('statusSection')),
            h('button', { style: S.btn, onClick: () => refreshAll() }, '↻ ' + t('refresh')),
          ),
          snap
            ? h('div', { style: S.stat },
                h('div', { style: S.statItem },
                  h('span', { style: S.statNum }, String(snap.pendingCount)),
                  h('span', { style: S.statLabel }, t('pending')),
                ),
                h('div', { style: S.statItem },
                  h('span', { style: Object.assign({}, S.statNum, snap.conflictCount ? { color: 'var(--dsw-alias-state-error-primary)' } : {}) }, String(snap.conflictCount)),
                  h('span', { style: S.statLabel }, t('conflicts')),
                ),
                h('div', { style: S.statItem },
                  h('span', { style: S.statNum }, running ? '…' : (snap.lastSyncTime ? '✓' : '—')),
                  h('span', { style: S.statLabel }, t('lastSync') + '：' + (snap.lastSyncTime ? fmtTime(snap.lastSyncTime) : t('never'))),
                ),
                h('div', { style: S.statItem },
                  h('span', { style: S.statNum }, running ? t('running') : t('idle')),
                  h('span', { style: S.statLabel }, t('phase') + '：' + phaseText + (snap.progress && snap.progress.total ? ' (' + snap.progress.done + '/' + snap.progress.total + ')' : '')),
                ),
              )
            : h('div', null, '…'),
          h('div', { style: S.row },
            h('button', { style: Object.assign({}, S.btn, S.btnPrimary, busy === 'sync' ? S.btnDisabled : {}), disabled: busy === 'sync', onClick: () => doSync('mirror') }, busy === 'sync' ? t('syncing') : t('syncNow')),
            running ? h('button', { style: Object.assign({}, S.btn, S.btnDanger), onClick: () => doStop() }, t('stop')) : null,
            h('button', { style: Object.assign({}, S.btn, busy === 'test' ? S.btnDisabled : {}), disabled: busy === 'test', onClick: () => doTest() }, busy === 'test' ? t('testing') : t('testConnection')),
          ),
          msg ? h('div', { role: 'alert', style: Object.assign({ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }, msg.kind === 'ok' ? S.msgOk : S.msgErr) }, msg.text) : null,
        ),

        // 配置卡
        cfg ? h('div', { style: S.card },
          h('h3', { style: S.section }, t('configSection')),
          h('div', { style: S.row },
            h('div', { style: S.field },
              h('label', { style: S.label }, t('cfgType')),
              // r174：与「自动同步」同因 —— 原生 select 的弹层在这块浮层里打不开，
              // 只剩两个选项，索性一起摊成按钮，面板里不再有任何 <select>。
              h('div', { style: S.segRow },
                [['webdav', 'WebDAV'], ['mount', 'mount']].map(([v, label]) => h('button', {
                  key: 'type-' + v,
                  type: 'button',
                  'data-sync-type': v,
                  style: Object.assign({}, S.seg, cfg.type === v ? S.segOn : null),
                  onClick: () => setCfgField('type', v),
                }, label)),
              ),
            ),
            cfg.type === 'webdav'
              ? h('div', { style: S.field },
                  h('label', { style: S.label }, t('cfgUrl')),
                  h('input', { style: S.input, value: cfg.webdav.url || '', placeholder: 'https://nas.local:5006/dav', onChange: (e) => setCfgField('webdav.url', e.target.value) }),
                )
              : h('div', { style: S.field },
                  h('label', { style: S.label }, t('cfgMount')),
                  h('input', { style: S.input, value: cfg.mountRoot || '', onChange: (e) => setCfgField('mountRoot', e.target.value) }),
                ),
          ),
          cfg.type === 'webdav'
            ? h('div', { style: S.row },
                h('div', { style: S.field },
                  h('label', { style: S.label }, t('cfgRemote')),
                  h('input', { style: S.input, value: cfg.webdav.remotePath || '', placeholder: '/dsh-sync', onChange: (e) => setCfgField('webdav.remotePath', e.target.value) }),
                  h('span', { style: S.hint }, t('cfgRemoteHint')),
                ),
              )
            : null,
          cfg.type === 'webdav'
            ? h('div', { style: S.row },
                h('div', { style: S.field },
                  h('label', { style: S.label }, t('cfgUser')),
                  h('input', { style: S.input, value: cfg.webdav.username || '', onChange: (e) => setCfgField('webdav.username', e.target.value) }),
                ),
                h('div', { style: S.field },
                  h('label', { style: S.label }, t('cfgPass') + (cfg.webdav.passwordSet ? '（' + t('passwordKeep') + '）' : '')),
                  // ⚠️ 必须是非受控输入（defaultValue，不能写 value: ''）：
                  //   钉死 value 的受控框每敲一个字符就被 React 重置成空，
                  //   结果只剩**最后一个字符**进了 _pass —— 用户存进去的密码是残缺的，
                  //   表现就是「密码明明没输错却 401」。
                  h('input', { style: S.input, type: 'password', defaultValue: '', onChange: (e) => setCfgField('webdav._pass', e.target.value) }),
                ),
              )
            : null,
          h('div', { style: S.row },
            h('div', { style: S.field },
              h('label', { style: S.label }, t('cfgPassphrase') + (passSet ? '（' + t('passwordKeep') + '）' : '')),
              h('input', { style: S.input, type: 'password', value: passDraft, onChange: (e) => setPassDraft(e.target.value), placeholder: passSet ? '' : 'required' }),
              h('span', { style: S.hint }, t('cfgPassphraseHint')),
            ),
          ),

          // ---- 同步内容：分类勾选（r3）----
          // 服务端 `syncScope` 决定扫描哪些子树；这里只负责勾选与提交。
          // 未勾选的分类既不上传也不下载，且**不会**删除 NAS 上已有的旧文件。
          h('div', { style: S.field, flex: '1 1 100%' },
            h('div', { style: S.scopeHead },
              h('label', { style: S.label }, t('cfgScope')),
              h('div', { style: S.scopeBtns },
                h('button', { type: 'button', style: S.scopeBtn, onClick: () => setAllScope(true) }, t('scopeAll')),
                h('button', { type: 'button', style: S.scopeBtn, onClick: () => setAllScope(false) }, t('scopeNone')),
              ),
            ),
            h('div', { style: S.scopeList },
              SCOPE_ORDER.map((k) => {
                // 用 `=== true` 而不是 `!== false`：后者会把「缺失的键」当成勾选。
                // 一旦服务端返回的 syncScope 不完整（旧配置 / 手工改过 config.json），
                // profiles / settings / pluginPatch 这三个敏感分类就会被默认打开 ——
                // 这与 DEFAULT 里「敏感默认关」的设计正好相反。缺键一律回落常量。
                const scope = Object.assign({}, SCOPE_DEFAULT, cfg.syncScope || {});
                const on = scope[k] === true;
                const keyLabel = 'scope' + k.charAt(0).toUpperCase() + k.slice(1);
                const row = h('label', { key: k, style: S.scopeRow },
                  h('input', { type: 'checkbox', 'data-scope': k, checked: on, onChange: (e) => setCfgField('syncScope.' + k, e.target.checked) }),
                  h('span', null, t(keyLabel)),
                  SCOPE_SENSITIVE[k] ? h('span', { style: S.badge }, t('scopeSensitive')) : null,
                );
                // 「技能」是唯一有第二层的分类：勾上它才展开技能名单，
                // 没勾时藏起来，免得用户以为关掉的技能仍在同步。
                if (k !== 'skills') return row;
                let sub = null;
                if (on) {
                  if (skills === null) {
                    sub = h('div', { style: S.skillMeta }, t('skillsLoading'));
                  } else if (skillNames.length === 0) {
                    sub = h('div', { style: S.skillMeta }, t('skillsEmpty'));
                  } else {
                    sub = h('div', { style: S.skillList },
                      skillNames.map((name) => {
                        const info = skills.find((s) => s.name === name) || {};
                        return h('label', { key: name, style: S.skillRow },
                          h('input', {
                            type: 'checkbox',
                            'data-skill': name,
                            checked: skillSel.includes(name),
                            onChange: (e) => toggleSkill(name, e.target.checked),
                          }),
                          h('span', null, name),
                          h('span', { style: S.skillMeta },
                            (info.files || 0) + ' 个 · ' + formatBytes(info.bytes || 0)),
                        );
                      }),
                      h('span', { style: S.skillMeta },
                        ((cfg.skillFilter && cfg.skillFilter.length) ? '' : t('skillsAllOn')) + ' ' + t('skillsHint')),
                    );
                  }
                }
                return h('div', { key: k + '-wrap', style: S.skillGroup }, row, sub);
              }),
            ),
            h('span', { style: S.hint }, t('cfgScopeHint')),
            // 自定义文件夹编辑器：只在「自定义文件夹」这一类被勾上时展开，
            // 跟「技能」下的明细一致 —— 关掉的分类不该还占着屏幕。
            (Object.assign({}, SCOPE_DEFAULT, cfg.syncScope || {}).customFolders === true)
              ? h('div', { style: S.cfBlock },
                  h('label', { style: S.label }, t('cfgCustomFolders')),
                  h('div', { style: S.hint, marginBottom: '6px' }, t('cfgCustomFoldersHint')),
                  customFoldersNow().map((f, i) =>
                    h('div', { key: 'cf-' + i, style: S.cfRow },
                      h('input', {
                        style: S.cfName,
                        type: 'text',
                        placeholder: t('cfgCustomFolderName'),
                        value: f.name || '',
                        onChange: (e) => updateCustomFolder(i, 'name', e.target.value),
                      }),
                      h('input', {
                        style: S.cfPath,
                        type: 'text',
                        placeholder: t('cfgCustomFolderPath'),
                        value: f.path || '',
                        onChange: (e) => updateCustomFolder(i, 'path', e.target.value),
                      }),
                      h('button', {
                        type: 'button',
                        style: S.cfDel,
                        title: t('cfgCustomFolderRemove'),
                        onClick: () => removeCustomFolder(i),
                      }, '×'),
                    ),
                  ),
                  h('button', { type: 'button', style: S.scopeBtn, onClick: addCustomFolder }, t('cfgCustomFolderAdd')),
                )
              : null,
          ),
          h('div', { style: S.row },
            h('div', { style: S.field },
              h('label', { style: S.label }, t('cfgAuto')),
              // r174：原来是原生 <select>，用户在手机上点开只能看到「只上传」、换不了别的
              // （WebView 里 select 的原生弹层在本面板里被盖住/吞掉）。
              // 改成平铺按钮：一次看到四个选项、点谁是谁，不依赖任何系统弹层。
              h('div', { style: S.segRow },
                [['off', t('cfgAutoOff')], ['push', t('cfgPush')], ['pull', t('cfgPull')], ['mirror', t('cfgMirror')]]
                  .map(([v, label]) => h('button', {
                    key: 'auto-' + v,
                    type: 'button',
                    'data-auto-mode': v,
                    style: Object.assign({}, S.seg, autoMode === v ? S.segOn : null),
                    onClick: () => setAutoMode(v),
                  }, label)),
              ),
            ),
            cfg.autoSync && cfg.autoSync.enabled
              ? (() => {
                  // 间隔也做成平铺按钮：跟上面的「关闭/只上传/只下载/双向」保持同一种交互，
                  // 手机上不用弹系统数字键盘就能改。最后一档「自定义」才展开输入框。
                  const INTERVAL_PRESETS = [5, 15, 30, 60, 120];
                  const cur = Number(cfg.autoSync.intervalMin) || 30;
                  const showCustom = customInterval || INTERVAL_PRESETS.indexOf(cur) === -1;
                  return h('div', { style: S.field },
                    h('label', { style: S.label }, t('cfgInterval')),
                    h('div', { style: S.segRow },
                      INTERVAL_PRESETS.map((v) => h('button', {
                        key: 'iv-' + v,
                        type: 'button',
                        'data-interval': v,
                        style: Object.assign({}, S.seg, (!showCustom && cur === v) ? S.segOn : null),
                        onClick: () => { setCustomInterval(false); setCfgField('autoSync.intervalMin', v); },
                      }, v + ' ' + t('cfgIntervalUnit'))),
                      h('button', {
                        key: 'iv-custom',
                        type: 'button',
                        'data-interval': 'custom',
                        style: Object.assign({}, S.seg, showCustom ? S.segOn : null),
                        onClick: () => setCustomInterval(true),
                      }, t('cfgIntervalCustom')),
                    ),
                    showCustom
                      ? h('div', { style: S.intervalCustomRow },
                          h('input', {
                            style: S.inputNarrow,
                            type: 'number', min: 1, max: 1440,
                            value: cur,
                            onChange: (e) => setCfgField('autoSync.intervalMin', Number(e.target.value) || 30),
                          }),
                          h('span', { style: S.hint }, t('cfgIntervalUnit') + '（1–1440）'),
                        )
                      : null,
                  );
                })()
              : null,
          ),
          h('div', { style: S.row },
            h('button', { style: Object.assign({}, S.btn, S.btnPrimary, busy === 'save' ? S.btnDisabled : {}), disabled: busy === 'save', onClick: () => saveConfig() }, busy === 'save' ? t('saving') : t('save')),
          ),
        ) : null,

        // 待同步
        pending ? h('div', { style: S.card },
          h('h3', { style: S.section }, t('pendingSection') + '（' + pending.total + '）'),
          pending.items.length === 0
            ? h('div', { style: S.hint }, t('empty'))
            : h('div', null, pending.items.map((f) =>
                h('div', { key: f.rel, style: S.fileRow },
                  h('span', { style: S.fileName }, f.rel),
                  h('span', { style: S.badge }, (f.action === 'upload' ? '↑ ' : '↓ ') + formatBytes(f.size)),
                ),
              )),
        ) : null,

        // 冲突
        conflicts ? h('div', { style: S.card },
          h('h3', { style: S.section }, t('conflictSection') + '（' + conflicts.items.length + '）'),
          conflicts.items.length === 0
            ? h('div', { style: S.hint }, t('noConflicts'))
            : h('div', null, conflicts.items.map((cf) =>
                h('div', { key: cf.rel, style: Object.assign({}, S.fileRow, { flexWrap: 'wrap' }) },
                  h('span', { style: S.fileName }, cf.rel),
                  h('span', { style: S.row },
                    cf.mergeable ? h('button', { style: S.btn, disabled: busy === 'merge:' + cf.rel, onClick: () => tryMerge(cf.rel) }, t('tryMerge')) : null,
                    h('button', { style: S.btn, disabled: busy === 'resolve:' + cf.rel, onClick: () => resolve(cf.rel, 'local') }, t('keepLocal')),
                    h('button', { style: S.btn, disabled: busy === 'resolve:' + cf.rel, onClick: () => resolve(cf.rel, 'remote') }, t('keepRemote')),
                    h('button', { style: S.btn, disabled: busy === 'resolve:' + cf.rel, onClick: () => resolve(cf.rel, 'skip') }, t('skipItem')),
                  ),
                ),
              )),
        ) : null,
      );
    }

    function PanelIcon(props) {
      const size = (props && props.size) || 20;
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      },
        h('path', { d: 'M4 8h12l-3-3' }),
        h('path', { d: 'M20 16H8l3 3' }),
        h('path', { d: 'M16 5v3', opacity: 0 }),
      );
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-nas-sync: dictionaries');
      const t = ctx.locale.bind(NS);
      function NasPanel() { return h(PanelView, { t }); }
      function NasPanelIcon(props) { return h(PanelIcon, props); }
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, NasPanel),
      );
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 21, locale: NS, label: () => t('panelLabel') },
          NasPanelIcon,
        ),
      );
    }

    return { inject: ['slots', 'locale'], apply };
  },
});
