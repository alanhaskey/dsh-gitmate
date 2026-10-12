# GitMate

**A Git panel in the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) sidebar — plus the same operations as fifteen agent tools.**

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

## AI features

| Feature | What it does |
| --- | --- |
| **Commit message** | Generated from the staged diff. If you have already typed something, the button becomes *Refine draft*: the model keeps your intent and fills in the rest instead of replacing it. |
| **Review before commit** | Reads the staged changes and reports only what would bite — a wrong result, a missed edge case, an unhandled error, a committed secret, debug output left in, a behaviour change with no test. Click a finding to open that file's diff. |
| **Split this commit** | Divides the staged changes into commits that each stand on their own, with a message for each. Commit one group; the rest stay staged and the plan is redrawn. |
| **Explain a change** | Two to five bullets on what a file's change does, so you can review without reading every line. |
| **`.gitignore`** | Infers the rules from the project's manifests and layout. One button creates it, one adds what is missing. |

Buttons that call a model are marked **AI**. Every generation uses the session's default model — there is no second model to configure.

## Branches, history, remotes

- **Branch selector** — switch, create, delete, and merge any branch into the checked-out one. A conflicted merge is reported with the files that need a decision, and can be aborted.
- **Commit graph** — every branch and remote-tracking branch, not just this one. Expand a commit for its full message, the files it touched, and what you can do to it: rewind, revert, cherry-pick, rebase, or tag. Click a changed file to see its diff inside that commit.
- **Remotes** — push, pull, fetch, and a **Sync** that fetches, fast-forwards, then pushes. It refuses to merge a diverged branch rather than inventing a merge commit.
- **Stash** — set work aside and take it back later (pop, apply, drop).

## Setup

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
- **Model output is treated as untrusted input.** A review finding that names a file which is not staged is dropped; a split plan that does not cover every staged file is flagged; an answer that does not parse is shown as-is rather than reported as "nothing found".
- **Nothing is committed, pushed, or repaired automatically.** The AI features produce material for a decision, not the decision.

## Development

```sh
node test/smoke.mjs     # 497 assertions; runs real git, no DSH required
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
