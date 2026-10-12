/**
 * Bundle entry point: plugin identity plus a revision-aware loader for the
 * implementation in `impl.js`.
 *
 * Why the indirection: Node caches an ES module for the lifetime of the
 * process, and this deployment gives the loader no module HMR (that needs
 * `--expose-internals`, which DSH Desktop does not pass), so a plain
 * `import './impl.js'` would keep running the first generation of the code
 * until the app restarts. `apply` runs again on every profile recompose, and it
 * re-reads the implementation files' modification times here — so editing the
 * implementation and toggling this bundle is enough to load it, with no restart
 * and no unbounded module growth (unchanged files map to the same URL and stay
 * cached).
 *
 * @module dsh-gitmate
 */

import { statSync } from 'node:fs';

/** Plugin identity recorded by the loader. */
export const name = 'dsh-git';

/**
 * Git tools are useless without a tool registry and a shell to run git in.
 *
 * `sandboxPolicy` is deliberately NOT injected: it is read per call through
 * `ctx.get`, so a profile that does not serve it falls back to the deployment
 * default instead of failing to activate the whole plugin. See `policyFor` in
 * `impl.js`.
 */
export const inject = ['tools', 'shell'];

/**
 * Every file one generation of this plugin is made of. The revision below is
 * the newest of their modification times, so editing ANY of them produces a new
 * module URL — keying on the entry module's own mtime would leave a sibling edit
 * invisible to a running process, which is exactly the trap this list avoids.
 */
const IMPLEMENTATION = ['impl.js', 'git-core.js', 'messages.js', 'review.js', 'rpc.js', 'text.js'];

/**
 * The revision of the implementation currently on disk.
 * @param entry - the implementation module URL the siblings resolve against.
 * @returns the newest modification time as a string, or '' when none is readable.
 */
function revisionOf(entry) {
  let newest = 0;
  for (const file of IMPLEMENTATION) {
    try {
      newest = Math.max(newest, statSync(new URL(`./${file}`, entry)).mtimeMs);
    } catch {
      /* an unreadable file simply contributes nothing to the revision */
    }
  }
  return newest === 0 ? '' : String(newest);
}

/**
 * Load the current implementation and register its tools.
 * @param ctx - the plugin context, carrying the injected services.
 * @param config - this bundle's row config from `cordis.patch.yml`.
 */
export async function apply(ctx, config) {
  const implementation = new URL('./impl.js', import.meta.url);
  const revision = revisionOf(implementation);
  const loaded =
    revision === ''
      ? await import('./impl.js')
      : await import(`${implementation.href}?rev=${encodeURIComponent(revision)}`);
  return loaded.apply(ctx, config);
}
