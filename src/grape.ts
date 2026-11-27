// Grape REST client and issue normalization. No Orca imports: this module is testable in
// plain Node, which is where the interesting bugs live (URL validation, odd payloads).
//
// Endpoints used, all of them readable with a personal `grape_` API key:
//   GET /api/issues/mine                your issues, status-enriched cards
//   GET /api/issues/{owner}/{repo}/{n}  one issue: base fields, events, pipeline
// Review endpoints (review-pass / review-reject / awaiting-input) need the session `tk_`
// token Grape injects into an agent's own environment and answer 403 to a personal key, so
// this plugin never calls them.

import type { GrapeIssue, GrapeIssueDetail, PipelineNode } from './protocol'

export class GrapeError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'invalid_base_url'
      | 'unauthorized'
      | 'forbidden'
      | 'not_found'
      | 'http_error'
      | 'network'
      | 'bad_payload',
    readonly status = 0
  ) {
    super(message)
    this.name = 'GrapeError'
  }
}

/** Strips whitespace and a trailing slash, and refuses anything but http(s) with a host. */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = (raw || '').trim()
  if (!trimmed) throw new GrapeError('Grape base URL is empty', 'invalid_base_url')
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new GrapeError(`Not a URL: ${trimmed}`, 'invalid_base_url')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new GrapeError(`Base URL must be http or https, got ${url.protocol}`, 'invalid_base_url')
  }
  if (!url.hostname) throw new GrapeError('Base URL has no host', 'invalid_base_url')
  // A pasted API path or query would silently break every request later.
  url.search = ''
  url.hash = ''
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`
}

/** `gitcode:owner/repo` -> `owner/repo`. Grape's routes take the unprefixed form. */
export function fromRepoKey(repoKey: string): string {
  const key = (repoKey || '').trim()
  return key.includes(':') ? key.split(':').slice(1).join(':') : key
}

/** The provider half of a repo key, or `gitcode` when it carries none. */
export function providerOf(repoKey: string): string {
  const key = (repoKey || '').trim()
  return key.includes(':') ? key.split(':', 1)[0] : 'gitcode'
}

/** The web host a repo lives on. Grape's own dashboard resolves it the same way: github.com for
 *  `github:`, gitcode.com otherwise; a self-hosted GitLab needs the override setting. */
export function vcsHostFor(repoKey: string, override = ''): string {
  const provider = providerOf(repoKey)
  if (provider === 'github') return 'github.com'
  if (provider === 'gitcode') return 'gitcode.com'
  return override.trim() || ''
}

export interface IssueLinks {
  /** The Grape console. Its SPA has no per-issue route, so this is the console root. */
  grape: string
  /** The issue on the code host. */
  issue: string
  /** The repository on the code host. */
  repo: string
}

/** Card links. Empty strings mean "cannot build it": a self-hosted host we were not told about
 *  must not be guessed, or the link would 404 in a way that looks like a plugin bug. */
export function issueLinks(
  repoKey: string,
  number: number,
  options: { grapeBaseUrl: string; vcsHostOverride?: string }
): IssueLinks {
  const repo = fromRepoKey(repoKey)
  const host = vcsHostFor(repoKey, options.vcsHostOverride ?? '')
  const base = host && repo ? `https://${host}/${repo}` : ''
  return {
    grape: options.grapeBaseUrl || '',
    issue: base ? `${base}/issues/${number}` : '',
    repo: base
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function pickString(source: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = asString(source[key])
    if (value) return value
  }
  return ''
}

/** One /api/issues card -> GrapeIssue. Unknown shapes degrade instead of throwing: a Grape
 *  release that renames a field should gray out one column, not empty the panel. */
export function normalizeIssue(raw: unknown): GrapeIssue {
  const row = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const repoKey = asString(row.repo_key)
  const number = asNumber(row.issue_number)
  return {
    key: `${repoKey}#${number}`,
    id: asNumber(row.id),
    number,
    repoKey,
    title: asString(row.title) || `#${number}`,
    status: asString(row.status) || 'unknown',
    stage: pickString(row, ['stage', 'issue_stage']),
    sceneName: asString(row.scene_name),
    assignee: asString(row.assignee),
    creator: pickString(row, ['creator', 'created_by']),
    running: row.is_running === true,
    isPr: row.is_pr === true,
    description: asString(row.task_description),
    createdAt: pickString(row, ['created_at'])
  }
}

function normalizeNodes(pipeline: unknown): PipelineNode[] {
  const segments = (pipeline && typeof pipeline === 'object' ? pipeline : {}) as Record<
    string,
    unknown
  >
  return asArray(segments.segments)
    .map((segment) => {
      const node = (segment && typeof segment === 'object' ? segment : {}) as Record<
        string,
        unknown
      >
      return {
        name: pickString(node, ['name', 'segment', 'node', 'stage', 'title']),
        status: pickString(node, ['status', 'state', 'task_status'])
      }
    })
    .filter((node) => node.name || node.status)
}

/** One /api/issues/{owner}/{repo}/{n} payload -> GrapeIssueDetail (may carry a VCS fallback
 *  shape, which has no pipeline and a null issue_id). */
export function normalizeIssueDetail(raw: unknown, repoKey: string): GrapeIssueDetail {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const number = asNumber(body.number)
  const key = body.issue_id === null || body.issue_id === undefined ? `${repoKey}#${number}` : `${repoKey}#${number}`
  return {
    key,
    number,
    repoKey,
    title: asString(body.title) || `#${number}`,
    stage: pickString(body, ['stage', 'issue_stage']),
    taskStatus: pickString(body, ['task_status', 'status']),
    ownerAgent: asString(body.owner_agent),
    assignee: asString(body.assignee),
    creator: asString(body.creator),
    eventsCount: asNumber(body.events_count, asArray(body.events).length),
    attachmentsCount: asArray(body.attachments).length,
    pipelineStatus: pickString(
      (body.pipeline && typeof body.pipeline === 'object' ? body.pipeline : {}) as Record<
        string,
        unknown
      >,
      ['status', 'summary']
    ),
    nodes: normalizeNodes(body.pipeline)
  }
}

/** The prompt an agent gets on dispatch. Deterministic and complete: the issue number, its
 *  title, its status and the requirement body, then any team instructions from settings. */
export function buildDispatchPrompt(issue: GrapeIssue, extraInstructions = ''): string {
  const repo = fromRepoKey(issue.repoKey)
  const lines = [
    `Grape issue ${repo}#${issue.number}: ${issue.title}`,
    '',
    `Status: ${issue.status}${issue.stage ? ` (stage: ${issue.stage})` : ''}`,
    issue.sceneName ? `Scene: ${issue.sceneName}` : '',
    '',
    issue.description.trim() || '(This issue has no description on Grape; ask before assuming the requirement.)',
    '',
    'Read the requirement above, then plan before you change code. Do not close or move the issue on Grape: a personal API key cannot do that, and the reviewer does it in the Grape web UI.'
  ]
  const extra = extraInstructions.trim()
  if (extra) lines.push('', extra)
  return lines.filter((line, index) => line !== '' || index < 3).join('\n')
}

export interface GrapeClientOptions {
  baseUrl: string
  token: string
  /** Injected in tests; defaults to the Node global. */
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export class GrapeClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(options: GrapeClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl)
    this.token = (options.token || '').trim()
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.timeoutMs = options.timeoutMs ?? 15000
  }

  async listMine(query: { status?: string; repoKey?: string } = {}): Promise<GrapeIssue[]> {
    const params = new URLSearchParams()
    if (query.status) params.set('status', query.status)
    if (query.repoKey) params.set('repo_key', query.repoKey)
    const body = await this.getJson('/api/issues/mine', params)
    return asArray((body as Record<string, unknown>).issues).map(normalizeIssue)
  }

  async issueDetail(repoKey: string, number: number): Promise<GrapeIssueDetail> {
    const repo = fromRepoKey(repoKey)
    if (!repo.includes('/')) {
      throw new GrapeError(`Cannot read owner/repo from "${repoKey}"`, 'bad_payload')
    }
    const [owner, ...rest] = repo.split('/')
    const path = `/api/issues/${encodeURIComponent(owner)}/${encodeURIComponent(
      rest.join('/')
    )}/${encodeURIComponent(String(number))}`
    return normalizeIssueDetail(await this.getJson(path), repoKey)
  }

  /** Moves an issue to `status`. A personal key may do this; review-pass/review-reject are the
   *  two that stay locked to an agent session. */
  async setStatus(issueId: number, status: string): Promise<void> {
    await this.sendJson('PUT', `/api/issues/${encodeURIComponent(String(issueId))}/status`, {
      status
    })
  }

  /** Posts a comment on the issue and into the task conversation. */
  async clarify(issueId: number, message: string): Promise<void> {
    await this.sendJson('POST', `/api/issues/${encodeURIComponent(String(issueId))}/clarify`, {
      message
    })
  }

  private async sendJson(method: 'PUT' | 'POST', path: string, body: unknown): Promise<unknown> {
    const url = `${this.baseUrl}${path}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          'PRIVATE-TOKEN': this.token,
          'content-type': 'application/json',
          accept: 'application/json'
        },
        body: JSON.stringify(body),
        signal: controller.signal
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new GrapeError(`Cannot reach ${this.baseUrl}: ${reason}`, 'network')
    } finally {
      clearTimeout(timer)
    }

    if (response.status === 403) {
      throw new GrapeError(
        `Grape refused ${path} for this key (403). Only review-pass and review-reject need an agent session token.`,
        'forbidden',
        403
      )
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      const code = response.status === 401 ? 'unauthorized' : 'http_error'
      throw new GrapeError(
        `Grape answered ${response.status} for ${path}${text ? `: ${text.slice(0, 200)}` : ''}`,
        code,
        response.status
      )
    }
    try {
      return await response.json()
    } catch {
      // A 204 or an empty body is a fine answer for a write.
      return null
    }
  }

  private async getJson(path: string, params?: URLSearchParams): Promise<unknown> {
    const suffix = params && params.toString() ? `?${params.toString()}` : ''
    const url = `${this.baseUrl}${path}${suffix}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          // Grape accepts Bearer / PRIVATE-TOKEN / ?access_token; the header keeps the key
          // out of URLs and out of proxy logs.
          'PRIVATE-TOKEN': this.token,
          accept: 'application/json'
        },
        signal: controller.signal
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new GrapeError(`Cannot reach ${this.baseUrl}: ${reason}`, 'network')
    } finally {
      clearTimeout(timer)
    }

    if (response.status === 401) {
      throw new GrapeError('Grape rejected the API key (401). Check the key is a valid grape_ token.', 'unauthorized', 401)
    }
    if (response.status === 403) {
      throw new GrapeError(
        'Grape refused this key for that endpoint (403). Review actions need an agent session token; this plugin only reads.',
        'forbidden',
        403
      )
    }
    if (response.status === 404) {
      throw new GrapeError(`Grape has no ${path} (404)`, 'not_found', 404)
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new GrapeError(
        `Grape answered ${response.status} for ${path}${text ? `: ${text.slice(0, 200)}` : ''}`,
        'http_error',
        response.status
      )
    }
    try {
      return await response.json()
    } catch {
      throw new GrapeError(`Grape answered ${path} with a non-JSON body`, 'bad_payload')
    }
  }
}
