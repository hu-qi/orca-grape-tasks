// The plugin's own worker. Orca starts it on the panel's first request and transpiles this
// file when it loads: no build step. A save restarts it and drops in-memory state, so the
// issue list lives in orca.storage and the token in orca.secrets.
//
// Every Grape call happens here, never in the panel: a panel frame has no network.
import type { OrcaWorkerApi } from 'orca/worker'
import type {
  ConnectionStatus,
  DispatchResult,
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
  if (typeof raw === 'string' && raw !== '') {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) issues = parsed as GrapeIssue[]
    } catch {
      issues = []
    }
  }
  return {
    issues,
    fetchedAt: typeof checkedAt === 'number' ? checkedAt : 0
  }
}

async function writeCache(orca: OrcaWorkerApi, cache: IssueCache): Promise<void> {
  await orca.storage.set(STORAGE_ISSUES, JSON.stringify(cache.issues))
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

/** The list the panel renders, cached first and refreshed from Grape when it is allowed. */
async function loadIssues(
  orca: OrcaWorkerApi,
  options: { force?: boolean } = {}
): Promise<IssueListResult> {
  const cache = await readCache(orca)
  const fresh = options.force !== true && Date.now() - cache.fetchedAt < CACHE_TTL_MS
  if (fresh && cache.issues.length > 0) {
    return {
      issues: cache.issues,
      status: await connectionStatus(orca, { reachable: true, checkedAt: cache.fetchedAt }),
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
      fetchedAt: cache.fetchedAt,
      fromCache: cache.issues.length > 0
    }
  }
  try {
    const client = clientFor(baseUrl, token)
    const status = await readSetting(orca, SETTING_STATUS)
    const repoKey = await readSetting(orca, SETTING_REPO)
    const issues = await client.listMine({ status, repoKey })
    const fetchedAt = Date.now()
    await writeCache(orca, { issues, fetchedAt })
    await updateStatusBar(orca, issues)
    return {
      issues,
      status: await connectionStatus(orca, { reachable: true, checkedAt: fetchedAt }),
      fetchedAt,
      fromCache: false
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Serving the last good list beats an empty panel when the VPN drops.
    return {
      issues: cache.issues,
      status: await connectionStatus(orca, { error: message }),
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
    try {
      const issues = await clientFor(normalized, stored).listMine({
        status: await readSetting(orca, SETTING_STATUS),
        repoKey: await readSetting(orca, SETTING_REPO)
      })
      const fetchedAt = Date.now()
      await writeCache(orca, { issues, fetchedAt })
      await updateStatusBar(orca, issues)
      const status = await connectionStatus(orca, { reachable: true, checkedAt: fetchedAt })
      orca.panels.post('grape.changed', {
        issues,
        status,
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
    await writeCache(orca, { issues: [], fetchedAt: 0 })
    await updateStatusBar(orca, [])
    return connectionStatus(orca, { reachable: false, error: null, checkedAt: 0 })
  })

  orca.panels.handle('grape.issues.list', async ({ force }) => {
    const result = await loadIssues(orca, { force })
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
