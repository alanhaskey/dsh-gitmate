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

import { buildGraph, createGitCore, diffRows, shellQuote } from '../lib/git-core.js';
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
const TEST_ENV = {
  ...process.env,
  HOME: fakeHome,
  XDG_CONFIG_HOME: join(fakeHome, '.config'),
  GIT_CONFIG_GLOBAL: join(fakeHome, '.gitconfig'),
  GIT_CONFIG_SYSTEM: '/dev/null',
};

/** A minimal stand-in for `ctx.shell`, backed by a real bash process. */
function childProcessExec({ command, cwd, stdin, timeoutMs }) {
  return new Promise((settle) => {
    const child = execFile(
      '/bin/bash',
      ['-c', command],
      { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: TEST_ENV },
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
      resolve: (request) => request,
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
      if (name === 'sessions') {
        return {
          get: (id) => (Object.hasOwn(sessionCwds, id) ? { header: { cwd: sessionCwds[id] } } : undefined),
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
    'git_commit',
    'git_config',
    'git_diff',
    'git_init',
    'git_log',
    'git_reset',
    'git_stage',
    'git_status',
    'git_sync',
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
