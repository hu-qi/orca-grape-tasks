// The plugin's own worker. Orca starts it on the panel's first request and transpiles this
// file when it loads: no build step. A save restarts it and drops in-memory state, so the
// issue list lives in orca.storage and the token in orca.secrets.
//
// Every Grape call happens here, never in the panel: a panel frame has no network.
import type { OrcaWorkerApi } from 'orca/worker'
import type {
  ConnectionStatus,
  DispatchResult,
  GrapeFilter,
  GrapeIssue,
  GrapeIssueDetail,
  IssueListResult
} from './protocol'
import { GrapeClient, GrapeError, buildDispatchPrompt, normalizeBaseUrl } from './grape'

const SETTING_BASE_URL = 'baseUrl'
const SETTING_AGENT = 'defaultAgent'
const SETTING_STATUS = 'statusFilter'
const SETTING_REPO = 'repoKeyFilter'
const SETTING_EXTRA = 'extraInstructions'
const SECRET_TOKEN = 'grape-token'
const STORAGE_ISSUES = 'issues'
const STORAGE_CHECKED_AT = 'checkedAt'
/** A list younger than this is served without calling Grape, except on an explicit refresh. */
const CACHE_TTL_MS = 60_000

interface IssueCache {
  issues: GrapeIssue[]
  fetchedAt: number
  /** The filter these rows were fetched with; rows from another filter are not an answer. */
  filter: GrapeFilter
}

const ALL_FILTER: GrapeFilter = { status: '', repoKey: '' }

function toFilter(value: unknown): GrapeFilter {
  const box = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return {
    status: typeof box.status === 'string' ? box.status : '',
    repoKey: typeof box.repoKey === 'string' ? box.repoKey : ''
  }
}

/** Reads one string setting. Orca hands back every owned setting as a JSON value. */
async function readSetting(orca: OrcaWorkerApi, key: string): Promise<string> {
  const value = await orca.settings.get(key)
  return typeof value === 'string' ? value.trim() : ''
}

async function readConnection(
  orca: OrcaWorkerApi
): Promise<{ baseUrl: string; token: string }> {
  const [baseUrl, secret] = await Promise.all([
    readSetting(orca, SETTING_BASE_URL),
    orca.secrets.get(SECRET_TOKEN)
  ])
  return { baseUrl, token: (secret ?? '').trim() }
}

/** The list is stored as JSON text: plugin storage takes plain JSON values, and an issue row
 *  has no index signature to satisfy that, while a string survives any future field rename. */
async function readCache(orca: OrcaWorkerApi): Promise<IssueCache> {
  const [raw, checkedAt] = await Promise.all([
    orca.storage.get(STORAGE_ISSUES),
    orca.storage.get(STORAGE_CHECKED_AT)
  ])
  let issues: GrapeIssue[] = []
  let filter: GrapeFilter = ALL_FILTER
  if (typeof raw === 'string' && raw !== '') {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        // Cache written before the filter was recorded: usable, but only for "all statuses".
        issues = parsed as GrapeIssue[]
      } else if (parsed && typeof parsed === 'object') {
        const box = parsed as Record<string, unknown>
        if (Array.isArray(box.issues)) issues = box.issues as GrapeIssue[]
        filter = toFilter(box.filter)
      }
    } catch {
      issues = []
    }
  }
  return {
    issues,
    fetchedAt: typeof checkedAt === 'number' ? checkedAt : 0,
    filter
  }
}

async function writeCache(orca: OrcaWorkerApi, cache: IssueCache): Promise<void> {
  await orca.storage.set(
    STORAGE_ISSUES,
    JSON.stringify({ issues: cache.issues, filter: cache.filter })
  )
  await orca.storage.set(STORAGE_CHECKED_AT, cache.fetchedAt)
}

/** State as the panel shows it, without touching the network. */
async function connectionStatus(
  orca: OrcaWorkerApi,
  patch: { reachable?: boolean; error?: string | null; checkedAt?: number } = {}
): Promise<ConnectionStatus> {
  const { baseUrl, token } = await readConnection(orca)
  const { fetchedAt } = await readCache(orca)
  const reachable = patch.reachable ?? (patch.error ? false : fetchedAt > 0)
  return {
    configured: Boolean(baseUrl && token),
    baseUrl,
    hasToken: Boolean(token),
    reachable,
    checkedAt: patch.checkedAt ?? (fetchedAt > 0 ? fetchedAt : null),
    error: patch.error ?? null
  }
}

function clientFor(baseUrl: string, token: string): GrapeClient {
  if (!token) {
    throw new GrapeError('No Grape API key is stored. Paste a grape_ key in the panel.', 'unauthorized')
  }
  return new GrapeClient({ baseUrl, token })
}

/** The filter as stored. Both empty means every status in every repository. */
async function currentFilter(orca: OrcaWorkerApi): Promise<GrapeFilter> {
  const [status, repoKey] = await Promise.all([
    readSetting(orca, SETTING_STATUS),
    readSetting(orca, SETTING_REPO)
  ])
  return { status, repoKey }
}

function sameFilter(a: GrapeFilter, b: GrapeFilter): boolean {
  return a.status === b.status && a.repoKey === b.repoKey
}

/** The list the panel renders, cached first and refreshed from Grape when it is allowed. */
async function loadIssues(
  orca: OrcaWorkerApi,
  options: { force?: boolean } = {}
): Promise<IssueListResult> {
  const filter = await currentFilter(orca)
  const cache = await readCache(orca)
  // A cache filled under a different filter is not this filter's answer: showing it would label
  // another query's rows with the current one. A fresh empty answer counts as an answer, which
  // is why this checks fetchedAt rather than the row count.
  const fresh =
    options.force !== true &&
    sameFilter(cache.filter, filter) &&
    cache.fetchedAt > 0 &&
    Date.now() - cache.fetchedAt < CACHE_TTL_MS
  if (fresh) {
    return {
      issues: cache.issues,
      status: await connectionStatus(orca, { reachable: true, checkedAt: cache.fetchedAt }),
      filter,
      fetchedAt: cache.fetchedAt,
      fromCache: true
    }
  }

  const { baseUrl, token } = await readConnection(orca)
  // Nothing configured is not an error to report: the panel shows the connection form instead,
  // and firing a request with no key would paint a red banner over a first-run panel.
  if (!baseUrl || !token) {
    return {
      issues: cache.issues,
      status: await connectionStatus(orca, { reachable: false, error: null }),
      filter,
      fetchedAt: cache.fetchedAt,
      fromCache: cache.issues.length > 0
    }
  }
  try {
    const client = clientFor(baseUrl, token)
    const issues = await client.listMine(filter)
    const fetchedAt = Date.now()
    await writeCache(orca, { issues, fetchedAt, filter })
    await updateStatusBar(orca, issues)
    // `orca plugin logs` should answer "why is my list empty" without a debugging session. The
    // key is never part of this: only the host, the filter and what came back.
    orca.log(
      `listMine ${baseUrl} status=${filter.status || '(all)'} repo=${filter.repoKey || '(all)'} -> ${
        issues.length
      } issue(s)`
    )
    return {
      issues,
      status: await connectionStatus(orca, { reachable: true, checkedAt: fetchedAt }),
      filter,
      fetchedAt,
      fromCache: false
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    orca.log(`listMine failed: ${message}`)
    // Serving the last good list beats an empty panel when the VPN drops.
    return {
      issues: cache.issues,
      status: await connectionStatus(orca, { error: message }),
      filter,
      fetchedAt: cache.fetchedAt,
      fromCache: cache.issues.length > 0
    }
  }
}

function waitingCount(issues: GrapeIssue[]): number {
  return issues.filter(
    (issue) =>
      issue.status === 'active' ||
      issue.status === 'awaiting_input' ||
      issue.status === 'pending_review' ||
      issue.running
  ).length
}

async function updateStatusBar(orca: OrcaWorkerApi, issues: GrapeIssue[]): Promise<void> {
  const waiting = waitingCount(issues)
  await orca.host.call('statusBar.update', {
    id: 'grape-summary',
    text: waiting > 0 ? `Grape ${waiting}` : 'Grape -',
    tone: waiting > 0 ? 'warning' : 'neutral',
    tooltip:
      issues.length > 0
        ? `${waiting} of ${issues.length} Grape issues waiting on you`
        : 'Grape Tasks: no issues'
  })
}

export default function activate(orca: OrcaWorkerApi): void {
  orca.panels.handle('grape.connection.get', async () => connectionStatus(orca))

  orca.panels.handle('grape.connection.save', async ({ baseUrl, token }) => {
    const normalized = normalizeBaseUrl(baseUrl)
    await orca.settings.set(SETTING_BASE_URL, normalized)
    if (token !== undefined && token.trim() !== '') {
      // Empty token means "keep the stored one": the panel shows it masked and a save with
      // no retyped key must not wipe it.
      await orca.secrets.set(SECRET_TOKEN, token.trim())
    }
    const { token: stored } = await readConnection(orca)
    const filter = await currentFilter(orca)
    try {
      const issues = await clientFor(normalized, stored).listMine(filter)
      const fetchedAt = Date.now()
      await writeCache(orca, { issues, fetchedAt, filter })
      await updateStatusBar(orca, issues)
      const status = await connectionStatus(orca, { reachable: true, checkedAt: fetchedAt })
      orca.panels.post('grape.changed', {
        issues,
        status,
        filter,
        fetchedAt,
        fromCache: false
      } satisfies IssueListResult)
      return status
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return connectionStatus(orca, { reachable: false, error: message })
    }
  })

  orca.panels.handle('grape.connection.clear', async () => {
    await orca.secrets.delete(SECRET_TOKEN)
    await orca.settings.set(SETTING_BASE_URL, '')
    await writeCache(orca, { issues: [], fetchedAt: 0, filter: ALL_FILTER })
    await updateStatusBar(orca, [])
    return connectionStatus(orca, { reachable: false, error: null, checkedAt: 0 })
  })

  orca.panels.handle('grape.issues.list', async ({ force }) => {
    const result = await loadIssues(orca, { force })
    orca.panels.post('grape.changed', result)
    return result
  })

  orca.panels.handle('grape.filter.all', async () => {
    // One press instead of sending the person into Settings: clear both filters, then answer
    // the wider question. The filters are the person's own settings, so this is their change.
    await orca.settings.set(SETTING_STATUS, '')
    await orca.settings.set(SETTING_REPO, '')
    const result = await loadIssues(orca, { force: true })
    orca.panels.post('grape.changed', result)
    return result
  })

  orca.panels.handle('grape.issue.detail', async ({ issueKey }) => {
    const { issues } = await readCache(orca)
    const cached = issues.find((issue) => issue.key === issueKey)
    if (!cached) {
      throw new GrapeError(`Issue ${issueKey} is not in the cached list. Refresh first.`, 'not_found')
    }
    const { baseUrl, token } = await readConnection(orca)
    const detail: GrapeIssueDetail = await clientFor(baseUrl, token).issueDetail(
      cached.repoKey,
      cached.number
    )
    return detail
  })

  orca.panels.handle('grape.issue.dispatch', async ({ issueKey, agent }): Promise<DispatchResult> => {
    const { issues } = await readCache(orca)
    const issue = issues.find((candidate) => candidate.key === issueKey)
    if (!issue) {
      throw new GrapeError(`Issue ${issueKey} is not in the cached list. Refresh first.`, 'not_found')
    }

    // A dispatch without a workspace would silently start an agent somewhere unexpected, so
    // an unfocused Orca window is an error the person can act on.
    const workspace = await orca.host.call('workspace.readContext')
    if (!workspace?.workspaceId) {
      throw new Error('No Orca workspace is focused. Open the repository workspace, then dispatch.')
    }

    if (issue.isPr) {
      throw new Error(`${issueKey} is a pull request card, not a Grape issue. Dispatch the issue itself.`)
    }

    const chosenAgent = (agent || (await readSetting(orca, SETTING_AGENT)) || 'claude').trim()
    const prompt = buildDispatchPrompt(issue, await readSetting(orca, SETTING_EXTRA))

    const launched = await orca.host.call('agent.launch', {
      workspaceId: workspace.workspaceId,
      agent: chosenAgent,
      prompt
    })

    await orca.host.call('workspace.open', { workspaceId: workspace.workspaceId }).catch(() => {
      // Focusing the window is a convenience; the agent already started.
    })
    await orca.host
      .call('notifications.show', {
        title: `Grape ${issue.key}`,
        body: `${chosenAgent} started in ${workspace.displayName || 'the focused workspace'}`
      })
      .catch(() => {})

    const result: DispatchResult = {
      issueKey: issue.key,
      workspaceId: workspace.workspaceId,
      workspaceName: workspace.displayName || workspace.branch || 'workspace',
      terminalId: launched.terminalId,
      agent: chosenAgent
    }
    orca.panels.post('grape.dispatched', result)
    return result
  })
}
