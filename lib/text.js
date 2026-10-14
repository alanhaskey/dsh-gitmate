/**
 * Text a person reads, in the language the plugin is set to.
 *
 * The boundary is deliberate: this covers the messages the Host hands back for
 * the panel, which is what someone actually looks at when something fails. Tool
 * descriptions and schemas stay English, because those are read by a model, and
 * git's own output is matched against a phrase table rather than reimplemented —
 * `git` on macOS usually ships no message catalogs, so its i18n cannot be
 * relied on.
 *
 * Messages are matched by their English shape, so a message written once at its
 * source does not have to be threaded through a translator at every call site.
 * A pattern that matches nothing leaves the text alone, which is no worse than
 * sending English.
 *
 * @module dsh-gitmate/text
 */

/** Message shapes this plugin authors, keyed for both languages. */
export const MESSAGES = {
  notARepo: {
    en: 'not a git repository',
    zh: '这里不是 git 仓库',
  },
  sessionNotLive: {
    en: 'session "{sessionId}" is not live; reopen the panel',
    zh: '会话「{sessionId}」尚未就绪；请重新打开面板',
  },
  unknownEndpoint: {
    en: 'unknown endpoint: {endpoint}',
    zh: '未知的接口：{endpoint}',
  },
  pathRangeNeedsBase: {
    en: 'scope "range" needs base (and optionally head)',
    zh: '范围对比需要 base（可选 head）',
  },
  discardNeedsPaths: {
    en: 'discard needs an explicit paths list; pass ["."] to discard every tracked modification',
    zh: '丢弃需要明确指定路径；传 ["."] 可以丢弃全部已跟踪文件的改动',
  },
  unknownAction: {
    en: 'unknown action "{action}"; expected {expected}',
    zh: '未知操作「{action}」；可用的是 {expected}',
  },
  noMessageGenerator: {
    en: 'no message was supplied and message generation is unavailable',
    zh: '没有提供提交说明，而且当前无法生成',
  },
  nothingStaged: {
    en: 'nothing is staged; stage paths first (git_stage) or pass all: true',
    zh: '暂存区是空的；先暂存文件，或用 all: true 提交全部改动',
  },
  configNeedsKey: {
    en: '{action} needs a key, for example user.name',
    zh: '{action} 需要一个键名，例如 user.name',
  },
  configSetNeedsValue: {
    en: 'set needs a value',
    zh: 'set 需要一个值',
  },
  noRemote: {
    en: 'this repository has no remote; add one with `git remote add origin <url>` before pushing or pulling',
    zh: '这个仓库还没有远程；先执行 `git remote add origin <url>` 再推送或拉取',
  },
  noRemoteForTags: {
    en: 'this repository has no remote to push tags to',
    zh: '这个仓库还没有远程，无法推送标签',
  },
  detachedSync: {
    en: 'HEAD is detached; name the branch to sync',
    zh: '当前处于游离 HEAD，请指明要同步的分支',
  },
  detachedPush: {
    en: 'HEAD is detached; name the branch to push',
    zh: '当前处于游离 HEAD，请指明要推送的分支',
  },
  diverged: {
    en: 'local {branch} and {upstream} have diverged; merge or rebase them yourself, then sync again',
    zh: '本地 {branch} 和 {upstream} 已经分叉；请自行合并或变基后再同步',
  },
  operationConflicts: {
    en: '{describe} stopped with {n} conflicted file(s); resolve them and stage them, then continue or abort',
    zh: '{describe} 因 {n} 个文件冲突而停下；解决并暂存后继续，或中止',
  },
  mergeConflicts: {
    en: 'merging {source} into {head} stopped with {n} conflicted file(s); resolve them and commit, or abort the merge',
    zh: '把 {source} 合并进 {head} 时因 {n} 个文件冲突而停下；解决并提交，或中止合并',
  },
  tagNeedsName: {
    en: '{action} needs a tag name',
    zh: '{action} 需要一个标签名',
  },
  badTagName: {
    en: '"{name}" is not a usable tag name',
    zh: '「{name}」不是可用的标签名',
  },
  noCommitMatches: {
    en: 'no commit matches {revision}',
    zh: '找不到匹配 {revision} 的提交',
  },
  cherryPickNeedsRevisions: {
    en: 'cherry-pick needs at least one revision',
    zh: '遴选至少需要一个提交',
  },
  rebaseNeedsOnto: {
    en: 'rebase needs the branch or revision to rebase onto',
    zh: '变基需要指明目标分支或提交',
  },
  noBranchOrCommit: {
    en: 'no branch or commit matches {onto}',
    zh: '找不到匹配 {onto} 的分支或提交',
  },
  stashListFailed: {
    en: 'git stash list failed',
    zh: '读取贮藏列表失败',
  },
  stashEmpty: {
    en: 'there is nothing in the stash',
    zh: '贮藏里没有内容',
  },
  mergeNeedsBranch: {
    en: 'merge needs the branch to merge in',
    zh: '合并需要指明要合入的分支',
  },
  mergeSelf: {
    en: '{source} is already the checked-out branch',
    zh: '{source} 就是当前分支',
  },
  noLocalBranch: {
    en: 'there is no local branch named {source}',
    zh: '没有名为 {source} 的本地分支',
  },
  branchNeedsName: {
    en: '{action} needs a branch name',
    zh: '{action} 需要一个分支名',
  },
  nothingToDescribe: {
    en: 'there is nothing to describe: the working tree is clean',
    zh: '没有可描述的改动：工作区是干净的',
  },
  pathRequired: {
    en: 'a path is required',
    zh: '需要提供一个路径',
  },
  cannotPreview: {
    en: 'cannot preview {target}',
    zh: '无法预览 {target}',
  },
  noCommitToUndo: {
    en: 'the repository has no commit to undo',
    zh: '这个仓库还没有可撤销的提交',
  },
  firstCommitSoftOnly: {
    en: '"{hash}" is the first commit, so only mode "soft" can undo it',
    zh: '「{hash}」是第一个提交，只能用 soft 模式撤销',
  },
  noDirectoryToInspect: {
    en: 'no directory to inspect',
    zh: '没有可检查的目录',
  },
  cannotRead: {
    en: 'cannot read {root}',
    zh: '无法读取 {root}',
  },
  noDirectoryToWrite: {
    en: 'no directory to write into',
    zh: '没有可写入的目录',
  },
  noEntriesSelected: {
    en: 'no entries were selected',
    zh: '没有选中任何条目',
  },
  cannotWrite: {
    en: 'cannot write {path}: {error}',
    zh: '无法写入 {path}：{error}',
  },
  commandCancelled: {
    en: 'git command was cancelled',
    zh: 'git 命令已取消',
  },
  commandTimedOut: {
    en: 'git command timed out after {ms}ms',
    zh: 'git 命令在 {ms}ms 后超时',
  },
  commandDenied: {
    en: 'git command was blocked by the file sandbox: {detail}',
    zh: 'git 命令被文件沙箱拦下：{detail}',
  },
  commandDeniedByMode: {
    // Most entries translate one sentence into another, so their English text is
    // also the shape to match. This one answers with advice the incoming message
    // does not contain, so it states the shape separately.
    match: 'git command was blocked by the file sandbox (session mode "{mode}"): {detail}',
    en: 'Blocked by this session\'s permission mode ({mode}) — this step writes inside .git, which that mode does not allow. Switch the session to workspace-write or danger-full-access. If it is already on danger-full-access, the sandbox backend on this machine is refusing writes and the Harness needs restarting. Cause: {detail}',
    zh: '被这个会话的权限模式拦下（当前：{mode}）——这一步要写 `.git`，该模式不允许。把会话切到 workspace-write 或 danger-full-access 即可。如果已经是 danger-full-access，说明这台机器上的沙箱后端在拒绝写入，需要重启 DSH。原因：{detail}',
  },
  gitFailed: {
    en: '{what} failed',
    zh: '{what} 失败',
  },
  exitCode: {
    en: '{fallback} (git exited with {code})',
    zh: '{fallback}（git 退出码 {code}）',
  },
  sandboxDenied: {
    en: 'access denied',
    zh: '访问被拒绝',
  },
  gitUnavailable: {
    en: 'git could not be run here, so this folder cannot be read as a repository. Check that git is installed and on PATH — a container or a fresh system often has not got it. {detail}',
    zh: '这里无法运行 git，所以读不出这个文件夹的仓库信息。确认 git 已安装并在 PATH 中——容器或刚装好的系统上常常没有。{detail}',
  },
  sandboxUnavailable: {
    en: 'The Harness cannot start a sandbox on this machine, so it refuses to run git outside one. This is an environment problem, not a repository problem — nothing about your project is wrong. {hint} Reported cause: {detail}',
    zh: '这台机器上 DSH 启动不了沙箱，因此它拒绝在沙箱之外运行 git。这是环境问题，不是仓库问题——你的项目本身没有任何不对。{hint}原始原因：{detail}',
  },
};

/**
 * Sentences git itself writes, matched against the WHOLE message.
 *
 * macOS ships `git` without message catalogs, so `LC_ALL=zh_CN.UTF-8` changes
 * nothing; the sentences a user meets most often are carried here instead. The
 * match must span everything, because replacing part of a sentence leaves text
 * that reads as neither language — a miss simply stays as git wrote it, which is
 * still accurate.
 */
const GIT_PHRASES = [
  [
    /^(?:error:\s*)?Your local changes to the following files would be overwritten by merge:\s*([\s\S]+?)\s*Please commit your changes or stash them before you merge\.\s*Aborting\.?$/i,
    '本地改动会被这次合并覆盖，请先提交或贮藏：$1',
  ],
  [
    /^(?:error:\s*)?Your local changes to the following files would be overwritten by checkout:\s*([\s\S]+?)\s*Please commit your changes or stash them before you switch branches\.\s*Aborting\.?$/i,
    '本地改动会被这次切换覆盖，请先提交或贮藏：$1',
  ],
  [
    /^error: Your local changes to the following files would be overwritten by merge:\s*([\s\S]+)$/i,
    '本地改动会被这次合并覆盖，请先提交或贮藏：$1',
  ],
  [/^fatal: not a git repository \(or any of the parent directories\): \.git\.?$/i, '当前目录及其父目录都不是 git 仓库'],
  [/^! \[rejected\]\s+(\S+) -> (\S+) \(fetch first\)$/i, '推送被拒绝：$1 → $2（远程有本地没有的提交）'],
  [/^! \[rejected\]\s+(\S+) -> (\S+) \(non-fast-forward\)$/i, '推送被拒绝：$1 → $2（不是快进）'],
  [/^! \[remote rejected\]\s+(\S+) -> (\S+) \((.+)\)$/i, '远程拒绝了推送：$1 → $2（$3）'],
  [/^(?:error:\s*)?failed to push some refs to '?(.+?)'?\.?$/i, '推送失败：$1'],
  [/^CONFLICT \(content\): Merge conflict in (.+)$/i, '内容冲突：$1 需要手动解决'],
  [/^CONFLICT \(content\): Conflict in (.+)$/i, '内容冲突：$1 需要手动解决'],
  [/^CONFLICT \((.+)\): (.+)$/i, '冲突（$1）：$2'],
  [/^Automatic merge failed; fix conflicts and then commit the result\.?$/i, '自动合并失败；解决冲突后再提交'],
  [/^nothing to commit, working tree clean$/i, '没有要提交的内容，工作区是干净的'],
  [/^nothing to commit.*$/i, '没有要提交的内容'],
  [/^fatal: A branch named '(.+)' already exists\.?$/i, '已经存在名为「$1」的分支'],
  [/^fatal: invalid reference: (.+)$/i, '无效的引用：$1'],
  [/^fatal: Not possible to fast-forward, aborting\.?$/i, '无法快进，已放弃'],
  [/^fatal: You have not concluded your merge \(MERGE_HEAD exists\)\..*$/i, '上一次合并还没有结束（MERGE_HEAD 仍在），请先完成或中止它'],
  [/^error: could not apply (.+)$/i, '无法应用 $1'],
  [/^Please tell me who you are\..*$/i, '请先配置提交身份（user.name / user.email）'],
  [/^error: pathspec '?(.+?)'? did not match any file\(s\) known to git\.?$/i, '路径「$1」没有匹配到 git 已知的文件'],
  [/^error: The following untracked working tree files would be overwritten by merge:\s*([\s\S]+?)\s*Please move or remove them before you merge\.\s*Aborting\.?$/i, '这些未跟踪文件会被合并覆盖，请先移走或删除：$1'],
  [/^No local changes to save$/i, '没有可贮藏的改动'],
  [/^fatal: There is no merge to abort.*$/i, '当前没有可中止的合并'],
  [/^error: you need to resolve your current index first$/i, '需要先解决当前的索引冲突'],
  [/^Already up to date\.?$/i, '已经是最新的'],
  [/^error: cannot switch branch while (\w+)/i, '正在 $1 中，无法切换分支'],
  [/^error: Your local changes would be overwritten by merge\.\s*Please commit your changes or stash them\.\s*Aborting\.?$/i, '本地改动会被合并覆盖，请先提交或贮藏'],
];

const ESCAPE = /[.*+?^${}()|[\]\\]/g;

/** Turn `no commit matches {revision}` into a matcher with one capture group. */
function patternFor(template) {
  const names = [];
  const body = template
    .replace(ESCAPE, '\\$&')
    .replace(/\\\{(\w+)\\\}/g, (_, name) => {
      names.push(name);
      return '(.+?)';
    });
  return { matcher: new RegExp(`^${body}$`), names };
}

/** Patterns are derived once per language, from each entry's own shape. */
const PATTERNS = Object.entries(MESSAGES).map(([key, entry]) => ({ key, ...patternFor(entry.match ?? entry.en) }));

/**
 * What to try when the sandbox itself will not start.
 *
 * The causes are platform-specific, and naming the wrong one sends the reader to
 * the wrong place: a Windows `%TEMP%` problem says nothing to a Linux user whose
 * kernel lacks Landlock.
 */
const SANDBOX_HINT = {
  linux: {
    en: 'On Linux that usually means bubblewrap is missing or the kernel does not enforce Landlock: install bubblewrap, or switch this session to danger-full-access. ',
    zh: 'Linux 上通常是缺少 bubblewrap，或内核不支持 Landlock：装上 bubblewrap，或者把这个会话切到 danger-full-access。',
  },
  darwin: {
    en: 'On macOS that usually means `sandbox-exec` is unavailable: switch this session to danger-full-access. ',
    zh: 'macOS 上通常是 sandbox-exec 不可用：把这个会话切到 danger-full-access。',
  },
  win32: {
    en: 'On Windows the usual cause is a %TEMP% folder that cannot be written to — the runner cannot create its own temporary directory there: fix that, or switch this session to danger-full-access. ',
    zh: 'Windows 上最常见的原因是 %TEMP% 目录不可写（沙箱连自己的临时目录都建不出来）：修好它，或者把这个会话切到 danger-full-access。',
  },
};

/** A platform-neutral fallback for anything not named above. */
const SANDBOX_HINT_OTHER = {
  en: 'Fix the sandbox on this host, or switch this session to danger-full-access. ',
  zh: '先修好这台机器上的沙箱，或者把这个会话切到 danger-full-access。',
};

/**
 * Pick the language for messages a person reads.
 *
 * `auto` means "match the repository's commits" for generated text, but a git
 * error has no such signal — and this plugin's surface is Chinese-first — so
 * anything that is not an explicit `en` reads in Chinese.
 * @param setting - the `messageLanguage` value.
 */
export function hostLanguage(setting) {
  return setting === 'en' ? 'en' : 'zh';
}

/**
 * Build the translator for one language.
 * @param setting - the `messageLanguage` value.
 */
export function createHostText(setting, options = {}) {
  const language = hostLanguage(setting);
  // Injectable so every platform's advice can be exercised from one machine.
  const platform = options.platform ?? process.platform;
  const sandboxHint = (SANDBOX_HINT[platform] ?? SANDBOX_HINT_OTHER)[language];
  const fill = (template, params) =>
    template.replace(/\{(\w+)\}/g, (whole, name) =>
      params !== undefined && params[name] !== undefined ? String(params[name]) : whole,
    );

  return {
    language,
    /** One named message. */
    t(key, params) {
      const entry = MESSAGES[key];
      if (entry === undefined) return key;
      return fill(entry[language] ?? entry.en, params);
    },
    /**
     * Localise a message that was already built.
     *
     * Tries this plugin's own shapes first, then the phrases git writes. Anything
     * unrecognised is returned untouched.
     * @param raw - the message as authored or as git wrote it.
     */
    message(raw) {
      const text = String(raw ?? '').trim();
      if (text === '') return text;
      // 1. the whole message is one of ours — rendered in the target language
      //    either way, because these are this plugin's own sentences and the
      //    English rendering can carry advice the incoming text does not.
      const whole = this.authored(text);
      if (whole !== null) return whole;
      // Anything else is the Host's own wording. There is nothing to translate
      // for an English reader, and rewriting it would only lose detail.
      if (language === 'en') return text;
      // 2. one of ours, then git's own words after a colon
      const at = text.indexOf(': ');
      if (at > 0) {
        const head = this.authored(text.slice(0, at));
        if (head !== null) return `${head}：${this.gitPhrase(text.slice(at + 2))}`;
      }
      // 3. the sandbox refusing to run anything at all — worth naming, because
      //    the raw text reads like a repository fault and is not one
      const refusal = /no sandbox backend is usable on this host|refusing to run the command unconfined/i.exec(text);
      if (refusal !== null) {
        const runner = /Runner failure: ([\s\S]+)$/i.exec(text);
        return this.t('sandboxUnavailable', { hint: sandboxHint, detail: (runner?.[1] ?? text).trim() });
      }
      // 4. git itself never ran
      if (/could not run git/i.test(text)) return this.t('gitUnavailable', { detail: text.replace(/^could not run git here:\s*/i, '') });
      // 5. git's words alone
      return this.gitPhrase(text);
    },
    /** Match one of this plugin's own message shapes, or null. */
    authored(raw) {
      for (const { key, matcher, names } of PATTERNS) {
        const match = matcher.exec(raw);
        if (match === null) continue;
        const params = {};
        names.forEach((name, index) => {
          params[name] = match[index + 1];
        });
        return this.t(key, params);
      }
      return null;
    },
    /** Translate the sentences git itself writes, in place. */
    gitPhrase(raw) {
      let out = String(raw ?? '');
      if (language === 'en' || out === '') return out;
      for (const [pattern, replacement] of GIT_PHRASES) out = out.replace(pattern, replacement);
      return out;
    },
  };
}
