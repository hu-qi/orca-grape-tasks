// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses.
// Only src/grape.ts is covered here: the worker's Orca calls are the host's job, and the
// panel has its own test.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as workerModule from './worker'
import {
  GrapeClient,
  GrapeError,
  buildDispatchPrompt,
  fromRepoKey,
  issueLinks,
  normalizeBaseUrl,
  normalizeIssue,
  normalizeIssueDetail
} from './grape'

function fetchReturning(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' }
    })) as unknown as typeof fetch
}

test('normalizeBaseUrl keeps the root and drops a pasted path suffix', () => {
  assert.equal(normalizeBaseUrl('http://grape.internal:8080/'), 'http://grape.internal:8080')
  assert.equal(normalizeBaseUrl(' https://grape.example.com// '), 'https://grape.example.com')
  // A pasted API path or query would break every request later.
  assert.equal(normalizeBaseUrl('http://h:8080/api/v1'), 'http://h:8080/api/v1')
  assert.equal(normalizeBaseUrl('http://h:8080/?token=leak'), 'http://h:8080')
})

test('normalizeBaseUrl refuses anything a request cannot use', () => {
  for (const bad of ['', '   ', 'grape.internal:8080', 'ftp://grape.internal', 'file:///etc/passwd']) {
    let code = ''
    try {
      normalizeBaseUrl(bad)
    } catch (error) {
      code = error instanceof GrapeError ? error.code : 'not_a_grape_error'
    }
    assert.equal(code, 'invalid_base_url')
  }
})

test('fromRepoKey strips the provider prefix Grape stores', () => {
  assert.equal(fromRepoKey('gitcode:acme/platform'), 'acme/platform')
  assert.equal(fromRepoKey('github:acme/platform'), 'acme/platform')
  assert.equal(fromRepoKey('acme/platform'), 'acme/platform')
  assert.equal(fromRepoKey(''), '')
})

test('normalizeIssue maps a real /api/issues card', () => {
  const issue = normalizeIssue({
    id: 4120,
    issue_number: 412,
    repo_key: 'gitcode:acme/platform',
    title: 'Pipeline stops after the build stage',
    status: 'pending_review',
    stage: 'build',
    scene_name: 'default',
    assignee: 'huqi',
    creator: 'huqi',
    is_running: false,
    task_description: 'The deploy stage never starts.',
    created_at: '2026-11-20 10:12:00'
  })
  assert.equal(issue.key, 'gitcode:acme/platform#412')
  assert.equal(issue.number, 412)
  assert.equal(issue.status, 'pending_review')
  assert.equal(issue.stage, 'build')
  assert.equal(issue.running, false)
  assert.equal(issue.isPr, false)
})

test('normalizeIssue degrades instead of throwing on an odd payload', () => {
  // A Grape release that renames a field should gray out one column, not empty the panel.
  const issue = normalizeIssue({ issue_number: '77', repo_key: null, status: 5 })
  assert.equal(issue.number, 77)
  assert.equal(issue.repoKey, '')
  assert.equal(issue.status, '5')
  assert.equal(issue.title, '#77')
  assert.equal(issue.running, false)

  const empty = normalizeIssue(null)
  assert.equal(empty.number, 0)
  assert.equal(empty.key, '#0')
})

test('normalizeIssueDetail reads the pipeline roadmap and counters', () => {
  const detail = normalizeIssueDetail(
    {
      number: 412,
      issue_id: 4120,
      title: 'Pipeline stops after the build stage',
      stage: 'build',
      task_status: 'failed',
      owner_agent: 'claude',
      events_count: 9,
      attachments: [{}, {}],
      pipeline: {
        status: 'failed',
        // Grape's segments carry `agent` and `event_type`; there is no `name`, which is why a
        // name-only normalisation rendered a pipeline as ": completed | : completed".
        segments: [
          { seq: 2, agent: 'coding', event_type: 'issue_claimed', status: 'failed' },
          { seq: 1, agent: 'vod', event_type: 'issue_opened', status: 'completed' }
        ]
      }
    },
    'gitcode:acme/platform'
  )
  assert.equal(detail.key, 'gitcode:acme/platform#412')
  assert.equal(detail.taskStatus, 'failed')
  assert.equal(detail.eventsCount, 9)
  assert.equal(detail.attachmentsCount, 2)
  assert.equal(detail.pipelineStatus, 'failed')
  assert.deepEqual(detail.nodes, [
    { name: 'vod', status: 'completed', eventType: 'issue_opened', seq: 1 },
    { name: 'coding', status: 'failed', eventType: 'issue_claimed', seq: 2 }
  ])
})

test('a pipeline segment without an agent falls back to its event type, never to a blank name', () => {
  const detail = normalizeIssueDetail(
    { pipeline: { segments: [{ seq: 1, event_type: 'issue_opened', status: 'completed' }] } },
    'gitcode:acme/platform'
  )
  assert.deepEqual(detail.nodes, [
    { name: 'issue_opened', status: 'completed', eventType: 'issue_opened', seq: 1 }
  ])
})

test('buildDispatchPrompt carries the issue identity, the body and team instructions', () => {
  const issue = normalizeIssue({
    issue_number: 412,
    repo_key: 'gitcode:acme/platform',
    title: 'Pipeline stops after the build stage',
    status: 'active',
    stage: 'plan',
    task_description: 'The deploy stage never starts.'
  })
  const prompt = buildDispatchPrompt(issue, 'Use feat/ prefixes and run the unit tests.')
  assert.ok(prompt.includes('acme/platform#412'))
  assert.ok(prompt.includes('Pipeline stops after the build stage'))
  assert.ok(prompt.includes('The deploy stage never starts.'))
  assert.ok(prompt.includes('Use feat/ prefixes and run the unit tests.'))
  // The key cannot move the issue, so the prompt must not imply that it can.
  assert.ok(prompt.includes('Do not close or move the issue'))
})

test('buildDispatchPrompt says so when the issue has no body', () => {
  const prompt = buildDispatchPrompt(normalizeIssue({ issue_number: 5, title: 'No body' }))
  assert.ok(prompt.includes('no description'))
})

test('listMine sends the key as a header and normalizes the cards', async () => {
  let seenUrl = ''
  let seenToken = ''
  const client = new GrapeClient({
    baseUrl: 'http://grape.internal:8080/',
    token: 'grape_abc',
    fetchImpl: (async (url: string, init: RequestInit) => {
      seenUrl = url
      seenToken = String((init.headers as Record<string, string>)['PRIVATE-TOKEN'])
      return new Response(
        JSON.stringify({
          issues: [
            { issue_number: 1, repo_key: 'gitcode:a/b', title: 'one', status: 'active' },
            { issue_number: 2, repo_key: 'gitcode:a/b', title: 'two', status: 'processing' }
          ],
          sort_order: 'desc',
          mode: 'default'
        }),
        { status: 200 }
      )
    }) as unknown as typeof fetch
  })

  const issues = await client.listMine({ status: 'active', repoKey: 'a/b' })
  assert.equal(issues.length, 2)
  assert.equal(issues[1].key, 'gitcode:a/b#2')
  assert.equal(seenToken, 'grape_abc')
  assert.ok(seenUrl.startsWith('http://grape.internal:8080/api/issues/mine?'))
  assert.ok(seenUrl.includes('status=active'))
  assert.ok(seenUrl.includes('repo_key=a%2Fb'))
})

test('issueDetail turns the stored repo key into the route Grape serves', async () => {
  let seenUrl = ''
  const client = new GrapeClient({
    baseUrl: 'http://grape.internal:8080',
    token: 'grape_abc',
    fetchImpl: (async (url: string) => {
      seenUrl = url
      return new Response(JSON.stringify({ number: 412, title: 'detail' }), { status: 200 })
    }) as unknown as typeof fetch
  })

  const detail = await client.issueDetail('gitcode:acme/platform', 412)
  assert.equal(seenUrl, 'http://grape.internal:8080/api/issues/acme/platform/412')
  assert.equal(detail.number, 412)
})

test('HTTP failures become typed errors the panel can explain', async () => {
  const cases: Array<[number, string]> = [
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [500, 'http_error']
  ]
  for (const [status, code] of cases) {
    const client = new GrapeClient({
      baseUrl: 'http://grape.internal:8080',
      token: 'grape_abc',
      fetchImpl: fetchReturning(status, { detail: 'nope' })
    })
    let actual = ''
    try {
      await client.listMine()
    } catch (error) {
      actual = error instanceof GrapeError ? error.code : 'not_a_grape_error'
    }
    assert.equal(actual, code)
  }
})

test('a dead host reports a network error, not a stack trace', async () => {
  const client = new GrapeClient({
    baseUrl: 'http://grape.internal:8080',
    token: 'grape_abc',
    fetchImpl: (async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.1:8080')
    }) as unknown as typeof fetch
  })
  let message = ''
  try {
    await client.listMine()
  } catch (error) {
    message = error instanceof Error ? error.message : ''
  }
  assert.ok(message.includes('Cannot reach http://grape.internal:8080'))
  assert.ok(message.includes('ECONNREFUSED'))
})

// ---------------------------------------------------------------------------------------
// The worker itself, on the host Orca gives it. A dispatch has to do two things right: start
// the agent in the workspace the person is actually looking at, and refuse loudly when there
// is none, because a silent fallback would start an agent somewhere unexpected.

const CACHED_ISSUES = JSON.stringify([
  {
    key: 'gitcode:acme/platform#412',
    id: 4120,
    number: 412,
    repoKey: 'gitcode:acme/platform',
    title: 'Pipeline stops after the build stage',
    status: 'active',
    stage: 'plan',
    sceneName: 'default',
    assignee: 'huqi',
    creator: 'huqi',
    running: false,
    isPr: false,
    description: 'The deploy stage never starts.',
    createdAt: '2026-11-20 10:12:00'
  },
  {
    key: 'gitcode:acme/platform#413',
    id: 4130,
    number: 413,
    repoKey: 'gitcode:acme/platform',
    title: 'Second issue',
    status: 'active',
    stage: 'plan',
    sceneName: 'default',
    assignee: 'huqi',
    creator: 'huqi',
    running: false,
    isPr: false,
    description: '',
    createdAt: '2026-11-20 11:00:00'
  },
  {
    key: 'gitcode:acme/platform#414',
    id: 4140,
    number: 414,
    repoKey: 'gitcode:acme/platform',
    title: 'Third issue',
    status: 'active',
    stage: 'plan',
    sceneName: 'default',
    assignee: 'huqi',
    creator: 'huqi',
    running: false,
    isPr: false,
    description: '',
    createdAt: '2026-11-20 12:00:00'
  },
  {
    key: 'gitcode:acme/platform#415',
    id: 4150,
    number: 415,
    repoKey: 'gitcode:acme/platform',
    title: 'Fourth issue',
    status: 'active',
    stage: 'plan',
    sceneName: 'default',
    assignee: 'huqi',
    creator: 'huqi',
    running: false,
    isPr: false,
    description: '',
    createdAt: '2026-11-20 13:00:00'
  }
])

async function mountGrapeWorker(
  results: Record<string, unknown>,
  overrides: { storage?: Record<string, unknown> } = {}
): Promise<Awaited<ReturnType<typeof mountWorker>>> {
  const host = mockHost({
    results,
    settings: {
      baseUrl: 'http://grape.internal:8080',
      defaultAgent: 'codex',
      extraInstructions: 'Run the unit tests before you finish.',
      autoWriteBack: true,
      writeBackStatus: 'pending_review',
      maxBatch: 3
    },
    secrets: { 'grape-token': 'grape_abc' },
    storage: { issues: CACHED_ISSUES, checkedAt: 1, ...overrides.storage }
  })
  return mountWorker(workerModule, { host })
}

test('dispatch launches the configured agent in the focused workspace', async () => {
  const worker = await mountGrapeWorker({
    'workspace.readContext': {
      workspaceId: 'w1',
      branch: 'feat/412',
      displayName: 'platform',
      terminals: []
    },
    'agent.launch': { terminalId: 't1' },
    'workspace.open': { opened: true },
    'notifications.show': { delivered: true }
  })

  const result = await worker.request('grape.issue.dispatch', {
    issueKey: 'gitcode:acme/platform#412'
  })
  assert.equal(result.terminalId, 't1')
  assert.equal(result.workspaceName, 'platform')
  // No explicit agent on the request: the worker falls back to the setting, not a constant.
  assert.equal(result.agent, 'codex')

  // callsOf answers the params each call was made with, in order.
  const launched = worker.host.callsOf('agent.launch')
  assert.equal(launched.length, 1)
  const params = launched[0] as { workspaceId: string; agent: string; prompt: string }
  assert.equal(params.workspaceId, 'w1')
  assert.equal(params.agent, 'codex')
  assert.ok(params.prompt.includes('acme/platform#412'))
  assert.ok(params.prompt.includes('The deploy stage never starts.'))
  assert.ok(params.prompt.includes('Run the unit tests before you finish.'))
  assert.deepEqual(worker.refusals, [])
})

test('dispatch refuses when no Orca workspace is focused', async () => {
  const worker = await mountGrapeWorker({ 'workspace.readContext': null })

  let message = ''
  try {
    await worker.request('grape.issue.dispatch', { issueKey: 'gitcode:acme/platform#412' })
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  assert.ok(message.includes('No Orca workspace is focused'))
  // Nothing reached the host: no agent was started anywhere.
  assert.equal(worker.host.callsOf('agent.launch').length, 0)
})

test('dispatch refuses an issue the cache does not know', async () => {
  const worker = await mountGrapeWorker({
    'workspace.readContext': {
      workspaceId: 'w1',
      branch: 'main',
      displayName: 'platform',
      terminals: []
    }
  })

  let message = ''
  try {
    await worker.request('grape.issue.dispatch', { issueKey: 'gitcode:acme/platform#999' })
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  assert.ok(message.includes('is not in the cached list'))
  assert.equal(worker.host.callsOf('agent.launch').length, 0)
})

// ---------------------------------------------------------------------------------------
// The closed loop and the batch. These are the parts that change state in Grape, so the tests
// pin down *how many* writes happen, not just that one happened.

function recordingFetch(calls: string[]): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${String(url).replace('http://grape.internal:8080', '')}`)
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }) as unknown as typeof fetch
}

const SETTLED = {
  'workspace.readContext': {
    workspaceId: 'w1',
    branch: 'main',
    displayName: 'platform',
    terminals: []
  },
  'agent.launch': { terminalId: 't1' },
  'workspace.open': { opened: true },
  'notifications.show': { delivered: true }
}

test('a finished agent writes back once, even when the event repeats', async () => {
  const calls: string[] = []
  workerModule.useFetchForTests(recordingFetch(calls))
  try {
    const worker = await mountGrapeWorker(SETTLED)
    await worker.request('grape.issue.dispatch', { issueKey: 'gitcode:acme/platform#412' })

    const event = {
      workspaceId: 'w1',
      paneKey: 'pane-1',
      terminalId: 't1',
      state: 'done' as const,
      receivedAt: 1_764_000_000_000
    }
    await worker.emit('agent.status.changed', event)
    // Orca can report the same settled state again; a second comment would be a bug.
    await worker.emit('agent.status.changed', event)

    assert.deepEqual(calls, [
      'PUT /api/issues/4120/status',
      'POST /api/issues/4120/clarify'
    ])
    const listed = await worker.request('grape.dispatch.list')
    assert.equal(listed.records.length, 1)
    assert.equal(listed.records[0].state, 'written-back')
    assert.equal(listed.records[0].writeBackStatus, 'pending_review')
  } finally {
    workerModule.useFetchForTests(undefined)
  }
})

test('an agent that is not one of ours does not write back', async () => {
  const calls: string[] = []
  workerModule.useFetchForTests(recordingFetch(calls))
  try {
    const worker = await mountGrapeWorker(SETTLED)
    await worker.request('grape.issue.dispatch', { issueKey: 'gitcode:acme/platform#412' })

    // Same workspace, different terminal: someone else's agent in the same worktree.
    await worker.emit('agent.status.changed', {
      workspaceId: 'w1',
      paneKey: 'pane-2',
      terminalId: 'other-terminal',
      state: 'done',
      receivedAt: 1_764_000_000_000
    })
    // A working agent is not finished.
    await worker.emit('agent.status.changed', {
      workspaceId: 'w1',
      paneKey: 'pane-1',
      terminalId: 't1',
      state: 'working',
      receivedAt: 1_764_000_000_001
    })

    assert.deepEqual(calls, [])
    const listed = await worker.request('grape.dispatch.list')
    assert.equal(listed.records[0].state, 'running')
  } finally {
    workerModule.useFetchForTests(undefined)
  }
})

test('auto write-back off leaves Grape untouched', async () => {
  const calls: string[] = []
  workerModule.useFetchForTests(recordingFetch(calls))
  try {
    const host = mockHost({
      results: SETTLED,
      settings: {
        baseUrl: 'http://grape.internal:8080',
        defaultAgent: 'codex',
        autoWriteBack: false,
        writeBackStatus: 'pending_review'
      },
      secrets: { 'grape-token': 'grape_abc' },
      storage: { issues: CACHED_ISSUES, checkedAt: 1 }
    })
    const worker = await mountWorker(workerModule, { host })
    await worker.request('grape.issue.dispatch', { issueKey: 'gitcode:acme/platform#412' })
    await worker.emit('agent.status.changed', {
      workspaceId: 'w1',
      paneKey: 'pane-1',
      terminalId: 't1',
      state: 'done',
      receivedAt: 1_764_000_000_000
    })

    assert.deepEqual(calls, [])
    assert.ok(worker.logs.some((line) => line.includes('auto write-back is off')))
  } finally {
    workerModule.useFetchForTests(undefined)
  }
})

test('a batch gives each issue its own worktree and reports the overflow', async () => {
  const worker = await mountGrapeWorker({
    'workspace.readContext': {
      workspaceId: 'w1',
      branch: 'main',
      displayName: 'platform',
      terminals: []
    },
    'workspace.list': {
      workspaces: [
        {
          id: 'w1',
          kind: 'worktree',
          name: 'platform',
          projectId: 'proj-1',
          path: '/tmp/platform',
          branch: 'main',
          hostId: 'local'
        }
      ],
      truncated: false
    },
    'project.list': {
      projects: [{ id: 'proj-1', name: 'platform', kind: 'git', hostId: 'local', path: '/tmp/platform' }],
      truncated: false
    },
    'workspace.create': { workspaceId: 'w-new', terminalId: 't-new' },
    'notifications.show': { delivered: true }
  })

  const result = await worker.request('grape.issues.dispatchBatch', {
    issueKeys: [
      'gitcode:acme/platform#412',
      'gitcode:acme/platform#413',
      'gitcode:acme/platform#414',
      'gitcode:acme/platform#415'
    ]
  })

  // maxBatch is 3 in the fixture, and the fourth is reported rather than silently dropped.
  assert.equal(result.dispatched.length, 3)
  assert.equal(result.failed.length, 1)
  assert.ok(result.failed[0].error.includes('batch limit'))
  assert.equal(worker.host.callsOf('workspace.create').length, 3)

  const created = worker.host.callsOf('workspace.create')[0] as {
    projectId: string
    agent: string
    prompt: string
  }
  assert.equal(created.projectId, 'proj-1')
  assert.equal(created.agent, 'codex')
  assert.ok(created.prompt.includes('acme/platform#412'))

  const listed = await worker.request('grape.dispatch.list')
  assert.equal(listed.records.length, 3)
  assert.ok(listed.records.every((record) => record.state === 'running'))
})

test('a batch refuses issues from two repositories before creating any worktree', async () => {
  // One batch branches from one project, so mixing repositories would put another repo's code
  // into the first repo's checkout. The panel blocks the add; this covers a direct RPC call.
  const issues = JSON.parse(CACHED_ISSUES) as Array<Record<string, unknown>>
  const mixed = [
    ...issues.slice(0, 1),
    { ...issues[0], key: 'gitcode:acme/other#900', id: 9000, number: 900, repoKey: 'gitcode:acme/other' }
  ]
  const worker = await mountGrapeWorker(
    {
      'workspace.list': {
        workspaces: [
          {
            id: 'w1',
            kind: 'worktree',
            name: 'platform',
            projectId: 'proj-1',
            path: '/tmp/platform',
            branch: 'main',
            hostId: 'local'
          }
        ],
        truncated: false
      },
      'project.list': {
        projects: [
          { id: 'proj-1', name: 'platform', kind: 'git', hostId: 'local', path: '/tmp/platform' }
        ],
        truncated: false
      },
      'workspace.create': { workspaceId: 'w-new', terminalId: 't-new' },
      'notifications.show': { delivered: true }
    },
    { storage: { issues: JSON.stringify(mixed) } }
  )

  let error = ''
  try {
    await worker.request('grape.issues.dispatchBatch', {
      issueKeys: ['gitcode:acme/platform#412', 'gitcode:acme/other#900']
    })
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message : String(thrown)
  }

  assert.ok(error.includes('one repository'), `expected a repository refusal, got: ${error}`)
  assert.ok(error.includes('gitcode:acme/other'))
  // Nothing started: the check runs before the first workspace.create.
  assert.equal(worker.host.callsOf('workspace.create').length, 0)
})

test('a batch refuses a pull request card instead of starting an agent on it', async () => {
  const worker = await mountGrapeWorker({
    'workspace.list': {
      workspaces: [
        {
          id: 'w1',
          kind: 'worktree',
          name: 'platform',
          projectId: 'proj-1',
          path: '/tmp/platform',
          branch: 'main',
          hostId: 'local'
        }
      ],
      truncated: false
    },
    'project.list': {
      projects: [{ id: 'proj-1', name: 'platform', kind: 'git', hostId: 'local', path: '/tmp/platform' }],
      truncated: false
    },
    'workspace.readContext': {
      workspaceId: 'w1',
      branch: 'main',
      displayName: 'platform',
      terminals: []
    }
  })

  const result = await worker.request('grape.issues.dispatchBatch', {
    issueKeys: ['gitcode:acme/platform#999']
  })
  assert.equal(result.dispatched.length, 0)
  assert.equal(result.failed.length, 1)
  assert.equal(worker.host.callsOf('workspace.create').length, 0)
})

// ---------------------------------------------------------------------------------------
// Card links: built from the same rule Grape's own dashboard uses, and refused rather than
// guessed for a self-hosted host we were not told about.

test('issue links follow the code host of the provider', () => {
  assert.deepEqual(
    issueLinks('gitcode:acme/platform', 412, { grapeBaseUrl: 'http://g:8080' }),
    {
      grape: 'http://g:8080',
      issue: 'https://gitcode.com/acme/platform/issues/412',
      repo: 'https://gitcode.com/acme/platform'
    }
  )
  assert.equal(
    issueLinks('github:acme/platform', 7, { grapeBaseUrl: '' }).issue,
    'https://github.com/acme/platform/issues/7'
  )
})

test('issue links are refused for an unknown host instead of guessed', () => {
  // A self-hosted GitLab without the override setting: a wrong link looks like a plugin bug.
  const unknown = issueLinks('mygitlab:acme/platform', 9, { grapeBaseUrl: 'http://g:8080' })
  assert.equal(unknown.issue, '')
  assert.equal(unknown.repo, '')
  assert.equal(unknown.grape, 'http://g:8080')

  const overridden = issueLinks('mygitlab:acme/platform', 9, {
    grapeBaseUrl: 'http://g:8080',
    vcsHostOverride: 'gitlab.internal.example.com'
  })
  assert.equal(overridden.issue, 'https://gitlab.internal.example.com/acme/platform/issues/9')
})

test('a folder project refuses a batch before starting anything', async () => {
  // Orca's own error here is "folder projects have no worktrees", raised once per issue, which
  // reads like a plugin failure. The focused project's kind is checked up front instead.
  const worker = await mountGrapeWorker({
    'workspace.readContext': {
      workspaceId: 'w1',
      branch: 'main',
      displayName: 'notes',
      terminals: []
    },
    'workspace.list': {
      workspaces: [
        {
          id: 'w1',
          kind: 'folder',
          name: 'notes',
          projectId: 'proj-folder',
          path: '/tmp/notes',
          branch: null,
          hostId: 'local'
        }
      ],
      truncated: false
    },
    'project.list': {
      projects: [
        {
          id: 'proj-folder',
          name: 'temp-notes',
          kind: 'folder',
          hostId: 'local',
          path: '/tmp/notes'
        }
      ],
      truncated: false
    }
  })

  let message = ''
  try {
    await worker.request('grape.issues.dispatchBatch', {
      issueKeys: ['gitcode:acme/platform#412']
    })
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  assert.ok(message.includes('temp-notes'))
  assert.ok(message.includes('folder projects have no worktrees'))
  // The fix is actionable: it points at the control that can actually run the batch.
  assert.ok(message.includes('Pick a Git project in the batch bar'))
  // Nothing was attempted: no worktree, no agent.
  assert.equal(worker.host.callsOf('workspace.create').length, 0)
  const listed = await worker.request('grape.dispatch.list')
  assert.equal(listed.records.length, 0)
})

test('targets list only Git projects, and name the focused project whatever its kind', async () => {
  const worker = await mountGrapeWorker({
    'workspace.readContext': {
      workspaceId: 'w1',
      branch: 'main',
      displayName: 'dev',
      terminals: []
    },
    'workspace.list': {
      workspaces: [
        {
          id: 'w1',
          kind: 'folder',
          name: 'dev',
          projectId: 'proj-folder',
          path: '/tmp/dev',
          branch: null,
          hostId: 'local'
        }
      ],
      truncated: false
    },
    'project.list': {
      projects: [
        { id: 'proj-folder', name: 'dev', kind: 'folder', hostId: 'local', path: '/tmp/dev' },
        { id: 'proj-git', name: 'platform', kind: 'git', hostId: 'local', path: '/tmp/platform' }
      ],
      truncated: false
    }
  })

  const targets = await worker.request('orca.targets')
  // A folder project is never offered as a batch target; it is only reported so the panel can
  // explain why the focused workspace cannot branch.
  assert.deepEqual(
    targets.projects.map((project) => project.name),
    ['platform']
  )
  assert.equal(targets.focused?.kind, 'folder')
  assert.equal(targets.focused?.name, 'dev')
})

test('a batch can target a Git project while a folder project is focused', async () => {
  const worker = await mountGrapeWorker({
    'workspace.readContext': {
      workspaceId: 'w1',
      branch: 'main',
      displayName: 'dev',
      terminals: []
    },
    'workspace.list': {
      workspaces: [
        {
          id: 'w1',
          kind: 'folder',
          name: 'dev',
          projectId: 'proj-folder',
          path: '/tmp/dev',
          branch: null,
          hostId: 'local'
        }
      ],
      truncated: false
    },
    'project.list': {
      projects: [
        { id: 'proj-folder', name: 'dev', kind: 'folder', hostId: 'local', path: '/tmp/dev' },
        { id: 'proj-git', name: 'platform', kind: 'git', hostId: 'local', path: '/tmp/platform' }
      ],
      truncated: false
    },
    'workspace.create': { workspaceId: 'w-new', terminalId: 't-new' },
    'notifications.show': { delivered: true }
  })

  const result = await worker.request('grape.issues.dispatchBatch', {
    issueKeys: ['gitcode:acme/platform#412'],
    projectId: 'proj-git'
  })
  assert.equal(result.dispatched.length, 1)
  const created = worker.host.callsOf('workspace.create')[0] as { projectId: string }
  assert.equal(created.projectId, 'proj-git')
})
