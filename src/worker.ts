// The plugin's own worker. Orca starts it on the panel's first request and transpiles this
// file when it loads: no build step. A save restarts it and drops in-memory state, so the
// issue list lives in orca.storage and the token in orca.secrets.
//
// Every Grape call happens here, never in the panel: a panel frame has no network.
import type { OrcaWorkerApi } from 'orca/worker'
import type {
  BatchDispatchResult,
  ConnectionStatus,
  OrcaTargets,
  DispatchListResult,
  DispatchRecord,
  DispatchResult,
  GrapeFilter,
  GrapeIssue,
  GrapeIssueDetail,
  GrapeIssueLinks,
  IssueListResult,
  WriteBackResult
} from './protocol'
import {
  GrapeClient,
  GrapeError,
  buildDispatchPrompt,
  issueLinks,
  normalizeBaseUrl
} from './grape'

const SETTING_BASE_URL = 'baseUrl'
const SETTING_AGENT = 'defaultAgent'
const SETTING_STATUS = 'statusFilter'
const SETTING_REPO = 'repoKeyFilter'
const SETTING_EXTRA = 'extraInstructions'
const SETTING_AUTO_WRITEBACK = 'autoWriteBack'
const SETTING_WRITEBACK_STATUS = 'writeBackStatus'
const SETTING_MAX_BATCH = 'maxBatch'
const SETTING_VCS_HOST = 'vcsHost'
const SECRET_TOKEN = 'grape-token'
const STORAGE_ISSUES = 'issues'
const STORAGE_CHECKED_AT = 'checkedAt'
const STORAGE_DISPATCHES = 'dispatches'
/** A list younger than this is served without calling Grape, except on an explicit refresh. */
const CACHE_TTL_MS = 60_000
/** Hard ceiling on one batch: each issue starts its own agent and worktree. */
const MAX_BATCH_LIMIT = 8

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

/** Tests replace the network here so a write-back can be asserted without a server. Orca only
 *  calls the default export, so the extra export costs nothing at runtime. */
let clientFetch: typeof fetch | undefined

export function useFetchForTests(fetchImpl: typeof fetch | undefined): void {
  clientFetch = fetchImpl
}

function clientFor(baseUrl: string, token: string): GrapeClient {
  if (!token) {
    throw new GrapeError('No Grape API key is stored. Paste a grape_ key in the panel.', 'unauthorized')
  }
  return new GrapeClient({ baseUrl, token, fetchImpl: clientFetch })
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

// --- dispatches: the issue <-> workspace binding, and the write-back ----------------------

async function readDispatches(orca: OrcaWorkerApi): Promise<DispatchRecord[]> {
  const raw = await orca.storage.get(STORAGE_DISPATCHES)
  if (typeof raw !== 'string' || raw === '') return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as DispatchRecord[]) : []
  } catch {
    return []
  }
}

async function writeDispatches(
  orca: OrcaWorkerApi,
  records: DispatchRecord[]
): Promise<void> {
  // Newest first and bounded: this log is a convenience, not an archive.
  await orca.storage.set(STORAGE_DISPATCHES, JSON.stringify(records.slice(0, 50)))
}

function replaceRecord(records: DispatchRecord[], next: DispatchRecord): DispatchRecord[] {
  return [next, ...records.filter((record) => record.issueKey !== next.issueKey)]
}

async function readNumberSetting(
  orca: OrcaWorkerApi,
  key: string,
  fallback: number
): Promise<number> {
  const value = await orca.settings.get(key)
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function writeBackMessage(record: DispatchRecord, status: string, outcome?: string): string {
  const at = new Date(record.writeBackAt ?? Date.now()).toISOString()
  return [
    `Orca agent ${record.agent} finished ${record.issueKey} in workspace "${record.workspaceName}".`,
    outcome ? `Agent outcome: ${outcome}.` : '',
    `Status set to ${status || '(unchanged)'} by the Grape Tasks Orca plugin at ${at}.`,
    'Approving or rejecting needs an agent session token, so this plugin leaves the final review to a person.'
  ]
    .filter(Boolean)
    .join('\n')
}

/** The one place a result goes back to Grape. Idempotent: a record already written back is not
 *  written twice, so a repeated agent event cannot post a second comment. */
async function writeBackOnce(
  orca: OrcaWorkerApi,
  record: DispatchRecord,
  outcome?: string
): Promise<WriteBackResult> {
  if (record.state === 'written-back') {
    return {
      issueKey: record.issueKey,
      status: record.writeBackStatus ?? '',
      commentPosted: false,
      error: 'already written back'
    }
  }

  const { baseUrl, token } = await readConnection(orca)
  const status = await readSetting(orca, SETTING_WRITEBACK_STATUS)
  const records = await readDispatches(orca)
  let commentPosted = false
  try {
    const client = clientFor(baseUrl, token)
    if (status) await client.setStatus(record.issueId, status)
    const next: DispatchRecord = {
      ...record,
      state: 'written-back',
      writeBackAt: Date.now(),
      writeBackStatus: status
    }
    let error: string | undefined
    try {
      await client.clarify(record.issueId, writeBackMessage(next, status, outcome))
      commentPosted = true
    } catch (clarifyError) {
      // The status change already landed. A refused comment must not be reported as a failed
      // write-back, or the person retries a transition that already happened.
      error = clarifyError instanceof Error ? clarifyError.message : String(clarifyError)
    }
    await writeDispatches(orca, replaceRecord(records, next))
    orca.panels.post('grape.dispatches.changed', { records: await readDispatches(orca) })
    await updateStatusBarFromCache(orca)
    orca.log(`write-back ${record.issueKey} status=${status || '(none)'} comment=${commentPosted}`)
    return { issueKey: record.issueKey, status, commentPosted, error }
  } catch (writeError) {
    const message = writeError instanceof Error ? writeError.message : String(writeError)
    await writeDispatches(orca, replaceRecord(records, { ...record, state: 'failed', writeBackError: message }))
    orca.panels.post('grape.dispatches.changed', { records: await readDispatches(orca) })
    orca.log(`write-back failed ${record.issueKey}: ${message}`)
    return { issueKey: record.issueKey, status, commentPosted, error: message }
  }
}

async function updateStatusBarFromCache(orca: OrcaWorkerApi): Promise<void> {
  const { issues } = await readCache(orca)
  await updateStatusBar(orca, issues)
}

/** Git projects a batch may branch from, plus the focused workspace's project whatever its kind.
 *  The panel shows the Git ones and explains the folder one instead of letting Orca refuse per
 *  issue ("folder projects have no worktrees", raised once per selection). */
async function readTargets(orca: OrcaWorkerApi): Promise<OrcaTargets> {
  const [projects, ctx, list] = await Promise.all([
    orca.host.call('project.list'),
    orca.host.call('workspace.readContext'),
    orca.host.call('workspace.list')
  ])
  const focusedRow =
    ctx?.workspaceId !== undefined
      ? list.workspaces.find((workspace) => workspace.id === ctx.workspaceId)
      : undefined
  const focusedProject = focusedRow?.projectId
    ? projects.projects.find((candidate) => candidate.id === focusedRow.projectId)
    : undefined
  return {
    projects: projects.projects
      .filter((project) => project.kind === 'git')
      .map((project) => ({ id: project.id, name: project.name, hostId: project.hostId })),
    focused:
      focusedRow?.projectId && focusedProject
        ? {
            projectId: focusedRow.projectId,
            name: focusedProject.name,
            kind: focusedProject.kind
          }
        : null
  }
}

/** The project a batch branches from: the one the person picked, else the focused workspace's,
 *  and only ever a Git project. */
async function resolveTarget(
  orca: OrcaWorkerApi,
  projectId?: string
): Promise<{ projectId: string; hostId: string | null; baseBranch: string | null; displayName: string }> {
  const [projects, ctx, list] = await Promise.all([
    orca.host.call('project.list'),
    orca.host.call('workspace.readContext'),
    orca.host.call('workspace.list')
  ])
  const focusedRow =
    ctx?.workspaceId !== undefined
      ? list.workspaces.find((workspace) => workspace.id === ctx.workspaceId)
      : undefined
  const picked = projectId !== undefined && projectId !== ''
    ? projects.projects.find((candidate) => candidate.id === projectId)
    : undefined
  if (projectId !== undefined && projectId !== '' && !picked) {
    throw new Error(
      `The chosen project (${projectId}) is no longer in Orca. Pick another Git project in the batch bar.`
    )
  }
  const target =
    picked ??
    (focusedRow?.projectId
      ? projects.projects.find((candidate) => candidate.id === focusedRow.projectId)
      : undefined)

  if (!target) {
    const gitProjects = projects.projects.filter((project) => project.kind === 'git')
    throw new Error(
      gitProjects.length > 0
        ? `Pick a Git project in the batch bar (${gitProjects.map((project) => project.name).join(', ')}), then dispatch again.`
        : 'Orca has no Git project to branch from. Add the repository as a Git project first.'
    )
  }
  if (target.kind !== 'git') {
    throw new Error(
      `"${target.name}" is a folder project, and folder projects have no worktrees. Pick a Git project in the batch bar to dispatch a batch.`
    )
  }
  return {
    projectId: target.id,
    hostId: target.hostId,
    // An explicitly picked project has no focused branch to copy, so Orca uses its own default.
    baseBranch: picked ? null : (focusedRow?.branch ?? null),
    displayName: picked ? target.name : (focusedRow?.name || ctx?.displayName || target.name)
  }
}

function branchNameFor(issue: GrapeIssue): string {
  const slug = issue.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return `grape/${issue.number}${slug ? `-${slug}` : ''}`
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
    // Remember the binding: without it a finished agent has nothing to write back to.
    await writeDispatches(
      orca,
      replaceRecord(await readDispatches(orca), {
        issueKey: issue.key,
        issueId: issue.id,
        repoKey: issue.repoKey,
        number: issue.number,
        title: issue.title,
        workspaceId: result.workspaceId,
        workspaceName: result.workspaceName,
        terminalId: result.terminalId,
        agent: chosenAgent,
        dispatchedAt: Date.now(),
        state: 'running'
      })
    )
    orca.panels.post('grape.dispatched', result)
    orca.panels.post('grape.dispatches.changed', { records: await readDispatches(orca) })
    return result
  })

  orca.panels.handle('grape.dispatch.list', async (): Promise<DispatchListResult> => ({
    records: await readDispatches(orca)
  }))

  orca.panels.handle('orca.targets', async (): Promise<OrcaTargets> => readTargets(orca))

  orca.panels.handle('grape.dispatch.writeBack', async ({ issueKey }): Promise<WriteBackResult> => {
    const record = (await readDispatches(orca)).find((candidate) => candidate.issueKey === issueKey)
    if (!record) {
      throw new Error(`${issueKey} was not dispatched from this Orca, so there is nothing to write back.`)
    }
    return writeBackOnce(orca, record)
  })

  orca.panels.handle('grape.issue.links', async ({ issueKey }): Promise<GrapeIssueLinks> => {
    const issue = (await readCache(orca)).issues.find((candidate) => candidate.key === issueKey)
    if (!issue) {
      throw new GrapeError(`Issue ${issueKey} is not in the cached list. Refresh first.`, 'not_found')
    }
    const { baseUrl } = await readConnection(orca)
    return issueLinks(issue.repoKey, issue.number, {
      grapeBaseUrl: baseUrl,
      vcsHostOverride: await readSetting(orca, SETTING_VCS_HOST)
    })
  })

  orca.panels.handle(
    'grape.issues.dispatchBatch',
    async ({ issueKeys, agent, projectId }): Promise<BatchDispatchResult> => {
      const requested = (issueKeys ?? []).filter((key) => typeof key === 'string' && key !== '')
      if (requested.length === 0) throw new Error('No issues were selected.')
      const { issues } = await readCache(orca)
      // The person picks the target project in the batch bar; the focused workspace is only the
      // default. A folder project can never be the target, and says so before anything starts.
      const project = await resolveTarget(orca, projectId)
      const chosenAgent = (agent || (await readSetting(orca, SETTING_AGENT)) || 'claude').trim()
      const extra = await readSetting(orca, SETTING_EXTRA)
      // Every issue starts its own worktree and agent: the cap keeps one press from opening a
      // dozen agents, and the overflow is reported rather than silently dropped.
      const limit = Math.min(
        Math.max(await readNumberSetting(orca, SETTING_MAX_BATCH, 3), 1),
        MAX_BATCH_LIMIT
      )

      const dispatched: DispatchRecord[] = []
      const failed: Array<{ issueKey: string; error: string }> = requested
        .slice(limit)
        .map((issueKey) => ({ issueKey, error: `beyond the batch limit of ${limit}` }))
      let records = await readDispatches(orca)

      for (const issueKey of requested.slice(0, limit)) {
        const issue = issues.find((candidate) => candidate.key === issueKey)
        if (!issue) {
          failed.push({ issueKey, error: 'not in the cached list' })
          continue
        }
        if (issue.isPr) {
          failed.push({ issueKey, error: 'pull request card, not an issue' })
          continue
        }
        const name = branchNameFor(issue)
        try {
          const created = await orca.host.call('workspace.create', {
            projectId: project.projectId,
            hostId: project.hostId ?? undefined,
            name,
            baseBranch: project.baseBranch ?? undefined,
            agent: chosenAgent,
            prompt: buildDispatchPrompt(issue, extra)
          })
          const record: DispatchRecord = {
            issueKey: issue.key,
            issueId: issue.id,
            repoKey: issue.repoKey,
            number: issue.number,
            title: issue.title,
            workspaceId: created.workspaceId,
            workspaceName: name,
            terminalId: created.terminalId ?? '',
            agent: chosenAgent,
            dispatchedAt: Date.now(),
            state: 'running'
          }
          records = replaceRecord(records, record)
          dispatched.push(record)
        } catch (error) {
          failed.push({ issueKey, error: error instanceof Error ? error.message : String(error) })
        }
      }

      await writeDispatches(orca, records)
      orca.panels.post('grape.dispatches.changed', { records: await readDispatches(orca) })
      await orca.host
        .call('notifications.show', {
          title: `Grape: ${dispatched.length} agent(s) started`,
          body: failed.length > 0 ? `${failed.length} issue(s) could not start` : 'Every selected issue started'
        })
        .catch(() => {})
      orca.log(`batch: started ${dispatched.length}, failed ${failed.length}`)
      return { dispatched, failed }
    }
  )

  // The closed loop. An agent Orca reports as done must write its result back exactly once;
  // the record's own state is what stops a second comment on a repeated event.
  orca.events.on('agent.status.changed', async (event) => {
    if (event.state !== 'done') return
    const record = (await readDispatches(orca)).find((candidate) => {
      if (candidate.state !== 'running') return false
      // The terminal is the identity of the agent we started. A workspace is not: another
      // agent finishing in the same worktree must never write our issue back.
      if (candidate.terminalId && event.terminalId) {
        return candidate.terminalId === event.terminalId
      }
      // Only a record without a terminal (a batch whose workspace.create named none) may fall
      // back to the workspace, and only against an event that names no terminal either.
      return (
        candidate.terminalId === '' &&
        event.terminalId === undefined &&
        event.workspaceId !== null &&
        candidate.workspaceId === event.workspaceId
      )
    })
    if (!record) return
    if ((await orca.settings.get(SETTING_AUTO_WRITEBACK)) !== true) {
      orca.log(`${record.issueKey} finished; auto write-back is off`)
      return
    }
    await writeBackOnce(orca, record, event.mainAgent?.outcome)
  })
}
