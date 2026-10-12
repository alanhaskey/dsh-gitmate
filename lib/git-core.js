/**
 * Git operations over an injected command runner.
 *
 * Nothing here depends on DeepSeek Harness: `createGitCore` receives an `exec`
 * function and returns plain async operations over plain JSON values. `index.js`
 * supplies an `exec` backed by the Harness `shell` service; `test/smoke.mjs`
 * supplies one backed by `node:child_process`. That split is what makes the git
 * behaviour testable without a live Harness.
 *
 * @module dsh-gitmate/git-core
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Prefix that keeps git non-interactive: no credential prompt, no editor, no pager. */
/**
 * The shell this runs under is not always a POSIX one.
 *
 * The Harness ships a PowerShell executor for Windows, where `VAR=value git …`
 * is not a command at all — it fails as an unknown term, so every git call in the
 * plugin failed there. These are handed to the shell as real environment entries
 * instead, which every executor honours.
 */
const GIT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  GIT_EDITOR: 'true',
};

/** Windows gets PowerShell by default, and its quoting rules are its own. */
const IS_WINDOWS = process.platform === 'win32';

/** Config passed on every invocation rather than through the user's config files. */
const BASE_CONFIG = ['-c', 'core.quotepath=false', '-c', 'color.ui=false'];

/** Longest prefix of a patch we are willing to hold in memory. */
const HARD_OUTPUT_CAP = 8 * 1024 * 1024;

const STATUS_LABELS = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'type-changed',
  U: 'unmerged',
};

/**
 * Quote one shell word for `bash -c`. Every argument that reaches git goes
 * through this, so a path containing spaces, quotes, or `$(...)` stays data.
 * @param value - the raw argument.
 * @returns the single-quoted shell word.
 */
export function quoteFor(value, windows) {
  const text = String(value);
  // PowerShell escapes a single quote by doubling it; a POSIX shell closes the
  // quote, escapes one and reopens it.
  return windows ? `'${text.replace(/'/g, "''")}'` : `'${text.replace(/'/g, `'\\''`)}'`;
}

/** Quote one argument for the shell this Host runs commands under. */
export function shellQuote(value) {
  return quoteFor(value, IS_WINDOWS);
}

/** Collapse a command's stderr into one line suitable for a tool result. */
function firstLine(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed === '') return '';
  return trimmed.split('\n')[0].trim();
}

/** True when `child` is inside `parent` (or is `parent`). */
function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * `.gitignore` building blocks, grouped so a caller can offer them as choices.
 * Each group is a list of literal lines; nothing here is generated from the
 * repository beyond deciding which groups apply.
 */
export const GITIGNORE_GROUPS = [
  {
    id: 'node',
    label: 'Node',
    markers: ['package.json'],
    entries: [
      'node_modules/',
      'npm-debug.log*',
      'yarn-error.log*',
      'pnpm-debug.log*',
      '.pnpm-store/',
      '.npm/',
      'dist/',
      'build/',
      'coverage/',
      '.next/',
      '.nuxt/',
      '.output/',
      '.turbo/',
      '.cache/',
    ],
  },
  {
    id: 'python',
    label: 'Python',
    markers: ['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile', 'poetry.lock'],
    entries: [
      '__pycache__/',
      '*.py[cod]',
      '*.egg-info/',
      '.venv/',
      'venv/',
      '.pytest_cache/',
      '.mypy_cache/',
      '.ruff_cache/',
      'build/',
      'dist/',
    ],
  },
  {
    id: 'go',
    label: 'Go',
    markers: ['go.mod', 'go.sum'],
    entries: ['/bin/', '/vendor/', '*.test', '*.out'],
  },
  {
    id: 'rust',
    label: 'Rust',
    markers: ['Cargo.toml'],
    entries: ['/target/'],
  },
  {
    id: 'java',
    label: 'Java / Kotlin',
    markers: ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle'],
    entries: ['target/', 'build/', '*.class', '.gradle/'],
  },
  {
    id: 'dotnet',
    label: '.NET',
    markers: ['*.csproj', '*.sln', '*.fsproj'],
    entries: ['bin/', 'obj/', '*.user', '*.suo'],
  },
  {
    id: 'ruby',
    label: 'Ruby',
    markers: ['Gemfile', 'Rakefile', '*.gemspec'],
    entries: ['.bundle/', 'vendor/bundle/', '*.gem', 'log/', 'tmp/'],
  },
  {
    id: 'php',
    label: 'PHP',
    markers: ['composer.json', 'artisan'],
    entries: ['/vendor/', 'storage/*.key'],
  },
  {
    id: 'secrets',
    label: 'Secrets and local environment',
    markers: ['.env'],
    entries: ['.env', '.env.local', '.env.*.local', '*.pem', '*.key'],
  },
  {
    id: 'logs',
    label: 'Logs and caches',
    markers: [],
    entries: ['*.log', 'logs/', '.eslintcache', '.stylelintcache'],
  },
  {
    id: 'editors',
    label: 'Editors',
    markers: ['.vscode', '.idea'],
    entries: [
      '.vscode/*',
      '!.vscode/settings.json',
      '!.vscode/extensions.json',
      '.idea/',
      '*.iml',
      'out/',
      '.fleet/',
    ],
  },
  {
    id: 'os',
    label: 'Operating system',
    markers: [],
    entries: ['.DS_Store', '._*', '.Spotlight-V100', '.Trashes', 'Thumbs.db', 'Desktop.ini', '$RECYCLE.BIN/', '*~'],
  },
];

/** The groups a repository with no detectable language still usefully gets. */
const GITIGNORE_FALLBACK_GROUPS = ['secrets', 'logs', 'editors', 'os'];

/** Collapse a group list into the unique lines it contributes, order preserved. */
function flattenGroups(groups) {
  const seen = new Set();
  const lines = [];
  for (const group of groups) {
    for (const entry of group.entries) {
      if (seen.has(entry)) continue;
      seen.add(entry);
      lines.push(entry);
    }
  }
  return lines;
}

/**
 * Lay a commit list out in lanes, newest first.
 *
 * Each row gets the lane its commit sits in, the lanes whose line passes
 * through it, and the lanes its parents continue into. A lane is claimed by the
 * first commit that needs it and freed when nothing waits on it — the usual
 * swimlane arrangement, enough for the shapes a reader meets in practice. The
 * ordering comes from `--topo-order`, so parents always follow their children.
 *
 * @param commits - `{ hash, parents }` records, newest first.
 * @returns `{ rows, laneCount }`, one row per commit in the same order.
 */
export function buildGraph(commits) {
  /** Lane index → the commit hash that lane is waiting for. */
  const lanes = [];
  const rows = [];
  let laneCount = 1;

  const occupied = () => {
    const taken = [];
    for (let index = 0; index < lanes.length; index += 1) {
      if (lanes[index] !== undefined) taken.push(index);
    }
    return taken;
  };

  const claim = (hash) => {
    const held = lanes.indexOf(hash);
    if (held !== -1) return held;
    const free = lanes.indexOf(undefined);
    const lane = free === -1 ? lanes.length : free;
    lanes[lane] = hash;
    return lane;
  };

  for (const commit of commits) {
    const before = occupied();
    const lane = claim(commit.hash);
    const parents = Array.isArray(commit.parents) ? commit.parents : [];

    // This lane now waits for the first parent, or is free at a root commit.
    if (parents.length === 0) lanes[lane] = undefined;
    else lanes[lane] = parents[0];

    const parentLanes = [lane];
    for (const parent of parents.slice(1)) {
      const target = claim(parent);
      if (!parentLanes.includes(target)) parentLanes.push(target);
    }

    while (lanes.length > 0 && lanes[lanes.length - 1] === undefined) lanes.pop();
    const after = occupied();

    laneCount = Math.max(laneCount, lane + 1, ...before, ...after, ...parentLanes);
    rows.push({ lane, before, after, parentLanes });
  }
  return { rows, laneCount };
}

/** Hunk header: `@@ -old,cnt +new,cnt @@` optionally followed by a section. */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/** Patch lines that describe the file rather than its content. */
const PATCH_FILE_META = /^(diff --git |index |--- |\+\+\+ |old mode |new mode |similarity index |dissimilarity index )/;

/**
 * Find the part of a replaced line that actually changed.
 *
 * A common-prefix/suffix trim, not a word diff: it underlines the same span an
 * editor does for the ordinary "one token changed" case, and refuses to mark
 * anything when the two lines share too little to call one an edit of the other.
 *
 * @param before - the removed line's text.
 * @param after - the added line's text.
 * @returns `{ before, after }` triples of `[head, changed, tail]`, or undefined.
 */
function inlineChange(before, after) {
  const limit = Math.min(before.length, after.length);
  let head = 0;
  while (head < limit && before[head] === after[head]) head += 1;
  let tail = 0;
  while (tail < limit - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail += 1;
  const shared = head + tail;
  if (shared === 0 || shared < limit * 0.3) return undefined;
  return {
    before: [before.slice(0, head), before.slice(head, before.length - tail), before.slice(before.length - tail)],
    after: [after.slice(0, head), after.slice(head, after.length - tail), after.slice(after.length - tail)],
  };
}

/** Attach inline spans to every replaced line that has a counterpart. */
function pairChangedLines(rows) {
  let index = 0;
  while (index < rows.length) {
    if (rows[index].kind !== 'del') {
      index += 1;
      continue;
    }
    let removed = index;
    while (removed < rows.length && rows[removed].kind === 'del') removed += 1;
    let added = removed;
    while (added < rows.length && rows[added].kind === 'add') added += 1;
    const removedRows = rows.slice(index, removed);
    const addedRows = rows.slice(removed, added);
    const pairs = Math.min(removedRows.length, addedRows.length);
    for (let step = 0; step < pairs; step += 1) {
      const change = inlineChange(removedRows[step].text, addedRows[step].text);
      if (change === undefined) continue;
      removedRows[step].inline = change.before;
      addedRows[step].inline = change.after;
    }
    index = added;
  }
  return rows;
}

/**
 * Turn a unified patch into rows a reader can follow.
 *
 * Git's format is built for tools: it repeats file headers and gives every line
 * a one-character prefix. Each row here keeps both line numbers, the sign, and
 * the text as separate fields, so a view can put them in gutters the way an
 * editor's diff view does. This lives on the Host rather than in the panel so it
 * is covered by the same offline tests as the rest of the git behaviour.
 *
 * @param patch - the unified diff text.
 * @returns `{ rows, flags }`, where a flag is a file-level fact worth showing.
 */
export function diffRows(patch) {
  const rows = [];
  const flags = [];
  let oldNo = 0;
  let newNo = 0;
  for (const line of String(patch ?? '').split('\n')) {
    if (line === '') continue;
    if (line.startsWith('new file mode')) {
      if (!flags.includes('new')) flags.push('new');
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      if (!flags.includes('deleted')) flags.push('deleted');
      continue;
    }
    if (line.startsWith('rename from ') || line.startsWith('rename to ')) {
      if (!flags.includes('renamed')) flags.push('renamed');
      continue;
    }
    if (PATCH_FILE_META.test(line)) continue;
    if (line.startsWith('\\')) continue;
    const hunk = HUNK_HEADER.exec(line);
    if (hunk !== null) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[3]);
      // Without a section, the header itself is the only location hint.
      rows.push({ kind: 'hunk', text: (hunk[5] ?? '').trim() || line });
      continue;
    }
    const sign = line[0];
    const text = line.slice(1);
    if (sign === '+') rows.push({ kind: 'add', newNo: newNo++, text });
    else if (sign === '-') rows.push({ kind: 'del', oldNo: oldNo++, text });
    else if (sign === ' ') rows.push({ kind: 'context', oldNo: oldNo++, newNo: newNo++, text });
    else rows.push({ kind: 'meta', text: line });
  }
  return { rows: pairChangedLines(rows), flags };
}

/**
 * Build the git command layer.
 * @param options - `exec` runs one command; `config` carries plugin tunables.
 * @returns the git operations this plugin exposes.
 */
export function createGitCore({ exec, config = {} }) {
  const settings = {
    defaultBranch: 'main',
    commandTimeoutMs: 60000,
    maxDiffBytes: 80000,
    maxPromptBytes: 24000,
    ...config,
  };

  /** Run one git invocation with the non-interactive environment and base config. */
  async function run(args, opts = {}) {
    // `--no-pager` is a flag rather than an environment variable, so the pager
    // stays out of the way on every platform.
    const command = `git --no-pager ${[...BASE_CONFIG, ...args].map(shellQuote).join(' ')}`;
    const outcome = await exec({
      command,
      env: GIT_ENV,
      cwd: opts.cwd,
      stdin: opts.stdin,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs ?? settings.commandTimeoutMs,
      stdoutMaxBytes: opts.stdoutMaxBytes ?? HARD_OUTPUT_CAP,
    });
    return {
      ok: outcome.code === 0,
      code: outcome.code,
      // A Windows shell returns CRLF; the parsers below split on newlines and
      // would otherwise carry a stray carriage return into every path and patch
      // line.
      stdout: String(outcome.stdout ?? '').replace(/\r\n/g, '\n'),
      stderr: String(outcome.stderr ?? '').replace(/\r\n/g, '\n'),
      timedOut: Boolean(outcome.timedOut),
      aborted: Boolean(outcome.aborted),
      denied: Boolean(outcome.denied),
      command,
    };
  }

  /**
   * Turn a failed invocation into one actionable sentence.
   * @param result - the failed invocation.
   * @param fallback - used when the command produced no diagnostic.
   */
  /**
   * The line that explains a failure, rather than the one that names a place.
   *
   * git leads a push with `To <url>` and only then says what went wrong, so
   * taking the first line reported the destination and hid the reason: a
   * rejected push read as "To https://github.com/…" and nothing else.
   */
  function failureLine(text) {
    const lines = String(text ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !/^hint:/i.test(line));
    const at = lines.findIndex((line) => /^(error|fatal|remote:|!|CONFLICT)/i.test(line) || /\brejected\b/i.test(line));
    const reason = at === -1 ? (lines[0] ?? '') : lines[at];
    if (reason === '') return '';
    // git often ends the reason with a colon and lists the paths underneath. Take
    // those with it, or the message reads as a sentence that stops mid-thought.
    if (!reason.endsWith(':')) return reason;
    const detail = lines
      .slice(at === -1 ? 1 : at + 1)
      .filter((line) => !/^(error|fatal|remote:|!|CONFLICT)/i.test(line))
      .slice(0, 4);
    return [reason, ...detail].join(' ');
  }

  function describeFailure(result, fallback) {
    if (result.aborted) return 'git command was cancelled';
    if (result.timedOut) return `git command timed out after ${settings.commandTimeoutMs}ms`;
    if (result.denied) {
      return `git command was blocked by the file sandbox: ${failureLine(result.stderr) || 'access denied'}`;
    }
    // stderr carries the reason; stdout is a progress log. Joining both produced
    // sentences like "…would be overwritten by merge: On branch main".
    const detail = (failureLine(result.stderr) || failureLine(result.stdout)).trim();
    return detail || `${fallback} (git exited with ${result.code})`;
  }

  /** Recognize the identity failure so the caller gets a way out, not just an error. */
  function identityHint(text) {
    const value = String(text ?? '');
    if (/Please tell me who you are|unable to auto-detect email address|empty ident name/i.test(value)) {
      return 'Set the commit identity first: git_config with action "set", key "user.name" or "user.email".';
    }
    return '';
  }

  /** Locate the repository containing `cwd`. */
  async function probe({ cwd, signal } = {}) {
    const result = await run(['rev-parse', '--path-format=absolute', '--show-toplevel', '--absolute-git-dir'], {
      cwd,
      signal,
      timeoutMs: Math.min(settings.commandTimeoutMs, 20000),
    });
    if (!result.ok) {
      return { ok: true, isRepo: false, cwd, reason: describeFailure(result, 'not a git repository') };
    }
    const lines = result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    const root = lines[0];
    const gitDir = lines[1];
    if (!root) return { ok: true, isRepo: false, cwd, reason: 'git could not report a work tree root' };
    return { ok: true, isRepo: true, root, gitDir, cwd: root };
  }

  /** True when HEAD already resolves to a commit. */
  async function hasHead(root, signal) {
    const result = await run(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: root, signal });
    return result.ok;
  }

  /** Rewrite absolute paths under the repository root into repo-relative ones. */
  function normalizePaths(root, paths) {
    if (!Array.isArray(paths)) return [];
    return paths
      .map((entry) => String(entry).trim())
      .filter(Boolean)
      .map((entry) => {
        if (!isAbsolute(entry)) return entry;
        const abs = resolve(entry);
        return isInside(root, abs) ? relative(root, abs) || '.' : entry;
      });
  }

  /** Reject path arguments that would reach outside the repository. */
  function assertContained(root, paths) {
    for (const entry of paths) {
      if (isAbsolute(entry)) {
        if (!isInside(root, resolve(entry))) return `path escapes the repository: ${entry}`;
        continue;
      }
      if (!isInside(root, resolve(root, entry))) return `path escapes the repository: ${entry}`;
    }
    return '';
  }

  /** Parse `git status --porcelain=v2 -z` into the fields callers actually use. */
  function parsePorcelainV2(text) {
    const records = String(text).split('\0');
    const state = {
      oid: '',
      branch: '',
      detached: false,
      upstream: '',
      ahead: 0,
      behind: 0,
      staged: [],
      unstaged: [],
      untracked: [],
      conflicted: [],
    };
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (record === '') continue;
      if (record.startsWith('# ')) {
        const body = record.slice(2);
        if (body.startsWith('branch.oid ')) state.oid = body.slice('branch.oid '.length);
        else if (body.startsWith('branch.head ')) state.branch = body.slice('branch.head '.length);
        else if (body.startsWith('branch.upstream ')) state.upstream = body.slice('branch.upstream '.length);
        else if (body.startsWith('branch.ab ')) {
          const match = /\+(-?\d+)\s+-(-?\d+)/.exec(body);
          if (match) {
            state.ahead = Number(match[1]);
            state.behind = Number(match[2]);
          }
        }
        continue;
      }
      const kind = record[0];
      if (kind === '1') {
        const parts = record.split(' ');
        const xy = parts[1] ?? '..';
        const path = parts.slice(8).join(' ');
        pushEntry(state, xy, path, null);
      } else if (kind === '2') {
        const parts = record.split(' ');
        const xy = parts[1] ?? '..';
        const path = parts.slice(9).join(' ');
        index += 1;
        pushEntry(state, xy, path, records[index] ?? null);
      } else if (kind === 'u') {
        const parts = record.split(' ');
        const path = parts.slice(10).join(' ');
        state.conflicted.push({ path, status: 'unmerged' });
      } else if (kind === '?') {
        state.untracked.push(record.slice(2));
      }
    }
    state.detached = state.branch === '(detached)';
    if (state.detached) state.branch = '';
    return state;
  }

  /** Split one porcelain-v2 XY pair into its index and work-tree halves. */
  function pushEntry(state, xy, path, origPath) {
    const [indexStatus, worktreeStatus] = [xy[0] ?? '.', xy[1] ?? '.'];
    if (indexStatus !== '.') {
      state.staged.push({
        path,
        status: STATUS_LABELS[indexStatus] ?? indexStatus,
        ...(origPath ? { from: origPath } : {}),
      });
    }
    if (worktreeStatus !== '.') {
      state.unstaged.push({
        path,
        status: STATUS_LABELS[worktreeStatus] ?? worktreeStatus,
        ...(origPath ? { from: origPath } : {}),
      });
    }
  }

  /**
   * Read the full working-tree state.
   *
   * @param args - `cwd` selects the repository; `withCounts` also reports how
   * many lines each change adds and removes, which costs two extra git calls
   * and is therefore off by default.
   */
  async function status({ cwd, signal, withCounts = false } = {}) {
    const found = await probe({ cwd, signal });
    if (!found.isRepo) {
      return {
        ok: true,
        isRepo: false,
        cwd: found.cwd,
        reason: found.reason,
        hint: 'Run git_init to create a repository here.',
      };
    }
    const result = await run(['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'], {
      cwd: found.root,
      signal,
    });
    if (!result.ok) {
      return { ok: false, isRepo: true, root: found.root, error: describeFailure(result, 'git status failed') };
    }
    const state = parsePorcelainV2(result.stdout);
    let untrackedLines;
    if (withCounts) {
      // `--no-renames` keeps one path per row so the counts map straight onto
      // the entries; a rename is summed from its two halves below.
      const [worktree, index] = await Promise.all([
        run(['diff', '--numstat', '--no-renames'], { cwd: found.root, signal }),
        run(['diff', '--cached', '--numstat', '--no-renames'], { cwd: found.root, signal }),
      ]);
      const attach = (entries, raw) => {
        if (!raw.ok) return;
        const counts = parseNumstat(raw.stdout);
        for (const entry of entries) {
          const after = counts.get(entry.path);
          const before = entry.from === undefined ? undefined : counts.get(entry.from);
          if (after !== undefined && before !== undefined) {
            entry.lines = {
              additions: (after.additions ?? 0) + (before.additions ?? 0),
              deletions: (after.deletions ?? 0) + (before.deletions ?? 0),
            };
          } else if (after !== undefined) entry.lines = after;
          else if (before !== undefined) entry.lines = before;
        }
      };
      attach(state.staged, index);
      attach(state.unstaged, worktree);
      untrackedLines = {};
      for (const path of state.untracked) {
        const count = countLines(found.root, path);
        if (count !== null) untrackedLines[path] = count;
      }
    }
    return {
      ok: true,
      isRepo: true,
      root: found.root,
      // Which operation left the tree mid-way, so a surface can offer the right
      // way out instead of guessing from the conflict list.
      operation: operationInProgress(found.gitDir),
      branch: state.branch,
      detached: state.detached,
      head: state.oid && state.oid !== '(initial)' ? state.oid.slice(0, 7) : '',
      initial: state.oid === '(initial)',
      upstream: state.upstream,
      ahead: state.ahead,
      behind: state.behind,
      staged: state.staged,
      unstaged: state.unstaged,
      untracked: state.untracked,
      conflicted: state.conflicted,
      ...(untrackedLines === undefined ? {} : { untrackedLines }),
      clean:
        state.staged.length === 0 &&
        state.unstaged.length === 0 &&
        state.untracked.length === 0 &&
        state.conflicted.length === 0,
    };
  }

  /**
   * Name the operation git is in the middle of, if any.
   *
   * git leaves a marker per operation rather than a single flag, and the way out
   * differs for each, so the marker is read here instead of inferred.
   * @param gitDir - the resolved `.git` directory.
   */
  function operationInProgress(gitDir) {
    if (typeof gitDir !== 'string' || gitDir === '') return '';
    const marks = [
      ['MERGE_HEAD', 'merge'],
      ['CHERRY_PICK_HEAD', 'cherry-pick'],
      ['REVERT_HEAD', 'revert'],
      ['rebase-merge', 'rebase'],
      ['rebase-apply', 'rebase'],
    ];
    for (const [file, name] of marks) {
      if (existsSync(join(gitDir, file))) return name;
    }
    return '';
  }

  /** Assemble the argument tail that selects one diff scope. */
  async function scopeArgs(root, scope, options, signal) {
    const context = Number.isInteger(options.contextLines) ? ['-U', String(options.contextLines)] : [];
    const mode = options.stat ? ['--stat'] : options.nameOnly ? ['--name-status'] : [];
    const common = ['--no-color', '--no-ext-diff', ...context, ...mode];
    switch (scope) {
      case 'staged':
        return { args: ['diff', '--cached', ...common], note: '' };
      case 'unstaged':
        return { args: ['diff', ...common], note: '' };
      case 'last-commit':
        return { args: ['show', '--format=', '--patch', ...common, 'HEAD'], note: '' };
      case 'commit': {
        // One commit's own change, so a file listed under a commit can be read
        // without leaving the history view.
        const revision = String(options.revision ?? '').trim() || 'HEAD';
        const known = await run(['rev-parse', '--verify', '--quiet', `${revision}^{commit}`], { cwd: root, signal });
        if (!known.ok) return { error: `no commit matches ${revision}` };
        return { args: ['show', '--format=', '--patch', ...common, revision], note: '' };
      }
      case 'range': {
        const base = String(options.base ?? '').trim();
        const head = String(options.head ?? 'HEAD').trim();
        if (!base) return { error: 'scope "range" needs base (and optionally head)' };
        return { args: ['diff', `${base}..${head}`, ...common], note: '' };
      }
      case 'all':
      default: {
        if (await hasHead(root, signal)) return { args: ['diff', 'HEAD', ...common], note: '' };
        return {
          args: ['diff', '--cached', ...common],
          note: 'the repository has no commit yet, so "all" shows the staged change set only',
        };
      }
    }
  }

  /**
   * Read one patch.
   * @param args - `scope`, optional `paths`, `base`/`head`, `stat`, `nameOnly`,
   * `contextLines`, `maxBytes`, and `cwd`.
   */
  async function diff(args = {}) {
    const { cwd, signal, paths } = args;
    const found = await probe({ cwd, signal });
    if (!found.isRepo) {
      return { ok: true, isRepo: false, cwd: found.cwd, reason: found.reason, patch: '', files: [] };
    }
    const root = found.root;
    const selected = normalizePaths(root, paths);
    const escape = assertContained(root, selected);
    if (escape) return { ok: false, isRepo: true, root, error: escape };
    const scope = String(args.scope ?? 'all');
    const built = await scopeArgs(root, scope, args, signal);
    if (built.error) return { ok: false, isRepo: true, root, error: built.error };

    const pathArgs = selected.length > 0 ? ['--', ...selected] : [];
    const result = await run([...built.args, ...pathArgs], { cwd: root, signal });
    if (!result.ok) {
      return { ok: false, isRepo: true, root, error: describeFailure(result, 'git diff failed') };
    }
    const cap = Number.isInteger(args.maxBytes) && args.maxBytes > 0 ? args.maxBytes : settings.maxDiffBytes;
    const full = result.stdout;
    const truncated = full.length > cap;
    const files = await changedFiles(root, scope, selected, signal, args);
    return {
      ok: true,
      isRepo: true,
      root,
      scope,
      ...(built.note ? { note: built.note } : {}),
      patch: truncated ? full.slice(0, cap) : full,
      truncated,
      ...(truncated ? { omittedBytes: full.length - cap } : {}),
      files,
    };
  }

  /** The per-file change list for one scope, as `--numstat` reports it. */
  async function changedFiles(root, scope, paths, signal, options = {}) {
    const pathArgs = paths.length > 0 ? ['--', ...paths] : [];
    const args =
      scope === 'staged'
        ? ['diff', '--cached', '--numstat']
        : scope === 'last-commit'
          ? ['show', '--format=', '--numstat', 'HEAD']
          : scope === 'commit'
            ? ['show', '--format=', '--numstat', String(options.revision ?? '').trim() || 'HEAD']
            : scope === 'unstaged'
              ? ['diff', '--numstat']
              : ['diff', 'HEAD', '--numstat'];
    const result = await run([...args, ...pathArgs], { cwd: root, signal });
    if (!result.ok) return [];
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [added, deleted, ...rest] = line.split('\t');
        return {
          path: rest.join('\t'),
          additions: added === '-' ? null : Number(added),
          deletions: deleted === '-' ? null : Number(deleted),
        };
      })
      .filter((entry) => entry.path !== '');
  }

  /**
   * Add paths to the index, unstage them, or discard their working-tree edits.
   * @param args - `action` (`add` | `unstage` | `discard`), optional `paths`,
   * `keepUntracked` (discard only), and `cwd`.
   */
  async function stage(args = {}) {
    const { cwd, signal } = args;
    const action = String(args.action ?? 'add');
    const found = await probe({ cwd, signal });
    if (!found.isRepo) {
      return { ok: false, isRepo: false, cwd: found.cwd, error: `not a git repository: ${found.reason}` };
    }
    const root = found.root;
    const selected = normalizePaths(root, args.paths);
    const escape = assertContained(root, selected);
    if (escape) return { ok: false, isRepo: true, root, error: escape };
    const all = selected.length === 0;
    if (action === 'discard' && all) {
      return {
        ok: false,
        isRepo: true,
        root,
        error: 'discard needs an explicit paths list; pass ["."] to discard every tracked modification',
      };
    }

    if (action === 'add') {
      const result = all ? await run(['add', '-A'], { cwd: root, signal }) : await run(['add', '--', ...selected], {
        cwd: root,
        signal,
      });
      if (!result.ok) return { ok: false, isRepo: true, root, error: describeFailure(result, 'git add failed') };
      return { ok: true, isRepo: true, root, action, paths: all ? ['(all changes)'] : selected };
    }

    if (action === 'unstage') {
      const head = await hasHead(root, signal);
      const target = all ? ['.'] : selected;
      const result = head
        ? await run(['restore', '--staged', '--', ...target], { cwd: root, signal })
        : await run(['rm', '--cached', '-r', '-q', '--ignore-unmatch', '--', ...target], { cwd: root, signal });
      if (!result.ok) return { ok: false, isRepo: true, root, error: describeFailure(result, 'git unstage failed') };
      return { ok: true, isRepo: true, root, action, paths: all ? ['(all staged paths)'] : selected };
    }

    if (action === 'discard') {
      // A path can be tracked, untracked, or a directory holding both, and the
      // two need opposite treatment: a tracked file is restored from the index,
      // while an untracked one has no earlier version to go back to, so
      // discarding it means deleting it. `git restore` silently ignores the
      // untracked half, which is how "discarded" used to leave a new file on
      // disk. Ask git which is which rather than assuming.
      const listed = await run(['ls-files', '--others', '--exclude-standard', '-z', '--', ...selected], {
        cwd: root,
        signal,
      });
      const untracked = listed.ok ? listed.stdout.split('\0').filter(Boolean) : [];
      // Ignored files are deliberately out of scope: `git clean` without -x
      // leaves them alone, and nothing here should change that.
      const removable = args.keepUntracked === true ? [] : untracked;

      const restore = await run(['restore', '--', ...selected], { cwd: root, signal });
      if (!restore.ok && removable.length === 0) {
        return { ok: false, isRepo: true, root, error: describeFailure(restore, 'git restore failed') };
      }
      if (!restore.ok && !/did not match|pathspec/i.test(restore.stderr)) {
        // A real failure, not "this path only exists untracked".
        return { ok: false, isRepo: true, root, error: describeFailure(restore, 'git restore failed') };
      }

      let removed = [];
      if (removable.length > 0) {
        const clean = await run(['clean', '-f', '-d', '--', ...removable], { cwd: root, signal });
        if (!clean.ok) return { ok: false, isRepo: true, root, error: describeFailure(clean, 'git clean failed') };
        removed = clean.stdout
          .split('\n')
          .map((line) => line.replace(/^Removing\s+/, '').trim())
          .filter((line) => line !== '');
      }
      return {
        ok: true,
        isRepo: true,
        root,
        action,
        paths: selected,
        restored: restore.ok,
        removed,
        untracked: untracked.length,
        keepUntracked: args.keepUntracked === true,
      };
    }

    return { ok: false, isRepo: true, root, error: `unknown action "${action}"; expected add, unstage, or discard` };
  }

  /** Read one commit's per-file statistics. */
  async function commitStats(root, revision, signal) {
    const result = await run(['show', '--numstat', '--format=', '-1', revision], { cwd: root, signal });
    if (!result.ok) return [];
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [added, deleted, ...rest] = line.split('\t');
        return {
          path: rest.join('\t'),
          additions: added === '-' ? null : Number(added),
          deletions: deleted === '-' ? null : Number(deleted),
        };
      })
      .filter((entry) => entry.path !== '');
  }

  /**
   * Create a commit, generating the message when the caller supplies none.
   * @param args - `message`, `all`, `paths`, `amend`, `signoff`, `noVerify`,
   * `dryRun`, `cwd`, and `generateMessage` (injected by the plugin).
   */
  async function commit(args = {}) {
    const { cwd, signal, generateMessage } = args;
    const found = await probe({ cwd, signal });
    if (!found.isRepo) {
      return { ok: false, isRepo: false, cwd: found.cwd, error: `not a git repository: ${found.reason}` };
    }
    const root = found.root;
    const selected = normalizePaths(root, args.paths);
    const escape = assertContained(root, selected);
    if (escape) return { ok: false, isRepo: true, root, error: escape };

    if (args.all) {
      const added = await run(['add', '-A'], { cwd: root, signal });
      if (!added.ok) return { ok: false, isRepo: true, root, error: describeFailure(added, 'git add failed') };
    } else if (selected.length > 0) {
      const added = await run(['add', '--', ...selected], { cwd: root, signal });
      if (!added.ok) return { ok: false, isRepo: true, root, error: describeFailure(added, 'git add failed') };
    }

    const message = String(args.message ?? '').trim();
    let resolved = message;
    let generated = null;
    if (resolved === '' && !(args.amend && !args.regenerate)) {
      if (typeof generateMessage !== 'function') {
        return { ok: false, isRepo: true, root, error: 'no message was supplied and message generation is unavailable' };
      }
      const proposal = await generateMessage({ cwd: root, signal });
      if (!proposal.ok) return { ok: false, isRepo: true, root, error: proposal.error };
      resolved = proposal.message;
      generated = proposal;
    }

    const stagedStat = await run(['diff', '--cached', '--shortstat'], { cwd: root, signal });
    const stagedFiles = await run(['diff', '--cached', '--name-only'], { cwd: root, signal });
    const stagedCount = stagedFiles.ok ? stagedFiles.stdout.split('\n').filter((line) => line.trim() !== '').length : 0;

    if (args.dryRun) {
      return {
        ok: true,
        isRepo: true,
        root,
        dryRun: true,
        stagedCount,
        diffstat: stagedStat.stdout.trim(),
        message: resolved,
        generated: Boolean(generated),
        ...(generated ? { messageMeta: generated.meta } : {}),
      };
    }

    if (stagedCount === 0 && !args.amend) {
      return {
        ok: false,
        isRepo: true,
        root,
        error: 'nothing is staged; stage paths first (git_stage) or pass all: true',
        message: resolved,
      };
    }

    const commitArgs = ['commit'];
    if (args.amend) commitArgs.push('--amend');
    if (args.amend && resolved === '') commitArgs.push('--no-edit');
    else commitArgs.push('-F', '-');
    if (args.signoff || settings.signoff) commitArgs.push('--signoff');
    if (args.noVerify) commitArgs.push('--no-verify');

    const result = await run(commitArgs, {
      cwd: root,
      signal,
      stdin: resolved === '' ? undefined : `${resolved}\n`,
    });
    if (!result.ok) {
      const detail = describeFailure(result, 'git commit failed');
      const hint = identityHint(`${result.stderr}\n${result.stdout}`);
      return { ok: false, isRepo: true, root, error: hint ? `${detail} ${hint}` : detail, message: resolved };
    }

    const head = await run(['rev-parse', 'HEAD'], { cwd: root, signal });
    const hash = head.ok ? head.stdout.trim() : '';
    const branch = await run(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, signal });
    const files = hash ? await commitStats(root, 'HEAD', signal) : [];
    return {
      ok: true,
      isRepo: true,
      root,
      amend: Boolean(args.amend),
      hash,
      shortHash: hash.slice(0, 7),
      branch: branch.ok ? branch.stdout.trim() : '',
      subject: resolved === '' ? (result.stdout.match(/^\[[^\]]+\]\s*(.+)$/m)?.[1] ?? '') : resolved.split('\n')[0],
      message: resolved,
      generated: Boolean(generated),
      ...(generated ? { messageMeta: generated.meta } : {}),
      files,
      summary: result.stdout.trim().split('\n').slice(0, 4).join('\n'),
    };
  }

  /**
   * List recent commits on the checked-out branch.
   * @param args - `limit`, optional `path`, and `cwd`.
   */
  async function log(args = {}) {
    const { cwd, signal } = args;
    const found = await probe({ cwd, signal });
    if (!found.isRepo) {
      return { ok: false, isRepo: false, cwd: found.cwd, error: `not a git repository: ${found.reason}`, commits: [] };
    }
    const root = found.root;
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 200);
    const pathArgs = args.path ? ['--', ...normalizePaths(root, [args.path])] : [];
    const result = await run(
      ['log', `-n${limit}`, '--no-color', '--pretty=format:%h%x1f%an%x1f%aI%x1f%s%x00', ...pathArgs],
      { cwd: root, signal },
    );
    if (!result.ok) {
      if (/does not have any commits yet|unknown revision|bad default revision/i.test(result.stderr)) {
        return { ok: true, isRepo: true, root, commits: [], note: 'the repository has no commits yet' };
      }
      return { ok: false, isRepo: true, root, error: describeFailure(result, 'git log failed'), commits: [] };
    }
    const commits = result.stdout
      .split('\0')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [hash, author, date, ...subject] = entry.split('\u001f');
        return { hash, author, date, subject: subject.join('\u001f') };
      });
    return { ok: true, isRepo: true, root, commits };
  }

  /**
   * Read one commit: its whole message and the files it touched.
   * @param args - `cwd` and the commit `hash` (defaults to HEAD).
   */
  async function commitDetail({ cwd, signal, hash } = {}) {
    const found = await probe({ cwd, signal });
    if (!found.isRepo) {
      return { ok: false, isRepo: false, cwd: found.cwd, error: `not a git repository: ${found.reason}` };
    }
    const root = found.root;
    const revision = String(hash ?? '').trim() || 'HEAD';
    const meta = await run(
      ['show', '-s', '--no-color', '--no-patch', '--pretty=format:%H%x1f%h%x1f%an%x1f%aI%x1f%P%x1f%B', revision],
      { cwd: root, signal },
    );
    if (!meta.ok) return { ok: false, isRepo: true, root, error: describeFailure(meta, 'git show failed') };
    const [fullHash, shortHash, author, date, parents, ...rest] = meta.stdout.split('\u001f');
    const message = rest.join('\u001f').replace(/\s+$/, '');
    const lines = message.split('\n');
    const stat = await run(['show', '--numstat', '--format=', '-1', revision], { cwd: root, signal });
    const files = stat.ok
      ? stat.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => {
            const [added, deleted, ...tail] = line.split('\t');
            return {
              path: tail.join('\t'),
              additions: added === '-' ? null : Number(added),
              deletions: deleted === '-' ? null : Number(deleted),
            };
          })
          .filter((file) => file.path !== '')
      : [];
    return {
      ok: true,
      isRepo: true,
      root,
      hash: fullHash,
      shortHash,
      author,
      date,
      parents: parents === '' ? [] : parents.split(' '),
      subject: lines[0] ?? '',
      body: lines.slice(1).join('\n').trim(),
      message,
      files,
    };
  }

  /**
   * Read recent commits together with everything a graph view needs.
   *
   * Separate from `log` on purpose: the agent tool wants subjects, while the
   * panel wants parent links and the refs pointing at each commit, and the extra
   * git calls are only worth paying for the view that draws them.
   *
   * @param args - `limit` and `cwd`.
   */
  async function history(args = {}) {
    const { cwd, signal } = args;
    const found = await probe({ cwd, signal });
    if (!found.isRepo) {
      return { ok: false, isRepo: false, cwd: found.cwd, error: `not a git repository: ${found.reason}`, commits: [] };
    }
    const root = found.root;
    const limit = Math.min(Math.max(Number(args.limit) || 30, 1), 200);
    // `--all` on purpose: a graph of only the checked-out branch is a line, not
    // a tree. Every branch, remote-tracking ref, and tag is history a reader
    // wants to place themselves in, and refs below say which is which.
    const result = await run(
      [
        'log',
        '-n',
        String(limit),
        '--all',
        '--topo-order',
        '--no-color',
        '--pretty=format:%h%x1f%H%x1f%P%x1f%an%x1f%aI%x1f%s%x00',
      ],
      { cwd: root, signal },
    );
    if (!result.ok) {
      if (/does not have any commits yet|unknown revision|bad default revision/i.test(result.stderr)) {
        return {
          ok: true,
          isRepo: true,
          root,
          commits: [],
          graph: { rows: [], laneCount: 1 },
          note: 'the repository has no commits yet',
        };
      }
      return { ok: false, isRepo: true, root, error: describeFailure(result, 'git log failed'), commits: [] };
    }
    const commits = result.stdout
      .split('\0')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [shortHash, fullHash, parents, author, date, ...subject] = entry.split('\u001f');
        return {
          hash: fullHash,
          shortHash,
          parents: parents === '' ? [] : parents.split(' '),
          subject: subject.join('\u001f'),
          author,
          date,
          refs: [],
        };
      });

    // One extra call names every branch and remote-tracking ref, so the view can
    // show where they point instead of leaving the reader to guess.
    const refs = await run(
      // `%(*objectname)` is the commit an annotated tag points at; without it a
      // tag would name the tag object and match no commit in the list.
      [
        'for-each-ref',
        '--format=%(refname:short)%1f%(objectname)%1f%(*objectname)',
        'refs/heads',
        'refs/remotes',
        'refs/tags',
      ],
      { cwd: root, signal },
    );
    if (refs.ok) {
      const byHash = new Map(commits.map((commit) => [commit.hash, commit]));
      for (const line of refs.stdout.split('\n')) {
        if (line.trim() === '') continue;
        const [name, objectId, peeled] = line.split('\u001f');
        const commit = byHash.get(((peeled ?? '').trim() || (objectId ?? '').trim()));
        if (commit !== undefined && name !== undefined && !name.endsWith('/HEAD')) commit.refs.push(name.trim());
      }
    }

    // The graph only needs the short parent ids, which is also what the view shows.
    const graph = buildGraph(
      commits.map((commit) => ({ hash: commit.shortHash, parents: commit.parents.map((parent) => parent.slice(0, 7)) })),
    );
    const current = await run(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, signal });
    const head = await run(['rev-parse', 'HEAD'], { cwd: root, signal });
    return {
      ok: true,
      isRepo: true,
      root,
      branch: current.ok ? current.stdout.trim() : '',
      // With `--all`, the newest row is not necessarily the checked-out commit,
      // so the view is told which one HEAD points at instead of assuming.
      head: head.ok ? head.stdout.trim() : '',
      commits,
      graph,
    };
  }

  /** Give a repository the commit identity a first commit needs, if it is missing. */
  async function identity(root, signal) {
    const name = await run(['config', '--get', 'user.name'], { cwd: root, signal });
    const email = await run(['config', '--get', 'user.email'], { cwd: root, signal });
    return {
      userName: name.ok ? name.stdout.trim() : '',
      userEmail: email.ok ? email.stdout.trim() : '',
    };
  }

  /**
   * Create a repository, optionally with a .gitignore and a first commit.
   * @param args - `initialBranch`, `gitignore` text, `initialCommitMessage`, `cwd`.
   */
  async function init(args = {}) {
    const { cwd, signal } = args;
    const target = cwd ?? process.cwd();
    const existing = await probe({ cwd: target, signal });
    if (existing.isRepo) {
      return { ok: true, isRepo: true, root: existing.root, created: false, note: 'already a git repository' };
    }
    const branch = String(args.initialBranch ?? settings.defaultBranch ?? 'main').trim() || 'main';
    if (!existsSync(target)) mkdirSync(target, { recursive: true });
    const created = await run(['init', '-b', branch], { cwd: target, signal });
    if (!created.ok) {
      return { ok: false, isRepo: false, cwd: target, error: describeFailure(created, 'git init failed') };
    }
    const found = await probe({ cwd: target, signal });
    const root = found.isRepo ? found.root : target;

    let wroteGitignore = false;
    const gitignoreText = typeof args.gitignore === 'string' ? args.gitignore : '';
    if (gitignoreText.trim() !== '') {
      const path = join(root, '.gitignore');
      if (!existsSync(path)) {
        writeFileSync(path, gitignoreText.endsWith('\n') ? gitignoreText : `${gitignoreText}\n`, 'utf8');
        wroteGitignore = true;
      }
    }

    const identityInfo = await identity(root, signal);
    let initialCommit = null;
    let initialCommitError = '';
    const firstMessage = String(args.initialCommitMessage ?? '').trim();
    if (firstMessage !== '') {
      if (identityInfo.userName === '' || identityInfo.userEmail === '') {
        initialCommitError =
          'the first commit was skipped because no commit identity is configured; run git_config with action "set" for user.name and user.email';
      } else {
        await run(['add', '-A'], { cwd: root, signal });
        const committed = await run(['commit', '-F', '-'], { cwd: root, signal, stdin: `${firstMessage}\n` });
        if (committed.ok) {
          const head = await run(['rev-parse', 'HEAD'], { cwd: root, signal });
          initialCommit = head.ok ? head.stdout.trim() : '';
        } else {
          initialCommitError = describeFailure(committed, 'the first commit failed');
        }
      }
    }

    return {
      ok: true,
      isRepo: true,
      root,
      created: true,
      branch,
      gitignoreWritten: wroteGitignore,
      identity: identityInfo,
      identityConfigured: identityInfo.userName !== '' && identityInfo.userEmail !== '',
      initialCommit,
      ...(initialCommitError ? { initialCommitError } : {}),
    };
  }

  /**
   * Read or write git configuration.
   * @param args - `action` (`get` | `set` | `unset` | `list`), `key`, `value`,
   * `scope` (`local` | `global` | `effective`), and `cwd`.
   */
  async function configCommand(args = {}) {
    const { cwd, signal } = args;
    const action = String(args.action ?? 'get');
    const scope = String(args.scope ?? 'local');
    const scopeFlag =
      scope === 'global' ? '--global' : scope === 'effective' ? null : '--local';
    if (scope === 'local' || scope === 'global') {
      const found = await probe({ cwd, signal });
      if (scope === 'local' && !found.isRepo) {
        return { ok: false, isRepo: false, error: `not a git repository: ${found.reason}` };
      }
      if (!found.isRepo && scope === 'local') return { ok: false, isRepo: false, error: 'not a git repository' };
    }
    const workdir = (await probe({ cwd, signal })).root ?? cwd;
    const key = String(args.key ?? '').trim();
    const value = args.value === undefined || args.value === null ? '' : String(args.value);

    if (action === 'list') {
      const result = await run(['config', ...(scopeFlag ? [scopeFlag] : []), '--list'], { cwd: workdir, signal });
      if (!result.ok) return { ok: false, error: describeFailure(result, 'git config --list failed') };
      const entries = result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const at = line.indexOf('=');
          return at === -1 ? { key: line, value: '' } : { key: line.slice(0, at), value: line.slice(at + 1) };
        });
      return { ok: true, root: workdir, scope, entries };
    }

    if (key === '') return { ok: false, error: `${action} needs a key, for example user.name` };

    if (action === 'get') {
      const result = await run(['config', ...(scopeFlag ? [scopeFlag] : []), '--get', key], { cwd: workdir, signal });
      if (!result.ok) return { ok: true, root: workdir, scope, key, value: '', found: false };
      return { ok: true, root: workdir, scope, key, value: result.stdout.trim(), found: true };
    }

    if (action === 'set') {
      if (value === '') return { ok: false, error: 'set needs a value' };
      const result = await run(['config', ...(scopeFlag ? [scopeFlag] : []), key, value], { cwd: workdir, signal });
      if (!result.ok) return { ok: false, error: describeFailure(result, 'git config failed') };
      return { ok: true, root: workdir, scope, key, value, written: true };
    }

    if (action === 'unset') {
      const result = await run(['config', ...(scopeFlag ? [scopeFlag] : []), '--unset', key], { cwd: workdir, signal });
      if (!result.ok) {
        if (/not found|no such section|multiple values/i.test(result.stderr)) {
          return { ok: true, root: workdir, scope, key, removed: false };
        }
        return { ok: false, error: describeFailure(result, 'git config --unset failed') };
      }
      return { ok: true, root: workdir, scope, key, removed: true };
    }

    return { ok: false, error: `unknown action "${action}"; expected get, set, unset, or list` };
  }

  /**
   * Fetch, pull, or push the checked-out branch.
   * @param args - `action` (`push` | `pull` | `fetch`), `remote`, `branch`,
   * `setUpstream`, `force`, `rebase`, `prune`, and `cwd`.
   */
  async function sync(args = {}) {
    const { cwd, signal } = args;
    const action = String(args.action ?? 'push');
    const found = await probe({ cwd, signal });
    if (!found.isRepo) {
      return { ok: false, isRepo: false, cwd: found.cwd, error: `not a git repository: ${found.reason}` };
    }
    const root = found.root;
    const networkTimeout = settings.commandTimeoutMs * 4;
    const remotes = await run(['remote'], { cwd: root, signal });
    const remoteList = remotes.ok ? remotes.stdout.split('\n').map((line) => line.trim()).filter(Boolean) : [];
    const remote = String(args.remote ?? (remoteList.includes('origin') ? 'origin' : remoteList[0] ?? 'origin')).trim();

    if (action === 'fetch') {
      const fetchArgs = remoteList.length === 0 ? ['fetch'] : ['fetch', remote];
      if (args.prune) fetchArgs.push('--prune');
      const result = await run(fetchArgs, { cwd: root, signal, timeoutMs: networkTimeout });
      if (!result.ok) return { ok: false, isRepo: true, root, error: describeFailure(result, 'git fetch failed') };
      return { ok: true, isRepo: true, root, action, remote: remoteList.length === 0 ? '(none)' : remote };
    }

    if (remoteList.length === 0) {
      return {
        ok: false,
        isRepo: true,
        root,
        error: 'this repository has no remote; add one with `git remote add origin <url>` before pushing or pulling',
      };
    }

    /**
     * One button that reconciles both directions.
     *
     * Fetch first so the ahead/behind counts describe the remote as it is now
     * rather than as of the last fetch, then move whichever side is actually
     * behind. The pull is `--ff-only`: a one-click action should never invent a
     * merge commit or leave a conflicted tree behind, so a diverged branch is
     * reported instead of merged.
     */
    if (action === 'sync') {
      const current = await run(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, signal });
      const branch = String(args.branch ?? (current.ok ? current.stdout.trim() : '')).trim();
      if (branch === '' || branch === 'HEAD') {
        return { ok: false, isRepo: true, root, action, error: 'HEAD is detached; name the branch to sync' };
      }

      const fetched = await run(['fetch', remote], { cwd: root, signal, timeoutMs: networkTimeout });
      if (!fetched.ok) {
        return { ok: false, isRepo: true, root, action, error: describeFailure(fetched, 'git fetch failed') };
      }

      const before = await status({ cwd: root, signal });
      const upstream = before.upstream ?? '';
      // A configured upstream name is not the same as a ref that exists: cloning
      // a remote with no branches yet leaves the branch tracking `origin/main`
      // before `origin/main` is there, and a pruned remote branch removes the ref
      // while leaving the config. Treat both as "publish this branch", or the
      // commits would sit locally with nothing ever pushing them.
      const tracked =
        upstream !== '' &&
        (await run(['rev-parse', '--verify', '--quiet', `refs/remotes/${upstream}`], { cwd: root, signal })).ok;
      const publish = !tracked;
      let pulled = 0;
      if (tracked && before.behind > 0) {
        const pulledResult = await run(['pull', '--ff-only', remote, branch], {
          cwd: root,
          signal,
          timeoutMs: networkTimeout,
        });
        if (!pulledResult.ok) {
          return {
            ok: false,
            isRepo: true,
            root,
            action,
            diverged: true,
            error: `local ${branch} and ${upstream} have diverged; merge or rebase them yourself, then sync again`,
            summary: pulledResult.stdout.trim() || pulledResult.stderr.trim(),
          };
        }
        pulled = before.behind;
      }

      const after = await status({ cwd: root, signal });
      let pushed = 0;
      if (publish || after.ahead > 0) {
        // Publishing a branch sends every commit it holds; there is no upstream
        // to measure against yet.
        const total = publish ? await run(['rev-list', '--count', 'HEAD'], { cwd: root, signal }) : null;
        const ahead = total === null ? after.ahead : total.ok ? Number(total.stdout.trim()) : 1;
        pushed = ahead === 0 ? 1 : ahead;
        const pushArgs = ['push'];
        if (publish) pushArgs.push('-u');
        pushArgs.push(remote, branch);
        const pushedResult = await run(pushArgs, { cwd: root, signal, timeoutMs: networkTimeout });
        if (!pushedResult.ok) {
          return {
            ok: false,
            isRepo: true,
            root,
            action,
            error: describeFailure(pushedResult, 'git push failed'),
            summary: pushedResult.stdout.trim() || pushedResult.stderr.trim(),
          };
        }
      }

      const settled = await status({ cwd: root, signal });
      return {
        ok: true,
        isRepo: true,
        root,
        action,
        remote,
        branch,
        upstream: tracked ? upstream : '',
        published: publish,
        pulled,
        pushed,
        ahead: settled.ahead,
        behind: settled.behind,
      };
    }

    if (action === 'pull') {
      const pullArgs = ['pull'];
      if (args.rebase) pullArgs.push('--rebase');
      pullArgs.push(remote);
      const branch = String(args.branch ?? '').trim();
      if (branch) pullArgs.push(branch);
      const result = await run(pullArgs, { cwd: root, signal, timeoutMs: networkTimeout });
      if (!result.ok) {
        return {
          ok: false,
          isRepo: true,
          root,
          error: describeFailure(result, 'git pull failed'),
          summary: result.stdout.trim() || result.stderr.trim(),
        };
      }
      return { ok: true, isRepo: true, root, action, remote, summary: result.stdout.trim() || 'already up to date' };
    }

    if (action === 'push') {
      const current = await run(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, signal });
      const branch = String(args.branch ?? (current.ok ? current.stdout.trim() : '')).trim();
      if (branch === '' || branch === 'HEAD') {
        return { ok: false, isRepo: true, root, error: 'HEAD is detached; name the branch to push' };
      }
      const state = await status({ cwd: root, signal });
      const tracking = state.upstream ? state.upstream : '';
      const pushArgs = ['push'];
      const wantUpstream = args.setUpstream ?? tracking === '';
      if (args.force) pushArgs.push('--force-with-lease');
      if (wantUpstream) pushArgs.push('-u');
      pushArgs.push(remote, branch);
      const result = await run(pushArgs, { cwd: root, signal, timeoutMs: networkTimeout });
      if (!result.ok) {
        return {
          ok: false,
          isRepo: true,
          root,
          error: describeFailure(result, 'git push failed'),
          summary: result.stdout.trim() || result.stderr.trim(),
        };
      }
      return {
        ok: true,
        isRepo: true,
        root,
        action,
        remote,
        branch,
        setUpstream: Boolean(wantUpstream),
        summary: result.stdout.trim() || result.stderr.trim(),
      };
    }

    return { ok: false, isRepo: true, root, error: `unknown action "${action}"; expected push, pull, or fetch` };
  }

  /**
   * A conflict is a state, not a crash — shared by every operation that can stop
   * halfway (merge, revert, cherry-pick, rebase).
   */
  async function conflictedState(root, signal, describe) {
    const state = await status({ cwd: root, signal });
    const conflicts = state.conflicted ?? [];
    if (conflicts.length === 0) return null;
    return {
      ok: false,
      isRepo: true,
      root,
      conflicted: true,
      conflicts: conflicts.map((entry) => entry.path),
      error: `${describe} stopped with ${conflicts.length} conflicted file(s); resolve them and stage them, then continue or abort`,
    };
  }

  /**
   * Read, create, delete, or publish tags.
   *
   * The name is checked with `git check-ref-format` rather than a hand-rolled
   * pattern: git owns the rule, and a name it rejects must never reach a command
   * line.
   *
   * @param args - `action` (`list` | `create` | `delete` | `push`), `name`,
   * `message`, `revision`, `force`, `remote`, and `cwd`.
   */
  async function tag(args = {}) {
    const { cwd, signal } = args;
    const action = String(args.action ?? 'list');
    const found = await probe({ cwd, signal });
    if (!found.isRepo) {
      return { ok: false, isRepo: false, cwd: found.cwd, error: `not a git repository: ${found.reason}` };
    }
    const root = found.root;
    const remotes = await run(['remote'], { cwd: root, signal });
    const remoteList = remotes.ok ? remotes.stdout.split('\n').map((line) => line.trim()).filter(Boolean) : [];

    if (action === 'list') {
      const listed = await run(
        [
          'tag',
          '--list',
          '--sort=-creatordate',
          '--format=%(refname:short)%1f%(objectname:short)%1f%(creatordate:short)%1f%(subject)',
        ],
        { cwd: root, signal },
      );
      if (!listed.ok) return { ok: false, isRepo: true, root, error: describeFailure(listed, 'git tag failed') };
      const tags = listed.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [name, hash, date, ...subject] = line.split('\u001f');
          return { name, hash, date, subject: subject.join('\u001f') };
        });
      return { ok: true, isRepo: true, root, action, tags, remotes: remoteList };
    }

    const name = String(args.name ?? '').trim();
    if (name === '' && !(action === 'push' && args.all === true)) {
      return { ok: false, isRepo: true, root, error: `${action} needs a tag name` };
    }
    if (name !== '') {
      const valid = await run(['check-ref-format', `refs/tags/${name}`], { cwd: root, signal });
      if (!valid.ok) return { ok: false, isRepo: true, root, error: `"${name}" is not a usable tag name` };
    }

    if (action === 'create') {
      const createArgs = ['tag'];
      const message = String(args.message ?? '').trim();
      if (message !== '') createArgs.push('-a', '-m', message);
      if (args.force === true) createArgs.push('-f');
      createArgs.push(name);
      const revision = String(args.revision ?? '').trim();
      if (revision !== '') createArgs.push(revision);
      const created = await run(createArgs, { cwd: root, signal });
      if (!created.ok) {
        return { ok: false, isRepo: true, root, action, error: describeFailure(created, 'git tag failed') };
      }
      return {
        ok: true,
        isRepo: true,
        root,
        action,
        name,
        annotated: message !== '',
        revision: revision || 'HEAD',
        summary: created.stdout.trim(),
      };
    }

    if (action === 'delete') {
      const removed = await run(['tag', '-d', name], { cwd: root, signal });
      if (!removed.ok) {
        return { ok: false, isRepo: true, root, action, error: describeFailure(removed, 'git tag -d failed') };
      }
      return { ok: true, isRepo: true, root, action, name, summary: removed.stdout.trim() };
    }

    if (action === 'push') {
      if (remoteList.length === 0) {
        return { ok: false, isRepo: true, root, action, error: 'this repository has no remote to push tags to' };
      }
      const remote = String(args.remote ?? (remoteList.includes('origin') ? 'origin' : remoteList[0])).trim();
      const pushArgs = ['push', remote];
      if (args.all === true) pushArgs.push('--tags');
      else pushArgs.push(name);
      const pushed = await run(pushArgs, { cwd: root, signal, timeoutMs: settings.commandTimeoutMs * 4 });
      if (!pushed.ok) {
        return {
          ok: false,
          isRepo: true,
          root,
          action,
          error: describeFailure(pushed, 'pushing the tag failed'),
          summary: pushed.stdout.trim(),
        };
      }
      return { ok: true, isRepo: true, root, action, name: name || '(all tags)', remote, summary: pushed.stdout.trim() };
    }

    return { ok: false, isRepo: true, root, error: `unknown action "${action}"; expected list, create, delete, or push` };
  }

  /**
   * Undo one commit by adding its inverse.
   *
   * This is the counterpart of `resetLastCommit` for history that is already
   * published: it never moves a ref, so nothing anyone else has is rewritten.
   *
   * @param args - `revision`, `noCommit`, `mainline`, and `cwd`.
   */
  async function revert(args = {}) {
    const { cwd, signal } = args;
    const found = await probe({ cwd, signal });
    if (!found.isRepo) {
      return { ok: false, isRepo: false, cwd: found.cwd, error: `not a git repository: ${found.reason}` };
    }
    const root = found.root;
    const revision = String(args.revision ?? 'HEAD').trim() || 'HEAD';
    const exists = await run(['rev-parse', '--verify', '--quiet', `${revision}^{commit}`], { cwd: root, signal });
    if (!exists.ok) return { ok: false, isRepo: true, root, error: `no commit matches ${revision}` };

    if (args.abort === true) {
      const aborted = await run(['revert', '--abort'], { cwd: root, signal });
      if (!aborted.ok) {
        return { ok: false, isRepo: true, root, action: 'revert', error: describeFailure(aborted, 'git revert --abort failed') };
      }
      return { ok: true, isRepo: true, root, action: 'revert', aborted: true };
    }

    const revertArgs = ['revert', '--no-edit'];
    if (args.noCommit === true) revertArgs.push('--no-commit');
    const mainline = Number(args.mainline);
    if (Number.isInteger(mainline) && mainline > 0) revertArgs.push('-m', String(mainline));
    revertArgs.push(revision);

    const result = await run(revertArgs, { cwd: root, signal, timeoutMs: settings.commandTimeoutMs * 2 });
    const stopped = await conflictedState(root, signal, `reverting ${revision}`);
    if (stopped !== null) return { ...stopped, action: 'revert', revision, summary: result.stdout.trim() };
    if (!result.ok) {
      return {
        ok: false,
        isRepo: true,
        root,
        action: 'revert',
        revision,
        error: describeFailure(result, 'git revert failed'),
        summary: result.stdout.trim(),
      };
    }
    const state = await status({ cwd: root, signal });
    const head = await run(['rev-parse', '--short', 'HEAD'], { cwd: root, signal });
    return {
      ok: true,
      isRepo: true,
      root,
      action: 'revert',
      revision,
      hash: args.noCommit === true ? '' : head.ok ? head.stdout.trim() : '',
      staged: state.staged.length,
      summary: result.stdout.trim(),
    };
  }

  /**
   * Apply the changes of one or more commits here, as new commits.
   *
   * @param args - `revisions`, `noCommit`, `mainline`, and `cwd`.
   */
  async function cherryPick(args = {}) {
    const { cwd, signal } = args;
    const found = await probe({ cwd, signal });
    if (!found.isRepo) {
      return { ok: false, isRepo: false, cwd: found.cwd, error: `not a git repository: ${found.reason}` };
    }
    const root = found.root;
    if (args.abort === true) {
      const aborted = await run(['cherry-pick', '--abort'], { cwd: root, signal });
      if (!aborted.ok) {
        return {
          ok: false,
          isRepo: true,
          root,
          action: 'cherry-pick',
          error: describeFailure(aborted, 'git cherry-pick --abort failed'),
        };
      }
      return { ok: true, isRepo: true, root, action: 'cherry-pick', aborted: true };
    }
    const listed = Array.isArray(args.revisions) ? args.revisions : [args.revision];
    const revisions = listed.map((entry) => String(entry ?? '').trim()).filter(Boolean);
    if (revisions.length === 0) {
      return { ok: false, isRepo: true, root, error: 'cherry-pick needs at least one revision' };
    }
    for (const revision of revisions) {
      const exists = await run(['rev-parse', '--verify', '--quiet', `${revision}^{commit}`], { cwd: root, signal });
      if (!exists.ok) return { ok: false, isRepo: true, root, error: `no commit matches ${revision}` };
    }

    const pickArgs = ['cherry-pick'];
    if (args.noCommit === true) pickArgs.push('--no-commit');
    const mainline = Number(args.mainline);
    if (Number.isInteger(mainline) && mainline > 0) pickArgs.push('-m', String(mainline));
    pickArgs.push(...revisions);

    const result = await run(pickArgs, { cwd: root, signal, timeoutMs: settings.commandTimeoutMs * 2 });
    const stopped = await conflictedState(root, signal, `cherry-picking ${revisions.join(', ')}`);
    if (stopped !== null) return { ...stopped, action: 'cherry-pick', revisions, summary: result.stdout.trim() };
    if (!result.ok) {
      return {
        ok: false,
        isRepo: true,
        root,
        action: 'cherry-pick',
        revisions,
        error: describeFailure(result, 'git cherry-pick failed'),
        summary: result.stdout.trim(),
      };
    }
    const head = await run(['rev-parse', '--short', 'HEAD'], { cwd: root, signal });
    return {
      ok: true,
      isRepo: true,
      root,
      action: 'cherry-pick',
      revisions,
      hash: head.ok ? head.stdout.trim() : '',
      summary: result.stdout.trim(),
    };
  }

  /**
   * Replay this branch's commits on top of another revision.
   *
   * Stopping is expected here more than anywhere else, so the same conflict
   * report covers it and `continue`/`abort` are first-class actions rather than
   * something the caller has to run by hand.
   *
   * @param args - `onto`, `abort`, `continue`, `autostash`, and `cwd`.
   */
  async function rebase(args = {}) {
    const { cwd, signal } = args;
    const found = await probe({ cwd, signal });
    if (!found.isRepo) {
      return { ok: false, isRepo: false, cwd: found.cwd, error: `not a git repository: ${found.reason}` };
    }
    const root = found.root;

    if (args.abort === true || args.continue === true) {
      const verb = args.abort === true ? '--abort' : '--continue';
      const stepped = await run(['rebase', verb], { cwd: root, signal, timeoutMs: settings.commandTimeoutMs * 2 });
      const stopped = await conflictedState(root, signal, 'the rebase');
      if (stopped !== null) return { ...stopped, action: 'rebase', step: verb };
      if (!stepped.ok) {
        return {
          ok: false,
          isRepo: true,
          root,
          action: 'rebase',
          step: verb,
          error: describeFailure(stepped, `git rebase ${verb} failed`),
          summary: stepped.stdout.trim() || stepped.stderr.trim(),
        };
      }
      const head = await run(['rev-parse', '--short', 'HEAD'], { cwd: root, signal });
      return {
        ok: true,
        isRepo: true,
        root,
        action: 'rebase',
        step: verb,
        aborted: args.abort === true,
        hash: head.ok ? head.stdout.trim() : '',
        summary: stepped.stdout.trim(),
      };
    }

    const onto = String(args.onto ?? '').trim();
    if (onto === '') {
      return { ok: false, isRepo: true, root, error: 'rebase needs the branch or revision to rebase onto' };
    }
    const exists = await run(['rev-parse', '--verify', '--quiet', `${onto}^{commit}`], { cwd: root, signal });
    if (!exists.ok) return { ok: false, isRepo: true, root, error: `no branch or commit matches ${onto}` };

    const rebaseArgs = ['rebase'];
    if (args.autostash === true) rebaseArgs.push('--autostash');
    rebaseArgs.push(onto);

    const result = await run(rebaseArgs, { cwd: root, signal, timeoutMs: settings.commandTimeoutMs * 2 });
    const stopped = await conflictedState(root, signal, `rebasing onto ${onto}`);
    if (stopped !== null) return { ...stopped, action: 'rebase', onto, summary: result.stdout.trim() };
    if (!result.ok) {
      return {
        ok: false,
        isRepo: true,
        root,
        action: 'rebase',
        onto,
        error: describeFailure(result, 'git rebase failed'),
        summary: result.stdout.trim() || result.stderr.trim(),
      };
    }
    const head = await run(['rev-parse', '--short', 'HEAD'], { cwd: root, signal });
    return {
      ok: true,
      isRepo: true,
      root,
      action: 'rebase',
      onto,
      hash: head.ok ? head.stdout.trim() : '',
      upToDate: /up to date|up-to-date/i.test(result.stdout),
      summary: result.stdout.trim(),
    };
  }

  /**
   * Set working-tree changes aside, or put them back.
   *
   * Stashes are addressed by position, so the index is turned into `stash@{N}`
   * here rather than accepted as text: an argument that reached git verbatim
   * could name a commit instead.
   *
   * @param args - `action` (`push` | `list` | `pop` | `apply` | `drop`),
   * `message`, `index`, `includeUntracked`, `paths`, and `cwd`.
   */
  async function stash(args = {}) {
    const { cwd, signal } = args;
    const action = String(args.action ?? 'push');
    const found = await probe({ cwd, signal });
    if (!found.isRepo) {
      return { ok: false, isRepo: false, cwd: found.cwd, error: `not a git repository: ${found.reason}` };
    }
    const root = found.root;
    const position = Math.max(0, Math.trunc(Number(args.index) || 0));
    const ref = `stash@{${position}}`;

    /** Read the stash list, newest first. */
    const readList = async () => {
      const listed = await run(['stash', 'list', '--no-color', '--pretty=format:%gd%x1f%s%x1f%cr'], {
        cwd: root,
        signal,
      });
      if (!listed.ok) return null;
      return listed.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [name, subject, when] = line.split('\u001f');
          return { ref: name, subject, when };
        });
    };

    if (action === 'list') {
      const entries = await readList();
      if (entries === null) return { ok: false, isRepo: true, root, error: 'git stash list failed' };
      return { ok: true, isRepo: true, root, action, stashes: entries };
    }

    if (action === 'push') {
      const pushArgs = ['stash', 'push'];
      const message = String(args.message ?? '').trim();
      if (message !== '') pushArgs.push('-m', message);
      if (args.includeUntracked === true) pushArgs.push('-u');
      const selected = normalizePaths(root, args.paths);
      const escape = assertContained(root, selected);
      if (escape) return { ok: false, isRepo: true, root, error: escape };
      if (selected.length > 0) pushArgs.push('--', ...selected);

      const result = await run(pushArgs, { cwd: root, signal });
      if (!result.ok) {
        return { ok: false, isRepo: true, root, action, error: describeFailure(result, 'git stash failed') };
      }
      const clean = /No local changes to save/i.test(result.stdout);
      const entries = await readList();
      return {
        ok: true,
        isRepo: true,
        root,
        action,
        nothingToStash: clean,
        stash: entries?.[0] ?? null,
        stashes: entries ?? [],
      };
    }

    if (action === 'pop' || action === 'apply' || action === 'drop') {
      const entries = await readList();
      if (entries !== null && entries.length === 0) {
        return { ok: false, isRepo: true, root, action, error: 'there is nothing in the stash' };
      }
      const verb = action === 'drop' ? 'drop' : action;
      const result = await run(['stash', verb, ref], { cwd: root, signal });
      if (!result.ok) {
        return { ok: false, isRepo: true, root, action, error: describeFailure(result, `git stash ${verb} failed`) };
      }
      const after = await readList();
      const state = await status({ cwd: root, signal });
      return {
        ok: true,
        isRepo: true,
        root,
        action,
        ref,
        // A pop that conflicts leaves the stash in place, which is worth saying.
        kept: action === 'pop' ? /conflict/i.test(result.stdout + result.stderr) : undefined,
        conflicts: state.conflicted?.length ?? 0,
        restored: state.unstaged.length + state.staged.length,
        stashes: after ?? [],
        summary: result.stdout.trim(),
      };
    }

    return { ok: false, isRepo: true, root, error: `unknown action "${action}"; expected push, list, pop, apply, or drop` };
  }

  /**
   * Merge a branch into the checked-out one, or undo a merge that stopped.
   *
   * A conflicted merge is a normal outcome, not a failure to hide: git exits
   * non-zero and leaves the index mid-merge, so the result says which files need
   * a decision and the caller can show them. `abort` puts the working tree back.
   *
   * @param args - `branch` to merge in, `noFf`, `message`, `abort`, and `cwd`.
   */
  async function merge(args = {}) {
    const { cwd, signal } = args;
    const found = await probe({ cwd, signal });
    if (!found.isRepo) {
      return { ok: false, isRepo: false, cwd: found.cwd, error: `not a git repository: ${found.reason}` };
    }
    const root = found.root;
    const current = await run(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, signal });
    const head = current.ok ? current.stdout.trim() : '';

    if (args.abort === true) {
      const aborted = await run(['merge', '--abort'], { cwd: root, signal });
      if (!aborted.ok) {
        return { ok: false, isRepo: true, root, error: describeFailure(aborted, 'git merge --abort failed') };
      }
      const settled = await status({ cwd: root, signal });
      return { ok: true, isRepo: true, root, action: 'abort', branch: head, conflicts: settled.conflicted?.length ?? 0 };
    }

    const source = String(args.branch ?? '').trim();
    if (source === '') return { ok: false, isRepo: true, root, error: 'merge needs the branch to merge in' };
    if (source === head) {
      return { ok: false, isRepo: true, root, error: `${source} is already the checked-out branch` };
    }
    const exists = await run(['rev-parse', '--verify', '--quiet', `refs/heads/${source}`], { cwd: root, signal });
    if (!exists.ok) return { ok: false, isRepo: true, root, error: `there is no local branch named ${source}` };

    const mergeArgs = ['merge'];
    if (args.noFf === true) mergeArgs.push('--no-ff');
    const message = String(args.message ?? '').trim();
    if (message !== '') mergeArgs.push('-m', message);
    mergeArgs.push(source);

    const result = await run(mergeArgs, { cwd: root, signal, timeoutMs: settings.commandTimeoutMs * 2 });
    const state = await status({ cwd: root, signal });
    const conflicts = state.conflicted ?? [];

    if (conflicts.length > 0) {
      return {
        ok: false,
        isRepo: true,
        root,
        action: 'merge',
        branch: source,
        // A merge that needs a human is a state, not a crash: say so and hand
        // back the files, so a surface can offer "resolve and commit" or "abort".
        conflicted: true,
        conflicts: conflicts.map((entry) => entry.path),
        error: `merging ${source} into ${head} stopped with ${conflicts.length} conflicted file(s); resolve them and commit, or abort the merge`,
        summary: result.stdout.trim().split('\n').slice(0, 6).join('\n'),
      };
    }
    if (!result.ok) {
      return {
        ok: false,
        isRepo: true,
        root,
        action: 'merge',
        branch: source,
        error: describeFailure(result, 'git merge failed'),
        summary: result.stdout.trim() || result.stderr.trim(),
      };
    }

    const newHead = await run(['rev-parse', '--short', 'HEAD'], { cwd: root, signal });
    return {
      ok: true,
      isRepo: true,
      root,
      action: 'merge',
      branch: source,
      into: head,
      head: newHead.ok ? newHead.stdout.trim() : '',
      fastForward: /fast-forward/i.test(result.stdout),
      upToDate: /already up to date/i.test(result.stdout),
      changed: state.staged.length + state.unstaged.length,
      summary: result.stdout.trim(),
    };
  }

  /**
   * List, create, switch, or delete local branches.
   * @param args - `action` (`list` | `create` | `switch` | `delete`), `name`,
   * `startPoint`, `force`, and `cwd`.
   */
  async function branch(args = {}) {
    const { cwd, signal } = args;
    const action = String(args.action ?? 'list');
    const found = await probe({ cwd, signal });
    if (!found.isRepo) {
      return { ok: false, isRepo: false, cwd: found.cwd, error: `not a git repository: ${found.reason}` };
    }
    const root = found.root;

    if (action === 'list') {
      const result = await run(
        ['branch', '--no-color', '--format=%(HEAD)%1f%(refname:short)%1f%(upstream:short)%1f%(upstream:track)%1f%(committerdate:short)%1f%(subject)'],
        { cwd: root, signal },
      );
      if (!result.ok) return { ok: false, isRepo: true, root, error: describeFailure(result, 'git branch failed') };
      const branches = result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [head, name, upstream, track, date, ...subject] = line.split('\u001f');
          return {
            current: head === '*',
            name,
            upstream: upstream || '',
            track: track || '',
            date: date || '',
            subject: subject.join('\u001f'),
          };
        });
      return { ok: true, isRepo: true, root, branches };
    }

    const name = String(args.name ?? '').trim();
    if (name === '') return { ok: false, isRepo: true, root, error: `${action} needs a branch name` };

    if (action === 'create') {
      const startPoint = String(args.startPoint ?? '').trim();
      const result = await run(['switch', '-c', name, ...(startPoint ? [startPoint] : [])], { cwd: root, signal });
      if (!result.ok) return { ok: false, isRepo: true, root, error: describeFailure(result, 'git switch -c failed') };
      return { ok: true, isRepo: true, root, action, name, startPoint, summary: result.stderr.trim() };
    }

    if (action === 'switch') {
      const result = await run(['switch', name], { cwd: root, signal });
      if (!result.ok) return { ok: false, isRepo: true, root, error: describeFailure(result, 'git switch failed') };
      return { ok: true, isRepo: true, root, action, name, summary: result.stderr.trim() };
    }

    if (action === 'delete') {
      const result = await run(['branch', args.force ? '-D' : '-d', name], { cwd: root, signal });
      if (!result.ok) return { ok: false, isRepo: true, root, error: describeFailure(result, 'git branch -d failed') };
      return { ok: true, isRepo: true, root, action, name, summary: result.stdout.trim() };
    }

    return { ok: false, isRepo: true, root, error: `unknown action "${action}"; expected list, create, switch, or delete` };
  }

  /**
   * Gather everything a commit-message model needs about the pending change.
   * @param args - `cwd`, `includeUnstaged`, `maxPatchBytes`, and `signal`.
   */
  async function changeBundle(args = {}) {
    const { cwd, signal } = args;
    const state = await status({ cwd, signal });
    if (!state.ok) return { ok: false, error: state.error ?? 'git status failed' };
    if (!state.isRepo) {
      return { ok: false, isRepo: false, error: `not a git repository: ${state.reason}` };
    }
    const root = state.root;
    const cap = Number.isInteger(args.maxPatchBytes) && args.maxPatchBytes > 0 ? args.maxPatchBytes : settings.maxPromptBytes;

    const staged = await diff({ cwd: root, scope: 'staged', maxBytes: cap, signal });
    const unstaged =
      args.includeUnstaged === false ? null : await diff({ cwd: root, scope: 'unstaged', maxBytes: cap, signal });
    const history = await log({ cwd: root, limit: 15, signal });
    const hasWork = state.staged.length > 0 || state.unstaged.length > 0 || state.untracked.length > 0;
    if (!hasWork) {
      return { ok: false, isRepo: true, root, error: 'there is nothing to describe: the working tree is clean' };
    }
    return {
      ok: true,
      isRepo: true,
      root,
      branch: state.branch,
      initial: Boolean(state.initial),
      commitCount: history.commits.length,
      recentCommits: history.commits.map((entry) => entry.subject).filter(Boolean),
      staged: {
        files: staged.files ?? [],
        patch: staged.patch ?? '',
        truncated: Boolean(staged.truncated),
        count: state.staged.length,
      },
      unstaged: unstaged
        ? {
            files: unstaged.files ?? [],
            patch: unstaged.patch ?? '',
            truncated: Boolean(unstaged.truncated),
            count: state.unstaged.length,
          }
        : null,
      untracked: state.untracked.slice(0, 20).map((path) => ({ path, preview: previewUntracked(root, path) })),
      untrackedTotal: state.untracked.length,
    };
  }

  /** Read `git diff --numstat` output as path → line counts. */
  function parseNumstat(text) {
    const counts = new Map();
    for (const line of String(text ?? '').split('\n')) {
      if (line.trim() === '') continue;
      const [added, deleted, ...rest] = line.split('\t');
      const path = rest.join('\t');
      if (path === '') continue;
      // A binary file reports "-" for both counts.
      counts.set(path, {
        additions: added === '-' ? null : Number(added),
        deletions: deleted === '-' ? null : Number(deleted),
      });
    }
    return counts;
  }

  /** Count the lines of one small text file, or null when it is not one. */
  function countLines(root, path) {
    try {
      const abs = resolve(root, path);
      if (!isInside(root, abs)) return null;
      const info = statSync(abs);
      if (!info.isFile() || info.size > 512 * 1024) return null;
      const buffer = readFileSync(abs);
      if (buffer.subarray(0, 8000).includes(0)) return null;
      const lines = buffer.toString('utf8').split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      return lines.length;
    } catch {
      return null;
    }
  }

  /** Read a bounded, text-only preview of one untracked file. */
  function previewUntracked(root, path) {
    try {
      const abs = resolve(root, path);
      if (!isInside(root, abs)) return '';
      const info = statSync(abs);
      if (!info.isFile()) return '';
      if (info.size > 256 * 1024) return '(file is larger than 256 KiB; contents omitted)';
      const buffer = readFileSync(abs);
      if (buffer.subarray(0, 8000).includes(0)) return '(binary file; contents omitted)';
      const text = buffer.toString('utf8');
      return text.length > 4000 ? `${text.slice(0, 4000)}\n… (truncated)` : text;
    } catch {
      return '';
    }
  }

  /**
   * Render a file git does not track yet as an all-added patch.
   *
   * `git diff` reports nothing for an untracked path, so a review surface would
   * show an empty pane for exactly the files a user most wants to read before
   * staging them.
   * @param args - `cwd` and the repository-relative `path`.
   */
  async function viewUntracked({ cwd, path, signal } = {}) {
    const found = await probe({ cwd, signal });
    if (!found.isRepo) return { ok: false, isRepo: false, error: `not a git repository: ${found.reason}` };
    const target = normalizePaths(found.root, [path])[0];
    if (!target) return { ok: false, isRepo: true, error: 'a path is required' };
    const escape = assertContained(found.root, [target]);
    if (escape) return { ok: false, isRepo: true, error: escape };
    const text = previewUntracked(found.root, target);
    if (text === '') return { ok: false, isRepo: true, root: found.root, error: `cannot preview ${target}` };
    const lines = text.split('\n');
    const body = lines.map((line) => `+${line}`).join('\n');
    return {
      ok: true,
      isRepo: true,
      root: found.root,
      scope: 'untracked',
      // A well-formed new-file patch, so the row parser numbers it 1..N like any
      // other addition instead of tripping over a synthetic header.
      patch: `diff --git a/${target} b/${target}\nnew file mode 100644\n--- /dev/null\n+++ b/${target}\n@@ -0,0 +1,${lines.length} @@\n${body}`,
      truncated: text.includes('… (truncated)'),
      files: [{ path: target, additions: text.split('\n').length, deletions: 0 }],
    };
  }

  /**
   * Move the branch back to a commit.
   *
   * With no `target` this undoes the most recent commit; with one it rewinds to
   * that revision. `soft` keeps the discarded changes staged, `mixed` keeps them
   * in the working tree unstaged, and `hard` throws them away. Rewinding past a
   * commit that is already on the upstream rewrites published history, so the
   * result says so and callers are expected to confirm before choosing that.
   *
   * @param args - `cwd`, `mode` (`soft` | `mixed` | `hard`), and optional `target`.
   */
  async function resetLastCommit({ cwd, signal, mode = 'mixed', target } = {}) {
    const found = await probe({ cwd, signal });
    if (!found.isRepo) {
      return { ok: false, isRepo: false, cwd: found.cwd, error: `not a git repository: ${found.reason}` };
    }
    const root = found.root;
    const chosen = mode === 'soft' || mode === 'hard' ? mode : 'mixed';

    const head = await run(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: root, signal });
    if (!head.ok) {
      return { ok: false, isRepo: true, root, error: 'the repository has no commit to undo' };
    }

    // Which revision to rewind to, and how much that discards — both reported,
    // so a caller can say exactly what it is about to do.
    const requested = String(target ?? '').trim();
    const revision = requested === '' ? 'HEAD~1' : requested;
    if (requested !== '') {
      const reachable = await run(['rev-parse', '--verify', '--quiet', `${requested}^{commit}`], { cwd: root, signal });
      if (!reachable.ok) return { ok: false, isRepo: true, root, error: `no commit matches ${requested}` };
    }

    const described = await run(['log', '-1', '--pretty=format:%h%x1f%s'], { cwd: root, signal });
    const [hash, ...rest] = described.stdout.split('\u001f');
    const undone = { hash, subject: rest.join('\u001f') };
    const dropped = await run(['rev-list', '--count', `${revision}..HEAD`], { cwd: root, signal });

    // Is this commit already published? Counting commits the upstream lacks
    // answers it without needing the remote to be reachable.
    let published = false;
    const upstream = await run(['rev-parse', '--verify', '--quiet', '@{upstream}'], { cwd: root, signal });
    if (upstream.ok) {
      const ahead = await run(['rev-list', '--count', `${upstream.stdout.trim()}..HEAD`], { cwd: root, signal });
      published = ahead.ok && Number(ahead.stdout.trim()) === 0;
    }

    const parent = await run(['rev-parse', '--verify', '--quiet', revision], { cwd: root, signal });
    if (!parent.ok && requested === '') {
      // The root commit has no parent to reset to. Dropping the branch ref is
      // the only faithful equivalent, and it can only preserve the work tree.
      if (chosen !== 'soft') {
        return {
          ok: false,
          isRepo: true,
          root,
          error: `"${hash}" is the first commit, so only mode "soft" can undo it`,
          undone,
          published,
        };
      }
      const dropped = await run(['update-ref', '-d', 'HEAD'], { cwd: root, signal });
      if (!dropped.ok) {
        return { ok: false, isRepo: true, root, error: describeFailure(dropped, 'could not undo the first commit') };
      }
      return { ok: true, isRepo: true, root, mode: chosen, undone, published, firstCommit: true };
    }

    const flag = chosen === 'soft' ? '--soft' : chosen === 'hard' ? '--hard' : '--mixed';
    const result = await run(['reset', flag, revision], { cwd: root, signal });
    if (!result.ok) {
      return { ok: false, isRepo: true, root, error: describeFailure(result, 'git reset failed'), undone, published };
    }
    const state = await status({ cwd: root, signal });
    return {
      ok: true,
      isRepo: true,
      root,
      mode: chosen,
      target: revision,
      dropped: dropped.ok ? Number(dropped.stdout.trim()) : null,
      undone,
      published,
      staged: state.staged?.length ?? 0,
      unstaged: state.unstaged?.length ?? 0,
      untracked: state.untracked?.length ?? 0,
    };
  }

  /**
   * Report which `.gitignore` groups apply here and what is already covered.
   * @param args - `cwd`.
   */
  async function gitignorePlan({ cwd, signal } = {}) {
    const found = await probe({ cwd, signal });
    // A plan is also useful before the repository exists, so a plain directory
    // is answered from the directory itself rather than refused.
    const root = found.isRepo ? found.root : cwd;
    if (typeof root !== 'string' || root === '') {
      return { ok: false, error: 'no directory to inspect' };
    }
    let files = [];
    try {
      files = readdirSync(root);
    } catch {
      return { ok: false, root, error: `cannot read ${root}` };
    }
    const path = join(root, '.gitignore');
    let current = '';
    try {
      if (existsSync(path)) current = readFileSync(path, 'utf8');
    } catch {
      current = '';
    }
    const present = new Set(
      current
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('#')),
    );
    const groups = GITIGNORE_GROUPS.map((group) => {
      const detected = group.markers.some((marker) =>
        marker.startsWith('*') ? files.some((file) => file.endsWith(marker.slice(1))) : files.includes(marker),
      );
      const missing = group.entries.filter((entry) => !present.has(entry));
      return {
        id: group.id,
        label: group.label,
        detected,
        entries: group.entries,
        missing: missing.length,
      };
    });
    const anyDetected = groups.some((group) => group.detected);
    return {
      ok: true,
      root,
      exists: current !== '',
      current,
      groups,
      // Detected languages plus the groups every repository wants; a repository
      // that resembles nothing still gets the safe baseline.
      suggested: groups
        .filter((group) => (anyDetected ? group.detected : GITIGNORE_FALLBACK_GROUPS.includes(group.id)))
        .map((group) => group.id),
    };
  }

  /**
   * Merge entries into `.gitignore`, adding only lines that are not there yet.
   * @param args - `cwd` and the list of `entries`.
   */
  /**
   * Describe what a repository is made of, for a model that has to decide what
   * belongs in `.gitignore`.
   *
   * Deliberately shallow and bounded: the point is to recognise the ecosystem
   * (a manifest), the layout (top-level entries), and the artefacts (a sample of
   * paths, including ignored ones so existing build output is visible), not to
   * hand over the source tree.
   *
   * @param args - `cwd` and how many paths to sample.
   */
  async function projectShape({ cwd, signal, limit = 400 } = {}) {
    const found = await probe({ cwd, signal });
    const root = found.isRepo ? found.root : cwd;
    if (typeof root !== 'string' || root === '') return { ok: false, error: 'no directory to inspect' };
    let top = [];
    try {
      top = readdirSync(root).filter((name) => name !== '.git').sort();
    } catch {
      return { ok: false, root, error: `cannot read ${root}` };
    }
    // Tracked, untracked, and ignored alike: an artefact that is already ignored
    // is exactly the evidence that its pattern belongs in the file.
    const listed = await run(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, signal });
    const files = listed.ok
      ? listed.stdout.split('\0').filter(Boolean).slice(0, limit)
      : [];
    const manifests = {};
    for (const name of ['package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod', 'Gemfile', 'pom.xml', 'build.gradle', 'composer.json', 'Makefile', 'CMakeLists.txt', 'Dockerfile']) {
      const candidate = resolve(root, name);
      if (!isInside(root, candidate) || !existsSync(candidate)) continue;
      try {
        const info = statSync(candidate);
        if (!info.isFile() || info.size > 8192) {
          manifests[name] = '(present, not read)';
          continue;
        }
        manifests[name] = readFileSync(candidate, 'utf8');
      } catch {
        manifests[name] = '(present, not read)';
      }
    }
    return {
      ok: true,
      root,
      isRepo: found.isRepo,
      top,
      files,
      truncated: files.length >= limit,
      manifests,
    };
  }

  async function writeGitignore({ cwd, signal, entries } = {}) {
    const found = await probe({ cwd, signal });
    const root = found.isRepo ? found.root : cwd;
    if (typeof root !== 'string' || root === '') return { ok: false, error: 'no directory to write into' };
    const wanted = Array.isArray(entries) ? entries.filter((entry) => typeof entry === 'string' && entry.trim() !== '') : [];
    if (wanted.length === 0) return { ok: false, error: 'no entries were selected' };
    void signal;
    const path = join(root, '.gitignore');
    let before = '';
    try {
      if (existsSync(path)) before = readFileSync(path, 'utf8');
    } catch {
      before = '';
    }
    const present = new Set(
      before
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('#')),
    );
    const added = wanted.filter((entry) => !present.has(entry));
    if (added.length === 0) {
      return { ok: true, root, added: [], unchanged: true };
    }
    const head = before.trim() === '' ? '' : `${before.replace(/\s*$/, '')}\n\n`;
    const body = `${added.join('\n')}\n`;
    try {
      writeFileSync(path, `${head}${body}`, 'utf8');
    } catch (error) {
      return { ok: false, root, error: `cannot write ${path}: ${error?.message ?? error}` };
    }
    return { ok: true, root, added, unchanged: false };
  }

  return {
    settings,
    run,
    probe,
    hasHead,
    status,
    diff,
    stage,
    commit,
    log,
    init,
    config: configCommand,
    sync,
    branch,
    merge,
    stash,
    tag,
    revert,
    cherryPick,
    rebase,
    changeBundle,
    viewUntracked,
    history,
    commitDetail,
    gitignoreGroups: GITIGNORE_GROUPS,
    resetLastCommit,
    gitignorePlan,
    writeGitignore,
    projectShape,
    identity,
    normalizePaths,
    isInside,
    /** Exposed so tests and the tool layer share one path-safety check. */
    pathSeparator: sep,
  };
}
