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
export function buildUserPrompt(bundle) {
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
  };
  return [
    'Write the commit message for the change described by this JSON document.',
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
  style = 'conventional',
  language = 'auto',
  template = '',
  maxTokens = 700,
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
  const custom = String(template ?? '').trim();
  if (custom !== '') {
    // The user's own wording comes last so it can override the defaults above.
    rules.push(`Repository conventions supplied by the user, which take precedence over the rules above:\n${custom}`);
  }

  return runTextCall({
    llm,
    route,
    system: rules.join('\n\n'),
    messages: [{ role: 'user', content: [{ type: 'text', text: buildUserPrompt(bundle) }] }],
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
  maxTokens = 500,
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

  return runTextCall({
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
  let text = '';
  let finish;
  try {
    for await (const chunk of llm.stream({
      provider: route.provider,
      model: route.model,
      system,
      messages,
      maxTokens,
      ...(signal ? { signal } : {}),
    })) {
      if (chunk?.type === 'text-delta') text += chunk.text ?? '';
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

  const value = normalize(text);
  if (value === '') return { ok: false, error: emptyError };
  const isExplanation = normalize === normalizeExplanation;
  return {
    ok: true,
    ...(isExplanation ? { summary: value } : { message: value }),
    meta: {
      provider: route.provider,
      model: route.model,
      ...(meta ? meta(value) : {}),
      ...(finish?.kind === 'max-tokens' ? { truncated: true } : {}),
    },
  };
}
