/**
 * Client half: the Git panel in the right Sidebar.
 *
 * The panel is a tab type of the right Sidebar (`sidebarRightTabs.register`),
 * so it opens from the sidebar's own guide page, docks like the shipped Files
 * tab, and closes without leaving anything behind. Its body renders in the
 * `sidebar.right.pane.tab` seat, which the sidebar dispatches by the tab's
 * `kind`.
 *
 * Every operation goes to this package's Host half over the `/api/dsh-git`
 * route `rpc.js` answers on. The panel therefore holds no git logic of its own:
 * it sends intent and renders the JSON that comes back, which is the same
 * implementation the agent tools call.
 *
 * @module @local/dsh-git/client
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-git',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { Fragment, useCallback, useEffect, useMemo, useRef, useState } = React;

    /** This package's panel endpoint and the tab type's identity. */
    const PANEL_URL = 'api/dsh-git';
    const TAB_ID = 'dsh-git';
    const LOCALE_NS = 'dsh-git';

    /** How often the panel re-reads the repository while it is open. */
    const POLL_MS = 5000;

    /** The right Sidebar serves one column; keep the diff readable at that width. */
    const DIFF_CHAR_CAP = 60000;

    /** How long to keep waiting for the Host to come back after a settings save. */
    const RELOAD_RETRIES = 6;
    const RELOAD_DELAY_MS = 400;

    /** Groups a repository that resembles nothing still usefully gets. */
    const GITIGNORE_FALLBACK = ['secrets', 'logs', 'editors', 'os'];

    /** Strings this panel renders. Both dictionaries carry every key. */
    const DICTIONARIES = {
      zh: {
        tab: 'Git',
        guide: '查看改动、生成提交说明、提交与推送，不用离开面板。',
        settings: '设置',
        back: '返回',
        branch: '分支',
        upstream: '上游',
        noUpstream: '未设置上游',
        ahead: '领先 {n}',
        behind: '落后 {n}',
        refresh: '刷新',
        staged: '已暂存',
        changes: '改动',
        untracked: '未跟踪',
        conflicted: '冲突',
        stageAll: '全部暂存',
        unstageAll: '全部取消暂存',
        stage: '暂存',
        unstage: '取消暂存',
        discard: '丢弃',
        confirmDiscard: '确认丢弃',
        allChanges: '全部改动',
        commitMessage: '提交说明',
        messagePlaceholder: '留空则根据暂存的改动自动生成',
        generate: '生成说明',
        generating: '生成中…',
        commit: '提交',
        committing: '提交中…',
        pushAfter: '提交后推送',
        push: '推送',
        pull: '拉取',
        fetch: '获取',
        working: '处理中…',
        notRepo: '这里还不是 Git 仓库',
        notRepoHint: '初始化之后就能在这里暂存、提交和推送。',
        init: '初始化仓库',
        initializing: '初始化中…',
        identityMissing: '还没有配置提交身份，Git 无法创建提交。',
        identityHint: '选择写入范围后保存：',
        userName: 'user.name',
        userEmail: 'user.email',
        scopeLocal: '本仓库',
        scopeGlobal: '全局',
        save: '保存',
        saving: '保存中…',
        saved: '已保存，面板正在重载…',
        clean: '工作区是干净的',
        noChanges: '没有改动',
        truncated: '补丁过长，已截断',
        nothingStaged: '还没有暂存任何改动。',
        explain: '解释改动',
        explaining: '正在总结…',
        explanation: '这个文件改了什么',
        localBranches: '本地分支',
        newBranch: '新建分支',
        newBranchPlaceholder: '分支名',
        create: '创建',
        creating: '创建中…',
        switchTo: '切换过去',
        deleteBranch: '删除这个分支',
        confirmDeleteBranch: '确认删除',
        currentBranch: '当前',
        rollback: '回滚上次提交',
        rollbackHint: '撤销最近一次提交，选择它的改动怎么处理：',
        rollbackSoft: '保留改动（已暂存）',
        rollbackMixed: '保留改动（取消暂存）',
        rollbackHard: '丢弃改动',
        rollbackWarning: '已经推送过的提交被撤销会改写历史，之后推送需要 --force-with-lease。',
        rollbackConfirm: '确认',
        language: '生成说明的语言',
        langAuto: '跟随仓库既有提交',
        langEn: '英文',
        langZh: '简体中文',
        style: '提交说明风格',
        styleConventional: 'Conventional Commits（feat: …）',
        stylePlain: '普通祈使句',
        template: '自定义要求 / 模板',
        templateHint: '例如：以模块名开头；或列出固定的审查清单。会追加在默认规则之后，优先级更高。',
        signoff: '提交时添加 Signed-off-by',
        defaultBranch: '默认分支名',
        modelOverride: '生成用的模型（留空用会话默认）',
        provider: 'provider',
        model: 'model',
        saveSettings: '保存设置',
        settingsUnavailable: '这个环境没有配置编辑器，设置无法从这里保存；可以直接改 cordis.patch.yml。',
        gitignore: '.gitignore',
        gitignoreHint: '按仓库里已有的文件推断，勾选后追加写入；已有内容不会被删除。',
        gitignoreWrite: '写入 .gitignore',
        gitignoreWriting: '写入中…',
        gitignoreNone: '没有选择任何分组。',
        gitignoreAdded: '已写入 {n} 条',
        pullDone: '已拉取',
        pushDone: '已推送',
        fetchDone: '已获取',
        initDone: '仓库已初始化',
        commitDone: '已提交 {hash}',
        stageDone: '已暂存',
        unstageDone: '已取消暂存',
        discardDone: '已丢弃',
        savedDone: '已保存',
        branchDone: '已切换到 {name}',
        branchCreated: '已创建 {name}',
        branchDeleted: '已删除 {name}',
        rollbackDone: '已撤销 {hash}',
        rollbackPublished: '撤销的提交已经推送过，推送时需要 --force-with-lease。',
      },
      en: {
        tab: 'Git',
        guide: 'Review changes, generate a commit message, and commit or push without leaving the panel.',
        settings: 'Settings',
        back: 'Back',
        branch: 'Branch',
        upstream: 'Upstream',
        noUpstream: 'No upstream',
        ahead: '{n} ahead',
        behind: '{n} behind',
        refresh: 'Refresh',
        staged: 'Staged',
        changes: 'Changes',
        untracked: 'Untracked',
        conflicted: 'Conflicted',
        stageAll: 'Stage all',
        unstageAll: 'Unstage all',
        stage: 'Stage',
        unstage: 'Unstage',
        discard: 'Discard',
        confirmDiscard: 'Confirm discard',
        allChanges: 'All changes',
        commitMessage: 'Commit message',
        messagePlaceholder: 'Leave empty to generate one from the staged diff',
        generate: 'Generate message',
        generating: 'Generating…',
        commit: 'Commit',
        committing: 'Committing…',
        pushAfter: 'Push after committing',
        push: 'Push',
        pull: 'Pull',
        fetch: 'Fetch',
        working: 'Working…',
        notRepo: 'This directory is not a Git repository',
        notRepoHint: 'Initialize it to stage, commit, and push from here.',
        init: 'Initialize repository',
        initializing: 'Initializing…',
        identityMissing: 'No commit identity is configured, so Git cannot create a commit.',
        identityHint: 'Pick the scope to write, then save:',
        userName: 'user.name',
        userEmail: 'user.email',
        scopeLocal: 'repository',
        scopeGlobal: 'global',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved; the panel is reloading…',
        clean: 'The working tree is clean',
        noChanges: 'No changes',
        truncated: 'Patch truncated',
        nothingStaged: 'Nothing is staged yet.',
        explain: 'Explain change',
        explaining: 'Summarizing…',
        explanation: 'What this file changed',
        localBranches: 'Local branches',
        newBranch: 'New branch',
        newBranchPlaceholder: 'branch name',
        create: 'Create',
        creating: 'Creating…',
        switchTo: 'Switch to it',
        deleteBranch: 'Delete this branch',
        confirmDeleteBranch: 'Confirm delete',
        currentBranch: 'current',
        rollback: 'Undo last commit',
        rollbackHint: 'Undo the most recent commit and choose what happens to its changes:',
        rollbackSoft: 'Keep changes staged',
        rollbackMixed: 'Keep changes unstaged',
        rollbackHard: 'Delete the changes',
        rollbackWarning:
          'Undoing a commit that was already pushed rewrites published history; pushing afterwards needs --force-with-lease.',
        rollbackConfirm: 'Confirm',
        language: 'Commit message language',
        langAuto: "Follow the repository's commits",
        langEn: 'English',
        langZh: 'Simplified Chinese',
        style: 'Commit message style',
        styleConventional: 'Conventional Commits (feat: …)',
        stylePlain: 'Plain imperative sentence',
        template: 'Extra instructions / template',
        templateHint:
          'For example: start with the module name, or list a fixed review checklist. Appended after the default rules, which it overrides.',
        signoff: 'Add Signed-off-by to commits',
        defaultBranch: 'Default branch name',
        modelOverride: 'Model used for generation (blank uses the session default)',
        provider: 'provider',
        model: 'model',
        saveSettings: 'Save settings',
        settingsUnavailable:
          'This deployment exposes no configuration editor, so settings cannot be saved from here; edit cordis.patch.yml instead.',
        gitignore: '.gitignore',
        gitignoreHint:
          'Inferred from the files already in the repository. Selected groups are appended; existing lines are never removed.',
        gitignoreWrite: 'Write .gitignore',
        gitignoreWriting: 'Writing…',
        gitignoreNone: 'No group is selected.',
        gitignoreAdded: 'Wrote {n} entries',
        pullDone: 'Pulled',
        pushDone: 'Pushed',
        fetchDone: 'Fetched',
        initDone: 'Repository initialized',
        commitDone: 'Committed {hash}',
        stageDone: 'Staged',
        unstageDone: 'Unstaged',
        discardDone: 'Discarded',
        savedDone: 'Saved',
        branchDone: 'Switched to {name}',
        branchCreated: 'Created {name}',
        branchDeleted: 'Deleted {name}',
        rollbackDone: 'Undid {hash}',
        rollbackPublished: 'That commit was already pushed, so pushing now needs --force-with-lease.',
      },
    };

    /**
     * Post one endpoint to this package's Host half.
     *
     * The URL is relative, exactly as the shipped RPC client builds its own, so
     * it resolves against whatever mount the page is served from. The route sits
     * behind the shared `/api` prefix, which already applies the Host/Origin
     * fence and browser authentication.
     * @param endpoint - one of the Host half's endpoint names.
     * @param payload - a plain JSON object.
     * @returns the value, or `{ error }` describing why there is none.
     */
    async function askHost(endpoint, payload) {
      try {
        const response = await fetch(PANEL_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ endpoint, ...payload }),
        });
        if (!response.ok) return { error: `the host answered HTTP ${response.status}` };
        const answer = await response.json();
        if (answer === null || typeof answer !== 'object') return { error: 'the host returned a malformed answer' };
        if (answer.ok !== true) return { error: answer.error?.message ?? 'the host refused the request' };
        return { value: answer.value };
      } catch (failure) {
        return { error: failure instanceof Error ? failure.message : String(failure) };
      }
    }

    /** Wait, bounded by the caller's own cancellation checks. */
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    /** The inline Git glyph, drawn with `currentColor` so it follows the theme. */
    function GitIcon({ size = 16 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 64 64',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 6,
          strokeLinecap: 'round',
          'aria-hidden': true,
          style: { display: 'block', flex: '0 0 auto' },
        },
        h('path', { d: 'M32 14v17' }),
        h('path', { d: 'M32 31 19 44' }),
        h('path', { d: 'M32 31v13' }),
        h('circle', { cx: 32, cy: 12, r: 5, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 19, cy: 48, r: 5, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 32, cy: 48, r: 5, fill: 'currentColor', stroke: 'none' }),
      );
    }

    /** The stylesheet the panel mounts with its own subtree, so unmounting removes it. */
    function PanelStyles() {
      return h('style', {
        children: `
.dsg-root { display:flex; flex-direction:column; height:100%; min-height:0; color:var(--dsw-alias-label-primary); font-size:12px; }
.dsg-bar { display:flex; align-items:center; gap:8px; padding:8px 10px; border-bottom:1px solid var(--dsw-alias-border-l1); flex:0 0 auto; }
.dsg-bar-main { display:flex; flex-direction:column; gap:2px; min-width:0; flex:1 1 auto; }
.dsg-branch { display:flex; align-items:center; gap:6px; font-weight:600; font-size:12px; }
.dsg-branch-btn { display:flex; align-items:center; gap:5px; min-width:0; appearance:none; border:1px solid transparent; background:none; color:inherit; font:inherit; font-weight:600; padding:2px 5px; border-radius:6px; cursor:pointer; max-width:100%; }
.dsg-branch-btn:hover:not(:disabled) { border-color:var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); }
.dsg-branch-btn:disabled { cursor:default; }
.dsg-branch-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsg-caret { color:var(--dsw-alias-label-secondary); font-size:9px; }
.dsg-meta { color:var(--dsw-alias-label-secondary); font-size:11px; display:flex; gap:8px; flex-wrap:wrap; padding-left:5px; }
.dsg-badge { border:1px solid var(--dsw-alias-border-l1); border-radius:999px; padding:0 6px; font-size:10px; color:var(--dsw-alias-label-secondary); }
.dsg-btn { appearance:none; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); border-radius:6px; padding:3px 8px; font-size:11px; line-height:1.6; cursor:pointer; font-family:inherit; white-space:nowrap; }
.dsg-btn:hover:not(:disabled) { border-color:var(--dsw-alias-border-l2); }
.dsg-btn:disabled { opacity:.5; cursor:default; }
.dsg-btn-primary { background:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-bg-base); font-weight:600; }
.dsg-btn-danger { color:var(--dsw-alias-state-error-primary); border-color:var(--dsw-alias-state-error-primary); }
.dsg-btn-armed { background:var(--dsw-alias-state-error-primary); color:var(--dsw-alias-bg-base); font-weight:600; padding:2px 6px; font-size:10px; }
.dsg-btn-icon { padding:2px 6px; font-size:12px; }
.dsg-btn-quiet { background:none; border-color:transparent; color:var(--dsw-alias-label-secondary); }
.dsg-btn-quiet:hover:not(:disabled) { border-color:var(--dsw-alias-border-l1); color:var(--dsw-alias-label-primary); }
.dsg-scroll { flex:1 1 auto; min-height:0; overflow:auto; }
.dsg-section { border-bottom:1px solid var(--dsw-alias-border-l1); }
.dsg-section-head { display:flex; align-items:center; gap:6px; padding:6px 10px; color:var(--dsw-alias-label-secondary); font-size:11px; position:sticky; top:0; background:var(--dsw-alias-bg-base); z-index:1; }
.dsg-section-head b { color:var(--dsw-alias-label-primary); font-weight:600; }
.dsg-row { display:flex; align-items:center; gap:6px; padding:3px 10px; }
.dsg-row:hover { background:var(--dsw-alias-bg-layer-1); }
.dsg-row-active { background:var(--dsw-alias-bg-layer-1); box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary); }
.dsg-status { flex:0 0 auto; width:14px; text-align:center; font-weight:700; font-size:11px; }
.dsg-path { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; direction:rtl; text-align:left; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px; cursor:pointer; }
.dsg-path:hover { text-decoration:underline; }
.dsg-diff { border-bottom:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-2); }
.dsg-diff-head { display:flex; align-items:center; gap:6px; padding:5px 10px; font-size:11px; color:var(--dsw-alias-label-secondary); background:var(--dsw-alias-bg-layer-2); }
.dsg-diff-head b { color:var(--dsw-alias-label-primary); font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsg-summary-title { padding:6px 10px 0; font-size:10px; letter-spacing:.04em; text-transform:uppercase; color:var(--dsw-alias-label-secondary); }
.dsg-summary { margin:0; padding:4px 10px 8px; font-size:11px; line-height:1.6; white-space:pre-wrap; font-family:inherit; color:var(--dsw-alias-label-primary); border-bottom:1px dashed var(--dsw-alias-border-l1); }
.dsg-diff-body { margin:0; padding:6px 10px 10px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px; line-height:1.5; white-space:pre; overflow-x:auto; }
.dsg-add { color:var(--dsw-alias-state-success-primary); }
.dsg-del { color:var(--dsw-alias-state-error-primary); }
.dsg-hunk { color:var(--dsw-alias-brand-primary); }
.dsg-dim { color:var(--dsw-alias-label-secondary); }
.dsg-commit { flex:0 0 auto; border-top:1px solid var(--dsw-alias-border-l1); padding:8px 10px; display:flex; flex-direction:column; gap:6px; background:var(--dsw-alias-bg-base); }
.dsg-textarea { width:100%; box-sizing:border-box; resize:vertical; min-height:56px; border:1px solid var(--dsw-alias-border-l1); border-radius:6px; background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px; line-height:1.5; padding:6px; }
.dsg-textarea:focus { outline:none; border-color:var(--dsw-alias-brand-primary); }
.dsg-actions { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.dsg-spacer { flex:1 1 auto; }
.dsg-check { display:flex; align-items:center; gap:4px; color:var(--dsw-alias-label-secondary); font-size:11px; cursor:pointer; }
.dsg-note { padding:6px 10px; font-size:11px; border-radius:6px; margin:8px 10px; display:flex; flex-direction:column; gap:6px; }
.dsg-note-error { background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-state-error-primary); color:var(--dsw-alias-state-error-primary); }
.dsg-note-ok { background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-state-success-primary); color:var(--dsw-alias-state-success-primary); }
.dsg-note-warn { background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-state-warn-primary); color:var(--dsw-alias-label-primary); }
.dsg-empty { padding:20px 14px; text-align:center; color:var(--dsw-alias-label-secondary); display:flex; flex-direction:column; gap:8px; align-items:center; }
.dsg-field { display:flex; align-items:center; gap:6px; }
.dsg-input { flex:1 1 auto; min-width:0; border:1px solid var(--dsw-alias-border-l1); border-radius:6px; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font-size:11px; padding:3px 6px; font-family:inherit; }
.dsg-input:focus { outline:none; border-color:var(--dsw-alias-brand-primary); }
.dsg-label { color:var(--dsw-alias-label-secondary); font-size:11px; flex:0 0 auto; }
.dsg-form { display:flex; flex-direction:column; gap:8px; padding:10px; }
.dsg-form-row { display:flex; flex-direction:column; gap:4px; }
.dsg-form-title { font-weight:600; font-size:11px; margin-top:2px; }
.dsg-divider { border-top:1px solid var(--dsw-alias-border-l1); margin:4px 0; }
.dsg-branch-panel { border-bottom:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); padding:6px 10px 8px; display:flex; flex-direction:column; gap:4px; max-height:45%; overflow:auto; flex:0 0 auto; }
.dsg-branch-row { display:flex; align-items:center; gap:6px; font-size:11px; padding:2px 0; }
.dsg-branch-row-name { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; cursor:pointer; }
.dsg-branch-row-name:hover { text-decoration:underline; }
.dsg-branch-current { color:var(--dsw-alias-brand-primary); font-weight:600; cursor:default; }
.dsg-branch-current:hover { text-decoration:none; }
`,
      });
    }

    /** The chip's title seat: the glyph and label beside it. */
    function makeTabTitle(t) {
      return function GitTabTitle() {
        return h(
          'span',
          { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
          h(GitIcon, { size: 14 }),
          h('span', null, t('tab')),
        );
      };
    }

    /** The single-letter status mark, in the vocabulary git's porcelain uses. */
    function markFor(status) {
      switch (status) {
        case 'modified':
          return 'M';
        case 'added':
          return 'A';
        case 'deleted':
          return 'D';
        case 'renamed':
          return 'R';
        case 'copied':
          return 'C';
        case 'unmerged':
          return 'U';
        default:
          return '•';
      }
    }

    /** Status colour drawn only from theme tokens. */
    function colourFor(status) {
      switch (status) {
        case 'added':
          return 'var(--dsw-alias-state-success-primary)';
        case 'deleted':
        case 'unmerged':
          return 'var(--dsw-alias-state-error-primary)';
        case 'modified':
          return 'var(--dsw-alias-state-warn-primary)';
        default:
          return 'var(--dsw-alias-label-secondary)';
      }
    }

    /** The unified patch, one coloured span per line. */
    function DiffBody({ patch }) {
      const lines = useMemo(() => patch.split('\n'), [patch]);
      return h(
        'pre',
        { className: 'dsg-diff-body' },
        lines.map((line, index) =>
          h(
            'div',
            {
              key: index,
              className: line.startsWith('+')
                ? 'dsg-add'
                : line.startsWith('-')
                  ? 'dsg-del'
                  : line.startsWith('@@')
                    ? 'dsg-hunk'
                    : line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')
                      ? 'dsg-dim'
                      : undefined,
            },
            line === '' ? ' ' : line,
          ),
        ),
      );
    }

    /** One changed path, with the action that moves it across the index boundary. */
    function FileRow({ entry, scope, active, onOpen, onAction, busy, confirming, confirmKey, t }) {
      const isStaged = scope === 'staged';
      const armed = confirming === confirmKey;
      return h(
        'div',
        { className: `dsg-row${active ? ' dsg-row-active' : ''}` },
        h(
          'span',
          { className: 'dsg-status', style: { color: colourFor(entry.status) }, title: entry.status },
          markFor(entry.status),
        ),
        h(
          'span',
          {
            className: 'dsg-path',
            title: entry.path,
            onClick: () => onOpen(isStaged ? 'staged' : 'unstaged', entry.path),
          },
          entry.from ? `${entry.from} → ${entry.path}` : entry.path,
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dsg-btn dsg-btn-icon',
            disabled: busy,
            title: isStaged ? t('unstage') : t('stage'),
            onClick: () => onAction(isStaged ? 'unstage' : 'add', [entry.path]),
          },
          isStaged ? '−' : '+',
        ),
        isStaged
          ? null
          : h(
              'button',
              {
                type: 'button',
                className: `dsg-btn dsg-btn-icon dsg-btn-danger${armed ? ' dsg-btn-armed' : ''}`,
                disabled: busy,
                title: armed ? t('confirmDiscard') : t('discard'),
                onClick: () => onAction('discard', [entry.path], true),
              },
              armed ? t('confirmDiscard') : '⟲',
            ),
      );
    }

    /**
     * Build the panel component.
     * @param t - the bound translate for this plugin's namespace.
     * @returns the component the sidebar renders in its pane seat.
     */
    function makePanel(t) {
      return function GitPanel(props) {
        const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : '';

        const [status, setStatus] = useState(null);
        const [error, setError] = useState('');
        const [notice, setNotice] = useState('');
        const [busy, setBusy] = useState('');
        const [open, setOpen] = useState(null);
        const [patch, setPatch] = useState(null);
        const [summary, setSummary] = useState(null);
        const [message, setMessage] = useState('');
        const [pushAfter, setPushAfter] = useState(false);
        const [confirming, setConfirming] = useState('');
        const [identity, setIdentity] = useState({ scope: 'local', userName: '', userEmail: '' });
        const [view, setView] = useState('changes');
        const [branches, setBranches] = useState(null);
        const [branchOpen, setBranchOpen] = useState(false);
        const [newBranch, setNewBranch] = useState('');
        const [rollbackOpen, setRollbackOpen] = useState(false);
        const [settings, setSettings] = useState(null);
        const [draft, setDraft] = useState(null);
        const [ignorePlan, setIgnorePlan] = useState(null);
        const [ignoreChoice, setIgnoreChoice] = useState(null);
        const mounted = useRef(true);
        const ignoreRef = useRef(null);
        ignoreRef.current = ignoreChoice;

        useEffect(() => {
          mounted.current = true;
          return () => {
            mounted.current = false;
          };
        }, []);

        /** One round trip, already unwrapped into a value or an error. */
        const request = useCallback(
          async (endpoint, payload = {}) => askHost(endpoint, { sessionId, ...payload }),
          [sessionId],
        );

        /** Re-read the repository and fold the identity probe into the same state. */
        const refresh = useCallback(
          async (silent) => {
            const answer = await request('status');
            if (!mounted.current) return undefined;
            if (answer.error) {
              setError(answer.error);
              return undefined;
            }
            setError('');
            setStatus(answer.value);
            setIdentity((current) =>
              current.userName === '' && current.userEmail === ''
                ? { ...current, userName: answer.value.userName ?? '' }
                : current,
            );
            if (!silent) setOpen(null);
            return answer.value;
          },
          [request],
        );

        useEffect(() => {
          void refresh(false);
        }, [refresh]);

        // The repository also changes outside this panel — the agent commits, a
        // branch moves — so re-read it while the tab is on screen.
        useEffect(() => {
          const tick = () => {
            if (document.visibilityState === 'hidden') return;
            if (busy !== '') return;
            void refresh(true);
          };
          const timer = setInterval(tick, POLL_MS);
          return () => clearInterval(timer);
        }, [refresh, busy]);

        /** Clear the transient success note after a moment. */
        useEffect(() => {
          if (notice === '') return undefined;
          const timer = setTimeout(() => setNotice(''), 5000);
          return () => clearTimeout(timer);
        }, [notice]);

        /** Run one mutating operation, then re-read the repository. */
        const act = useCallback(
          async (label, endpoint, payload, report) => {
            setBusy(label);
            setError('');
            const answer = await request(endpoint, payload);
            if (!mounted.current) return undefined;
            setBusy('');
            if (answer.error) {
              setError(answer.error);
              return undefined;
            }
            if (report) setNotice(report(answer.value));
            await refresh(true);
            return answer.value;
          },
          [refresh, request],
        );

        const openDiff = useCallback(
          async (scope, path) => {
            setOpen({ scope, path });
            setPatch(null);
            setSummary(null);
            const answer = await request('diff', { scope, paths: [path], maxBytes: DIFF_CHAR_CAP });
            if (!mounted.current) return;
            if (answer.error) {
              setError(answer.error);
              setPatch(null);
              return;
            }
            setError('');
            setPatch(answer.value);
          },
          [request],
        );

        /** Ask the model what this file's change does, instead of reading it all. */
        const explain = useCallback(async () => {
          if (open === null) return;
          setBusy('explain');
          setError('');
          const answer = await request('explain', { scope: open.scope, path: open.path });
          if (!mounted.current) return;
          setBusy('');
          if (answer.error) {
            setError(answer.error);
            return;
          }
          if (answer.value?.ok !== true) {
            setError(answer.value?.error ?? 'the model returned no explanation');
            return;
          }
          setSummary({ path: open.path, text: answer.value.summary });
        }, [open, request]);

        const onAction = useCallback(
          async (action, paths, destructive) => {
            if (destructive) {
              const key = `${action}:${paths.join(',')}`;
              if (confirming !== key) {
                setConfirming(key);
                return;
              }
              setConfirming('');
            }
            const label = action === 'add' ? 'stage' : action === 'unstage' ? 'unstage' : 'discard';
            const done = label === 'stage' ? 'stageDone' : label === 'unstage' ? 'unstageDone' : 'discardDone';
            await act(label, 'stage', { action, paths }, () => t(done));
          },
          [act, confirming, t],
        );

        const generate = useCallback(async () => {
          setBusy('generate');
          setError('');
          const answer = await request('generateMessage');
          if (!mounted.current) return;
          setBusy('');
          if (answer.error) {
            setError(answer.error);
            return;
          }
          if (answer.value?.ok !== true) {
            setError(answer.value?.error ?? 'the model returned no message');
            return;
          }
          setMessage(answer.value.message);
        }, [request]);

        const commit = useCallback(async () => {
          const trimmed = message.trim();
          const value = await act('commit', 'commit', trimmed === '' ? {} : { message: trimmed }, (result) =>
            t('commitDone').replace('{hash}', result?.shortHash ?? ''),
          );
          if (value?.ok === true) {
            setMessage('');
            setPatch(null);
            setSummary(null);
            setOpen(null);
            if (pushAfter) await act('push', 'sync', { action: 'push' }, () => t('pushDone'));
          }
        }, [act, message, pushAfter, t]);

        const saveIdentity = useCallback(async () => {
          setBusy('save');
          setError('');
          for (const [key, value] of [
            ['user.name', identity.userName],
            ['user.email', identity.userEmail],
          ]) {
            if (value.trim() === '') continue;
            const answer = await request('config', { action: 'set', key, value: value.trim(), scope: identity.scope });
            if (answer.error) {
              if (mounted.current) {
                setBusy('');
                setError(answer.error);
              }
              return;
            }
          }
          if (!mounted.current) return;
          setBusy('');
          setNotice(t('savedDone'));
          await refresh(true);
        }, [identity, refresh, request, t]);

        /** Read the branch list the first time the branch panel opens. */
        const toggleBranches = useCallback(async () => {
          const next = !branchOpen;
          setBranchOpen(next);
          if (!next) return;
          const answer = await request('branch', { action: 'list' });
          if (!mounted.current) return;
          if (answer.error) {
            setError(answer.error);
            return;
          }
          setBranches(answer.value.branches ?? []);
        }, [branchOpen, request]);

        const reloadBranches = useCallback(async () => {
          const answer = await request('branch', { action: 'list' });
          if (mounted.current && answer.value) setBranches(answer.value.branches ?? []);
        }, [request]);

        const switchBranch = useCallback(
          async (name) => {
            await act('branch', 'branch', { action: 'switch', name }, () => t('branchDone').replace('{name}', name));
            if (!mounted.current) return;
            setBranchOpen(false);
            await reloadBranches();
          },
          [act, reloadBranches, t],
        );

        const createBranch = useCallback(async () => {
          const name = newBranch.trim();
          if (name === '') return;
          await act('createBranch', 'branch', { action: 'create', name }, () => t('branchCreated').replace('{name}', name));
          if (!mounted.current) return;
          setNewBranch('');
          setBranchOpen(false);
          await reloadBranches();
        }, [act, newBranch, reloadBranches, t]);

        const deleteBranch = useCallback(
          async (name) => {
            const key = `delete:${name}`;
            if (confirming !== key) {
              setConfirming(key);
              return;
            }
            setConfirming('');
            await act('deleteBranch', 'branch', { action: 'delete', name }, () => t('branchDeleted').replace('{name}', name));
            if (!mounted.current) return;
            await reloadBranches();
          },
          [act, confirming, reloadBranches, t],
        );

        const rollback = useCallback(
          async (mode) => {
            const value = await act('rollback', 'reset', { mode }, (result) =>
              result?.ok === false
                ? ''
                : `${t('rollbackDone').replace('{hash}', result?.undone?.hash ?? '')}${result?.published ? ` — ${t('rollbackPublished')}` : ''}`,
            );
            if (!mounted.current) return;
            setRollbackOpen(false);
            if (value?.ok === true) {
              setPatch(null);
              setSummary(null);
              setOpen(null);
            }
          },
          [act, t],
        );

        /** Read the plugin settings and the `.gitignore` plan together. */
        const loadSettings = useCallback(async () => {
          const [settingsAnswer, planAnswer] = await Promise.all([request('settings'), request('gitignore')]);
          if (!mounted.current) return false;
          if (settingsAnswer.error) {
            setError(settingsAnswer.error);
            return false;
          }
          setSettings(settingsAnswer.value);
          setDraft({ ...settingsAnswer.value.values });
          if (planAnswer.value?.ok === true) {
            setIgnorePlan(planAnswer.value);
            setIgnoreChoice(new Set(planAnswer.value.suggested ?? GITIGNORE_FALLBACK));
          }
          return true;
        }, [request]);

        const openSettings = useCallback(async () => {
          setView('settings');
          setBranchOpen(false);
          setRollbackOpen(false);
          setBusy('settings');
          const loaded = await loadSettings();
          if (!mounted.current) return;
          setBusy('');
          if (!loaded) setView('changes');
        }, [loadSettings]);

        /**
         * Save the settings.
         *
         * The write reconciles the profile, which re-applies this plugin and
         * briefly takes the route down, so a transport failure right after the
         * save is expected: what matters is whether the values read back.
         */
        const saveSettings = useCallback(async () => {
          if (draft === null) return;
          setBusy('saveSettings');
          setError('');
          const answer = await request('settings', { action: 'set', values: draft });
          if (!mounted.current) return;
          if (answer.error === undefined && answer.value?.ok === false) {
            setBusy('');
            setError(answer.value.error);
            return;
          }
          setNotice(t('saved'));
          for (let attempt = 0; attempt < RELOAD_RETRIES; attempt += 1) {
            await wait(RELOAD_DELAY_MS + attempt * RELOAD_DELAY_MS);
            if (!mounted.current) return;
            const check = await request('settings');
            if (check.value !== undefined) {
              setSettings(check.value);
              setDraft({ ...check.value.values });
              setBusy('');
              setNotice(t('savedDone'));
              await refresh(true);
              return;
            }
          }
          if (!mounted.current) return;
          setBusy('');
        }, [draft, refresh, request, t]);

        /** Write the selected `.gitignore` groups. */
        const writeIgnore = useCallback(async () => {
          const chosen = ignoreRef.current;
          const chosenGroups = chosen === null ? [] : [...chosen];
          if (chosenGroups.length === 0) {
            setError(t('gitignoreNone'));
            return;
          }
          setBusy('gitignore');
          setError('');
          const answer = await request('gitignore', { action: 'write', groups: chosenGroups });
          if (!mounted.current) return;
          setBusy('');
          if (answer.error) {
            setError(answer.error);
            return;
          }
          if (answer.value?.ok === false) {
            setError(answer.value.error);
            return;
          }
          if (answer.value?.plan?.ok === true) {
            setIgnorePlan(answer.value.plan);
            setIgnoreChoice(new Set(answer.value.plan.suggested ?? []));
          }
          setNotice(t('gitignoreAdded').replace('{n}', String(answer.value?.added?.length ?? 0)));
          await refresh(true);
        }, [refresh, request, t]);

        const groups = useMemo(() => {
          if (!status?.isRepo) return [];
          return [
            { key: 'conflicted', label: t('conflicted'), entries: status.conflicted ?? [] },
            { key: 'staged', label: t('staged'), entries: status.staged ?? [] },
            { key: 'changes', label: t('changes'), entries: status.unstaged ?? [] },
            {
              key: 'untracked',
              label: t('untracked'),
              entries: (status.untracked ?? []).map((path) => ({ path, status: 'added' })),
            },
          ].filter((group) => group.entries.length > 0);
        }, [status, t]);

        const disabled = busy !== '';
        const stagedCount = (status?.staged ?? []).length;

        const header = h(
          'div',
          { className: 'dsg-bar' },
          h(
            'div',
            { className: 'dsg-bar-main' },
            h(
              'div',
              { className: 'dsg-branch' },
              status?.isRepo
                ? h(
                    'button',
                    { type: 'button', className: 'dsg-branch-btn', disabled, onClick: () => void toggleBranches() },
                    h(GitIcon, { size: 13 }),
                    h(
                      'span',
                      { className: 'dsg-branch-name' },
                      status.branch || (status.detached ? `detached @ ${status.head}` : t('notRepo')),
                    ),
                    h('span', { className: 'dsg-caret' }, branchOpen ? '▲' : '▼'),
                  )
                : h(Fragment, null, h(GitIcon, { size: 13 }), h('span', { className: 'dsg-branch-name' }, t('notRepo'))),
            ),
            status?.isRepo
              ? h(
                  'div',
                  { className: 'dsg-meta' },
                  h('span', null, status.upstream ? `${t('upstream')} ${status.upstream}` : t('noUpstream')),
                  status.ahead > 0
                    ? h('span', { className: 'dsg-badge' }, t('ahead').replace('{n}', String(status.ahead)))
                    : null,
                  status.behind > 0
                    ? h('span', { className: 'dsg-badge' }, t('behind').replace('{n}', String(status.behind)))
                    : null,
                )
              : null,
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsg-btn dsg-btn-icon',
              disabled,
              title: t('refresh'),
              onClick: () => void refresh(false),
            },
            '⟳',
          ),
          h(
            'button',
            {
              type: 'button',
              className: `dsg-btn dsg-btn-icon${view === 'settings' ? ' dsg-btn-primary' : ''}`,
              disabled,
              title: view === 'settings' ? t('back') : t('settings'),
              onClick: () => {
                if (view === 'settings') {
                  setView('changes');
                  void refresh(true);
                } else {
                  void openSettings();
                }
              },
            },
            view === 'settings' ? '←' : '⚙',
          ),
        );

        const branchPanel =
          branchOpen && status?.isRepo
            ? h(
                'div',
                { className: 'dsg-branch-panel' },
                h('div', { className: 'dsg-dim' }, t('localBranches')),
                (branches ?? []).map((entry) =>
                  h(
                    'div',
                    { className: 'dsg-branch-row', key: entry.name },
                    h(
                      'span',
                      {
                        className: `dsg-branch-row-name${entry.current ? ' dsg-branch-current' : ''}`,
                        title: entry.current ? t('currentBranch') : t('switchTo'),
                        onClick: () => {
                          if (!entry.current) void switchBranch(entry.name);
                        },
                      },
                      `${entry.current ? '● ' : '  '}${entry.name}${entry.track ? ` ${entry.track}` : ''}`,
                    ),
                    entry.current
                      ? h('span', { className: 'dsg-dim' }, t('currentBranch'))
                      : h(
                          Fragment,
                          null,
                          h(
                            'button',
                            {
                              type: 'button',
                              className: `dsg-btn dsg-btn-icon dsg-btn-danger${
                                confirming === `delete:${entry.name}` ? ' dsg-btn-armed' : ''
                              }`,
                              disabled,
                              title:
                                confirming === `delete:${entry.name}` ? t('confirmDeleteBranch') : t('deleteBranch'),
                              onClick: () => void deleteBranch(entry.name),
                            },
                            confirming === `delete:${entry.name}` ? t('confirmDeleteBranch') : '×',
                          ),
                          h(
                            'button',
                            { type: 'button', className: 'dsg-btn', disabled, onClick: () => void switchBranch(entry.name) },
                            t('switchTo'),
                          ),
                        ),
                  ),
                ),
                h(
                  'div',
                  { className: 'dsg-field' },
                  h('input', {
                    className: 'dsg-input',
                    placeholder: t('newBranchPlaceholder'),
                    value: newBranch,
                    onChange: (event) => setNewBranch(event.target.value),
                    'aria-label': t('newBranch'),
                  }),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsg-btn',
                      disabled: disabled || newBranch.trim() === '',
                      onClick: () => void createBranch(),
                    },
                    busy === 'createBranch' ? t('creating') : t('create'),
                  ),
                ),
              )
            : null;

        const emptyState = h(
          'div',
          { className: 'dsg-empty' },
          h(GitIcon, { size: 28 }),
          h('div', null, t('notRepo')),
          h('div', { className: 'dsg-dim' }, t('notRepoHint')),
          h(
            'button',
            {
              type: 'button',
              className: 'dsg-btn dsg-btn-primary',
              disabled,
              onClick: () => void act('init', 'init', {}, () => t('initDone')),
            },
            busy === 'init' ? t('initializing') : t('init'),
          ),
        );

        const identityNote = h(
          'div',
          { className: 'dsg-note dsg-note-warn' },
          h('div', null, t('identityMissing')),
          h(
            'div',
            { className: 'dsg-field' },
            h(
              'select',
              {
                className: 'dsg-input',
                style: { flex: '0 0 auto' },
                value: identity.scope,
                onChange: (event) => setIdentity({ ...identity, scope: event.target.value }),
              },
              h('option', { value: 'local' }, t('scopeLocal')),
              h('option', { value: 'global' }, t('scopeGlobal')),
            ),
            h('span', { className: 'dsg-dim' }, t('identityHint')),
          ),
          h(
            'div',
            { className: 'dsg-field' },
            h('input', {
              className: 'dsg-input',
              placeholder: t('userName'),
              value: identity.userName,
              onChange: (event) => setIdentity({ ...identity, userName: event.target.value }),
            }),
            h('input', {
              className: 'dsg-input',
              placeholder: t('userEmail'),
              value: identity.userEmail,
              onChange: (event) => setIdentity({ ...identity, userEmail: event.target.value }),
            }),
            h(
              'button',
              { type: 'button', className: 'dsg-btn', disabled, onClick: () => void saveIdentity() },
              busy === 'save' ? t('saving') : t('save'),
            ),
          ),
        );

        /** The patch and, once asked for, the plain-language summary. */
        const diffPane = (entry) =>
          h(
            'div',
            { className: 'dsg-diff' },
            h(
              'div',
              { className: 'dsg-diff-head' },
              h('b', null, entry.path),
              h('span', { className: 'dsg-spacer' }),
              patch?.truncated ? h('span', { className: 'dsg-dim' }, t('truncated')) : null,
              h(
                'button',
                { type: 'button', className: 'dsg-btn', disabled, onClick: () => void explain() },
                busy === 'explain' ? t('explaining') : t('explain'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsg-btn dsg-btn-icon',
                  onClick: () => {
                    setOpen(null);
                    setPatch(null);
                    setSummary(null);
                  },
                },
                '✕',
              ),
            ),
            summary !== null && summary.path === entry.path
              ? h(
                  Fragment,
                  null,
                  h('div', { className: 'dsg-summary-title' }, t('explanation')),
                  h('pre', { className: 'dsg-summary' }, summary.text),
                )
              : null,
            patch === null ? h('div', { className: 'dsg-empty' }, t('working')) : h(DiffBody, { patch: patch.patch || '' }),
          );

        const changes = h(
          'div',
          { className: 'dsg-scroll' },
          groups.length === 0 ? h('div', { className: 'dsg-empty' }, t('clean')) : null,
          groups.map((group) =>
            h(
              'div',
              { className: 'dsg-section', key: group.key },
              h(
                'div',
                { className: 'dsg-section-head' },
                h('b', null, group.label),
                h('span', null, String(group.entries.length)),
                h('span', { className: 'dsg-spacer' }),
                group.key === 'staged'
                  ? h(
                      'button',
                      { type: 'button', className: 'dsg-btn', disabled, onClick: () => void onAction('unstage') },
                      t('unstageAll'),
                    )
                  : null,
                group.key === 'changes' || group.key === 'untracked'
                  ? h(
                      'button',
                      { type: 'button', className: 'dsg-btn', disabled, onClick: () => void onAction('add') },
                      t('stageAll'),
                    )
                  : null,
              ),
              group.entries.map((entry) =>
                h(
                  Fragment,
                  { key: `${group.key}:${entry.path}` },
                  h(FileRow, {
                    entry,
                    scope: group.key === 'staged' ? 'staged' : group.key,
                    active: open?.path === entry.path,
                    onOpen: openDiff,
                    onAction,
                    busy: disabled,
                    confirming,
                    confirmKey: `discard:${entry.path}`,
                    t,
                  }),
                  open?.path === entry.path ? diffPane(entry) : null,
                ),
              ),
            ),
          ),
        );

        const rollbackRow = h(
          'div',
          null,
          rollbackOpen
            ? h(
                Fragment,
                null,
                h('div', { className: 'dsg-dim' }, t('rollbackHint')),
                h(
                  'div',
                  { className: 'dsg-actions' },
                  h(
                    'button',
                    { type: 'button', className: 'dsg-btn', disabled, onClick: () => void rollback('soft') },
                    t('rollbackSoft'),
                  ),
                  h(
                    'button',
                    { type: 'button', className: 'dsg-btn', disabled, onClick: () => void rollback('mixed') },
                    t('rollbackMixed'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: `dsg-btn dsg-btn-danger${confirming === 'rollback:hard' ? ' dsg-btn-armed' : ''}`,
                      disabled,
                      onClick: () => {
                        if (confirming !== 'rollback:hard') {
                          setConfirming('rollback:hard');
                          return;
                        }
                        setConfirming('');
                        void rollback('hard');
                      },
                    },
                    confirming === 'rollback:hard' ? t('rollbackConfirm') : t('rollbackHard'),
                  ),
                  h(
                    'button',
                    { type: 'button', className: 'dsg-btn dsg-btn-quiet', onClick: () => setRollbackOpen(false) },
                    t('back'),
                  ),
                ),
                h('div', { className: 'dsg-dim' }, t('rollbackWarning')),
              )
            : h(
                'button',
                { type: 'button', className: 'dsg-btn dsg-btn-quiet', disabled, onClick: () => setRollbackOpen(true) },
                t('rollback'),
              ),
        );

        const commitBox = h(
          'div',
          { className: 'dsg-commit' },
          h('textarea', {
            className: 'dsg-textarea',
            rows: 3,
            placeholder: t('messagePlaceholder'),
            value: message,
            onChange: (event) => setMessage(event.target.value),
            'aria-label': t('commitMessage'),
          }),
          h(
            'div',
            { className: 'dsg-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'dsg-btn',
                disabled: disabled || stagedCount === 0,
                onClick: () => void generate(),
              },
              busy === 'generate' ? t('generating') : t('generate'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsg-btn dsg-btn-primary',
                disabled: disabled || stagedCount === 0,
                onClick: () => void commit(),
              },
              busy === 'commit' ? t('committing') : t('commit'),
            ),
            h('span', { className: 'dsg-spacer' }),
            h(
              'label',
              { className: 'dsg-check' },
              h('input', { type: 'checkbox', checked: pushAfter, onChange: (event) => setPushAfter(event.target.checked) }),
              t('pushAfter'),
            ),
          ),
          h(
            'div',
            { className: 'dsg-actions' },
            h(
              'button',
              { type: 'button', className: 'dsg-btn', disabled, onClick: () => void act('push', 'sync', { action: 'push' }, () => t('pushDone')) },
              t('push'),
            ),
            h(
              'button',
              { type: 'button', className: 'dsg-btn', disabled, onClick: () => void act('pull', 'sync', { action: 'pull' }, () => t('pullDone')) },
              t('pull'),
            ),
            h(
              'button',
              { type: 'button', className: 'dsg-btn', disabled, onClick: () => void act('fetch', 'sync', { action: 'fetch' }, () => t('fetchDone')) },
              t('fetch'),
            ),
            h('span', { className: 'dsg-spacer' }),
            stagedCount === 0 ? h('span', { className: 'dsg-dim' }, t('nothingStaged')) : null,
          ),
          rollbackRow,
        );

        /** One labelled settings row. */
        const field = (label, control) =>
          h('div', { className: 'dsg-form-row', key: label }, h('span', { className: 'dsg-label' }, label), control);

        const settingsView =
          draft === null
            ? h('div', { className: 'dsg-empty' }, t('working'))
            : h(
                'div',
                { className: 'dsg-scroll' },
                h(
                  'div',
                  { className: 'dsg-form' },
                  settings?.writable === false
                    ? h('div', { className: 'dsg-note dsg-note-warn' }, t('settingsUnavailable'))
                    : null,
                  field(
                    t('language'),
                    h(
                      'select',
                      {
                        className: 'dsg-input',
                        value: draft.messageLanguage,
                        onChange: (event) => setDraft({ ...draft, messageLanguage: event.target.value }),
                      },
                      h('option', { value: 'auto' }, t('langAuto')),
                      h('option', { value: 'en' }, t('langEn')),
                      h('option', { value: 'zh' }, t('langZh')),
                    ),
                  ),
                  field(
                    t('style'),
                    h(
                      'select',
                      {
                        className: 'dsg-input',
                        value: draft.messageStyle,
                        onChange: (event) => setDraft({ ...draft, messageStyle: event.target.value }),
                      },
                      h('option', { value: 'conventional' }, t('styleConventional')),
                      h('option', { value: 'plain' }, t('stylePlain')),
                    ),
                  ),
                  field(
                    t('template'),
                    h('textarea', {
                      className: 'dsg-textarea',
                      rows: 4,
                      value: draft.messageTemplate,
                      placeholder: t('templateHint'),
                      onChange: (event) => setDraft({ ...draft, messageTemplate: event.target.value }),
                    }),
                  ),
                  h(
                    'label',
                    { className: 'dsg-check' },
                    h('input', {
                      type: 'checkbox',
                      checked: draft.signoff === true,
                      onChange: (event) => setDraft({ ...draft, signoff: event.target.checked }),
                    }),
                    t('signoff'),
                  ),
                  field(
                    t('defaultBranch'),
                    h('input', {
                      className: 'dsg-input',
                      value: draft.defaultBranch,
                      onChange: (event) => setDraft({ ...draft, defaultBranch: event.target.value }),
                    }),
                  ),
                  h('div', { className: 'dsg-form-title' }, t('modelOverride')),
                  h(
                    'div',
                    { className: 'dsg-field' },
                    h('input', {
                      className: 'dsg-input',
                      placeholder: t('provider'),
                      value: draft.provider,
                      onChange: (event) => setDraft({ ...draft, provider: event.target.value }),
                    }),
                    h('input', {
                      className: 'dsg-input',
                      placeholder: t('model'),
                      value: draft.model,
                      onChange: (event) => setDraft({ ...draft, model: event.target.value }),
                    }),
                  ),
                  h(
                    'div',
                    { className: 'dsg-actions' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsg-btn dsg-btn-primary',
                        disabled: disabled || settings?.writable === false,
                        onClick: () => void saveSettings(),
                      },
                      busy === 'saveSettings' ? t('saving') : t('saveSettings'),
                    ),
                  ),
                  h('div', { className: 'dsg-divider' }),
                  h('div', { className: 'dsg-form-title' }, t('gitignore')),
                  h('div', { className: 'dsg-dim' }, t('gitignoreHint')),
                  ignorePlan === null
                    ? h('div', { className: 'dsg-dim' }, t('working'))
                    : h(
                        Fragment,
                        null,
                        (ignorePlan.groups ?? []).map((group) =>
                          h(
                            'label',
                            { className: 'dsg-check', key: group.id },
                            h('input', {
                              type: 'checkbox',
                              checked: ignoreChoice?.has(group.id) === true,
                              onChange: (event) => {
                                const next = new Set(ignoreChoice ?? []);
                                if (event.target.checked) next.add(group.id);
                                else next.delete(group.id);
                                setIgnoreChoice(next);
                              },
                            }),
                            `${group.label}${group.detected ? ' ●' : ''}${group.missing === 0 ? '' : ` (+${group.missing})`}`,
                          ),
                        ),
                        h(
                          'div',
                          { className: 'dsg-actions' },
                          h(
                            'button',
                            { type: 'button', className: 'dsg-btn', disabled, onClick: () => void writeIgnore() },
                            busy === 'gitignore' ? t('gitignoreWriting') : t('gitignoreWrite'),
                          ),
                        ),
                      ),
                ),
              );

        return h(
          'div',
          { className: 'dsg-root', 'data-plugin': 'dsh-git' },
          h(PanelStyles),
          header,
          branchPanel,
          error !== '' ? h('div', { className: 'dsg-note dsg-note-error' }, error) : null,
          notice !== '' ? h('div', { className: 'dsg-note dsg-note-ok' }, notice) : null,
          !status ? h('div', { className: 'dsg-empty' }, t('working')) : null,
          status && !status.isRepo ? emptyState : null,
          status?.isRepo && !status.identityConfigured ? identityNote : null,
          status?.isRepo ? (view === 'settings' ? settingsView : changes) : null,
          status?.isRepo && view === 'changes' ? commitBox : null,
        );
      };
    }

    return {
      inject: ['slots', 'locale', 'sidebarRightTabs'],
      apply(ctx) {
        const disposers = [];
        const own = (dispose) => {
          if (typeof dispose === 'function') disposers.push(dispose);
          return dispose;
        };

        own(ctx.locale.register(LOCALE_NS, DICTIONARIES));
        const t = ctx.locale.bind(LOCALE_NS);

        try {
          const tabs = ctx.sidebarRightTabs;
          if (tabs === undefined || typeof tabs.register !== 'function') {
            throw new Error('this Harness does not serve the right Sidebar tab registry');
          }
          own(
            tabs.register({
              id: TAB_ID,
              kind: TAB_ID,
              title: () => t('tab'),
              guide: [{ order: 15, title: () => t('tab'), description: () => t('guide'), icon: GitIcon }],
            }),
          );
          own(
            ctx.slots.inject('sidebar.right.pane.tab', () =>
              ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID, locale: LOCALE_NS }, makePanel(t)),
            ),
          );
          own(
            ctx.slots.inject('sidebar.right.pane.tab.title', () =>
              ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, makeTabTitle(t)),
            ),
          );
        } catch (failure) {
          // A foreign or absent registry leaves the sidebar without the tab
          // instead of taking the page down; the agent tools are unaffected.
          console.error('dsh-git: could not register the sidebar tab', failure);
        }

        ctx.effect(() => () => {
          for (const dispose of disposers.splice(0)) {
            try {
              dispose();
            } catch {
              /* a disposer that throws must not block the rest */
            }
          }
        });
      },
    };
  },
});
