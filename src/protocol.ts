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

/** One page of the issue list. */
export interface IssueListResult {
  issues: GrapeIssue[]
  status: ConnectionStatus
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
    /** Pipeline roadmap and counters of one issue. */
    'grape.issue.detail': { input: { issueKey: string }; output: GrapeIssueDetail }
    /** Starts an agent in the focused workspace with the issue as its prompt. */
    'grape.issue.dispatch': { input: { issueKey: string; agent?: string }; output: DispatchResult }
  }

  interface PluginPanelEvents {
    /** Posted to every open panel after the list or the connection changes. */
    'grape.changed': IssueListResult
    /** Posted after a dispatch so the panel can show where it landed. */
    'grape.dispatched': DispatchResult
  }
}
