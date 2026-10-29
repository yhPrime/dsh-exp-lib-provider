/**
 * 工具测试：exp_record / exp_recall 与 Provider 共用同一文件与语义。
 * Run: node tests/tools.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { buildTools } from '../tools.js'
import { buildProvider } from '../provider.js'
import { readStore, storeFile } from '../store.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-provider-tools-'))
const defineTool = (definition) => definition
const tools = buildTools(defineTool, { dataDir: dir })
const record = tools.find((tool) => tool.name === 'exp_record')
const recall = tools.find((tool) => tool.name === 'exp_recall')
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

await check('两个工具都注册，参数 schema 完整', () => {
  assert.ok(record && recall)
  assert.equal(record.parameters.intent.required, true)
  assert.equal(record.parameters.action.required, true)
  assert.equal(recall.parameters.intent.required, true)
  assert.equal(typeof record.execute, 'function')
  assert.equal(typeof recall.execute, 'function')
})

await check('exp_record：首次写入 added，落盘到 exp-lib.json', () => {
  const out = record.execute({ intent: '制作研学课六页PPT', action: '先定主题色再排版', outcome: 'success', type: 'PPT / 课件', note: '红色党政风' })
  assert.equal(out.action, 'added')
  assert.equal(out.hits, 1)
  assert.equal(out.typeName, 'PPT / 课件')
  assert.equal(out.count, 1)
  assert.ok(fs.existsSync(storeFile(dir)))
})

await check('exp_record：重复写入就地更新 hits', () => {
  const out = record.execute({ intent: '制作研学课六页PPT', action: '先定主题色再排版', outcome: 'accepted' })
  assert.equal(out.action, 'updated')
  assert.equal(out.hits, 2)
  assert.equal(out.count, 1)
  assert.equal(readStore(dir).experiences.length, 1)
})

await check('exp_record：不同做法 → 新条 + 旧条 superseded', () => {
  const out = record.execute({ intent: '制作研学课六页PPT', action: '先排版再统一调色', outcome: 'partial', type: 'PPT / 课件' })
  assert.equal(out.action, 'superseded')
  assert.ok(out.supersededId)
  const store = readStore(dir)
  assert.equal(store.experiences.length, 2)
  assert.ok(store.experiences.some((item) => item.superseded_by === out.id))
})

await check('exp_recall：返回排序、过滤旧条、带证据', () => {
  const out = recall.execute({ intent: '制作研学课六页PPT', limit: 5 })
  assert.ok(out.candidates.length >= 1)
  assert.equal(out.candidates[0].action, '先排版再统一调色')
  assert.ok(out.candidates[0].evidence.length >= 1)
  assert.equal(out.candidates[0].evidence[0].intent, '制作研学课六页PPT')
})

await check('exp_recall 与 Provider 读同一文件、同一语义', async () => {
  const sdk = {
    apiVersion: 'dsh-mnemon.memory-space-provider/v1',
    defineMemorySpaceProviderDefinition: (definition) => definition,
  }
  const adapter = buildProvider(sdk, { dataDir: dir }).create({ configuration: { dataDir: dir } })
  // Provider 的 search 是 async（契约要求 Promise），这里必须 await
  const providerResults = (await adapter.search({}, { query: '制作研学课六页PPT', limit: 5 })).results
  const toolOut = recall.execute({ intent: '制作研学课六页PPT', limit: 5 })
  assert.ok(providerResults.length >= 1)
  assert.equal(providerResults[0].id, toolOut.candidates[0].evidence[0].id)
})

await check('工具跟随配置：Provider 状态里的数据目录优先于插件配置', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-provider-state-'))
  const stateDataDir = path.join(stateDir, 'data')
  const stateFile = path.join(stateDir, 'memory-providers.json')
  fs.writeFileSync(stateFile, JSON.stringify({ services: { 'exp-lib': { dataDir: stateDataDir } } }), 'utf8')
  const followTools = buildTools(defineTool, { dataDir: dir, providerStateFile: stateFile })
  const followRecord = followTools.find((tool) => tool.name === 'exp_record')
  const followRecall = followTools.find((tool) => tool.name === 'exp_recall')
  followRecord.execute({ intent: '跟随配置测试', action: '读状态文件', outcome: 'success' })
  assert.ok(fs.existsSync(path.join(stateDataDir, 'exp-lib.json')), '应写到状态文件指定的目录')
  const out = followRecall.execute({ intent: '跟随配置测试', limit: 3 })
  assert.ok(out.candidates.length >= 1)
  fs.rmSync(stateDir, { recursive: true, force: true })
})

try {
  fs.rmSync(dir, { recursive: true, force: true })
} catch {}

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
