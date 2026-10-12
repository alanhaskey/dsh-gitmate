/**
 * The two things a model can read a staged change set for.
 *
 * Both ask for JSON and parse it defensively: a model that answers in prose, or
 * names a file that is not in the change set, must degrade to something honest
 * rather than to a wrong finding. Every path is checked against the change set
 * before it is shown, because a plausible-looking path the diff never mentioned
 * is exactly the kind of wrong a reader cannot catch.
 *
 * @module dsh-gitmate/review
 */

import { languageRule, runTextCallWithRetry } from './messages.js';

/** Review instructions: report, do not pad. */
const REVIEW_RULES = [
  'You review a staged change set before it is committed, for the person who wrote it.',
  'Reply with a JSON array and nothing else: no prose, no heading, no code fence.',
  'Each element is {"path": "<one of the changed paths, exactly>", "line": <number or null>, "severity": "bug" | "risk" | "test" | "style", "what": "<the problem, one sentence>", "fix": "<what to do, one sentence>"}.',
  'Report only what you can point at in the supplied diff. Never invent a path, a line, or a behaviour the diff does not show.',
  'Aim at what would bite: a wrong result, a missed edge case, an unhandled error, a resource left open, a secret or local path committed, debug output left in, a behaviour change with no test.',
  'Do not report style preferences, naming, formatting, or anything a linter would catch.',
  'Do not summarise the change; that is a different job.',
  'An empty array is the correct answer when the change is clean. Do not pad the list to seem useful.',
].join('\n');

/** Split instructions: partition, do not merge. */
const SPLIT_RULES = [
  'You divide one staged change set into separate commits, each of which stands on its own.',
  'Reply with a JSON array and nothing else: no prose, no heading, no code fence.',
  'Each element is {"message": "<a complete commit message>", "paths": ["<changed path>", ...], "why": "<one sentence on what makes this group one change>"}.',
  'Group by intent, not by file type: a fix and the test that covers it belong together; a refactor and an unrelated feature do not.',
  'Every changed path must appear in exactly one group. Never invent a path and never leave one out.',
  'Prefer two to five groups. One group is the correct answer when the change really is one thing — do not split for the sake of splitting.',
  'Each message follows Conventional Commits: an imperative subject under 72 characters, then an optional body when the group needs one.',
  'The same language rule applies to every message.',
].join('\n');

/**
 * Pull the first JSON array out of a model reply.
 *
 * Models wrap answers in fences or add a sentence despite being asked not to, so
 * the array is located rather than assumed.
 * @param raw - the reply.
 * @returns the parsed array, or null when there is nothing parseable.
 */
export function extractJsonArray(raw) {
  let text = String(raw ?? '').replace(/\r\n/g, '\n').trim();
  const fence = /```(?:json)?\n([\s\S]*?)\n?```/.exec(text);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const SEVERITIES = new Set(['bug', 'risk', 'test', 'style']);

/**
 * Keep only the findings that point at the change set that was reviewed.
 *
 * @param raw - the model reply.
 * @param allowed - the paths the change set actually contains.
 * @returns `{ findings, dropped, parsed }` — `parsed` is false when nothing could
 * be read as JSON, which the caller reports differently from "nothing found".
 */
export function normalizeFindings(raw, allowed) {
  const entries = extractJsonArray(raw);
  if (entries === null) return { findings: [], dropped: 0, parsed: false };
  const known = new Set(allowed ?? []);
  const findings = [];
  let dropped = 0;
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') {
      dropped += 1;
      continue;
    }
    const path = String(entry.path ?? '').trim();
    const what = String(entry.what ?? '').trim();
    if (path === '' || what === '' || (known.size > 0 && !known.has(path))) {
      dropped += 1;
      continue;
    }
    const line = Number(entry.line);
    findings.push({
      path,
      line: Number.isFinite(line) && line > 0 ? Math.trunc(line) : null,
      severity: SEVERITIES.has(entry.severity) ? entry.severity : 'risk',
      what,
      fix: String(entry.fix ?? '').trim(),
    });
  }
  return { findings, dropped, parsed: true };
}

/**
 * Keep only the groups that partition the change set.
 *
 * A partition is the whole point: a path in two groups would be committed twice,
 * and a path in none would be silently left behind. Anything that is not a clean
 * partition is refused rather than repaired.
 *
 * @param raw - the model reply.
 * @param allowed - the paths the change set actually contains.
 * @returns `{ groups, parsed, complete }`.
 */
export function normalizeGroups(raw, allowed) {
  const entries = extractJsonArray(raw);
  if (entries === null) return { groups: [], parsed: false, complete: false };
  const known = new Set(allowed ?? []);
  const seen = new Set();
  const groups = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue;
    const message = String(entry.message ?? '').trim();
    const paths = (Array.isArray(entry.paths) ? entry.paths : [])
      .map((path) => String(path ?? '').trim())
      .filter((path) => path !== '' && (known.size === 0 || known.has(path)));
    if (message === '' || paths.length === 0) continue;
    const unique = paths.filter((path) => !seen.has(path));
    if (unique.length === 0) continue;
    for (const path of unique) seen.add(path);
    groups.push({ message, paths: unique, why: String(entry.why ?? '').trim() });
  }
  const complete = known.size > 0 && seen.size === known.size;
  return { groups, parsed: true, complete };
}

/**
 * Review the staged change set.
 * @param options - the LLM service, route, change bundle, language, and limits.
 * @returns `{ ok: true, findings, dropped, summary }` or `{ ok: false, error }`.
 */
export async function reviewStagedChanges({
  llm,
  route,
  bundle,
  language = 'auto',
  maxTokens = 6000,
  signal,
} = {}) {
  if (!llm || typeof llm.stream !== 'function') {
    return { ok: false, error: 'no model service is available to review this change' };
  }
  if (!route?.provider || !route?.model) return { ok: false, error: 'no model is selected for review' };
  if ((bundle?.staged?.files ?? []).length === 0) {
    return { ok: false, error: 'there is nothing staged to review' };
  }

  const call = await runTextCallWithRetry({
    llm,
    route,
    system: `${REVIEW_RULES}\n\n${languageRule(language, 'review')}`,
    messages: [{ role: 'user', content: [{ type: 'text', text: buildReviewPrompt(bundle) }] }],
    maxTokens,
    signal,
    // The value is the parsed list, so an unparseable reply keeps its raw text for
    // the caller to show rather than being thrown away.
    normalize: (text) => text,
    emptyError: 'the model returned nothing to review',
    meta: () => ({}),
  });
  if (call.ok !== true) return { ok: false, error: call.error };

  const parsed = normalizeFindings(call.message, (bundle.staged.files ?? []).map((file) => file.path));
  if (!parsed.parsed) {
    return { ok: true, findings: [], dropped: 0, unparsed: true, raw: String(call.message).trim(), meta: call.meta };
  }
  return { ok: true, ...parsed, meta: call.meta };
}

/**
 * Propose a split of the staged change set into standalone commits.
 * @param options - the LLM service, route, change bundle, language, and limits.
 * @returns `{ ok: true, groups, complete }` or `{ ok: false, error }`.
 */
export async function suggestCommitSplit({
  llm,
  route,
  bundle,
  language = 'auto',
  maxTokens = 4000,
  signal,
} = {}) {
  if (!llm || typeof llm.stream !== 'function') {
    return { ok: false, error: 'no model service is available to plan this split' };
  }
  if (!route?.provider || !route?.model) return { ok: false, error: 'no model is selected for planning the split' };
  const paths = (bundle?.staged?.files ?? []).map((file) => file.path);
  if (paths.length === 0) return { ok: false, error: 'there is nothing staged to split' };

  const call = await runTextCallWithRetry({
    llm,
    route,
    system: `${SPLIT_RULES}\n\n${languageRule(language, 'split')}`,
    messages: [{ role: 'user', content: [{ type: 'text', text: buildReviewPrompt(bundle, paths) }] }],
    maxTokens,
    signal,
    normalize: (text) => text,
    emptyError: 'the model returned no plan',
    meta: () => ({}),
  });
  if (call.ok !== true) return { ok: false, error: call.error };

  const parsed = normalizeGroups(call.message, paths);
  if (!parsed.parsed) {
    return { ok: true, groups: [], complete: false, unparsed: true, raw: String(call.message).trim(), meta: call.meta };
  }
  return { ok: true, ...parsed, meta: call.meta };
}

/**
 * The shared user prompt: the change set, and the exact paths it contains.
 *
 * The path list is spelled out separately from the patch because a model that
 * has to derive it from diff headers gets them subtly wrong.
 * @param bundle - from `changeBundle`.
 * @param paths - the staged paths, when the caller needs them stated.
 */
export function buildReviewPrompt(bundle, paths = []) {
  const payload = {
    branch: bundle.branch || '(unborn)',
    recentCommitSubjects: bundle.recentCommits ?? [],
    stagedFiles: paths.length > 0 ? paths : (bundle.staged?.files ?? []).map((file) => file.path),
    stagedSummary: (bundle.staged?.files ?? []).map((file) => ({
      path: file.path,
      additions: file.additions ?? null,
      deletions: file.deletions ?? null,
    })),
    stagedDiff: bundle.staged?.patch ?? '',
    stagedDiffTruncated: Boolean(bundle.staged?.truncated),
  };
  return [
    'The staged change set is described by this JSON document.',
    'The stagedDiff field is the patch; stagedFiles is the exact set of paths it touches.',
    '',
    JSON.stringify(payload, null, 2),
  ].join('\n');
}
