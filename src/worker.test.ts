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
        segments: [{ name: 'plan', status: 'completed' }, { segment: 'build', state: 'failed' }]
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
    { name: 'plan', status: 'completed' },
    { name: 'build', status: 'failed' }
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
  }
])

async function mountGrapeWorker(
  results: Record<string, unknown>
): Promise<Awaited<ReturnType<typeof mountWorker>>> {
  const host = mockHost({
    results,
    settings: {
      baseUrl: 'http://grape.internal:8080',
      defaultAgent: 'codex',
      extraInstructions: 'Run the unit tests before you finish.'
    },
    secrets: { 'grape-token': 'grape_abc' },
    storage: { issues: CACHED_ISSUES, checkedAt: 1 }
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
