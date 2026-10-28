/**
 * Provider 契约测试：manifest / adapter 方法形状（stub SDK + 临时目录）。
 * Run: node tests/provider.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { buildProvider } from '../provider.js'
import { SPACE_DESCRIPTION, SPACE_NAME, readStore, storeFile, upsertExperience, writeStore } from '../store.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-provider-'))
const sdk = {
  apiVersion: 'dsh-mnemon.memory-space-provider/v1',
  defineMemorySpaceProviderDefinition: (definition) => definition,
}
const definition = buildProvider(sdk, { dataDir: dir })
const adapter = definition.create({ configuration: { dataDir: dir } })
let passed = 0
let failed = 0

function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}`)
    console.log(`       ${error && error.message ? error.message : error}`)
  }
}

check('manifest：provider 契约字段与能力位', () => {
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

check('status：空库健康，统计形状正确', () => {
  const status = adapter.status({})
  assert.equal(status.healthy, true)
  assert.equal(status.stats.totalInsights, 0)
  assert.equal(typeof status.stats.dbSizeBytes, 'number')
  assert.ok(status.stats.byCategory)
})

check('discover：空库不返回空间；有数据时返回「经验库」', () => {
  assert.deepEqual(adapter.discover({}), [])
  const store = readStore(dir)
  upsertExperience(store, { intent: '做一个研学课PPT', action: '先定主题色', outcome: 'success', type: 'PPT / 课件' })
  writeStore(dir, store)
  const spaces = adapter.discover({})
  assert.equal(spaces.length, 1)
  assert.equal(spaces[0].externalId, 'exp-lib')
  assert.equal(spaces[0].name, SPACE_NAME)
  assert.equal(spaces[0].description, SPACE_DESCRIPTION)
})

check('remember：拒收并提示用 exp_record', () => {
  assert.throws(() => adapter.remember({}, { content: '随便一条' }), /exp_record/)
})

check('search：非空查询返回 JitRL 排序结果，带 score 与提示', () => {
  const store = readStore(dir)
  upsertExperience(store, { intent: '做一个研学课PPT', action: '先排版再调色', outcome: 'partial', type: 'PPT / 课件' })
  writeStore(dir, store)
  const out = adapter.search({}, { query: '做研学课PPT', limit: 5 })
  assert.ok(out.results.length >= 1)
  assert.ok(out.results[0].content.includes('PPT'))
  assert.equal(typeof out.results[0].score, 'number')
  assert.ok(out.hint.includes('JitRL'))
})

check('list：按 query 过滤，返回 Insight 形状', () => {
  const items = adapter.list({}, { query: '研学课', limit: 10 })
  assert.ok(items.length >= 1)
  for (const item of items) {
    assert.equal(typeof item.id, 'string')
    assert.equal(typeof item.content, 'string')
    assert.ok(Array.isArray(item.tags))
    assert.ok(Array.isArray(item.entities))
  }
})

check('graph：节点与取代边可用', () => {
  const graph = adapter.graph({})
  assert.ok(graph.nodes.length >= 1)
  assert.ok(Array.isArray(graph.edges))
  assert.ok(typeof graph.generatedAt === 'string')
})

check('entityIndex：实体索引完整', () => {
  const index = adapter.entityIndex({})
  assert.equal(index.complete, true)
  assert.ok(Array.isArray(index.memories))
})

check('forget：软删后状态与检索都排除', () => {
  const store = readStore(dir)
  const target = store.experiences.find((item) => !item.deleted_at && !item.superseded_by)
  adapter.forget({}, target.id)
  const after = adapter.status({})
  assert.equal(after.stats.deletedInsights, 1)
  const out = adapter.search({}, { query: '做研学课PPT', limit: 5 })
  assert.equal(out.results.some((item) => item.id === target.id), false)
})

check('create 时清理过期墓碑', () => {
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

try {
  fs.rmSync(dir, { recursive: true, force: true })
} catch {}

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
