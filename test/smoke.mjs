/**
 * Offline smoke test for the git core.
 *
 * Runs the real git binary through a `node:child_process`-backed exec, so the
 * behaviour checked here is the behaviour the Harness will get from
 * `ctx.shell`. Run with `node test/smoke.mjs`.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildGraph, createGitCore, diffRows, quoteFor, shellQuote } from '../lib/git-core.js';
import {
  buildUserPrompt,
  explainFileChange,
  generateCommitMessage,
  languageRule,
  normalizeCommitMessage,
  normalizeExplanation,
  normalizeIgnorePatterns,
  resolveRoute,
  suggestIgnorePatterns,
} from '../lib/messages.js';
import { createHostText as hostText, MESSAGES as HOST_MESSAGES } from '../lib/text.js';
import { extractArray, normalizeFindings, normalizeGroups, reviewStagedChanges, suggestCommitSplit } from '../lib/review.js';
import * as plugin from '../lib/plugin.js';

/**
 * The keyword sets `@deepseek-ai/dsh-tools` enforces at `tools.register` time.
 * Mirrored here so a schema the live Harness would reject fails in this test
 * instead of at install time. Source: `assertSupportedJsonSchema` in
 * `@deepseek-ai/dsh-tools/lib/index.js`.
 */
const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];
const CONSTRAINT_KEYWORDS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const']);
const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples']);
const ONE_OF_SIBLING_KEYWORDS = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const'];

/** Collect every way `node` leaves the supported JSON Schema subset. */
function checkSchemaNode(node, path, violations) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    violations.push(`${path} must be a schema object`);
    return;
  }
  for (const key of Object.keys(node)) {
    if (CONSTRAINT_KEYWORDS.has(key) || ANNOTATION_KEYWORDS.has(key)) continue;
    violations.push(`${path}.${key} is not a supported keyword`);
  }
  if (Object.hasOwn(node, 'description') && typeof node.description !== 'string') {
    violations.push(`${path}.description must be a string`);
  }
  const hasType = Object.hasOwn(node, 'type');
  const hasOneOf = Object.hasOwn(node, 'oneOf');
  if (hasType && hasOneOf) {
    violations.push(`${path} cannot declare both type and oneOf`);
    return;
  }
  if (!hasType && !hasOneOf) {
    for (const key of ONE_OF_SIBLING_KEYWORDS) {
      if (Object.hasOwn(node, key)) violations.push(`${path}.${key} requires type or oneOf`);
    }
    return;
  }
  if (hasOneOf) {
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) violations.push(`${path}.oneOf must hold at least two schemas`);
    else node.oneOf.forEach((child, index) => checkSchemaNode(child, `${path}.oneOf[${index}]`, violations));
    return;
  }
  const type = node.type;
  if (typeof type !== 'string' || !SCHEMA_TYPES.includes(type)) {
    violations.push(
      Array.isArray(type)
        ? `${path}.type must be a single type string (type arrays are not supported)`
        : `${path}.type must be one of ${SCHEMA_TYPES.join('/')}`,
    );
    return;
  }
  const keywordTypes = {
    properties: ['object'],
    required: ['object'],
    additionalProperties: ['object'],
    items: ['array'],
    enum: ['string', 'number', 'integer', 'boolean', 'null'],
    const: ['string', 'number', 'integer', 'boolean', 'null'],
  };
  for (const [key, allowed] of Object.entries(keywordTypes)) {
    if (Object.hasOwn(node, key) && !allowed.includes(type)) {
      violations.push(`${path}.${key} is not supported on type "${type}"`);
    }
  }
  if (type === 'object') {
    if (Object.hasOwn(node, 'properties')) {
      if (node.properties === null || typeof node.properties !== 'object' || Array.isArray(node.properties)) {
        violations.push(`${path}.properties must be an object of schemas`);
      } else {
        for (const [child, schema] of Object.entries(node.properties)) {
          checkSchemaNode(schema, `${path}.properties.${child}`, violations);
        }
      }
    }
    if (Object.hasOwn(node, 'required') && (!Array.isArray(node.required) || node.required.some((e) => typeof e !== 'string'))) {
      violations.push(`${path}.required must be an array of strings`);
    }
  } else if (type === 'array') {
    if (Object.hasOwn(node, 'items')) checkSchemaNode(node.items, `${path}.items`, violations);
  } else if (Object.hasOwn(node, 'enum')) {
    if (!Array.isArray(node.enum) || node.enum.length === 0) violations.push(`${path}.enum must be a non-empty array`);
  }
}

let failures = 0;
let checks = 0;

function check(label, condition, detail) {
  checks += 1;
  if (condition) {
    process.stdout.write(`  ok   ${label}\n`);
  } else {
    failures += 1;
    process.stdout.write(`  FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}\n`);
  }
}

function section(title) {
  process.stdout.write(`\n${title}\n`);
}

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-git-smoke-'));
const repo = join(sandbox, 'repo');
const fakeHome = join(sandbox, 'home');
mkdirSync(fakeHome, { recursive: true });

/**
 * An isolated environment: a private HOME and no system config, so the machine's
 * real git identity and defaults cannot decide the outcome of a check.
 */
/** Run git directly, for the few setup steps no operation covers. */
function gitIn(cwd, ...args) {
  return new Promise((settle, fail) => {
    execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024, env: TEST_ENV }, (error, stdout, stderr) => {
      if (error) fail(new Error(`${args.join(' ')}: ${stderr || error.message}`));
      else settle(stdout);
    });
  });
}

const TEST_ENV = {
  ...process.env,
  HOME: fakeHome,
  XDG_CONFIG_HOME: join(fakeHome, '.config'),
  GIT_CONFIG_GLOBAL: join(fakeHome, '.gitconfig'),
  GIT_CONFIG_SYSTEM: '/dev/null',
};

/** The last request handed to the shell stand-in, for asserting the contract. */
let lastShellRequest = null;

/** A minimal stand-in for `ctx.shell`, backed by a real bash process. */
function childProcessExec({ command, cwd, stdin, timeoutMs, env }) {
  return new Promise((settle) => {
    const child = execFile(
      '/bin/bash',
      ['-c', command],
      { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: { ...TEST_ENV, ...(env ?? {}) } },
      (error, stdout, stderr) => {
        let code = 0;
        if (error) code = typeof error.code === 'number' ? error.code : 1;
        settle({
          code,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          timedOut: Boolean(error?.killed),
          aborted: false,
          denied: false,
        });
      },
    );
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

const core = createGitCore({ exec: childProcessExec, config: { defaultBranch: 'main' } });

/** A stand-in that answers with Windows-style output, to check the parsers. */
function crlfExec(reply) {
  return async (request) => {
    lastShellRequest = request;
    return { code: 0, stdout: reply(request), stderr: '', timedOut: false, aborted: false, denied: false };
  };
}

try {
  section('shell quoting');
  check('quotes a plain word', shellQuote('src/a.ts') === "'src/a.ts'");
  check('neutralizes a quote', shellQuote("it's") === "'it'\\''s'");
  check('neutralizes a command substitution', shellQuote('$(rm -rf /)') === "'$(rm -rf /)'");

  section('status outside a repository');
  const before = await core.status({ cwd: sandbox });
  check('reports isRepo false', before.isRepo === false, before);
  check('offers git_init', typeof before.hint === 'string' && before.hint.includes('git_init'));

  section('init');
  const initialized = await core.init({ cwd: repo, gitignore: 'node_modules/\n*.log\n' });
  check('creates the repository', initialized.ok === true && initialized.created === true, initialized);
  check('uses the configured default branch', initialized.branch === 'main', initialized.branch);
  check('writes .gitignore', initialized.gitignoreWritten === true);
  check('reports a missing identity', initialized.identityConfigured === false);

  const again = await core.init({ cwd: repo });
  check('is idempotent', again.created === false && again.ok === true, again);

  section('config');
  check(
    'writes a local identity',
    (await core.config({ cwd: repo, action: 'set', key: 'user.name', value: 'Test User' })).ok === true,
  );
  check(
    'writes a local email',
    (await core.config({ cwd: repo, action: 'set', key: 'user.email', value: 'test@example.com' })).ok === true,
  );
  const readBack = await core.config({ cwd: repo, action: 'get', key: 'user.email' });
  check('reads it back', readBack.found === true && readBack.value === 'test@example.com', readBack);
  const missing = await core.config({ cwd: repo, action: 'get', key: 'user.signingkey' });
  check('reports an unset key without failing', missing.ok === true && missing.found === false, missing);
  const listed = await core.config({ cwd: repo, action: 'list' });
  check('lists local entries', listed.ok === true && listed.entries.length >= 2, listed.entries?.length);
  check(
    'rejects an unknown action',
    (await core.config({ cwd: repo, action: 'explode', key: 'user.name' })).ok === false,
  );

  section('stage and commit');
  writeFileSync(join(repo, 'index.js'), 'export const answer = 42;\n');
  writeFileSync(join(repo, 'notes.md'), '# notes\n');
  const untracked = await core.status({ cwd: repo });
  check('sees the gitignore and two new files', untracked.untracked.length === 3, untracked.untracked);
  check('is not clean', untracked.clean === false);

  const staged = await core.stage({ cwd: repo, action: 'add' });
  check('stages everything', staged.ok === true, staged);
  const afterStage = await core.status({ cwd: repo });
  check('reports three staged paths', afterStage.staged.length === 3, afterStage.staged);
  check('reports no untracked paths left', afterStage.untracked.length === 0);

  const unstageOne = await core.stage({ cwd: repo, action: 'unstage', paths: ['notes.md'] });
  check('unstages one path', unstageOne.ok === true, unstageOne);
  const partly = await core.status({ cwd: repo });
  check('leaves two staged and one untracked', partly.staged.length === 2 && partly.untracked.length === 1, {
    staged: partly.staged,
    untracked: partly.untracked,
  });

  const first = await core.commit({ cwd: repo, message: 'feat: add the answer module' });
  check('commits', first.ok === true, first.error);
  check('returns a short hash', typeof first.shortHash === 'string' && first.shortHash.length === 7, first.shortHash);
  check('reports the branch', first.branch === 'main', first.branch);
  check('is not marked generated', first.generated === false);
  check('lists the committed file', first.files.some((file) => file.path === 'index.js'), first.files);

  const emptyCommit = await core.commit({ cwd: repo, message: 'chore: nothing' });
  check('refuses a commit with nothing staged', emptyCommit.ok === false, emptyCommit.error);
  check('still reports the message it would have used', emptyCommit.message === 'chore: nothing', emptyCommit.message);

  section('log and diff');
  const logged = await core.log({ cwd: repo, limit: 5 });
  check('returns the commit', logged.commits.length === 1 && logged.commits[0].hash === first.shortHash, logged.commits);
  check('reports the subject', logged.commits[0].subject === 'feat: add the answer module', logged.commits[0]);

  const lastPatch = await core.diff({ cwd: repo, scope: 'last-commit' });
  check('reads the last commit patch', lastPatch.ok === true && lastPatch.patch.includes('answer = 42'), lastPatch.patch?.slice(0, 120));
  check(
    'reports per-file counts',
    lastPatch.files.some((file) => file.path === 'index.js' && file.additions === 1 && file.deletions === 0),
    lastPatch.files,
  );

  writeFileSync(join(repo, 'index.js'), 'export const answer = 43;\nexport const extra = true;\n');
  const worktree = await core.diff({ cwd: repo, scope: 'unstaged' });
  check('reads unstaged work', worktree.patch.includes('answer = 43'), worktree.patch?.slice(0, 160));
  const stagedOnly = await core.diff({ cwd: repo, scope: 'staged' });
  check('staged scope is empty after committing', stagedOnly.patch.trim() === '', stagedOnly.patch);

  const statOnly = await core.diff({ cwd: repo, scope: 'unstaged', stat: true });
  check('stat mode omits hunks', !statOnly.patch.includes('@@'), statOnly.patch);

  section('path containment');
  const escaped = await core.stage({ cwd: repo, action: 'add', paths: ['../../etc/passwd'] });
  check('refuses a path escaping the repository', escaped.ok === false, escaped.error);
  const discardAll = await core.stage({ cwd: repo, action: 'discard' });
  check('refuses a blanket discard', discardAll.ok === false, discardAll.error);
  const discarded = await core.stage({ cwd: repo, action: 'discard', paths: ['index.js'] });
  check('discards one named path', discarded.ok === true, discarded);
  check('reverted the work tree', (await core.diff({ cwd: repo, scope: 'unstaged' })).patch.trim() === '');

  section('change bundle and message generation');
  writeFileSync(join(repo, 'index.js'), 'export const answer = 43;\n');
  writeFileSync(join(repo, 'extra.js'), 'export const extra = true;\n');
  await core.stage({ cwd: repo, action: 'add', paths: ['index.js'] });
  const bundle = await core.changeBundle({ cwd: repo });
  check('bundle is ok', bundle.ok === true, bundle.error);
  check('bundle carries the staged patch', bundle.staged.patch.includes('answer = 43'), bundle.staged.patch?.slice(0, 120));
  check('bundle knows the branch', bundle.branch === 'main', bundle.branch);
  check('bundle includes recent subjects', bundle.recentCommits.includes('feat: add the answer module'), bundle.recentCommits);
  check('bundle samples untracked files', bundle.untracked.some((entry) => entry.path === 'extra.js'), bundle.untracked);

  const prompt = buildUserPrompt(bundle);
  check('prompt embeds the staged diff', prompt.includes('answer = 43'));
  check('prompt embeds recent subjects', prompt.includes('feat: add the answer module'));

  check('normalizes a fenced answer', normalizeCommitMessage('```\nfix: a\n```') === 'fix: a');
  check('normalizes a quoted answer', normalizeCommitMessage('"fix: a"') === 'fix: a');
  check('drops an attribution trailer', !normalizeCommitMessage('fix: a\n\nbody\n\nSigned-off-by: Bot <b@x>').includes('Signed-off-by'));
  check('drops a label prefix', normalizeCommitMessage('Commit message: fix: a') === 'fix: a');

  const routeFromConfig = resolveRoute({ config: { provider: 'p', model: 'm' } });
  check('prefers the configured route', routeFromConfig.provider === 'p' && routeFromConfig.model === 'm');
  const routeFromDefault = resolveRoute({ config: {}, defaultModel: { currentSelection: () => ({ provider: 'd', model: 'dm' }) } });
  check('falls back to the default model', routeFromDefault.provider === 'd');
  check('reports no route', resolveRoute({ config: {} }) === null);

  const fakeLlm = {
    async *stream(options) {
      check('sends the resolved route to the model', options.provider === 'p' && options.model === 'm');
      check('sends a system prompt', typeof options.system === 'string' && options.system.includes('Conventional Commits'));
      yield { type: 'text-delta', index: 0, text: 'feat(core): ' };
      yield { type: 'text-delta', index: 0, text: 'answer 43 instead of 42' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const proposal = await generateCommitMessage({
    llm: fakeLlm,
    route: { provider: 'p', model: 'm' },
    bundle,
    language: 'en',
  });
  check('generates a message', proposal.ok === true && proposal.message === 'feat(core): answer 43 instead of 42', proposal);
  check(
    'reports the route it used',
    proposal.meta?.provider === 'p' && proposal.meta?.subject === proposal.message,
    proposal.meta,
  );

  const failingLlm = {
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new Error('transport exploded');
    },
  };
  const failed = await generateCommitMessage({ llm: failingLlm, route: { provider: 'p', model: 'm' }, bundle });
  check('surfaces a model failure', failed.ok === false && failed.error.includes('transport exploded'), failed);

  const emptyLlm = { async *stream() { yield { type: 'finish', reason: { kind: 'stop' } }; } };
  check('rejects an empty answer', (await generateCommitMessage({ llm: emptyLlm, route: { provider: 'p', model: 'm' }, bundle })).ok === false);
  check('reports a missing model service', (await generateCommitMessage({ llm: null, route: { provider: 'p', model: 'm' }, bundle })).ok === false);

  section('commit with a generated message');
  const generated = await core.commit({
    cwd: repo,
    generateMessage: async () => ({ ok: true, message: 'feat(core): answer 43 instead of 42', meta: { provider: 'p', model: 'm' } }),
  });
  check('commits with the generated message', generated.ok === true, generated.error);
  check('flags the message as generated', generated.generated === true);
  check('stores the generated subject', generated.subject === 'feat(core): answer 43 instead of 42', generated.subject);
  const afterGenerate = await core.log({ cwd: repo, limit: 3 });
  check('history has both commits', afterGenerate.commits.length === 2, afterGenerate.commits.map((c) => c.subject));

  const dry = await core.commit({
    cwd: repo,
    all: true,
    dryRun: true,
    generateMessage: async () => ({ ok: true, message: 'chore: preview', meta: {} }),
  });
  check('dry run reports the message', dry.dryRun === true && dry.message === 'chore: preview', dry);
  check('dry run did not commit', (await core.log({ cwd: repo, limit: 5 })).commits.length === 2);

  section('amend');
  const amended = await core.commit({ cwd: repo, amend: true, message: 'feat(core): answer 43, amended' });
  check('amends the commit', amended.ok === true && amended.amend === true, amended.error);
  const afterAmend = await core.log({ cwd: repo, limit: 5 });
  check('still has two commits', afterAmend.commits.length === 2, afterAmend.commits.length);
  check('uses the new subject', afterAmend.commits[0].subject === 'feat(core): answer 43, amended', afterAmend.commits[0].subject);

  const amendKeep = await core.commit({ cwd: repo, amend: true });
  check('amends while keeping the message', amendKeep.ok === true && amendKeep.subject === 'feat(core): answer 43, amended', amendKeep);

  section('branches');
  const created = await core.branch({ cwd: repo, action: 'create', name: 'feature/panel' });
  check('creates a branch', created.ok === true, created.error);
  const branches = await core.branch({ cwd: repo, action: 'list' });
  check('lists both branches', branches.branches.length === 2, branches.branches);
  check('marks the new branch current', branches.branches.find((b) => b.name === 'feature/panel')?.current === true);
  const switched = await core.branch({ cwd: repo, action: 'switch', name: 'main' });
  check('switches back', switched.ok === true, switched.error);
  const deleted = await core.branch({ cwd: repo, action: 'delete', name: 'feature/panel' });
  check('deletes the branch', deleted.ok === true, deleted.error);
  check('rejects delete without a name', (await core.branch({ cwd: repo, action: 'delete' })).ok === false);

  section('sync without a remote');
  const pushed = await core.sync({ cwd: repo, action: 'push' });
  check('explains the missing remote', pushed.ok === false && /no remote/.test(pushed.error), pushed.error);

  section('tool registration and schema subset');
  const registered = [];
  const toolRepo = join(sandbox, 'tool-repo');
  /** Sessions that chose a mode, and the policy the Host resolves for them. */
  const sessionModes = { 'session-loose': 'danger-full-access', 'session-panel': 'workspace-write' };
  const resolvedPolicies = [];
  const sandboxPolicy = {
    resolve: (request = {}) => {
      const session = request.session;
      const policy = {
        mode: session === undefined ? 'workspace-write' : (sessionModes[session.id] ?? 'workspace-write'),
        ...(session === undefined ? {} : { sessionId: session.id }),
      };
      resolvedPolicies.push(policy);
      return policy;
    },
  };
  const sessionCwds = { 'session-panel': toolRepo };
  const panel = { route: null };
  const configWrites = [];
  const fakeEntry = { options: { id: 'dsh-git', name: 'file:///tmp/dsh-git/lib/plugin.js' } };
  const fakeCtx = {
    // The settings view needs the plugin's own Loader entry, exactly as the
    // live Host reaches it through `ctx.fiber`.
    fiber: { entry: fakeEntry },
    logger: { info: () => {} },
    tools: {
      register: (definition) => {
        registered.push(definition);
        return () => {};
      },
    },
    shell: {
      resolve: (request) => {
        lastShellRequest = request;
        return request;
      },
      execute: async (spec) => ({
        result: async () => {
          const outcome = await childProcessExec({
            command: spec.command,
            cwd: spec.workdir,
            stdin: spec.stdin,
            timeoutMs: spec.timeoutMs,
          });
          return {
            exitCode: outcome.code,
            stdout: { text: outcome.stdout },
            stderr: { text: outcome.stderr },
            timedOut: outcome.timedOut,
            aborted: false,
            sandbox: undefined,
          };
        },
      }),
    },
    get: (name) => {
      if (name === 'sandboxPolicy') return sandboxPolicy;
      if (name === 'sessions') {
        return {
          get: (id) => (Object.hasOwn(sessionCwds, id) ? { id, header: { cwd: sessionCwds[id] } } : undefined),
        };
      }
      if (name === 'configEditor') {
        return {
          edit: async (entry, change) => {
            configWrites.push({ entry, next: change({ defaultBranch: 'main', messageLanguage: 'auto' }, {}) });
          },
        };
      }
      return undefined;
    },
    effect: (callback) => {
      callback();
    },
    /**
     * Stand in for cordis's deferred inject. Only `connection` is requested, so
     * this answers exactly that request and records the Fetch route the plugin
     * opens — which is what lets the panel bridge be tested here. Injected
     * services are exposed as context properties, matching cordis's rebinding:
     * reading them with `ctx.get()` yields the raw service instead, and that
     * difference is part of why the first live attempt at a bridge failed.
     */
    inject: (deps, callback) => {
      if (!Array.isArray(deps) || !deps.includes('connection')) return () => {};
      const connection = {
        fetch: {
          register: (route) => {
            panel.route = route;
            return () => {
              panel.route = null;
            };
          },
        },
      };
      const scoped = {
        connection,
        get: (name) => (name === 'connection' ? connection : undefined),
      };
      const dispose = callback(scoped);
      return () => {
        if (typeof dispose === 'function') dispose();
      };
    },
  };

  await plugin.apply(fakeCtx, { defaultBranch: 'main' });
  const expectedNames = [
    'git_branch',
    'git_cherry_pick',
    'git_commit',
    'git_config',
    'git_diff',
    'git_init',
    'git_log',
    'git_rebase',
    'git_reset',
    'git_revert',
    'git_stage',
    'git_stash',
    'git_status',
    'git_sync',
    'git_tag',
  ];
  check('registers exactly the documented tools', registered.map((t) => t.name).sort().join(',') === expectedNames.join(','), registered.map((t) => t.name));

  for (const tool of registered) {
    const violations = [];
    checkSchemaNode(tool.parameters, `${tool.name}.parameters`, violations);
    checkSchemaNode(tool.output.schema, `${tool.name}.output.schema`, violations);
    check(`${tool.name}: schemas stay inside the DSH subset`, violations.length === 0, violations);
    check(
      `${tool.name}: declares a description and a result renderer`,
      typeof tool.description === 'string' && tool.description.length > 30 && typeof tool.output.render === 'function',
      { description: tool.description?.length, render: typeof tool.output.render },
    );
    check(
      `${tool.name}: parameters are a closed object`,
      tool.parameters.type === 'object' && tool.parameters.additionalProperties === false,
      tool.parameters,
    );
  }

  section('tools against a live repository');
  const byName = (name) => registered.find((tool) => tool.name === name);
  const runTool = async (name, args) => {
    const tool = byName(name);
    const value = await tool.execute(args, { agent: undefined, signal: undefined });
    return { value, text: tool.output.render(args, value)[0].text };
  };

  const outside = await runTool('git_status', { cwd: sandbox });
  check('git_status reports a non-repository', outside.value.isRepo === false && outside.text.includes('not a git repository'), outside.text);

  const initialised = await runTool('git_init', { cwd: toolRepo, gitignore: 'node_modules/\n' });
  check('git_init creates the repository', initialised.value.ok === true && initialised.value.created === true, initialised.text);
  check('git_init names the identity gap in its text', initialised.text.includes('no commit identity'), initialised.text);

  await runTool('git_config', { cwd: toolRepo, action: 'set', key: 'user.name', value: 'Tool User' });
  const wroteEmail = await runTool('git_config', { cwd: toolRepo, action: 'set', key: 'user.email', value: 'tool@example.com' });
  check('git_config writes and reports a value', wroteEmail.value.written === true && wroteEmail.text.includes('tool@example.com'), wroteEmail.text);
  const readName = await runTool('git_config', { cwd: toolRepo, action: 'get', key: 'user.name' });
  check('git_config reads a value back', readName.text === 'user.name=Tool User', readName.text);

  writeFileSync(join(toolRepo, 'app.js'), 'console.log("hi");\n');
  const untrackedStatus = await runTool('git_status', { cwd: toolRepo });
  check(
    'git_status lists the new file',
    untrackedStatus.text.includes('untracked (2)') && untrackedStatus.text.includes('app.js (new)'),
    untrackedStatus.text,
  );

  const stagedAll = await runTool('git_stage', { cwd: toolRepo, action: 'add' });
  check('git_stage stages everything', stagedAll.value.ok === true && stagedAll.text.startsWith('staged:'), stagedAll.text);

  const committed = await runTool('git_commit', {
    cwd: toolRepo,
    message: 'feat: add the app entry\n\nPrint a greeting on start.\n',
  });
  check('git_commit commits', committed.value.ok === true && /^committed [0-9a-f]{7} on main/.test(committed.text), committed.text);
  check('git_commit renders the full message', committed.text.includes('feat: add the app entry') && committed.text.includes('Print a greeting'), committed.text);
  check('git_commit reports the committed file', committed.text.includes('app.js'), committed.text);

  const toolLog = await runTool('git_log', { cwd: toolRepo, limit: 5 });
  check('git_log lists the commit', toolLog.text.includes('feat: add the app entry'), toolLog.text);

  const toolPatch = await runTool('git_diff', { cwd: toolRepo, scope: 'last-commit' });
  check('git_diff returns the patch', toolPatch.value.patch.includes('console.log'), toolPatch.text.slice(0, 200));

  const toolBranches = await runTool('git_branch', { cwd: toolRepo, action: 'list' });
  check('git_branch marks the current branch', toolBranches.text.includes('* main'), toolBranches.text);

  const groupedInit = await runTool('git_init', { cwd: join(sandbox, 'grouped-repo'), gitignoreGroups: ['node', 'secrets'] });
  check('git_init accepts curated gitignore groups', groupedInit.value.ok === true, groupedInit.text);
  const groupedIgnore = readFileSync(join(sandbox, 'grouped-repo', '.gitignore'), 'utf8');
  check('the group lines reach the file', groupedIgnore.includes('node_modules/') && groupedIgnore.includes('.env'), groupedIgnore.slice(0, 120));

  const noRemote = await runTool('git_sync', { cwd: toolRepo, action: 'push' });
  check('git_sync explains the missing remote', noRemote.value.ok === false && noRemote.text.includes('no remote'), noRemote.text);

  const preview = await runTool('git_commit', { cwd: toolRepo, all: true, dryRun: true, message: 'chore: preview' });
  check('git_commit dry run renders the message', preview.value.dryRun === true && preview.text.includes('dry run') && preview.text.includes('chore: preview'), preview.text);

  const blanketDiscard = await runTool('git_stage', { cwd: toolRepo, action: 'discard' });
  check('git_stage refuses a blanket discard', blanketDiscard.value.ok === false && blanketDiscard.text.startsWith('error:'), blanketDiscard.text);

  section('messages a person reads follow the language setting');
  const zhText = hostText();
  const enText = hostText('en');
  check('an unset or auto setting reads in Chinese', zhText.language === 'zh', zhText.language);
  check('explicit English reads in English', enText.language === 'en', enText.language);
  check('an unknown language falls back to Chinese', hostText('klingon').language === 'zh');

  // Every entry must survive the round trip: its own English text, translated,
  // must come back as its Chinese text with the same values in place.
  const roundTrip = [];
  for (const [key, entry] of Object.entries(HOST_MESSAGES)) {
    const sample = (entry.match ?? entry.en).replace(/\{(\w+)\}/g, (_, name) => `<${name}>`);
    const expected = entry.zh.replace(/\{(\w+)\}/g, (_, name) => `<${name}>`);
    const actual = zhText.message(sample);
    if (actual !== expected) roundTrip.push({ key, sample, expected, actual });
  }
  check('every message translates by its own shape', roundTrip.length === 0, roundTrip);

  check('a plugin message translates', zhText.message('no commit matches HEAD~1') === '找不到匹配 HEAD~1 的提交', zhText.message('no commit matches HEAD~1'));
  check(
    'a plugin prefix keeps git\'s words after it',
    zhText.message('not a git repository: fatal: not a git repository (or any of the parent directories): .git') ===
      '这里不是 git 仓库：当前目录及其父目录都不是 git 仓库',
    zhText.message('not a git repository: fatal: not a git repository (or any of the parent directories): .git'),
  );
  check(
    'a rejected push explains itself in Chinese',
    zhText.message('! [rejected]        main -> main (fetch first)') === '推送被拒绝：main → main（远程有本地没有的提交）',
    zhText.message('! [rejected]        main -> main (fetch first)'),
  );
  check('English is left exactly as it was', enText.message('no commit matches HEAD~1') === 'no commit matches HEAD~1');
  // A miss must stay readable rather than half-translated.
  const unknown = 'a sentence this plugin never wrote';
  check('an unknown sentence is passed through untouched', zhText.message(unknown) === unknown, zhText.message(unknown));

  // The message the user actually met: git names the files, and stdout must not
  // be glued onto the end of it.
  const overwrite =
    'error: Your local changes to the following files would be overwritten by merge:\n\tf.txt\nPlease commit your changes or stash them before you merge.\nAborting\n';
  const localizedOverwrite = zhText.message(overwrite.trim().split('\n').map((line) => line.trim()).filter(Boolean).join(' '));
  check('the overwrite warning names the files', localizedOverwrite.includes('f.txt'), localizedOverwrite);
  check('and says what to do', localizedOverwrite.includes('提交或贮藏'), localizedOverwrite);
  check('and is not glued to stdout', !localizedOverwrite.includes('On branch'), localizedOverwrite);

  section('a refusal names the mode that refused');
  // A read-only session cannot write `.git`; a session already on
  // danger-full-access that is still refused has a different problem. Saying
  // which mode is what tells the two apart.
  const deniedCore = createGitCore({
    exec: async () => ({
      code: 128,
      stdout: '',
      stderr: "fatal: Unable to create 'C:/x/.git/index.lock': Permission denied",
      timedOut: false,
      aborted: false,
      denied: true,
    }),
    sandboxMode: 'read-only',
    config: { commandTimeoutMs: 5000 },
  });
  const denied = await deniedCore.status({ cwd: toolRepo });
  check('the failure carries the mode', String(denied.error ?? denied.reason ?? '').includes('session mode "read-only"'), denied);
  const deniedText = hostText().message(String(denied.error ?? denied.reason));
  check('the panel names the mode', deniedText.includes('read-only'), deniedText.slice(0, 60));
  check('and says what to switch to', deniedText.includes('danger-full-access'), deniedText.slice(0, 200));
  check('and the index.lock cause survives', deniedText.includes('index.lock'), deniedText.slice(-80));
  check(
    'English gets the same advice',
    hostText('en').message(String(denied.error ?? denied.reason)).includes('danger-full-access'),
    hostText('en').message(String(denied.error ?? denied.reason)).slice(0, 120),
  );

  // Without a mode (the panel's own route) the older wording is kept.
  const plainDenied = createGitCore({
    exec: async () => ({ code: 128, stdout: '', stderr: 'fatal: denied', timedOut: false, aborted: false, denied: true }),
    config: { commandTimeoutMs: 5000 },
  });
  const noModeRefusal = await plainDenied.status({ cwd: toolRepo });
  check(
    'a refusal with no mode keeps the plain wording',
    !String(noModeRefusal.error ?? noModeRefusal.reason).includes('session mode'),
    noModeRefusal,
  );

  section('a sandbox refusal is not an empty folder');
  // A probe fails either because this is not a repository or because git never
  // ran. The panel offered to `git init` for both, which is useless advice when
  // the machine cannot start a sandbox.
  const refusal =
    'could not run git here: sandbox mode "workspace-write" is requested but no sandbox backend is usable on this host; ' +
    'refusing to run the command unconfined. Runner failure: windows-acl-run: EPERM: operation not permitted, mkdtemp ' +
    "'C:\\Users\\someone\\AppData\\Local\\Temp\\dsh-XXXXXX'";
  const noSandboxCore = createGitCore({
    exec: async () => ({ code: 1, stdout: '', stderr: refusal, timedOut: false, aborted: false, denied: true }),
    config: { commandTimeoutMs: 5000 },
  });
  const noSandbox = await noSandboxCore.status({ cwd: toolRepo });
  check('the probe reports git as unavailable', noSandbox.ok === true && noSandbox.unavailable === true, noSandbox);
  check('and keeps the reason', String(noSandbox.reason).includes('sandbox'), noSandbox.reason);

  const ordinaryCore = createGitCore({
    exec: async () => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git', timedOut: false, aborted: false, denied: false }),
    config: { commandTimeoutMs: 5000 },
  });
  const ordinary = await ordinaryCore.status({ cwd: toolRepo });
  check('an ordinary folder is not flagged as unavailable', ordinary.unavailable === undefined, ordinary);

  // The raw text reads like a repository fault; it is not one, and saying so is
  // the difference between a user fixing their machine and blaming their project.
  const refusalText = hostText().message(refusal);
  check('the refusal is explained as an environment problem', refusalText.includes('环境问题'), refusalText.slice(0, 80));
  check('and keeps the reported cause', refusalText.includes('mkdtemp'), refusalText.slice(-60));
  // English is left exactly as the Host wrote it: there is nothing to translate,
  // and rewriting an English message for an English reader would only lose detail.
  // The causes are platform-specific, and naming the wrong one sends the reader to
  // the wrong place: a Windows %TEMP% problem says nothing to a Linux user whose
  // kernel lacks Landlock.
  const under = (platform) => hostText('auto', { platform }).message(refusal);
  check('Linux advice names bubblewrap and Landlock', under('linux').includes('bubblewrap') && under('linux').includes('Landlock'), under('linux').slice(0, 100));
  check('Windows advice names %TEMP%', under('win32').includes('%TEMP%'), under('win32').slice(0, 100));
  check('macOS advice names sandbox-exec', under('darwin').includes('sandbox-exec'), under('darwin').slice(0, 100));
  check(
    'an unnamed platform still gets useful advice',
    under('freebsd').includes('danger-full-access') && !under('freebsd').includes('%TEMP%'),
    under('freebsd').slice(0, 100),
  );
  check(
    'and every one of them keeps the reported cause',
    ['linux', 'darwin', 'win32', 'freebsd'].every((platform) => under(platform).includes('mkdtemp')),
  );

  check(
    'and English keeps the Host wording untouched',
    hostText('en').message(refusal) === refusal,
    hostText('en').message(refusal).slice(0, 80),
  );

  section('a failing request leaves a trace');
  check(
    'the route logs a failed endpoint before answering',
    /catch \(error\) \{[\s\S]{0,400}?logger\?\.error\?\.\([\s\S]{0,200}?return json\(failure\('internal'/.test(
      readFileSync(new URL('../lib/rpc.js', import.meta.url), 'utf8'),
    ),
    'the route answers 500 without logging',
  );
  check(
    'and the host revision covers every implementation file',
    ['impl.js', 'git-core.js', 'messages.js', 'review.js', 'rpc.js', 'text.js'].every((file) =>
      readFileSync(new URL('../lib/plugin.js', import.meta.url), 'utf8').includes(`'${file}'`),
    ),
    'a file is missing from IMPLEMENTATION, so editing it would not reload the Host half',
  );

  section("a tool call carries the caller's sandbox policy");
  // The deployment default is `workspace-write`. A session that switched itself to
  // danger-full-access was still executed under the default, whose Windows ACL
  // runner could not start, so every git command failed while the panel blamed
  // the repository. The policy has to come from the call.
  const statusTool = registered.find((tool) => tool.name === 'git_status');
  check('git_status is registered', statusTool !== undefined);

  resolvedPolicies.length = 0;
  await statusTool.execute({ cwd: toolRepo }, { agent: { session: { id: 'session-loose' } } });
  check(
    'the session mode reaches the shell request',
    lastShellRequest.sandboxPolicy?.mode === 'danger-full-access',
    lastShellRequest.sandboxPolicy,
  );
  check(
    'and it was resolved from that session',
    resolvedPolicies.some((policy) => policy.sessionId === 'session-loose'),
    resolvedPolicies,
  );

  resolvedPolicies.length = 0;
  await statusTool.execute({ cwd: toolRepo }, { agent: { session: { id: 'session-panel' } } });
  check(
    'a session on the default still resolves through its own session',
    lastShellRequest.sandboxPolicy?.mode === 'workspace-write' &&
      lastShellRequest.sandboxPolicy?.sessionId === 'session-panel',
    lastShellRequest.sandboxPolicy,
  );

  // The panel's route has no session, so it keeps the deployment default — and
  // that has to stay byte-for-byte what it was.
  resolvedPolicies.length = 0;
  await statusTool.execute({ cwd: toolRepo }, undefined);
  check('the panel path sends no policy at all', lastShellRequest.sandboxPolicy === undefined, lastShellRequest.sandboxPolicy);
  check('and asks the service for nothing', resolvedPolicies.length === 0, resolvedPolicies);

  // A dry profile serves no policy service: the tools must still work.
  const withService = fakeCtx.get;
  fakeCtx.get = (name) => (name === 'sandboxPolicy' ? undefined : withService(name));
  await statusTool.execute({ cwd: toolRepo }, { agent: { session: { id: 'session-loose' } } });
  fakeCtx.get = withService;
  check(
    'a profile without the service falls back instead of failing',
    lastShellRequest.sandboxPolicy === undefined && statusTool !== undefined,
    lastShellRequest.sandboxPolicy,
  );

  // A backend that cannot start is an environment fault, not a repository fault.
  const realExecute = fakeCtx.shell.execute;
  fakeCtx.shell.execute = async () => {
    throw new Error(
      'sandbox mode "workspace-write" is requested but no sandbox backend is usable on this host; refusing to run the command unconfined. ' +
        "Runner failure: windows-acl-run: EPERM: operation not permitted, mkdtemp 'C:\\Users\\x\\AppData\\Local\\Temp\\dsh-XXXXXX'",
    );
  };
  const refusedCall = await statusTool.execute({ cwd: toolRepo }, { agent: { session: { id: 'session-loose' } } });
  fakeCtx.shell.execute = realExecute;
  check('a runner failure is reported, not thrown', refusedCall.ok === true && refusedCall.isRepo === false, refusedCall);
  check('as an unavailable git rather than an empty folder', refusedCall.unavailable === true, refusedCall.unavailable);
  check('with the environment named in the reason', /windows-acl-run|sandbox/i.test(String(refusedCall.reason)), refusedCall.reason);

  section('a shell that cannot start is a message, not a 500');
  // The service contract lets `execute` and `result` reject. On Windows a panel
  // opened on a folder whose path the shell cannot use got an HTTP 500 out of it,
  // and the body's reason never reached the screen.
  const deadShell = createGitCore({
    exec: async () => {
      throw new Error('spawn git ENOENT');
    },
    config: { commandTimeoutMs: 5000 },
  });
  const deadStatus = await deadShell.status({ cwd: toolRepo });
  check('the read answers instead of throwing', deadStatus.ok === true && deadStatus.isRepo === false, deadStatus);
  check('and says git could not be run', String(deadStatus.reason).includes('could not run git'), deadStatus.reason);
  const deadInit = await deadShell.init({ cwd: toolRepo });
  check('and so does a write', deadInit.ok === false && String(deadInit.error).includes('could not run git'), deadInit);
  const deadLog = await deadShell.log({ cwd: toolRepo, limit: 5 });
  check('and a read that parses output', deadLog.ok === false && String(deadLog.error).includes('could not run git'), deadLog);

  // The panel's own transport must carry that reason through rather than
  // replacing it with the status code.
  const transportSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  const notOkAt = transportSource.indexOf('if (!response.ok) {');
  let notOkBlock = '';
  if (notOkAt !== -1) {
    let depth = 0;
    for (let at = transportSource.indexOf('{', notOkAt); at < transportSource.length; at += 1) {
      if (transportSource[at] === '{') depth += 1;
      else if (transportSource[at] === '}') {
        depth -= 1;
        if (depth === 0) {
          notOkBlock = transportSource.slice(notOkAt, at + 1);
          break;
        }
      }
    }
  }
  check(
    'the panel reads the reason out of a failed response',
    notOkBlock.includes('response.text()') && notOkBlock.includes('endpoint') && notOkBlock.includes('answered HTTP'),
    notOkBlock.slice(0, 120) || 'no non-ok branch found',
  );

  section('hostile filenames survive the quoting');
  // Every argument goes through a shell string, so a name with a space, a quote,
  // or a dollar sign is the one place a platform difference shows up as data
  // loss rather than an error. Exercised end to end, on a real repository.
  const awkward = join(sandbox, 'awkward-repo');
  await core.init({ cwd: awkward });
  for (const [key, value] of [['user.name', 'Quote User'], ['user.email', 'quote@example.com']]) {
    await core.config({ cwd: awkward, action: 'set', key, value });
  }
  // A space, a single quote, a dollar sign and a semicolon — each of which a
  // naive quoter turns into a broken command or a second command.
  const tricky = "wei'rd $file;name.txt";
  writeFileSync(join(awkward, tricky), 'content\n');
  const awkwardStaged = await core.stage({ cwd: awkward, action: 'add', paths: [tricky] });
  check('a hostile filename can be staged', awkwardStaged.ok === true, staged);
  const awkwardStatus = await core.status({ cwd: awkward });
  check(
    'and it arrives whole in the status',
    awkwardStatus.staged.some((entry) => entry.path === tricky),
    awkwardStatus.staged.map((entry) => entry.path),
  );
  const awkwardCommit = await core.commit({ cwd: awkward, message: 'chore: awkward name' });
  check('and can be committed', awkwardCommit.ok === true, committed);
  const awkwardPatch = await core.diff({ cwd: awkward, scope: 'last-commit', paths: [tricky] });
  check('and its patch is readable', awkwardPatch.ok === true && awkwardPatch.patch.includes('content'), awkwardPatch.error ?? awkwardPatch.patch?.slice(0, 80));
  const awkwardLog = await core.log({ cwd: awkward, limit: 1 });
  check('with the commit recorded', awkwardLog.commits[0]?.subject === 'chore: awkward name', awkwardLog.commits[0]);

  // The quoter itself, for both shells.
  check('a quote is escaped for a POSIX shell', quoteFor("a'b", false) === `'a'\\''b'`, quoteFor("a'b", false));
  check('and doubled for PowerShell', quoteFor("a'b", true) === "'a''b'", quoteFor("a'b", true));
  check('a dollar sign stays literal', quoteFor('$HOME', false) === "'$HOME'" && quoteFor('$HOME', true) === "'$HOME'");

  section('the git invocation works under a Windows shell too');
  // Windows gets the Harness's PowerShell executor, where `VAR=value git …` is
  // not a command at all: it fails as an unknown term. The environment has to be
  // handed over as environment entries instead.
  await core.status({ cwd: toolRepo });
  check('the command carries no POSIX environment prefix', !/^[A-Z_]+=/.test(lastShellRequest.command), lastShellRequest.command);
  check('and starts with the interpreter-agnostic git call', lastShellRequest.command.startsWith('git --no-pager '), lastShellRequest.command);
  check(
    'the environment is passed as real entries',
    lastShellRequest.env?.GIT_TERMINAL_PROMPT === '0' && lastShellRequest.env?.GIT_PAGER === 'cat',
    lastShellRequest.env,
  );
  // A localized git both defeats the English phrase table in text.js and, on
  // Windows, comes back in the console code page as mojibake.
  check(
    'git is pinned to a single language',
    lastShellRequest.env?.LC_ALL === 'C' && lastShellRequest.env?.LANG === 'C',
    lastShellRequest.env,
  );
  check('the pager is disabled by a flag, not an assignment', lastShellRequest.command.includes('--no-pager'), lastShellRequest.command);

  // PowerShell doubles a quote; a POSIX shell closes, escapes and reopens.
  check('a POSIX argument is quoted for a POSIX shell', quoteFor("it's", false) === `'it'\\''s'`, quoteFor("it's", false));
  check('and quoted for PowerShell when that is the shell', quoteFor("it's", true) === "'it''s'", quoteFor("it's", true));
  check('a plain argument is quoted the same way in both', quoteFor('plain', false) === "'plain'" && quoteFor('plain', true) === "'plain'");

  // A Windows shell answers with CRLF, and every parser here splits on newlines.
  const crlfCore = createGitCore({
    exec: crlfExec(() => '## main\r\n M one.txt\r\n?? two.txt\r\n'),
    config: { defaultBranch: 'main' },
  });
  const crlfStatus = await crlfCore.status({ cwd: toolRepo });
  check(
    'a CRLF status read parses without stray carriage returns',
    crlfStatus.unstaged.every((entry) => !entry.path.includes('\r')) &&
      crlfStatus.untracked.every((path) => !path.includes('\r')),
    { unstaged: crlfStatus.unstaged, untracked: crlfStatus.untracked },
  );
  const crlfPatch = createGitCore({
    exec: crlfExec(() => 'diff --git a/x b/x\r\n--- a/x\r\n+++ b/x\r\n@@ -1 +1 @@\r\n-old\r\n+new\r\n'),
    config: { maxDiffBytes: 8000 },
  });
  const parsedCrlf = await crlfPatch.diff({ cwd: toolRepo });
  check(
    'a CRLF patch parses into clean rows',
    (parsedCrlf.rows ?? []).every((row) => !String(row.text ?? '').includes('\r')),
    parsedCrlf.rows,
  );

  section('undoing a commit is not the same as rewinding to it');
  // The panel's newest-commit button says "undo this commit", so the reset has to
  // step back one commit. Sending the clicked hash instead makes it
  // `reset --soft HEAD` — a no-op that reported itself as a rewind, which is what
  // a user saw as "it says it rewound but the list is empty".
  const undoTrail = join(sandbox, 'undo-trail');
  await core.init({ cwd: undoTrail });
  for (const [key, value] of [['user.name', 'Undo User'], ['user.email', 'undo@example.com']]) {
    await core.config({ cwd: undoTrail, action: 'set', key, value });
  }
  writeFileSync(join(undoTrail, 'first.txt'), 'first\n');
  await core.commit({ cwd: undoTrail, all: true, message: 'feat: first' });
  writeFileSync(join(undoTrail, 'second.txt'), 'second\n');
  await core.commit({ cwd: undoTrail, all: true, message: 'feat: second' });
  const headHash = (await core.log({ cwd: undoTrail, limit: 1 })).commits[0].hash;

  const rewindToHead = await core.resetLastCommit({ cwd: undoTrail, mode: 'soft', target: headHash });
  check('rewinding to the commit that is already HEAD changes nothing', rewindToHead.ok === true && rewindToHead.dropped === 0, rewindToHead);
  check('and it says so rather than reporting a rewind', rewindToHead.staged === 0 && rewindToHead.unstaged === 0, rewindToHead);
  check('the commit is still there afterwards', (await core.log({ cwd: undoTrail, limit: 1 })).commits[0].hash === headHash);

  // What the button actually promises: the commit goes away, its work stays staged.
  const undid = await core.resetLastCommit({ cwd: undoTrail, mode: 'soft' });
  check('undoing the newest commit keeps its changes staged', undid.ok === true && undid.staged === 1, undid);
  check('and names the commit it undid', undid.undone?.subject === 'feat: second', undid.undone);
  const afterUndo = await core.status({ cwd: undoTrail });
  check('so the file appears in the list', afterUndo.staged.some((entry) => entry.path === 'second.txt'), afterUndo.staged);
  check('and the branch moved back one commit', (await core.log({ cwd: undoTrail, limit: 1 })).commits[0].subject === 'feat: first');

  // The same trap one level down: rewinding to an older commit does discard work.
  // Two commits stack on top of 'feat: first', so going back to it drops two.
  for (const name of ['third', 'fourth']) {
    writeFileSync(join(undoTrail, `${name}.txt`), `${name}\n`);
    await core.commit({ cwd: undoTrail, all: true, message: `feat: ${name}` });
  }
  const older = (await core.log({ cwd: undoTrail, limit: 3 })).commits.at(-1);
  check('the rewind target is the oldest of the three', older.subject === 'feat: first', older.subject);
  const back = await core.resetLastCommit({ cwd: undoTrail, mode: 'soft', target: older.hash });
  check('rewinding to an older commit reports what it discarded', back.ok === true && back.dropped === 2, back);
  check('and leaves those changes staged', back.staged > 0, back);

  section('every view of the panel renders without throwing');
  {
    const Fragment = Symbol('Fragment');
    const stateOrder = [];
    const effectErrors = [];
    function runSafely(fn, label) {
      try {
        const cleanup = fn();
        return null;
      } catch (error) {
        return `${label}: ${error && error.message}\n${error && error.stack}`;
      }
    }
    let overrides = {};
    const React = {
      Fragment,
      createElement(type, props, ...children) {
        return { type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } };
      },
      useState: (initial) => {
        const value = typeof initial === 'function' ? initial() : initial;
        const index = stateOrder.length;
        stateOrder.push(value);
        return [overrides[index] === undefined ? value : overrides[index], () => {}];
      },
      useEffect: (fn) => { effectErrors.push(runSafely(fn, 'useEffect')); },
      useLayoutEffect: (fn) => { effectErrors.push(runSafely(fn, 'useLayoutEffect')); },
      useCallback: (fn) => fn,
      useMemo: (fn) => fn(),
      useRef: (initial) => ({ current: initial }),
      useContext: () => undefined,
      memo: (component) => component,
    };

    globalThis.setInterval = () => 0;
    globalThis.clearInterval = () => {};
    globalThis.setTimeout = () => 0;
    globalThis.clearTimeout = () => {};
    globalThis.requestAnimationFrame = () => 0;
    globalThis.cancelAnimationFrame = () => {};
    globalThis.fetch = () => new Promise(() => {});

    const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
    let load = null;
    globalThis.window = { __ModuleLoader__: { load: (r) => { load = r; } } };
    globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
    new Function('require', 'window', 'document', source)(
      (id) => { if (id === 'react') return React; throw new Error(`unexpected require(${id})`); },
      globalThis.window,
      globalThis.document,
    );

    const api = load.factory((id) => { if (id === 'react') return React; throw new Error(`unexpected require(${id})`); });
    let Panel = null;
    api.apply({
      effect: () => () => {},
      inject: (deps, cb) => { cb({ locale: { register: () => () => {}, bind: () => (k) => k } }); return () => {}; },
      get: () => undefined,
      sidebarRightTabs: { register: () => () => {} },
      slots: {
        register: (options, component) => { if (options?.name === 'sidebar.right.pane.tab') Panel = component; return () => {}; },
        inject: (key, callback) => { callback(); return () => {}; },
      },
      locale: { register: () => () => {}, bind: () => (k) => k },
      logger: { info() {}, warn() {}, error() {} },
    });

    function walk(node, seen) {
      if (node === null || node === undefined || typeof node === 'boolean') return;
      if (typeof node === 'string' || typeof node === 'number') return;
      if (Array.isArray(node)) { for (const child of node) walk(child, seen); return; }
      if (typeof node.type === 'function') {
        seen.count += 1;
        seen.names.add(node.type.name || 'anonymous');
        let rendered;
        try {
          rendered = node.type(node.props ?? {});
        } catch (error) {
          seen.errors.push(`${node.type.name || 'anonymous'}: ${error && error.message}\n${error && error.stack}`);
          return;
        }
        walk(rendered, seen);
        return;
      }
      walk(node.props?.children, seen);
    }

    const STATUS = {
      ok: true, isRepo: true, root: '/tmp/repo', branch: 'main', detached: false,
      upstream: 'origin/main', ahead: 1, behind: 0, operation: 'merge',
      staged: [{ path: 'a.js', status: 'modified', lines: { additions: 2, deletions: 1 } }],
      unstaged: [{ path: 'b.js', status: 'deleted', lines: { additions: 0, deletions: 4 } }],
      untracked: ['c.js'], conflicted: [{ path: 'd.js', status: 'unmerged' }], clean: false,
      identityConfigured: true, userName: 'u', userEmail: 'e', untrackedLines: { 'c.js': 3 },
    };
    const COMMIT = {
      hash: 'abcdef1234567890', shortHash: 'abcdef1', parents: [], subject: 'feat: x',
      author: 'u', date: '2026-10-12T00:00:00Z', refs: ['main', 'v1.0.0'],
    };
    const ROWS = [{ kind: 'hunk', text: '@@ -1 +1 @@' }, { kind: 'add', newNo: 1, text: 'x' }, { kind: 'del', oldNo: 1, text: 'y' }, { kind: 'context', oldNo: 2, newNo: 2, text: 'z', inline: ['a', 'b', 'c'] }, { kind: 'meta', text: 'mode changed' }];

    /** index: name, from the useState order in the source. */
    const base = {
      0: STATUS,
      11: { userName: '', userName: 'u', userEmail: 'e', scope: 'local' },
      13: [{ name: 'main', current: true, upstream: 'origin/main', track: '' }, { name: 'side', current: false, upstream: '', track: '' }],
      14: true,
      17: { writable: true, entryId: 'dsh-git', values: {} },
      18: { messageLanguage: 'auto', messageStyle: 'conventional', messageTemplate: 't', signoff: false, defaultBranch: 'main' },
      19: { ok: true, exists: true, current: 'node_modules/\n', groups: [{ id: 'node', label: 'Node', detected: true, entries: [], missing: 2 }], suggested: ['node'] },
      20: false,
      21: { ok: true, head: COMMIT.hash, branch: 'main', graph: { laneCount: 2, rows: [{ lane: 0, before: [], after: [0, 1], parentLanes: [0, 1] }] }, commits: [COMMIT] },
      22: COMMIT.hash,
      23: { [COMMIT.hash]: { ok: true, body: 'why', message: 'feat: x', files: [{ path: 'a.js', additions: 2, deletions: 1 }] } },
      24: { hash: COMMIT.hash, mode: 'hard' },
      25: COMMIT.hash,
      26: 'v1.0.0',
      28: { ok: true, findings: [{ path: 'a.js', line: 3, severity: 'bug', what: 'w', fix: 'f' }], dropped: 1 },
      29: { ok: true, complete: true, groups: [
        { message: 'feat: a', paths: ['a.js'], why: 'one thing' },
        { message: 'fix: b', paths: ['b.js'], why: 'another' },
      ] },
      30: { hash: COMMIT.hash, path: 'a.js' },
      31: { ok: true, rows: ROWS, flags: [], files: [] },
      32: [{ ref: 'stash@{0}', subject: 'wip', when: 'now' }],
      33: true,
      34: 120,
    };
        const repoStatus = {
          ok: true, isRepo: true, root: '/tmp/repo', branch: 'main', detached: false,
          upstream: 'origin/main', ahead: 1, behind: 0, operation: 'merge',
          staged: [{ path: 'a.js', status: 'modified', lines: { additions: 2, deletions: 1 } }],
          unstaged: [{ path: 'b.js', status: 'deleted', lines: { additions: 0, deletions: 4 } }],
          untracked: ['c.js'], conflicted: [{ path: 'd.js', status: 'unmerged' }], clean: false,
          identityConfigured: true, userName: 'u', userEmail: 'e', untrackedLines: { 'c.js': 3 },
        };
        const oneCommit = {
          hash: 'abcdef1234567890', shortHash: 'abcdef1', parents: [], subject: 'feat: x',
          author: 'u', date: '2026-10-12T00:00:00Z', refs: ['main', 'v1.0.0'],
        };
        const patchRows = [
          { kind: 'hunk', text: '@@ -1 +1 @@' },
          { kind: 'add', newNo: 1, text: 'x' },
          { kind: 'del', oldNo: 1, text: 'y' },
          { kind: 'context', oldNo: 2, newNo: 2, text: 'z', inline: ['a', 'b', 'c'] },
          { kind: 'meta', text: 'mode changed' },
        ];
        /** State slots are addressed by their index in the panel's own useState order. */
        const filled = {
          0: repoStatus,
          11: { userName: 'u', userEmail: 'e', scope: 'local' },
          13: [{ name: 'main', current: true, upstream: 'origin/main', track: '' }],
          14: true,
          17: { writable: true, entryId: 'dsh-git', values: {} },
          18: { messageLanguage: 'auto', messageStyle: 'conventional', messageTemplate: 't', signoff: false, defaultBranch: 'main' },
          19: { ok: true, exists: true, current: 'node_modules/\n', groups: [{ id: 'node', label: 'Node', detected: true, entries: [], missing: 2 }], suggested: ['node'] },
          21: { ok: true, head: oneCommit.hash, branch: 'main', graph: { laneCount: 2, rows: [{ lane: 0, before: [], after: [0, 1], parentLanes: [0, 1] }] }, commits: [oneCommit] },
          22: oneCommit.hash,
          23: { [oneCommit.hash]: { ok: true, body: 'why', message: 'feat: x', files: [{ path: 'a.js', additions: 2, deletions: 1 }] } },
          24: { hash: oneCommit.hash, mode: 'hard' },
          25: oneCommit.hash,
          26: 'v1.0.0',
          27: { ok: true, findings: [{ path: 'a.js', line: 3, severity: 'bug', what: 'w', fix: 'f' }], dropped: 1 },
          29: { ok: true, complete: true, groups: [{ message: 'feat: a', paths: ['a.js'], why: 'one thing' }] },
          30: { hash: oneCommit.hash, path: 'a.js' },
          31: { ok: true, rows: patchRows, flags: [], files: [] },
          32: [{ ref: 'stash@{0}', subject: 'wip', when: 'now' }],
          33: true,
          34: 120,
        };
        const scenarios = [
          ['a fresh mount', {}],
          ['no repository', { 0: { ok: true, isRepo: false, root: '/tmp/repo', reason: 'no .git here' } }],
          ['a failed status read', { 0: { ok: false, isRepo: false, error: 'git is not installed' } }],
          ['a clean tree', { 0: { ...repoStatus, clean: true, staged: [], unstaged: [], untracked: [], conflicted: [], operation: '', ahead: 0 } }],
          ['a detached HEAD', { 0: { ...repoStatus, detached: true, branch: '', upstream: '', operation: '' }, 13: [] }],
          ['a missing identity', { 0: { ...repoStatus, identityConfigured: false }, 11: { userName: '', userEmail: '', scope: 'local' } }],
          ['the changes view', { ...filled, 12: 'changes' }],
          ['the settings view', { ...filled, 12: 'settings' }],
          ['the history view', { ...filled, 12: 'history' }],
          ['the review in place of the list', { ...filled, 12: 'changes' }],
          ['the split in place of the list', { ...filled, 12: 'changes', 27: null }],
      ['a truncated split plan', { ...filled, 12: 'changes', 27: null, 29: { ok: true, complete: false, truncated: true, groups: [{ message: 'feat: a', paths: ['a.js'], why: 'x' }] } }],
      ['an unreadable split answer', { ...filled, 12: 'changes', 27: null, 29: { ok: true, complete: false, unparsed: true, truncated: true, groups: [], raw: 'not json' } }],
        ];

        const failures = [];
        const rendered = new Set();
        for (const [label, patch] of scenarios) {
          stateOrder.length = 0;
          effectErrors.length = 0;
          overrides = patch;
          const seen = { count: 0, errors: [], names: new Set() };
          walk(React.createElement(Panel, { sessionId: 's', usePanelInfo: () => ({ activePanelId: null }) }), seen);
          for (const name of seen.names) rendered.add(name);
          const bad = [...seen.errors, ...effectErrors.filter(Boolean)];
          if (bad.length > 0) failures.push(`${label}: ${bad[0].split('\n')[0]}`);
        }

        check('no view throws while rendering', failures.length === 0, failures);
        // A render that stops early reports no throw either, so the parts that only
        // appear deeper in the tree are named. FileRow is where a tooltip helper that
        // lived in the panel went missing: the slot caught the throw, retired the tab,
        // and left an empty pane behind.
        check('the file rows render', rendered.has('FileRow'), [...rendered].sort());
        check('the diff renderer renders', rendered.has('DiffBody'), [...rendered].sort());
        check('the commit graph renders', rendered.has('GraphCell') || rendered.has('GraphRow'), [...rendered].sort());
      }


  section('a .gitignore is tidied, not only appended to');
  const messyIgnore = [
    'node_modules/',
    '.DS_Store',
    'node_modules/',
    'node_modules/.cache/',
    'dist/',
    '',
    '',
    '*.log',
    'npm-debug.log*',
  ].join('\n');
  const tidiedUp = core.organizeGitignore(messyIgnore);
  const tidiedLines = tidiedUp.text.split('\n');
  check('an exact duplicate is dropped', !tidiedLines.includes('node_modules/') || tidiedLines.filter((line) => line === 'node_modules/').length === 1, tidiedLines);
  check('and reported as a duplicate', tidiedUp.removed.some((entry) => entry.reason === 'duplicate' && entry.line === 'node_modules/'), tidiedUp.removed);
  check(
    'a rule an earlier broader one covers is dropped',
    !tidiedLines.includes('node_modules/.cache/') &&
      tidiedUp.removed.some((entry) => entry.reason === 'covered' && entry.by === 'node_modules/'),
    tidiedUp.removed,
  );
  check('blank runs collapse to one', !tidiedUp.text.includes('\n\n\n'), JSON.stringify(tidiedUp.text));
  check('and it ends with a single newline', tidiedUp.text.endsWith('\n') && !tidiedUp.text.endsWith('\n\n'), JSON.stringify(tidiedUp.text.slice(-8)));
  check('entries are grouped under headings', tidiedUp.grouped === true && tidiedUp.text.includes('# Node'), tidiedLines.slice(0, 4));
  // Nothing that was there logically may disappear.
  for (const rule of ['dist/', '*.log', 'npm-debug.log*', '.DS_Store']) {
    check(`the rule ${rule} survives`, tidiedLines.includes(rule), tidiedLines);
  }

  // A glob never removes anything: `*.log` does not cover `npm-debug.log*`.
  check('a glob rule does not swallow other rules', tidiedLines.includes('npm-debug.log*'), tidiedLines);

  // Order is semantic once a negation exists, so nothing is dropped or moved.
  const negated = ['*.log', '!keep.log', 'dist/', 'dist/'].join('\n');
  const negatedResult = core.organizeGitignore(negated);
  // Removing an exact duplicate never changes meaning, negation or not; dropping a
  // "covered" rule could, because a `!` line may re-include it.
  check(
    'a negation stops the covered-rule dropping',
    negatedResult.removed.every((entry) => entry.reason === 'duplicate'),
    negatedResult.removed,
  );
  check(
    'while exact duplicates are still collapsed',
    negatedResult.text.split('\n').filter((line) => line === 'dist/').length === 1,
    negatedResult.text,
  );
  check('and stops the reordering', negatedResult.grouped === false, negatedResult.grouped);
  check('so the file keeps its shape', negatedResult.text.startsWith('*.log\n!keep.log'), JSON.stringify(negatedResult.text));

  // A file someone annotated is a file someone organised on purpose.
  const commented = ['# mine, in this order', '.DS_Store', 'node_modules/'].join('\n');
  const commentedResult = core.organizeGitignore(commented);
  check('a hand-written comment stops the reordering', commentedResult.grouped === false, commentedResult.grouped);
  check('but duplicates are still removed', core.organizeGitignore('# x\ndist/\ndist/').removed.length === 1);

  // Idempotence: a second pass must find nothing left to do, or the button would
  // rewrite the file every time it is pressed.
  const secondPass = core.organizeGitignore(tidiedUp.text);
  check('tidying twice changes nothing', secondPass.text === tidiedUp.text && secondPass.removed.length === 0, secondPass.removed);

  section('the panel never reads a binding before it exists');
  // A `const` in the panel body sits in its temporal dead zone until the line
  // that declares it, and two positions are evaluated *during* the render: a
  // dependency array, and any expression outside a callback. Reading a later
  // binding from either throws, the slot entry blanks, and the user gets an empty
  // panel — which is how the stash effect and the abort label both broke.
  /**
   * Blank comments and literal text so their contents are not read as code.
   *
   * A template literal is special: its text is not code, but a `${…}`
   * interpolation is evaluated where the template is, so those are kept.
   */
  function stripLiterals(line) {
    let out = '';
    let quote = null;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (quote === "'" || quote === '"') {
        if (ch === '\\') { i += 1; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (quote === '`') {
        if (ch === '\\') { i += 1; continue; }
        if (ch === '`') { quote = null; continue; }
        if (ch === '$' && line[i + 1] === '{') {
          let depth = 0;
          let end = i + 1;
          for (; end < line.length; end += 1) {
            if (line[end] === '{') depth += 1;
            else if (line[end] === '}') { depth -= 1; if (depth === 0) break; }
          }
          out += ` ${line.slice(i + 2, end)} `;
          i = end;
        }
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ' '; continue; }
      if (ch === '/' && line[i + 1] === '/') break;
      out += ch;
    }
    return out;
  }

  /** Blank `=> { … }` and `=> rest-of-line` bodies: they run when called, not now. */
  function stripDeferred(text) {
    let out = text;
    for (let index = out.indexOf('=>'); index !== -1; index = out.indexOf('=>', index + 1)) {
      let cursor = index + 2;
      while (cursor < out.length && /\s/.test(out[cursor])) cursor += 1;
      if (out[cursor] === '{') {
        let depth = 0;
        let end = cursor;
        for (; end < out.length; end += 1) {
          if (out[end] === '{') depth += 1;
          else if (out[end] === '}') { depth -= 1; if (depth === 0) break; }
        }
        out = out.slice(0, cursor) + ' '.repeat(end - cursor + 1) + out.slice(end + 1);
      } else {
        let end = out.indexOf('\n', cursor);
        if (end === -1) end = out.length;
        out = out.slice(0, cursor) + ' '.repeat(end - cursor) + out.slice(end);
      }
    }
    return out;
  }

  function findRenderOrderProblems(source) {
    const lines = source.split('\n');
    const code = lines.map(stripLiterals);
    const params = new Set();
    for (const line of code) {
      for (const match of line.matchAll(/function\s+[A-Za-z_$][\w$]*\s*\(([^)]*)\)/g)) {
        for (const raw of match[1].split(',')) {
          const name = raw.trim().split(/[=:]/)[0].trim();
          if (/^[A-Za-z_$][\w$]*$/.test(name)) params.add(name);
        }
      }
    }
    const decls = [];
    code.forEach((line, index) => {
      const match = /^ {8}const ([A-Za-z_$][\w$]*)\s*=\s*(.*)$/.exec(line);
      if (match) decls.push({ name: match[1], line: index + 1, init: match[2] });
    });
    const declaredAt = new Map();
    for (const decl of decls) if (!declaredAt.has(decl.name) && !params.has(decl.name)) declaredAt.set(decl.name, decl.line);

    const deferred = /^(useCallback|useMemo|useState|useRef|useEffect)\(/;
    const problems = [];
    for (const decl of decls) {
      if (deferred.test(decl.init)) continue;
      let end = decl.line;
      while (end < lines.length && !/;\s*$/.test(code[end - 1])) end += 1;
      const text = stripDeferred(code.slice(decl.line - 1, end).join('\n'));
      for (const [name, line] of declaredAt) {
        if (name === decl.name || line <= decl.line) continue;
        const pattern = new RegExp(`(^|[^\\w$.])${name}\\b`, 'g');
        let match = pattern.exec(text);
        let read = false;
        while (match !== null) {
          const at = match.index + match[1].length;
          const before = text.slice(0, at).replace(/\s+$/, '').slice(-1);
          // `{ commit: … }` is an object key, not a read of a binding named commit.
          const isKey = /^\s*:/.test(text.slice(at + name.length)) && (before === '{' || before === ',');
          if (!isKey) {
            read = true;
            break;
          }
          match = pattern.exec(text);
        }
        if (read) problems.push(`eager: ${decl.name} (line ${decl.line}) reads ${name} declared at line ${line}`);
      }
    }
    code.forEach((line, index) => {
      const match = /^\s*\},\s*\[([^\]]*)\]\)?;?\s*$/.exec(line);
      if (!match) return;
      for (const raw of match[1].split(',')) {
        const name = raw.trim();
        if (name === '' || !declaredAt.has(name)) continue;
        if (declaredAt.get(name) > index + 1) {
          problems.push(`deps: line ${index + 1} depends on ${name} declared at line ${declaredAt.get(name)}`);
        }
      }
    });
    return problems;
  }

  const panelSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  const orderProblems = findRenderOrderProblems(panelSource);
  check('no binding is read before it is declared', orderProblems.length === 0, orderProblems);

  // The shell draws its own tooltips, so a native `title` never surfaces in a
  // plugin's markup: hover text has to go through the panel's own bubble.
  const strayTitles = [...panelSource.matchAll(/^\s*title: (.+)$/gm)].map((match) => match[1].trim());
  check(
    'panel controls do not rely on the native title attribute',
    strayTitles.every((value) => value.startsWith('option.title') || value.startsWith('() =>')),
    strayTitles,
  );
  // Every operation takes the whole panel out of service while it runs, so a
  // silent panel reads as a frozen one: each of them has to name itself.
  const busyKinds = new Set([
    ...[...panelSource.matchAll(/act\('([a-zA-Z]+)'/g)].map((match) => match[1]),
    ...[...panelSource.matchAll(/setBusy\('([a-zA-Z]+)'\)/g)].map((match) => match[1]),
  ]);
  const busyLabelled = new Set([...panelSource.matchAll(/^\s+([a-zA-Z]+): t\('busy/gm)].map((match) => match[1]));
  check(
    'every operation that blocks the panel says what it is doing',
    [...busyKinds].filter((kind) => !busyLabelled.has(kind)).length === 0,
    [...busyKinds].filter((kind) => !busyLabelled.has(kind)),
  );
  // `unavailable` is not a transient failure: every probe re-attempts the same
  // sandbox start-up, and on Windows a failed one has been observed to leave the
  // whole run unable to write. The panel says so once and offers a retry.
  check(
    'the poll stops when git cannot run at all',
    /if \(unavailableRef\.current\) return;/.test(panelSource) &&
      /unavailableRef\.current = answer\.value\?\.unavailable === true/.test(panelSource),
  );
  check(
    'and the error card offers a retry instead',
    panelSource.includes("t('gitUnavailableTitle')") && panelSource.includes("onClick: () => void refresh(true)"),
  );
  check(
    'and the wait is visible rather than only disabling controls',
    panelSource.includes('dsg-toast-running') && panelSource.includes('dsg-spin'),
  );
  // Both floating messages hang off the list area, so they land above the splitter
  // and above the commit box rather than over it.
  check(
    'the running notice and the messages share one layer',
    (panelSource.match(/className: 'dsg-toasts'/g) ?? []).length === 1 &&
      panelSource.includes("'dsg-note dsg-toast dsg-toast-running'"),
    (panelSource.match(/className: 'dsg-toasts'/g) ?? []).length,
  );
  check(
    'and that layer is inside the list area, not the panel root',
    /\n\s+toasts,\n\s+\),\n\s+tooltip === null/.test(panelSource),
  );
  check(
    'the floating surface is opaque rather than a translucent wash',
    !/\.dsg-toast \{[^}]*background:var\(--dsw-alias-bg-overlay\)/.test(panelSource) &&
      !panelSource.includes('dsg-running'),
  );

  check(
    'the model-backed controls carry an AI mark',
    (panelSource.match(/aiChip\(/g) ?? []).length >= 6,
    (panelSource.match(/aiChip\(/g) ?? []).length,
  );

  section('the panel only names theme tokens that exist');
  // The published alias set, exactly as the live client Theme provider reports it
  // (cordis_inspect_query, platform=client, provider=Theme, method=listTokens).
  // A token that is not in this list resolves to nothing, which fails silently:
  // `color: var(--made-up)` computes to `unset`, so the text inherits whatever it
  // is sitting on. A chip filled with the brand alias — near-white in the dark
  // theme — then inherits near-white text and renders as a blank white block.
  const THEME_TOKENS = new Set([
    '--dsw-alias-bg-base',
    '--dsw-alias-bg-layer-1',
    '--dsw-alias-bg-layer-2',
    '--dsw-alias-bg-overlay',
    '--dsw-alias-border-l1',
    '--dsw-alias-border-l2',
    '--dsw-alias-brand-primary',
    '--dsw-alias-label-primary',
    '--dsw-alias-label-secondary',
    '--dsw-alias-state-error-primary',
    '--dsw-alias-state-idle-primary',
    '--dsw-alias-state-success-primary',
    '--dsw-alias-state-warn-primary',
    '--dsw-specific-sidebar-fill',
  ]);
  const clientSourceForStyles = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  const referenced = [...new Set([...clientSourceForStyles.matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map((match) => match[1]))];
  check('references at least one token', referenced.length >= 8, referenced.length);
  check(
    'every referenced token is published by the theme',
    referenced.every((token) => THEME_TOKENS.has(token)),
    referenced.filter((token) => !THEME_TOKENS.has(token)),
  );
  // The brand alias is the theme's ink colour, so the text on it is bg-base —
  // the same pairing the primary button has always used.
  check(
    'the brand fill is paired with a real inverse',
    /\.dsg-choice-on \{[^}]*background:var\(--dsw-alias-brand-primary\)[^}]*color:var\(--dsw-alias-bg-base\)[^}]*\}/.test(clientSourceForStyles),
    (clientSourceForStyles.match(/\.dsg-choice-on \{[^}]*\}/) ?? ['(rule not found)'])[0],
  );
  // A stylesheet lives inside a template literal, so a stray backtick in a
  // comment ends it early and takes the bundle down with it.
  const stylesheet = /children: `([\s\S]*?)`,\n      \}\);/.exec(clientSourceForStyles)?.[1] ?? '';
  check('the stylesheet was found', stylesheet.length > 4000, stylesheet.length);
  check('no backtick survives inside the stylesheet', !stylesheet.includes('`'));
  // State-coloured actions must tint with the state alias and keep the label on
  // the readable alias; the state colours are mid-tone in both themes, so using
  // one as text on the base background lands near 2:1 contrast.
  for (const [name, token] of [['success', '--dsw-alias-state-success-primary'], ['warn', '--dsw-alias-state-warn-primary']]) {
    const rule = new RegExp(`\\.dsg-btn-${name} \\{[^}]*\\}`).exec(clientSourceForStyles)?.[0] ?? '';
    check(`the ${name} action tints with its state alias`, rule.includes(`color-mix(in srgb, var(${token})`), rule);
    check(`the ${name} action keeps a readable label`, rule.includes('color:var(--dsw-alias-label-primary)'), rule);
    check(`the ${name} action declares a fallback first`, /background:var\(--dsw-alias-bg-base\);\s*background:color-mix/.test(rule), rule);
  }
  check(
    'the stylesheet uses no literal colour',
    !/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(stylesheet),
    (stylesheet.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g) ?? []).slice(0, 5),
  );

  section('package manifest agrees with itself');
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  const declaredId = /__ModuleLoader__\.load\(\{\s*(?:\/\/[^\n]*\n\s*)*id:\s*'([^']+)'/.exec(clientSource)?.[1];
  // dsh-client-modules keys the browser module table by PACKAGE NAME: it registers
  // a bundle under the id the bundle declares and looks it up by the entry's
  // package name. When those disagree the graph row has no factory and the whole
  // renderer refuses to boot — the app opens in startup recovery instead of
  // loading. That is exactly what renaming the package once did here.
  check('the client bundle declares the package name as its module id', declaredId === manifest.name, {
    declared: declaredId,
    packageName: manifest.name,
  });
  check('the manifest is no longer private', manifest.private !== true);
  check('the bundle patch exists', existsSync(new URL(`../${manifest.dsh.bundle.patch.replace('./', '')}`, import.meta.url)));
  check('the client entry point exists', existsSync(new URL(`../${manifest.exports['./client'].replace('./', '')}`, import.meta.url)));
  check('the host entry point exists', existsSync(new URL(`../${manifest.main.replace('./', '')}`, import.meta.url)));
  check('the icon exists', existsSync(new URL(`../${manifest.icon.replace('./', '')}`, import.meta.url)));
  for (const locale of ['zh', 'en']) {
    check(`the ${locale} locale ships`, existsSync(new URL(`../locale/${locale}.json`, import.meta.url)));
  }
  // Every file a fresh install needs must be reachable through `files`, or the
  // published package installs without its own entry point.
  for (const needed of ['lib', 'locale', 'cordis.patch.yml', 'icon.svg']) {
    check(`${needed} is included in the published files`, manifest.files.includes(needed), manifest.files);
  }
  check('the loader row names the package', readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8').includes(`name: '${manifest.name}'`));

  section('commit graph lanes');
  const linear = buildGraph([{ hash: 'c', parents: ['b'] }, { hash: 'b', parents: ['a'] }, { hash: 'a', parents: [] }]);
  check('a linear history is one lane', linear.laneCount === 1 && linear.rows.every((row) => row.lane === 0), linear);
  check('the oldest commit ends its lane', linear.rows[2].after.length === 0 && linear.rows[2].before.length === 1, linear.rows[2]);
  check('a middle commit keeps its lane open', linear.rows[1].before[0] === 0 && linear.rows[1].after[0] === 0, linear.rows[1]);

  const merged = buildGraph([
    { hash: 'm', parents: ['a', 'b'] },
    { hash: 'a', parents: ['c'] },
    { hash: 'b', parents: ['c'] },
    { hash: 'c', parents: [] },
  ]);
  check('a merge opens a second lane', merged.laneCount === 2, merged);
  check('the merge row links both parents', merged.rows[0].parentLanes.join(',') === '0,1', merged.rows[0]);
  check('the second branch gets its own lane', merged.rows[2].lane === 1, merged.rows[2]);
  check('both branches rejoin at the shared parent', merged.rows[3].before.join(',') === '0,1', merged.rows[3]);

  const branchy = buildGraph([
    { hash: 't2', parents: ['t1'] },
    { hash: 't1', parents: ['base'] },
    { hash: 'main2', parents: ['base'] },
    { hash: 'base', parents: [] },
  ]);
  check('a second head takes a free lane', branchy.rows[2].lane === 1, branchy.rows[2]);
  check('the shared ancestor rejoins them', branchy.rows[3].before.join(',') === '0,1', branchy.rows[3]);
  check('the graph never reports fewer than one lane', buildGraph([]).laneCount === 1 && buildGraph([]).rows.length === 0);

  section('history for the graph view');
  const historyRepo = join(sandbox, 'history-repo');
  await core.init({ cwd: historyRepo });
  await core.config({ cwd: historyRepo, action: 'set', key: 'user.name', value: 'Graph User' });
  await core.config({ cwd: historyRepo, action: 'set', key: 'user.email', value: 'graph@example.com' });
  const emptyHistory = await core.history({ cwd: historyRepo });
  check('an empty repository reports no commits instead of failing', emptyHistory.ok === true && emptyHistory.commits.length === 0, emptyHistory);
  check('and still describes a graph', emptyHistory.graph.laneCount === 1 && emptyHistory.graph.rows.length === 0, emptyHistory.graph);

  for (const [file, text, message] of [
    ['a.txt', 'one\n', 'feat: first'],
    ['b.txt', 'two\n', 'feat: second'],
  ]) {
    writeFileSync(join(historyRepo, file), text);
    await core.stage({ cwd: historyRepo, action: 'add' });
    await core.commit({ cwd: historyRepo, message });
  }
  await core.branch({ cwd: historyRepo, action: 'create', name: 'feature/graph' });
  writeFileSync(join(historyRepo, 'c.txt'), 'three\n');
  await core.commit({ cwd: historyRepo, all: true, message: 'feat: on the branch' });
  await core.branch({ cwd: historyRepo, action: 'switch', name: 'main' });
  writeFileSync(join(historyRepo, 'd.txt'), 'four\n');
  await core.commit({ cwd: historyRepo, all: true, message: 'feat: on main' });
  const graphRepo = await core.history({ cwd: historyRepo, limit: 20 });
  // Both branch tips are within the same second, so the order between them is
  // the graph's business, not this test's: what matters is that both are here.
  const subjects = graphRepo.commits.map((c) => c.subject);
  check(
    'lists every branch, not just the checked-out one',
    graphRepo.commits.length === 4 &&
      subjects.includes('feat: on main') &&
      subjects.includes('feat: on the branch') &&
      subjects.at(-1) === 'feat: first',
    subjects,
  );
  check(
    'says which commit HEAD points at',
    graphRepo.commits.some((c) => c.hash === graphRepo.head && c.refs.includes('main')),
    { head: graphRepo.head, tips: graphRepo.commits.slice(0, 2).map((c) => [c.subject, c.refs]) },
  );
  check('gives every commit a short hash', graphRepo.commits.every((c) => c.shortHash.length === 7), graphRepo.commits.map((c) => c.shortHash));
  check('links each commit to its parents', graphRepo.commits[0].parents.length === 1, graphRepo.commits[0]);
  check('the root commit has no parent', graphRepo.commits.at(-1).parents.length === 0, graphRepo.commits.at(-1));
  check('produces one graph row per commit', graphRepo.graph.rows.length === graphRepo.commits.length, graphRepo.graph.rows.length);
  check('detects the divergence as two lanes', graphRepo.graph.laneCount === 2, graphRepo.graph);
  check('names the branch that points at a commit', graphRepo.commits.some((c) => c.refs.includes('feature/graph')), graphRepo.commits.map((c) => c.refs));
  check('names the checked-out branch', graphRepo.commits.some((c) => c.refs.includes('main')), graphRepo.commits.map((c) => c.refs));
  check('reports the current branch', graphRepo.branch === 'main', graphRepo.branch);
  check('honours the limit', (await core.history({ cwd: historyRepo, limit: 2 })).commits.length === 2);

  section('per-file line counts for the panel');
  const counted = await core.status({ cwd: toolRepo, withCounts: true });
  check('counts are opt-in', (await core.status({ cwd: toolRepo })).staged.every((e) => e.lines === undefined));
  check('reports counts when asked', counted.ok === true, counted);
  check('reports nothing to count on a clean tree', counted.staged.length === 0 && counted.unstaged.length === 0, counted);

  writeFileSync(join(toolRepo, 'app.js'), 'line one\nline two\nline three\n');
  writeFileSync(join(toolRepo, 'brand-new.txt'), 'a\nb\nc\nd\n');
  const dirty = await core.status({ cwd: toolRepo, withCounts: true });
  const changed = dirty.unstaged.find((entry) => entry.path === 'app.js');
  check('attaches a count to a modified file', changed?.lines?.additions >= 1 && changed?.lines?.deletions >= 1, changed);
  check('counts an untracked file by its lines', dirty.untrackedLines['brand-new.txt'] === 4, dirty.untrackedLines);

  await core.stage({ cwd: toolRepo, action: 'add', paths: ['app.js'] });
  const stagedCounts = await core.status({ cwd: toolRepo, withCounts: true });
  check('attaches a count to a staged file', stagedCounts.staged.find((e) => e.path === 'app.js')?.lines !== undefined, stagedCounts.staged);
  await core.stage({ cwd: toolRepo, action: 'discard', paths: ['app.js'] });
  await core.stage({ cwd: toolRepo, action: 'unstage' });
  rmSync(join(toolRepo, 'brand-new.txt'), { force: true });

  section('panel bridge');
  check(
    'opens the exact Fetch route under /api',
    panel.route?.path === '/api/dsh-git' && panel.route?.methods.includes('POST') && panel.route?.requestBody === 'buffered',
    { path: panel.route?.path, methods: panel.route?.methods, body: panel.route?.requestBody },
  );

  /**
   * Drive the real Fetch handler the way the browser does, so the transport
   * checks (body parsing, envelope shape, status codes) are covered too.
   */
  const ask = async (endpoint, payload) => {
    const request = new Request('http://localhost/api/dsh-git', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint, ...payload }),
    });
    const response = await panel.route.fetch(request);
    return { status: response.status, body: await response.json() };
  };

  const malformed = await panel.route.fetch(
    new Request('http://localhost/api/dsh-git', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' }),
  );
  check('rejects a body that is not JSON', malformed.status === 400, malformed.status);

  const noEndpoint = await panel.route.fetch(
    new Request('http://localhost/api/dsh-git', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
  );
  check('rejects a body with no endpoint', noEndpoint.status === 400, noEndpoint.status);

  const unknownEndpoint = await ask('nope', { sessionId: 'session-panel' });
  check(
    'refuses an unknown endpoint',
    unknownEndpoint.status === 200 && unknownEndpoint.body.ok === false && unknownEndpoint.body.error.code === 'dsh-git/unknown-endpoint',
    unknownEndpoint.body.error,
  );

  const unknownSession = await ask('status', { sessionId: 'session-gone' });
  check(
    'refuses a session that is not live',
    unknownSession.body.ok === false && unknownSession.body.error.code === 'dsh-git/no-session',
    unknownSession.body.error,
  );

  const panelStatus = (await ask('status', { sessionId: 'session-panel' })).body;
  check('answers the panel with repository state', panelStatus.ok === true && panelStatus.value.isRepo === true, panelStatus);
  check('folds the identity probe into the status round trip', panelStatus.value.identityConfigured === true, panelStatus.value);

  const panelReadName = (await ask('config', { sessionId: 'session-panel', action: 'get', key: 'user.name' })).body;
  check('reads configuration through the bridge', panelReadName.ok === true && panelReadName.value.value === 'Tool User', panelReadName.value);
  const wroteName = (await ask('config', { sessionId: 'session-panel', action: 'set', key: 'user.name', value: 'Panel User', scope: 'local' })).body;
  check('writes configuration through the bridge', wroteName.ok === true && wroteName.value.written === true, wroteName.value);
  check(
    'the written value reads back',
    (await ask('config', { sessionId: 'session-panel', action: 'get', key: 'user.name' })).body.value.value === 'Panel User',
  );

  writeFileSync(join(toolRepo, 'panel.js'), 'export const panel = true;\n');
  const stagedViaPanel = (await ask('stage', { sessionId: 'session-panel', action: 'add', paths: ['panel.js'] })).body;
  check('stages through the bridge', stagedViaPanel.ok === true && stagedViaPanel.value.ok === true, stagedViaPanel.value);

  const stagedDiff = (await ask('diff', { sessionId: 'session-panel', scope: 'staged', paths: ['panel.js'] })).body;
  check(
    'hands the panel parsed rows instead of a raw patch',
    stagedDiff.ok === true &&
      stagedDiff.value.patch === undefined &&
      Array.isArray(stagedDiff.value.rows) &&
      stagedDiff.value.rows.some((row) => row.kind === 'add' && row.text.includes('panel = true')),
    stagedDiff.value,
  );
  check(
    'numbers the added row on the new side',
    stagedDiff.value.rows.find((row) => row.kind === 'add')?.newNo === 1,
    stagedDiff.value.rows,
  );

  const committedViaPanel = (await ask('commit', { sessionId: 'session-panel', message: 'feat(panel): add the panel entry' })).body;
  check('commits through the bridge', committedViaPanel.ok === true && committedViaPanel.value.ok === true, committedViaPanel.value);

  const logViaPanel = (await ask('log', { sessionId: 'session-panel', limit: 3 })).body;
  check(
    'lists history through the bridge',
    logViaPanel.ok === true && logViaPanel.value.commits.some((entry) => entry.subject === 'feat(panel): add the panel entry'),
    logViaPanel.value?.commits,
  );

  writeFileSync(join(toolRepo, 'fresh-preview.js'), 'export const preview = 1;\n');
  const untrackedDiff = (await ask('diff', { sessionId: 'session-panel', scope: 'unstaged', paths: ['fresh-preview.js'] })).body;
  check(
    'shows an untracked file as additions instead of an empty pane',
    untrackedDiff.ok === true &&
      untrackedDiff.value.flags.includes('new') &&
      untrackedDiff.value.rows.filter((row) => row.kind === 'add').length === 2 &&
      untrackedDiff.value.rows.some((row) => row.kind === 'add' && row.text.includes('export const preview = 1;')),
    untrackedDiff.value,
  );

  const panelGenerated = (await ask('generateMessage', { sessionId: 'session-panel' })).body;
  check('reports why message generation is unavailable, not a crash', panelGenerated.ok === true && panelGenerated.value.ok === false, panelGenerated.value);

  const explained = (await ask('explain', { sessionId: 'session-panel', scope: 'last-commit', path: 'panel.js' })).body;
  check('reports why an explanation is unavailable, not a crash', explained.ok === true && explained.value.ok === false, explained.value);
  const noPath = (await ask('explain', { sessionId: 'session-panel' })).body;
  check('refuses an explanation with no path', noPath.ok === false && noPath.error.code === 'dsh-git/bad-request', noPath.error);

  writeFileSync(join(toolRepo, 'package.json'), '{}\n');
  const plan = (await ask('gitignore', { sessionId: 'session-panel' })).body;
  check('plans .gitignore groups', plan.ok === true && plan.value.ok === true, plan.value);
  check('detects the repository language', plan.value.groups.some((group) => group.id === 'node' && group.detected), plan.value.groups?.map((g) => [g.id, g.detected]));
  const nodeMissingBefore = plan.value.groups.find((group) => group.id === 'node').missing;
  const ignored = (await ask('gitignore', { sessionId: 'session-panel', action: 'write', entries: ['dist/', '.env', 'node_modules/'] })).body;
  check('writes the patterns it is given', ignored.ok === true && ignored.value.added.includes('.env') && ignored.value.added.includes('dist/'), ignored.value);
  check('does not repeat a line already present', !ignored.value.added.includes('node_modules/'), ignored.value.added);
  // Every pattern that was actually written stops counting as missing; one of the
  // three was already in the file, so the drop is measured, not assumed.
  const nodeEntries = plan.value.groups.find((group) => group.id === 'node').entries;
  const addedToNode = ignored.value.added.filter((entry) => nodeEntries.includes(entry)).length;
  const nodeMissingAfter = ignored.value.plan.groups.find((group) => group.id === 'node').missing;
  check(
    'reports the new state',
    addedToNode > 0 && nodeMissingAfter === nodeMissingBefore - addedToNode,
    { before: nodeMissingBefore, after: nodeMissingAfter, addedToNode, added: ignored.value.added },
  );
  const ignoredAgain = (await ask('gitignore', { sessionId: 'session-panel', action: 'write', entries: ['dist/'] })).body;
  check('is idempotent', ignoredAgain.value.unchanged === true, ignoredAgain.value);
  const noEntries = (await ask('gitignore', { sessionId: 'session-panel', action: 'write', entries: [] })).body;
  check('refuses a write with nothing in it', noEntries.ok === false, noEntries);

  const settingsRead = (await ask('settings', { sessionId: 'session-panel' })).body;
  check('reads the plugin settings', settingsRead.ok === true && settingsRead.value.values.messageLanguage === 'auto', settingsRead.value);
  check('reports the config row it would write', settingsRead.value.entryId === 'dsh-git' && settingsRead.value.writable === true, settingsRead.value);
  const settingsWrite = (await ask('settings', { sessionId: 'session-panel', action: 'set', values: { messageLanguage: 'zh', messageStyle: 'plain', messageTemplate: '以模块名开头' } })).body;
  check('persists recognized settings', settingsWrite.ok === true && settingsWrite.value.ok === true && settingsWrite.value.saved.messageLanguage === 'zh', settingsWrite.value);
  check('writes through the configuration editor', configWrites.length === 1 && configWrites[0].entry.options.id === 'dsh-git', configWrites.length);
  check('restates the whole config, not just the change', configWrites[0].next.defaultBranch === 'main' && configWrites[0].next.messageTemplate === '以模块名开头', configWrites[0]?.next && Object.keys(configWrites[0].next));
  const settingsRejected = (await ask('settings', { sessionId: 'session-panel', action: 'set', values: { messageLanguage: 'klingon' } })).body;
  check('ignores an unrecognized setting value', settingsRejected.value.ok === false, settingsRejected.value);
  // Message generation always runs on the session's model, so the panel exposes
  // no provider/model pair at all and must not accept one.
  const modelAttempt = (await ask('settings', { sessionId: 'session-panel', action: 'set', values: { provider: 'x', model: 'y' } })).body;
  check('refuses a model override', modelAttempt.value.ok === false, modelAttempt.value);
  check(
    'exposes no provider or model setting to the panel',
    !Object.hasOwn(settingsRead.value.values, 'provider') && !Object.hasOwn(settingsRead.value.values, 'model'),
    Object.keys(settingsRead.value.values),
  );
  const branchAttempt = (await ask('settings', { sessionId: 'session-panel', action: 'set', values: { defaultBranch: 'trunk' } })).body;
  check('only accepts a branch the panel can offer', branchAttempt.value.ok === false, branchAttempt.value);
  const branchOk = (await ask('settings', { sessionId: 'session-panel', action: 'set', values: { defaultBranch: 'master' } })).body;
  check('accepts the other offered branch', branchOk.value.ok === true && branchOk.value.saved.defaultBranch === 'master', branchOk.value);

  section('gitignore inference through the bridge');
  // Its own directory, so "nothing there yet" is a fact rather than an accident
  // of what earlier sections already wrote.
  const ignoreRepo = join(sandbox, 'ignore-repo');
  mkdirSync(join(ignoreRepo, 'node_modules', 'left-pad'), { recursive: true });
  writeFileSync(join(ignoreRepo, 'package.json'), '{"name":"ignore-repo","version":"1.0.0"}\n');
  sessionCwds['session-ignore'] = ignoreRepo;

  const inferred = (await ask('gitignoreSuggest', { sessionId: 'session-ignore', mode: 'init' })).body;
  check(
    'infers patterns without a model, falling back to the built-in rules',
    inferred.value.ok === true && inferred.value.source === 'heuristic' && inferred.value.patterns.length > 0,
    { source: inferred.value.source, count: inferred.value.patterns?.length },
  );
  check('says why it fell back rather than pretending', /no model/i.test(inferred.value.note ?? ''), inferred.value.note);
  check('proposes the Node artefacts this project needs', inferred.value.patterns.includes('node_modules/'), inferred.value.patterns);
  check('reports that no .gitignore exists yet', inferred.value.exists === false, inferred.value.exists);
  check('everything proposed would be added', inferred.value.added.length === inferred.value.patterns.length, inferred.value.added);

  const ignoreWritten = (await ask('gitignore', { sessionId: 'session-ignore', action: 'write', entries: inferred.value.added })).body;
  check('writes what the inference proposed', ignoreWritten.value.ok === true && ignoreWritten.value.added.length > 0, ignoreWritten.value);
  check(
    'the file now exists on disk',
    readFileSync(join(ignoreRepo, '.gitignore'), 'utf8').includes('node_modules/'),
    readFileSync(join(ignoreRepo, '.gitignore'), 'utf8').slice(0, 60),
  );

  const inferredAgain = (await ask('gitignoreSuggest', { sessionId: 'session-ignore', mode: 'optimize' })).body;
  check('a second pass sees the file it just wrote', inferredAgain.value.exists === true, inferredAgain.value.exists);
  check('and has nothing left to add', inferredAgain.value.ok === true && inferredAgain.value.added.length === 0, inferredAgain.value.added);

  // A user's own line must survive both passes.
  writeFileSync(join(ignoreRepo, '.gitignore'), `${readFileSync(join(ignoreRepo, '.gitignore'), 'utf8')}my-own-note.txt\n`);
  await ask('gitignoreSuggest', { sessionId: 'session-ignore', mode: 'optimize' });
  check(
    'never rewrites a line the user wrote',
    readFileSync(join(ignoreRepo, '.gitignore'), 'utf8').includes('my-own-note.txt'),
    readFileSync(join(ignoreRepo, '.gitignore'), 'utf8').slice(-40),
  );

  const undone = (await ask('reset', { sessionId: 'session-panel', mode: 'soft' })).body;
  check('undoes the last commit through the bridge', undone.ok === true && undone.value.ok === true && undone.value.undone.subject === 'feat(panel): add the panel entry', undone.value);
  check('reports the state after undoing', undone.value.staged >= 1, undone.value);
  const restored = (await ask('commit', { sessionId: 'session-panel', message: 'feat(panel): add the panel entry' })).body;
  check('re-commits what was undone', restored.ok === true && restored.value.ok === true, restored.value);

  section('review findings are checked against what was staged');
  const keptFinding = normalizeFindings(
    '```json\n[{"path":"a.js","line":3,"severity":"bug","what":"x","fix":"y"},{"path":"ghost.js","line":1,"severity":"bug","what":"invented"}]\n```',
    ['a.js'],
  );
  check('keeps a finding that names a staged path', keptFinding.findings.length === 1 && keptFinding.findings[0].path === 'a.js', keptFinding);
  check('and carries its line and severity', keptFinding.findings[0].line === 3 && keptFinding.findings[0].severity === 'bug', keptFinding.findings[0]);
  // A plausible path the diff never mentioned is the failure a reader cannot catch.
  check('drops a finding that names a path that is not staged', keptFinding.dropped === 1, keptFinding.dropped);
  check('an unparseable reply is reported as unparsed', normalizeFindings('I read it, looks fine', ['a.js']).parsed === false);
  check(
    'an empty array is a valid clean answer',
    normalizeFindings('[]', ['a.js']).parsed === true && normalizeFindings('[]', ['a.js']).findings.length === 0,
  );
  check(
    'an unknown severity falls back to risk',
    normalizeFindings('[{"path":"a.js","what":"x","severity":"urgent"}]', ['a.js']).findings[0].severity === 'risk',
  );
  check('a finding with no description is dropped', normalizeFindings('[{"path":"a.js","what":"  "}]', ['a.js']).findings.length === 0);
  check('a line that is not a number becomes null', normalizeFindings('[{"path":"a.js","what":"x","line":"nope"}]', ['a.js']).findings[0].line === null);

  section('a truncated JSON answer is retried with more room');
  // The retry is what stops the salvage from being the normal path: a reply cut
  // by the output limit gets one attempt with twice the budget.
  const splitReplies = [
    '[{"message":"feat: a","paths":["a.js"],"why":"x"},{"message":"feat: b","paths":["b',
    '[{"message":"feat: a","paths":["a.js"],"why":"x"},{"message":"feat: b","paths":["b.js"],"why":"y"}]',
  ];
  const budgets = [];
  const scripted = {
    stream: async function* (request) {
      budgets.push(request.maxTokens);
      const reply = splitReplies.length > 1 ? splitReplies.shift() : splitReplies[0];
      yield { type: 'text-delta', index: 0, text: reply };
      yield {
        type: 'finish',
        reason: budgets.length === 1 ? { kind: 'max-tokens' } : { kind: 'stop' },
      };
    },
  };
  const retried = await suggestCommitSplit({
    llm: scripted,
    route: { provider: 'test', model: 'test-model' },
    bundle: { staged: { files: [{ path: 'a.js' }, { path: 'b.js' }], patch: 'diff' } },
    maxTokens: 1000,
  });
  check('the retry gets twice the budget', budgets.length === 2 && budgets[1] === 2000, budgets);
  check('and the complete answer is the one kept', retried.groups.length === 2 && retried.truncated === false, retried);
  check('with the partition complete', retried.complete === true, retried);

  section('a reply cut off mid-array is salvaged, not discarded');
  // A model that runs out of output budget stops mid-JSON. Throwing the whole
  // reply away turned "three usable groups" into "no plan at all" — the user saw
  // an empty split screen with a complete plan in the raw text below it.
  const cutOff =
    '[{"message":"feat: a","paths":["a.js"],"why":"x"},{"message":"feat: b","paths":["b.js"],"why":"y"},{"message":"feat: c","paths":["c';
  const salvaged = extractArray(cutOff);
  check('the complete leading elements survive', salvaged.entries?.length === 2, salvaged.entries);
  check('and the cut is reported', salvaged.truncated === true, salvaged.truncated);
  check('a whole array is not marked truncated', extractArray('[{"message":"a","paths":["a.js"]}]').truncated === false);
  check('a reply with no array at all parses to nothing', extractArray('I cannot help with that').entries === null);

  const salvagedPlan = normalizeGroups(cutOff, ['a.js', 'b.js', 'c.js']);
  check('the salvaged plan has groups to show', salvagedPlan.groups.length === 2, salvagedPlan.groups);
  check('it is flagged as truncated', salvagedPlan.truncated === true, salvagedPlan);
  check('and as incomplete, since c.js is missing', salvagedPlan.complete === false, salvagedPlan);

  const cutFindings = normalizeFindings('[{"path":"a.js","what":"w"},{"path":"b.js","wh', ['a.js', 'b.js']);
  check('findings survive a cut too', cutFindings.findings.length === 1 && cutFindings.truncated === true, cutFindings);

  section('a split plan must partition the change set');
  const fullPlan = normalizeGroups('[{"message":"feat: a","paths":["a.js"]},{"message":"fix: b","paths":["b.js"]}]', ['a.js', 'b.js']);
  check('a fullPlan partition is accepted', fullPlan.groups.length === 2 && fullPlan.complete === true, fullPlan);
  const shortPlan = normalizeGroups('[{"message":"feat: a","paths":["a.js"]}]', ['a.js', 'b.js']);
  check('a plan that leaves a file out is flagged', shortPlan.complete === false, shortPlan);
  const twicePlan = normalizeGroups('[{"message":"a","paths":["a.js"]},{"message":"b","paths":["a.js"]}]', ['a.js']);
  check('a path in two groups is only taken once', twicePlan.groups.length === 1 && twicePlan.complete === true, twicePlan);
  check('a group with no message is dropped', normalizeGroups('[{"message":"  ","paths":["a.js"]}]', ['a.js']).groups.length === 0);
  check('a group naming only unknown paths is dropped', normalizeGroups('[{"message":"x","paths":["ghost.js"]}]', ['a.js']).groups.length === 0);
  check('an unparseable plan is reported as unparsed', normalizeGroups('here is my plan', ['a.js']).parsed === false);

  section('the review and the split run on a real change set');
  const reviewRoute = { provider: 'test', model: 'test-model' };
  const reviewLlm = (reply, sink = []) => ({
    stream: async function* (request) {
      sink.push(request);
      yield { type: 'text-delta', index: 0, text: reply };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  });
  writeFileSync(join(toolRepo, 'reviewed.js'), 'module.exports = 1;\n');
  await core.stage({ cwd: toolRepo, action: 'add', paths: ['reviewed.js'] });
  const reviewBundle = await core.changeBundle({ cwd: toolRepo, maxPatchBytes: 20000 });
  check('the change bundle is available to review', reviewBundle.ok === true, reviewBundle.error);

  const reviewed = await reviewStagedChanges({
    llm: reviewLlm('[{"path":"reviewed.js","line":1,"severity":"risk","what":"no test","fix":"add one"}]'),
    route: reviewRoute,
    bundle: reviewBundle,
  });
  check('a review parses the model answer', reviewed.ok === true && reviewed.findings.length === 1, reviewed);
  check('and the finding is usable by the panel', reviewed.findings[0].path === 'reviewed.js' && reviewed.findings[0].fix === 'add one', reviewed.findings[0]);
  check('an empty repository change set cannot be reviewed', (await reviewStagedChanges({ llm: reviewLlm('[]'), route: reviewRoute, bundle: { staged: { files: [] } } })).ok === false);

  const splitSink = [];
  const splitPlan = await suggestCommitSplit({
    llm: reviewLlm('[{"message":"feat: add reviewed","paths":["reviewed.js"],"why":"one thing"}]', splitSink),
    route: reviewRoute,
    bundle: reviewBundle,
  });
  check('a split plan parses', splitPlan.ok === true && splitPlan.groups.length === 1 && splitPlan.complete === true, splitPlan);
  check('and the prompt states the exact staged paths', splitSink[0].messages[0].content[0].text.includes('reviewed.js'), 'path list missing from the prompt');

  section('the panel runs git under its own session\'s permission');
  // Every panel endpoint falls back to the deployment default without this — and
  // on a Windows host whose `workspace-write` runner cannot start, that made the
  // panel unable to run git at all, no matter what the user chose for the session
  // the tab belongs to.
  const looseSession = join(sandbox, 'loose-repo');
  await core.init({ cwd: looseSession });
  for (const [key, value] of [['user.name', 'Panel User'], ['user.email', 'panel@example.com']]) {
    await core.config({ cwd: looseSession, action: 'set', key, value });
  }
  writeFileSync(join(looseSession, 'panel.txt'), 'x\n');
  await core.commit({ cwd: looseSession, all: true, message: 'chore: seed' });
  sessionCwds['session-loose'] = looseSession;
  sessionModes['session-loose'] = 'danger-full-access';

  await ask('status', { sessionId: 'session-loose' });
  check(
    'a panel request carries the session policy',
    lastShellRequest.sandboxPolicy?.mode === 'danger-full-access',
    lastShellRequest.sandboxPolicy,
  );
  check(
    'and resolved it from that session',
    resolvedPolicies.some((policy) => policy.sessionId === 'session-loose'),
    resolvedPolicies,
  );

  // A session that never chose a mode resolves through its own session to the
  // deployment default, which is the precedence the Host documents.
  sessionCwds['session-plain'] = toolRepo;
  resolvedPolicies.length = 0;
  await ask('status', { sessionId: 'session-plain' });
  check(
    'a session with no chosen mode resolves to the deployment default',
    lastShellRequest.sandboxPolicy?.mode === 'workspace-write' &&
      lastShellRequest.sandboxPolicy?.sessionId === 'session-plain',
    lastShellRequest.sandboxPolicy,
  );

  section('committing one group leaves the rest staged');
  const groupRepo = join(sandbox, 'group-repo');
  await core.init({ cwd: groupRepo });
  for (const [key, value] of [['user.name', 'Group User'], ['user.email', 'group@example.com']]) {
    await core.config({ cwd: groupRepo, action: 'set', key, value });
  }
  writeFileSync(join(groupRepo, 'seed.txt'), 'seed\n');
  await core.commit({ cwd: groupRepo, all: true, message: 'chore: seed' });
  sessionCwds['session-group'] = groupRepo;

  writeFileSync(join(groupRepo, 'one.js'), 'one\n');
  writeFileSync(join(groupRepo, 'two.js'), 'two\n');
  await core.stage({ cwd: groupRepo, action: 'add' });
  const grouped = (await ask('commitGroup', { sessionId: 'session-group', paths: ['one.js'], message: 'feat: one' })).body;
  check('the group commits', grouped.value.ok === true, grouped.value);
  check('only the named path is committed', (await core.log({ cwd: groupRepo, limit: 1 })).commits[0].subject === 'feat: one', (await core.log({ cwd: groupRepo, limit: 1 })).commits);
  const afterGroup = await core.status({ cwd: groupRepo });
  check('and the other file is still there to commit', afterGroup.staged.some((entry) => entry.path === 'two.js'), afterGroup.staged);
  check('reported as remaining', grouped.value.remaining === 1, grouped.value.remaining);
  check('a group with no paths is refused', (await ask('commitGroup', { sessionId: 'session-group', paths: [], message: 'x' })).body.ok === false);
  check('a group with no message is refused', (await ask('commitGroup', { sessionId: 'session-group', paths: ['two.js'], message: '' })).body.ok === false);
  check('an endpoint without a model says so', (await ask('review', { sessionId: 'session-group' })).body.value.ok === false, 'review should refuse without a model');

  section('init with a first commit');
  const anonymous = join(sandbox, 'anonymous');
  const skipped = await core.init({ cwd: anonymous, initialCommitMessage: 'chore: initial commit' });
  check(
    'skips the first commit when no identity is configured',
    skipped.ok === true && skipped.initialCommit === null && typeof skipped.initialCommitError === 'string',
    skipped,
  );
  check('explains how to fix it', skipped.initialCommitError.includes('git_config'), skipped.initialCommitError);

  await core.config({ cwd: sandbox, action: 'set', scope: 'global', key: 'user.name', value: 'Test User' });
  await core.config({ cwd: sandbox, action: 'set', scope: 'global', key: 'user.email', value: 'test@example.com' });

  const fresh = join(sandbox, 'fresh');
  const firstInit = await core.init({
    cwd: fresh,
    initialBranch: 'trunk',
    initialCommitMessage: 'chore: initial commit',
    gitignore: 'dist/\n',
  });
  check('creates and commits', firstInit.ok === true && typeof firstInit.initialCommit === 'string' && firstInit.initialCommit.length > 0, firstInit);
  check('uses the requested branch', firstInit.branch === 'trunk', firstInit.branch);
  const freshLog = await core.log({ cwd: fresh });
  check('has one commit', freshLog.commits.length === 1 && freshLog.commits[0].subject === 'chore: initial commit', freshLog.commits);

  section('diff rows for a reader');
  const SAMPLE_PATCH = [
    'diff --git a/src/app.js b/src/app.js',
    'index f7de733..5ef9430 100644',
    '--- a/src/app.js',
    '+++ b/src/app.js',
    '@@ -10,7 +10,8 @@ export function main() {',
    ' const a = 1;',
    ' const b = 2;',
    '-const total = a + b;',
    '+const total = a + b + 1;',
    '+const extra = true;',
    ' return total;',
    ' }',
    '',
  ].join('\n');
  const parsed = diffRows(SAMPLE_PATCH);
  check('drops the git file header', !parsed.rows.some((row) => row.text.includes('diff --git') || row.text.includes('index f7de733')), parsed.rows.map((r) => r.text));
  check('keeps the hunk section as its own row', parsed.rows[0].kind === 'hunk' && parsed.rows[0].text.includes('export function main'), parsed.rows[0]);
  check('numbers context lines on both sides', parsed.rows[1].oldNo === 10 && parsed.rows[1].newNo === 10, parsed.rows[1]);
  const removed = parsed.rows.find((row) => row.kind === 'del');
  const added = parsed.rows.find((row) => row.kind === 'add');
  check('numbers a removed line only on the old side', removed.oldNo === 12 && removed.newNo === undefined, removed);
  check('numbers the first added line on both sides', added.oldNo === undefined && added.newNo === 12, added);
  const lastContext = parsed.rows.filter((r) => r.kind === 'context').pop();
  check('keeps counting past a replacement', lastContext.oldNo === 14 && lastContext.newNo === 15, lastContext);
  // The removed line lost nothing of its own (the edit was a pure insertion),
  // so only the added line carries a mark, and only over what it inserted.
  check('marks only the span that changed', removed.inline?.[1] === '' && added.inline?.[1] === ' + 1', { removed: removed.inline, added: added.inline });
  check('keeps the shared text out of the mark', removed.inline?.[0] === 'const total = a + b' && added.inline?.[2] === ';', { removed: removed.inline, added: added.inline });
  check('a line with no counterpart is not marked', parsed.rows.filter((r) => r.kind === 'add')[1].inline === undefined);

  const unrelated = diffRows(['@@ -1 +1 @@', '-aaaaaaaaaaaaaaaaaaaa', '+bbbbbbbbbbbbbbbbbbbb', ''].join('\n'));
  check('does not mark two unrelated lines', unrelated.rows.every((row) => row.inline === undefined), unrelated.rows);

  const createdFile = diffRows(['diff --git a/new.txt b/new.txt', 'new file mode 100644', 'index 0000000..1111111', '--- /dev/null', '+++ b/new.txt', '@@ -0,0 +1,2 @@', '+one', '+two', ''].join('\n'));
  check('reports a new file', createdFile.flags.includes('new'), createdFile.flags);
  check('new file lines start at one', createdFile.rows[1].newNo === 1 && createdFile.rows[1].oldNo === undefined, createdFile.rows[1]);

  const deletedFile = diffRows(['diff --git a/gone.txt b/gone.txt', 'deleted file mode 100644', '--- a/gone.txt', '+++ /dev/null', '@@ -1 +0,0 @@', '-bye', ''].join('\n'));
  check('reports a deleted file', deletedFile.flags.includes('deleted'), deletedFile.flags);

  const renamedFile = diffRows(['diff --git a/a.txt b/b.txt', 'similarity index 100%', 'rename from a.txt', 'rename to b.txt', ''].join('\n'));
  check('reports a rename with no content rows', renamedFile.flags.includes('renamed') && renamedFile.rows.length === 0, renamedFile);

  check('an empty patch yields no rows', diffRows('').rows.length === 0);
  check('a no-newline marker adds no row', diffRows(['@@ -1 +1 @@', '-a', '+b', '\\ No newline at end of file', ''].join('\n')).rows.length === 3);

  section('undo the last commit');
  const undoRepo = join(sandbox, 'undo-repo');
  await core.init({ cwd: undoRepo });
  await core.config({ cwd: undoRepo, action: 'set', key: 'user.name', value: 'Undo User' });
  await core.config({ cwd: undoRepo, action: 'set', key: 'user.email', value: 'undo@example.com' });
  check('refuses to undo in a repository with no commits', (await core.resetLastCommit({ cwd: undoRepo })).ok === false);

  writeFileSync(join(undoRepo, 'a.txt'), 'one\n');
  await core.stage({ cwd: undoRepo, action: 'add' });
  const firstEver = await core.commit({ cwd: undoRepo, message: 'chore: first' });
  check('makes a root commit', firstEver.ok === true, firstEver.error);
  const rootMixed = await core.resetLastCommit({ cwd: undoRepo, mode: 'mixed' });
  check('refuses a non-soft undo of the first commit', rootMixed.ok === false && rootMixed.error.includes('first commit'), rootMixed.error);
  const rootSoft = await core.resetLastCommit({ cwd: undoRepo, mode: 'soft' });
  check('undoes the first commit softly', rootSoft.ok === true && rootSoft.firstCommit === true, rootSoft);
  const afterRootUndo = await core.status({ cwd: undoRepo });
  check('leaves the first commit\'s files staged', afterRootUndo.staged.length === 1, afterRootUndo.staged);
  await core.commit({ cwd: undoRepo, message: 'chore: first' });

  writeFileSync(join(undoRepo, 'a.txt'), 'two\n');
  await core.commit({ cwd: undoRepo, all: true, message: 'feat: second' });
  writeFileSync(join(undoRepo, 'a.txt'), 'three\n');
  await core.commit({ cwd: undoRepo, all: true, message: 'feat: third' });
  check('has three commits', (await core.log({ cwd: undoRepo })).commits.length === 3);

  const softUndo = await core.resetLastCommit({ cwd: undoRepo, mode: 'soft' });
  check('soft undo drops one commit', softUndo.ok === true && softUndo.undone.subject === 'feat: third', softUndo);
  check('soft undo keeps the change staged', softUndo.staged === 1 && softUndo.unstaged === 0, softUndo);
  check('history is back to two commits', (await core.log({ cwd: undoRepo })).commits.length === 2);

  await core.commit({ cwd: undoRepo, message: 'feat: third' });
  const mixedUndo = await core.resetLastCommit({ cwd: undoRepo, mode: 'mixed' });
  check('mixed undo unstages the change', mixedUndo.ok === true && mixedUndo.staged === 0 && mixedUndo.unstaged === 1, mixedUndo);
  await core.commit({ cwd: undoRepo, all: true, message: 'feat: third' });

  const hardUndo = await core.resetLastCommit({ cwd: undoRepo, mode: 'hard' });
  check('hard undo keeps the tree clean', hardUndo.ok === true && hardUndo.unstaged === 0 && hardUndo.staged === 0, hardUndo);
  check('hard undo discarded the edit', (await core.diff({ cwd: undoRepo, scope: 'unstaged' })).patch.trim() === '');
  check('the published flag is false without an upstream', hardUndo.published === false, hardUndo);

  section('tags, revert, cherry-pick and rebase');
  const opsRepo = join(sandbox, 'ops-repo');
  await core.init({ cwd: opsRepo });
  for (const [key, value] of [['user.name', 'Ops User'], ['user.email', 'ops@example.com']]) {
    await core.config({ cwd: opsRepo, action: 'set', key, value });
  }
  writeFileSync(join(opsRepo, 'one.txt'), 'one\n');
  await core.commit({ cwd: opsRepo, all: true, message: 'feat: one' });

  // ---- tags ----
  check('a repository starts with no tags', (await core.tag({ cwd: opsRepo, action: 'list' })).tags.length === 0);
  const lightTag = await core.tag({ cwd: opsRepo, action: 'create', name: 'v0.1.0' });
  check('creates a lightweight tag', lightTag.ok === true && lightTag.annotated === false, lightTag);
  const annotated = await core.tag({ cwd: opsRepo, action: 'create', name: 'v0.2.0', message: 'release two' });
  check('creates an annotated tag when given a message', annotated.ok === true && annotated.annotated === true, annotated);
  check('rejects a name git would not accept', (await core.tag({ cwd: opsRepo, action: 'create', name: 'not a tag' })).ok === false);
  check('refuses to reuse a name without force', (await core.tag({ cwd: opsRepo, action: 'create', name: 'v0.1.0' })).ok === false);
  check('and replaces it with force', (await core.tag({ cwd: opsRepo, action: 'create', name: 'v0.1.0', force: true })).ok === true);
  check('lists both tags', (await core.tag({ cwd: opsRepo, action: 'list' })).tags.length === 2);
  check('deleting one works', (await core.tag({ cwd: opsRepo, action: 'delete', name: 'v0.1.0' })).ok === true);
  check('leaving one', (await core.tag({ cwd: opsRepo, action: 'list' })).tags.length === 1);
  check('pushing a tag needs a remote', (await core.tag({ cwd: opsRepo, action: 'push', name: 'v0.2.0' })).ok === false);
  const tagged = await core.history({ cwd: opsRepo, limit: 5 });
  // An annotated tag points at a tag object, so this only works if the ref is
  // peeled to its commit.
  check('an annotated tag shows on its commit', tagged.commits.some((c) => c.refs.includes('v0.2.0')), tagged.commits.map((c) => c.refs));

  // ---- revert: undo by adding an inverse, leaving history intact ----
  writeFileSync(join(opsRepo, 'two.txt'), 'two\n');
  await core.commit({ cwd: opsRepo, all: true, message: 'feat: two' });
  const twoCommit = (await core.log({ cwd: opsRepo, limit: 1 })).commits[0].hash;
  const reverted = await core.revert({ cwd: opsRepo, revision: twoCommit });
  check('revert adds a commit', reverted.ok === true && reverted.hash !== '', reverted);
  check('and the file is gone again', !existsSync(join(opsRepo, 'two.txt')), reverted);
  const afterRevert = await core.log({ cwd: opsRepo, limit: 4 });
  check('the original commit is still in history', afterRevert.commits.some((c) => c.hash === twoCommit), afterRevert.commits.map((c) => c.hash));
  check('refuses a revision that does not exist', (await core.revert({ cwd: opsRepo, revision: 'nope' })).ok === false);

  // A revert that stops short of committing leaves a revert *in progress*: git
  // then refuses to switch branches, so un-staging is not enough — the way out is
  // the abort, which is also what the panel's button dispatches to.
  const stagedRevert = await core.revert({ cwd: opsRepo, revision: 'HEAD~1', noCommit: true });
  check('a revert can stop short of committing', stagedRevert.ok === true && stagedRevert.hash === '', stagedRevert);
  const revertAborted = await core.revert({ cwd: opsRepo, abort: true });
  check('and it can be aborted', revertAborted.ok === true && revertAborted.aborted === true, revertAborted);
  check(
    'leaving a clean tree and nothing in progress',
    (await core.status({ cwd: opsRepo })).clean === true && (await core.status({ cwd: opsRepo })).operation === '',
    await core.status({ cwd: opsRepo }),
  );

  // ---- cherry-pick: lift one commit onto another branch ----
  const createdSource = await core.branch({ cwd: opsRepo, action: 'create', name: 'source' });
  check('created a branch to lift a commit from', createdSource.ok === true, createdSource);
  writeFileSync(join(opsRepo, 'gift.txt'), 'gift\n');
  await core.commit({ cwd: opsRepo, all: true, message: 'feat: a gift' });
  const gift = (await core.log({ cwd: opsRepo, limit: 1 })).commits[0].hash;
  const backToMain = await core.branch({ cwd: opsRepo, action: 'switch', name: 'main' });
  check('switched back to the branch without it', backToMain.ok === true, backToMain);
  check('the gift is not here yet', !existsSync(join(opsRepo, 'gift.txt')));

  // This branch moves on first, which is both the realistic case and the only one
  // where the picked commit cannot coincide with the original: picking a direct
  // child of HEAD, with the same author and committer inside the same second,
  // reproduces the object byte for byte and therefore the same hash.
  writeFileSync(join(opsRepo, 'main-only.txt'), 'main\n');
  await core.commit({ cwd: opsRepo, all: true, message: 'feat: main only' });

  const picked = await core.cherryPick({ cwd: opsRepo, revisions: [gift] });
  check('cherry-pick brings the change over', picked.ok === true && existsSync(join(opsRepo, 'gift.txt')), picked);
  const pickedHead = (await core.log({ cwd: opsRepo, limit: 1 })).commits[0];
  check('as a new commit, not the same one', pickedHead.hash !== gift, { picked: pickedHead.hash, original: gift, subject: pickedHead.subject });
  check('refuses an unknown revision', (await core.cherryPick({ cwd: opsRepo, revisions: ['nope'] })).ok === false);
  check('and needs at least one revision', (await core.cherryPick({ cwd: opsRepo, revisions: [] })).ok === false);

  // ---- rebase: replay onto another branch, and get out when it stops ----
  const ontoSource = await core.branch({ cwd: opsRepo, action: 'switch', name: 'source' });
  check('switched to the branch to rebase onto', ontoSource.ok === true, ontoSource);
  writeFileSync(join(opsRepo, 'shared.txt'), 'from source\n');
  await core.commit({ cwd: opsRepo, all: true, message: 'feat: source side' });
  const rebasingBranch = await core.branch({ cwd: opsRepo, action: 'switch', name: 'main' });
  check('and back to the branch to rebase', rebasingBranch.ok === true, rebasingBranch);
  writeFileSync(join(opsRepo, 'shared.txt'), 'from main\n');
  await core.commit({ cwd: opsRepo, all: true, message: 'feat: main side' });

  check('rebase refuses an unknown target', (await core.rebase({ cwd: opsRepo, onto: 'nope' })).ok === false);
  const rebased = await core.rebase({ cwd: opsRepo, onto: 'source' });
  check('a rebase that conflicts reports it', rebased.ok === false && rebased.conflicted === true, rebased);
  check('naming the file', rebased.conflicts?.includes('shared.txt'), rebased.conflicts);
  check(
    'the git directory says a rebase is in progress',
    (await core.status({ cwd: opsRepo })).operation === 'rebase',
    (await core.status({ cwd: opsRepo })).operation,
  );
  const rebaseAborted = await core.rebase({ cwd: opsRepo, abort: true });
  check('and it can be aborted', rebaseAborted.ok === true && rebaseAborted.aborted === true, rebaseAborted);
  check('leaving nothing in progress', (await core.status({ cwd: opsRepo })).operation === '', (await core.status({ cwd: opsRepo })).operation);
  check(
    'with the file back on this branch',
    readFileSync(join(opsRepo, 'shared.txt'), 'utf8') === 'from main\n',
    readFileSync(join(opsRepo, 'shared.txt'), 'utf8'),
  );

  section('merge and stash');
  const workRepo = join(sandbox, 'merge-repo');
  await core.init({ cwd: workRepo });
  for (const [key, value] of [['user.name', 'Merge User'], ['user.email', 'merge@example.com']]) {
    await core.config({ cwd: workRepo, action: 'set', key, value });
  }
  writeFileSync(join(workRepo, 'base.txt'), 'base\n');
  await core.commit({ cwd: workRepo, all: true, message: 'chore: base' });

  // a side branch that only adds commits: merging it can fast-forward
  await core.branch({ cwd: workRepo, action: 'create', name: 'feature' });
  writeFileSync(join(workRepo, 'feature.txt'), 'feature\n');
  await core.commit({ cwd: workRepo, all: true, message: 'feat: on the branch' });
  await core.branch({ cwd: workRepo, action: 'switch', name: 'main' });

  const refusedCurrent = await core.merge({ cwd: workRepo, branch: 'main' });
  check('refuses to merge the checked-out branch into itself', refusedCurrent.ok === false, refusedCurrent);
  const refusedMissing = await core.merge({ cwd: workRepo, branch: 'nope' });
  check('refuses a branch that does not exist', refusedMissing.ok === false, refusedMissing);

  const fastForwarded = await core.merge({ cwd: workRepo, branch: 'feature' });
  check('fast-forwards when the branch is ahead', fastForwarded.ok === true && fastForwarded.fastForward === true, fastForwarded);
  check('and the file arrives', existsSync(join(workRepo, 'feature.txt')), fastForwarded);
  const upToDate = await core.merge({ cwd: workRepo, branch: 'feature' });
  check('merging again is a no-op', upToDate.ok === true && upToDate.upToDate === true, upToDate);

  // a real merge commit, from two branches that both moved
  await core.branch({ cwd: workRepo, action: 'create', name: 'side' });
  writeFileSync(join(workRepo, 'side.txt'), 'side\n');
  await core.commit({ cwd: workRepo, all: true, message: 'feat: side work' });
  await core.branch({ cwd: workRepo, action: 'switch', name: 'main' });
  writeFileSync(join(workRepo, 'main.txt'), 'main\n');
  await core.commit({ cwd: workRepo, all: true, message: 'feat: main work' });
  const mergeCommit = await core.merge({ cwd: workRepo, branch: 'side', noFf: true });
  check('creates a merge commit when asked', mergeCommit.ok === true && mergeCommit.fastForward === false, mergeCommit);
  check('both sides are present', existsSync(join(workRepo, 'side.txt')) && existsSync(join(workRepo, 'main.txt')), mergeCommit);

  // a conflict is a state to report, not a crash
  await core.branch({ cwd: workRepo, action: 'create', name: 'clash' });
  writeFileSync(join(workRepo, 'shared.txt'), 'from clash\n');
  await core.commit({ cwd: workRepo, all: true, message: 'feat: clash side' });
  await core.branch({ cwd: workRepo, action: 'switch', name: 'main' });
  writeFileSync(join(workRepo, 'shared.txt'), 'from main\n');
  await core.commit({ cwd: workRepo, all: true, message: 'feat: main side' });

  const conflicted = await core.merge({ cwd: workRepo, branch: 'clash' });
  check('a conflicted merge reports itself as such', conflicted.ok === false && conflicted.conflicted === true, conflicted);
  check('naming the file that needs a decision', conflicted.conflicts?.includes('shared.txt'), conflicted.conflicts);
  check('and the message says what to do', /resolve them and commit, or abort/.test(conflicted.error ?? ''), conflicted.error);
  check('the working tree is mid-merge', existsSync(join(workRepo, '.git', 'MERGE_HEAD')), 'no MERGE_HEAD');
  check(
    'and the conflict shows up in status',
    (await core.status({ cwd: workRepo })).conflicted.some((entry) => entry.path === 'shared.txt'),
    (await core.status({ cwd: workRepo })).conflicted,
  );

  const aborted = await core.merge({ cwd: workRepo, abort: true });
  check('aborting the merge succeeds', aborted.ok === true && aborted.action === 'abort', aborted);
  check('leaving no merge in progress', !existsSync(join(workRepo, '.git', 'MERGE_HEAD')), 'MERGE_HEAD survived');
  check('and the file back on this branch', readFileSync(join(workRepo, 'shared.txt'), 'utf8') === 'from main\n', readFileSync(join(workRepo, 'shared.txt'), 'utf8'));

  // stash: set work aside without committing it
  const emptyStash = await core.stash({ cwd: workRepo, action: 'list' });
  check('the stash starts empty', emptyStash.ok === true && emptyStash.stashes.length === 0, emptyStash);
  const nothingToStash = await core.stash({ cwd: workRepo, action: 'push' });
  check('pushing a clean tree says there is nothing to stash', nothingToStash.ok === true && nothingToStash.nothingToStash === true, nothingToStash);

  writeFileSync(join(workRepo, 'shared.txt'), 'work in progress\n');
  const stashedOnce = await core.stash({ cwd: workRepo, action: 'push', message: 'wip: half done' });
  check('stashing takes the change away', stashedOnce.ok === true && readFileSync(join(workRepo, 'shared.txt'), 'utf8') === 'from main\n', stashedOnce);
  check('and records a labelled stash', stashedOnce.stashes.length === 1 && /half done/.test(stashedOnce.stashes[0].subject), stashedOnce.stashes);
  check('leaving the tree clean', (await core.status({ cwd: workRepo })).clean === true, (await core.status({ cwd: workRepo })).clean);

  const applied = await core.stash({ cwd: workRepo, action: 'apply' });
  check('applying brings the change back', readFileSync(join(workRepo, 'shared.txt'), 'utf8') === 'work in progress\n', applied);
  check('and keeps the stash', applied.stashes.length === 1, applied.stashes);

  await core.stash({ cwd: workRepo, action: 'push', message: 'wip: again' });
  check('a second stash stacks on the first', (await core.stash({ cwd: workRepo, action: 'list' })).stashes.length === 2);
  const popped = await core.stash({ cwd: workRepo, action: 'pop' });
  check('popping restores the newest', popped.ok === true && readFileSync(join(workRepo, 'shared.txt'), 'utf8') === 'work in progress\n', popped);
  check('and drops it', popped.stashes.length === 1, popped.stashes);
  const dropped = await core.stash({ cwd: workRepo, action: 'drop' });
  check('dropping empties the stash', dropped.ok === true && dropped.stashes.length === 0, dropped);
  check('and an empty stash refuses further work', (await core.stash({ cwd: workRepo, action: 'pop' })).ok === false);

  section('sync reconciles both directions');
  const originRepo = join(sandbox, 'sync-origin');
  const seedRepo = join(sandbox, 'sync-seed');
  const cloneRepo = join(sandbox, 'sync-clone');

  // A bare remote, the way a real one behaves: pushing into a non-bare
  // repository that has the branch checked out is refused by git, so a fixture
  // built from a working copy would only ever test the rejection path.
  await gitIn(sandbox, '-c', 'init.defaultBranch=main', 'init', '--bare', originRepo);
  await gitIn(sandbox, '-c', 'init.defaultBranch=main', 'clone', '--quiet', originRepo, seedRepo);
  for (const repo of [seedRepo, cloneRepo]) {
    await core.config({ cwd: repo, action: 'set', key: 'user.name', value: 'Sync User' });
    await core.config({ cwd: repo, action: 'set', key: 'user.email', value: 'sync@example.com' });
  }
  writeFileSync(join(seedRepo, 'seed.txt'), 'seed\n');
  const seedCommit = await core.commit({ cwd: seedRepo, all: true, message: 'chore: seed' });
  check('commits the seed into the fresh clone', seedCommit.ok === true, seedCommit);
  const seeded = await core.sync({ cwd: seedRepo, action: 'sync' });
  check('publishes the seed commit to the bare remote', seeded.ok === true && seeded.pushed === 1, seeded);

  await gitIn(sandbox, 'clone', '--quiet', originRepo, cloneRepo);
  await core.config({ cwd: cloneRepo, action: 'set', key: 'user.name', value: 'Sync User' });
  await core.config({ cwd: cloneRepo, action: 'set', key: 'user.email', value: 'sync@example.com' });
  const cloneState = await core.status({ cwd: cloneRepo });
  check('set up a second working copy to sync against', cloneState.isRepo === true && cloneState.upstream !== '', cloneState.upstream);
  check('the clone starts with the seed commit', existsSync(join(cloneRepo, 'seed.txt')), cloneRepo);

  const quiet = await core.sync({ cwd: cloneRepo, action: 'sync' });
  check('a branch with nothing to move reports nothing moved', quiet.ok === true && quiet.pulled === 0 && quiet.pushed === 0, quiet);

  // the remote moves ahead: sync must fast-forward
  writeFileSync(join(seedRepo, 'remote.txt'), 'from the remote\n');
  await core.commit({ cwd: seedRepo, all: true, message: 'feat: remote work' });
  await core.sync({ cwd: seedRepo, action: 'sync' });
  const behind = await core.sync({ cwd: cloneRepo, action: 'sync' });
  check('fetches and fast-forwards when behind', behind.ok === true && behind.pulled === 1, behind);
  check('the pulled commit is on disk', existsSync(join(cloneRepo, 'remote.txt')), behind);
  check('and nothing was pushed', behind.pushed === 0, behind);

  // the clone moves ahead: sync must push
  writeFileSync(join(cloneRepo, 'local.txt'), 'from the clone\n');
  await core.commit({ cwd: cloneRepo, all: true, message: 'feat: local work' });
  const ahead = await core.sync({ cwd: cloneRepo, action: 'sync' });
  check('pushes when ahead', ahead.ok === true && ahead.pushed === 1 && ahead.pulled === 0, ahead);
  check(
    'the remote really has the commit',
    (await gitIn(originRepo, 'log', '--oneline', '-n', '5')).includes('feat: local work'),
    await gitIn(originRepo, 'log', '--oneline', '-n', '5'),
  );

  // Being ahead and behind at once is divergence, so the only way two working
  // copies can both move is for one to be refused — which the next block covers.
  // A working copy cannot push from a view of the remote that predates someone
  // else's push; it fast-forwards first, as a developer would.
  const seedCatchesUp = await core.sync({ cwd: seedRepo, action: 'sync' });
  check('the other working copy fast-forwards what the clone pushed', seedCatchesUp.ok === true && seedCatchesUp.pulled === 1, seedCatchesUp);

  // a diverged branch is reported, never merged behind the user's back
  writeFileSync(join(seedRepo, 'conflict.txt'), 'remote version\n');
  await core.commit({ cwd: seedRepo, all: true, message: 'feat: remote conflicting' });
  const conflictingSeed = await core.sync({ cwd: seedRepo, action: 'sync' });
  check('the conflicting remote commit lands', conflictingSeed.ok === true && conflictingSeed.pushed === 1, conflictingSeed);
  writeFileSync(join(cloneRepo, 'conflict.txt'), 'local version\n');
  await core.commit({ cwd: cloneRepo, all: true, message: 'feat: local conflicting' });
  const diverged = await core.sync({ cwd: cloneRepo, action: 'sync' });
  check('refuses to merge a diverged branch', diverged.ok === false && diverged.diverged === true, diverged);
  check('and says how to proceed', /diverged/.test(diverged.error ?? ''), diverged.error);
  check('leaving no half-finished merge behind', !existsSync(join(cloneRepo, '.git', 'MERGE_HEAD')), 'a merge was started');
  check(
    'the working file kept the local version',
    readFileSync(join(cloneRepo, 'conflict.txt'), 'utf8') === 'local version\n',
    readFileSync(join(cloneRepo, 'conflict.txt'), 'utf8'),
  );

  // A push from a stale view of the remote is refused. git leads that output with
  // "To <url>" and only then says why, so the destination used to be reported as
  // the whole failure and the reason was never shown.
  const rejectedPush = await core.sync({ cwd: cloneRepo, action: 'push' });
  check('a rejected push fails', rejectedPush.ok === false, rejectedPush);
  check(
    'and the message names the reason, not the destination',
    /rejected|fetch first|non-fast-forward/i.test(rejectedPush.error ?? ''),
    rejectedPush.error,
  );
  check('without leading with the remote URL', !/^To\s+\S+\s*$/.test(rejectedPush.error ?? ''), rejectedPush.error);

  const fetchHere = await core.sync({ cwd: sandbox, action: 'fetch' });
  check('fetch on a directory that is not a repository reports it rather than throwing', fetchHere.ok === false && fetchHere.isRepo === false, fetchHere);

  section('discard handles a path by what it actually is');
  const discardRepo = join(sandbox, 'discard-repo');
  await core.init({ cwd: discardRepo });
  await core.config({ cwd: discardRepo, action: 'set', key: 'user.name', value: 'Discard User' });
  await core.config({ cwd: discardRepo, action: 'set', key: 'user.email', value: 'discard@example.com' });
  writeFileSync(join(discardRepo, 'tracked.txt'), 'original\n');
  writeFileSync(join(discardRepo, '.gitignore'), 'ignored-dir/\n');
  await core.stage({ cwd: discardRepo, action: 'add' });
  await core.commit({ cwd: discardRepo, message: 'chore: seed' });

  // one modified tracked file, one brand-new file, one ignored file
  writeFileSync(join(discardRepo, 'tracked.txt'), 'edited\n');
  writeFileSync(join(discardRepo, 'brand-new.txt'), 'fresh\n');
  mkdirSync(join(discardRepo, 'ignored-dir'), { recursive: true });
  writeFileSync(join(discardRepo, 'ignored-dir', 'keep.txt'), 'ignored but mine\n');

  const discardNew = await core.stage({ cwd: discardRepo, action: 'discard', paths: ['brand-new.txt'] });
  check('discarding an untracked file succeeds', discardNew.ok === true, discardNew);
  check('and reports the deletion', discardNew.removed?.includes('brand-new.txt'), discardNew.removed);
  check('and the file is gone from disk', !existsSync(join(discardRepo, 'brand-new.txt')), existsSync(join(discardRepo, 'brand-new.txt')));

  writeFileSync(join(discardRepo, 'brand-new.txt'), 'fresh again\n');
  const discardTracked = await core.stage({ cwd: discardRepo, action: 'discard', paths: ['tracked.txt'] });
  check('discarding a tracked edit restores it', discardTracked.ok === true && readFileSync(join(discardRepo, 'tracked.txt'), 'utf8') === 'original\n', readFileSync(join(discardRepo, 'tracked.txt'), 'utf8'));
  check('and reports no deletion', (discardTracked.removed ?? []).length === 0, discardTracked.removed);

  // a directory holding both kinds: the modification is reverted, the new file removed
  writeFileSync(join(discardRepo, 'tracked.txt'), 'edited again\n');
  const mixed = await core.stage({ cwd: discardRepo, action: 'discard', paths: ['.'] });
  check('a directory discard reverts the edit', readFileSync(join(discardRepo, 'tracked.txt'), 'utf8') === 'original\n', mixed);
  check('and removes the untracked file inside it', !existsSync(join(discardRepo, 'brand-new.txt')), mixed.removed);
  check('while leaving ignored files alone', existsSync(join(discardRepo, 'ignored-dir', 'keep.txt')), 'ignored file was removed');

  // the opt-out still keeps untracked work
  writeFileSync(join(discardRepo, 'kept.txt'), 'do not delete me\n');
  const kept = await core.stage({ cwd: discardRepo, action: 'discard', paths: ['.'], keepUntracked: true });
  check('keepUntracked leaves the file in place', kept.ok === true && existsSync(join(discardRepo, 'kept.txt')), kept);
  check('and says how many were kept', kept.untracked >= 1 && kept.keepUntracked === true, kept);

  check('discard still refuses to run without paths', (await core.stage({ cwd: discardRepo, action: 'discard' })).ok === false);
  check('discard still refuses a path outside the repository', (await core.stage({ cwd: discardRepo, action: 'discard', paths: ['../escape.txt'] })).ok === false);

  section('rewind to a chosen commit');
  const rewindRepo = join(sandbox, 'rewind-repo');
  await core.init({ cwd: rewindRepo });
  await core.config({ cwd: rewindRepo, action: 'set', key: 'user.name', value: 'Rewind User' });
  await core.config({ cwd: rewindRepo, action: 'set', key: 'user.email', value: 'rewind@example.com' });
  for (const [name, message] of [['one.txt', 'feat: one'], ['two.txt', 'feat: two'], ['three.txt', 'feat: three']]) {
    writeFileSync(join(rewindRepo, name), `${name}\n`);
    await core.commit({ cwd: rewindRepo, all: true, message });
  }
  const rewindLog = await core.log({ cwd: rewindRepo, limit: 10 });
  const middle = rewindLog.commits[1].hash;
  check('refuses a target that is not a commit', (await core.resetLastCommit({ cwd: rewindRepo, target: 'nope' })).ok === false);

  const rewound = await core.resetLastCommit({ cwd: rewindRepo, mode: 'soft', target: middle });
  check('rewinds to the named commit', rewound.ok === true && rewound.target === middle, rewound);
  check('says how many commits it dropped', rewound.dropped === 1, rewound);
  check('keeps the dropped work staged', rewound.staged === 1, rewound);
  const afterRewind = await core.log({ cwd: rewindRepo, limit: 10 });
  check('history is back to two commits', afterRewind.commits.length === 2, afterRewind.commits.map((c) => c.subject));
  check('the newest commit is the target', afterRewind.commits[0].hash === middle, afterRewind.commits[0]);

  section('one commit in full');
  const detail = await core.commitDetail({ cwd: rewindRepo, hash: middle });
  check('reads the commit', detail.ok === true && detail.shortHash === middle, detail);
  check('splits subject and body', detail.subject === 'feat: two' && detail.body === '', { subject: detail.subject, body: detail.body });
  check('lists the files it touched', detail.files.length === 1 && detail.files[0].path === 'two.txt', detail.files);
  check('counts the lines it added', detail.files[0].additions === 1, detail.files);
  check('names the author and parent', detail.author === 'Rewind User' && detail.parents.length === 1, detail);

  writeFileSync(join(rewindRepo, 'one.txt'), 'one\nmore\n');
  await core.commit({ cwd: rewindRepo, all: true, message: 'feat: with a body\n\nWhy it changed, in a paragraph.' });
  const withBody = await core.commitDetail({ cwd: rewindRepo });
  check('keeps a multi-paragraph body', withBody.subject === 'feat: with a body' && withBody.body === 'Why it changed, in a paragraph.', withBody);
  check('defaults to HEAD', withBody.ok === true && withBody.hash.length === 40, withBody.hash);

  section('one file inside one commit');
  const firstCommit = (await core.log({ cwd: toolRepo, limit: 20 })).commits.at(-1);
  const fileDiff = await core.diff({
    cwd: toolRepo,
    scope: 'commit',
    revision: firstCommit.hash,
    paths: ['app.js'],
  });
  check('a commit-scoped diff answers for one file', fileDiff.ok === true, fileDiff);
  const fileRows = diffRows(fileDiff.patch ?? '').rows;
  check(
    'and parses into the rows the panel draws',
    fileRows.some((row) => row.kind === 'add' && row.text.includes('console.log')),
    fileRows.map((row) => [row.kind, row.text]),
  );
  check('the hunk is numbered from the file, not the repository', fileRows.some((row) => row.kind === 'hunk'), fileRows);
  const untouched = await core.diff({ cwd: toolRepo, scope: 'commit', revision: firstCommit.hash, paths: ['nothing-here.txt'] });
  check('a path the commit did not touch yields an empty patch', (untouched.patch ?? '') === '', untouched.patch);
  check(
    'an unknown revision is refused',
    (await core.diff({ cwd: toolRepo, scope: 'commit', revision: 'no-such-commit' })).ok === false,
  );

  section('a draft turns generation into completion');
  const sampleBundle = {
    branch: 'main',
    recentCommits: ['feat: earlier'],
    staged: { files: [{ path: 'app.js', additions: 2, deletions: 1 }], patch: 'diff --git a/app.js b/app.js\n+a\n-b\n' },
    unstaged: null,
    untracked: [],
  };
  const plainPrompt = buildUserPrompt(sampleBundle);
  const draftedPrompt = buildUserPrompt(sampleBundle, '  fix the login redirect  ');
  check('an empty draft leaves the prompt as a plain request', plainPrompt.includes('Write the commit message for the change'), plainPrompt.slice(0, 80));
  check('an empty draft carries no draft field', !plainPrompt.includes('authorDraft'), plainPrompt);
  check('a draft is handed over verbatim', draftedPrompt.includes('"authorDraft": "fix the login redirect"'), draftedPrompt);
  check('a draft changes the instruction to completion', draftedPrompt.includes('Complete and improve it'), draftedPrompt.slice(0, 120));

  /** A model stub that records the request it was given. */
  const capturingLlm = (reply, sink) => ({
    stream: async function* (request) {
      sink.push(request);
      yield { type: 'text-delta', text: reply };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  });
  const draftRoute = { provider: 'test', model: 'test-model' };

  const withoutDraft = [];
  const plainMessage = await generateCommitMessage({
    llm: capturingLlm('feat: add a thing', withoutDraft),
    route: draftRoute,
    bundle: sampleBundle,
  });
  check('generation still works without a draft', plainMessage.ok === true && plainMessage.message === 'feat: add a thing', plainMessage);
  check('no draft means no draft rule', !withoutDraft[0].system.includes('authorDraft'), withoutDraft[0].system.slice(-120));

  const withDraft = [];
  const fromDraft = await generateCommitMessage({
    llm: capturingLlm('fix(auth): keep the login redirect', withDraft),
    route: draftRoute,
    bundle: sampleBundle,
    draft: 'fix login redirect',
  });
  check('a draft produces a message', fromDraft.ok === true && fromDraft.message === 'fix(auth): keep the login redirect', fromDraft);
  check('the draft rule forbids replacing the author\'s wording', withDraft[0].system.includes('Never replace their description'), withDraft[0].system.slice(-260));
  check('the draft reaches the model', JSON.stringify(withDraft[0].messages).includes('fix login redirect'), withDraft[0].messages);

  section('an explanation that comes back empty');
  /** A model stub that yields a fixed list of chunks. */
  const scriptedLlm = (script, sink = []) => ({
    stream: async function* (request) {
      sink.push(request);
      for (const chunk of script) yield chunk;
    },
  });
  const explainOnce = (script, sink) =>
    explainFileChange({
      llm: scriptedLlm(script, sink),
      route: draftRoute,
      path: 'app.js',
      patch: 'diff --git a/app.js b/app.js\n+const x = 1;\n',
    });

  const reasoningOnly = [
    { type: 'reasoning-delta', index: 0, text: 'weighing the change…' },
    { type: 'usage', usage: { inputTokens: 900, outputTokens: 700, reasoningTokens: 700 } },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ];
  const emptySink = [];
  const recovered = await explainOnce(reasoningOnly, emptySink);
  check('a model that spent its budget thinking is retried', emptySink.length === 2, emptySink.length);
  check('and the retry asks for more room', emptySink[1].maxTokens === emptySink[0].maxTokens * 2, {
    first: emptySink[0].maxTokens,
    second: emptySink[1].maxTokens,
  });
  check('still failing, it names the real cause', recovered.ok === false && /budget/.test(recovered.error), recovered.error);
  check('rather than blaming an empty answer', !/empty explanation/.test(recovered.error), recovered.error);

  // the retry succeeds when the second attempt has room
  let call = 0;
  const recoveringLlm = {
    stream: async function* () {
      call += 1;
      if (call === 1) {
        yield { type: 'finish', reason: { kind: 'max-tokens' } };
        return;
      }
      yield { type: 'text-delta', index: 0, text: '- The guard now rejects empty input.' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const explainedOnRetry = await explainFileChange({
    llm: recoveringLlm,
    route: draftRoute,
    path: 'app.js',
    patch: 'diff --git a/app.js b/app.js\n+const x = 1;\n',
  });
  check('a retry that works returns the explanation', explainedOnRetry.ok === true && /guard/.test(explainedOnRetry.summary), explainedOnRetry);

  // an adapter that hands over a whole block instead of deltas is understood
  const blockOnly = await explainOnce([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '- The block arrived whole.' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);
  check('a text block without deltas is still read', blockOnly.ok === true && /arrived whole/.test(blockOnly.summary), blockOnly);

  // a provider error is a decision, not a fluke: no retry
  const errorSink = [];
  const refused = await explainOnce(
    [{ type: 'finish', reason: { kind: 'error', failure: { message: 'quota exhausted', code: 'QUOTA' } } }],
    errorSink,
  );
  check('a provider error is not retried', errorSink.length === 1, errorSink.length);
  check('and its own message is passed through', /quota exhausted/.test(refused.error), refused.error);

  // reasoning tokens travel with the result so a caller can see what happened
  const withUsage = [];
  const measured = await explainFileChange({
    llm: scriptedLlm(
      [
        { type: 'text-delta', index: 0, text: '- Fine.' },
        { type: 'usage', usage: { inputTokens: 10, outputTokens: 20, reasoningTokens: 5 } },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
      withUsage,
    ),
    route: draftRoute,
    path: 'app.js',
    patch: 'diff --git a/app.js b/app.js\n+x\n',
  });
  check('reports the token usage it was given', measured.meta?.usage?.reasoningTokens === 5, measured.meta);

  section('ignore patterns are filtered before they are written');
  const keep = normalizeIgnorePatterns(
    [
      '\`\`\`',
      'node_modules/',
      'dist/',
      '*.log',
      '.env.local',
      'coverage/',
      '!keep-me.json',
      '# a comment the model added',
      'Here is the list you asked for',
      '',
      '*',
      '**',
      '/*',
      '*.json',
      '*.ts',
      '*.md',
      'src/',
      '/src/',
      'lib/',
      'node_modules/',
      '/src/generated/',
      '\`\`\`',
    ].join('\n'),
  );
  check('keeps the artefact patterns', keep.includes('node_modules/') && keep.includes('dist/') && keep.includes('.env.local'), keep);
  check('keeps a negation and a nested path', keep.includes('!keep-me.json') && keep.includes('/src/generated/'), keep);
  check('drops a fence, a comment and prose', !keep.some((entry) => entry.includes('\`') || entry.startsWith('#') || entry.includes(' ')), keep);
  check('drops patterns that would hide the whole tree', !keep.includes('*') && !keep.includes('**') && !keep.includes('/*'), keep);
  check('drops a bare source extension', !keep.includes('*.json') && !keep.includes('*.ts') && !keep.includes('*.md'), keep);
  check('drops a whole source directory', !keep.includes('src/') && !keep.includes('/src/') && !keep.includes('lib/'), keep);
  check('de-duplicates', keep.filter((entry) => entry === 'node_modules/').length === 1, keep);

  const suggested = await suggestIgnorePatterns({
    llm: capturingLlm('dist/\n.cache/\n*.log', []),
    route: draftRoute,
    shape: { root: '/tmp/x', top: ['src', 'package.json'], files: ['src/index.js'], manifests: { 'package.json': '{}' } },
    mode: 'init',
  });
  check('a model reply becomes a pattern list', suggested.ok === true && suggested.patterns.join(',') === 'dist/,.cache/,*.log', suggested);

  const optimizeAsk = [];
  await suggestIgnorePatterns({
    llm: capturingLlm('dist/', optimizeAsk),
    route: draftRoute,
    shape: { root: '/tmp/x', top: [], files: [], manifests: {} },
    existing: 'node_modules/\n',
    mode: 'optimize',
  });
  const initAsk = [];
  await suggestIgnorePatterns({
    llm: capturingLlm('dist/', initAsk),
    route: draftRoute,
    shape: { root: '/tmp/x', top: [], files: [], manifests: {} },
    existing: 'node_modules/\n',
    mode: 'init',
  });
  check('an optimize pass is shown the current file', JSON.stringify(optimizeAsk[0].messages).includes('existingGitignore'), optimizeAsk[0].messages);
  check('an init pass is not', !JSON.stringify(initAsk[0].messages).includes('existingGitignore'), initAsk[0].messages);

  section('gitignore planning');
  const planRepo = join(sandbox, 'gitignore-plan');
  await core.init({ cwd: planRepo });
  writeFileSync(join(planRepo, 'package.json'), '{}\n');
  writeFileSync(join(planRepo, 'requirements.txt'), 'requests\n');
  const ignorePlan = await core.gitignorePlan({ cwd: planRepo });
  check('plans groups for a repository', ignorePlan.ok === true && ignorePlan.exists === false, ignorePlan);
  check('detects node and python', ignorePlan.groups.find((g) => g.id === 'node').detected && ignorePlan.groups.find((g) => g.id === 'python').detected, ignorePlan.groups?.map((g) => [g.id, g.detected]));
  check('does not claim rust', ignorePlan.groups.find((g) => g.id === 'rust').detected === false);
  check('suggests the detected groups', ignorePlan.suggested.includes('node') && ignorePlan.suggested.includes('python'), ignorePlan.suggested);

  const wrote = await core.writeGitignore({ cwd: planRepo, entries: ['node_modules/', 'dist/', '.env'] });
  check('writes the entries', wrote.ok === true && wrote.added.length === 3, wrote);
  const wroteAgain = await core.writeGitignore({ cwd: planRepo, entries: ['node_modules/', 'dist/'] });
  check('adds nothing twice', wroteAgain.ok === true && wroteAgain.unchanged === true, wroteAgain);
  const ignoreFile = readFileSync(join(planRepo, '.gitignore'), 'utf8');
  check('the file has each line once', ignoreFile.split('\n').filter((l) => l === 'node_modules/').length === 1, ignoreFile);
  check('reports the file as existing', (await core.gitignorePlan({ cwd: planRepo })).exists === true);
  check('counts what is still missing', (await core.gitignorePlan({ cwd: planRepo })).groups.find((g) => g.id === 'node').missing > 0);
  check('rejects an empty selection', (await core.writeGitignore({ cwd: planRepo, entries: [] })).ok === false);

  section('explain one file change');
  const explainLlm = {
    async *stream(options) {
      check('sends the patch to the model', options.messages[0].content[0].text.includes('a.txt'), options.messages[0].content[0].text.slice(0, 80));
      check(
        'carries the configured language into the prompt',
        options.system.includes('Simplified Chinese'),
        options.system.slice(-160),
      );
      yield { type: 'text-delta', index: 0, text: '```\n- rewrites a.txt\n- nothing else\n```' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const fileSummary = await explainFileChange({
    llm: explainLlm,
    route: { provider: 'p', model: 'm' },
    path: 'a.txt',
    patch: '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+two\n',
    // The same `messageLanguage` setting drives the commit message and this.
    language: 'zh',
  });
  check('explains a file change', fileSummary.ok === true && fileSummary.summary.startsWith('- rewrites a.txt'), fileSummary);
  check('strips the code fence', !fileSummary.summary.includes('```'));
  check('names the file in meta', fileSummary.meta?.path === 'a.txt', fileSummary.meta);
  check('rejects an empty patch', (await explainFileChange({ llm: explainLlm, route: { provider: 'p', model: 'm' }, path: 'x', patch: '  ' })).ok === false);
  check('rejects a missing model service', (await explainFileChange({ llm: null, route: { provider: 'p', model: 'm' }, path: 'x', patch: 'y' })).ok === false);
  check('normalizes a labelled explanation', normalizeExplanation('Summary: - one thing') === '- one thing');

  section('one language setting, both outputs');
  check('zh message rule keeps the conventional prefix', languageRule('zh', 'message').includes('<type>(<scope>):'));
  check('zh explanation rule does not mention the commit prefix', !languageRule('zh', 'explanation').includes('<type>'));
  check('zh explanation rule asks for Simplified Chinese', languageRule('zh', 'explanation').includes('Simplified Chinese'));
  check('en explanation rule asks for English', languageRule('en', 'explanation') === 'Write the explanation in English.');
  check('auto explanation can fall back to the patch language', languageRule('auto', 'explanation').includes('code comments'));
  check('auto message rule stays about commit subjects', languageRule('auto', 'message').includes('commit subjects'));
  check('an unknown language behaves as auto', languageRule('klingon', 'message') === languageRule('auto', 'message'));

  const zhMessageLlm = {
    async *stream(options) {
      check('the commit prompt uses the message phrasing', options.system.includes('Write the commit message in Simplified Chinese'), options.system.slice(-140));
      yield { type: 'text-delta', index: 0, text: 'feat: 说明' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const zhMessage = await generateCommitMessage({
    llm: zhMessageLlm,
    route: { provider: 'p', model: 'm' },
    bundle,
    language: 'zh',
  });
  check('generates a Chinese commit message', zhMessage.ok === true && zhMessage.message === 'feat: 说明', zhMessage);
  check('drops blank lines', normalizeExplanation('- a\n\n\n- b') === '- a\n- b');

  section('detached HEAD and unborn repositories');
  const unborn = join(sandbox, 'unborn');
  await core.init({ cwd: unborn });
  const unbornStatus = await core.status({ cwd: unborn });
  check('reports an unborn branch', unbornStatus.initial === true && unbornStatus.branch === 'main', unbornStatus);
  const unbornLog = await core.log({ cwd: unborn });
  check('logs nothing without failing', unbornLog.ok === true && unbornLog.commits.length === 0, unbornLog);
  const unbornAll = await core.diff({ cwd: unborn, scope: 'all' });
  check('reads "all" without HEAD', unbornAll.ok === true, unbornAll.error);
  check('explains the fallback', typeof unbornAll.note === 'string' && unbornAll.note.includes('no commit yet'), unbornAll.note);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`);
if (failures > 0) {
  process.stdout.write(`${failures} check(s) failed\n`);
  process.exit(1);
}
