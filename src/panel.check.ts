// `orca plugin check` renders the panel once per scenario, each with the worker on a fresh
// host. Seed what the worker reads so check shows more than the first state.
import { defineCheck } from 'orca/testing'

const cachedIssues = [
  {
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
    description: 'The build stage finishes but the deploy stage never starts.',
    createdAt: '2026-11-20 10:12:00'
  },
  {
    key: 'gitcode:acme/platform#415',
    id: 4150,
    number: 415,
    repoKey: 'gitcode:acme/platform',
    title: 'Add a health endpoint to the gateway',
    status: 'active',
    stage: 'plan',
    sceneName: 'default',
    assignee: 'huqi',
    creator: 'huqi',
    running: true,
    isPr: false,
    description: '',
    createdAt: '2026-11-21 09:00:00'
  }
]

export default defineCheck({
  // Nothing configured: the panel shows the connection form.
  'not connected': {},
  // A cached list from a previous session: the panel renders it without the network.
  'cached list': {
    storage: { issues: cachedIssues, checkedAt: 1_764_000_000_000 },
    settings: { baseUrl: 'http://grape.internal:8080', statusFilter: 'active' },
    secrets: { 'grape-token': 'grape_check_only' }
  }
})
