# GitMate

**A Git panel in the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) sidebar — plus the same operations as fifteen agent tools.**

Runs anywhere the Harness does: macOS, Linux, and Windows (PowerShell).

Only two things genuinely differ across platforms, and both live on the Host side: **how arguments are quoted** (PowerShell doubles a single quote, a POSIX shell closes-escapes-reopens; chosen by `process.platform`) and **how the environment is passed** (through the shell request's `env` field rather than a POSIX `VAR=value` prefix, which is not a command on Windows). Nothing else is platform-aware: paths go through `node:path`, nothing outside `lib/` is written, and no file needing an executable bit is created. When the sandbox will not start, the advice **names the cause for the platform you are on** (bubblewrap/Landlock on Linux, `sandbox-exec` on macOS, `%TEMP%` on Windows).

English | [中文](README.zh.md)

Review changes, read diffs, stage, commit with a generated message, merge, stash, sync, and rewind history without leaving the panel. Every operation is also a tool the agent can call, so asking in chat works too.

```sh
dsh plugin --profile web add github:alanhaskey/dsh-gitmate
```

Restart DSH once, refresh the page, then open **GitMate** from the sidebar's **+** menu.

> The internal ids (Loader row `dsh-git`, tab key) differ from the package name on purpose: the row id is the key of a config row you may already have, and renaming it would orphan your saved settings.

## Reviewing and committing

- **Four groups** — conflicts, staged, changes, untracked. Each row shows the kind in words, the path, and that file's `+N −M`. Row actions stage, unstage, and discard, with a second click for anything destructive.
- **Diffs like an editor** — two line-number gutters, `+`/`−` markers, tinted rows, and only the changed span of a replaced line marked. Click a file to expand it in place; click again to collapse. Widen the context from 3 lines to 24 when a hunk needs more of the file.
- **One row of list actions**, shown only when they would do something, with the counts in the labels.
- **Amend** — fold the staged changes into the previous commit; leaving the message box empty keeps the existing message.
- **A draggable splitter** between the list and the commit card resizes the message box.
- **A panel that is working says so** — every operation shows a turning indicator and names itself ("Committing…", "Reviewing the staged changes…") instead of only greying its buttons out. It sits with the messages at the foot of the list, above the splitter, so it never covers the commit box.

## AI features

| Feature | What it does |
| --- | --- |
| **Commit message** | Generated from the staged diff. If you have already typed something, the button becomes *Refine draft*: the model keeps your intent and fills in the rest instead of replacing it. |
| **Review before commit** | Reads the staged changes and reports only what would bite — a wrong result, a missed edge case, an unhandled error, a committed secret, debug output left in, a behaviour change with no test. Click a finding to open that file's diff. |
| **Split this commit** | Divides the staged changes into commits that each stand on their own, with a message for each. The plan is a draft you can edit: rewrite any message, merge a group into the one above, remove one, ask for a new plan, commit one group at a time, or commit them all in order. Each commit leaves the other files staged. |
| **Explain a change** | Two to five bullets on what a file's change does, so you can review without reading every line. |
| **`.gitignore`** | Infers the rules from the project's manifests and layout. One button creates it; one adds what is missing **and tidies the whole file** — exact duplicates, rules an earlier broader rule already covers (`node_modules/.cache/` after `node_modules/`), and runs of blank lines. It groups entries under headings only when that cannot change the meaning: with a `!` rule (git decides by the last match, so order is semantic) or with your own comments, the order is kept and the panel says so. |

Buttons that call a model are marked **AI**. Every generation uses the session's default model — there is no second model to configure.

## Branches, history, remotes

- **Branch selector** — switch, create, delete, and merge any branch into the checked-out one. A conflicted merge is reported with the files that need a decision, and can be aborted.
- **Commit graph** — every branch and remote-tracking branch, not just this one. Strokes are computed on the Host and shipped with the data, so "the rows join up" is an assertion rather than something to eyeball. Two things make it hold:

- **The straight runs are elements pinned to the row's bottom**, not coordinates inside a fixed-height box. A row's height is not fixed — expanding a commit makes it much taller — and a fixed box left a gap between every pair of rows, which is what made the tree look like it was floating.
- **When several lanes wait for the same commit, all but the claimed one are released.** Otherwise they keep waiting for a commit already emitted and drag a line to the bottom with no commit on it — the other half of the floating look.

A branch opening here starts **below** the node and one converging here arrives **above** it, each joined to the node by a curve; one hue carries three weights — the commit's own line, the branch curves, and the lanes merely passing through. Expand a commit for its full message, the files it touched, and what you can do to it: rewind, revert, cherry-pick, rebase, or tag. Click a changed file to see its diff inside that commit.
- **Remotes** — push, pull, fetch, and a **Sync** that fetches, fast-forwards, then pushes. It refuses to merge a diverged branch rather than inventing a merge commit.
- **Stash** — set work aside and take it back later (pop, apply, drop).

## A directory holding several repositories

A workspace root is often just a **container for several projects** — not a repository itself, with `alpha/` and `beta/` below it. Asking "is this a repository" answers "no" for every one of them, so the panel used to offer only to initialise a new one.

The panel now **finds the repositories under that root** (three levels deep, skipping `node_modules`/`vendor`/`dist` and the like, at most forty), lists them, and works on the one you pick. A chip in the header takes you back to the list. **When the root is itself a repository it lists only itself**, so nested submodules are not offered as separate projects.

The boundary: the panel only accepts a path **inside the session's directory** — `/etc`, or anything that climbs out with `../..`, is ignored and the session's own folder is used instead. The agent tools work the same way: point one at a subdirectory and git finds the repository root by itself.

## Setup

Without a repository the **history button is disabled** — there is no history to show — while **settings stays reachable**, because that is where someone looks when the panel is not doing what they expect. If the repository disappears while the panel is open (the folder changed, `.git` was removed), the view falls back to the change list rather than leaving the button lit on a view that cannot render.



One click initialises a repository and writes the local commit identity; two buttons handle `.gitignore`. Nothing is chosen from a list of ecosystems — the plugin reads the project and decides.

## Configuration

Settings live in this plugin's own row in `cordis.patch.yml`, so they survive upgrades and stay visible on the Plugins page. Everything below is a button or a checkbox; there is nothing to type unless you want custom instructions.

| Key | Default | Meaning |
| --- | --- | --- |
| `messageLanguage` | `auto` | Language of generated text: `auto` (follow the repository), `en`, `zh`. When unset or `auto`, the panel's own messages read as Chinese. |
| `messageStyle` | `conventional` | `conventional` (`feat: …`) or `plain`. |
| `messageTemplate` | — | Extra instructions, appended last so they override the defaults. |
| `signoff` | `false` | Add a `Signed-off-by` trailer. |
| `defaultBranch` | `main` | Branch created by *Initialise*. |
| `maxPromptBytes` | `24000` | Diff text handed to the model per change set. |
| `maxDiffBytes` | `80000` | Patch text a tool returns before truncating. |
| `commandTimeoutMs` | `60000` | Per git command; network commands get four times this. |

## Safety

- **Nothing destructive happens on a single click.** Discarding, deleting a branch, dropping a stash, rebasing, and rewinding all ask first, and say what will be lost.
- **Rewinding and reverting are separate**, because they are: rewinding moves the branch and rewrites history, reverting adds an inverse commit and is safe for anything already pushed. The panel warns before a rewind that would rewrite published history.
- **"Undo this commit" and "rewind to here" are separate too.** On the newest commit the button undoes that commit and leaves its changes staged, unstaged, or deleted as you choose; on an older commit it moves the branch pointer back to that commit. The notice names the commit that was actually undone and always states how many were discarded — including none.
- **A refusal says which mode refused.** A read-only session cannot write `.git`, so committing and switching branches are rejected by design; the message names the mode and what to switch to. If it is already `danger-full-access` and still refused, the sandbox backend on that machine is refusing writes and the Harness needs restarting — two different problems, told apart.
- **git's own diagnostics are pinned to English** (`LC_ALL=C`). The plugin's text is still localised by the setting; git's is kept stable because the phrase table in `lib/text.js` matches English sentences, and a localised git defeats it — worse on Windows, where git writes in the console code page and the pipeline decodes UTF-8, so a Chinese message arrives as mojibake.
- **The panel follows the permission mode of the session it belongs to.** Every panel request is bound to a session — it is that session's tab — so git runs under that session's mode rather than the deployment default. This matters: where the default (`workspace-write`) cannot start, the panel could not run git at all, whatever the user set on their own session.
- **Every tool call runs git under the calling session's permission mode**, with the deployment default only as a fallback. The panel's route has no session, so it passes no policy at all and leaves the choice to the Host.
- **When git cannot run at all, the panel stops re-probing every five seconds.** `unavailable` is not transient: each probe re-attempts the same sandbox start-up, and on Windows a failed one has been observed to leave the whole run unable to write. It says so once and offers a retry instead of retriggering it.
- **"git could not be run" and "this is not a repository" are different failures**, and the panel says which: the first gives the reason and a retry instead of inviting you to `git init` a repository that exists and merely cannot be read. An environment problem such as a sandbox that will not start is explained in one sentence, with the original cause kept.
- **Model output is treated as untrusted input.** A review finding that names a file which is not staged is dropped; a split plan that does not cover every staged file is flagged; an answer that does not parse is shown as-is rather than reported as "nothing found".
- **Nothing is committed, pushed, or repaired automatically.** The AI features produce material for a decision, not the decision.

## Development

```sh
node test/smoke.mjs     # 634 assertions; runs real git, no DSH required
```

```
lib/plugin.js      entry point; reloads the implementation when it changes
lib/impl.js        operations + the fifteen agent tools
lib/git-core.js    git operations, patch parsing, the commit-graph layout
lib/messages.js    prompts and model calls for text generation
lib/review.js      pre-commit review and split planning
lib/text.js        panel messages in both languages
lib/rpc.js         the panel's HTTP route
lib/client.js      the browser half (no build step, no dependencies)
```

The bundle has no dependencies at all — nothing to install, nothing to duplicate inside the profile. `lib/client.js` is hand-written, so a change to it needs only a page refresh; a change to the Host half needs the bundle reloaded.

## License

[MIT](LICENSE)
