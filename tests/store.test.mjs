/**
 * 存储语义测试：upsert 三分支、软删墓碑、过滤、排序、观测数据。
 * Run: node tests/store.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  dataDirFromProviderState,
  forgetExperience,
  graphSnapshot,
  listInsights,
  purgeTombstones,
  rankExperiences,
  readStore,
  statsOf,
  upsertExperience,
  visibleExperiences,
  writeStore,
} from '../store.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-provider-store-'))
const store = readStore(dir)
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

const INTENT = '制作一个研学课的六页PPT并导出成演示文稿'
const actionA = '先定主题色再排版'
const actionB = '先排版再统一调色'

check('新增：第一条写入是 added', () => {
  const result = upsertExperience(store, { intent: INTENT, action: actionA, outcome: 'success', type: 'PPT / 课件', note: '红色党政风' })
  assert.equal(result.action, 'added')
  assert.equal(store.experiences.length, 1)
  assert.equal(result.experience.hits, 1)
  assert.equal(result.experience.G, 1)
  assert.equal(result.experience.typeName, 'PPT / 课件')
})

check('重复：同意图同做法 → 就地更新，hits+1，不新增行', () => {
  const result = upsertExperience(store, { intent: INTENT, action: actionA, outcome: 'partial', note: '第二次' })
  assert.equal(result.action, 'updated')
  assert.equal(store.experiences.length, 1)
  assert.equal(result.experience.hits, 2)
  assert.equal(result.experience.outcome, 'partial')
  assert.equal(result.experience.G, 0.3)
})

check('近似替换：同类型不同做法 → 新条 + 旧条 superseded_by', () => {
  const result = upsertExperience(store, { intent: INTENT, action: actionB, outcome: 'success', type: 'PPT / 课件' })
  assert.equal(result.action, 'superseded')
  assert.equal(store.experiences.length, 2)
  const old = store.experiences.find((item) => item.action === actionA)
  assert.equal(old.superseded_by, result.experience.id)
  assert.equal(result.experience.supersedes, old.id)
})

check('过滤：可见经验排除已被取代的旧条', () => {
  const visible = visibleExperiences(store)
  assert.equal(visible.length, 1)
  assert.equal(visible[0].action, actionB)
})

check('排序：只对可见经验排序，返回优势/置信度/证据', () => {
  const ranked = rankExperiences(store, INTENT, 5)
  assert.ok(ranked.candidates.length >= 1)
  const top = ranked.candidates[0]
  assert.equal(top.action, actionB)
  assert.equal(typeof top.advantage, 'number')
  assert.equal(typeof top.confidence, 'number')
  assert.ok(top.evidence.length >= 1)
  assert.equal(top.evidence[0].intent, INTENT)
})

check('软删：forget 后不可见但仍在文件里', () => {
  const target = store.experiences.find((item) => !item.deleted_at && !item.superseded_by)
  assert.ok(forgetExperience(store, target.id))
  assert.equal(visibleExperiences(store).length, 0)
  assert.equal(store.experiences.length, 2)
  assert.equal(store.experiences.filter((item) => item.deleted_at).length, 1)
})

check('墓碑 TTL：过期的软删行被物理清理', () => {
  const stale = store.experiences.find((item) => item.deleted_at)
  stale.deleted_at = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString()
  const removed = purgeTombstones(store, 30)
  assert.equal(removed, 1)
  assert.equal(store.experiences.some((item) => item.id === stale.id), false)
})

check('观测：listInsights / graph / stats 形状正确', () => {
  upsertExperience(store, { intent: '做一节课的任务卡', action: 'task-card-builder', outcome: 'success', type: '文档 / 教案' })
  const insights = listInsights(store, { limit: 10 })
  assert.ok(insights.length >= 1)
  assert.ok(typeof insights[0].content === 'string' && insights[0].content.includes('任务卡'))
  assert.ok(Array.isArray(insights[0].entities))

  const graph = graphSnapshot(store)
  assert.ok(graph.nodes.length >= 1)
  assert.ok(Array.isArray(graph.edges))

  const stats = statsOf(store, dir)
  assert.ok(stats.totalInsights >= 1)
  assert.equal(typeof stats.dbSizeBytes, 'number')
  assert.ok(stats.byCategory['文档 / 教案'] >= 1)
})

check('持久化：writeStore 后 readStore 内容一致', () => {
  writeStore(dir, store)
  const again = readStore(dir)
  assert.equal(again.experiences.length, store.experiences.length)
  assert.ok(again.types.length >= 1)
})

check('类型不预设：按需自动创建 + 近似合并 + 泛化名 + 上限 + 每日上限', () => {
  const d1 = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-types-'))
  const s1 = readStore(d1)
  assert.equal(s1.types.length, 1)
  assert.equal(s1.types[0].name, '未分类')

  const created = upsertExperience(s1, { intent: '做研学课', action: '先定主题色', type: '研学课设计', typeDescription: '研学课教案与流程' })
  assert.equal(created.type.created, true)
  assert.equal(created.experience.typeName, '研学课设计')
  assert.equal(s1.types.filter((type) => type.system !== true).length, 1)

  const exact = upsertExperience(s1, { intent: '做研学课', action: '先定主题色', type: '研学课设计' })
  assert.equal(exact.type.created, false)

  const near = upsertExperience(s1, { intent: '做研学课', action: '先写大纲', type: '研学课设计方法' })
  assert.equal(near.type.created, false)
  assert.equal(near.type.mergedInto, '研学课设计')

  const generic = upsertExperience(s1, { intent: '随便做点', action: '试试', type: '其他' })
  assert.equal(generic.experience.typeName, '未分类')
  assert.equal(generic.type.created, false)

  const capped = readStore(fs.mkdtempSync(path.join(os.tmpdir(), 'exp-types-cap-')))
  upsertExperience(capped, { intent: '任务一', action: '做法一', type: 'PPT制作' }, { maxTypes: 1 })
  const over = upsertExperience(capped, { intent: '任务二', action: '做法二', type: '代码插件' }, { maxTypes: 1 })
  assert.equal(over.type.created, false)
  assert.equal(over.type.rejected, 'limit')
  assert.equal(over.experience.typeName, '未分类')

  const rated = readStore(fs.mkdtempSync(path.join(os.tmpdir(), 'exp-types-rate-')))
  upsertExperience(rated, { intent: '任务一', action: '做法一', type: 'PPT制作' }, { maxTypes: 10, newTypesPerDay: 1 })
  const rate = upsertExperience(rated, { intent: '任务二', action: '做法二', type: '代码插件' }, { maxTypes: 10, newTypesPerDay: 1 })
  assert.equal(rate.type.created, false)
  assert.equal(rate.type.rejected, 'rate')

  for (const temp of [d1]) fs.rmSync(temp, { recursive: true, force: true })
})

check('跟随配置：从记忆插件状态里读 Provider 数据目录', () => {
  const stateFile = path.join(dir, 'memory-providers.json')
  fs.writeFileSync(stateFile, JSON.stringify({ services: { 'exp-lib': { dataDir: path.join(dir, 'from-state') } } }), 'utf8')
  const resolved = dataDirFromProviderState({ providerStateFile: stateFile, mnemonDataDir: path.join(dir, 'none') })
  assert.equal(resolved, path.join(dir, 'from-state'))
})

try {
  fs.rmSync(dir, { recursive: true, force: true })
} catch {}

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
