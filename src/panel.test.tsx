// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses.
// Stands in for src/worker.ts: what each plugin.request answers.
import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { ConnectionStatus, GrapeIssue, IssueListResult } from './protocol'

const NOT_CONNECTED: ConnectionStatus = {
  configured: false,
  baseUrl: '',
  hasToken: false,
  reachable: false,
  checkedAt: null,
  error: null
}

const CONNECTED: ConnectionStatus = {
  configured: true,
  baseUrl: 'http://grape.internal:8080',
  hasToken: true,
  reachable: true,
  checkedAt: 1_764_000_000_000,
  error: null
}

const ISSUE: GrapeIssue = {
  key: 'gitcode:acme/platform#412',
  id: 4120,
  number: 412,
  repoKey: 'gitcode:acme/platform',
  title: 'Pipeline stops after the build stage',
  status: 'pending_review',
  stage: 'build',
  sceneName: 'default',
  assignee: 'huqi',
  creator: 'huqi',
  running: false,
  isPr: false,
  description: 'The deploy stage never starts.',
  createdAt: '2026-11-20 10:12:00'
}

function listResult(issues: GrapeIssue[], status = CONNECTED): IssueListResult {
  return { issues, status, fetchedAt: 1_764_000_000_000, fromCache: false }
}

/** What the panel drew, props included: assertions must not care whether a string is a prop
 *  or a text child. */
function drawn(view: Awaited<ReturnType<typeof mount>>): string {
  return JSON.stringify(view.tree())
}

const DETAIL = {
  key: ISSUE.key,
  number: 412,
  repoKey: ISSUE.repoKey,
  title: ISSUE.title,
  stage: 'build',
  taskStatus: 'failed',
  ownerAgent: 'claude',
  assignee: 'huqi',
  creator: 'huqi',
  eventsCount: 9,
  attachmentsCount: 2,
  pipelineStatus: 'failed',
  nodes: [{ name: 'build', status: 'failed' }]
}

test('an unconfigured panel asks for the connection instead of an empty list', async () => {
  const host = mockHost({
    requests: {
      'grape.connection.get': () => NOT_CONNECTED,
      'grape.issues.list': () => listResult([], NOT_CONNECTED)
    }
  })
  const view = await mount(panel, { host })
  await view.settled()

  // The empty state's title and description are props, so read the drawn tree, not the text.
  assert.ok(drawn(view).includes('Not connected yet'))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('a cached list renders issues and opens one', async () => {
  const host = mockHost({
    requests: {
      'grape.connection.get': () => CONNECTED,
      'grape.issues.list': () => listResult([ISSUE]),
      'grape.issue.detail': () => DETAIL
    }
  })
  const view = await mount(panel, { host })
  await view.settled()

  assert.ok(drawn(view).includes('Pipeline stops after the build stage'))
  assert.ok(drawn(view).includes('1 waiting'))

  // A ListItem's title is a prop, so the row is targeted by component type, not by text.
  await view.press({ type: 'ListItem' })
  assert.ok(drawn(view).includes('build: failed'))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('a working list dispatches the selected issue with the chosen agent', async () => {
  const dispatched: Array<{ issueKey: string; agent?: string }> = []
  const host = mockHost({
    requests: {
      'grape.connection.get': () => CONNECTED,
      'grape.issues.list': () => listResult([ISSUE]),
      'grape.issue.detail': () => DETAIL,
      'grape.issue.dispatch': (input) => {
        dispatched.push(input)
        return {
          issueKey: input.issueKey,
          workspaceId: 'w1',
          workspaceName: 'platform',
          terminalId: 't1',
          agent: input.agent ?? 'claude'
        }
      }
    }
  })
  const view = await mount(panel, { host })
  await view.settled()

  await view.press({ type: 'ListItem' })
  await view.press({ text: 'Dispatch to workspace' })

  assert.equal(dispatched.length, 1)
  assert.equal(dispatched[0].issueKey, ISSUE.key)
  assert.ok(drawn(view).includes('claude started on'))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('a failing Grape call is reported, not swallowed', async () => {
  const host = mockHost({
    requests: {
      'grape.connection.get': () => CONNECTED,
      'grape.issues.list': () =>
        listResult([], { ...CONNECTED, reachable: false, error: 'Grape rejected the API key (401).' })
    }
  })
  const view = await mount(panel, { host })
  await view.settled()

  assert.ok(drawn(view).includes('Grape rejected the API key (401).'))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})