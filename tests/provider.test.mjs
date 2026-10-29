/**
 * Provider 契约测试：manifest / adapter 方法形状（stub SDK + 临时目录）。
 * Run: node tests/provider.test.mjs
 *
 * 注意：memory-spaces 的 MemoryProviderAdapter 把数据面方法都当 Promise 用
 * （`untilAborted(discover())`、`status().catch(...)`），所以这里断言每个方法
 * 返回 thenable——同步返回值会让宿主崩在 `.then/.catch is not a function`。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { buildProvider } from '../provider.js'
import { SPACE_DESCRIPTION, SPACE_NAME, readStore, upsertExperience, writeStore } from '../store.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-provider-'))
const sdk = {
  apiVersion: 'dsh-mnemon.memory-space-provider/v1',
  defineMemorySpaceProviderDefinition: (definition) => definition,
}
const definition = buildProvider(sdk, { dataDir: dir })
const adapter = definition.create({ configuration: { dataDir: dir } })
let passed = 0
let failed = 0

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}`)
    console.log(`       ${error && error.message ? error.message : error}`)
  }
}

const isThenable = (value) => value !== null && typeof value === 'object' && typeof value.then === 'function'

await check('manifest：provider 契约字段与能力位', () => {
  // 契约要求 adapter.id === manifest.typeId（memory-spaces 的 assertRuntime 会校验）
  assert.equal(adapter.id, 'exp-lib')
  const manifest = definition.manifest
  assert.equal(manifest.apiVersion, 'dsh-mnemon.memory-space-provider/v1')
  assert.equal(manifest.kind, 'provider')
  assert.equal(manifest.typeId, 'exp-lib')
  assert.equal(manifest.packageName, 'dsh-exp-lib-provider')
  assert.equal(manifest.origin, 'third-party')
  assert.equal(manifest.locality, 'local')
  assert.deepEqual(manifest.capabilities, {
    search: true, browse: true, graph: true, entities: true,
    related: false, remember: false, link: false, forget: true,
    writeMode: 'exact', deletionMode: 'soft',
  })
  assert.equal(manifest.scoreSemantics, 'provider-native')
  assert.equal(manifest.fields.length, 1)
  assert.equal(manifest.fields[0].key, 'dataDir')
  assert.equal(manifest.fields[0].input, 'path')
  assert.deepEqual(manifest.secrets, [])
})

await check('契约：数据面方法都返回 Promise（宿主 .then/.catch 直接可用）', async () => {
  const calls = {
    discover: () => adapter.discover({}),
    status: () => adapter.status({}),
    search: () => adapter.search({}, { query: '研学课' }),
    list: () => adapter.list({}, { limit: 5 }),
    graph: () => adapter.graph({}),
    entityIndex: () => adapter.entityIndex({}),
    forget: () => adapter.forget({}, 'ex_missing'),
    remember: () => adapter.remember({}, { content: 'x' }),
  }
  for (const [name, call] of Object.entries(calls)) {
    const value = call()
    assert.equal(isThenable(value), true, `${name}() 应返回 Promise，实际是 ${Object.prototype.toString.call(value)}`)
    await value.catch(() => undefined)
  }
  // 宿主 line 2853 的原样写法：同步值在这里会抛 TypeError
  const status = await adapter.status({}).catch((error) => ({ healthy: false, error: String(error) }))
  assert.equal(status.healthy, true)
  // 宿主 line 3103 的原样写法：discover 必须是 thenable
  assert.deepEqual(await adapter.discover({}), [])
})

await check('status：空库健康，统计形状正确', async () => {
  const status = await adapter.status({})
  assert.equal(status.healthy, true)
  assert.equal(status.stats.totalInsights, 0)
  assert.equal(typeof status.stats.dbSizeBytes, 'number')
  assert.ok(status.stats.byCategory)
})

const emptySpaces = await adapter.discover({})
const seededStore = readStore(dir)
upsertExperience(seededStore, { intent: '做一个研学课PPT', action: '先定主题色', outcome: 'success', type: 'PPT / 课件' })
writeStore(dir, seededStore)
const spaces = await adapter.discover({})

await check('discover：空库不返回空间；有数据时返回「经验库」', () => {
  assert.deepEqual(emptySpaces, [])
  assert.equal(spaces.length, 1)
  assert.equal(spaces[0].externalId, 'exp-lib')
  assert.equal(spaces[0].name, SPACE_NAME)
  assert.equal(spaces[0].description, SPACE_DESCRIPTION)
})

await check('remember：拒收并提示用 exp_record', async () => {
  await assert.rejects(() => adapter.remember({}, { content: '随便一条' }), /exp_record/)
})

await check('search：非空查询返回 JitRL 排序结果，带 score 与提示', async () => {
  const store = readStore(dir)
  upsertExperience(store, { intent: '做一个研学课PPT', action: '先排版再调色', outcome: 'partial', type: 'PPT / 课件' })
  writeStore(dir, store)
  const out = await adapter.search({}, { query: '做研学课PPT', limit: 5 })
  assert.ok(out.results.length >= 1)
  assert.ok(out.results[0].content.includes('PPT'))
  assert.equal(typeof out.results[0].score, 'number')
  assert.ok(out.hint.includes('JitRL'))
})

await check('list：按 query 过滤，返回 Insight 形状', async () => {
  const items = await adapter.list({}, { query: '研学课', limit: 10 })
  assert.ok(items.length >= 1)
  for (const item of items) {
    assert.equal(typeof item.id, 'string')
    assert.equal(typeof item.content, 'string')
    assert.ok(Array.isArray(item.tags))
    assert.ok(Array.isArray(item.entities))
  }
})

await check('graph：节点与取代边可用', async () => {
  const graph = await adapter.graph({})
  assert.ok(graph.nodes.length >= 1)
  assert.ok(Array.isArray(graph.edges))
  assert.ok(typeof graph.generatedAt === 'string')
})

await check('entityIndex：实体索引完整', async () => {
  const index = await adapter.entityIndex({})
  assert.equal(index.complete, true)
  assert.ok(Array.isArray(index.memories))
})

await check('forget：软删后状态与检索都排除', async () => {
  const store = readStore(dir)
  const target = store.experiences.find((item) => !item.deleted_at && !item.superseded_by)
  await adapter.forget({}, target.id)
  const after = await adapter.status({})
  assert.equal(after.stats.deletedInsights, 1)
  const out = await adapter.search({}, { query: '做研学课PPT', limit: 5 })
  assert.equal(out.results.some((item) => item.id === target.id), false)
})

await check('create 时清理过期墓碑', async () => {
  const stale = readStore(dir)
  stale.experiences.push({
    id: 'ex_stale', ts: new Date().toISOString(), lastSeenAt: new Date().toISOString(), hits: 1,
    intent: '旧经验', action: '旧做法', state: { tokens: ['旧'], cgrams: [], artifacts: [], actions: [] },
    step_rewards: [0], G: 0, outcome: 'unknown', note: '', origin: 'manual',
    typeId: 'ty_other', typeName: '未分类',
    deleted_at: new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString(), superseded_by: null,
  })
  writeStore(dir, stale)
  const before = readStore(dir).experiences.some((item) => item.id === 'ex_stale')
  assert.equal(before, true)
  buildProvider(sdk, { dataDir: dir, tombstoneDays: 30 }).create({ configuration: { dataDir: dir } })
  const after = readStore(dir).experiences.some((item) => item.id === 'ex_stale')
  assert.equal(after, false)
})

await check('宿主没传配置时，从祖先目录 .mnemon 找到服务设置的数据目录', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-provider-root-'))
  const expDir = path.join(root, '.exp')
  fs.mkdirSync(path.join(root, '.mnemon', 'state'), { recursive: true })
  fs.mkdirSync(expDir, { recursive: true })
  fs.writeFileSync(path.join(root, '.mnemon', 'state', 'memory-providers.json'), JSON.stringify({
    services: { 'exp-lib': { dataDir: expDir } },
  }), 'utf8')
  const store = readStore(expDir)
  upsertExperience(store, { intent: '祖先目录定位测试', action: '读服务设置', outcome: 'success' })
  writeStore(expDir, store)
  const def2 = buildProvider(sdk, { dataDir: path.join(root, '插件', '经验库', 'provider-data') })
  const adapter2 = def2.create({ configuration: {} })
  const items = await adapter2.list({}, { limit: 10 })
  assert.ok(items.some((item) => item.content.includes('祖先目录定位测试')))
  fs.rmSync(root, { recursive: true, force: true })
})

try {
  fs.rmSync(dir, { recursive: true, force: true })
} catch {}

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
