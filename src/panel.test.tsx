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
  return {
    issues,
    status,
    filter: { status: 'active', repoKey: '' },
    fetchedAt: 1_764_000_000_000,
    fromCache: false
  }
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
  nodes: [{ name: 'build', status: 'failed', eventType: 'issue_opened', seq: 1 }]
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
      'grape.issue.detail': () => DETAIL,
      'grape.issue.links': () => ({
        grape: 'http://grape.internal:8080',
        issue: 'https://gitcode.com/acme/platform/issues/412',
        repo: 'https://gitcode.com/acme/platform'
      })
    }
  })
  const view = await mount(panel, { host })
  await view.settled()

  assert.ok(drawn(view).includes('Pipeline stops after the build stage'))
  assert.ok(drawn(view).includes('1 waiting'))

  // The list is a Table now: a row opens by activation, not by text.
  await view.activateRow({ type: 'Table' }, ISSUE.key)
  // Each pipeline segment draws as a badge, so the agent and its state are one label.
  assert.ok(drawn(view).includes('build · failed'))
  assert.ok(drawn(view).includes('0 of 1 steps completed · 1 failed'))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('repeated pipeline segments collapse into one badge with a count', async () => {
  // Real shape from Grape issue #3383: the same agent emits one segment per event, so a plain
  // badge list repeats "coding · completed" instead of saying how many times it ran.
  const host = mockHost({
    requests: {
      'grape.connection.get': () => CONNECTED,
      'grape.issues.list': () => listResult([ISSUE]),
      'grape.issue.detail': () => ({
        ...DETAIL,
        nodes: [
          { name: 'vod', status: 'completed', eventType: 'issue_opened', seq: 1 },
          { name: 'vod', status: 'completed', eventType: 'a2a_event', seq: 2 },
          { name: 'coding', status: 'completed', eventType: 'a2a_event', seq: 3 },
          { name: 'coding', status: 'failed', eventType: 'a2a_event', seq: 4 }
        ]
      }),
      'grape.issue.links': () => ({ grape: '', issue: '', repo: '' })
    }
  })
  const view = await mount(panel, { host })
  await view.settled()
  await view.activateRow({ type: 'Table' }, ISSUE.key)

  const text = drawn(view)
  // Two vod/completed segments become one counted badge; the two coding segments differ by
  // status, so they stay separate and neither gets a count.
  assert.ok(text.includes('vod · completed ×2'))
  assert.ok(text.includes('coding · completed'))
  assert.ok(text.includes('coding · failed'))
  assert.ok(!text.includes('coding · completed ×'))
  assert.ok(text.includes('3 of 4 steps completed · 1 failed'))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('a working list dispatches the selected issue with the chosen agent', async () => {
  const dispatched: Array<{ issueKey: string; agent?: string }> = []
  const host = mockHost({
    requests: {
      'grape.connection.get': () => CONNECTED,
      'grape.issues.list': () => listResult([ISSUE]),
      'grape.issue.detail': () => DETAIL,
      'grape.issue.links': () => ({
        grape: 'http://grape.internal:8080',
        issue: 'https://gitcode.com/acme/platform/issues/412',
        repo: 'https://gitcode.com/acme/platform'
      }),
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

  await view.activateRow({ type: 'Table' }, ISSUE.key)
  await view.press({ text: 'Dispatch here' })

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

test('an empty list names the filter it asked for and widens on one press', async () => {
  // This is the state that was unreadable: connected, answered, zero rows. The panel has to say
  // which status and which host produced that, instead of a bare "no issues".
  const widened: string[] = []
  const host = mockHost({
    requests: {
      'grape.connection.get': () => CONNECTED,
      'grape.issues.list': () => ({
        issues: [],
        status: CONNECTED,
        filter: { status: 'pending_review', repoKey: '' },
        fetchedAt: 1_764_000_000_000,
        fromCache: false
      }),
      'grape.filter.all': () => {
        widened.push('all')
        return {
          issues: [ISSUE],
          status: CONNECTED,
          filter: { status: '', repoKey: '' },
          fetchedAt: 1_764_000_000_001,
          fromCache: false
        }
      }
    }
  })
  const view = await mount(panel, { host })
  await view.settled()

  // The drawn tree is JSON, so quotes in the description arrive escaped; match the stable part.
  assert.ok(drawn(view).includes('returned 0 issues for status'))
  assert.ok(drawn(view).includes('pending_review'))

  await view.press({ text: 'Show all statuses' })
  assert.equal(widened.length, 1)
  // The widened answer replaces the empty state with the rows it found.
  assert.ok(drawn(view).includes('Pipeline stops after the build stage'))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})
test('an issue is queued for a batch and started in the chosen Git project', async () => {
  const batches: Array<{ issueKeys: string[]; projectId?: string }> = []
  const host = mockHost({
    requests: {
      'grape.connection.get': () => CONNECTED,
      'grape.issues.list': () => listResult([ISSUE]),
      'grape.dispatch.list': () => ({ records: [] }),
      'orca.targets': () => ({
        projects: [{ id: 'proj-git', name: 'platform', hostId: 'local' }],
        // The focused workspace sits in a folder project: batch still works via the picker.
        focused: { projectId: 'proj-folder', name: 'dev', kind: 'folder' }
      }),
      'grape.issue.detail': () => DETAIL,
      'grape.issue.links': () => ({
        grape: 'http://grape.internal:8080',
        issue: 'https://gitcode.com/acme/platform/issues/412',
        repo: 'https://gitcode.com/acme/platform'
      }),
      'grape.issues.dispatchBatch': (input) => {
        batches.push(input)
        return {
          dispatched: [
            {
              issueKey: ISSUE.key,
              issueId: ISSUE.id,
              repoKey: ISSUE.repoKey,
              number: ISSUE.number,
              title: ISSUE.title,
              workspaceId: 'w-new',
              workspaceName: 'grape/412',
              terminalId: 't-new',
              agent: 'claude',
              dispatchedAt: 1_764_000_000_000,
              state: 'running' as const
            }
          ],
          failed: []
        }
      }
    }
  })
  const view = await mount(panel, { host })
  await view.settled()

  await view.activateRow({ type: 'Table' }, ISSUE.key)
  await view.press({ text: 'Add to batch' })
  assert.ok(drawn(view).includes('1 queued'))
  assert.ok(drawn(view).includes('Remove from batch'))

  await view.press({ text: 'Start 1 in platform' })
  assert.equal(batches.length, 1)
  assert.equal(batches[0].projectId, 'proj-git')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})
