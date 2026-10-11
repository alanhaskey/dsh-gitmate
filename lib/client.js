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
 * @module dsh-gitmate/client
 */

window.__ModuleLoader__.load({
  // The module table is keyed by PACKAGE NAME (dsh-client-modules registers a
  // bundle under the id it declares here, and looks it up by the entry's package
  // name). A mismatch leaves the graph row with no factory and the renderer
  // refuses to boot. `test/smoke.mjs` asserts this equals package.json's name.
  id: 'dsh-gitmate',
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

    /** Strings this panel renders. Both dictionaries carry every key. */
    const DICTIONARIES = {
      zh: {
        tab: 'GitMate',
        guide: '改动、差异、自动生成提交说明、提交与推送、提交图和回滚，都在这里。',
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
        improve: '补充优化',
        generating: '生成中…',
        commit: '提交',
        committing: '提交中…',
        pushAfter: '提交后推送',
        remote: '远程',
        push: '推送',
        pull: '拉取',
        fetch: '获取',
        working: '处理中…',
        sessionPending: '正在等待会话就绪…',
        sessionGone: '这个会话仍未就绪；切换一次会话，或重开面板。',
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
        stModified: '修改',
        stAdded: '新增',
        stDeleted: '删除',
        stRenamed: '重命名',
        stCopied: '复制',
        stUnmerged: '冲突',
        stTypeChanged: '类型变更',
        stChanged: '改动',
        noChanges: '没有改动',
        truncated: '补丁过长，已截断',
        emptyPatch: '这个文件没有可显示的差异。',
        resizeHint: '拖动调整输入框高度，双击恢复默认',
        history: '历史提交',
        noCommits: '还没有任何提交',
        noCommitsHint: '第一次提交之后，这里会画出提交图。',
        undoThisCommit: '撤销这次提交',
        rewindHere: '回滚到这个提交',
        rewindHint: '分支指针会移回这个提交，被丢弃的改动怎么处理：',
        rewindDone: '已回滚到 {hash}',
        dropped: '丢弃 {n} 个提交',
        noFiles: '这个提交没有文件变更（可能是空提交）。',
        cancel: '取消',
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
        language: '生成说明与改动解释的语言',
        languageHint: '提交说明和「解释改动」共用这一项。',
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
        saveSettings: '保存设置',
        settingsUnavailable: '这个环境没有配置编辑器，设置无法从这里保存；可以直接改 cordis.patch.yml。',
        gitignore: '.gitignore',
        gitignoreHint: '不用选类别：读完项目里的清单文件和目录结构后自动推断，只追加、不删除你写的行。',
        gitignoreInit: '初始化 .gitignore',
        gitignoreOptimize: '优化 .gitignore',
        gitignoreWorking: '推断中…',
        gitignoreInitHint: '看一遍项目，生成它需要的 .gitignore。',
        gitignoreInitBlocked: '已经有 .gitignore 了，用「优化」在它基础上补充。',
        gitignoreOptimizeHint: '对照项目现状，补上现在缺的规则。',
        gitignoreOptimizeBlocked: '还没有 .gitignore，先用「初始化」。',
        gitignoreCurrent: '当前有 {n} 条规则。',
        gitignoreAbsent: '当前没有 .gitignore。',
        gitignoreNothing: '没有需要补充的规则。',
        gitignoreFailed: '推断失败，请重试。',
        gitignoreByModel: '模型推断',
        gitignoreByRules: '内置规则',
        gitignoreAdded: '已追加 {n} 条规则（{source}）。',
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
        tab: 'GitMate',
        guide: 'Diffs, generated commit messages, commit and push, a history graph and rewind — all in this panel.',
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
        improve: 'Refine draft',
        generating: 'Generating…',
        commit: 'Commit',
        committing: 'Committing…',
        pushAfter: 'Push after committing',
        remote: 'Remote',
        push: 'Push',
        pull: 'Pull',
        fetch: 'Fetch',
        working: 'Working…',
        sessionPending: 'Waiting for the session to come up…',
        sessionGone: 'This session is still not ready. Switch sessions, or reopen the panel.',
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
        stModified: 'Modified',
        stAdded: 'Added',
        stDeleted: 'Deleted',
        stRenamed: 'Renamed',
        stCopied: 'Copied',
        stUnmerged: 'Conflict',
        stTypeChanged: 'Type',
        stChanged: 'Changed',
        noChanges: 'No changes',
        truncated: 'Patch truncated',
        emptyPatch: 'This file has no diff to show.',
        resizeHint: 'Drag to resize the message box, double-click to reset',
        history: 'Commit history',
        noCommits: 'No commits yet',
        noCommitsHint: 'The graph appears here after the first commit.',
        undoThisCommit: 'Undo this commit',
        rewindHere: 'Rewind to this commit',
        rewindHint: 'The branch pointer moves back to this commit. Its changes are:',
        rewindDone: 'Rewound to {hash}',
        dropped: '{n} commit(s) dropped',
        noFiles: 'This commit changed no files (it may be empty).',
        cancel: 'Cancel',
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
        language: 'Language for messages and explanations',
        languageHint: 'Both the commit message and “Explain change” use this setting.',
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
        saveSettings: 'Save settings',
        settingsUnavailable:
          'This deployment exposes no configuration editor, so settings cannot be saved from here; edit cordis.patch.yml instead.',
        gitignore: '.gitignore',
        gitignoreHint:
          'Nothing to pick: the plugin reads the manifests and the layout, then infers the rules. Existing lines are never removed.',
        gitignoreInit: 'Create .gitignore',
        gitignoreOptimize: 'Improve .gitignore',
        gitignoreWorking: 'Inferring…',
        gitignoreInitHint: 'Read the project and write the .gitignore it needs.',
        gitignoreInitBlocked: 'A .gitignore already exists — use Improve to extend it.',
        gitignoreOptimizeHint: 'Compare against the project and add what is missing.',
        gitignoreOptimizeBlocked: 'No .gitignore yet — create one first.',
        gitignoreCurrent: '{n} rule(s) currently.',
        gitignoreAbsent: 'No .gitignore yet.',
        gitignoreNothing: 'Nothing to add.',
        gitignoreFailed: 'Inference failed, please retry.',
        gitignoreByModel: 'inferred by the model',
        gitignoreByRules: 'built-in rules',
        gitignoreAdded: 'Added {n} rule(s) ({source}).',
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
        if (answer.ok !== true) {
          // The code matters: `no-session` means the panel asked before the
          // session it is bound to had come live, which is a race, not a fault.
          return { error: answer.error?.message ?? 'the host refused the request', code: answer.error?.code };
        }
        return { value: answer.value };
      } catch (failure) {
        return { error: failure instanceof Error ? failure.message : String(failure) };
      }
    }

    /**
     * How long to keep re-asking when the session is not live yet.
     *
     * The sidebar restores its tabs before the sessions behind them finish
     * coming up, so the first status request of a fresh launch can arrive too
     * early. The wait grows and then stops: a session that never appears is a
     * different problem and gets told about rather than retried forever.
     */
    const SESSION_RETRY_DELAYS = [200, 400, 800, 1600, 3000, 4000];

    /** Wait, bounded by the caller's own cancellation checks. */
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    /**
     * The GitMate mark: a commit graph drawn on a 24px grid.
     *
     * `currentColor` and a stroke that stays proportional at every size, so the
     * chip, the panel header, the guide card, and the empty state all read as
     * the same mark and follow the active theme without a second asset.
     */
    function GitIcon({ size = 16, muted = false }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block', flex: '0 0 auto', opacity: muted ? 0.55 : 1 },
        },
        h('path', { d: 'M6.5 8.2v7.6' }),
        h('path', { d: 'M17.5 10.9v.6a4.2 4.2 0 0 1-4.2 4.2H12' }),
        h('circle', { cx: 6.5, cy: 5.7, r: 2.5 }),
        h('circle', { cx: 6.5, cy: 18.3, r: 2.5 }),
        h('circle', { cx: 17.5, cy: 8.4, r: 2.5 }),
      );
    }

    /**
     * One stroked glyph on the shared 24px grid.
     *
     * The panel draws its own controls rather than importing a Harness UI
     * package, so this is the whole icon set: `currentColor`, one stroke weight,
     * one grid — which is what makes a row of actions read as designed instead
     * of as punctuation.
     */
    function Glyph({ size = 14, children, style }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block', flex: '0 0 auto', ...style },
        },
        children,
      );
    }

    const IconRefresh = (p) =>
      h(Glyph, p, h('path', { d: 'M20.5 12a8.5 8.5 0 1 1-2.5-6' }), h('path', { d: 'M20.5 4.5V10H15' }));
    const IconSliders = (p) =>
      h(
        Glyph,
        p,
        h('path', { d: 'M4 8h16' }),
        h('path', { d: 'M4 16h16' }),
        h('circle', { cx: 10, cy: 8, r: 2.4, fill: 'var(--dsw-alias-bg-layer-1)' }),
        h('circle', { cx: 15, cy: 16, r: 2.4, fill: 'var(--dsw-alias-bg-layer-1)' }),
      );
    const IconBack = (p) => h(Glyph, p, h('path', { d: 'M19 12H5' }), h('path', { d: 'm11 6-6 6 6 6' }));
    const IconPlus = (p) => h(Glyph, p, h('path', { d: 'M12 6.5v11' }), h('path', { d: 'M6.5 12h11' }));
    const IconMinus = (p) => h(Glyph, p, h('path', { d: 'M6.5 12h11' }));
    const IconUndo = (p) =>
      h(Glyph, p, h('path', { d: 'M4 10h9.5a5.5 5.5 0 0 1 0 11H9' }), h('path', { d: 'M8 6 4 10l4 4' }));
    const IconChevron = ({ size = 12, up = false }) =>
      h(Glyph, { size }, h('path', { d: up ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6' }));
    const IconPush = (p) =>
      h(Glyph, p, h('path', { d: 'M12 19V6' }), h('path', { d: 'm6 12 6-6 6 6' }), h('path', { d: 'M5 21h14' }));
    const IconPull = (p) =>
      h(Glyph, p, h('path', { d: 'M12 5v13' }), h('path', { d: 'm6 12 6 6 6-6' }), h('path', { d: 'M5 3h14' }));
    const IconFetch = (p) =>
      h(Glyph, p, h('path', { d: 'M12 4v8' }), h('path', { d: 'm8.5 8.5 3.5 3.5 3.5-3.5' }), h('path', { d: 'M4.5 16a8 8 0 0 0 15 0' }));
    const IconSpark = (p) =>
      h(
        Glyph,
        p,
        h('path', { d: 'M12 3.5l1.9 5.6 5.6 1.9-5.6 1.9L12 18.5l-1.9-5.6L4.5 11l5.6-1.9z' }),
        h('path', { d: 'M18.5 4.5v3' }),
        h('path', { d: 'M17 6h3' }),
      );
    const IconBubble = (p) =>
      h(
        Glyph,
        p,
        h('path', { d: 'M20 13.5a2.5 2.5 0 0 1-2.5 2.5H10l-4 3.5v-3.5H6.5A2.5 2.5 0 0 1 4 13.5v-6A2.5 2.5 0 0 1 6.5 5h11A2.5 2.5 0 0 1 20 7.5z' }),
        h('path', { d: 'M8.5 9.5h7' }),
        h('path', { d: 'M8.5 12.5h4' }),
      );
    const IconTrash = (p) =>
      h(Glyph, p, h('path', { d: 'M4.5 7h15' }), h('path', { d: 'M9.5 7V4.8h5V7' }), h('path', { d: 'M6.5 7l1 12.2h9L17.5 7' }));
    const IconGraph = (p) =>
      h(
        Glyph,
        p,
        h('path', { d: 'M7 5.5v13' }),
        h('path', { d: 'M17 8.5v2a4 4 0 0 1-4 4H7' }),
        h('circle', { cx: 7, cy: 4.5, r: 2.2 }),
        h('circle', { cx: 7, cy: 19.5, r: 2.2 }),
        h('circle', { cx: 17, cy: 6.5, r: 2.2 }),
      );
    const IconCheck = (p) => h(Glyph, p, h('path', { d: 'm5 12.5 4.5 4.5L19 7.5' }));
    const IconCommit = (p) =>
      h(Glyph, p, h('circle', { cx: 12, cy: 12, r: 3.6 }), h('path', { d: 'M12 3.5v4.9' }), h('path', { d: 'M12 15.6v4.9' }));
    const IconSwitch = (p) =>
      h(Glyph, p, h('path', { d: 'M4 6v6.5A3.5 3.5 0 0 0 7.5 16H19' }), h('path', { d: 'm15 12 4 4-4 4' }));

    /** The stylesheet the panel mounts with its own subtree, so unmounting removes it. */
    function PanelStyles() {
      return h('style', {
        children: `
.dsg-root { display:flex; flex-direction:column; height:100%; min-height:0; color:var(--dsw-alias-label-primary); font-size:12px; line-height:1.5; -webkit-font-smoothing:antialiased; position:relative; }
/* The package's signature: a two-pixel brand rule across the top of the pane,
   fading out so it reads as an accent rather than a border. Pure tokens, so it
   follows the active theme and any brand colour the deployment sets. */
.dsg-rule { flex:0 0 auto; height:2px; background:linear-gradient(90deg, var(--dsw-alias-brand-primary), transparent); }
.dsg-root *, .dsg-root *::before, .dsg-root *::after { box-sizing:border-box; }

/* header ------------------------------------------------------------------ */
.dsg-hero { position:relative; overflow:hidden; display:flex; flex-direction:column; gap:7px; padding:10px; border-bottom:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-base); flex:0 0 auto; }
/* A wash of the brand colour behind the header. Token-derived and very low
   opacity, so it tints without changing any text's contrast. */
.dsg-hero::before { content:''; position:absolute; inset:0; background:linear-gradient(180deg, var(--dsw-alias-brand-primary), transparent 58%); opacity:.05; pointer-events:none; }
.dsg-hero > * { position:relative; }
.dsg-hero-top { display:flex; align-items:center; gap:6px; min-width:0; }
.dsg-hero-meta { display:flex; align-items:center; gap:6px; flex-wrap:wrap; padding-left:2px; min-height:16px; }
.dsg-upstream { color:var(--dsw-alias-label-secondary); font-size:10.5px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:14em; }
/* Deliberately plain: the branch name, a disclosure caret, and nothing else.
   It reads as a control from its shape and hover state, not from decoration. */
.dsg-branch-btn { display:inline-flex; align-items:center; gap:5px; min-width:0; max-width:100%; appearance:none; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font:inherit; font-weight:600; font-size:12.5px; padding:0 9px; min-height:28px; border-radius:999px; cursor:pointer; transition:border-color .12s ease; }
.dsg-branch-btn:hover:not(:disabled) { border-color:var(--dsw-alias-border-l2); }
.dsg-branch-btn:disabled { cursor:default; opacity:.7; }
.dsg-branch-static { display:inline-flex; align-items:center; padding:0 9px; min-height:28px; font-weight:600; font-size:12.5px; border:1px solid var(--dsw-alias-border-l1); border-radius:999px; background:var(--dsw-alias-bg-base); }
.dsg-branch-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
.dsg-badge { display:inline-flex; align-items:center; border:1px solid var(--dsw-alias-border-l1); border-radius:999px; padding:1px 7px; font-size:10px; color:var(--dsw-alias-label-secondary); }
.dsg-badge-ahead { color:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); }
.dsg-badge-behind { color:var(--dsw-alias-state-warn-primary); border-color:var(--dsw-alias-state-warn-primary); }

/* controls ---------------------------------------------------------------- */
.dsg-btn { appearance:none; display:inline-flex; align-items:center; justify-content:center; gap:5px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); border-radius:7px; padding:0 9px; min-height:26px; font-size:11px; line-height:1.5; cursor:pointer; font-family:inherit; white-space:nowrap; transition:background-color .12s ease, border-color .12s ease, opacity .12s ease; }
/* Barely larger than a secondary control: enough to read as primary, not
   enough to shout. */
.dsg-btn-commit { min-height:28px; font-size:12px; padding:0 12px; border-radius:8px; }
.dsg-btn:hover:not(:disabled) { border-color:var(--dsw-alias-border-l2); }
.dsg-btn:disabled { opacity:.45; cursor:default; }
.dsg-btn-primary { background:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-bg-base); font-weight:600; }
.dsg-btn-danger { color:var(--dsw-alias-state-error-primary); border-color:var(--dsw-alias-state-error-primary); }
.dsg-btn-armed { background:var(--dsw-alias-state-error-primary); color:var(--dsw-alias-bg-base); font-weight:600; padding:0 8px; font-size:10.5px; }
.dsg-btn-icon { min-width:26px; padding:0 6px; font-size:12px; display:inline-flex; align-items:center; justify-content:center; }
.dsg-btn-quiet { background:none; border-color:transparent; color:var(--dsw-alias-label-secondary); }
.dsg-root button:focus-visible, .dsg-root input:focus-visible, .dsg-root select:focus-visible, .dsg-root textarea:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:1px; }
.dsg-btn-quiet:hover:not(:disabled) { border-color:var(--dsw-alias-border-l1); color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-layer-1); }
/* A few mutually exclusive options, all visible: no hidden menu, one click. */
.dsg-choice { display:flex; align-items:stretch; border:1px solid var(--dsw-alias-border-l1); border-radius:7px; overflow:hidden; }
/* Equal shares, not content widths: "跟随仓库 / English / 简体中文" would otherwise
   be three different widths with a gap at the end of the track. */
.dsg-choice-btn { flex:1 1 0; min-width:0; appearance:none; border:none; border-left:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-secondary); font:inherit; font-size:11px; padding:0 6px; min-height:26px; cursor:pointer; transition:background-color .12s ease, color .12s ease; }
.dsg-choice-btn:first-child { border-left:none; }
.dsg-choice-btn:hover:not(:disabled) { color:var(--dsw-alias-label-primary); }
.dsg-choice-btn:disabled { opacity:.5; cursor:default; }
/* The brand alias is the theme's ink colour: near-black in the light theme and
   near-white in the dark one, and bg-base is its inverse in both. That is why the
   primary button has always used bg-base as the text on a brand fill. Pairing the
   fill with a token that does not exist leaves the colour unset, so the text
   inherits the very near-white it is sitting on: an apparently blank chip. */
.dsg-choice-on { background:var(--dsw-alias-brand-primary); color:var(--dsw-alias-bg-base); font-weight:600; }
.dsg-choice-on:hover:not(:disabled) { color:var(--dsw-alias-bg-base); }
.dsg-input { flex:1 1 auto; min-width:0; border:1px solid var(--dsw-alias-border-l1); border-radius:7px; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font-size:11px; min-height:26px; padding:3px 8px; font-family:inherit; transition:border-color .12s ease; }
.dsg-input:focus { outline:none; border-color:var(--dsw-alias-brand-primary); }
.dsg-textarea { width:100%; resize:none; height:62px; min-height:44px; border:1px solid var(--dsw-alias-border-l1); border-radius:8px; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px; line-height:1.6; padding:7px 8px; transition:border-color .12s ease; }
.dsg-textarea:focus { outline:none; border-color:var(--dsw-alias-brand-primary); }
.dsg-check { display:inline-flex; align-items:center; gap:5px; color:var(--dsw-alias-label-secondary); font-size:11px; cursor:pointer; user-select:none; }
.dsg-field { display:flex; align-items:center; gap:6px; }
.dsg-label { color:var(--dsw-alias-label-secondary); font-size:10.5px; letter-spacing:.02em; }

/* layout ------------------------------------------------------------------ */
.dsg-scroll { flex:1 1 auto; min-height:0; overflow:auto; }
/* The content area is the positioning context for the floating messages. */
.dsg-main { position:relative; flex:1 1 auto; min-height:0; display:flex; flex-direction:column; }
/* Anchored to the bottom of the content area, centred, and only as wide as its
   own text: at the top edge it covered the first rows of the list, which is
   exactly where the eye is when a message arrives. */
.dsg-toasts { position:absolute; left:10px; right:10px; bottom:10px; z-index:6; display:flex; flex-direction:column; align-items:center; gap:6px; pointer-events:none; }
/* Elevated so it reads as floating over the list rather than as part of it. */
.dsg-toast { margin:0; pointer-events:auto; width:max-content; max-width:100%; padding:7px 13px; align-items:center; text-align:center; background:var(--dsw-alias-bg-overlay); border-color:var(--dsw-alias-border-l2); box-shadow:0 6px 20px color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent); }
.dsg-section + .dsg-section { border-top:1px solid var(--dsw-alias-border-l1); }
.dsg-section:last-child { border-bottom:1px solid var(--dsw-alias-border-l1); }
/* List-level actions, one row: the count rides inside the button it belongs to.
   Sized to their labels rather than stretched across the panel — they are two
   different actions, not two halves of one switch, and a lone button should not
   become a full-width bar. */
.dsg-bulk { flex:0 0 auto; display:flex; align-items:center; justify-content:flex-end; gap:6px; padding:9px 10px 7px; }
.dsg-bulk > .dsg-btn { min-width:94px; justify-content:center; }
/* State-coloured actions. The state aliases are mid-tone, so they are used as a
   wash and an outline while the label keeps the readable alias — coloured text on
   the base background would sit near 2:1 contrast in the light theme. Each
   declaration is preceded by a plain fallback for engines without color-mix. */
.dsg-btn-success { background:var(--dsw-alias-bg-base); background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 16%, var(--dsw-alias-bg-base)); border-color:var(--dsw-alias-state-success-primary); color:var(--dsw-alias-label-primary); }
.dsg-btn-success:hover:not(:disabled) { background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 28%, var(--dsw-alias-bg-base)); }
.dsg-btn-warn { background:var(--dsw-alias-bg-base); background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 18%, var(--dsw-alias-bg-base)); border-color:var(--dsw-alias-state-warn-primary); color:var(--dsw-alias-label-primary); }
.dsg-btn-warn:hover:not(:disabled) { background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 30%, var(--dsw-alias-bg-base)); }
.dsg-section-head { display:flex; align-items:center; gap:7px; padding:7px 10px 6px; color:var(--dsw-alias-label-secondary); font-size:10.5px; letter-spacing:.05em; text-transform:uppercase; position:sticky; top:0; background:var(--dsw-alias-bg-base); z-index:1; }
.dsg-section-head b { color:var(--dsw-alias-label-secondary); font-weight:600; }
.dsg-count { min-width:18px; text-align:center; border-radius:999px; background:var(--dsw-alias-bg-base); border:1px solid currentColor; padding:0 5px; font-size:10px; letter-spacing:0; font-weight:600; }
.dsg-spacer { flex:1 1 auto; }
.dsg-dim { color:var(--dsw-alias-label-secondary); }

/* change rows ------------------------------------------------------------- */
.dsg-row { display:flex; align-items:center; gap:7px; padding:4px 10px; transition:background-color .1s ease; }
.dsg-row:hover { background:var(--dsw-alias-bg-layer-1); }
.dsg-row-active { background:var(--dsw-alias-bg-layer-1); box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary); }
/* The change's kind as a word: the row sets an inline color from the status,
   and currentColor makes the outline and text match. */
.dsg-kind { flex:0 0 auto; min-width:34px; text-align:center; border-radius:6px; border:1px solid currentColor; background:var(--dsw-alias-bg-base); display:inline-flex; align-items:center; justify-content:center; font-size:9.5px; font-weight:600; line-height:1; padding:2px 4px; }
.dsg-path { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; direction:rtl; text-align:left; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px; cursor:pointer; appearance:none; background:none; border:none; padding:0; color:inherit; }
.dsg-row { cursor:pointer; }
.dsg-lines { flex:0 0 auto; display:inline-flex; align-items:center; gap:4px; font-size:10px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
/* A grab bar between the list and the commit area. It keeps a real hit area
   while the visible line stays one pixel. */
.dsg-splitter { flex:0 0 auto; height:9px; margin:-4px 0 -4px; cursor:row-resize; position:relative; z-index:2; }
.dsg-splitter::after { content:''; position:absolute; left:10px; right:10px; top:4px; height:1px; background:var(--dsw-alias-border-l1); transition:background-color .12s ease; }
.dsg-splitter:hover::after, .dsg-splitter:active::after { background:var(--dsw-alias-brand-primary); }

/* diff -------------------------------------------------------------------- */
.dsg-diff { border-top:1px solid var(--dsw-alias-border-l1); border-left:2px solid var(--dsw-alias-brand-primary); background:var(--dsw-alias-bg-layer-2); }
.dsg-diff-head { display:flex; align-items:center; gap:6px; padding:7px 10px; font-size:11px; color:var(--dsw-alias-label-secondary); border-bottom:1px solid var(--dsw-alias-border-l1); }
.dsg-diff-head b { color:var(--dsw-alias-label-primary); font-weight:600; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
.dsg-summary-title { display:flex; align-items:center; gap:6px; padding:9px 10px 0; font-size:10px; letter-spacing:.06em; text-transform:uppercase; color:var(--dsw-alias-label-secondary); }
.dsg-summary-title::before { content:''; width:3px; height:11px; border-radius:2px; background:var(--dsw-alias-brand-primary); }
.dsg-summary { margin:0; padding:6px 10px 10px; font-size:11.5px; line-height:1.7; white-space:pre-wrap; font-family:inherit; color:var(--dsw-alias-label-primary); border-bottom:1px dashed var(--dsw-alias-border-l1); }
/* Diff view: two line-number gutters, a sign, then the text — the shape an
   editor uses, so a reader can see what moved instead of parsing git's format.
   Row tints come from color-mix over a status token, with a plain surface
   colour declared first as the fallback; neither is a literal colour. */
.dsg-diff-body { margin:0; padding:6px 0 10px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px; line-height:1.6; }
.dsg-dline { display:flex; align-items:flex-start; padding:0 10px 0 0; }
.dsg-dline:hover { background:var(--dsw-alias-bg-layer-1); }
.dsg-dadd { background:var(--dsw-alias-bg-layer-2); background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent); }
.dsg-ddel { background:var(--dsw-alias-bg-layer-2); background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); }
.dsg-dno { flex:0 0 34px; text-align:right; padding-right:7px; color:var(--dsw-alias-label-secondary); opacity:.7; user-select:none; }
.dsg-dsign { flex:0 0 13px; text-align:center; user-select:none; }
.dsg-dadd .dsg-dsign { color:var(--dsw-alias-state-success-primary); }
.dsg-ddel .dsg-dsign { color:var(--dsw-alias-state-error-primary); }
.dsg-dtext { flex:1 1 auto; min-width:0; white-space:pre-wrap; overflow-wrap:anywhere; }
.dsg-dmark { border-radius:2px; background:var(--dsw-alias-bg-layer-2); background:color-mix(in srgb, currentColor 24%, transparent); }
.dsg-dhunk { margin:6px 0 3px; padding:3px 10px; color:var(--dsw-alias-label-secondary); background:var(--dsw-alias-bg-base); border-top:1px solid var(--dsw-alias-border-l1); border-bottom:1px solid var(--dsw-alias-border-l1); white-space:pre-wrap; overflow-wrap:anywhere; }
.dsg-dmeta { padding:2px 10px; color:var(--dsw-alias-label-secondary); white-space:pre-wrap; overflow-wrap:anywhere; }
.dsg-stat-add { color:var(--dsw-alias-state-success-primary); }
.dsg-stat-del { color:var(--dsw-alias-state-error-primary); }

/* commit card ------------------------------------------------------------- */
/* History: the graph is drawn by the panel, in a fixed-width column so the
   lanes of consecutive rows line up into continuous lines. */
.dsg-hrow { display:flex; align-items:flex-start; gap:8px; padding:4px 10px 4px 6px; border-bottom:1px solid var(--dsw-alias-border-l1); }
.dsg-hrow:last-child { border-bottom:none; }
.dsg-hrow:hover { background:var(--dsw-alias-bg-layer-1); }
.dsg-graph { flex:0 0 auto; overflow:visible; }
.dsg-glane { stroke:var(--dsw-alias-border-l2); stroke-width:1.6; fill:none; }
.dsg-gnode { fill:var(--dsw-alias-bg-base); stroke:var(--dsw-alias-label-secondary); stroke-width:1.6; }
.dsg-gnode-head { fill:var(--dsw-alias-brand-primary); stroke:var(--dsw-alias-brand-primary); stroke-width:1.6; }
.dsg-hmain { flex:1 1 auto; min-width:0; display:flex; flex-direction:column; gap:2px; padding-top:2px; }
.dsg-hline { display:flex; align-items:center; gap:5px; min-width:0; }
.dsg-hsubject { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:11.5px; }
.dsg-ref { flex:0 0 auto; max-width:10em; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; border:1px solid var(--dsw-alias-brand-primary); color:var(--dsw-alias-brand-primary); border-radius:5px; padding:0 5px; font-size:9.5px; line-height:1.7; }
.dsg-hmeta { display:flex; align-items:center; gap:8px; color:var(--dsw-alias-label-secondary); font-size:10px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
.dsg-hrow-open { background:var(--dsw-alias-bg-layer-1); }
.dsg-hhead { display:flex; flex-direction:column; gap:3px; width:100%; min-width:0; appearance:none; background:none; border:none; padding:0; margin:0; color:inherit; font:inherit; text-align:left; cursor:pointer; }
.dsg-hbody { display:flex; flex-direction:column; gap:7px; padding:8px 0 2px; }
.dsg-hmessage { margin:0; padding:7px 8px; border:1px solid var(--dsw-alias-border-l1); border-radius:8px; background:var(--dsw-alias-bg-base); font-family:inherit; font-size:11px; line-height:1.65; white-space:pre-wrap; overflow-wrap:anywhere; color:var(--dsw-alias-label-primary); }
.dsg-hfiles { display:flex; flex-direction:column; gap:3px; }
.dsg-hfile { display:flex; align-items:center; gap:6px; font-size:10.5px; }
.dsg-hfile-path { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; direction:rtl; text-align:left; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--dsw-alias-label-secondary); }
/* Destructive work states its consequence in the warning colour before it offers
   the buttons, and the hardest mode confirms separately. */
.dsg-danger { display:flex; flex-direction:column; gap:7px; margin-top:8px; padding:8px; border:1px solid var(--dsw-alias-state-warn-primary); border-radius:8px; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font-size:11px; }
.dsg-commit { flex:0 0 auto; border-top:1px solid var(--dsw-alias-border-l1); padding:10px; display:flex; flex-direction:column; gap:8px; background:var(--dsw-alias-bg-base); }
.dsg-card { display:flex; flex-direction:column; gap:8px; padding:9px; border:1px solid var(--dsw-alias-border-l1); border-radius:10px; background:var(--dsw-alias-bg-layer-1); }
.dsg-actions { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.dsg-hint { color:var(--dsw-alias-label-secondary); font-size:10.5px; }

/* notices ----------------------------------------------------------------- */
.dsg-note { padding:8px 10px; font-size:11px; line-height:1.6; border-radius:8px; margin:8px 10px 0; display:flex; flex-direction:column; gap:7px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); }
/* A coloured edge marks the kind; the text keeps the readable alias, because the
   success alias is a mid-tone green that lands near 2:1 on the light surface. */
.dsg-note-error { border-color:var(--dsw-alias-state-error-primary); color:var(--dsw-alias-label-primary); }
.dsg-note-ok { border-color:var(--dsw-alias-state-success-primary); color:var(--dsw-alias-label-primary); }
.dsg-note-warn { border-color:var(--dsw-alias-state-warn-primary); color:var(--dsw-alias-label-primary); }

/* empty states ------------------------------------------------------------ */
.dsg-empty { padding:26px 18px; text-align:center; color:var(--dsw-alias-label-secondary); display:flex; flex-direction:column; gap:8px; align-items:center; }
.dsg-empty-mark { color:var(--dsw-alias-brand-primary); opacity:.6; }
.dsg-empty-title { color:var(--dsw-alias-label-primary); font-size:12.5px; font-weight:600; }
.dsg-empty-text { font-size:11px; line-height:1.7; max-width:26em; }

/* branch popover ---------------------------------------------------------- */
.dsg-popover { margin:8px 10px; border:1px solid var(--dsw-alias-border-l1); border-radius:12px; background:var(--dsw-alias-bg-base); display:flex; flex-direction:column; min-height:0; max-height:52%; flex:0 0 auto; overflow:hidden; }
.dsg-popover-head { display:flex; align-items:center; gap:6px; padding:8px 9px 7px; border-bottom:1px solid var(--dsw-alias-border-l1); }
.dsg-popover-title { flex:1 1 auto; font-size:10px; letter-spacing:.07em; text-transform:uppercase; color:var(--dsw-alias-label-secondary); font-weight:600; }
.dsg-popover-list { display:flex; flex-direction:column; gap:1px; padding:5px; overflow:auto; min-height:0; }
.dsg-popover-foot { display:flex; align-items:center; gap:6px; padding:7px 9px; border-top:1px solid var(--dsw-alias-border-l1); }
.dsg-branch-row { display:flex; align-items:center; gap:7px; padding:5px 7px; border-radius:8px; font-size:11.5px; }
.dsg-branch-row:hover { background:var(--dsw-alias-bg-layer-1); }
.dsg-branch-row-current .dsg-branch-row-name { font-weight:600; }
.dsg-branch-lead { flex:0 0 auto; width:14px; display:inline-flex; align-items:center; justify-content:center; color:var(--dsw-alias-label-secondary); }
.dsg-branch-row-name { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; cursor:pointer; }
.dsg-branch-row-name:hover { text-decoration:underline; text-underline-offset:2px; }
.dsg-branch-current { cursor:default; }
.dsg-branch-current:hover { text-decoration:none; }
.dsg-branch-track { flex:0 0 auto; color:var(--dsw-alias-label-secondary); font-size:10px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
/* Row actions stay out of the way until the row is pointed at or focused. */
.dsg-btn-reveal { opacity:0; transition:opacity .12s ease; }
.dsg-branch-row:hover .dsg-btn-reveal, .dsg-btn-reveal:focus-visible { opacity:1; }
.dsg-count-quiet { color:var(--dsw-alias-label-secondary); }

/* settings ---------------------------------------------------------------- */
.dsg-form { display:flex; flex-direction:column; gap:9px; padding:10px; }
.dsg-form-row { display:flex; flex-direction:column; gap:5px; }
.dsg-form-title { display:flex; align-items:center; gap:6px; font-weight:600; font-size:11px; letter-spacing:.02em; }
/* Buttons in the settings form share the row evenly, so the control column stays
   a column instead of a ragged edge. */
.dsg-form .dsg-actions > .dsg-btn { flex:1 1 0; min-width:0; justify-content:center; }
.dsg-form-title::before { content:''; width:3px; height:11px; border-radius:2px; background:var(--dsw-alias-brand-primary); }
.dsg-divider { border-top:1px solid var(--dsw-alias-border-l1); margin:3px 0; }
`,
      });
    }

    /** The chip's title seat: the glyph and label beside it. */
    function makeTabTitle(t) {
      return function GitTabTitle() {
        return h(
          'span',
          { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
          h(GitIcon, { size: 16 }),
          h('span', null, t('tab')),
        );
      };
    }

    /**
     * The status word for one change.
     *
     * A letter is git's vocabulary, not a reader's: the row says 修改 / 删除 /
     * 新增 in the panel's own language instead.
     */
    function kindKey(status) {
      switch (status) {
        case 'modified':
          return 'stModified';
        case 'added':
          return 'stAdded';
        case 'deleted':
          return 'stDeleted';
        case 'renamed':
          return 'stRenamed';
        case 'copied':
          return 'stCopied';
        case 'unmerged':
          return 'stUnmerged';
        case 'type-changed':
          return 'stTypeChanged';
        default:
          return 'stChanged';
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

    /** Geometry shared by every graph cell, so rows line up into columns. */
    const LANE_W = 11;
    const ROW_H = 24;

    /**
     * One commit's cell of the history graph.
     *
     * The Host decides the lanes; this draws them: a vertical line for every lane
     * passing through the row, a curve from the commit's node to each parent's
     * lane, and the node itself. The commit `HEAD` points at is filled with the
     * brand colour, so the current position is findable at a glance.
     */
    function GraphCell({ row, laneCount, head }) {
      const mid = ROW_H / 2;
      const width = Math.max(1, laneCount) * LANE_W + 2;
      const x = (lane) => lane * LANE_W + LANE_W / 2 + 1;
      const before = new Set(row.before ?? []);
      const after = new Set(row.after ?? []);
      const parts = [];
      for (const lane of [...new Set([...(row.before ?? []), ...(row.after ?? [])])]) {
        parts.push(
          h('line', {
            key: `lane-${lane}`,
            x1: x(lane),
            y1: before.has(lane) ? 0 : mid,
            x2: x(lane),
            y2: after.has(lane) ? ROW_H : mid,
            className: 'dsg-glane',
          }),
        );
      }
      for (const parent of row.parentLanes ?? []) {
        if (parent === row.lane) continue;
        parts.push(
          h('path', {
            key: `parent-${parent}`,
            d: `M ${x(row.lane)} ${mid} C ${x(row.lane)} ${mid + 9}, ${x(parent)} ${ROW_H - 9}, ${x(parent)} ${ROW_H}`,
            className: 'dsg-glane',
            fill: 'none',
          }),
        );
      }
      parts.push(
        h('circle', { key: 'node', cx: x(row.lane), cy: mid, r: 3.4, className: head ? 'dsg-gnode-head' : 'dsg-gnode' }),
      );
      return h(
        'svg',
        { width, height: ROW_H, viewBox: `0 0 ${width} ${ROW_H}`, className: 'dsg-graph', 'aria-hidden': true },
        parts,
      );
    }

    /**
     * A few mutually exclusive options as buttons.
     *
     * A `<select>` hides its alternatives behind a click and its current value
     * behind a control the eye skips; with two or three options every choice can
     * simply be visible and take one click.
     */
    function Choice({ value, options, onChange, disabled }) {
      return h(
        'div',
        { className: 'dsg-choice', role: 'group' },
        options.map((option) =>
          h(
            'button',
            {
              key: option.value,
              type: 'button',
              className: `dsg-choice-btn${option.value === value ? ' dsg-choice-on' : ''}`,
              disabled,
              'aria-pressed': option.value === value,
              title: option.title ?? option.label,
              onClick: () => onChange(option.value),
            },
            option.label,
          ),
        ),
      );
    }

    /** One piece of a line, marking the changed span when the Host found one. */
    function lineText(text, inline) {
      if (!inline) return text === '' ? ' ' : text;
      return [
        inline[0],
        inline[1] === '' ? null : h('span', { className: 'dsg-dmark', key: 'mark' }, inline[1]),
        inline[2],
      ];
    }

    /**
     * The patch as a diff view: two line-number gutters, a sign, then the text.
     *
     * The Host parses the unified diff into rows and marks the span that changed
     * within a replaced line; this draws them. Row tints come from `color-mix`
     * over a status token, with a plain surface colour declared first as the
     * fallback — neither is a literal colour.
     */
    function DiffBody({ rows, t }) {
      if (!Array.isArray(rows) || rows.length === 0) return h('div', { className: 'dsg-empty' }, t('emptyPatch'));
      return h(
        'div',
        { className: 'dsg-diff-body' },
        rows.map((row, index) => {
          if (row.kind === 'hunk') {
            return h('div', { className: 'dsg-dhunk', key: index }, row.text === '' ? '@@' : row.text);
          }
          if (row.kind === 'meta') return h('div', { className: 'dsg-dmeta', key: index }, row.text);
          const className =
            row.kind === 'add' ? 'dsg-dline dsg-dadd' : row.kind === 'del' ? 'dsg-dline dsg-ddel' : 'dsg-dline';
          return h(
            'div',
            { className, key: index },
            h('span', { className: 'dsg-dno' }, row.oldNo === undefined ? '' : String(row.oldNo)),
            h('span', { className: 'dsg-dno' }, row.newNo === undefined ? '' : String(row.newNo)),
            h('span', { className: 'dsg-dsign' }, row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ''),
            h('span', { className: 'dsg-dtext' }, lineText(row.text, row.inline)),
          );
        }),
      );
    }

    /** The line counts git reports for one change, when it has them. */
    function LineCounts({ lines }) {
      if (lines === null || lines === undefined) return null;
      const additions = lines.additions;
      const deletions = lines.deletions;
      if (additions === null && deletions === null) return null;
      return h(
        'span',
        { className: 'dsg-lines' },
        additions === null || additions === undefined
          ? null
          : h('span', { className: 'dsg-stat-add' }, `+${additions}`),
        deletions === null || deletions === undefined
          ? null
          : h('span', { className: 'dsg-stat-del' }, `−${deletions}`),
      );
    }

    /** One changed path, with the action that moves it across the index boundary. */
    function FileRow({ entry, scope, active, lines, onToggle, onAction, busy, confirming, confirmKey, t }) {
      const isStaged = scope === 'staged';
      const armed = confirming === confirmKey;
      return h(
        'div',
        {
          className: `dsg-row${active ? ' dsg-row-active' : ''}`,
          'aria-expanded': active,
          // The whole row is the target, not just the path text; the controls
          // inside it stop the click themselves.
          onClick: (event) => {
            if (event.target.closest('button, input, label, a') !== null) return;
            onToggle(scope === 'staged' ? 'staged' : 'unstaged', entry.path);
          },
        },
        h(
          'span',
          { className: 'dsg-kind', style: { color: colourFor(entry.status) }, title: entry.status },
          t(kindKey(entry.status)),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dsg-path',
            title: entry.path,
            'aria-expanded': active,
            onClick: () => onToggle(scope === 'staged' ? 'staged' : 'unstaged', entry.path),
          },
          entry.from ? `${entry.from} → ${entry.path}` : entry.path,
        ),
        h(LineCounts, { lines }),
        h(
          'button',
          {
            type: 'button',
            className: 'dsg-btn dsg-btn-icon',
            disabled: busy,
            title: isStaged ? t('unstage') : t('stage'),
            onClick: () => onAction(isStaged ? 'unstage' : 'add', [entry.path]),
          },
          isStaged ? h(IconMinus, { size: 13 }) : h(IconPlus, { size: 13 }),
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
              armed ? t('confirmDiscard') : h(IconUndo, { size: 13 }),
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
        /** True while the panel is waiting for its session to come live. */
        const [waiting, setWaiting] = useState(false);
        /** Attempts spent on the session behind this tab. */
        const sessionAttempt = useRef(0);
        /** Set once that budget is spent, so later polls only probe. */
        const sessionGaveUp = useRef(false);
        const [history, setHistory] = useState(null);
        const [openCommit, setOpenCommit] = useState(null);
        const [commits, setCommits] = useState({});
        const [rewind, setRewind] = useState(null);
        /** Pixels given to the message box; null means its stylesheet default. */
        const [messageHeight, setMessageHeight] = useState(null);

        const mounted = useRef(true);
        const rootRef = useRef(null);
        const commitRef = useRef(null);
        const dragRef = useRef(null);

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
            let answer = await request('status');
            if (!mounted.current) return undefined;
            // A fresh launch can reach here before the session behind the tab is
            // live: the sidebar restores its tabs first. Wait for it rather than
            // greeting the user with an error they cannot act on.
            while (answer.code === 'dsh-git/no-session' && !sessionGaveUp.current) {
              const attempt = sessionAttempt.current;
              if (attempt >= SESSION_RETRY_DELAYS.length) {
                // Out of patience. The poll keeps probing once per tick, so a
                // session that appears later still recovers on its own.
                sessionGaveUp.current = true;
                setWaiting(false);
                setError(t('sessionGone'));
                return undefined;
              }
              sessionAttempt.current = attempt + 1;
              setWaiting(true);
              await wait(SESSION_RETRY_DELAYS[attempt]);
              if (!mounted.current) return undefined;
              answer = await request('status');
              if (!mounted.current) return undefined;
            }
            if (answer.code === 'dsh-git/no-session') {
              setWaiting(false);
              setError(t('sessionGone'));
              return undefined;
            }
            setWaiting(false);
            sessionAttempt.current = 0;
            sessionGaveUp.current = false;
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

        // A new session id means a new session to wait for.
        useEffect(() => {
          sessionAttempt.current = 0;
          sessionGaveUp.current = false;
          setWaiting(false);
        }, [sessionId]);

        // The repository also changes outside this panel — the agent commits, a
        // branch moves — so re-read it while the tab is on screen.
        useEffect(() => {
          const tick = () => {
            if (document.visibilityState === 'hidden') return;
            if (busy !== '') return;
            // A startup retry burst already owns the route; only probe once it
            // has finished, so the two never overlap.
            if (sessionAttempt.current > 0 && !sessionGaveUp.current) return;
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

        /** Open a file's diff, or close it when the same file is clicked again. */
        const toggleDiff = useCallback(
          (scope, path) => {
            if (open !== null && open.path === path) {
              setOpen(null);
              setPatch(null);
              setSummary(null);
              return;
            }
            void openDiff(scope, path);
          },
          [open, openDiff],
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

        /**
         * Ask for a message, or for the draft to be finished.
         *
         * The draft travels with the request: an empty box means "write one",
         * anything else means "keep my intent and complete it".
         */
        const generate = useCallback(async () => {
          setBusy('generate');
          setError('');
          const answer = await request('generateMessage', { draft: message.trim() });
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
        }, [message, request]);

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

        /** Read the commit graph, newest first. */
        const loadHistory = useCallback(async () => {
          setBusy('history');
          const answer = await request('history', { limit: 40 });
          if (!mounted.current) return;
          setBusy('');
          if (answer.error) {
            setError(answer.error);
            return;
          }
          if (answer.value?.ok !== true) {
            setError(answer.value?.error ?? 'could not read the history');
            return;
          }
          setError('');
          setHistory(answer.value);
        }, [request]);



        /** Open one commit: its whole message and the files it touched. */
        const toggleCommit = useCallback(
          async (commit) => {
            if (openCommit === commit.hash) {
              setOpenCommit(null);
              return;
            }
            setOpenCommit(commit.hash);
            if (commits[commit.hash] !== undefined) return;
            const answer = await request('commitDetail', { hash: commit.hash });
            if (!mounted.current) return;
            if (answer.error) {
              setError(answer.error);
              return;
            }
            if (answer.value?.ok !== true) {
              setError(answer.value?.error ?? 'could not read this commit');
              return;
            }
            setCommits((current) => ({ ...current, [commit.hash]: answer.value }));
          },
          [openCommit, commits, request],
        );

        /**
         * Rewind the branch to a commit.
         *
         * Destructive by nature, so it is two steps: pick the mode, then confirm
         * — and the confirm names the commit and how much it discards.
         */
        const rewindTo = useCallback(
          async (commit, mode) => {
            setBusy('rewind');
            setError('');
            const answer = await request('reset', { mode, target: commit.hash });
            if (!mounted.current) return;
            setBusy('');
            if (answer.error) {
              setError(answer.error);
              return;
            }
            if (answer.value?.ok !== true) {
              setError(answer.value?.error ?? 'the rewind failed');
              return;
            }
            setRewind(null);
            setOpenCommit(null);
            setCommits({});
            setNotice(
              `${t('rewindDone').replace('{hash}', commit.shortHash)}${answer.value.dropped ? ` (${t('dropped').replace('{n}', String(answer.value.dropped))})` : ''}${
                answer.value.published ? ` — ${t('rollbackPublished')}` : ''
              }`,
            );
            await loadHistory();
            await refresh(true);
          },
          [loadHistory, refresh, request, t],
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
          if (planAnswer.value?.ok === true) setIgnorePlan(planAnswer.value);
          return true;
        }, [request]);

        /** Re-read whether a `.gitignore` exists and how much it already covers. */
        const loadIgnore = useCallback(async () => {
          const answer = await request('gitignore');
          if (!mounted.current) return;
          if (answer.value?.ok === true) setIgnorePlan(answer.value);
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

        /**
         * Create or extend `.gitignore` from what the project is made of.
         *
         * Nothing is picked here on purpose: the Host reads the manifests, the
         * top-level layout, and a sample of paths, and decides. `init` writes the
         * file when it is absent, `optimize` appends only what is missing from an
         * existing one — neither ever removes a line the user wrote.
         */
        const inferIgnore = useCallback(
          async (mode) => {
            setBusy('gitignore');
            setError('');
            const suggestion = await request('gitignoreSuggest', { mode });
            if (!mounted.current) return;
            if (suggestion.error || suggestion.value?.ok !== true) {
              setBusy('');
              setError(suggestion.error ?? suggestion.value?.error ?? t('gitignoreFailed'));
              return;
            }
            const entries = suggestion.value.added ?? [];
            if (entries.length === 0) {
              setBusy('');
              setNotice(t('gitignoreNothing'));
              return;
            }
            const answer = await request('gitignore', { action: 'write', entries });
            if (!mounted.current) return;
            setBusy('');
            if (answer.error || answer.value?.ok === false) {
              setError(answer.error ?? answer.value?.error ?? t('gitignoreFailed'));
              return;
            }
            setNotice(
              t('gitignoreAdded')
                .replace('{n}', String(answer.value?.added?.length ?? 0))
                .replace('{source}', t(suggestion.value.source === 'model' ? 'gitignoreByModel' : 'gitignoreByRules')),
            );
            await loadIgnore();
            await refresh(true);
          },
          [loadIgnore, refresh, request, t],
        );

        const groups = useMemo(() => {
          if (!status?.isRepo) return [];
          return [
            {
              key: 'conflicted',
              label: t('conflicted'),
              tone: 'var(--dsw-alias-state-error-primary)',
              entries: status.conflicted ?? [],
            },
            { key: 'staged', label: t('staged'), tone: 'var(--dsw-alias-state-success-primary)', entries: status.staged ?? [] },
            { key: 'changes', label: t('changes'), tone: 'var(--dsw-alias-state-warn-primary)', entries: status.unstaged ?? [] },
            {
              key: 'untracked',
              label: t('untracked'),
              tone: 'var(--dsw-alias-brand-primary)',
              entries: (status.untracked ?? []).map((path) => ({ path, status: 'added' })),
            },
          ].filter((group) => group.entries.length > 0);
        }, [status, t]);

        const disabled = busy !== '';
        const stagedCount = (status?.staged ?? []).length;
        // Everything "stage all" would pick up: modified files and new ones.
        const unstagedCount = (status?.unstaged ?? []).length + (status?.untracked ?? []).length;

        const header = h(
          'div',
          { className: 'dsg-hero' },
          h(
            'div',
            { className: 'dsg-hero-top' },
            status?.isRepo
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsg-branch-btn',
                    disabled,
                    onClick: () => void toggleBranches(),
                  },
                  h(
                    'span',
                    { className: 'dsg-branch-name' },
                    status.branch || (status.detached ? `detached @ ${status.head}` : t('notRepo')),
                  ),
                  h(IconChevron, { size: 12, up: branchOpen }),
                )
              : h(
                  'div',
                  { className: 'dsg-branch-static' },
                  h('span', { className: 'dsg-branch-name' }, t('notRepo')),
                ),
            h('span', { className: 'dsg-spacer' }),
            h(
              'button',
              {
                type: 'button',
                className: 'dsg-btn dsg-btn-icon dsg-btn-quiet',
                disabled,
                title: t('refresh'),
                onClick: () => void refresh(false),
              },
              h(IconRefresh, { size: 15 }),
            ),
            h(
              'button',
              {
                type: 'button',
                className: `dsg-btn dsg-btn-icon${view === 'history' ? ' dsg-btn-primary' : ' dsg-btn-quiet'}`,
                disabled,
                title: view === 'history' ? t('back') : t('history'),
                onClick: () => {
                  if (view === 'history') {
                    setView('changes');
                    void refresh(true);
                  } else {
                    setView('history');
                    void loadHistory();
                  }
                },
              },
              view === 'history' ? h(IconBack, { size: 15 }) : h(IconGraph, { size: 15 }),
            ),
            h(
              'button',
              {
                type: 'button',
                className: `dsg-btn dsg-btn-icon${view === 'settings' ? ' dsg-btn-primary' : ' dsg-btn-quiet'}`,
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
              view === 'settings' ? h(IconBack, { size: 15 }) : h(IconSliders, { size: 15 }),
            ),
          ),
          status?.isRepo
            ? h(
                'div',
                { className: 'dsg-hero-meta' },
                status.upstream
                  ? h('span', { className: 'dsg-upstream' }, status.upstream)
                  : h('span', { className: 'dsg-hint' }, t('noUpstream')),
                status.ahead > 0
                  ? h('span', { className: 'dsg-badge dsg-badge-ahead' }, t('ahead').replace('{n}', String(status.ahead)))
                  : null,
                status.behind > 0
                  ? h('span', { className: 'dsg-badge dsg-badge-behind' }, t('behind').replace('{n}', String(status.behind)))
                  : null,
                status.clean ? h('span', { className: 'dsg-hint' }, t('clean')) : null,
                h('span', { className: 'dsg-spacer' }),
                // Remote work belongs beside the divergence it acts on, not at
                // the bottom of the commit form.
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsg-btn dsg-btn-icon dsg-btn-quiet',
                    disabled,
                    title: t('push'),
                    onClick: () => void act('push', 'sync', { action: 'push' }, () => t('pushDone')),
                  },
                  h(IconPush, { size: 13 }),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsg-btn dsg-btn-icon dsg-btn-quiet',
                    disabled,
                    title: t('pull'),
                    onClick: () => void act('pull', 'sync', { action: 'pull' }, () => t('pullDone')),
                  },
                  h(IconPull, { size: 13 }),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsg-btn dsg-btn-icon dsg-btn-quiet',
                    disabled,
                    title: t('fetch'),
                    onClick: () => void act('fetch', 'sync', { action: 'fetch' }, () => t('fetchDone')),
                  },
                  h(IconFetch, { size: 13 }),
                ),
              )
            : null,
        );

        const branchPanel =
          branchOpen && status?.isRepo
            ? h(
                'div',
                { className: 'dsg-popover' },
                h(
                  'div',
                  { className: 'dsg-popover-head' },
                  h('span', { className: 'dsg-popover-title' }, t('localBranches')),
                  h('span', { className: 'dsg-count dsg-count-quiet' }, String((branches ?? []).length)),
                ),
                h(
                  'div',
                  { className: 'dsg-popover-list' },
                  (branches ?? []).map((entry) =>
                    h(
                      'div',
                      {
                        className: `dsg-branch-row${entry.current ? ' dsg-branch-row-current' : ''}`,
                        key: entry.name,
                      },
                      h(
                        'span',
                        { className: 'dsg-branch-lead' },
                        entry.current ? h(IconCheck, { size: 13 }) : null,
                      ),
                      h(
                        'span',
                        {
                          className: `dsg-branch-row-name${entry.current ? ' dsg-branch-current' : ''}`,
                          title: entry.current ? t('currentBranch') : t('switchTo'),
                          onClick: () => {
                            if (!entry.current) void switchBranch(entry.name);
                          },
                        },
                        entry.name,
                      ),
                      entry.track ? h('span', { className: 'dsg-branch-track' }, entry.track) : null,
                      entry.current
                        ? null
                        : h(
                            Fragment,
                            null,
                            h(
                              'button',
                              {
                                type: 'button',
                                className: 'dsg-btn dsg-btn-icon dsg-btn-quiet dsg-btn-reveal',
                                disabled,
                                title: t('switchTo'),
                                onClick: () => void switchBranch(entry.name),
                              },
                              h(IconSwitch, { size: 13 }),
                            ),
                            h(
                              'button',
                              {
                                type: 'button',
                                className: `dsg-btn dsg-btn-icon dsg-btn-quiet dsg-btn-reveal${
                                  confirming === `delete:${entry.name}` ? ' dsg-btn-armed' : ''
                                }`,
                                disabled,
                                title:
                                  confirming === `delete:${entry.name}` ? t('confirmDeleteBranch') : t('deleteBranch'),
                                onClick: () => void deleteBranch(entry.name),
                              },
                              confirming === `delete:${entry.name}`
                                ? t('confirmDeleteBranch')
                                : h(IconTrash, { size: 13 }),
                            ),
                          ),
                    ),
                  ),
                ),
                h(
                  'div',
                  { className: 'dsg-popover-foot' },
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
                    h(IconPlus, { size: 13 }),
                    busy === 'createBranch' ? t('creating') : t('create'),
                  ),
                ),
              )
            : null;

        const emptyState = h(
          'div',
          { className: 'dsg-empty' },
          h('span', { className: 'dsg-empty-mark' }, h(GitIcon, { size: 38 })),
          h('div', { className: 'dsg-empty-title' }, t('notRepo')),
          h('div', { className: 'dsg-empty-text' }, t('notRepoHint')),
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

        /** The patch, and once asked for, the plain-language summary above it. */
        const diffPane = (entry) =>
          h(
            'div',
            { className: 'dsg-diff' },
            h(
              'div',
              { className: 'dsg-diff-head' },
              h('b', null, entry.path),
              h('span', { className: 'dsg-spacer' }),
              patch?.truncated ? h('span', { className: 'dsg-hint' }, t('truncated')) : null,
              h(
                'button',
                { type: 'button', className: 'dsg-btn', disabled, onClick: () => void explain() },
                h(IconBubble, { size: 13 }),
                busy === 'explain' ? t('explaining') : t('explain'),
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
            patch === null ? h('div', { className: 'dsg-empty' }, t('working')) : h(DiffBody, { rows: patch.rows, t }),
          );

        /**
         * List-level actions, in one place.
         *
         * They used to sit on every group header, which meant two "stage all"
         * buttons for one list and a third control that only made sense on the
         * staged group. One row, shown only when there is something to act on,
         * and each button present only when it would do anything.
         */
        const bulkActions =
          unstagedCount === 0 && stagedCount === 0
            ? null
            : h(
                'div',
                { className: 'dsg-bulk' },
                unstagedCount === 0
                  ? null
                  : h(
                      'button',
                      { type: 'button', className: 'dsg-btn dsg-btn-success', disabled, onClick: () => void onAction('add') },
                      t('stageAll'),
                      h('span', { className: 'dsg-hint' }, String(unstagedCount)),
                    ),
                stagedCount === 0
                  ? null
                  : h(
                      'button',
                      { type: 'button', className: 'dsg-btn dsg-btn-warn', disabled, onClick: () => void onAction('unstage') },
                      t('unstageAll'),
                      h('span', { className: 'dsg-hint' }, String(stagedCount)),
                    ),
              );

        /**
         * The transient messages, as a floating layer.
         *
         * Inline, they sat a few pixels above the action row and shoved the whole
         * list down whenever one appeared or expired. Floating keeps the list
         * still; they are anchored to the top of the content area, below the
         * persistent chrome, so nothing that must stay clickable is covered.
         */
        const toasts =
          waiting || error !== '' || notice !== ''
            ? h(
                'div',
                { className: 'dsg-toasts' },
                waiting ? h('div', { className: 'dsg-note dsg-toast' }, t('sessionPending')) : null,
                !waiting && error !== ''
                  ? h('div', { className: 'dsg-note dsg-toast dsg-note-error' }, error)
                  : null,
                notice !== '' ? h('div', { className: 'dsg-note dsg-toast dsg-note-ok' }, notice) : null,
              )
            : null;

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
                h(
                  'span',
                  { className: 'dsg-count', style: { color: group.tone } },
                  String(group.entries.length),
                ),
              ),
              group.entries.map((entry) =>
                h(
                  Fragment,
                  { key: `${group.key}:${entry.path}` },
                  h(FileRow, {
                    entry,
                    scope: group.key === 'staged' ? 'staged' : group.key,
                    active: open?.path === entry.path,
                    lines: entry.lines ?? (group.key === 'untracked' && status.untrackedLines?.[entry.path] !== undefined
                      ? { additions: status.untrackedLines[entry.path], deletions: 0 }
                      : undefined),
                    onToggle: toggleDiff,
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

        const commitBox = h(
          'div',
          { className: 'dsg-commit' },
          h(
            'div',
            { className: 'dsg-card' },
            h('textarea', {
              className: 'dsg-textarea',
              ref: commitRef,
              style: messageHeight === null ? undefined : { height: `${messageHeight}px` },
              rows: 3,
              placeholder: t('messagePlaceholder'),
              value: message,
              onChange: (event) => setMessage(event.target.value),
              'aria-label': t('commitMessage'),
            }),
            // Secondary controls first: ask the model for a message, or queue a push.
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
                h(IconSpark, { size: 13 }),
                busy === 'generate' ? t('generating') : message.trim() === '' ? t('generate') : t('improve'),
              ),
              h('span', { className: 'dsg-spacer' }),
              // The primary action sits at the card's trailing edge, sized like
              // every other control so the panel keeps one rhythm.
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsg-btn dsg-btn-primary dsg-btn-commit',
                  disabled: disabled || stagedCount === 0,
                  onClick: () => void commit(),
                },
                h(IconCommit, { size: 14 }),
                busy === 'commit' ? t('committing') : t('commit'),
              ),
            ),
            h(
              'div',
              { className: 'dsg-actions' },
              h(
                'label',
                { className: 'dsg-check' },
                h('input', {
                  type: 'checkbox',
                  checked: pushAfter,
                  onChange: (event) => setPushAfter(event.target.checked),
                }),
                t('pushAfter'),
              ),
              h('span', { className: 'dsg-spacer' }),
              stagedCount === 0 ? h('span', { className: 'dsg-hint' }, t('nothingStaged')) : null,
            ),
          ),
        );

        /**
         * The bar between the list and the commit area.
         *
         * Dragging it gives height to the *message box*, so the extra space goes
         * into the field being typed in rather than pushing the buttons around;
         * the list takes whatever is left. Double-clicking restores the default,
         * which matters because there is no other way back once it is resized.
         */
        const splitter = h('div', {
          className: 'dsg-splitter',
          role: 'separator',
          'aria-orientation': 'horizontal',
          'aria-label': t('resizeHint'),
          title: t('resizeHint'),
          onDoubleClick: () => setCommitHeight(null),
          onPointerDown: (event) => {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            dragRef.current = { y: event.clientY, height: commitRef.current?.offsetHeight ?? 62 };
          },
          onPointerMove: (event) => {
            const drag = dragRef.current;
            if (drag === null) return;
            // Leave room for the hero and a useful slice of the list.
            const room = Math.max(80, (rootRef.current?.offsetHeight ?? 600) - 300);
            setMessageHeight(Math.max(52, Math.min(drag.height + (drag.y - event.clientY), room)));
          },
          onPointerUp: (event) => {
            dragRef.current = null;
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
          },
          onPointerCancel: () => {
            dragRef.current = null;
          },
        });

        /** The history view: the commit graph, and one commit at a time in full. */
        const historyView =
          history === null
            ? h('div', { className: 'dsg-empty' }, t('working'))
            : history.commits.length === 0
              ? h(
                  'div',
                  { className: 'dsg-empty' },
                  h('span', { className: 'dsg-empty-mark' }, h(GitIcon, { size: 34 })),
                  h('div', { className: 'dsg-empty-title' }, t('noCommits')),
                  h('div', { className: 'dsg-empty-text' }, t('noCommitsHint')),
                )
              : h(
                  'div',
                  { className: 'dsg-scroll' },
                  history.commits.map((commit, index) => {
                    const open = openCommit === commit.hash;
                    const detail = commits[commit.hash];
                    const newest = index === 0 && commit.hash === history.head;
                    return h(
                      'div',
                      { className: `dsg-hrow${open ? ' dsg-hrow-open' : ''}`, key: commit.hash },
                      h(GraphCell, {
                        row: history.graph.rows[index] ?? { lane: 0, before: [], after: [], parentLanes: [] },
                        laneCount: history.graph.laneCount,
                        head: commit.hash === history.head,
                      }),
                      h(
                        'div',
                        { className: 'dsg-hmain' },
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'dsg-hhead',
                            'aria-expanded': open,
                            onClick: () => void toggleCommit(commit),
                          },
                          h(
                            'span',
                            { className: 'dsg-hline' },
                            commit.refs.map((ref) => h('span', { className: 'dsg-ref', key: ref, title: ref }, ref)),
                            h('span', { className: 'dsg-hsubject' }, commit.subject),
                          ),
                          h(
                            'span',
                            { className: 'dsg-hmeta' },
                            h('span', null, commit.shortHash),
                            h('span', null, commit.author),
                            h('span', null, String(commit.date ?? '').slice(0, 10)),
                          ),
                        ),
                        open
                          ? h(
                              'div',
                              { className: 'dsg-hbody' },
                              detail === undefined
                                ? h('div', { className: 'dsg-hint' }, t('working'))
                                : h(
                                    Fragment,
                                    null,
                                    detail.body === ''
                                      ? null
                                      : h('pre', { className: 'dsg-hmessage' }, detail.body),
                                    h(
                                      'div',
                                      { className: 'dsg-hfiles' },
                                      detail.files.length === 0
                                        ? h('div', { className: 'dsg-hint' }, t('noFiles'))
                                        : detail.files.map((file) =>
                                            h(
                                              'div',
                                              { className: 'dsg-hfile', key: file.path },
                                              h('span', { className: 'dsg-hfile-path', title: file.path }, file.path),
                                              h(LineCounts, { lines: file }),
                                            ),
                                          ),
                                    ),
                                  ),
                            )
                          : null,
                        open
                          ? rewind !== null && rewind.hash === commit.hash
                            ? h(
                                'div',
                                { className: 'dsg-danger' },
                                h('div', null, t('rewindHint')),
                                h(
                                  'div',
                                  { className: 'dsg-actions' },
                                  h(
                                    'button',
                                    {
                                      type: 'button',
                                      className: 'dsg-btn',
                                      disabled,
                                      onClick: () => void rewindTo(commit, 'soft'),
                                    },
                                    t('rollbackSoft'),
                                  ),
                                  h(
                                    'button',
                                    {
                                      type: 'button',
                                      className: 'dsg-btn',
                                      disabled,
                                      onClick: () => void rewindTo(commit, 'mixed'),
                                    },
                                    t('rollbackMixed'),
                                  ),
                                  h(
                                    'button',
                                    {
                                      type: 'button',
                                      className: `dsg-btn dsg-btn-danger${
                                        rewind.mode === 'hard' ? ' dsg-btn-armed' : ''
                                      }`,
                                      disabled,
                                      onClick: () =>
                                        rewind.mode === 'hard'
                                          ? void rewindTo(commit, 'hard')
                                          : setRewind({ hash: commit.hash, mode: 'hard' }),
                                    },
                                    rewind.mode === 'hard' ? t('rollbackConfirm') : t('rollbackHard'),
                                  ),
                                  h(
                                    'button',
                                    {
                                      type: 'button',
                                      className: 'dsg-btn dsg-btn-quiet',
                                      onClick: () => setRewind(null),
                                    },
                                    t('cancel'),
                                  ),
                                ),
                                h('div', { className: 'dsg-hint' }, t('rollbackWarning')),
                              )
                            : h(
                                'div',
                                { className: 'dsg-actions' },
                                h(
                                  'button',
                                  {
                                    type: 'button',
                                    className: 'dsg-btn dsg-btn-danger',
                                    disabled,
                                    onClick: () => setRewind({ hash: commit.hash, mode: null }),
                                  },
                                  h(IconUndo, { size: 13 }),
                                  newest ? t('undoThisCommit') : t('rewindHere'),
                                ),
                              )
                          : null,
                      ),
                    );
                  }),
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
                      Fragment,
                      null,
                      h(Choice, {
                        value: draft.messageLanguage,
                        disabled,
                        onChange: (next) => setDraft({ ...draft, messageLanguage: next }),
                        options: [
                          { value: 'auto', label: t('langAuto') },
                          { value: 'en', label: t('langEn') },
                          { value: 'zh', label: t('langZh') },
                        ],
                      }),
                      h('span', { className: 'dsg-hint' }, t('languageHint')),
                    ),
                  ),
                  field(
                    t('style'),
                    h(Choice, {
                      value: draft.messageStyle,
                      disabled,
                      onChange: (next) => setDraft({ ...draft, messageStyle: next }),
                      options: [
                        { value: 'conventional', label: t('styleConventional') },
                        { value: 'plain', label: t('stylePlain') },
                      ],
                    }),
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
                    h(Choice, {
                      value: draft.defaultBranch,
                      disabled,
                      onChange: (next) => setDraft({ ...draft, defaultBranch: next }),
                      options: [
                        { value: 'main', label: 'main' },
                        { value: 'master', label: 'master' },
                      ],
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
                        h(
                          'div',
                          { className: 'dsg-actions' },
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'dsg-btn',
                              // Nothing to create when a file with rules is already
                              // there; nothing to extend when one is not.
                              disabled: disabled || ignorePlan.exists === true,
                              title: ignorePlan.exists === true ? t('gitignoreInitBlocked') : t('gitignoreInitHint'),
                              onClick: () => void inferIgnore('init'),
                            },
                            busy === 'gitignore' ? t('gitignoreWorking') : t('gitignoreInit'),
                          ),
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'dsg-btn',
                              disabled: disabled || ignorePlan.exists !== true,
                              title: ignorePlan.exists === true ? t('gitignoreOptimizeHint') : t('gitignoreOptimizeBlocked'),
                              onClick: () => void inferIgnore('optimize'),
                            },
                            busy === 'gitignore' ? t('gitignoreWorking') : t('gitignoreOptimize'),
                          ),
                        ),
                        h(
                          'div',
                          { className: 'dsg-hint' },
                          ignorePlan.exists === true
                            ? t('gitignoreCurrent').replace('{n}', String(ignorePlan.current.split('\n').filter((line) => line.trim() !== '' && !line.trim().startsWith('#')).length))
                            : t('gitignoreAbsent'),
                        ),
                      ),
                ),
              );

        return h(
          'div',
          { className: 'dsg-root', 'data-plugin': 'dsh-git', ref: rootRef },
          h(PanelStyles),
          h('div', { className: 'dsg-rule' }),
          header,
          branchPanel,
          // Persistent chrome keeps its own space; only the message layer floats.
          status?.isRepo && !status.identityConfigured ? identityNote : null,
          status?.isRepo && view === 'changes' ? bulkActions : null,
          h(
            'div',
            { className: 'dsg-main' },
            !status && !waiting ? h('div', { className: 'dsg-empty' }, t('working')) : null,
            status && !status.isRepo ? emptyState : null,
            status?.isRepo
              ? view === 'settings'
                ? settingsView
                : view === 'history'
                  ? historyView
                  : changes
              : null,
            toasts,
          ),
          status?.isRepo && view === 'changes' ? splitter : null,
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

        /** The guide card draws its own artwork, so it gets a larger mark. */
        function GuideIcon() {
          return h(GitIcon, { size: 20 });
        }

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
              guide: [{ order: 15, title: () => t('tab'), description: () => t('guide'), icon: GuideIcon }],
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
