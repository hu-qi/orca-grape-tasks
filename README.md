# Grape Tasks for Orca

An Orca sidebar panel that lists **your Grape issues** and dispatches one into the
focused workspace as an agent prompt.

Grape is an internal issue-driven agent platform (FastAPI backend, `/api/issues/*`).
This plugin is the desktop bridge: read the requirement in Orca, press one button, and the
coding agent starts in the workspace you already have open.

## What it contributes

| Surface | What |
| --- | --- |
| Panel | `Grape Tasks` — your issue list, status badges, detail view, dispatch button |
| Command | `Grape Tasks: Refresh my issues` (palette) |
| Status bar | `Grape -` summary of issues waiting on you |

`execution: trusted-worker` — the worker is a Node process on your machine. The panel
itself has no network access, so every Grape call is made by the worker and reached from
the panel through `plugin.request`.

## Setup

1. Enable the plugin in Orca. It asks for these capabilities, and nothing else:

   | Capability | Why |
   | --- | --- |
   | `settings:own` | base URL, default agent, status filter |
   | `secrets:own` | your `grape_` API key (OS keyring, never in settings) |
   | `storage:own` | last issue list, so the panel opens instantly |
   | `workspace:read` | find the focused workspace and its agents |
   | `workspace:write` | focus the workspace a dispatch landed in |
   | `workspace:create` | give each issue in a batch its own worktree |
   | `agent:read` | show whether an agent is already running |
   | `agent:launch` | start the agent with the issue prompt |
   | `notifications:show` | tell you when a dispatch starts or fails |

2. Open the panel, fill **Grape base URL** (for example `http://grape.internal:8080`) and the
   API key in the connection row. The key is sent as a `PRIVATE-TOKEN` header, which is the
   same credential a GitLab-style personal token uses.
3. Press **Save & test**. The worker calls `GET /api/issues/mine?status=active` with the
   key; success means you are connected and the list fills in.

## Dispatch

Pressing **Dispatch** on an issue:

1. reads the focused workspace (`workspace.readContext`) — no workspace focused is an error,
   not a silent fallback;
2. builds a prompt from the issue number, title, status and description, plus your
   **Extra dispatch instructions** setting;
3. calls `agent.launch` in that workspace and focuses it;
4. records the binding (`issue ↔ workspace ↔ terminal`) so the result can find its way back;
5. posts a notification with the issue key.

A single dispatch starts where you are. **Batch** dispatch (select rows, then *Dispatch N
selected*) is different: each issue gets its own branch and worktree through
`workspace.create`, because several agents in one worktree would collide. `maxBatch` caps
one press, and anything over the cap is reported back instead of being dropped.

## Closed loop: the result goes back to Grape

Grape is the system of record, so a dispatch that never reports back just moves the copying
problem elsewhere. When Orca reports one of our agents as `done`, the worker:

1. matches the event to a dispatch record by **terminal id** (a workspace match would let
   another agent's completion write our issue back);
2. sets the issue status (`writeBackStatus`, default `pending_review`);
3. posts one comment with the agent, the workspace and the outcome.

The record's own state makes this happen **once**: a repeated `done` event cannot post a
second comment. If the status lands but the comment is refused, the write-back is reported as
partial rather than failed, so you are not tempted to retry a transition that already
happened. `autoWriteBack` turns the whole thing off; the **Dispatched** section in the panel
lists every dispatch and offers **Write back** for the manual case.

## Card links

A selected issue offers three jumps: **Source issue** and **Repository** on the code host,
and the **Grape console**. The code host follows the repository's provider — `github.com` for
`github:`, `gitcode.com` otherwise, exactly as Grape's own dashboard resolves it. For any
other host (self-hosted GitLab) set **Self-hosted code host** in the plugin settings; without
it those two links are hidden rather than guessed, because a wrong link looks like a bug.

Grape's console SPA has no per-issue route (only `#/` and `#event/<seq>`), so the console
link opens the console root.

## Why the review buttons are missing

Only `review-pass` and `review-reject` are session-only: they go through
`_session_devops_issue`, which needs the `tk_` token Grape injects into an agent's own
execution environment, so a personal `grape_` key gets `403`. Everything else this plugin
touches works with a personal key — verified against a live server:

| Call | Personal `grape_` key |
| --- | --- |
| `PUT /api/issues/{id}/status` | works |
| `POST /api/issues/{id}/clarify` | works |
| `POST /api/issues/{id}/pending-review` | works |
| `POST /api/issues/{id}/awaiting-input` | works |
| `POST /api/issues/{id}/review-pass` | `403` (session token only) |
| `POST /api/issues/{id}/review-reject` | `403` (session token only) |

So the plugin writes status and comments back, and leaves the final approve/reject to a
person in Grape. A button that always fails would be worse than no button.

## Develop

```bash
orca plugin validate . --json     # manifest + literal host.call names
orca plugin types . --json        # refresh .orca/types (git-ignored)
npx -y -p typescript@5 tsc -p .   # types only, no build step
orca plugin test . --json         # unit tests
orca plugin check . --json        # render every panel, unsandboxed
orca plugin inspect . --json      # what it contributes and what it asks for
```

Keep `node_modules` **out of this folder**. Orca hashes the plugin's own files to produce
`contentHash`, and a local `npm install` drops `node_modules/.bin/*` symlinks into it, which
`plugin validate` rejects with `symlink not allowed in plugin content`. Run `tsc` from a
throwaway install instead, as above.

Loading a `trusted-worker` plugin needs your approval once
(`--approve <fingerprint>` from the `approval_required` error); approving grants real
access on your machine, so read the capability list first.

## Layout

```
orca-plugin.json     manifest: panel, command, status bar, settings, capabilities
src/protocol.ts      the panel <-> worker contract, declared once
src/grape.ts         Grape REST client + issue normalization (no Orca imports)
src/worker.ts        Orca glue: settings, secrets, storage, agent.launch
src/panel.tsx        components panel
src/panel.check.ts   states rendered by `orca plugin check`
src/*.test.ts(x)     unit tests
```

## Naming and publishing

Plugin id `grape-tasks` — ids starting with `orca-` are reserved by Orca. The repository is
`orca-grape-tasks` by community convention (`orca-<thing>`), the manifest id does not have to
match the folder. The publisher is the GitHub repository owner, so the installed plugin key is
`hu-qi.grape-tasks`.

The community directory has **no form and no PR queue**: it is generated. Listing takes three
things, then machine checks run and a page appears at
`orca.dev/plugins/<owner>/<repo>` within about an hour:

```bash
gh repo edit <owner>/<repo> --add-topic orca-plugin   # 1. discoverable
git tag v0.2.0 && git push origin v0.2.0              # 2. a vX.Y.Z tag (pushes without one change nothing)
# 3. the repo is public, the manifest is format 2, and a license is set in the manifest or LICENSE
```

`orca plugin release-entry . --json` is the catalog entry as the indexer would build it
(commit, contentHash, contributions). Keep its output **outside this folder**: the entry hashes
the plugin's own files, so a JSON file dropped here changes `contentHash` and no longer matches
what was published.

Requirements that reject a listing: manifest format 1, no license, binary files (executables,
archives, symlinks — so never `npm install` here), a publisher that differs from the repo owner
or imitates a reserved name (`orca…`, `official`, `github`), forks, archived repos, and repos
without a version tag. A cover image is optional; cards without one get drawn art.


## License

MIT
