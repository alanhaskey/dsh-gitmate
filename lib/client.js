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
        actionFailed: '操作失败',
        syncHint: '同步更改（获取、快进、推送）',
        merge: '合并',
        mergeInto: '合并到 {branch}',
        mergeDone: '已合并 {branch}',
        mergeFastForward: '已快进合并 {branch}',
        mergeUpToDate: '{branch} 已经包含在内，无需合并',
        mergeAborted: '已中止合并',
        abort: '中止',
        abortMergeHint: '放弃这次操作，把工作区恢复到它之前',
        opMerge: '合并',
        opRebase: '变基',
        opCherryPick: '遴选',
        opRevert: '还原',
        operationAborted: '已中止{what}',
        syncCurrent: '已是最新，没有需要同步的提交',
        syncPublished: '已推送并关联远程分支 {branch}',
        syncPulled: '已拉取 {n} 个提交',
        syncPushed: '已推送 {n} 个提交',
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
        aiMark: 'AI',
        generating: '生成中…',
        commit: '提交',
        committing: '提交中…',
        pushAfter: '提交后推送',
        amend: '修订上次提交',
        amendCommit: '修订',
        amendHint: '把暂存内容并入上一个提交；说明框留空则沿用原来的说明',
        remote: '远程',
        push: '推送',
        pull: '拉取',
        fetch: '获取',
        working: '处理中…',
        sessionPending: '正在等待会话就绪…',
        sessionGone: '这个会话仍未就绪；切换一次会话，或重开面板。',
        notRepo: '这里还不是 Git 仓库',
        gitUnavailableTitle: '无法运行 git',
        retry: '重试',
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
        undoDone: '已撤销 {hash}',
        undoneCount: '撤销 {n} 个提交',
        undoHint: '这个提交会被撤销，它的改动怎么处理：',
        rewindNoop: '分支指针本来就在那里，没有丢弃任何提交',
        dropped: '丢弃 {n} 个提交',
        noFiles: '这个提交没有文件变更（可能是空提交）。',
        cancel: '取消',
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
        revertCommit: '还原这次提交',
        revertHint: '新增一个反向提交来撤销它——已推送的历史用这个，而不是回滚',
        revertDone: '已还原 {hash}',
        pickCommit: '挑到当前分支',
        pickHint: '把这个提交的改动作为新提交应用到当前分支',
        pickDone: '已遴选 {hash}',
        rebaseHere: '变基到此',
        rebaseHint: '把当前分支的提交重放到这个提交之上（会改写这些提交）',
        rebaseWarn: '变基会重写当前分支上尚未推送的提交。如果别人已经拉过这些提交，请改用还原。',
        rebaseConfirm: '确认变基',
        rebaseDone: '已变基到 {hash}',
        tagPlaceholder: '标签名，如 v1.0.0',
        createTag: '打标签',
        tagCreated: '已创建标签 {name}',
        reviewTitle: '提交前审阅',
        reviewHint: '提交前审阅 · AI：让模型读一遍暂存的改动，只报告真会出问题的地方',
        reviewClean: '没有发现值得说的问题',
        reviewUnparsed: '模型的回答没能解析成条目，原文附在下方。',
        reviewDropped: '有 {n} 条被丢弃——它们指向的路径不在这次暂存里。',
        reviewFailed: '审阅没有完成',
        openThisFile: '打开这个文件的差异',
        closeReview: '关闭',
        splitTitle: '拆分提交',
        splitHint: '拆分提交 · AI：按意图把暂存的改动拆成几个独立的提交',
        splitNone: '没有可拆分的方案',
        splitIncomplete: '这个方案没有覆盖全部暂存文件，可能漏掉了一些——可以照样提交，但请先核对。',
        splitTruncated: '模型的回答被输出上限截断了。下面是能完整解析出来的 {n} 组，最后一组可能不完整——可以先提交这些，或点「重新规划」再要一次。',
        splitUnparsed: '模型的回答没能解析成方案，原文附在下方。',
        splitFailed: '没能给出拆分方案',
        commitThisGroup: '提交这一组',
        commitAllGroups: '全部提交（{n} 组）',
        commitAllHint: '按顺序提交这 {n} 组，每组只含它自己的文件。',
        splitCommitted: '已提交 {n} 组',
        splitPartial: '前面 {n} 组已提交，然后停下了',
        replan: '重新规划',
        mergeUp: '并入上一组',
        mergeUpHint: '把这一组的文件并进上一组，说明沿用上一组的（可改）',
        dropGroup: '删除这组',
        dropGroupHint: '只从方案里去掉这一组，不改动你的文件',
        busyStaging: '正在暂存…',
        busyUnstaging: '正在取消暂存…',
        busyDiscarding: '正在丢弃…',
        busyCommitting: '正在提交…',
        busyAmending: '正在修订上次提交…',
        busyCommitGroup: '正在提交这一组…',
        busyPushing: '正在推送…',
        busyPulling: '正在拉取…',
        busyFetching: '正在获取…',
        busySyncing: '正在同步…',
        busySwitching: '正在切换分支…',
        busyCreatingBranch: '正在新建分支…',
        busyDeletingBranch: '正在删除分支…',
        busyMerging: '正在合并…',
        busyAborting: '正在中止…',
        busyRewinding: '正在回滚…',
        busyReverting: '正在还原…',
        busyPicking: '正在遴选…',
        busyRebasing: '正在变基…',
        busyTagging: '正在打标签…',
        busyStashing: '正在贮藏…',
        busyRestoring: '正在取回贮藏…',
        busyDropping: '正在丢弃贮藏…',
        busyInitialising: '正在初始化仓库…',
        busyReadingHistory: '正在读取历史…',
        busyGenerating: '正在生成提交说明…',
        busyExplaining: '正在解释这个文件的改动…',
        busyReviewing: '正在审阅暂存的改动…',
        busySplitting: '正在规划拆分…',
        busyGitignore: '正在推断忽略规则…',
        busySettings: '正在读取设置…',
        busySaving: '正在保存…',
        busyWorking: '正在处理…',
        groupCommitted: '已提交 {hash}，还剩 {left} 组',
        sevBug: '缺陷',
        sevRisk: '风险',
        sevTest: '缺测试',
        sevStyle: '其他',
        stashes: '贮藏',
        stashHint: '把当前改动收起来，稍后再取回',
        stashesHint: '查看贮藏的改动',
        stashDone: '已把改动收进贮藏',
        stashNothing: '没有需要贮藏的改动',
        stashPop: '取回',
        stashPopHint: '取回并从贮藏中移除',
        stashApply: '保留取回',
        stashApplyHint: '取回但保留这条贮藏',
        stashDrop: '删除',
        stashRestored: '已取回贮藏的改动',
        stashKept: '已取回（有冲突，贮藏保留着）',
        stashDropped: '已删除这条贮藏',
        confirm: '确认',
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
        gitignoreNoneAdded: '没有需要新增的，',
        gitignoreTidied: '整理掉 {n} 条（重复，或已被上面的规则覆盖），',
        gitignoreGrouped: '并按分组归类。',
        gitignoreKeptOrder: '保留了原有顺序（文件里有 ! 规则或你自己的注释，重排会改变结果）。',
        pullDone: '已拉取',
        pushDone: '已推送',
        fetchDone: '已获取',
        initDone: '仓库已初始化',
        commitDone: '已提交 {hash}',
        stageDone: '已暂存',
        unstageDone: '已取消暂存',
        discardDone: '已丢弃',
        discardDeleted: '已删除 {n} 个新增文件',
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
        actionFailed: 'The operation failed',
        syncHint: 'Sync changes (fetch, fast-forward, push)',
        merge: 'Merge',
        mergeInto: 'Merge into {branch}',
        mergeDone: 'Merged {branch}',
        mergeFastForward: 'Fast-forwarded to {branch}',
        mergeUpToDate: '{branch} is already contained; nothing to merge',
        mergeAborted: 'The merge was aborted',
        abort: 'Abort ',
        abortMergeHint: 'Give up this operation and put the working tree back',
        opMerge: 'merge',
        opRebase: 'rebase',
        opCherryPick: 'cherry-pick',
        opRevert: 'revert',
        operationAborted: 'Aborted the {what}',
        syncCurrent: 'Already up to date',
        syncPublished: 'Pushed and set the upstream for {branch}',
        syncPulled: 'Pulled {n} commit(s)',
        syncPushed: 'Pushed {n} commit(s)',
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
        aiMark: 'AI',
        generating: 'Generating…',
        commit: 'Commit',
        committing: 'Committing…',
        pushAfter: 'Push after committing',
        amend: 'Amend last commit',
        amendCommit: 'Amend',
        amendHint: 'Fold the staged changes into the previous commit; an empty message box keeps the existing one',
        remote: 'Remote',
        push: 'Push',
        pull: 'Pull',
        fetch: 'Fetch',
        working: 'Working…',
        sessionPending: 'Waiting for the session to come up…',
        sessionGone: 'This session is still not ready. Switch sessions, or reopen the panel.',
        notRepo: 'This directory is not a Git repository',
        gitUnavailableTitle: 'git could not be run',
        retry: 'Try again',
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
        undoDone: 'Undid {hash}',
        undoneCount: '{n} commit(s) undone',
        undoHint: 'This commit is undone. Its changes are:',
        rewindNoop: 'The branch was already there — nothing was discarded',
        dropped: '{n} commit(s) dropped',
        noFiles: 'This commit changed no files (it may be empty).',
        cancel: 'Cancel',
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
        revertCommit: 'Revert this commit',
        revertHint: 'Undo it with an inverse commit — use this for history that is already pushed, not a rewind',
        revertDone: 'Reverted {hash}',
        pickCommit: 'Cherry-pick here',
        pickHint: 'Apply this commit\'s change to the checked-out branch as a new commit',
        pickDone: 'Picked {hash}',
        rebaseHere: 'Rebase onto this',
        rebaseHint: 'Replay this branch\'s commits on top of this one (rewrites them)',
        rebaseWarn: 'A rebase rewrites the unpushed commits on this branch. If anyone already pulled them, revert instead.',
        rebaseConfirm: 'Rebase',
        rebaseDone: 'Rebased onto {hash}',
        tagPlaceholder: 'Tag name, e.g. v1.0.0',
        createTag: 'Tag',
        tagCreated: 'Created tag {name}',
        reviewTitle: 'Review before commit',
        reviewHint: 'Review before commit · AI: have the model read the staged changes and report only what would bite',
        reviewClean: 'Nothing worth flagging',
        reviewUnparsed: 'The answer did not parse into findings; the raw reply is below.',
        reviewDropped: '{n} finding(s) dropped — they named a path that is not staged.',
        reviewFailed: 'The review did not finish',
        openThisFile: 'Open this file\'s diff',
        closeReview: 'Close',
        splitTitle: 'Split this commit',
        splitHint: 'Split this commit · AI: divide the staged changes into separate commits by intent',
        splitNone: 'No split to propose',
        splitIncomplete: 'This plan does not cover every staged file — it may be missing some. You can still commit, but check first.',
        splitTruncated: 'The answer was cut off by the output limit. These are the {n} group(s) that parsed completely; the last one may be incomplete. Commit these, or plan again for a fresh attempt.',
        splitUnparsed: 'The answer did not parse into a plan; the raw reply is below.',
        splitFailed: 'No split could be planned',
        commitThisGroup: 'Commit this group',
        commitAllGroups: 'Commit all ({n})',
        commitAllHint: 'Commits these {n} groups in order, each with only its own files.',
        splitCommitted: 'Committed {n} group(s)',
        splitPartial: 'The first {n} group(s) committed, then it stopped',
        replan: 'Plan again',
        mergeUp: 'Merge up',
        mergeUpHint: 'Fold this group into the one above, keeping that message (editable)',
        dropGroup: 'Remove',
        dropGroupHint: 'Take this group out of the plan only; your files are untouched',
        busyStaging: 'Staging…',
        busyUnstaging: 'Unstaging…',
        busyDiscarding: 'Discarding…',
        busyCommitting: 'Committing…',
        busyAmending: 'Amending the last commit…',
        busyCommitGroup: 'Committing this group…',
        busyPushing: 'Pushing…',
        busyPulling: 'Pulling…',
        busyFetching: 'Fetching…',
        busySyncing: 'Syncing…',
        busySwitching: 'Switching branch…',
        busyCreatingBranch: 'Creating the branch…',
        busyDeletingBranch: 'Deleting the branch…',
        busyMerging: 'Merging…',
        busyAborting: 'Aborting…',
        busyRewinding: 'Rewinding…',
        busyReverting: 'Reverting…',
        busyPicking: 'Cherry-picking…',
        busyRebasing: 'Rebasing…',
        busyTagging: 'Tagging…',
        busyStashing: 'Stashing…',
        busyRestoring: 'Restoring the stash…',
        busyDropping: 'Dropping the stash…',
        busyInitialising: 'Initialising the repository…',
        busyReadingHistory: 'Reading history…',
        busyGenerating: 'Writing the commit message…',
        busyExplaining: 'Explaining this change…',
        busyReviewing: 'Reviewing the staged changes…',
        busySplitting: 'Planning the split…',
        busyGitignore: 'Inferring the ignore rules…',
        busySettings: 'Reading settings…',
        busySaving: 'Saving…',
        busyWorking: 'Working…',
        groupCommitted: 'Committed {hash}, {left} group(s) left',
        sevBug: 'Bug',
        sevRisk: 'Risk',
        sevTest: 'Test',
        sevStyle: 'Other',
        stashes: 'Stashes',
        stashHint: 'Set the current changes aside and take them back later',
        stashesHint: 'Show the stashed changes',
        stashDone: 'Stashed the changes',
        stashNothing: 'There is nothing to stash',
        stashPop: 'Pop',
        stashPopHint: 'Restore and remove this stash',
        stashApply: 'Apply',
        stashApplyHint: 'Restore but keep this stash',
        stashDrop: 'Drop',
        stashRestored: 'Restored the stashed changes',
        stashKept: 'Restored (a conflict kept the stash in place)',
        stashDropped: 'Dropped that stash',
        confirm: 'Confirm',
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
        gitignoreNoneAdded: 'nothing needed adding,',
        gitignoreTidied: 'tidied away {n} line(s) (duplicates, or already covered by a rule above),',
        gitignoreGrouped: 'and grouped the entries under headings.',
        gitignoreKeptOrder: 'the original order is kept (the file has ! rules or your own comments, and reordering would change the outcome).',
        pullDone: 'Pulled',
        pushDone: 'Pushed',
        fetchDone: 'Fetched',
        initDone: 'Repository initialized',
        commitDone: 'Committed {hash}',
        stageDone: 'Staged',
        unstageDone: 'Unstaged',
        discardDone: 'Discarded',
        discardDeleted: 'Deleted {n} new file(s)',
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
        if (!response.ok) {
          // Answer with everything needed to tell the two failure modes apart: a
          // JSON envelope means this route ran and threw, while anything else
          // means the request never reached it — a plugin that did not activate,
          // or a path the Host does not serve.
          let detail = '';
          try {
            const raw = await response.text();
            try {
              const body = JSON.parse(raw);
              detail = typeof body?.error?.message === 'string' ? body.error.message : '';
            } catch {
              detail = raw.trim().replace(/\s+/g, ' ').slice(0, 240);
            }
          } catch {
            detail = '';
          }
          const where = `${endpoint}${response.status === 404 ? ' — this Host does not serve the panel route' : ''}`;
          return {
            error: detail === '' ? `the host answered HTTP ${response.status} (${where})` : `${detail} (HTTP ${response.status}, ${where})`,
            code: 'dsh-git/internal',
          };
        }
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

    /** A turning arc, for anything the panel is waiting on. */
    const Spinner = ({ size = 13 }) =>
      h(
        Glyph,
        { size, className: 'dsg-spin' },
        h('circle', { cx: 12, cy: 12, r: 8, opacity: 0.25 }),
        h('path', { d: 'M12 4a8 8 0 0 1 8 8' }),
      );

    /** A label for the controls that ask a model to do something. */
    const aiChip = (corner) => h('span', { className: `dsg-ai${corner ? ' dsg-ai-corner' : ''}` }, 'AI');

    /** A magnifier over a line: read the change before committing it. */
    const IconReview = (p) =>
      h(
        Glyph,
        p,
        h('circle', { cx: 10.5, cy: 10.5, r: 6 }),
        h('path', { d: 'm15 15 4.5 4.5' }),
        h('path', { d: 'M8 11.5h5' }),
      );

    /** One line parting into two: one change, several commits. */
    const IconSplit = (p) =>
      h(
        Glyph,
        p,
        h('path', { d: 'M4 12h5' }),
        h('path', { d: 'M13 6.5h7' }),
        h('path', { d: 'M13 17.5h7' }),
        h('path', { d: 'M9 12c0-3 1.5-5.5 4-5.5' }),
        h('path', { d: 'M9 12c0 3 1.5 5.5 4 5.5' }),
      );

    /** A box with a lid: work put away for later. */
    const IconStash = (p) =>
      h(
        Glyph,
        p,
        h('path', { d: 'M4 5h16v4H4z' }),
        h('path', { d: 'M5.5 9v9.5a.5.5 0 0 0 .5.5h12a.5.5 0 0 0 .5-.5V9' }),
        h('path', { d: 'M10 13h4' }),
      );

    /** Two arrows in a cycle: this moves commits in both directions. */
    const IconSync = (p) =>
      h(
        Glyph,
        p,
        h('path', { d: 'M4.5 9.5A7.5 7.5 0 0 1 18 7' }),
        h('path', { d: 'M18 3.5V7h-3.5' }),
        h('path', { d: 'M19.5 14.5A7.5 7.5 0 0 1 6 17' }),
        h('path', { d: 'M6 20.5V17h3.5' }),
      );
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
.dsg-toasts { position:absolute; left:10px; right:10px; bottom:8px; z-index:19; display:flex; flex-direction:column; align-items:center; gap:6px; pointer-events:none; }
/* Elevated so it reads as floating over the list rather than as part of it. */
.dsg-toast { margin:0; pointer-events:auto; width:max-content; max-width:100%; padding:7px 13px; align-items:center; text-align:center; /* Opaque: the overlay token is a translucent wash, which read as a grey smudge over the list. */ background:var(--dsw-alias-bg-base); border-color:var(--dsw-alias-border-l2); box-shadow:0 6px 20px color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent); }
.dsg-toast-running { flex-direction:row; align-items:center; gap:6px; padding:5px 12px; border-radius:999px; color:var(--dsw-alias-label-primary); }
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
/* An open commit leads with what you can do to it, then what it says: the
   controls are the decision, the message is the reading. */
.dsg-htools { display:flex; flex-direction:column; gap:7px; padding:8px 0 0; }
.dsg-hbody { display:flex; flex-direction:column; gap:7px; padding:8px 0 2px; }
.dsg-hmessage { margin:0; padding:7px 8px; border:1px solid var(--dsw-alias-border-l1); border-radius:8px; background:var(--dsw-alias-bg-base); font-family:inherit; font-size:11px; line-height:1.65; white-space:pre-wrap; overflow-wrap:anywhere; color:var(--dsw-alias-label-primary); }
.dsg-hfiles { display:flex; flex-direction:column; gap:3px; }
.dsg-tag-input { flex:1 1 auto; min-width:0; }
/* Review findings: a severity chip, what it is, and where to look. */
/* One tooltip, anchored to the panel root: a bubble inside a button would be
   clipped by the hero's own overflow, and the shell's own tooltips do not reach
   a plugin's markup. */
.dsg-spin { animation:dsg-turn 900ms linear infinite; }
@keyframes dsg-turn { from { transform:rotate(0deg); } to { transform:rotate(360deg); } }
.dsg-tip { position:absolute; z-index:20; transform:translateX(-50%); max-width:min(230px, calc(100% - 12px)); padding:4px 8px; border:1px solid var(--dsw-alias-border-l2); border-radius:7px; background:var(--dsw-alias-bg-overlay); color:var(--dsw-alias-label-primary); font-size:10.5px; line-height:1.45; text-align:left; pointer-events:none; box-shadow:0 6px 18px color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent); }
/* Says which controls spend a model call before they are pressed. */
.dsg-ai { flex:0 0 auto; border:1px solid var(--dsw-alias-border-l2); border-radius:4px; padding:0 3px; margin-left:1px; font-size:8px; line-height:1.5; letter-spacing:.03em; color:var(--dsw-alias-label-secondary); }
.dsg-ai-corner { position:absolute; top:-5px; right:-5px; margin-left:0; background:var(--dsw-alias-bg-base); }
.dsg-btn-icon { position:relative; }
.dsg-review-head { display:flex; align-items:center; gap:6px; padding:8px 10px 6px; position:sticky; top:0; background:var(--dsw-alias-bg-base); z-index:1; }
.dsg-finding { display:flex; align-items:flex-start; gap:7px; width:100%; appearance:none; border:none; border-bottom:1px solid var(--dsw-alias-border-l1); background:none; color:inherit; font:inherit; text-align:left; padding:7px 10px; cursor:pointer; }
.dsg-finding:hover { background:var(--dsw-alias-bg-layer-1); }
.dsg-sev { flex:0 0 auto; border:1px solid currentColor; border-radius:5px; padding:1px 5px; font-size:9.5px; line-height:1.5; }
.dsg-sev-bug { color:var(--dsw-alias-state-error-primary); }
.dsg-sev-risk { color:var(--dsw-alias-state-warn-primary); }
.dsg-sev-test { color:var(--dsw-alias-label-secondary); }
.dsg-sev-style { color:var(--dsw-alias-label-secondary); }
.dsg-finding-main { flex:1 1 auto; min-width:0; display:flex; flex-direction:column; gap:2px; }
.dsg-finding-what { font-size:11.5px; line-height:1.5; }
.dsg-finding-fix { font-size:10.5px; color:var(--dsw-alias-label-secondary); line-height:1.5; }
.dsg-finding-where { flex:0 0 auto; max-width:38%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; direction:rtl; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:10px; color:var(--dsw-alias-label-secondary); }
/* One proposed commit: its message, the files it takes, and the button. */
.dsg-group { display:flex; flex-direction:column; gap:6px; padding:9px 10px; border-bottom:1px solid var(--dsw-alias-border-l1); }
.dsg-group-head { display:flex; align-items:baseline; gap:6px; font-size:11px; color:var(--dsw-alias-label-secondary); }
.dsg-group-why { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsg-btn-tiny { padding:1px 6px; font-size:10px; }
.dsg-group-all { gap:7px; border-top:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); }
.dsg-group-message { margin:0; width:100%; box-sizing:border-box; resize:vertical; padding:7px 8px; border:1px solid var(--dsw-alias-border-l1); border-radius:8px; background:var(--dsw-alias-bg-base); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px; line-height:1.6; white-space:pre-wrap; overflow-wrap:anywhere; }
.dsg-group-paths { display:flex; flex-wrap:wrap; gap:4px; }
.dsg-group-path { border:1px solid var(--dsw-alias-border-l1); border-radius:5px; padding:1px 5px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:10px; color:var(--dsw-alias-label-secondary); }
.dsg-hfile { display:flex; align-items:center; gap:6px; width:100%; appearance:none; border:none; background:none; padding:1px 0; color:inherit; font:inherit; font-size:10.5px; text-align:left; cursor:pointer; border-radius:5px; }
.dsg-hfile:hover { background:var(--dsw-alias-bg-layer-1); }
.dsg-hfile-open { color:var(--dsw-alias-label-primary); }
/* The commit's own diff, indented under the file it belongs to. */
.dsg-hfile-diff { margin:3px 0 5px 7px; padding-left:7px; border-left:2px solid var(--dsw-alias-border-l1); }
.dsg-hfile-path { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; direction:rtl; text-align:left; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--dsw-alias-label-secondary); }
/* Destructive work states its consequence in the warning colour before it offers
   the buttons, and the hardest mode confirms separately. */
.dsg-danger { display:flex; flex-direction:column; gap:7px; padding:8px; border:1px solid var(--dsw-alias-state-warn-primary); border-radius:8px; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font-size:11px; }
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

    /** Translation key naming an operation git is in the middle of. */
    function opLabelKey(operation) {
      switch (operation) {
        case 'rebase':
          return 'opRebase';
        case 'cherry-pick':
          return 'opCherryPick';
        case 'revert':
          return 'opRevert';
        default:
          return 'opMerge';
      }
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
    function FileRow({ entry, scope, active, lines, onToggle, onAction, busy, confirming, confirmKey, t, tip }) {
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
            ...tip(entry.path),
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
            ...tip(isStaged ? t('unstage') : t('stage')),
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
                ...tip(armed ? t('confirmDiscard') : t('discard')),
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
        const [amend, setAmend] = useState(false);
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
        /** True while the message on screen came from a status read, not an action. */
        const statusError = useRef(false);
        const [history, setHistory] = useState(null);
        const [openCommit, setOpenCommit] = useState(null);
        const [commits, setCommits] = useState({});
        const [rewind, setRewind] = useState(null);
        const [rebaseAt, setRebaseAt] = useState(null);
        const [tagName, setTagName] = useState('');
        /**
         * Whether git is entirely unusable here.
         *
         * Kept in a ref as well as in `status`, because the poll interval must
         * not be torn down and recreated every time the status object changes.
         */
        const unavailableRef = useRef(false);

        /** The one tooltip on screen, anchored to the button that asked for it. */
        const [tooltip, setTooltip] = useState(null);
        /** The staged-change review, or null; `mode` switches the list area over. */
        const [review, setReview] = useState(null);
        const [split, setSplit] = useState(null);
        /** Which file of which commit is expanded, and its parsed diff. */
        const [commitFile, setCommitFile] = useState(null);
        const [commitPatch, setCommitPatch] = useState(null);
        const [stashes, setStashes] = useState(null);
        const [stashOpen, setStashOpen] = useState(false);
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
              statusError.current = true;
              setError(answer.error);
              return undefined;
            }
            // Only clear a message this function put there. Wiping every error
            // meant the poll erased a failed push within five seconds — and the
            // refresh that follows an action erased it before it could be read.
            if (statusError.current) {
              statusError.current = false;
              setError('');
            }
            unavailableRef.current = answer.value?.unavailable === true;
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
            // git cannot run on this machine at all — every probe re-attempts the
            // same sandbox start-up, which fails the same way and, on Windows,
            // has been observed to leave the whole run unable to write. Probing
            // every five seconds cannot fix it; the error card carries a retry.
            if (unavailableRef.current) return;
            void refresh(true);
          };
          const timer = setInterval(tick, POLL_MS);
          return () => clearInterval(timer);
        }, [refresh, busy]);

        // A repository can stop being one while the panel is open — the folder
        // was switched, or `.git` was removed. The history view has nothing to
        // render then, and leaving the button lit next to the empty state would
        // claim otherwise.
        useEffect(() => {
          if (status !== null && status !== undefined && status.isRepo !== true && view === 'history') {
            setView('changes');
          }
          return undefined;
        }, [status, view]);

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
            if (answer.value?.ok === false) {
              // The Host answers a refused operation with `{ ok: false, error }`
              // rather than a transport failure — a diverged branch, a rejected
              // push. Reporting that through the success notice told the user the
              // opposite of what happened.
              setError(answer.value.error ?? t('actionFailed'));
              await refresh(true);
              return answer.value;
            }
            if (report) setNotice(report(answer.value));
            await refresh(true);
            return answer.value;
          },
          [refresh, request, t],
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
            // Deleting a new file is a bigger outcome than reverting an edit, so
            // say which one happened rather than reporting both as "discarded".
            await act(label, 'stage', { action, paths }, (result) =>
              label === 'discard' && (result?.removed?.length ?? 0) > 0
                ? t('discardDeleted').replace('{n}', String(result.removed.length))
                : t(done),
            );
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
          // Amending with an empty box keeps the message already there: the Host
          // turns `amend` without a message into `--no-edit` rather than asking
          // the model for a new one.
          const value = await act(
            'commit',
            'commit',
            { ...(trimmed === '' ? {} : { message: trimmed }), ...(amend ? { amend: true } : {}) },
            (result) => t('commitDone').replace('{hash}', result?.shortHash ?? ''),
          );
          if (value?.ok === true) {
            setMessage('');
            setPatch(null);
            setSummary(null);
            setOpen(null);
            if (pushAfter) await act('push', 'sync', { action: 'push' }, () => t('pushDone'));
          }
        }, [act, amend, message, pushAfter, t]);

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



        /** Read the stash list. */
        const loadStashes = useCallback(async () => {
          const answer = await request('stash', { action: 'list' });
          if (!mounted.current) return [];
          if (answer.error) {
            setError(answer.error);
            return [];
          }
          const entries = answer.value?.stashes ?? [];
          setStashes(entries);
          return entries;
        }, [request]);

        /** Set the working tree aside, or open the list when there is one to show. */
        const toggleStash = useCallback(async () => {
          const entries = stashes ?? (await loadStashes());
          if (!mounted.current) return;
          if (entries.length === 0) {
            await act('stash', 'stash', { action: 'push' }, (result) =>
              result?.nothingToStash === true ? t('stashNothing') : t('stashDone'),
            );
            await loadStashes();
            return;
          }
          setStashOpen((open) => !open);
        }, [act, loadStashes, stashes, t]);

        const restoreStash = useCallback(
          async (index, drop) => {
            setStashOpen(false);
            await act(drop ? 'pop' : 'apply', 'stash', { action: drop ? 'pop' : 'apply', index }, (result) =>
              result?.kept === true ? t('stashKept') : t('stashRestored'),
            );
            await loadStashes();
          },
          [act, loadStashes, t],
        );

        const dropStash = useCallback(
          async (index) => {
            await act('drop', 'stash', { action: 'drop', index }, () => t('stashDropped'));
            await loadStashes();
          },
          [act, loadStashes, t],
        );

        /** Keep the stash count current with the rest of the panel. */
        useEffect(() => {
          if (!status?.isRepo) return undefined;
          void loadStashes();
          return undefined;
        }, [loadStashes, status?.isRepo]);

        /**
         * What the panel is waiting for, in words.
         *
         * Every button goes unavailable while an operation runs, so silence reads
         * as a frozen panel; this is the label the running pill and the busy
         * buttons both use.
         */
        const busyLabel = (kind) =>
          ({
            stage: t('busyStaging'),
            unstage: t('busyUnstaging'),
            discard: t('busyDiscarding'),
            commit: amend ? t('busyAmending') : t('busyCommitting'),
            commitGroup: t('busyCommitGroup'),
            push: t('busyPushing'),
            pull: t('busyPulling'),
            fetch: t('busyFetching'),
            sync: t('busySyncing'),
            branch: t('busySwitching'),
            createBranch: t('busyCreatingBranch'),
            deleteBranch: t('busyDeletingBranch'),
            merge: t('busyMerging'),
            abort: t('busyAborting'),
            rollback: t('busyRewinding'),
            rewind: t('busyRewinding'),
            revert: t('busyReverting'),
            cherryPick: t('busyPicking'),
            rebase: t('busyRebasing'),
            tag: t('busyTagging'),
            stash: t('busyStashing'),
            pop: t('busyRestoring'),
            apply: t('busyRestoring'),
            drop: t('busyDropping'),
            init: t('busyInitialising'),
            history: t('busyReadingHistory'),
            generate: t('busyGenerating'),
            explain: t('busyExplaining'),
            review: t('busyReviewing'),
            split: t('busySplitting'),
            gitignore: t('busyGitignore'),
            settings: t('busySettings'),
            save: t('busySaving'),
            saveSettings: t('busySaving'),
          })[kind] ?? t('busyWorking');

        /**
         * Hover text for one control.
         *
         * The shell draws its own tooltips, so a native `title` never surfaces
         * here. This anchors one bubble to the panel root instead: a bubble inside
         * a button would be clipped by the hero's own overflow.
         * @param text - what to say.
         */
        const tip = (text) => ({
          'data-tip': text,
          'aria-label': text,
          onPointerEnter: (event) => {
            const root = rootRef.current?.getBoundingClientRect();
            const box = event.currentTarget.getBoundingClientRect();
            if (root === undefined || root === null) return;
            // Kept inside the panel so a bubble on the trailing buttons is not cut off.
            const half = 66;
            const centre = box.left - root.left + box.width / 2;
            setTooltip({
              text,
              x: Math.min(Math.max(centre, half), Math.max(half, root.width - half)),
              y: box.bottom - root.top + 6,
            });
          },
          onPointerLeave: () => setTooltip(null),
          onBlur: () => setTooltip(null),
        });

        /** Review the staged change set before committing it. */
        const runReview = useCallback(async () => {
          setBusy('review');
          setError('');
          const answer = await request('review');
          if (!mounted.current) return;
          setBusy('');
          if (answer.error || answer.value?.ok !== true) {
            setError(answer.error ?? answer.value?.error ?? t('reviewFailed'));
            return;
          }
          setSplit(null);
          setReview(answer.value);
        }, [request, t]);

        /** Ask how the staged change set would divide into standalone commits. */
        const planSplit = useCallback(async () => {
          setBusy('split');
          setError('');
          const answer = await request('split');
          if (!mounted.current) return;
          setBusy('');
          if (answer.error || answer.value?.ok !== true) {
            setError(answer.error ?? answer.value?.error ?? t('splitFailed'));
            return;
          }
          setReview(null);
          setSplit(answer.value);
        }, [request, t]);

        /** Replace one group in the plan without disturbing the others. */
        const editGroup = useCallback((index, patch) => {
          setSplit((current) =>
            current === null || !Array.isArray(current.groups)
              ? current
              : { ...current, groups: current.groups.map((group, at) => (at === index ? { ...group, ...patch } : group)) },
          );
        }, []);

        /**
         * Fold a group into the one above it.
         *
         * A model divides by intent as it read the diff, which is not always the
         * division the author wants; merging two groups is the common correction,
         * and doing it here is cheaper than asking for a new plan.
         */
        const mergeGroupIntoPrevious = useCallback((index) => {
          if (index === 0) return;
          setSplit((current) => {
            if (current === null || !Array.isArray(current.groups)) return current;
            const groups = current.groups.map((group) => ({ ...group, paths: [...group.paths] }));
            const previous = groups[index - 1];
            const joining = groups[index];
            previous.paths = [...new Set([...previous.paths, ...joining.paths])];
            // The earlier message described a narrower set; attach the other
            // reason so nothing that was written for it is silently dropped.
            if (joining.why !== '' && !previous.why.includes(joining.why)) {
              previous.why = previous.why === '' ? joining.why : `${previous.why} + ${joining.why}`;
            }
            return { ...current, groups: groups.filter((_, at) => at !== index) };
          });
        }, []);

        /**
         * Commit every group in the plan, in order.
         *
         * Each commit takes its own paths and leaves the rest staged, so the plan
         * can run to the end; the sequence stops at the first refusal and says how
         * far it got rather than reporting a success it did not have.
         */
        const commitAllGroups = useCallback(async () => {
          const groups = (split?.groups ?? []).filter((group) => group.paths.length > 0 && group.message.trim() !== '');
          if (groups.length === 0) return;
          setBusy('commitGroup');
          setError('');
          let done = 0;
          for (const group of groups) {
            const answer = await request('commitGroup', { paths: group.paths, message: group.message.trim() });
            if (!mounted.current) return;
            if (answer.error || answer.value?.ok !== true) {
              setBusy('');
              setError(answer.error ?? answer.value?.error ?? t('actionFailed'));
              await refresh(true);
              if (done > 0) setNotice(t('splitPartial').replace('{n}', String(done)));
              return;
            }
            done += 1;
          }
          setBusy('');
          setNotice(t('splitCommitted').replace('{n}', String(done)));
          setSplit(null);
          setMessage('');
          await refresh(true);
        }, [refresh, request, split, t]);

        /** Commit one proposed group, leaving the others for the next round. */
        const commitGroup = useCallback(
          async (group, index) => {
            const total = (split?.groups ?? []).length;
            const value = await act(
              'commitGroup',
              'commitGroup',
              { paths: group.paths, message: group.message.trim() },
              (result) =>
                t('groupCommitted')
                  .replace('{hash}', result?.shortHash ?? '')
                  .replace('{left}', String(Math.max(0, total - 1))),
            );
            if (value?.ok !== true || !mounted.current) return;
            setMessage('');
            // The committed group leaves the plan; the rest still describe what is
            // staged, so the plan is kept and its committed row is dropped. Asking
            // the model again here would silently replace an edited plan.
            setSplit((current) =>
              current === null || !Array.isArray(current.groups)
                ? current
                : { ...current, groups: current.groups.filter((_, at) => at !== index) },
            );
          },
          [act, split?.groups, t],
        );

        /**
         * Read one file's change inside one commit.
         *
         * Same parser and same renderer as the working-tree view: the Host answers
         * scope "commit" with the rows the panel already knows how to draw.
         */
        const openCommitFile = useCallback(
          async (commit, path) => {
            if (commitFile !== null && commitFile.hash === commit.hash && commitFile.path === path) {
              setCommitFile(null);
              setCommitPatch(null);
              return;
            }
            setCommitFile({ hash: commit.hash, path });
            setCommitPatch(null);
            const answer = await request('diff', {
              scope: 'commit',
              revision: commit.hash,
              paths: [path],
              maxBytes: DIFF_CHAR_CAP,
            });
            if (!mounted.current) return;
            if (answer.error) {
              setError(answer.error);
              return;
            }
            setError('');
            setCommitPatch(answer.value);
          },
          [commitFile, request],
        );

        /** Undo a commit by adding its inverse — the safe way for pushed history. */
        const revertCommit = useCallback(
          async (commit) => {
            await act('revert', 'revert', { revision: commit.hash }, () =>
              t('revertDone').replace('{hash}', commit.shortHash),
            );
          },
          [act, t],
        );

        /** Lift this commit's change onto the checked-out branch. */
        const pickCommit = useCallback(
          async (commit) => {
            await act('cherryPick', 'cherryPick', { revisions: [commit.hash] }, () =>
              t('pickDone').replace('{hash}', commit.shortHash),
            );
          },
          [act, t],
        );

        /** Replay the current branch on top of this commit. Rewrites history, so it asks first. */
        const rebaseOnto = useCallback(
          async (commit) => {
            setRebaseAt(null);
            await act('rebase', 'rebase', { onto: commit.hash }, () => t('rebaseDone').replace('{hash}', commit.shortHash));
          },
          [act, t],
        );

        const createTag = useCallback(
          async (commit) => {
            const name = tagName.trim();
            if (name === '') return;
            await act('tag', 'tag', { action: 'create', name, revision: commit.hash }, () =>
              t('tagCreated').replace('{name}', name),
            );
            setTagName('');
          },
          [act, tagName, t],
        );

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
            // Two different operations wear this dialog. On the newest commit the
            // button says "undo this commit", so the commit itself goes away and
            // the reset is one step back; on any older commit it says "rewind to
            // here", so the reset lands ON that commit. Passing the hash in both
            // cases made the first one `reset --soft HEAD` — a no-op that reported
            // itself as a rewind.
            const newest = commit.hash === history?.head;
            const answer = await request('reset', { mode, ...(newest ? {} : { target: commit.hash }) });
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
            // The count is reported even when it is zero: that is the case where
            // it matters most, and it used to be dropped for being falsy.
            const dropped = answer.value.dropped;
            setNotice(
              [
                // The Host reports which commit it actually undid; trusting the row
                // that was clicked would misname it if the list had gone stale.
                (newest ? t('undoDone') : t('rewindDone')).replace(
                  '{hash}',
                  String(answer.value.undone?.hash ?? commit.shortHash),
                ),
                Number.isFinite(dropped)
                  ? `(${(newest ? t('undoneCount') : t('dropped')).replace('{n}', String(dropped))})`
                  : '',
                dropped === 0 ? t('rewindNoop') : '',
                answer.value.published ? t('rollbackPublished') : '',
              ]
                .filter((part) => part !== '')
                .join(' '),
            );
            await loadHistory();
            await refresh(true);
          },
          [history?.head, loadHistory, refresh, request, t],
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
            // Even with nothing to add, the file is still worth tidying: entries
            // pile up as duplicates, and a rule an earlier one already covers is
            // noise. Returning early here is why "optimise" only ever appended.
            const entries = suggestion.value.added ?? [];
            const answer = await request('gitignore', { action: 'write', entries, organize: true });
            if (!mounted.current) return;
            setBusy('');
            if (answer.error || answer.value?.ok === false) {
              setError(answer.error ?? answer.value?.error ?? t('gitignoreFailed'));
              return;
            }
            const added = answer.value?.added?.length ?? 0;
            const removed = answer.value?.removed?.length ?? 0;
            if (answer.value?.unchanged === true) {
              setNotice(t('gitignoreNothing'));
            } else {
              setNotice(
                [
                  added > 0
                    ? t('gitignoreAdded')
                        .replace('{n}', String(added))
                        .replace('{source}', t(suggestion.value.source === 'model' ? 'gitignoreByModel' : 'gitignoreByRules'))
                    : t('gitignoreNoneAdded'),
                  removed > 0 ? t('gitignoreTidied').replace('{n}', String(removed)) : '',
                  // Grouping moves lines, so it only happens when that cannot
                  // change the outcome; naming which one happened avoids the
                  // impression that it silently refused.
                  answer.value?.grouped === true ? t('gitignoreGrouped') : t('gitignoreKeptOrder'),
                ]
                  .filter((part) => part !== '')
                  .join(' '),
              );
            }
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
                disabled: disabled || !status?.isRepo,
                ...tip(t('syncHint')),
                onClick: () => void syncNow(),
              },
              h(IconSync, { size: 15 }),
            ),
            h(
              'button',
              {
                type: 'button',
                className: `dsg-btn dsg-btn-icon${view === 'history' ? ' dsg-btn-primary' : ' dsg-btn-quiet'}`,
                // There is no history to show without a repository. Settings stays
                // enabled on purpose: it is where someone looks when the panel is
                // not doing what they expect.
                disabled: disabled || status?.isRepo !== true,
                ...tip(view === 'history' ? t('back') : t('history')),
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
                ...tip(view === 'settings' ? t('back') : t('settings')),
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
                // A clean tree says so once, in the list's own empty state. A line
                // up here said it twice on the same screen.
                h('span', { className: 'dsg-spacer' }),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsg-btn dsg-btn-icon dsg-btn-quiet',
                    disabled,
                    ...tip((stashes ?? []).length > 0 ? t('stashesHint') : t('stashHint')),
                    onClick: () => void toggleStash(),
                  },
                  h(IconStash, { size: 13 }),
                  (stashes ?? []).length > 0
                    ? h('span', { className: 'dsg-hint' }, String(stashes.length))
                    : null,
                ),
                // Remote work belongs beside the divergence it acts on, not at
                // the bottom of the commit form.
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsg-btn dsg-btn-icon dsg-btn-quiet',
                    disabled,
                    ...tip(t('push')),
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
                    ...tip(t('pull')),
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
                    ...tip(t('fetch')),
                    onClick: () => void act('fetch', 'sync', { action: 'fetch' }, () => t('fetchDone')),
                  },
                  h(IconFetch, { size: 13 }),
                ),
              )
            : null,
        );

        /**
         * The stash: one button that sets the tree aside, and a list once there is
         * something in it. Restoring offers both "keep the stash" and "drop it",
         * because only the user knows whether the work is finished.
         */
        const stashPanel =
          stashOpen && (stashes ?? []).length > 0
            ? h(
                'div',
                { className: 'dsg-popover' },
                h(
                  'div',
                  { className: 'dsg-popover-head' },
                  h('span', { className: 'dsg-popover-title' }, t('stashes')),
                  h('span', { className: 'dsg-count dsg-count-quiet' }, String(stashes.length)),
                ),
                h(
                  'div',
                  { className: 'dsg-popover-list' },
                  stashes.map((entry, index) =>
                    h(
                      'div',
                      { className: 'dsg-branch-row', key: entry.ref },
                      h(
                        'span',
                        { className: 'dsg-branch-row-name', title: entry.subject },
                        entry.subject,
                      ),
                      h('span', { className: 'dsg-branch-track' }, entry.when),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsg-btn dsg-btn-quiet dsg-btn-reveal',
                          disabled,
                          ...tip(t('stashPopHint')),
                          onClick: () => void restoreStash(index, true),
                        },
                        t('stashPop'),
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsg-btn dsg-btn-quiet dsg-btn-reveal',
                          disabled,
                          ...tip(t('stashApplyHint')),
                          onClick: () => void restoreStash(index, false),
                        },
                        t('stashApply'),
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: `dsg-btn dsg-btn-icon dsg-btn-quiet dsg-btn-reveal${
                            confirming === `stashdrop:${entry.ref}` ? ' dsg-btn-armed' : ''
                          }`,
                          disabled,
                          ...tip(t('stashDrop')),
                          onClick: () => {
                            if (confirming === `stashdrop:${entry.ref}`) void dropStash(index);
                            else setConfirming(`stashdrop:${entry.ref}`);
                          },
                        },
                        confirming === `stashdrop:${entry.ref}` ? t('confirm') : h(IconTrash, { size: 13 }),
                      ),
                    ),
                  ),
                ),
              )
            : null;

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
                          ...tip(entry.current ? t('currentBranch') : t('switchTo')),
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
                                ...tip(t('switchTo')),
                                onClick: () => void switchBranch(entry.name),
                              },
                              h(IconSwitch, { size: 13 }),
                            ),
                            h(
                              'button',
                              {
                                type: 'button',
                                className: 'dsg-btn dsg-btn-quiet dsg-btn-reveal',
                                disabled,
                                ...tip(t('mergeInto').replace('{branch}', status?.branch ?? '')),
                                onClick: () => void mergeBranch(entry.name),
                              },
                              t('merge'),
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

        // Two different failures wear the same "no repository" face. Offering to
        // create one is right for an ordinary folder and wrong when git never ran:
        // the user would press it, watch it fail, and still not learn that this
        // machine cannot start a sandbox.
        const emptyState =
          status?.unavailable === true
            ? h(
                'div',
                { className: 'dsg-empty' },
                h('span', { className: 'dsg-empty-mark' }, h(GitIcon, { size: 38 })),
                h('div', { className: 'dsg-empty-title' }, t('gitUnavailableTitle')),
                h('div', { className: 'dsg-empty-text' }, status.reason ?? ''),
                h(
                  'button',
                  { type: 'button', className: 'dsg-btn', disabled, onClick: () => void refresh(true) },
                  t('retry'),
                ),
              )
            : h(
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
                busy === 'explain' ? h(Spinner, { size: 13 }) : h(IconBubble, { size: 13 }),
                busy === 'explain' ? t('explaining') : t('explain'),
                aiChip(false),
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
        /** Which operation git is in the middle of, if any. */
        const inProgress = status?.operation ?? '';
        const conflictCount = (status?.conflicted ?? []).length;
        const bulkActions =
          unstagedCount === 0 && stagedCount === 0 && conflictCount === 0
            ? null
            : h(
                'div',
                { className: 'dsg-bulk' },
                conflictCount === 0
                  ? null
                  : h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsg-btn dsg-btn-warn',
                        disabled,
                        ...tip(t('abortMergeHint')),
                        onClick: () => void abortMerge(),
                      },
                      `${t('abort')}${t(opLabelKey(inProgress))}`,
                      h('span', { className: 'dsg-hint' }, String(conflictCount)),
                    ),
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
         * Merge a branch into the checked-out one.
         *
         * A conflicted merge comes back as a refusal carrying the file list, so
         * it lands in the error toast rather than a success notice — and the
         * bulk row grows an "abort the merge" button while the tree is mid-merge.
         */
        const mergeBranch = useCallback(
          async (name) => {
            setBranchOpen(false);
            await act('merge', 'branch', { action: 'merge', name }, (result) =>
              result?.upToDate === true
                ? t('mergeUpToDate').replace('{branch}', name)
                : t(result?.fastForward === true ? 'mergeFastForward' : 'mergeDone').replace('{branch}', name),
            );
          },
          [act, t],
        );

        /**
         * Leave whatever git is in the middle of.
         *
         * The marker in the git directory says which operation it is, and each
         * one has its own abort command, so the button is labelled and dispatched
         * from that rather than assuming a merge.
         */
        const abortMerge = useCallback(async () => {
          const op = status?.operation ?? 'merge';
          const endpoint = op === 'rebase' ? 'rebase' : op === 'cherry-pick' ? 'cherryPick' : op === 'revert' ? 'revert' : 'branch';
          const payload = op === 'merge' ? { action: 'abort' } : { abort: true };
          await act('abort', endpoint, payload, () => t('operationAborted').replace('{what}', t(opLabelKey(op))));
        }, [act, status, t]);

        /**
         * Talk to the remote once and settle both directions.
         *
         * Fetch, then fast-forward if the branch is behind and push if it is
         * ahead. The Host refuses to merge on our behalf, so a diverged branch
         * comes back as an explanation rather than a half-finished merge.
         */
        const syncNow = useCallback(async () => {
          await act('sync', 'sync', { action: 'sync' }, (result) => {
            if (result?.published === true) return t('syncPublished').replace('{branch}', result.branch);
            const pulled = result?.pulled ?? 0;
            const pushed = result?.pushed ?? 0;
            // Only one direction can ever move: being both ahead and behind is
            // divergence, and the Host refuses to merge that on its own.
            if (pulled === 0 && pushed === 0) return t('syncCurrent');
            return pulled > 0
              ? t('syncPulled').replace('{n}', String(pulled))
              : t('syncPushed').replace('{n}', String(pushed));
          });
        }, [act, t]);

        /**
         * The transient messages, as a floating layer.
         *
         * Inline, they sat a few pixels above the action row and shoved the whole
         * list down whenever one appeared or expired. Floating keeps the list
         * still; they are anchored to the top of the content area, below the
         * persistent chrome, so nothing that must stay clickable is covered.
         */
        const toasts =
          busy !== '' || waiting || error !== '' || notice !== ''
            ? h(
                'div',
                { className: 'dsg-toasts' },
                // What the panel is waiting for rides the same layer as the
                // messages: one anchor, so they stack instead of overlapping, and
                // it stays above the splitter rather than over the commit card.
                busy === ''
                  ? null
                  : h('div', { className: 'dsg-note dsg-toast dsg-toast-running' }, h(Spinner, { size: 13 }), busyLabel(busy)),
                waiting ? h('div', { className: 'dsg-note dsg-toast' }, t('sessionPending')) : null,
                !waiting && error !== ''
                  ? h('div', { className: 'dsg-note dsg-toast dsg-note-error' }, error)
                  : null,
                notice !== '' ? h('div', { className: 'dsg-note dsg-toast dsg-note-ok' }, notice) : null,
              )
            : null;

        /** The review of the staged change set, shown in place of the file list. */
        const reviewView = h(
          'div',
          { className: 'dsg-scroll' },
          h(
            'div',
            { className: 'dsg-review-head' },
            h('b', null, t('reviewTitle')),
            review?.findings?.length ? h('span', { className: 'dsg-count dsg-count-quiet' }, String(review.findings.length)) : null,
            h('span', { className: 'dsg-spacer' }),
            h(
              'button',
              { type: 'button', className: 'dsg-btn dsg-btn-quiet', onClick: () => setReview(null) },
              t('closeReview'),
            ),
          ),
          review?.unparsed === true
            ? h('div', { className: 'dsg-note dsg-note-warn' }, t('reviewUnparsed'))
            : null,
          review?.dropped > 0 ? h('div', { className: 'dsg-hint' }, t('reviewDropped').replace('{n}', String(review.dropped))) : null,
          (review?.findings ?? []).length === 0
            ? h('div', { className: 'dsg-empty' }, t('reviewClean'))
            : (review?.findings ?? []).map((finding, index) =>
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsg-finding',
                    key: `${finding.path}:${finding.line ?? 0}:${index}`,
                    ...tip(t('openThisFile')),
                    onClick: () => void openDiff('staged', finding.path),
                  },
                  h(
                    'span',
                    { className: `dsg-sev dsg-sev-${finding.severity}` },
                    t(`sev${finding.severity[0].toUpperCase()}${finding.severity.slice(1)}`),
                  ),
                  h(
                    'span',
                    { className: 'dsg-finding-main' },
                    h('span', { className: 'dsg-finding-what' }, finding.what),
                    finding.fix === '' ? null : h('span', { className: 'dsg-finding-fix' }, finding.fix),
                  ),
                  h(
                    'span',
                    { className: 'dsg-finding-where' },
                    `${finding.path}${finding.line === null ? '' : `:${finding.line}`}`,
                  ),
                ),
              ),
          review?.raw ? h('pre', { className: 'dsg-summary' }, review.raw) : null,
        );

        /** The proposed split, shown in place of the file list. */
        const splitView = h(
          'div',
          { className: 'dsg-scroll' },
          h(
            'div',
            { className: 'dsg-review-head' },
            h('b', null, t('splitTitle')),
            h('span', { className: 'dsg-spacer' }),
            h(
              'button',
              { type: 'button', className: 'dsg-btn dsg-btn-quiet', onClick: () => setSplit(null) },
              t('closeReview'),
            ),
          ),
          // Three different things used to read as one: an answer that could not
          // be parsed at all, an answer cut off by the output budget, and a
          // complete answer that simply left a file out. Only the last one is the
          // model's oversight.
          split?.unparsed === true
            ? h('div', { className: 'dsg-note dsg-note-warn' }, t('splitUnparsed'))
            : split?.truncated === true
              ? h(
                  'div',
                  { className: 'dsg-note dsg-note-warn' },
                  t('splitTruncated').replace('{n}', String((split.groups ?? []).length)),
                )
              : split?.complete === false
                ? h('div', { className: 'dsg-note dsg-note-warn' }, t('splitIncomplete'))
                : null,
          (split?.groups ?? []).length === 0
            ? h('div', { className: 'dsg-empty' }, t('splitNone'))
            : (split?.groups ?? []).map((group, index) =>
                h(
                  'div',
                  { className: 'dsg-group', key: `group-${index}` },
                  h(
                    'div',
                    { className: 'dsg-group-head' },
                    h('b', null, `#${index + 1}`),
                    h('span', { className: 'dsg-group-why' }, group.why),
                    h('span', { className: 'dsg-spacer' }),
                    // The plan is a draft: it can be merged upward or dropped,
                    // and every message stays editable before it is committed.
                    index === 0
                      ? null
                      : h(
                          'button',
                          {
                            type: 'button',
                            className: 'dsg-btn dsg-btn-quiet dsg-btn-tiny',
                            disabled,
                            ...tip(t('mergeUpHint')),
                            onClick: () => mergeGroupIntoPrevious(index),
                          },
                          t('mergeUp'),
                        ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsg-btn dsg-btn-quiet dsg-btn-tiny',
                        disabled,
                        ...tip(t('dropGroupHint')),
                        onClick: () =>
                          setSplit((current) =>
                            current === null ? current : { ...current, groups: current.groups.filter((_, at) => at !== index) },
                          ),
                      },
                      t('dropGroup'),
                    ),
                  ),
                  h('textarea', {
                    className: 'dsg-group-message',
                    value: group.message,
                    rows: Math.min(6, String(group.message).split('\n').length),
                    spellCheck: false,
                    disabled,
                    onChange: (event) => editGroup(index, { message: event.target.value }),
                  }),
                  h(
                    'div',
                    { className: 'dsg-group-paths' },
                    group.paths.map((path) => h('span', { className: 'dsg-group-path', key: path }, path)),
                  ),
                  h(
                    'div',
                    { className: 'dsg-actions' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsg-btn dsg-btn-primary',
                        disabled: disabled || group.message.trim() === '',
                        onClick: () => void commitGroup(group, index),
                      },
                      busy === 'commitGroup' ? h(Spinner, { size: 13 }) : null,
                      busy === 'commitGroup' ? t('committing') : t('commitThisGroup'),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsg-btn dsg-btn-quiet',
                        disabled,
                        onClick: () => void planSplit(),
                      },
                      t('replan'),
                    ),
                  ),
                ),
              ),
          (split?.groups ?? []).length > 1
            ? h(
                'div',
                { className: 'dsg-group dsg-group-all' },
                h('div', { className: 'dsg-hint' }, t('commitAllHint').replace('{n}', String(split.groups.length))),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsg-btn dsg-btn-primary',
                    disabled,
                    onClick: () => void commitAllGroups(),
                  },
                  busy === 'commitGroup' ? h(Spinner, { size: 13 }) : null,
                  t('commitAllGroups').replace('{n}', String(split.groups.length)),
                ),
              )
            : null,
          split?.raw ? h('pre', { className: 'dsg-summary' }, split.raw) : null,
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
                    tip,
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
                busy === 'generate' ? h(Spinner, { size: 13 }) : h(IconSpark, { size: 13 }),
                busy === 'generate' ? t('generating') : message.trim() === '' ? t('generate') : t('improve'),
                aiChip(false),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsg-btn dsg-btn-icon dsg-btn-quiet',
                  disabled: disabled || stagedCount === 0,
                  ...tip(t('reviewHint')),
                  onClick: () => void runReview(),
                },
                busy === 'review' ? h(Spinner, { size: 14 }) : h(IconReview, { size: 14 }),
                aiChip(true),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsg-btn dsg-btn-icon dsg-btn-quiet',
                  disabled: disabled || stagedCount === 0,
                  ...tip(t('splitHint')),
                  onClick: () => void planSplit(),
                },
                busy === 'split' ? h(Spinner, { size: 14 }) : h(IconSplit, { size: 14 }),
                aiChip(true),
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
                busy === 'commit' ? t('committing') : amend ? t('amendCommit') : t('commit'),
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
              h(
                'label',
                { className: 'dsg-check', title: t('amendHint') },
                h('input', {
                  type: 'checkbox',
                  checked: amend,
                  onChange: (event) => setAmend(event.target.checked),
                }),
                t('amend'),
              ),
              h('span', { className: 'dsg-spacer' }),
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
          ...tip(t('resizeHint')),
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
                              { className: 'dsg-htools' },
                          open
                            ? rewind !== null && rewind.hash === commit.hash
                              ? h(
                                  'div',
                                  { className: 'dsg-danger' },
                                  h('div', null, commit.hash === history?.head ? t('undoHint') : t('rewindHint')),
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
                                  Fragment,
                                  null,
                                  h(
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
                                    // Rewinding moves the branch; reverting adds an
                                    // inverse commit and leaves published history
                                    // alone, so both are offered side by side.
                                    h(
                                      'button',
                                      {
                                        type: 'button',
                                        className: 'dsg-btn',
                                        disabled,
                                        ...tip(t('revertHint')),
                                        onClick: () => void revertCommit(commit),
                                      },
                                      t('revertCommit'),
                                    ),
                                    h(
                                      'button',
                                      {
                                        type: 'button',
                                        className: 'dsg-btn',
                                        disabled,
                                        ...tip(t('pickHint')),
                                        onClick: () => void pickCommit(commit),
                                      },
                                      t('pickCommit'),
                                    ),
                                    h(
                                      'button',
                                      {
                                        type: 'button',
                                        className: 'dsg-btn',
                                        disabled,
                                        ...tip(t('rebaseHint')),
                                        onClick: () => setRebaseAt(commit.hash),
                                      },
                                      t('rebaseHere'),
                                    ),
                                  ),
                                  rebaseAt === commit.hash
                                    ? h(
                                        'div',
                                        { className: 'dsg-danger' },
                                        h('div', null, t('rebaseWarn')),
                                        h(
                                          'div',
                                          { className: 'dsg-actions' },
                                          h(
                                            'button',
                                            {
                                              type: 'button',
                                              className: 'dsg-btn dsg-btn-danger',
                                              disabled,
                                              onClick: () => void rebaseOnto(commit),
                                            },
                                            t('rebaseConfirm'),
                                          ),
                                          h(
                                            'button',
                                            {
                                              type: 'button',
                                              className: 'dsg-btn dsg-btn-quiet',
                                              onClick: () => setRebaseAt(null),
                                            },
                                            t('cancel'),
                                          ),
                                        ),
                                      )
                                    : null,
                                  h(
                                    'div',
                                    { className: 'dsg-actions' },
                                    h('input', {
                                      className: 'dsg-input dsg-tag-input',
                                      value: tagName,
                                      placeholder: t('tagPlaceholder'),
                                      onChange: (event) => setTagName(event.target.value),
                                    }),
                                    h(
                                      'button',
                                      {
                                        type: 'button',
                                        className: 'dsg-btn',
                                        disabled: disabled || tagName.trim() === '',
                                        onClick: () => void createTag(commit),
                                      },
                                      t('createTag'),
                                    ),
                                  ),
                                )
                            : null,
                            )
                          : null,
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
                                        : detail.files.map((file) => {
                                            const shown =
                                              commitFile !== null &&
                                              commitFile.hash === commit.hash &&
                                              commitFile.path === file.path;
                                            return h(
                                              Fragment,
                                              { key: file.path },
                                              h(
                                                'button',
                                                {
                                                  type: 'button',
                                                  className: `dsg-hfile${shown ? ' dsg-hfile-open' : ''}`,
                                                  'aria-expanded': shown,
                                                  ...tip(file.path),
                                                  onClick: () => void openCommitFile(commit, file.path),
                                                },
                                                h('span', { className: 'dsg-hfile-path' }, file.path),
                                                h(LineCounts, { lines: file }),
                                              ),
                                              shown
                                                ? h(
                                                    'div',
                                                    { className: 'dsg-hfile-diff' },
                                                    commitPatch === null
                                                      ? h('div', { className: 'dsg-hint' }, t('working'))
                                                      : h(DiffBody, { rows: commitPatch.rows, t }),
                                                  )
                                                : null,
                                            );
                                          }),
                                    ),
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
                              ...tip(ignorePlan.exists === true ? t('gitignoreInitBlocked') : t('gitignoreInitHint')),
                              onClick: () => void inferIgnore('init'),
                            },
                            busy === 'gitignore' ? t('gitignoreWorking') : t('gitignoreInit'),
                            aiChip(false),
                          ),
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'dsg-btn',
                              disabled: disabled || ignorePlan.exists !== true,
                              ...tip(ignorePlan.exists === true ? t('gitignoreOptimizeHint') : t('gitignoreOptimizeBlocked')),
                              onClick: () => void inferIgnore('optimize'),
                            },
                            busy === 'gitignore' ? t('gitignoreWorking') : t('gitignoreOptimize'),
                            aiChip(false),
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
          stashPanel,
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
                  : review !== null
                    ? reviewView
                    : split !== null
                      ? splitView
                      : changes
              : null,
            toasts,
          ),
          tooltip === null
            ? null
            : h(
                'div',
                { className: 'dsg-tip', style: { left: `${tooltip.x}px`, top: `${tooltip.y}px` } },
                tooltip.text,
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
