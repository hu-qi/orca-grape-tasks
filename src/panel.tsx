// No build step: Orca strips the types and compiles the JSX when the panel loads.
//
// This frame has no network. Every Grape call is a request to src/worker.ts; the panel only
// holds render state and never learns the API key.
import {
  Callout,
  Card,
  Collapsible,
  EmptyState,
  IconButton,
  Input,
  List,
  ListItem,
  Row,
  Select,
  Separator,
  shell,
  Spinner,
  Text,
  Button,
  Badge,
  Heading,
  Stack,
  atom,
  plugin,
  read,
  set,
  type PanelContext
} from 'orca'
import type {
  ConnectionStatus,
  DispatchResult,
  GrapeIssue,
  GrapeIssueDetail,
  IssueListResult
} from './protocol'

const issues = atom<GrapeIssue[]>([])
const status = atom<ConnectionStatus | null>(null)
const selectedKey = atom<string>('')
const detail = atom<GrapeIssueDetail | null>(null)
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

const STATUS_TONE: Record<string, 'neutral' | 'accent' | 'success' | 'warning' | 'danger'> = {
  active: 'accent',
  processing: 'accent',
  awaiting_input: 'warning',
  pending_review: 'warning',
  completed: 'success',
  cancelled: 'neutral'
}

function applyList(result: IssueListResult): void {
  set(issues, result.issues)
  set(status, result.status)
  set(fetchedAt, result.fetchedAt)
  set(fromCache, result.fromCache)
  set(baseUrlDraft, result.status.baseUrl)
  // An unconfigured plugin is a first run, not a failure: the form is the next step, and a red
  // banner over it would just be noise.
  if (result.status.error && result.status.configured) {
    set(notice, { tone: 'danger', text: result.status.error })
  }
  // A selected issue can disappear between refreshes.
  const current = read(selectedKey)
  if (current && !result.issues.some((issue) => issue.key === current)) {
    set(selectedKey, '')
    set(detail, null)
  }
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
    set(detail, null)
    set(tokenDraft, '')
    set(notice, { tone: 'warning', text: 'Grape connection cleared.' })
  } finally {
    set(busy, '')
  }
}

async function selectIssue(issue: GrapeIssue): Promise<void> {
  set(selectedKey, issue.key)
  set(detail, null)
  set(busy, 'detail')
  try {
    set(detail, await plugin.request('grape.issue.detail', { issueKey: issue.key }))
  } catch (error) {
    set(notice, { tone: 'danger', text: error instanceof Error ? error.message : String(error) })
  } finally {
    set(busy, '')
  }
}

async function dispatch(issue: GrapeIssue): Promise<void> {
  if (read(busy)) return
  set(busy, 'dispatch')
  set(notice, null)
  try {
    const result: DispatchResult = await plugin.request('grape.issue.dispatch', {
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

/** Runs once before the first render. */
export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(
    plugin.on('grape.changed', (result) => applyList(result)),
    plugin.on('grape.dispatched', (result) =>
      set(notice, {
        tone: 'success',
        text: `${result.agent} started on ${result.issueKey}.`
      })
    )
  )
  void plugin.request('grape.connection.get').then((current) => {
    set(status, current)
    set(baseUrlDraft, current.baseUrl)
    // With no key stored there is nothing to fetch; the form below is the whole first run.
    if (current.configured) void refresh(false)
  })
}

function issueLabel(issue: GrapeIssue): string {
  return `#${issue.number} ${issue.title}`
}

function issueDescription(issue: GrapeIssue): string {
  const repo = issue.repoKey.includes(':') ? issue.repoKey.split(':').slice(1).join(':') : issue.repoKey
  const parts = [repo || 'unknown repo', issue.status]
  if (issue.stage) parts.push(`stage ${issue.stage}`)
  if (issue.sceneName) parts.push(issue.sceneName)
  if (issue.running) parts.push('agent running')
  return parts.join(' · ')
}

export default function Panel() {
  const current = read(status)
  const list = read(issues)
  const busyWith = read(busy)
  const selected = list.find((issue) => issue.key === read(selectedKey))
  const warning = read(notice)
  const connected = current?.configured === true && current.reachable
  const waiting = list.filter(
    (issue) => issue.status === 'pending_review' || issue.status === 'awaiting_input'
  ).length

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
              onPress={() => {
                const url = current?.baseUrl
                if (url) void shell.openExternal(url)
              }}
            >
              Open Grape
            </Button>
          </Row>
          <Text muted size="xs">
            The key is stored as a plugin secret, not in settings. Review actions stay in Grape's web
            UI: they need an agent session token, which a personal key does not have.
          </Text>
        </Stack>
      </Collapsible>

      <Separator />

      {busyWith === 'list' && list.length === 0 ? (
        <Spinner label="Loading issues" />
      ) : list.length === 0 ? (
        <EmptyState
          title={connected ? 'No issues match this filter' : 'Not connected yet'}
          description={
            connected
              ? 'Change the status filter in the plugin settings, or refresh.'
              : 'Fill in the connection above; the list loads as soon as Grape answers.'
          }
          icon="layers"
        />
      ) : (
        <List label={`${list.length} issues`}>
          {list.map((issue) => (
            <ListItem
              key={issue.key}
              title={issueLabel(issue)}
              description={issueDescription(issue)}
              icon={issue.isPr ? 'branch' : issue.running ? 'agent' : 'file-text'}
              current={issue.key === read(selectedKey)}
              onPress={() => void selectIssue(issue)}
            >
              <Badge tone={STATUS_TONE[issue.status] ?? 'neutral'}>{issue.status}</Badge>
            </ListItem>
          ))}
        </List>
      )}

      {selected ? (
        <Card title={issueLabel(selected)} description={issueDescription(selected)}>
          <Stack gap="sm">
            {busyWith === 'detail' ? <Spinner label="Loading issue" /> : null}
            {read(detail) ? (
              <Stack gap="xs">
                <Text size="xs" muted>
                  {`stage ${read(detail)?.stage || '-'} · pipeline ${read(detail)?.pipelineStatus || '-'} · ${
                    read(detail)?.eventsCount ?? 0
                  } events · ${read(detail)?.attachmentsCount ?? 0} attachments`}
                </Text>
                {read(detail)?.nodes.length ? (
                  <Text size="xs">
                    {read(detail)!.nodes.map((node) => `${node.name}: ${node.status || '-'}`).join('  |  ')}
                  </Text>
                ) : null}
              </Stack>
            ) : null}
            {selected.description ? <Text size="xs">{selected.description}</Text> : null}
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
                disabled={busyWith !== ''}
                onPress={() => void dispatch(selected)}
              >
                {busyWith === 'dispatch' ? 'Starting...' : 'Dispatch to workspace'}
              </Button>
            </Row>
            <Text muted size="xs">
              Starts the agent in the focused Orca workspace with this issue as its prompt. It does not
              create a branch or worktree.
            </Text>
          </Stack>
        </Card>
      ) : (
        <Text muted size="xs">
          {read(fetchedAt) > 0
            ? `${read(fromCache) ? 'Cached' : 'Fetched'} ${new Date(read(fetchedAt)).toLocaleTimeString()}`
            : 'Select an issue to see its pipeline and dispatch it.'}
        </Text>
      )}
    </Stack>
  )
}
