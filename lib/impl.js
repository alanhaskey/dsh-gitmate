/**
 * Host half: git tools for the agent.
 *
 * Every tool is a thin adapter over `git-core.js`, so the git behaviour is one
 * implementation shared by the agent tools here and by any later caller.
 * Config comes from this bundle's row in `cordis.patch.yml`; missing keys fall
 * back to the defaults in that file.
 *
 * This module is loaded by `plugin.js`, which may address it with a `?rev=`
 * query. Siblings are imported under the same query so one generation of the
 * plugin is never assembled from two different generations of its own files.
 *
 * @module dsh-gitmate/impl
 */

import { resolve } from 'node:path';

/** The `?rev=` value the entry point loaded this module with, if any. */
const REVISION = new URL(import.meta.url).searchParams.get('rev') ?? '';
const SUFFIX = REVISION === '' ? '' : `?rev=${REVISION}`;

const { createGitCore } = await import(`./git-core.js${SUFFIX}`);
const { generateCommitMessage, explainFileChange, resolveRoute, suggestIgnorePatterns } = await import(
  `./messages.js${SUFFIX}`
);
const { registerGitPanel } = await import(`./rpc.js${SUFFIX}`);
const { createHostText } = await import(`./text.js${SUFFIX}`);

/** Shared `cwd` parameter description. */
const CWD_PARAM = {
  type: 'string',
  description:
    'Directory inside the repository. Defaults to the session workspace; a relative value resolves against it.',
};

/** Shared result schema for operations that report one outcome. */
const OUTCOME_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean', description: 'Whether the operation succeeded.' },
    root: { type: 'string', description: 'Absolute path of the repository root.' },
    error: { type: 'string', description: 'Why the operation failed, when ok is false.' },
  },
  required: ['ok'],
};

/** Wrap a text renderer into the tool output contract. */
function textOutput(schema, render) {
  return {
    schema,
    render(_args, value) {
      return [{ type: 'text', text: render(value) }];
    },
  };
}

/** `name (status)` for one status entry. */
const entryText = (entry) => `${entry.path} (${entry.status})`;

/** Render `git status` output. */
function renderStatus(value) {
  if (!value?.isRepo) {
    return `not a git repository: ${value?.reason ?? 'unknown'}\n${value?.hint ?? ''}`.trim();
  }
  const lines = [];
  lines.push(
    value.detached
      ? `detached HEAD at ${value.head || '(unknown)'}`
      : `on branch ${value.branch || '(unborn)'}${value.initial ? ' (no commits yet)' : ''}`,
  );
  if (value.upstream) {
    const divergence = [value.ahead ? `ahead ${value.ahead}` : '', value.behind ? `behind ${value.behind}` : '']
      .filter(Boolean)
      .join(', ');
    lines.push(`upstream ${value.upstream}${divergence ? ` (${divergence})` : ' (up to date)'}`);
  } else if (!value.detached) {
    lines.push('no upstream configured');
  }
  if (value.clean) lines.push('working tree clean');
  const sections = [
    ['staged', value.staged],
    ['modified, not staged', value.unstaged],
    ['untracked', (value.untracked ?? []).map((path) => ({ path, status: 'new' }))],
    ['conflicted', value.conflicted],
  ];
  for (const [label, entries] of sections) {
    if (!entries || entries.length === 0) continue;
    lines.push('', `${label} (${entries.length}):`);
    for (const entry of entries.slice(0, 60)) {
      lines.push(`  ${entryText(entry)}${entry.from ? ` ← ${entry.from}` : ''}`);
    }
    if (entries.length > 60) lines.push(`  … ${entries.length - 60} more`);
  }
  return lines.join('\n');
}

/** Render one diff result. */
function renderDiff(value) {
  if (value?.isRepo === false) return `not a git repository: ${value.reason ?? 'unknown'}`;
  if (value?.ok === false) return `error: ${value.error}`;
  const header = [`scope ${value.scope}`, `repository ${value.root}`];
  if (value.note) header.push(`note: ${value.note}`);
  if (value.files?.length) {
    header.push('files:');
    for (const file of value.files) {
      header.push(`  ${file.path} (+${file.additions ?? '?'} -${file.deletions ?? '?'})`);
    }
  }
  if (value.files?.length === 0) header.push('no tracked changes in this scope');
  const body = value.patch?.trim() ? value.patch : '(empty patch)';
  const tail = value.truncated ? `\n… patch truncated, ${value.omittedBytes} bytes omitted` : '';
  return `${header.join('\n')}\n\n${body}${tail}`;
}

/** Render a staging result. */
function renderStage(value) {
  if (value?.ok === false) return `error: ${value.error}`;
  const paths = (value.paths ?? []).join(', ');
  if (value.action === 'add') return `staged: ${paths}`;
  if (value.action === 'unstage') return `unstaged: ${paths}`;
  const removed = value.removed ?? [];
  if (removed.length > 0) {
    // Deleting a file is worth naming rather than folding into "discarded".
    return [`discarded working-tree changes for: ${paths}`, `deleted (were untracked): ${removed.join(', ')}`].join(
      '\n',
    );
  }
  if ((value.untracked ?? 0) > 0 && value.keepUntracked === true) {
    return `discarded working-tree changes for: ${paths}; kept ${value.untracked} untracked file(s)`;
  }
  return `discarded working-tree changes for: ${paths}`;
}

/** Render a commit result. */
function renderCommit(value) {
  if (value?.ok === false) return `error: ${value.error}`;
  if (value.dryRun) {
    return [
      `dry run: nothing was committed (${value.stagedCount} staged file(s))`,
      value.diffstat ? `diffstat: ${value.diffstat}` : '',
      '',
      'message:',
      value.message,
    ]
      .filter((line) => line !== '')
      .join('\n');
  }
  const lines = [
    `committed ${value.shortHash} on ${value.branch}${value.amend ? ' (amend)' : ''}`,
    value.generated ? 'message: generated from the staged diff' : 'message: supplied by the caller',
    '',
    value.message,
  ];
  if (value.files?.length) {
    lines.push('', `files (${value.files.length}):`);
    for (const file of value.files.slice(0, 60)) lines.push(`  ${file.path}`);
  }
  if (value.push) {
    lines.push('', value.push.ok ? `pushed: ${value.push.summary ?? 'ok'}` : `push failed: ${value.push.error}`);
  }
  return lines.join('\n');
}

/** Render a log result. */
function renderLog(value) {
  if (value?.ok === false) return `error: ${value.error}`;
  if (!value.commits?.length) return value.note ? `no commits: ${value.note}` : 'no commits';
  return value.commits.map((entry) => `${entry.hash}  ${entry.date?.slice(0, 10) ?? ''}  ${entry.subject}`).join('\n');
}

/** Render an init result. */
function renderInit(value) {
  if (value?.ok === false) return `error: ${value.error}`;
  const lines = [
    value.created ? `initialized empty repository at ${value.root}` : `already a git repository at ${value.root}`,
    `branch ${value.branch}`,
  ];
  if (value.gitignoreWritten) lines.push('wrote .gitignore');
  if (!value.identityConfigured) {
    lines.push('no commit identity configured; set user.name and user.email with git_config before committing');
  }
  if (value.initialCommit) lines.push(`first commit ${value.initialCommit.slice(0, 7)}`);
  if (value.initialCommitError) lines.push(`first commit skipped: ${value.initialCommitError}`);
  return lines.join('\n');
}

/** Render a config result. */
function renderConfig(value) {
  if (value?.ok === false) return `error: ${value.error}`;
  if (value.entries) {
    if (value.entries.length === 0) return `no ${value.scope} configuration set`;
    return value.entries.map((entry) => `${entry.key}=${entry.value}`).join('\n');
  }
  if (value.written) return `set ${value.scope} ${value.key}=${value.value}`;
  if (value.removed !== undefined) return value.removed ? `unset ${value.scope} ${value.key}` : `${value.key} was not set`;
  return value.found ? `${value.key}=${value.value}` : `${value.key} is not set in ${value.scope} configuration`;
}

/** Render a sync result. */
function renderSync(value) {
  if (value?.ok === false) {
    return [`error: ${value.error}`, value.summary ? '' : '', value.summary ?? ''].filter((l) => l !== '').join('\n');
  }
  if (value.action === 'fetch') return `fetched from ${value.remote}`;
  if (value.action === 'push') {
    return `pushed ${value.branch} to ${value.remote}${value.setUpstream ? ' (upstream set)' : ''}\n${value.summary ?? ''}`.trim();
  }
  return `pulled from ${value.remote}\n${value.summary ?? ''}`.trim();
}

/** Render an undo-the-last-commit result. */
function renderReset(value) {
  if (value?.ok === false) return `error: ${value.error}`;
  const lines = [
    value.firstCommit
      ? `undid the first commit ${value.undone?.hash ?? ''} (its changes are staged)`
      : `undid ${value.undone?.hash ?? ''} ${value.undone?.subject ?? ''} with --${value.mode}`,
  ];
  if (typeof value.staged === 'number') {
    lines.push(`working tree now: ${value.staged} staged, ${value.unstaged} modified, ${value.untracked} untracked`);
  }
  if (value.published) {
    lines.push(
      'warning: that commit was already on the upstream, so undoing it rewrites history others may have; pushing will need --force-with-lease',
    );
  }
  return lines.join('\n');
}

/** Render a branch result. */
/** The shape shared by the operations that add, undo, or replay commits. */
const REWRITE_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    error: { type: 'string' },
    action: { type: 'string' },
    hash: { type: 'string' },
    conflicted: { type: 'boolean' },
    conflicts: { type: 'array', items: { type: 'string' } },
    staged: { type: 'number' },
  },
  additionalProperties: false,
};

/**
 * Render one of those results.
 *
 * A conflict is the outcome a caller most needs explained, so it leads with the
 * files and the next step rather than a bare error.
 * @param verb - how to describe the successful outcome.
 */
function renderRewrite(verb) {
  return (value) => {
    if (value?.ok === false && value.conflicted !== true) return `error: ${value.error}`;
    if (value?.conflicted === true) {
      return [
        `error: ${value.error}`,
        ...(value.conflicts ?? []).map((path) => `  ${path}`),
        'resolve each file, stage it, and continue — or abort and put things back.',
      ].join('\n');
    }
    const where = value.hash ? ` (now at ${value.hash})` : '';
    if (value.action === 'rebase' && value.aborted === true) return 'aborted the rebase; the branch is back where it was';
    if (value.staged !== undefined && value.hash === '') return `staged the change without committing it (${value.staged} file(s))`;
    return `${verb}${where}${value.summary ? `\n${value.summary}` : ''}`;
  };
}

/** Render a tag result. */
function renderTag(value) {
  if (value?.ok === false) return `error: ${value.error}`;
  if (value.action === 'list') {
    const tags = value.tags ?? [];
    if (tags.length === 0) return 'no tags yet';
    return tags.map((entry) => `${entry.name}  ${entry.hash}  ${entry.date}  ${entry.subject}`.trimEnd()).join('\n');
  }
  if (value.action === 'create') return `created ${value.annotated ? 'annotated ' : ''}tag ${value.name} at ${value.revision}`;
  if (value.action === 'delete') return `deleted tag ${value.name}`;
  return `pushed ${value.name} to ${value.remote}`;
}

/** Render a stash result. */
function renderStash(value) {
  if (value?.ok === false) return `error: ${value.error}`;
  const list = (value.stashes ?? []).map((entry) => `${entry.ref}: ${entry.subject}${entry.when ? `  (${entry.when})` : ''}`);
  if (value.action === 'list') {
    return list.length === 0 ? 'the stash is empty' : list.join('\n');
  }
  if (value.action === 'push') {
    if (value.nothingToStash) return 'nothing to stash; the working tree has no changes';
    return [`stashed the working tree${value.stash ? ` as ${value.stash.ref}` : ''}`, ...list].join('\n');
  }
  const verb = value.action === 'drop' ? 'dropped' : value.action === 'pop' ? 'restored and dropped' : 'restored';
  return [
    `${verb} ${value.ref}${value.kept ? ' (the stash was kept: the restore conflicted)' : ''}`,
    ...list,
  ].join('\n');
}

function renderBranch(value) {  if (value?.ok === false) return `error: ${value.error}`;
  if (value.branches) {
    if (value.branches.length === 0) return 'no local branches yet';
    return value.branches
      .map(
        (entry) =>
          `${entry.current ? '*' : ' '} ${entry.name}${entry.upstream ? ` → ${entry.upstream}${entry.track}` : ''}  ${entry.subject ?? ''}`.trimEnd(),
      )
      .join('\n');
  }
  if (value.action === 'create') return `created and switched to ${value.name}${value.startPoint ? ` from ${value.startPoint}` : ''}`;
  if (value.action === 'switch') return `switched to ${value.name}`;
  if (value.action === 'merge') {
    if (value.conflicted) {
      return [
        `merging ${value.branch} stopped with conflicts in ${value.conflicts.length} file(s):`,
        ...value.conflicts.map((path) => `  ${path}`),
        'resolve each file, stage it, and commit; or run git_branch with action "abort".',
      ].join('\n');
    }
    if (value.upToDate) return `${value.branch} is already contained in ${value.into}; nothing to merge`;
    return `merged ${value.branch} into ${value.into} (${value.fastForward ? 'fast-forward' : 'merge commit'}${value.head ? `, now at ${value.head}` : ''})`;
  }
  if (value.action === 'abort') return `aborted the merge; back on ${value.branch}`;
  return `deleted branch ${value.name}`;
}

/**
 * Build the git operations both callers share: the agent tools registered below
 * and the panel channel in `rpc.js`. One implementation, two entry points.
 * @param ctx - the plugin context.
 * @param userConfig - this bundle's row config.
 * @returns the config, git core, and the directory/message plumbing.
 */
export function createOperations(ctx, userConfig) {
  const config = { ...(userConfig ?? {}) };

  /** The live session store, when the profile composes one. */
  function sessions() {
    const service = ctx.get('sessions');
    return service && typeof service.get === 'function' ? service : undefined;
  }

  /** Look up a live session by id. */
  function sessionById(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined;
    try {
      return sessions()?.get(sessionId);
    } catch {
      return undefined;
    }
  }

  /** Look up the live session behind an acting Agent. */
  function sessionFor(agent) {
    return agent?.id ? sessionById(agent.id) : undefined;
  }

  /** The workspace root a session was created in, when it recorded one. */
  function cwdForSession(sessionId) {
    const cwd = sessionById(sessionId)?.header?.cwd;
    return typeof cwd === 'string' && cwd !== '' ? cwd : undefined;
  }

  /** Resolve the directory a call should run in. */
  function resolveCwd(rawCwd, agent) {
    const workspace = sessionFor(agent)?.header?.cwd;
    if (typeof rawCwd === 'string' && rawCwd.trim() !== '') {
      const value = rawCwd.trim();
      if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) return value;
      return resolve(workspace ?? process.cwd(), value);
    }
    return workspace;
  }

  /** Run one command through the Harness shell service. */
  async function exec(spec) {
    const resolved = ctx.shell.resolve({
      command: spec.command,
      ...(spec.cwd ? { workdir: spec.cwd } : {}),
      timeoutMs: spec.timeoutMs,
      onExpiry: 'kill',
      stdoutMaxBytes: spec.stdoutMaxBytes,
      ...(spec.stdin !== undefined ? { stdin: spec.stdin } : {}),
      ...(spec.signal ? { signal: spec.signal } : {}),
    });
    const execution = await ctx.shell.execute(resolved);
    const result = await execution.result();
    return {
      code: result.exitCode ?? (result.timedOut ? 124 : 1),
      stdout: result.stdout?.text ?? '',
      stderr: result.stderr?.text ?? '',
      timedOut: Boolean(result.timedOut),
      aborted: Boolean(result.aborted),
      denied: Boolean(result.sandbox?.denied),
    };
  }

  const core = createGitCore({ exec, config });

  /**
   * Text for the messages a person reads.
   *
   * Only the panel's answers are translated: tool descriptions and tool results
   * are read by a model, and they stay in the language models handle best.
   */
  const text = createHostText(config.messageLanguage);

  /**
   * Produce a commit message for the pending change in `cwd`.
   *
   * @param draft - what the author already typed. An empty draft asks for a
   * message; a non-empty one asks for that draft to be completed and polished.
   */
  async function generateFor(cwd, signal, agent, draft = '') {
    const bundle = await core.changeBundle({ cwd, signal, maxPatchBytes: config.maxPromptBytes });
    if (!bundle.ok) return { ok: false, error: bundle.error };
    const route = resolveRoute({
      config,
      defaultModel: ctx.get('agentDefaultModel'),
      session: sessionFor(agent),
    });
    return generateCommitMessage({
      llm: ctx.get('llm'),
      route,
      bundle,
      draft,
      style: config.messageStyle ?? 'conventional',
      language: config.messageLanguage ?? 'auto',
      template: config.messageTemplate,
      signal,
    });
  }

  /** Explain one file's change in plain language, for the panel's reviewer view. */
  async function explainFor(cwd, { path, patch, signal }) {
    const route = resolveRoute({ config, defaultModel: ctx.get('agentDefaultModel') });
    return explainFileChange({
      llm: ctx.get('llm'),
      route,
      path,
      patch,
      language: config.messageLanguage ?? 'auto',
      signal,
    });
  }

  /**
   * The plugin's own configuration row and the editor that persists it.
   *
   * Settings live in this row rather than in plugin-private storage so they
   * survive upgrades, stay visible in `cordis.patch.yml`, and are editable from
   * the Plugins page too.
   */
  const entry = ctx.fiber?.entry;
  const configEditor = ctx.get('configEditor');

  /** Values the panel may read. */
  function readSettings() {
    return {
      values: {
        messageLanguage: config.messageLanguage ?? 'auto',
        messageStyle: config.messageStyle ?? 'conventional',
        messageTemplate: typeof config.messageTemplate === 'string' ? config.messageTemplate : '',
        signoff: config.signoff === true,
        defaultBranch: config.defaultBranch ?? 'main',
      },
      entryId: entry?.options?.id ?? '',
      writable: entry !== undefined && typeof configEditor?.edit === 'function',
    };
  }

  /** Keep only recognized keys, with the types the plugin expects. */
  function sanitizeSettings(changes) {
    const next = {};
    if (changes === null || typeof changes !== 'object') return next;
    if (changes.messageLanguage === 'auto' || changes.messageLanguage === 'en' || changes.messageLanguage === 'zh') {
      next.messageLanguage = changes.messageLanguage;
    }
    if (changes.messageStyle === 'conventional' || changes.messageStyle === 'plain') {
      next.messageStyle = changes.messageStyle;
    }
    if (typeof changes.messageTemplate === 'string') next.messageTemplate = changes.messageTemplate;
    if (typeof changes.signoff === 'boolean') next.signoff = changes.signoff;
    if (changes.defaultBranch === 'main' || changes.defaultBranch === 'master') {
      next.defaultBranch = changes.defaultBranch;
    }
    return next;
  }

  /** Persist the panel's changes into this plugin's config row. */
  async function writeSettings(changes) {
    const patch = sanitizeSettings(changes);
    if (Object.keys(patch).length === 0) {
      return { ok: false, error: 'no recognized setting was supplied', ...readSettings() };
    }
    if (entry === undefined || typeof configEditor?.edit !== 'function') {
      return {
        ok: false,
        error: 'this deployment exposes no configuration editor, so settings cannot be saved from here',
        ...readSettings(),
      };
    }
    // The row's config is replaced wholesale, so start from the resolved config
    // and restate every key the plugin needs.
    const candidate = { ...config, ...patch };
    try {
      await configEditor.edit(entry, () => candidate);
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error), ...readSettings() };
    }
    // The write reconciles the profile, so this plugin is re-applied with the
    // saved values; the panel re-reads them once the route is back.
    return { ok: true, saved: patch, reloading: true };
  }

  /**
   * Work out which ignore patterns this repository needs, without asking the user
   * to pick from a list of ecosystems.
   *
   * The model reads a shallow description of the project — manifests, top-level
   * entries, a sample of paths — and proposes patterns. When no model is
   * reachable the static group table answers instead, so both buttons still do
   * something useful offline; `source` says which happened.
   *
   * @param args - `cwd` and `mode`: `init` for a file that does not exist yet,
   * `optimize` for additions to one that does.
   */
  async function suggestGitignore({ cwd, signal, mode = 'init' } = {}) {
    const plan = await core.gitignorePlan({ cwd, signal });
    if (plan.ok !== true) return plan;
    const shape = await core.projectShape({ cwd: plan.root, signal });
    if (shape.ok !== true) return shape;
    const route = resolveRoute({ config, defaultModel: ctx.get('agentDefaultModel') });
    const answer = await suggestIgnorePatterns({
      llm: ctx.get('llm'),
      route,
      shape,
      existing: plan.current,
      mode,
      signal,
    });
    const present = new Set(
      plan.current
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('#')),
    );
    const proposed = answer.ok
      ? answer.patterns
      : gitignoreEntriesFor(plan.suggested.length > 0 ? plan.suggested : plan.groups.map((group) => group.id));
    if (proposed.length === 0) {
      return {
        ok: true,
        root: plan.root,
        exists: plan.exists,
        source: answer.ok ? 'model' : 'heuristic',
        patterns: [],
        added: [],
        ...(answer.ok ? {} : { note: answer.error }),
      };
    }
    return {
      ok: true,
      root: plan.root,
      exists: plan.exists,
      source: answer.ok ? 'model' : 'heuristic',
      patterns: proposed,
      // What a write would actually change; an optimize pass usually lands here.
      added: proposed.filter((entry) => !present.has(entry)),
      ...(answer.ok ? {} : { note: answer.error }),
    };
  }

  /** Expand `.gitignore` group ids into the lines they contribute. */
  function gitignoreEntriesFor(groups) {
    if (!Array.isArray(groups) || groups.length === 0) return [];
    const wanted = new Set(groups.map((group) => String(group)));
    const seen = new Set();
    const lines = [];
    for (const group of core.gitignoreGroups) {
      if (!wanted.has(group.id)) continue;
      for (const entry of group.entries) {
        if (seen.has(entry)) continue;
        seen.add(entry);
        lines.push(entry);
      }
    }
    return lines;
  }

  /** Bind `cwd`, `signal`, and the injected message generator for one call. */
  function scope(args, exec) {
    const cwd = resolveCwd(args?.cwd, exec?.agent);
    const signal = exec?.signal;
    return {
      cwd,
      signal,
      generateMessage: ({ cwd: target, signal: inner }) => generateFor(target ?? cwd, inner ?? signal, exec?.agent),
    };
  }

  return {
    config,
    core,
    generateFor,
    explainFor,
    readSettings,
    writeSettings,
    gitignoreEntriesFor,
    suggestGitignore,
    text,
    resolveCwd,
    sessionFor,
    sessionById,
    cwdForSession,
    scope,
  };
}

/**
 * Register the git tools and the panel channel.
 * @param ctx - the plugin context.
 * @param userConfig - this bundle's row config.
 */
export function apply(ctx, userConfig) {
  const operations = createOperations(ctx, userConfig);
  const { core, scope, gitignoreEntriesFor } = operations;

  const tools = [
    {
      name: 'git_status',
      description:
        'Inspect the git working tree: the checked-out branch, its upstream divergence, and every staged, modified, untracked, or conflicted path. Run this before committing, or to answer what changed in the repository.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { cwd: CWD_PARAM },
      },
      output: textOutput(
        {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            isRepo: { type: 'boolean', description: 'False when the directory is not inside a repository.' },
            root: { type: 'string' },
            branch: { type: 'string' },
            upstream: { type: 'string' },
            ahead: { type: 'number' },
            behind: { type: 'number' },
            clean: { type: 'boolean' },
            reason: { type: 'string' },
            hint: { type: 'string' },
          },
          required: ['ok', 'isRepo'],
        },
        renderStatus,
      ),
      isConcurrencySafe: () => true,
      presentCall: (args) => ({ card: 'generic', title: 'git status', kind: 'search', rawInput: args }),
      async execute(args, exec) {
        return core.status(scope(args, exec));
      },
    },
    {
      name: 'git_diff',
      description:
        'Read the patch for one change set, with the per-file line counts. Use it to review edits before committing, or to write a commit message yourself.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scope: {
            type: 'string',
            enum: ['all', 'staged', 'unstaged', 'last-commit', 'range'],
            description:
              'Which change set to show. "all" is everything against HEAD, "staged" is the index, "unstaged" is the work tree, "last-commit" is the previous commit\'s patch. Defaults to "all".',
          },
          paths: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Repository-relative paths to limit the patch to. Absolute paths inside the repository are accepted.',
          },
          base: { type: 'string', description: 'Range start revision. Required by scope "range".' },
          head: { type: 'string', description: 'Range end revision. Defaults to HEAD; only used by scope "range".' },
          stat: { type: 'boolean', description: 'Return the diffstat only, without hunks.' },
          nameOnly: { type: 'boolean', description: 'Return changed paths with their status only, without hunks.' },
          contextLines: { type: 'number', description: 'Lines of context around each hunk. Defaults to git\'s 3.' },
          maxBytes: {
            type: 'number',
            description: 'Byte cap for the returned patch text. Defaults to the plugin setting (80000).',
          },
          cwd: CWD_PARAM,
        },
      },
      output: textOutput(
        {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            isRepo: { type: 'boolean' },
            root: { type: 'string' },
            scope: { type: 'string' },
            patch: { type: 'string', description: 'Unified diff text, possibly truncated.' },
            truncated: { type: 'boolean' },
            omittedBytes: { type: 'number' },
            error: { type: 'string' },
            files: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  path: { type: 'string' },
                  additions: { type: 'number', description: 'Line count; null for a binary file.' },
                  deletions: { type: 'number', description: 'Line count; null for a binary file.' },
                },
                required: ['path'],
              },
            },
          },
          required: ['ok'],
        },
        renderDiff,
      ),
      isConcurrencySafe: () => true,
      presentCall: (args) => ({ card: 'generic', title: `git diff ${args?.scope ?? 'all'}`, kind: 'read', rawInput: args }),
      async execute(args, exec) {
        return core.diff({ ...scope(args, exec), ...args });
      },
    },
    {
      name: 'git_stage',
      description:
        'Change the index: stage paths, unstage them, or discard working-tree edits. "discard" deletes uncommitted work permanently and therefore requires an explicit paths list. Discarding a path that is not tracked deletes the file, since there is no earlier version to restore; pass keepUntracked to leave those in place.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['add', 'unstage', 'discard'],
            description:
              '"add" stages paths (or every change when paths is omitted), "unstage" removes them from the index, "discard" reverts their working-tree edits.',
          },
          paths: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Repository-relative paths. Omit for "add" and "unstage" to act on the whole working tree; "discard" requires at least one path and accepts ["."].',
          },
          keepUntracked: {
            type: 'boolean',
            description:
              'With "discard", keep untracked files instead of deleting them. Defaults to false: discarding a path that is not tracked deletes the file, because there is no earlier version to restore.',
          },
          cwd: CWD_PARAM,
        },
        required: ['action'],
      },
      output: textOutput(OUTCOME_SCHEMA, renderStage),
      presentCall: (args) => ({ card: 'generic', title: `git ${args?.action ?? 'stage'}`, kind: 'edit', rawInput: args }),
      async execute(args, exec) {
        return core.stage({ ...scope(args, exec), ...args });
      },
    },
    {
      name: 'git_commit',
      description:
        'Create a commit. Omit message to have one generated from the staged diff; pass message to supply your own. Set dryRun to preview the message without committing.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          message: {
            type: 'string',
            description:
              'The commit message. Omit to generate one from the staged diff. With amend, omitting it keeps the existing message.',
          },
          all: { type: 'boolean', description: 'Stage every tracked modification before committing. Defaults to false.' },
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Repository-relative paths to stage before committing.',
          },
          amend: { type: 'boolean', description: 'Replace the previous commit instead of adding one. Defaults to false.' },
          signoff: { type: 'boolean', description: 'Append a Signed-off-by trailer. Defaults to false.' },
          noVerify: { type: 'boolean', description: 'Skip pre-commit and commit-msg hooks. Defaults to false.' },
          dryRun: {
            type: 'boolean',
            description:
              'Generate or echo the message and the diffstat, then stop without committing. Paths selected by all or paths are still staged, so the preview matches what a real commit would record.',
          },
          push: {
            type: 'boolean',
            description: 'Push the branch to its remote after a successful commit. Defaults to false.',
          },
          cwd: CWD_PARAM,
        },
      },
      output: textOutput(
        {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            root: { type: 'string' },
            hash: { type: 'string' },
            shortHash: { type: 'string' },
            branch: { type: 'string' },
            message: { type: 'string' },
            generated: { type: 'boolean', description: 'True when this plugin generated the message.' },
            dryRun: { type: 'boolean' },
            amend: { type: 'boolean' },
            diffstat: { type: 'string' },
            error: { type: 'string' },
            files: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  path: { type: 'string' },
                  additions: { type: 'number', description: 'Line count; null for a binary file.' },
                  deletions: { type: 'number', description: 'Line count; null for a binary file.' },
                },
                required: ['path'],
              },
            },
          },
          required: ['ok'],
        },
        renderCommit,
      ),
      presentCall: (args) => ({
        card: 'generic',
        title: args?.amend ? 'git commit --amend' : 'git commit',
        kind: 'edit',
        rawInput: args,
      }),
      async execute(args, exec) {
        const bound = scope(args, exec);
        const result = await core.commit({ ...bound, ...args });
        if (!result.ok || !args.push) return result;
        const pushed = await core.sync({ cwd: result.root, signal: bound.signal, action: 'push' });
        return { ...result, push: pushed };
      },
    },
    {
      name: 'git_reset',
      description:
        'Undo the most recent commit. Choose what happens to the changes it introduced, and check the result for whether that commit was already pushed.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: {
            type: 'string',
            enum: ['soft', 'mixed', 'hard'],
            description:
              '"soft" keeps the changes staged, "mixed" keeps them in the working tree unstaged, "hard" deletes them. Defaults to "mixed".',
          },
          cwd: CWD_PARAM,
        },
        required: ['mode'],
      },
      output: textOutput(
        {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            root: { type: 'string' },
            mode: { type: 'string' },
            published: { type: 'boolean', description: 'True when the undone commit was already on the upstream.' },
            firstCommit: { type: 'boolean', description: 'True when the undone commit was the repository\'s only one.' },
            staged: { type: 'number' },
            unstaged: { type: 'number' },
            untracked: { type: 'number' },
            error: { type: 'string' },
            undone: {
              type: 'object',
              additionalProperties: false,
              properties: { hash: { type: 'string' }, subject: { type: 'string' } },
              required: ['hash'],
            },
          },
          required: ['ok'],
        },
        renderReset,
      ),
      presentCall: (args) => ({ card: 'generic', title: `git reset --${args?.mode ?? 'mixed'}`, kind: 'delete', rawInput: args }),
      async execute(args, exec) {
        return core.resetLastCommit({ ...scope(args, exec), ...args });
      },
    },
    {
      name: 'git_log',
      description: 'List recent commits on the checked-out branch, newest first, with hash, author, date, and subject.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          limit: { type: 'number', description: 'How many commits to return, 1–200. Defaults to 10.' },
          path: { type: 'string', description: 'Limit history to one repository-relative path.' },
          cwd: CWD_PARAM,
        },
      },
      output: textOutput(
        {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            root: { type: 'string' },
            note: { type: 'string' },
            error: { type: 'string' },
            commits: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  hash: { type: 'string' },
                  author: { type: 'string' },
                  date: { type: 'string' },
                  subject: { type: 'string' },
                },
                required: ['hash'],
              },
            },
          },
          required: ['ok'],
        },
        renderLog,
      ),
      isConcurrencySafe: () => true,
      presentCall: (args) => ({ card: 'generic', title: 'git log', kind: 'search', rawInput: args }),
      async execute(args, exec) {
        return core.log({ ...scope(args, exec), ...args });
      },
    },
    {
      name: 'git_init',
      description:
        'Create a git repository in a directory that has none, optionally writing a .gitignore and creating the first commit.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          initialBranch: { type: 'string', description: 'Name of the first branch. Defaults to the plugin setting (main).' },
          gitignore: {
            type: 'string',
            description:
              'Literal contents for a new .gitignore. Existing files are never overwritten. Omit to write none.',
          },
          gitignoreGroups: {
            type: 'array',
            items: {
              type: 'string',
              enum: ['node', 'python', 'go', 'rust', 'java', 'dotnet', 'ruby', 'php', 'secrets', 'logs', 'editors', 'os'],
            },
            description:
              'Curated .gitignore groups to write instead of literal text, for example ["node", "secrets", "os"]. Merged with gitignore when both are given.',
          },
          initialCommitMessage: {
            type: 'string',
            description:
              'Commit every file with this message right after initializing. Omit to leave the repository empty.',
          },
          cwd: CWD_PARAM,
        },
      },
      output: textOutput(
        {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            root: { type: 'string' },
            created: { type: 'boolean', description: 'False when the directory was already a repository.' },
            branch: { type: 'string' },
            gitignoreWritten: { type: 'boolean' },
            identityConfigured: { type: 'boolean' },
            initialCommit: { type: 'string' },
            initialCommitError: { type: 'string' },
            error: { type: 'string' },
          },
          required: ['ok'],
        },
        renderInit,
      ),
      presentCall: (args) => ({ card: 'generic', title: 'git init', kind: 'edit', rawInput: args }),
      async execute(args, exec) {
        const bound = scope(args, exec);
        // Group ids expand into curated lines; literal text is appended as given,
        // and `git_init` merges both without overwriting an existing file.
        const fromGroups = gitignoreEntriesFor(args?.gitignoreGroups);
        const literal = typeof args?.gitignore === 'string' ? args.gitignore : '';
        const merged = [fromGroups.join('\n'), literal].filter((part) => part.trim() !== '').join('\n');
        return core.init({ ...bound, ...args, ...(merged === '' ? {} : { gitignore: merged }) });
      },
    },
    {
      name: 'git_config',
      description:
        'Read or write git configuration, including the author identity a commit requires. Local scope applies to this repository only; global scope changes the whole machine.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['get', 'set', 'unset', 'list'], description: 'Defaults to "get".' },
          key: {
            type: 'string',
            description: 'Dotted configuration key, such as user.name, user.email, or init.defaultBranch.',
          },
          value: { type: 'string', description: 'New value. Required by "set".' },
          scope: {
            type: 'string',
            enum: ['local', 'global', 'effective'],
            description:
              '"local" writes this repository, "global" writes the user-wide file, "effective" reads the merged result and is read-only. Defaults to "local".',
          },
          cwd: CWD_PARAM,
        },
        required: ['action'],
      },
      output: textOutput(
        {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            scope: { type: 'string' },
            key: { type: 'string' },
            value: { type: 'string' },
            found: { type: 'boolean' },
            written: { type: 'boolean' },
            removed: { type: 'boolean' },
            error: { type: 'string' },
            entries: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: { key: { type: 'string' }, value: { type: 'string' } },
                required: ['key'],
              },
            },
          },
          required: ['ok'],
        },
        renderConfig,
      ),
      presentCall: (args) => ({ card: 'generic', title: `git config ${args?.action ?? 'get'}`, kind: 'edit', rawInput: args }),
      async execute(args, exec) {
        return core.config({ ...scope(args, exec), ...args });
      },
    },
    {
      name: 'git_sync',
      description:
        'Move commits between the local branch and its remote: fetch, pull, push, or "sync" — which fetches, then fast-forwards a branch that is behind and pushes one that is ahead, and reports a diverged branch instead of merging it.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['push', 'pull', 'fetch', 'sync'] },
          remote: { type: 'string', description: 'Remote name. Defaults to origin, or the only configured remote.' },
          branch: { type: 'string', description: 'Branch to push or pull. Defaults to the checked-out branch.' },
          setUpstream: {
            type: 'boolean',
            description: 'Pass -u when pushing. Defaults to true for a branch that has no upstream yet.',
          },
          force: { type: 'boolean', description: 'Push with --force-with-lease. Defaults to false.' },
          rebase: { type: 'boolean', description: 'Rebase local commits when pulling. Defaults to false.' },
          prune: { type: 'boolean', description: 'Delete stale remote-tracking branches when fetching. Defaults to false.' },
          cwd: CWD_PARAM,
        },
        required: ['action'],
      },
      output: textOutput(OUTCOME_SCHEMA, renderSync),
      presentCall: (args) => ({ card: 'generic', title: `git ${args?.action ?? 'sync'}`, kind: 'execute', rawInput: args }),
      async execute(args, exec) {
        return core.sync({ ...scope(args, exec), ...args });
      },
    },
    {
      name: 'git_branch',
      description:
        'List local branches with their upstream tracking, or create, switch, and delete them. action "merge" merges the named branch into the checked-out one; a conflicted merge is reported with the files that need a decision, and action "abort" undoes it.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'create', 'switch', 'delete', 'merge', 'abort'],
            description:
              'Defaults to "list". "merge" merges the named branch into the checked-out one; "abort" undoes a merge that stopped with conflicts.',
          },
          name: {
            type: 'string',
            description:
              'Branch name. Required by create, switch, delete, and merge (where it names the branch to merge in).',
          },
          startPoint: { type: 'string', description: 'Revision the new branch starts at. Defaults to HEAD.' },
          force: { type: 'boolean', description: 'With delete, remove a branch even when it is not merged. Defaults to false.' },
          noFf: { type: 'boolean', description: 'With merge, always create a merge commit instead of fast-forwarding.' },
          cwd: CWD_PARAM,
        },
        required: ['action'],
      },
      output: textOutput(
        {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            error: { type: 'string' },
            branches: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  current: { type: 'boolean' },
                  name: { type: 'string' },
                  upstream: { type: 'string' },
                  track: { type: 'string' },
                  date: { type: 'string' },
                  subject: { type: 'string' },
                },
                required: ['name'],
              },
            },
          },
          required: ['ok'],
        },
        renderBranch,
      ),
      isConcurrencySafe: (args) => args?.action === 'list',
      presentCall: (args) => ({ card: 'generic', title: `git branch ${args?.action ?? 'list'}`, kind: 'edit', rawInput: args }),
      async execute(args, exec) {
        // Merging shares this entry: it is a branch operation, and a separate
        // tool would only lengthen the list a model has to read.
        if (args?.action === 'merge' || args?.action === 'abort') {
          return core.merge({ ...scope(args, exec), ...args });
        }
        return core.branch({ ...scope(args, exec), ...args });
      },
    },
    {
      name: 'git_stash',
      description:
        'Set working-tree changes aside and bring them back later: list the stashes, push the current changes onto one, or pop, apply, and drop one. Use it to switch tasks without committing half-finished work.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'push', 'pop', 'apply', 'drop'],
            description: 'Defaults to "push". "apply" keeps the stash, "pop" removes it once it lands.',
          },
          message: { type: 'string', description: 'With push, a label for the stash.' },
          index: { type: 'number', description: 'Which stash to act on, newest first. Defaults to 0 (the newest).' },
          includeUntracked: {
            type: 'boolean',
            description: 'With push, also set aside untracked files. Defaults to false.',
          },
          paths: { type: 'array', items: { type: 'string' }, description: 'With push, only stash these paths.' },
          cwd: CWD_PARAM,
        },
        required: ['action'],
      },
      output: textOutput(
        {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            error: { type: 'string' },
            action: { type: 'string' },
            ref: { type: 'string' },
            stashes: {
              type: 'array',
              items: {
                type: 'object',
                properties: { ref: { type: 'string' }, subject: { type: 'string' }, when: { type: 'string' } },
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
        renderStash,
      ),
      isConcurrencySafe: (args) => args?.action === 'list',
      presentCall: (args) => ({ card: 'generic', title: `git stash ${args?.action ?? 'push'}`, kind: 'edit', rawInput: args }),
      async execute(args, exec) {
        return core.stash({ ...scope(args, exec), ...args });
      },
    },
    {
      name: 'git_tag',
      description:
        'List tags, create one (annotated when a message is given), delete one, or push one to the remote. A tag is a name for a commit, so the panel can offer a release without anyone typing a hash.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['list', 'create', 'delete', 'push'], description: 'Defaults to "list".' },
          name: { type: 'string', description: 'Tag name. Required by create, delete, and push (unless all is set).' },
          message: { type: 'string', description: 'With create, makes the tag annotated and stores this message.' },
          revision: { type: 'string', description: 'With create, the commit to tag. Defaults to HEAD.' },
          force: { type: 'boolean', description: 'With create, replace a tag that already exists.' },
          all: { type: 'boolean', description: 'With push, push every tag instead of one.' },
          remote: { type: 'string', description: 'Remote name. Defaults to origin, or the only configured remote.' },
          cwd: CWD_PARAM,
        },
        required: ['action'],
      },
      output: textOutput(
        {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            error: { type: 'string' },
            action: { type: 'string' },
            name: { type: 'string' },
            tags: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  hash: { type: 'string' },
                  date: { type: 'string' },
                  subject: { type: 'string' },
                },
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
        renderTag,
      ),
      isConcurrencySafe: (args) => args?.action === 'list',
      presentCall: (args) => ({ card: 'generic', title: `git tag ${args?.action ?? 'list'}`, kind: 'edit', rawInput: args }),
      async execute(args, exec) {
        return core.tag({ ...scope(args, exec), ...args });
      },
    },
    {
      name: 'git_revert',
      description:
        'Undo a commit by adding its inverse, leaving history intact. This is the safe counterpart of git_reset for commits that are already pushed; git_reset rewrites the branch instead.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          revision: { type: 'string', description: 'Commit to undo. Defaults to HEAD.' },
          noCommit: { type: 'boolean', description: 'Stage the inverse without committing it.' },
          mainline: { type: 'number', description: 'Parent number, when reverting a merge commit.' },
          cwd: CWD_PARAM,
        },
        required: [],
      },
      output: textOutput(REWRITE_SCHEMA, renderRewrite('reverted')),
      isConcurrencySafe: () => false,
      presentCall: (args) => ({ card: 'generic', title: `git revert ${args?.revision ?? 'HEAD'}`, kind: 'edit', rawInput: args }),
      async execute(args, exec) {
        return core.revert({ ...scope(args, exec), ...args });
      },
    },
    {
      name: 'git_cherry_pick',
      description:
        'Apply the changes of one or more commits from elsewhere onto the checked-out branch, as new commits. Use it to lift a fix off another branch without merging everything.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          revisions: {
            type: 'array',
            items: { type: 'string' },
            description: 'Commits to apply, in order.',
          },
          noCommit: { type: 'boolean', description: 'Apply to the working tree and index without committing.' },
          mainline: { type: 'number', description: 'Parent number, when picking a merge commit.' },
          cwd: CWD_PARAM,
        },
        required: ['revisions'],
      },
      output: textOutput(REWRITE_SCHEMA, renderRewrite('picked')),
      isConcurrencySafe: () => false,
      presentCall: (args) => ({
        card: 'generic',
        title: `git cherry-pick ${(args?.revisions ?? []).join(' ')}`,
        kind: 'edit',
        rawInput: args,
      }),
      async execute(args, exec) {
        return core.cherryPick({ ...scope(args, exec), ...args });
      },
    },
    {
      name: 'git_rebase',
      description:
        'Replay this branch\'s commits on top of another branch or revision, or abort and continue a rebase that stopped. Rewrites the commits being replayed, so it is the wrong tool for history someone else already has — use git_revert for that.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          onto: { type: 'string', description: 'Branch or revision to replay onto. Required unless abort or continue is set.' },
          abort: { type: 'boolean', description: 'Give up the rebase in progress and restore the previous state.' },
          continue: { type: 'boolean', description: 'Resume after the conflicts have been resolved and staged.' },
          autostash: { type: 'boolean', description: 'Stash uncommitted changes for the duration of the rebase.' },
          cwd: CWD_PARAM,
        },
        required: [],
      },
      output: textOutput(REWRITE_SCHEMA, renderRewrite('rebased onto')),
      isConcurrencySafe: () => false,
      presentCall: (args) => ({
        card: 'generic',
        title: args?.abort ? 'git rebase --abort' : args?.continue ? 'git rebase --continue' : `git rebase ${args?.onto ?? ''}`.trim(),
        kind: 'edit',
        rawInput: args,
      }),
      async execute(args, exec) {
        return core.rebase({ ...scope(args, exec), ...args });
      },
    },
  ];

  ctx.effect(() => {
    const disposers = tools.map((tool) => ctx.tools.register(tool));
    ctx.logger?.info?.(`dsh-git: registered ${tools.length} tools (${tools.map((tool) => tool.name).join(', ')})`);
    return () => {
      for (const dispose of disposers) dispose();
    };
  });

  // The settings view persists through `configEditor`, which writes the row's
  // own `id` and `name` into the profile patch. Reporting both here is how the
  // panel (and this log) knows the row is addressable before anything is saved.
  const entry = ctx.fiber?.entry;
  ctx.logger?.info?.(
    `dsh-git: config row id=${entry?.options?.id ?? '(none)'} name=${entry?.options?.name ?? '(none)'}`,
  );

  ctx.effect(() => {
    // The channel is a convenience for the panel: a profile without a Web
    // server, or a future connection change, must not cost the agent its tools.
    try {
      const release = registerGitPanel(ctx, operations);
      ctx.logger?.info?.('dsh-git: panel route requested (gated on the connection service)');
      return release;
    } catch (failure) {
      ctx.logger?.warn?.(`dsh-git: panel route unavailable, the agent tools still work: ${failure?.message ?? failure}`);
      return undefined;
    }
  });
}
