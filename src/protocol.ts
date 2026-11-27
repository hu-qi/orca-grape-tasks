// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
//
// The panel runs in a sandboxed frame with no network, so every Grape call is a request to
// the worker. Keeping the shapes here means a renamed field is a type error on both sides.
export {}

/** One Grape issue, normalized from the /api/issues card shape. */
export interface GrapeIssue {
  /** Stable card key: `${repoKey}#${number}`. */
  key: string
  /** Ledger id used by Grape's issue endpoints; not the VCS issue number. */
  id: number
  /** VCS issue number, as it appears in the repository. */
  number: number
  repoKey: string
  title: string
  /** active / processing / awaiting_input / pending_review / completed / cancelled. */
  status: string
  /** Pipeline stage name, empty when the issue has no stage row yet. */
  stage: string
  sceneName: string
  assignee: string
  creator: string
  /** True while an agent task for this issue is running. */
  running: boolean
  /** A cross-repository A2A PR card, not a real issue row. */
  isPr: boolean
  description: string
  createdAt: string
}

/** One node of the issue pipeline roadmap. */
export interface PipelineNode {
  name: string
  status: string
}

/** The detail view: everything the panel shows once an issue is selected. */
export interface GrapeIssueDetail {
  key: string
  number: number
  repoKey: string
  title: string
  stage: string
  taskStatus: string
  ownerAgent: string
  assignee: string
  creator: string
  eventsCount: number
  attachmentsCount: number
  pipelineStatus: string
  nodes: PipelineNode[]
}

/** Connection state as the panel shows it. */
export interface ConnectionStatus {
  /** A base URL and a token are both stored. */
  configured: boolean
  baseUrl: string
  hasToken: boolean
  /** The last call to Grape succeeded. */
  reachable: boolean
  /** When the last successful call happened, or null. */
  checkedAt: number | null
  /** Why the last call failed, or null. Shown verbatim in the panel. */
  error: string | null
}

/** The filter the worker actually applied, so an empty list can explain itself. */
export interface GrapeFilter {
  /** Empty means every status. */
  status: string
  /** Empty means every repository. */
  repoKey: string
}

/** One page of the issue list. */
export interface IssueListResult {
  issues: GrapeIssue[]
  status: ConnectionStatus
  /** What was asked for on the last fetch, including when it answered from cache. */
  filter: GrapeFilter
  fetchedAt: number
  /** True when the worker answered from storage because Grape was unreachable. */
  fromCache: boolean
}

export interface DispatchResult {
  issueKey: string
  workspaceId: string
  workspaceName: string
  terminalId: string
  agent: string
}

/** Where an issue lives, for the links a card offers. `grape` may repeat the console root when
 *  the console has no per-issue route. */
export interface GrapeIssueLinks {
  grape: string
  issue: string
  repo: string
}

/** One dispatch this plugin started, and whether the result made it back to Grape. */
export interface DispatchRecord {
  issueKey: string
  /** Grape's ledger id: what the status and clarify endpoints take. */
  issueId: number
  repoKey: string
  number: number
  title: string
  workspaceId: string
  workspaceName: string
  terminalId: string
  agent: string
  dispatchedAt: number
  /** running = the agent may still be working; written-back = Grape has the result. */
  state: 'running' | 'written-back' | 'failed'
  writeBackAt?: number
  writeBackStatus?: string
  writeBackError?: string
}

export interface DispatchListResult {
  records: DispatchRecord[]
}

export interface WriteBackResult {
  issueKey: string
  /** The status Grape ended up with, when the write-back succeeded. */
  status: string
  commentPosted: boolean
  error?: string
}

export interface BatchDispatchResult {
  dispatched: DispatchRecord[]
  failed: Array<{ issueKey: string; error: string }>
}

declare module 'orca' {
  interface PluginRequests {
    /** Current connection state, without calling Grape. */
    'grape.connection.get': { output: ConnectionStatus }
    /** Stores base URL and, when given, the API key, then probes Grape with them. */
    'grape.connection.save': { input: { baseUrl: string; token?: string }; output: ConnectionStatus }
    /** Forgets the stored base URL and token. */
    'grape.connection.clear': { output: ConnectionStatus }
    /** Lists the current user's issues. `force` skips the cache. */
    'grape.issues.list': { input: { force?: boolean }; output: IssueListResult }
    /** Clears the status and repository filters, then lists again. One press to widen a search
     *  that returned nothing, instead of sending the person to Settings. */
    'grape.filter.all': { output: IssueListResult }
    /** Pipeline roadmap and counters of one issue. */
    'grape.issue.detail': { input: { issueKey: string }; output: GrapeIssueDetail }
    /** Starts an agent in the focused workspace with the issue as its prompt. */
    'grape.issue.dispatch': { input: { issueKey: string; agent?: string }; output: DispatchResult }
    /** The three links a card offers: Grape console, the source issue, the repository. */
    'grape.issue.links': { input: { issueKey: string }; output: GrapeIssueLinks }
    /** Every dispatch this plugin started, newest first. */
    'grape.dispatch.list': { output: DispatchListResult }
    /** Writes the issue's status and a comment back to Grape, once per dispatch. */
    'grape.dispatch.writeBack': { input: { issueKey: string }; output: WriteBackResult }
    /** Starts one agent per issue, each in its own new worktree. */
    'grape.issues.dispatchBatch': {
      input: { issueKeys: string[]; agent?: string }
      output: BatchDispatchResult
    }
  }

  interface PluginPanelEvents {
    /** Posted to every open panel after the list or the connection changes. */
    'grape.changed': IssueListResult
    /** Posted after a dispatch so the panel can show where it landed. */
    'grape.dispatched': DispatchResult
    /** Posted whenever a dispatch record changes state, including write-back. */
    'grape.dispatches.changed': DispatchListResult
  }
}
