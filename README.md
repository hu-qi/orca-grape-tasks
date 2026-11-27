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
4. posts a notification with the issue key.

The plugin deliberately does **not** create a branch or worktree for you. `workspace.create`
exists in the Orca host API, and adding it later only needs the `workspace:create`
capability; the MVP keeps the blast radius to "start an agent where you are".

## Why the review buttons are missing

Grape's `review-pass`, `review-reject` and `awaiting-input` endpoints only accept the
session `tk_` token that Grape injects into an agent's own execution environment; a
personal `grape_` key gets `403`. A desktop client therefore cannot approve on your behalf,
and pretending otherwise would produce a button that always fails. Review stays in the Grape
web UI, linked from the issue detail (`Open in Grape`).

Likewise the plugin never posts issue comments for the same reason: comment writes go to
the VCS issue and are gated the same way.

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

## Naming

Plugin id `grape-tasks` — ids starting with `orca-` are reserved by Orca. The repository is
`orca-grape-tasks` by community convention (`orca-<thing>`), the manifest id does not have to
match the folder. Publishing to the Orca marketplace means committing, tagging `v0.1.1`,
adding the `orca-plugin` topic to the repo, and pasting the output of
`orca plugin release-entry . --json` into the catalog.

## License

MIT
