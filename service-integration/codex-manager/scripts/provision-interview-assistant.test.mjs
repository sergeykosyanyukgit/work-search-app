import assert from 'node:assert/strict'
import test from 'node:test'
import { provision, interviewProfile, interviewPolicy, PROFILE_VERSION, INTERVIEW_BASE_INSTRUCTIONS } from './provision-interview-assistant.mjs'

function fixture() {
  const state = { profiles: [], clients: [{ id: 'unrelated', externalId: 'other', name: 'other', status: 'ACTIVE', policy: { allowNetwork: true } }], writes: [], keys: 0 }
  const api = async (method, path, body) => {
    if (method === 'GET' && path.startsWith('/api/v1/admin/workers')) return [{ id: 'worker', status: 'READY', authenticated: true, draining: false, models: { data: [{ id: 'fixture-model' }] } }]
    if (path.endsWith('/quota/refresh')) return {}
    if (method === 'GET' && path.includes('/profiles')) return structuredClone(state.profiles)
    if (method === 'GET' && path.includes('/clients')) return structuredClone(state.clients)
    state.writes.push({ method, path, body })
    if (path === '/api/v1/admin/profiles') {
      const version = Math.max(0, ...state.profiles.map(row => row.version)) + 1
      const row = { ...body, id: `profile-${version}`, version, published: false }
      state.profiles.push(row)
      return structuredClone(row)
    }
    if (path.endsWith('/publish')) {
      for (const row of state.profiles) row.published = path === `/api/v1/admin/profiles/${row.id}/publish`
      return {}
    }
    if (path === '/api/v1/admin/clients') { const row = { ...body, id: 'dedicated', status: 'ACTIVE' }; state.clients.push(row); return structuredClone(row) }
    if (method === 'PATCH') { const row = state.clients.find(row => path.endsWith(`/${row.id}`)); row.policy = { ...row.policy, ...body.policy }; return structuredClone(row) }
    if (path.endsWith('/keys')) { state.keys++; return { token: 'fake-explicitly-issued-token' } }
    throw new Error(`Unexpected request ${method} ${path}`)
  }
  return { state, api }
}
test('preview prepares exact profile/policy without creating or patching records', async () => {
  const { state, api } = fixture()
  const result = await provision(api, { model: 'fixture-model' })
  assert.equal(result.applied, false)
  assert.deepEqual(state.writes, [])
  assert.equal(result.profile.rawConfig.features.shell_tool, false)
  assert.ok(result.policy.allowedRawConfigPaths.includes('features.shell_tool'))
  assert.equal(result.changes.profileVersion, 2)
  assert.deepEqual(result.changes.bootstrapVersions, [1])
  assert.equal(result.profile.rawConfig.codex_manager_runtime, 'app-server')
  assert.equal(result.profile.rawConfig.codex_manager_base_instructions, INTERVIEW_BASE_INSTRUCTIONS)
  assert.match(INTERVIEW_BASE_INSTRUCTIONS, /20–35 слов/)
  assert.match(INTERVIEW_BASE_INSTRUCTIONS, /до двух опорных пунктов/)
  assert.match(INTERVIEW_BASE_INSTRUCTIONS, /явно просит подробности или код/)
  assert.equal(result.profile.rawConfig.model_verbosity, 'low')
  assert.equal(result.profile.rawConfig.model_reasoning_summary, 'none')
  assert.equal(result.profile.perTurnTokenCap, 24_000)
  for (const path of ['codex_manager_runtime', 'codex_manager_base_instructions', 'model_verbosity', 'model_reasoning_summary']) {
    assert.ok(result.policy.allowedRawConfigPaths.includes(path))
  }
})
test('repeat provisioning is idempotent and does not touch unrelated clients or rotate keys', async () => {
  const { state, api } = fixture()
  const unrelated = structuredClone(state.clients[0])
  await provision(api, { model: 'fixture-model', apply: true })
  const writes = state.writes.length
  const result = await provision(api, { model: 'fixture-model', apply: true })
  assert.equal(state.writes.length, writes)
  assert.equal(state.keys, 0)
  assert.equal(result.changes.client, 'unchanged')
  assert.deepEqual(state.clients[0], unrelated)
})
test('explicit issuance creates a key only for the dedicated client', async () => {
  const { state, api } = fixture()
  const result = await provision(api, { model: 'fixture-model', apply: true, issueKey: true })
  assert.equal(result.token, 'fake-explicitly-issued-token')
  assert.equal(state.keys, 1)
  assert.deepEqual(state.writes.at(-1).body.scopes, ['sessions:read', 'sessions:write'])
  assert.equal(state.writes.at(-1).path, '/api/v1/admin/clients/dedicated/keys')
})
test('rejects unavailable model before mutations', async () => {
  const { state, api } = fixture()
  await assert.rejects(provision(api, { model: 'absent', apply: true }), /No READY/)
  assert.deepEqual(state.writes, [])
})
test('rejects immutable profile drift before mutations', async () => {
  const { state, api } = fixture()
  state.profiles.push({ ...interviewProfile('fixture-model'), id: 'profile', version: PROFILE_VERSION, turnTimeoutMs: 999_999 })
  await assert.rejects(provision(api, { model: 'fixture-model', apply: true }), /Immutable/)
  assert.deepEqual(state.writes, [])
})
test('patches only dedicated permission fields while preserving custom quotas', async () => {
  const { state, api } = fixture()
  state.clients.push({ id: 'dedicated', name: 'work-search-app', externalId: 'work-search-app', status: 'ACTIVE', policy: { ...interviewPolicy(interviewProfile('fixture-model')), allowNetwork: true, maxTurnsPerUtcDay: 777, queueTimeoutMs: 90_000 } })
  await provision(api, { model: 'fixture-model', apply: true })
  assert.equal(state.clients[1].policy.maxTurnsPerUtcDay, 777)
  assert.equal(state.clients[1].policy.allowNetwork, false)
  assert.equal(state.clients[1].policy.queueTimeoutMs, 90_000)
  assert.equal(state.writes.filter(row => row.method === 'PATCH').length, 1)
})

function existingDedicatedClient() {
  return {
    id: 'existing-work-search', name: 'work-search', externalId: null, status: 'ACTIVE',
    keys: [{ id: 'existing-key', scopes: ['sessions:read', 'sessions:write'] }],
    policy: {
      allowedProfileSlugs: [], allowDirectConfig: false,
      maxConcurrentSessions: 8, maxQueuedTurns: 20, maxTurnsPerUtcDay: 777,
      maxTokensPerUtcDay: 123_456, maxWorkspaces: 4, maxWorkspaceBytes: '987654321',
      maxUploadBytes: 654_321, queueTimeoutMs: 90_000, idleSessionTtlSeconds: 7200
    }
  }
}

test('explicit existing client is previewed and adopted without duplicate clients, keys or quota changes', async () => {
  const { state, api } = fixture()
  const client = existingDedicatedClient()
  state.clients.push(client)
  const original = structuredClone(client)
  const preview = await provision(api, { model: 'fixture-model', clientId: client.id })
  assert.equal(preview.clientId, client.id)
  assert.equal(preview.changes.client, 'update-dedicated-policy')
  assert.equal('queueTimeoutMs' in preview.policy, false)
  assert.deepEqual(state.writes, [])

  const result = await provision(api, { model: 'fixture-model', clientId: client.id, apply: true })
  assert.equal(result.clientId, client.id)
  assert.equal(state.clients.length, 2)
  assert.equal(state.keys, 0)
  assert.equal(client.name, original.name)
  assert.equal(client.externalId, original.externalId)
  assert.deepEqual(client.keys, original.keys)
  for (const [key, value] of Object.entries(original.policy)) {
    if (key.startsWith('max') || key === 'queueTimeoutMs' || key === 'idleSessionTtlSeconds') assert.equal(client.policy[key], value, key)
  }
  assert.deepEqual(client.policy.allowedProfileSlugs, ['interview-assistant'])
  assert.equal(state.writes.filter(row => row.path === '/api/v1/admin/clients' || row.path.endsWith('/keys')).length, 0)
  const patch = state.writes.find(row => row.method === 'PATCH')
  assert.equal(patch.path, `/api/v1/admin/clients/${client.id}`)
  assert.deepEqual(Object.keys(patch.body), ['policy'])
  const writes = state.writes.length
  const repeat = await provision(api, { model: 'fixture-model', clientId: client.id, apply: true })
  assert.equal(repeat.changes.client, 'unchanged')
  assert.equal(state.writes.length, writes)
})

test('explicit key issuance targets the selected existing client only', async () => {
  const { state, api } = fixture()
  const client = existingDedicatedClient()
  state.clients.push(client)
  await provision(api, { model: 'fixture-model', clientId: client.id, apply: true, issueKey: true })
  assert.equal(state.keys, 1)
  assert.equal(state.writes.at(-1).path, `/api/v1/admin/clients/${client.id}/keys`)
  assert.deepEqual(state.writes.at(-1).body.scopes, ['sessions:read', 'sessions:write'])
})

test('explicit unknown client ID cannot fall back to default discovery or create a replacement', async () => {
  const { state, api } = fixture()
  state.clients.push({ ...existingDedicatedClient(), externalId: 'work-search-app' })
  await assert.rejects(provision(api, { model: 'fixture-model', clientId: 'missing', apply: true }), /not found/)
  assert.deepEqual(state.writes, [])
})

test('explicit client ID rejects shared clients before profile or client mutations', async () => {
  for (const policy of [
    { allowedProfileSlugs: ['landing-generation'], allowDirectConfig: false },
    { allowedProfileSlugs: ['interview-assistant', 'other'], allowDirectConfig: false },
    { allowedProfileSlugs: [], allowDirectConfig: true },
    null
  ]) {
    const { state, api } = fixture()
    const client = { ...existingDedicatedClient(), policy }
    state.clients.push(client)
    await assert.rejects(provision(api, { model: 'fixture-model', clientId: client.id, apply: true }), /shared client/)
    assert.deepEqual(state.writes, [])
  }
})

test('explicit inactive client is not reactivated', async () => {
  const { state, api } = fixture()
  const client = { ...existingDedicatedClient(), status: 'SUSPENDED' }
  state.clients.push(client)
  await assert.rejects(provision(api, { model: 'fixture-model', clientId: client.id, apply: true }), /not active/)
  assert.deepEqual(state.writes, [])
})

test('empty explicit client ID is rejected before any API call', async () => {
  const api = async () => { assert.fail('No API call expected') }
  await assert.rejects(provision(api, { model: 'fixture-model', clientId: '', apply: true }), /requires an existing client ID/)
})

test('fresh provisioning bootstraps an unpublished legacy v1 and publishes only v2', async () => {
  const { state, api } = fixture()
  await provision(api, { model: 'fixture-model', apply: true })
  assert.equal(state.profiles.length, 2)
  assert.deepEqual(state.profiles.map(({ version, published }) => ({ version, published })), [
    { version: 1, published: false }, { version: 2, published: true }
  ])
  assert.equal(state.profiles[0].rawConfig.codex_manager_runtime, undefined)
  assert.equal(state.profiles[1].rawConfig.codex_manager_runtime, 'app-server')
  assert.deepEqual(state.writes.filter(row => row.path.endsWith('/publish')).map(row => row.path), ['/api/v1/admin/profiles/profile-2/publish'])
})

test('v1 upgrade preserves immutable contents, existing client identity, quotas and keys, then repeats without writes', async () => {
  const { state, api } = fixture()
  const legacy = { ...interviewProfile('fixture-model', 1), id: 'legacy-profile', version: 1, published: true }
  legacy.rawConfig.developer_instructions = 'Previously published custom legacy instructions remain immutable.'
  state.profiles.push(legacy)
  const oldContent = structuredClone(legacy)
  const client = existingDedicatedClient()
  client.policy = { ...client.policy, ...interviewPolicy(interviewProfile('fixture-model', 1)), queueTimeoutMs: 90_000 }
  state.clients.push(client)
  const originalClient = structuredClone(client)

  const preview = await provision(api, { model: 'fixture-model', clientId: client.id })
  assert.deepEqual(preview.changes.bootstrapVersions, [])
  assert.equal(preview.changes.profile, 'create-and-publish')
  assert.deepEqual(state.writes, [])
  await provision(api, { model: 'fixture-model', clientId: client.id, apply: true })
  assert.deepEqual({ ...legacy, published: true }, oldContent)
  assert.equal(state.profiles.length, 2)
  assert.equal(state.profiles.find(row => row.version === 2).published, true)
  assert.equal(state.clients.length, 2)
  assert.equal(state.keys, 0)
  assert.deepEqual(client.keys, originalClient.keys)
  for (const [key, value] of Object.entries(originalClient.policy)) {
    if (key.startsWith('max') || key === 'queueTimeoutMs' || key === 'idleSessionTtlSeconds') assert.equal(client.policy[key], value, key)
  }
  assert.deepEqual(client.policy.allowedProfileSlugs, ['interview-assistant'])
  assert.ok(client.policy.allowedRawConfigPaths.includes('codex_manager_runtime'))
  const writes = state.writes.length
  const repeated = await provision(api, { model: 'fixture-model', clientId: client.id, apply: true })
  assert.equal(repeated.changes.profile, 'unchanged')
  assert.equal(repeated.changes.client, 'unchanged')
  assert.equal(state.writes.length, writes)
})

test('resumes publication of an existing exact v2 without creating a new version', async () => {
  const { state, api } = fixture()
  state.profiles.push({ ...interviewProfile('fixture-model', 1), id: 'legacy', version: 1, published: true })
  state.profiles.push({ ...interviewProfile('fixture-model'), id: 'current', version: 2, published: false })
  await provision(api, { model: 'fixture-model', apply: true })
  assert.equal(state.profiles.length, 2)
  assert.equal(state.profiles[1].published, true)
  assert.equal(state.writes.filter(row => row.path === '/api/v1/admin/profiles').length, 0)
})

test('a newer version is never silently replaced or downgraded', async () => {
  const { state, api } = fixture()
  state.profiles.push({ ...interviewProfile('fixture-model'), id: 'future', version: 3, published: true })
  await assert.rejects(provision(api, { model: 'fixture-model', apply: true }), /refusing to replace or downgrade/)
  assert.deepEqual(state.writes, [])
})

test('missing explicit model is rejected before reading the service', async () => {
  for (const model of [undefined, '', ' ']) {
    await assert.rejects(provision(async () => assert.fail('No API call expected'), { model, apply: true }), /explicit model/)
  }
})
