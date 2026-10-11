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
 * @module @local/dsh-git/rpc
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
  const { core, config, cwdForSession, generateFor, explainFor, readSettings, writeSettings } = operations;

  return async function dispatch(endpoint, payload, signal) {
    if (!ENDPOINTS.has(endpoint)) return failure('unknown-endpoint', `unknown endpoint: ${endpoint}`);
    const sessionId = text(payload, 'sessionId');
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
            ...(flag(payload, 'includeUntracked') ? { includeUntracked: true } : {}),
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
        return success(await generateFor(cwd, signal, undefined));
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
      case 'settings':
        if (text(payload, 'action') === 'set') {
          return success(await writeSettings(payload?.values));
        }
        return success(readSettings());
      case 'reset':
        return success(await core.resetLastCommit({ ...bound, mode: text(payload, 'mode') || 'mixed' }));
      case 'gitignore': {
        if (text(payload, 'action') === 'write') {
          const chosen = list(payload, 'groups');
          const plan = await core.gitignorePlan({ cwd, signal });
          if (plan.ok !== true) return success(plan);
          const wanted = new Set(chosen);
          const entries = plan.groups.filter((group) => wanted.has(group.id)).flatMap((group) => group.entries);
          const written = await core.writeGitignore({ cwd, entries });
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
      case 'branch':
        return success(
          await core.branch({
            ...bound,
            action: text(payload, 'action') || 'list',
            ...(text(payload, 'name') ? { name: text(payload, 'name') } : {}),
            ...(text(payload, 'startPoint') ? { startPoint: text(payload, 'startPoint') } : {}),
            ...(flag(payload, 'force') ? { force: true } : {}),
          }),
        );
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
