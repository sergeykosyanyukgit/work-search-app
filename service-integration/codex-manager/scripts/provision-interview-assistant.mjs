import { pathToFileURL } from 'node:url'

export const PROFILE_SLUG = 'interview-assistant'
export const PROFILE_VERSION = 2
export const CLIENT_EXTERNAL_ID = 'work-search-app'
export const CLIENT_SCOPES = ['sessions:read', 'sessions:write']

export const INTERVIEW_BASE_INSTRUCTIONS = [
  'Ты помогаешь кандидату быстро сформулировать ответ на вопрос собеседования.',
  'Дай готовую к произнесению подсказку на языке вопроса с учетом переданного профиля кандидата и вакансии.',
  'Начинай сразу с прямого ответа. По умолчанию достаточно 20–35 слов: одна короткая мысль и до двух опорных пунктов.',
  'Если пользователь явно просит подробности или код, дай необходимое пояснение или минимальный пример кода.',
  'Не добавляй вступления, предложения продолжить, перечни альтернатив и повтор вопроса.',
  'Не выдумывай опыт кандидата или неизвестные факты. При существенной неоднозначности коротко обозначь допущение.',
  'Не используй инструменты, команды, файлы, браузер или сеть. Код приводи только как текст.'
].join('\n')

export function interviewProfile(model, version = PROFILE_VERSION) {
  if (typeof model !== 'string' || !model.trim()) throw new Error('An explicit model is required')
  if (![1, PROFILE_VERSION].includes(version)) throw new Error('Unsupported interview profile version')
  return {
    slug: PROFILE_SLUG,
    modelSequence: [model], recoveryModels: [], reasoningEffort: 'low', sandboxMode: 'read-only',
    networkAccess: false, webSearchMode: 'disabled', mcpTemplateSlugs: [], overrideableFields: [],
    turnTimeoutMs: 120_000, perTurnTokenCap: 24_000,
    rawConfig: {
      ...(version === PROFILE_VERSION ? {
        codex_manager_runtime: 'app-server',
        codex_manager_base_instructions: INTERVIEW_BASE_INSTRUCTIONS,
        model_verbosity: 'low',
        model_reasoning_summary: 'none'
      } : {}),
      features: { shell_tool: false, unified_exec: false, apps: false, multi_agent: false },
      tools: { view_image: false },
      developer_instructions: version === PROFILE_VERSION
        ? 'Следуй заданным инструкциям помощника по собеседованию и учитывай переданный профиль кандидата. По умолчанию отвечай кратко; по явной просьбе дай подробности или код. Не используй инструменты и не выдумывай опыт кандидата.'
        : 'Ты помощник по вопросам собеседования. Отвечай непосредственно на последний вопрос с учётом переданного опыта и вакансии. Не выполняй команды, не используй инструменты и не ищи данные в файлах или интернете. Не выдумывай личный опыт кандидата. Пиши ясный краткий ответ на языке вопроса, если пользователь не указал другой язык. Код показывай как текст ответа без запуска.'
    }
  }
}

function leaves(value, prefix = '') {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return child && typeof child === 'object' && !Array.isArray(child) ? leaves(child, path) : [path]
  })
}
export function interviewPolicy(profile) {
  return {
    allowedProfileSlugs: [PROFILE_SLUG], allowDirectConfig: false,
    allowedModels: profile.modelSequence, allowedEfforts: ['low'], allowedSandboxModes: ['read-only'],
    allowNetwork: false, allowedWebSearchModes: ['disabled'], allowedMcpTemplates: [],
    allowedRawConfigPaths: leaves(profile.rawConfig), queueTimeoutMs: 30_000
  }
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
  return JSON.stringify(value)
}
export function drift(stored, desired) { return Object.keys(desired).filter(key => canonical(stored[key]) !== canonical(desired[key])) }

export function availableModel(workers, model) {
  return workers.some(worker => {
    if (worker.status !== 'READY' || !worker.authenticated || worker.draining) return false
    const catalog = worker.models?.data ?? worker.models?.models ?? []
    return Array.isArray(catalog) && catalog.some(row => typeof row === 'string' ? row === model : [row.id, row.model, row.slug].includes(model))
  })
}

/** API-only provisioning preserves the manager's audit trail. No unrelated client is patched. */
export async function provision(api, { model, clientId, apply = false, issueKey = false }) {
  if (issueKey && !apply) throw new Error('--issue-key requires --apply')
  if (clientId !== undefined && (typeof clientId !== 'string' || !clientId.trim())) throw new Error('--client-id requires an existing client ID')
  const profile = interviewProfile(model)
  const policy = interviewPolicy(profile)
  // An explicitly selected existing client keeps every quota, including its queue timeout.
  if (clientId !== undefined) delete policy.queueTimeoutMs
  // Refresh is explicit: it calls the existing administrative model/quota probe before checking catalog.
  const workers = await api('GET', '/api/v1/admin/workers?refresh=false')
  if (!Array.isArray(workers)) throw new Error('Invalid worker catalog')
  for (const worker of workers.filter(row => row.status === 'READY' && row.authenticated && !row.draining)) {
    await api('POST', `/api/v1/admin/workers/${encodeURIComponent(worker.id)}/quota/refresh`)
  }
  const refreshed = await api('GET', '/api/v1/admin/workers?refresh=false')
  if (!Array.isArray(refreshed) || !availableModel(refreshed, model)) throw new Error(`No READY authenticated worker currently exposes model ${model}`)
  const profiles = await api('GET', `/api/v1/admin/profiles?slug=${PROFILE_SLUG}`)
  if (!Array.isArray(profiles)) throw new Error('Invalid profile catalog')
  if (profiles.some(row => row.slug !== PROFILE_SLUG || !Number.isSafeInteger(row.version) || row.version < 1 || row.version > PROFILE_VERSION)) {
    throw new Error('Unexpected existing profile versions; refusing to replace or downgrade them')
  }
  let stored = profiles.find(row => row.version === PROFILE_VERSION)
  if (stored && drift(stored, profile).length) throw new Error(`Immutable ${PROFILE_SLUG}@${PROFILE_VERSION} differs: ${drift(stored, profile).join(', ')}. Publish a new catalog version instead.`)
  const clients = []
  let cursor
  do {
    const rows = await api('GET', `/api/v1/admin/clients?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
    if (!Array.isArray(rows)) throw new Error('Invalid client catalog')
    clients.push(...rows)
    cursor = rows.length === 100 ? rows.at(-1).id : undefined
  } while (cursor)
  let client = clients.find(row => clientId === undefined ? row.externalId === CLIENT_EXTERNAL_ID : row.id === clientId)
  if (clientId !== undefined) {
    if (!client) throw new Error('Requested client ID was not found; refusing to create a replacement')
    const existingPolicy = client.policy
    if (!existingPolicy || existingPolicy.allowDirectConfig !== false || !Array.isArray(existingPolicy.allowedProfileSlugs) || existingPolicy.allowedProfileSlugs.some(slug => slug !== PROFILE_SLUG)) {
      throw new Error('Requested client permits unrelated profiles or direct configuration; refusing to repurpose a shared client')
    }
  }
  if (client && client.status !== 'ACTIVE') throw new Error('Dedicated client is not active; refusing to reactivate it')
  if (!client && clients.some(row => row.name === CLIENT_EXTERNAL_ID)) throw new Error('Client name belongs to another externalId; refusing to repurpose it')
  if (client) delete policy.queueTimeoutMs
  const changes = {
    profile: !stored ? 'create-and-publish' : !stored.published ? 'publish' : 'unchanged',
    bootstrapVersions: profiles.length ? [] : [1],
    client: !client ? 'create' : drift(client.policy ?? {}, policy).length ? 'update-dedicated-policy' : 'unchanged',
    model, profileVersion: PROFILE_VERSION, key: issueKey ? 'issue-new-key' : 'unchanged'
  }
  if (!apply) return { applied: false, changes, ...(client ? { clientId: client.id } : {}), profile, policy, scopes: CLIENT_SCOPES }
  // The API assigns the next version. Fresh installs reserve canonical v1 as an
  // unpublished legacy row; existing v1 rows and their session configs stay intact.
  if (!profiles.length) {
    const legacy = await api('POST', '/api/v1/admin/profiles', interviewProfile(model, 1))
    if (legacy.version !== 1) throw new Error('Profile version changed concurrently; refusing to publish')
  }
  if (!stored) stored = await api('POST', '/api/v1/admin/profiles', profile)
  if (stored.version !== PROFILE_VERSION) throw new Error('Profile version changed concurrently; refusing to publish')
  if (!stored.published) await api('POST', `/api/v1/admin/profiles/${encodeURIComponent(stored.id)}/publish`)
  if (!client) client = await api('POST', '/api/v1/admin/clients', { name: CLIENT_EXTERNAL_ID, externalId: CLIENT_EXTERNAL_ID, policy })
  else if (drift(client.policy ?? {}, policy).length) client = await api('PATCH', `/api/v1/admin/clients/${encodeURIComponent(client.id)}`, { policy })
  let token
  if (issueKey) {
    const key = await api('POST', `/api/v1/admin/clients/${encodeURIComponent(client.id)}/keys`, { name: `desktop-${new Date().toISOString()}`, scopes: CLIENT_SCOPES })
    token = key.token
    if (typeof token !== 'string' || !token) throw new Error('Service did not return the newly issued key')
  }
  return { applied: true, changes, clientId: client.id, ...(token ? { token } : {}) }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log('Usage: node scripts/provision-interview-assistant.mjs --model <worker-model> [--client-id <existing-dedicated-client-id>] [--url https://api.code-manager.ru] [--apply] [--issue-key]\nCredential: CODEX_MANAGER_ADMIN_TOKEN environment variable. Without --apply prints a preview. --client-id preserves the selected client identity, quotas and existing keys; shared clients are rejected. --issue-key prints the new client token once. Model/quota refresh runs even in preview.')
    return
  }
  const value = name => {
    const index = args.indexOf(name)
    if (index < 0) return undefined
    const result = args[index + 1]
    if (!result || result.startsWith('--')) throw new Error(`${name} requires a value`)
    return result
  }
  const base = new URL(value('--url') ?? 'https://api.code-manager.ru')
  if (base.username || base.password || (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))) throw new Error('HTTPS is required except for localhost')
  const adminToken = process.env.CODEX_MANAGER_ADMIN_TOKEN
  if (!adminToken || /[\r\n]/.test(adminToken)) throw new Error('Set CODEX_MANAGER_ADMIN_TOKEN')
  const api = async (method, path, body) => {
    const response = await fetch(new URL(path, base), {
      method, headers: { authorization: `Bearer ${adminToken}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(30_000)
    })
    if (!response.ok) throw new Error(`Manager rejected ${method} ${path.split('?')[0]} (${response.status})`)
    return response.json()
  }
  const result = await provision(api, { model: value('--model'), clientId: value('--client-id'), apply: args.includes('--apply'), issueKey: args.includes('--issue-key') })
  console.log(JSON.stringify(result, null, 2))
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'Provisioning failed'); process.exitCode = 1 })
}
