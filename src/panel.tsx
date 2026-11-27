// No build step: Orca strips the types and compiles the JSX when the panel loads.
//
// This frame has no network. Every Grape call is a request to src/worker.ts; the panel only
// holds render state and never learns the API key.
import {
  Badge,
  Button,
  Callout,
  Card,
  Collapsible,
  EmptyState,
  Heading,
  IconButton,
  Input,
  Row,
  Select,
  Separator,
  Spinner,
  Stack,
  Table,
  Text,
  atom,
  plugin,
  read,
  set,
  shell,
  type PanelContext
} from 'orca'
import type {
  ConnectionStatus,
  DispatchRecord,
  GrapeFilter,
  GrapeIssue,
  GrapeIssueDetail,
  GrapeIssueLinks,
  IssueListResult
} from './protocol'

const issues = atom<GrapeIssue[]>([])
const status = atom<ConnectionStatus | null>(null)
/** The filter the shown list was fetched with, so an empty list can name it. */
const filter = atom<GrapeFilter>({ status: '', repoKey: '' })
const selectedKey = atom<string>('')
const selectedRows = atom<string[]>([])
const detail = atom<GrapeIssueDetail | null>(null)
const links = atom<GrapeIssueLinks | null>(null)
const dispatches = atom<DispatchRecord[]>([])
const fetchedAt = atom<number>(0)
const fromCache = atom<boolean>(false)
const busy = atom<string>('')
const notice = atom<{ tone: 'success' | 'danger' | 'warning'; text: string } | null>(null)
const baseUrlDraft = atom<string>('')
const tokenDraft = atom<string>('')
const agent = atom<string>('claude')

const AGENTS = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'gemini', label: 'Gemini CLI' }
] as const

const COLUMNS = [
  { key: 'issue', label: 'Issue', width: 'auto', minWidth: 'md' },
  { key: 'status', label: 'Status', width: 'sm' },
  { key: 'stage', label: 'Stage', width: 'sm', hideBelow: 'md' },
  { key: 'agent', label: 'Agent', width: 'sm', hideBelow: 'sm' }
] as const

const STATUS_TONE: Record<string, 'neutral' | 'accent' | 'success' | 'warning' | 'danger'> = {
  active: 'accent',
  processing: 'accent',
  awaiting_input: 'warning',
  pending_review: 'warning',
  completed: 'success',
  cancelled: 'neutral'
}

const RECORD_TONE: Record<DispatchRecord['state'], 'accent' | 'success' | 'danger'> = {
  running: 'accent',
  'written-back': 'success',
  failed: 'danger'
}

function describeIssue(issue: GrapeIssue): string {
  const repo = issue.repoKey.includes(':')
    ? issue.repoKey.split(':').slice(1).join(':')
    : issue.repoKey
  const parts = [repo || 'unknown repo', issue.status]
  if (issue.stage) parts.push(`stage ${issue.stage}`)
  if (issue.sceneName) parts.push(issue.sceneName)
  if (issue.running) parts.push('agent running')
  return parts.join(' · ')
}

function applyList(result: IssueListResult): void {
  set(issues, result.issues)
  set(status, result.status)
  set(filter, result.filter)
  set(fetchedAt, result.fetchedAt)
  set(fromCache, result.fromCache)
  set(baseUrlDraft, result.status.baseUrl)
  // An unconfigured plugin is a first run, not a failure: the form is the next step, and a red
  // banner over it would just be noise.
  if (result.status.error && result.status.configured) {
    set(notice, { tone: 'danger', text: result.status.error })
  }
  const known = new Set(result.issues.map((issue) => issue.key))
  if (read(selectedKey) && !known.has(read(selectedKey))) {
    set(selectedKey, '')
    set(detail, null)
    set(links, null)
  }
  // Selections for issues that just left the list must not be dispatched by a later press.
  set(selectedRows, read(selectedRows).filter((key) => known.has(key)))
}

async function refresh(force: boolean): Promise<void> {
  if (read(busy)) return
  set(busy, 'list')
  set(notice, null)
  try {
    applyList(await plugin.request('grape.issues.list', { force }))
  } catch (error) {
    set(notice, { tone: 'danger', text: error instanceof Error ? error.message : String(error) })
  } finally {
    set(busy, '')
  }
}

async function widenFilter(): Promise<void> {
  if (read(busy)) return
  set(busy, 'list')
  set(notice, null)
  try {
    applyList(await plugin.request('grape.filter.all'))
  } catch (error) {
    set(notice, { tone: 'danger', text: error instanceof Error ? error.message : String(error) })
  } finally {
    set(busy, '')
  }
}

async function saveConnection(): Promise<void> {
  if (read(busy)) return
  set(busy, 'connection')
  set(notice, null)
  try {
    const next = await plugin.request('grape.connection.save', {
      baseUrl: read(baseUrlDraft),
      token: read(tokenDraft) || undefined
    })
    set(status, next)
    set(tokenDraft, '')
    if (next.error) {
      set(notice, { tone: 'danger', text: next.error })
    } else {
      set(notice, { tone: 'success', text: 'Connected to Grape.' })
      applyList(await plugin.request('grape.issues.list', { force: true }))
    }
  } catch (error) {
    set(notice, { tone: 'danger', text: error instanceof Error ? error.message : String(error) })
  } finally {
    set(busy, '')
  }
}

async function clearConnection(): Promise<void> {
  set(busy, 'connection')
  try {
    const next = await plugin.request('grape.connection.clear')
    set(status, next)
    set(issues, [])
    set(selectedKey, '')
    set(selectedRows, [])
    set(detail, null)
    set(links, null)
    set(tokenDraft, '')
    set(notice, { tone: 'warning', text: 'Grape connection cleared.' })
  } finally {
    set(busy, '')
  }
}

async function openIssue(issue: GrapeIssue): Promise<void> {
  set(selectedKey, issue.key)
  set(detail, null)
  set(links, null)
  set(busy, 'detail')
  try {
    // The detail is the reason this row was opened; the links are garnish. One failing must not
    // blank the other, so they settle independently.
    const [detailResult, linksResult] = await Promise.allSettled([
      plugin.request('grape.issue.detail', { issueKey: issue.key }),
      plugin.request('grape.issue.links', { issueKey: issue.key })
    ])
    if (detailResult.status === 'fulfilled') set(detail, detailResult.value)
    if (linksResult.status === 'fulfilled') set(links, linksResult.value)
    if (detailResult.status === 'rejected') {
      const reason = detailResult.reason
      set(notice, { tone: 'danger', text: reason instanceof Error ? reason.message : String(reason) })
    }
  } finally {
    set(busy, '')
  }
}

async function dispatchOne(issue: GrapeIssue): Promise<void> {
  if (read(busy)) return
  set(busy, 'dispatch')
  set(notice, null)
  try {
    const result = await plugin.request('grape.issue.dispatch', {
      issueKey: issue.key,
      agent: read(agent)
    })
    set(notice, {
      tone: 'success',
      text: `${result.agent} started on ${result.issueKey} in ${result.workspaceName}.`
    })
  } catch (error) {
    set(notice, { tone: 'danger', text: error instanceof Error ? error.message : String(error) })
  } finally {
    set(busy, '')
  }
}

async function dispatchSelected(): Promise<void> {
  const keys = read(selectedRows)
  if (keys.length === 0 || read(busy)) return
  set(busy, 'batch')
  set(notice, null)
  try {
    const result = await plugin.request('grape.issues.dispatchBatch', {
      issueKeys: keys,
      agent: read(agent)
    })
    if (result.dispatched.length === 0) {
      // Nothing started: the reason is the whole message. "0 started · 1 failed: …" reads like
      // a partial success and buries the one thing the person has to change.
      set(notice, {
        tone: 'danger',
        text: result.failed[0]?.error ?? 'Nothing was dispatched.'
      })
      return
    }
    const parts = [`${result.dispatched.length} started`]
    if (result.failed.length > 0) {
      parts.push(`${result.failed.length} failed: ${result.failed[0].error}`)
    }
    set(notice, {
      tone: result.failed.length > 0 ? 'warning' : 'success',
      text: parts.join(' · ')
    })
    set(selectedRows, [])
  } catch (error) {
    set(notice, { tone: 'danger', text: error instanceof Error ? error.message : String(error) })
  } finally {
    set(busy, '')
  }
}

async function writeBack(issueKey: string): Promise<void> {
  if (read(busy)) return
  set(busy, `writeback:${issueKey}`)
  set(notice, null)
  try {
    const result = await plugin.request('grape.dispatch.writeBack', { issueKey })
    set(notice, {
      tone: result.error ? 'warning' : 'success',
      text: result.error
        ? `Grape has the status, but the comment failed: ${result.error}`
        : `Wrote ${result.status || 'no status'} back to ${result.issueKey}.`
    })
  } catch (error) {
    set(notice, { tone: 'danger', text: error instanceof Error ? error.message : String(error) })
  } finally {
    set(busy, '')
  }
}

function openExternal(url: string): void {
  if (url) void shell.openExternal(url)
}

/** Runs once before the first render. */
export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(
    plugin.on('grape.changed', (result) => applyList(result)),
    plugin.on('grape.dispatched', (result) =>
      set(notice, { tone: 'success', text: `${result.agent} started on ${result.issueKey}.` })
    ),
    plugin.on('grape.dispatches.changed', (result) => set(dispatches, result.records))
  )
  void plugin.request('grape.connection.get').then((current) => {
    set(status, current)
    set(baseUrlDraft, current.baseUrl)
    // With no key stored there is nothing to fetch; the form below is the whole first run.
    if (current.configured) void refresh(false)
  })
  void plugin
    .request('grape.dispatch.list')
    .then((result) => set(dispatches, result.records))
    .catch(() => {})
}

export default function Panel() {
  const current = read(status)
  const list = read(issues)
  const busyWith = read(busy)
  const selected = list.find((issue) => issue.key === read(selectedKey))
  const picked = read(selectedRows)
  const warning = read(notice)
  const currentLinks = read(links)
  const records = read(dispatches)
  const connected = current?.configured === true && current.reachable
  const waiting = list.filter(
    (issue) => issue.status === 'pending_review' || issue.status === 'awaiting_input'
  ).length

  const rows = list.map((issue) => ({
    key: issue.key,
    cells: {
      issue: `#${issue.number} ${issue.title}`,
      status: issue.status,
      stage: issue.stage || '-',
      agent: issue.running ? 'running' : '-'
    }
  }))

  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Heading level={3}>Grape Tasks</Heading>
        <Row gap="xs" align="center">
          {waiting > 0 ? <Badge tone="warning">{`${waiting} waiting`}</Badge> : null}
          <IconButton
            icon="refresh"
            label="Refresh my issues"
            tooltip="Refresh my issues"
            disabled={busyWith !== ''}
            onPress={() => void refresh(true)}
          />
        </Row>
      </Row>

      {warning ? (
        <Callout tone={warning.tone} title={warning.tone === 'danger' ? 'Problem' : 'Grape'}>
          {warning.text}
        </Callout>
      ) : null}

      <Collapsible
        title="Connection"
        description={
          connected
            ? `${current?.baseUrl} · connected${read(fromCache) ? ' · cached list' : ''}`
            : current?.configured
              ? 'Configured, but the last call failed'
              : 'Add your Grape URL and API key'
        }
        defaultOpen={!connected}
      >
        <Stack gap="sm">
          <Input
            label="Grape base URL"
            value={read(baseUrlDraft)}
            placeholder="http://grape.internal:8080"
            onChange={(value) => set(baseUrlDraft, value)}
          />
          <Input
            label="API key"
            type="password"
            value={read(tokenDraft)}
            placeholder={current?.hasToken ? 'stored, paste to replace' : 'grape_...'}
            onChange={(value) => set(tokenDraft, value)}
          />
          <Row gap="xs">
            <Button onPress={() => void saveConnection()} disabled={busyWith !== ''}>
              {busyWith === 'connection' ? 'Testing...' : 'Save and test'}
            </Button>
            <Button variant="ghost" tone="danger" onPress={() => void clearConnection()}>
              Clear
            </Button>
            <Button
              variant="ghost"
              icon="open-external"
              disabled={!current?.baseUrl}
              onPress={() => openExternal(current?.baseUrl ?? '')}
            >
              Open Grape
            </Button>
          </Row>
          <Text muted size="xs">
            The key is stored as a plugin secret, not in settings. Approving or rejecting stays in
            Grape's web UI: those two calls need an agent session token.
          </Text>
        </Stack>
      </Collapsible>

      <Separator />

      {busyWith === 'list' && list.length === 0 ? (
        <Spinner label="Loading issues" />
      ) : list.length === 0 ? (
        // An empty list has to say what it asked for: "no issues" alone cannot be told apart
        // from "wrong filter", "wrong account" or "wrong server".
        <Stack gap="sm">
          <EmptyState
            title={connected ? 'No issues match this filter' : 'Not connected yet'}
            description={
              connected
                ? `${current?.baseUrl ?? 'Grape'} returned 0 issues for status "${
                    read(filter).status || 'any'
                  }"${read(filter).repoKey ? ` in ${read(filter).repoKey}` : ''}.`
                : 'Fill in the connection above; the list loads as soon as Grape answers.'
            }
            icon="layers"
          />
          {connected ? (
            <Row justify="center">
              <Button
                variant="outline"
                icon="filter"
                disabled={busyWith !== ''}
                onPress={() => void widenFilter()}
              >
                Show all statuses
              </Button>
            </Row>
          ) : null}
        </Stack>
      ) : (
        <Stack gap="sm">
          <Table
            label={`${list.length} issues`}
            columns={COLUMNS}
            rows={rows}
            selectionMode="multiple"
            selected={picked}
            onSelectionChange={(selection) => set(selectedRows, selection.keys)}
            onRowAction={(row) => {
              const issue = list.find((candidate) => candidate.key === row.key)
              if (issue) void openIssue(issue)
            }}
          />
          <Row gap="xs" align="center">
            <Select
              label="Agent"
              labelHidden
              value={read(agent)}
              options={AGENTS}
              onChange={(value) => set(agent, value)}
            />
            <Button
              icon="rocket"
              disabled={busyWith !== '' || picked.length === 0}
              onPress={() => void dispatchSelected()}
            >
              {busyWith === 'batch' ? 'Starting...' : `Dispatch ${picked.length || ''} selected`}
            </Button>
            {picked.length > 0 ? (
              <Button variant="ghost" onPress={() => set(selectedRows, [])}>
                Clear
              </Button>
            ) : null}
          </Row>
          <Text muted size="xs">
            A batch gives each issue its own worktree and agent. Selecting a row and pressing Enter
            opens the issue instead.
          </Text>
        </Stack>
      )}

      {selected ? (
        <Card title={`#${selected.number} ${selected.title}`} description={describeIssue(selected)}>
          <Stack gap="sm">
            {busyWith === 'detail' ? <Spinner label="Loading issue" /> : null}
            {read(detail) ? (
              <Stack gap="xs">
                <Text size="xs" muted>
                  {`stage ${read(detail)?.stage || '-'} · pipeline ${
                    read(detail)?.pipelineStatus || '-'
                  } · ${read(detail)?.eventsCount ?? 0} events · ${
                    read(detail)?.attachmentsCount ?? 0
                  } attachments`}
                </Text>
                {read(detail)?.nodes.length ? (
                  <Text size="xs">
                    {read(detail)!
                      .nodes.map((node) => `${node.name}: ${node.status || '-'}`)
                      .join('  |  ')}
                  </Text>
                ) : null}
              </Stack>
            ) : null}
            {selected.description ? <Text size="xs">{selected.description}</Text> : null}
            <Row gap="xs" align="center">
              <Badge tone={STATUS_TONE[selected.status] ?? 'neutral'}>{selected.status}</Badge>
              {currentLinks?.issue ? (
                <Button
                  variant="ghost"
                  icon="open-external"
                  onPress={() => openExternal(currentLinks.issue)}
                >
                  Source issue
                </Button>
              ) : null}
              {currentLinks?.repo ? (
                <Button
                  variant="ghost"
                  icon="branch"
                  onPress={() => openExternal(currentLinks.repo)}
                >
                  Repository
                </Button>
              ) : null}
              {currentLinks?.grape ? (
                <Button
                  variant="ghost"
                  icon="globe"
                  onPress={() => openExternal(currentLinks.grape)}
                >
                  Grape console
                </Button>
              ) : null}
            </Row>
            <Row gap="xs" align="center">
              <Button
                icon="rocket"
                disabled={busyWith !== ''}
                onPress={() => void dispatchOne(selected)}
              >
                {busyWith === 'dispatch' ? 'Starting...' : 'Dispatch to workspace'}
              </Button>
              <Text muted size="xs">
                Starts the agent in the focused workspace with this issue as its prompt.
              </Text>
            </Row>
            {!currentLinks?.issue ? (
              <Text muted size="xs">
                Set the self-hosted code host in the plugin settings to link issues outside
                gitcode.com and github.com.
              </Text>
            ) : null}
          </Stack>
        </Card>
      ) : (
        <Text muted size="xs">
          {read(fetchedAt) > 0
            ? `${read(fromCache) ? 'Cached' : 'Fetched'} ${new Date(
                read(fetchedAt)
              ).toLocaleTimeString()}`
            : 'Select an issue to see its pipeline, its links and to dispatch it.'}
        </Text>
      )}

      {records.length > 0 ? (
        <Collapsible
          title={`Dispatched (${records.length})`}
          description="Agents this plugin started, and whether the result reached Grape"
        >
          <Stack gap="sm">
            {records.map((record) => (
              <Row key={record.issueKey} justify="between" align="center" gap="sm">
                <Stack gap="none">
                  <Row gap="xs" align="center">
                    <Badge tone={RECORD_TONE[record.state]}>{record.state}</Badge>
                    <Text size="xs" truncate>
                      {`#${record.number} ${record.title}`}
                    </Text>
                  </Row>
                  <Text size="xs" muted truncate>
                    {`${record.agent} · ${record.workspaceName}${
                      record.writeBackError ? ` · ${record.writeBackError}` : ''
                    }`}
                  </Text>
                </Stack>
                {record.state === 'written-back' ? (
                  <Text size="xs" muted>
                    {record.writeBackStatus || 'no status'}
                  </Text>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busyWith !== ''}
                    onPress={() => void writeBack(record.issueKey)}
                  >
                    {busyWith === `writeback:${record.issueKey}` ? 'Writing...' : 'Write back'}
                  </Button>
                )}
              </Row>
            ))}
          </Stack>
        </Collapsible>
      ) : null}
    </Stack>
  )
}
