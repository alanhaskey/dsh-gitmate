/**
 * The Host half of the Git panel's bridge.
 *
 * The panel is a Client half of this same package, so it talks to the Host over
 * one exact Fetch route on the shared `/api` channel — plain JSON in, plain JSON
 * out, and no session-log traffic for a diff that is re-read on every refresh.
 *
 * Why a Fetch route rather than a dedicated RPC channel:
 * `connection.rpc.handle()` mounts the channel as
 * `owner.effect(() => owner.webServer.register(route))`, and `owner` there is the
 * *connection plugin's* context, which never injected `webServer` — so that call
 * fails with "cannot get property webServer without inject" for every outside
 * plugin. `connection.fetch.register()` only needs `owner.effect`, and the `/api`
 * prefix route already applies the Host/Origin fence and browser authentication,
 * so this route inherits both.
 *
 * Every endpoint calls the same operation the agent tools call; `impl.js` owns
 * one implementation and both callers share it.
 *
 * @module dsh-gitmate/rpc
 */

/** The exact Fetch route this package answers on, under the shared `/api` channel. */
import { diffRows } from './git-core.js';

export const PANEL_PATH = '/api/dsh-git';

/** The relative URL the browser half posts to, resolved against the page like the shipped RPC client. */
export const PANEL_URL = 'api/dsh-git';

/** Largest request body accepted, in bytes. */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Project one diff result onto what the panel renders.
 *
 * The unified patch is replaced by parsed rows: the Host already owns the
 * parser (and its tests), and the panel then has nothing to interpret — it draws
 * gutters, signs, and text.
 * @param result - the value `core.diff` or `core.viewUntracked` returned.
 * @returns the same result with `rows`/`flags` and without the raw patch.
 */
function forPanel(result) {
  if (result === null || typeof result !== 'object' || result.ok !== true) return result;
  const { rows, flags } = diffRows(result.patch ?? '');
  const { patch, ...rest } = result;
  void patch;
  return { ...rest, rows, flags };
}

/** Endpoints the panel may call. */
const ENDPOINTS = new Set([
  'status',
  'diff',
  'stage',
  'commit',
  'generateMessage',
  'explain',
  'sync',
  'init',
  'log',
  'branch',
  'config',
  'settings',
  'reset',
  'gitignore',
  'gitignoreSuggest',
  'history',
  'commitDetail',
  'stash',
  'tag',
  'revert',
  'cherryPick',
  'rebase',
]);

/** One failure in the envelope shape the Harness RPC transport uses. */
function failure(code, message) {
  return { ok: false, error: { code: `dsh-git/${code}`, message, details: {} } };
}

/** One success. */
function success(value) {
  return { ok: true, value };
}

/** Read a string field from an untrusted payload. */
function text(payload, key) {
  const value = payload === null || typeof payload !== 'object' ? undefined : payload[key];
  return typeof value === 'string' ? value : '';
}

/** Read a boolean field from an untrusted payload. */
function flag(payload, key) {
  const value = payload === null || typeof payload !== 'object' ? undefined : payload[key];
  return value === true;
}

/** Read a string-array field from an untrusted payload. */
function list(payload, key) {
  const value = payload === null || typeof payload !== 'object' ? undefined : payload[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => typeof entry === 'string' && entry !== '');
}

/**
 * Build the endpoint dispatcher.
 *
 * Kept apart from the transport so the operations can be exercised directly,
 * over the same signature the Fetch handler calls.
 *
 * @param operations - the shared operations `createOperations` returned.
 * @returns `(endpoint, payload, signal) => Promise<envelope>`.
 */
export function createPanelDispatcher(operations) {
  const { core, config, cwdForSession, generateFor, explainFor, readSettings, writeSettings, suggestGitignore } =
    operations;
  // Named apart from this file's own `text(payload, key)` accessor.
  const translator = operations.text;

  /**
   * Translate whatever the panel is about to be shown.
   *
   * One place, at the edge: an operation answers with the message it authored or
   * the one git produced, and both leave here in the configured language. Tool
   * results are untouched — those are read by a model.
   * @param answer - the `{ ok, value | error }` envelope.
   */
  function localized(answer) {
    if (translator === undefined || answer === null || typeof answer !== 'object') return answer;
    if (answer.ok === false && typeof answer.error?.message === 'string') {
      return { ...answer, error: { ...answer.error, message: translator.message(answer.error.message) } };
    }
    if (answer.ok === true && answer.value !== null && typeof answer.value?.error === 'string') {
      return { ...answer, value: { ...answer.value, error: translator.message(answer.value.error) } };
    }
    return answer;
  }

  async function dispatchRaw(endpoint, payload, signal) {
    if (!ENDPOINTS.has(endpoint)) return failure('unknown-endpoint', `unknown endpoint: ${endpoint}`);
    const sessionId = String(payload?.sessionId ?? '');
    const cwd = cwdForSession(sessionId);
    if (cwd === undefined) {
      return failure('no-session', `session "${sessionId || '(none)'}" is not live; reopen the panel`);
    }
    const bound = {
      cwd,
      signal,
      generateMessage: ({ cwd: target, signal: inner }) => generateFor(target ?? cwd, inner ?? signal, undefined),
    };

    switch (endpoint) {
      case 'status': {
        // The panel shows each row's +N/-M, so it asks for the counts; the agent
        // tool leaves them out and stays one git call cheaper.
        const state = await core.status({ ...bound, withCounts: true });
        // The panel needs to know whether a commit identity exists before it
        // offers a commit button, so fold that probe into the same round trip.
        const identity = state.isRepo ? await core.identity(state.root, signal) : { userName: '', userEmail: '' };
        return success({
          ...state,
          identityConfigured: identity.userName !== '' && identity.userEmail !== '',
          userName: identity.userName,
        });
      }
      case 'diff': {
        const scope = text(payload, 'scope') || 'all';
        const paths = list(payload, 'paths');
        const result = await core.diff({
          ...bound,
          scope,
          ...(paths.length > 0 ? { paths } : {}),
          maxBytes: Number.isInteger(payload?.maxBytes) ? payload.maxBytes : config.maxDiffBytes,
          // The panel widens the context when the reader asks for more of the
          // file around a hunk.
          ...(Number.isInteger(payload?.contextLines) ? { contextLines: payload.contextLines } : {}),
        });
        // An untracked path has no diff at all; show its contents as additions
        // instead of an empty pane.
        if (paths.length === 1 && result.ok !== false && (result.patch ?? '').trim() === '') {
          const preview = await core.viewUntracked({ cwd, path: paths[0], signal });
          if (preview.ok === true) return success(forPanel(preview));
        }
        return success(forPanel(result));
      }
      case 'stage': {
        const paths = list(payload, 'paths');
        return success(
          await core.stage({
            ...bound,
            action: text(payload, 'action'),
            ...(paths.length > 0 ? { paths } : {}),
            // Discarding an untracked path deletes it unless the caller opts out.
            ...(flag(payload, 'keepUntracked') ? { keepUntracked: true } : {}),
          }),
        );
      }
      case 'commit': {
        const message = text(payload, 'message');
        const paths = list(payload, 'paths');
        return success(
          await core.commit({
            ...bound,
            ...(message.trim() === '' ? {} : { message }),
            ...(flag(payload, 'all') ? { all: true } : {}),
            ...(paths.length > 0 ? { paths } : {}),
          }),
        );
      }
      case 'generateMessage':
        // A draft turns this from "write me a message" into "finish mine".
        return success(await generateFor(cwd, signal, undefined, text(payload, 'draft')));
      case 'explain': {
        const path = text(payload, 'path');
        if (path === '') return failure('bad-request', 'explain needs a path');
        const scope = text(payload, 'scope') || 'unstaged';
        const scoped = await core.diff({ ...bound, scope, paths: [path], maxBytes: config.maxPromptBytes });
        let patch = scoped.patch ?? '';
        if (patch.trim() === '' && scoped.ok !== false) {
          // An untracked file has no diff; explain its contents as additions.
          const preview = await core.viewUntracked({ cwd, path, signal });
          if (preview.ok === true) patch = preview.patch;
        }
        if (patch.trim() === '') return success({ ok: false, error: `there is no change in ${path} to explain` });
        return success(await explainFor(cwd, { path, patch, signal }));
      }
      case 'tag':
        return success(
          await core.tag({
            ...bound,
            action: text(payload, 'action') || 'list',
            ...(text(payload, 'name') ? { name: text(payload, 'name') } : {}),
            ...(text(payload, 'message') ? { message: text(payload, 'message') } : {}),
            ...(text(payload, 'revision') ? { revision: text(payload, 'revision') } : {}),
            ...(text(payload, 'remote') ? { remote: text(payload, 'remote') } : {}),
            ...(flag(payload, 'force') ? { force: true } : {}),
            ...(flag(payload, 'all') ? { all: true } : {}),
          }),
        );
      case 'revert':
        return success(
          await core.revert({
            ...bound,
            ...(text(payload, 'revision') ? { revision: text(payload, 'revision') } : {}),
            ...(flag(payload, 'noCommit') ? { noCommit: true } : {}),
            ...(flag(payload, 'abort') ? { abort: true } : {}),
            ...(Number.isInteger(payload?.mainline) ? { mainline: payload.mainline } : {}),
          }),
        );
      case 'cherryPick':
        return success(
          await core.cherryPick({
            ...bound,
            revisions: list(payload, 'revisions'),
            ...(flag(payload, 'noCommit') ? { noCommit: true } : {}),
            ...(flag(payload, 'abort') ? { abort: true } : {}),
            ...(Number.isInteger(payload?.mainline) ? { mainline: payload.mainline } : {}),
          }),
        );
      case 'rebase':
        return success(
          await core.rebase({
            ...bound,
            ...(text(payload, 'onto') ? { onto: text(payload, 'onto') } : {}),
            ...(flag(payload, 'abort') ? { abort: true } : {}),
            ...(flag(payload, 'continue') ? { continue: true } : {}),
            ...(flag(payload, 'autostash') ? { autostash: true } : {}),
          }),
        );
      case 'stash':
        return success(
          await core.stash({
            ...bound,
            action: text(payload, 'action') || 'list',
            ...(text(payload, 'message') ? { message: text(payload, 'message') } : {}),
            ...(Number.isInteger(payload?.index) ? { index: payload.index } : {}),
            ...(flag(payload, 'includeUntracked') ? { includeUntracked: true } : {}),
          }),
        );
      case 'history':
        return success(await core.history({ ...bound, limit: Number.isInteger(payload?.limit) ? payload.limit : 30 }));
      case 'settings':
        if (text(payload, 'action') === 'set') {
          return success(await writeSettings(payload?.values));
        }
        return success(readSettings());
      case 'reset':
        return success(
          await core.resetLastCommit({
            ...bound,
            mode: text(payload, 'mode') || 'mixed',
            ...(text(payload, 'target') ? { target: text(payload, 'target') } : {}),
          }),
        );
      case 'commitDetail':
        return success(
          await core.commitDetail({
            ...bound,
            ...(text(payload, 'hash') ? { hash: text(payload, 'hash') } : {}),
          }),
        );
      case 'gitignoreSuggest':
        // The panel asks what this repository should ignore; it never picks a
        // group set itself.
        return success(
          await suggestGitignore({
            ...bound,
            mode: text(payload, 'mode') === 'optimize' ? 'optimize' : 'init',
          }),
        );
      case 'gitignore': {
        if (text(payload, 'action') === 'write') {
          // The panel sends the patterns themselves: the group table is an
          // implementation detail of the offline fallback, not a menu.
          const entered = list(payload, 'entries');
          if (entered.length === 0) return failure('bad-request', 'gitignore write needs entries');
          const written = await core.writeGitignore({ cwd, entries: entered });
          if (written.ok !== true) return success(written);
          return success({ ...written, plan: await core.gitignorePlan({ cwd, signal }) });
        }
        return success(await core.gitignorePlan({ cwd, signal }));
      }
      case 'sync':
        return success(await core.sync({ ...bound, action: text(payload, 'action') || 'push' }));
      case 'init':
        return success(
          await core.init({
            ...bound,
            ...(text(payload, 'initialBranch') ? { initialBranch: text(payload, 'initialBranch') } : {}),
            ...(typeof payload?.gitignore === 'string' ? { gitignore: payload.gitignore } : {}),
          }),
        );
      case 'log':
        return success(
          await core.log({
            ...bound,
            limit: Number.isInteger(payload?.limit) ? payload.limit : 10,
            ...(text(payload, 'path') ? { path: text(payload, 'path') } : {}),
          }),
        );
      case 'branch': {
        const action = text(payload, 'action') || 'list';
        const common = {
          ...bound,
          action,
          ...(text(payload, 'name') ? { name: text(payload, 'name') } : {}),
          ...(flag(payload, 'force') ? { force: true } : {}),
        };
        // Merging belongs to the same entry as the branches it moves between.
        if (action === 'merge' || action === 'abort') {
          return success(await core.merge({ ...common, ...(flag(payload, 'noFf') ? { noFf: true } : {}) }));
        }
        return success(
          await core.branch({
            ...common,
            ...(text(payload, 'startPoint') ? { startPoint: text(payload, 'startPoint') } : {}),
          }),
        );
      }
      case 'config':
        return success(
          await core.config({
            ...bound,
            action: text(payload, 'action') || 'get',
            ...(text(payload, 'key') ? { key: text(payload, 'key') } : {}),
            ...(typeof payload?.value === 'string' ? { value: payload.value } : {}),
            ...(text(payload, 'scope') ? { scope: text(payload, 'scope') } : {}),
          }),
        );
      default:
        return failure('unknown-endpoint', `unknown endpoint: ${endpoint}`);
    }
  }

  /**
   * The panel-facing dispatcher: the raw one, with its messages put into the
   * language the plugin is set to.
   */
  return async function dispatch(endpoint, payload, signal) {
    return localized(await dispatchRaw(endpoint, payload, signal));
  };
}

/** One JSON response carrying an RPC envelope. */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Register the panel route.
 *
 * Rides an injected fiber so the connection service or this plugin unloading
 * withdraws the route; a profile without a Connection composes the agent tools
 * and simply has no panel.
 *
 * @param ctx - the plugin context.
 * @param operations - the shared operations `createOperations` returned.
 * @returns the exact effect disposer.
 */
export function registerGitPanel(ctx, operations) {
  const dispatch = createPanelDispatcher(operations);
  let disposeRoute;

  const release = ctx.inject(['connection'], (scoped) => {
    // Property access, not `scoped.get('connection')`: cordis rebinds a
    // service's `ctx` to the reading context only through the context proxy.
    const connection = scoped.connection;
    const register = connection?.fetch?.register;
    if (typeof register !== 'function') return undefined;

    const route = {
      path: PANEL_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        let body;
        try {
          const raw = await request.text();
          if (raw.length > MAX_BODY_BYTES) return json(failure('too-large', 'request body is too large'), 413);
          body = raw === '' ? {} : JSON.parse(raw);
        } catch {
          return json(failure('bad-request', 'request body is not JSON'), 400);
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          return json(failure('bad-request', 'request body must be a JSON object'), 400);
        }
        const { endpoint, ...payload } = body;
        if (typeof endpoint !== 'string' || endpoint === '') {
          return json(failure('bad-request', 'request body needs an endpoint'), 400);
        }
        try {
          return json(await dispatch(endpoint, payload, request.signal));
        } catch (error) {
          return json(failure('internal', error instanceof Error ? error.message : String(error)), 500);
        }
      },
    };

    // `register` answers the route's effect disposer.
    const registered = register.call(connection.fetch, route);
    disposeRoute = () => {
      if (typeof registered === 'function') registered();
    };
    return () => {
      disposeRoute?.();
      disposeRoute = undefined;
    };
  });

  // `ctx.inject` does not promise a callable back — it may hand over the scoped
  // context instead — so both halves are re-checked before being called.
  return () => {
    if (typeof release === 'function') release();
    if (typeof disposeRoute === 'function') disposeRoute();
  };
}
