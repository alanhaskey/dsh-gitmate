/**
 * Commit-message generation.
 *
 * The prompt is deliberately narrow: the model receives the pending change as
 * JSON and returns the message only. Nothing here imports a Harness package —
 * `generateCommitMessage` is handed `ctx.llm` and a resolved route, so the same
 * function serves the agent tool and, later, a UI action.
 *
 * @module dsh-gitmate/messages
 */

/** Subject prefixes the model may use. */
const CONVENTIONAL_TYPES = 'feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert';

/** Instruction that does not vary per call. */
const STABLE_RULES = [
  'You write Git commit messages.',
  'Reply with the commit message only: no quotes, no code fences, no commentary, no preamble.',
  '',
  'Format:',
  `- First line is one imperative subject in Conventional Commits form \`<type>(<scope>): <subject>\`, where <type> is one of ${CONVENTIONAL_TYPES}. Keep it under 72 characters, do not end it with a period, and omit the scope when no single area dominates.`,
  '- Then one blank line, then an optional body explaining what changed and why. Wrap the body at 72 characters and use "-" bullets when the change has more than one part.',
  '',
  'Content:',
  '- Describe the change the supplied diff actually makes. Never invent files, symbols, or intent the diff does not show.',
  '- Prefer the specific over the generic: name the behaviour or module that changed, not "update code".',
  '- Do not add Signed-off-by, Co-authored-by, or any tool attribution trailer.',
  '- A subject line alone is a correct answer when the change is small and self-evident.',
].join('\n');

/**
 * One language policy, phrased for the output being produced.
 *
 * Both outputs read the same setting — `messageLanguage` — so a user who picks
 * 简体中文 gets it for the commit message and for a file explanation alike. Only
 * the wording differs: the commit-message rules must mention the
 * `<type>(<scope>):` prefix, and the explanation rules must not.
 *
 * @param language - one of `auto`, `en`, `zh`.
 * @param kind - `message` for a commit message, `explanation` for a file summary.
 * @returns the instruction appended to that call's system prompt.
 */
export function languageRule(language, kind) {
  // `message` and `split` produce commit messages and keep the `<type>:` prefix;
  // `explanation` and `review` are prose and keep identifiers instead.
  const prose = kind === 'explanation' || kind === 'review';
  const subject =
    kind === 'review' ? 'every finding' : kind === 'split' ? 'each commit message' : kind === 'explanation' ? 'the explanation' : 'the commit message';
  if (prose) {
    if (language === 'en') return `Write ${subject} in English.`;
    if (language === 'zh') {
      return `Write ${subject} in Simplified Chinese. Keep code identifiers, file paths, and any quoted patch text exactly as they appear.`;
    }
    return [
      `Write ${subject} in the language of the repository's recent commit subjects.`,
      'When the history gives no signal, follow the language of the code comments and user-facing strings in the patch.',
      'When nothing suggests a language, write in English.',
    ].join(' ');
  }
  if (kind === 'split') {
    if (language === 'en') return `Write ${subject} in English.`;
    if (language === 'zh') {
      return `Write ${subject} in Simplified Chinese. Keep the \`<type>(<scope>):\` prefix and any code identifiers in English.`;
    }
    return `Write ${subject} in the language of the repository's recent commit subjects; when there are none, write in English.`;
  }
  const explanation = kind === 'explanation';
  if (language === 'en') {
    return explanation ? 'Write the explanation in English.' : 'Write the commit message in English.';
  }
  if (language === 'zh') {
    return explanation
      ? 'Write the explanation in Simplified Chinese. Keep code identifiers, file paths, and any quoted patch text exactly as they appear.'
      : 'Write the commit message in Simplified Chinese. Keep the `<type>(<scope>):` prefix and any code identifiers in English.';
  }
  if (explanation) {
    return [
      "Write the explanation in the language of the repository's recent commit subjects.",
      'When the history gives no signal, follow the language of the code comments and user-facing strings in the patch.',
      'When nothing suggests a language, write in English.',
    ].join(' ');
  }
  return "Write the commit message in the language of the repository's recent commit subjects; when there are none, write in English.";
}

/** Strip the wrappers a model sometimes adds around an otherwise good message. */
export function normalizeCommitMessage(raw) {
  let text = String(raw ?? '').replace(/\r\n/g, '\n').trim();
  const fence = /^```[a-zA-Z]*\n([\s\S]*?)\n?```$/.exec(text);
  if (fence) text = fence[1].trim();
  text = text.replace(/^(?:commit message|message|git commit message)\s*:\s*/i, '');
  text = text.replace(/^["'“”]+|["'“”]+$/g, '');
  text = text
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  text = text
    .split('\n')
    .filter((line) => !/^(signed-off-by|co-authored-by|generated-by|assisted-by):/i.test(line.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text;
}

/** Render one change set as a compact diffstat line. */
function diffstat(files) {
  if (!Array.isArray(files) || files.length === 0) return '(no tracked file changes)';
  const additions = files.reduce((total, file) => total + (file.additions ?? 0), 0);
  const deletions = files.reduce((total, file) => total + (file.deletions ?? 0), 0);
  return `${files.length} file(s) changed, ${additions} insertion(s), ${deletions} deletion(s)`;
}

/**
 * Frame the change bundle as the user message.
 * @param bundle - the value `changeBundle` produced.
 * @returns the request text.
 */
export function buildUserPrompt(bundle, draft = '') {
  const authored = String(draft ?? '').trim();
  const payload = {
    branch: bundle.branch || '(unborn)',
    recentCommitSubjects: bundle.recentCommits ?? [],
    stagedSummary: diffstat(bundle.staged?.files),
    stagedFiles: (bundle.staged?.files ?? []).map((file) => file.path),
    stagedDiff: bundle.staged?.patch ?? '',
    stagedDiffTruncated: Boolean(bundle.staged?.truncated),
    unstagedSummary: bundle.unstaged ? diffstat(bundle.unstaged.files) : null,
    unstagedFiles: bundle.unstaged ? (bundle.unstaged.files ?? []).map((file) => file.path) : null,
    unstagedDiff: bundle.unstaged?.patch ?? null,
    untrackedFiles: (bundle.untracked ?? []).map((entry) => entry.path),
    untrackedSamples: (bundle.untracked ?? [])
      .filter((entry) => entry.preview)
      .slice(0, 8)
      .map((entry) => ({ path: entry.path, content: entry.preview })),
    // Present only when the author typed something themselves.
    ...(authored === '' ? {} : { authorDraft: authored }),
  };
  return [
    authored === ''
      ? 'Write the commit message for the change described by this JSON document.'
      : 'The author already wrote `authorDraft`. Complete and improve it for the change described by this JSON document.',
    'The staged change set is what will be committed; unstaged and untracked entries are context only.',
    '',
    JSON.stringify(payload, null, 2),
  ].join('\n');
}

/**
 * Resolve the model route for message generation.
 * @param options - plugin config, the default-model service, and the live session.
 * @returns `{ provider, model }`, or `null` when nothing can be resolved.
 */
export function resolveRoute({ config = {}, defaultModel, session } = {}) {
  if (config.provider && config.model) return { provider: config.provider, model: config.model };
  const selected = defaultModel?.currentSelection?.();
  if (selected?.provider && selected?.model) return { provider: selected.provider, model: selected.model };
  const context = session?.requestContext?.();
  if (context?.provider && context?.model) return { provider: context.provider, model: context.model };
  return null;
}

/**
 * Generate one commit message.
 * @param options - the LLM service, resolved route, change bundle, style and
 * language policy, token cap, and cancellation.
 * @returns `{ ok: true, message, meta }` or `{ ok: false, error }`.
 */
export async function generateCommitMessage({
  llm,
  route,
  bundle,
  draft = '',
  style = 'conventional',
  language = 'auto',
  template = '',
  maxTokens = 2000,
  signal,
} = {}) {
  if (!llm || typeof llm.stream !== 'function') {
    return {
      ok: false,
      error:
        'no model service is available to generate a message; read the change with git_diff and pass an explicit message to git_commit',
    };
  }
  if (!route?.provider || !route?.model) {
    return {
      ok: false,
      error:
        'no model is selected for message generation; set provider and model in the plugin config, or pass an explicit message to git_commit',
    };
  }

  const rules = [STABLE_RULES];
  if (style === 'plain') {
    rules.push('Use a plain imperative subject instead of Conventional Commits: no `type(scope):` prefix, no emoji.');
  }
  rules.push(languageRule(language, 'message'));
  const authored = String(draft ?? '').trim();
  if (authored !== '') {
    // The author's own words are the intent, not a starting suggestion: the job
    // is to finish and polish them, not to substitute a description of the diff.
    rules.push(
      [
        'The author has already written a draft, supplied as `authorDraft`. Treat it as their intent:',
        'keep the meaning and every specific they chose, add what is missing, and fix the wording, format, and language.',
        'Never replace their description of the change with your own, and never drop a detail they included.',
        'When the draft is already a complete message, return it improved rather than rewritten.',
      ].join(' '),
    );
  }
  const custom = String(template ?? '').trim();
  if (custom !== '') {
    // The user's own wording comes last so it can override the defaults above.
    rules.push(`Repository conventions supplied by the user, which take precedence over the rules above:\n${custom}`);
  }

  return runTextCallWithRetry({
    llm,
    route,
    system: rules.join('\n\n'),
    messages: [{ role: 'user', content: [{ type: 'text', text: buildUserPrompt(bundle, authored) }] }],
    maxTokens,
    signal,
    normalize: normalizeCommitMessage,
    emptyError: 'the model returned an empty commit message',
    meta: (message) => {
      const subject = message.split('\n')[0];
      return { subject, subjectLength: subject.length };
    },
  });
}

/** Instruction for deciding what a repository should ignore. */
const IGNORE_RULES = [
  'You write `.gitignore` files.',
  'Reply with ignore patterns only: one per line, no comments, no code fences, no blank lines, no explanation.',
  'Use gitignore syntax. One pattern per line; a trailing slash means a directory.',
  'Prefer a few broad patterns over long enumerations of individual paths.',
  'Cover build output, dependency caches, editor and OS metadata, logs, coverage and test artefacts, local environment files, and generated or compiled files for the ecosystems the project actually uses.',
  'Never emit a pattern that would ignore source code, manifests, or lockfiles the project needs to build — `*`, `/*`, `**`, `src/`, and `*.json` are all wrong answers.',
  'When the project already ignores something, do not repeat it.',
].join('\n');

/** A pattern that would ignore the repository itself rather than its artefacts. */
const DESTRUCTIVE_PATTERN = /^(?:\*+|\*\*+|\/\*+|\/|\*\/|\.)$/;

/**
 * A bare extension wildcard for a file kind a project normally keeps.
 *
 * `*.json` and `*.md` are the shapes a model reaches for when it means "generated
 * files"; as written they also hide every manifest and every document, so they
 * are refused and the narrower intent is left to the user.
 */
const SOURCE_EXTENSION = /^\*\.([a-z0-9]{1,8})$/i;

/** Extensions that are source, configuration, or documentation rather than output. */
const KEPT_EXTENSIONS = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts',
  'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'php', 'swift', 'scala', 'sh', 'bash', 'zsh', 'ps1', 'lua', 'r',
  'json', 'jsonc', 'json5', 'toml', 'yaml', 'yml', 'ini', 'cfg', 'conf', 'properties', 'env',
  'md', 'markdown', 'rst', 'txt', 'adoc',
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'svg', 'sql', 'proto', 'gradle', 'lock',
]);

/** A whole source, test, or package directory hidden by one line. */
const SOURCE_ROOT = /^\/?(?:src|lib|libs|app|apps|source|packages|test|tests|spec|specs|docs)\/?$/i;

/**
 * Keep the lines a model returned that are usable as ignore patterns.
 *
 * Models occasionally wrap output in a fence, add commentary, or overreach into
 * a pattern that would hide the whole tree. This drops all three, because the
 * result is written to a file the user did not read line by line.
 *
 * @param raw - the model's reply.
 * @returns the surviving patterns, de-duplicated in order.
 */
export function normalizeIgnorePatterns(raw) {
  let text = String(raw ?? '').replace(/\r\n/g, '\n');
  const fence = /```[a-zA-Z]*\n([\s\S]*?)\n?```/.exec(text);
  if (fence) text = fence[1];
  const seen = new Set();
  const patterns = [];
  for (const line of text.split('\n')) {
    const entry = line.trim();
    if (entry === '' || entry.startsWith('#')) continue;
    // A model that explains itself puts prose here; patterns do not contain spaces.
    if (/\s/.test(entry)) continue;
    // A negation is an explicit intent, so it never gets the guards below.
    const bare = entry.startsWith('!') ? '' : entry;
    if (DESTRUCTIVE_PATTERN.test(bare)) continue;
    if (SOURCE_ROOT.test(bare)) continue;
    const extension = SOURCE_EXTENSION.exec(bare);
    if (extension !== null && KEPT_EXTENSIONS.has(extension[1].toLowerCase())) continue;
    if (seen.has(entry)) continue;
    seen.add(entry);
    patterns.push(entry);
  }
  return patterns;
}

/**
 * Ask the model what a repository should ignore.
 *
 * @param options - the LLM service, resolved route, the project description from
 * `projectShape`, the current `.gitignore`, and the mode.
 * @returns `{ ok: true, patterns }` or `{ ok: false, error }`.
 */
export async function suggestIgnorePatterns({
  llm,
  route,
  shape,
  existing = '',
  mode = 'init',
  maxTokens = 1200,
  signal,
} = {}) {
  if (!llm || typeof llm.stream !== 'function') {
    return { ok: false, error: 'no model service is available to infer ignore patterns' };
  }
  if (!route?.provider || !route?.model) {
    return { ok: false, error: 'no model is selected for ignore inference' };
  }
  const optimize = mode === 'optimize';
  const payload = {
    repository: shape?.root ?? '(unknown)',
    topLevelEntries: shape?.top ?? [],
    samplePaths: shape?.files ?? [],
    sampleTruncated: Boolean(shape?.truncated),
    manifestFiles: shape?.manifests ?? {},
    ...(optimize ? { existingGitignore: String(existing ?? '') } : {}),
  };
  const ask = optimize
    ? 'List ONLY the patterns this project needs that are absent from `existingGitignore`. If nothing is missing, reply with nothing at all.'
    : 'Write the `.gitignore` this project needs.';
  const answer = await runTextCallWithRetry({
    llm,
    route,
    system: IGNORE_RULES,
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: `${ask}\n\n${JSON.stringify(payload, null, 2)}` }],
      },
    ],
    maxTokens,
    signal,
    normalize: normalizeIgnorePatterns,
    emptyError: 'the model proposed no ignore patterns',
    meta: (patterns) => ({ count: patterns.length }),
  });
  if (answer.ok !== true) return { ok: false, error: answer.error };
  // `runTextCall` hands back the normalized value as `message`; here it is a list.
  return { ok: true, patterns: answer.message, meta: answer.meta };
}

/** Instruction for explaining one file's change to a reviewer. */
const EXPLAIN_RULES = [
  "You explain a single file's change to a reviewer who has not read the patch.",
  'Answer with 2 to 5 short bullet points and nothing else: no preamble, no heading, no code fence.',
  'Each bullet states one thing a reviewer must know: what changed, why it matters, and anything that could break or needs a second look.',
  'Name the functions, types, or behaviours the patch touches, using the identifiers exactly as they appear.',
  'When the patch only moves, renames, or reformats code, say so in one bullet instead of inventing intent.',
  'Never invent behaviour the patch does not show.',
].join('\n');

/**
 * Explain one file's change in plain language, so a reviewer can skip reading
 * every line of the diff.
 * @param options - the LLM service, resolved route, the file and its patch,
 * language policy, token cap, and cancellation.
 * @returns `{ ok: true, summary }` or `{ ok: false, error }`.
 */
export async function explainFileChange({
  llm,
  route,
  path,
  patch,
  language = 'auto',
  maxTokens = 2000,
  signal,
} = {}) {
  if (!llm || typeof llm.stream !== 'function') {
    return { ok: false, error: 'no model service is available to explain this change' };
  }
  if (!route?.provider || !route?.model) {
    return { ok: false, error: 'no model is selected for explanations; set one in the panel settings' };
  }
  const body = String(patch ?? '').trim();
  if (body === '') return { ok: false, error: 'there is no patch to explain' };

  return runTextCallWithRetry({
    llm,
    route,
    system: [EXPLAIN_RULES, languageRule(language, 'explanation')].join('\n\n'),
    messages: [{ role: 'user', content: [{ type: 'text', text: `Explain this change to \`${path}\`:\n\n${body}` }] }],
    maxTokens,
    signal,
    normalize: normalizeExplanation,
    emptyError: 'the model returned an empty explanation',
    meta: () => ({ path }),
  });
}

/** Strip the wrappers a model sometimes adds around a bullet list. */
export function normalizeExplanation(raw) {
  let text = String(raw ?? '').replace(/\r\n/g, '\n').trim();
  const fence = /^```[a-zA-Z]*\n([\s\S]*?)\n?```$/.exec(text);
  if (fence) text = fence[1].trim();
  text = text.replace(/^(?:explanation|summary|here(?:'s| is)[^\n]*)\s*:\s*/i, '');
  return text
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.trim() !== '')
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Stream one text-only model call and normalize its answer.
 *
 * Shared by commit messages and file explanations so both get the same
 * cancellation, finish-reason, and emptiness handling.
 *
 * @param options - the call plus the endpoint-owned answer name and normalization.
 * @returns `{ ok: true, message | summary, meta }` or `{ ok: false, error }`.
 */
async function runTextCall({ llm, route, system, messages, maxTokens, signal, normalize, emptyError, meta }) {
  let deltas = '';
  const blocks = [];
  let finish;
  let usage;
  try {
    for await (const chunk of llm.stream({
      provider: route.provider,
      model: route.model,
      system,
      messages,
      maxTokens,
      ...(signal ? { signal } : {}),
    })) {
      if (chunk?.type === 'text-delta') deltas += chunk.text ?? '';
      // An adapter may hand over a finished text block instead of (or as well as)
      // its deltas; keeping both means an answer is never lost to whichever
      // shape this provider chose.
      else if (chunk?.type === 'block-end' && chunk.block?.type === 'text') blocks.push(chunk.block.text ?? '');
      else if (chunk?.type === 'usage') usage = chunk.usage;
      else if (chunk?.type === 'finish') finish = chunk.reason;
    }
  } catch (error) {
    return { ok: false, error: `message generation failed: ${error?.message ?? String(error)}` };
  }

  if (finish?.kind === 'error' || finish?.kind === 'aborted') {
    return { ok: false, error: `message generation failed: ${finish.failure?.message ?? finish.kind}` };
  }
  if (finish?.kind === 'tool-calls') {
    return { ok: false, error: 'message generation failed: the model requested a tool call' };
  }

  const value = normalize(deltas === '' ? blocks.join('') : deltas);
  if (value === '') {
    // Reasoning shares the output budget, so a model that thinks its way through
    // the whole allowance finishes with `max-tokens` and not one word written.
    // That is worth naming — and worth one retry with room to spare — rather than
    // reporting the same "empty" as a model that simply said nothing.
    const spent = usage?.reasoningTokens === undefined ? '' : ` (${usage.reasoningTokens} reasoning tokens)`;
    return {
      ok: false,
      retryable: true,
      ranOutOfRoom: finish?.kind === 'max-tokens',
      error:
        finish?.kind === 'max-tokens'
          ? `the model used its whole ${maxTokens}-token budget${spent} without writing an answer`
          : emptyError,
    };
  }
  void finish;
  const isExplanation = normalize === normalizeExplanation;
  return {
    ok: true,
    ...(isExplanation ? { summary: value } : { message: value }),
    meta: {
      provider: route.provider,
      model: route.model,
      ...(meta ? meta(value) : {}),
      ...(finish?.kind === 'max-tokens' ? { truncated: true } : {}),
      ...(usage === undefined ? {} : { usage }),
    },
  };
}

/**
 * Run one text call, and give it a second chance when it came back with nothing.
 *
 * Only an empty answer is retried: a provider error, an abort, or a tool call is
 * a decision, not a fluke. When the first attempt ran out of room the retry gets
 * double the budget, which is what a reasoning model usually needs to reach the
 * part where it writes.
 */
export async function runTextCallWithRetry(options) {
  const first = await runTextCall(options);
  if (first.ok === true) {
    // An answer cut off by the output budget is not a failure, but for a reply
    // that has to be read as JSON it is useless past the cut. One retry with
    // twice the room is cheaper than asking the user to press the button again.
    if (options.retryOnTruncation === true && first.meta?.truncated === true) {
      const fuller = await runTextCall({ ...options, maxTokens: (options.maxTokens ?? 700) * 2 });
      if (fuller.ok === true && fuller.meta?.truncated !== true) return fuller;
    }
    return first;
  }
  if (first.retryable !== true) return first;
  const second = await runTextCall({
    ...options,
    maxTokens: (options.maxTokens ?? 700) * 2,
  });
  return second.ok === true ? second : first;
}
