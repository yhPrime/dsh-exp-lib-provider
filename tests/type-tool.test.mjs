/**
 * exp_type 管理工具测试：list / create / rename / merge / delete。
 * Run: node tests/type-tool.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { buildTools } from '../tools.js'
import { readStore, upsertExperience, writeStore } from '../store.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-type-tool-'))
const defineTool = (definition) => definition
const typeTool = buildTools(defineTool, { dataDir: dir }).find((tool) => tool.name === 'exp_type')
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

// 先造几条经验与类型
const seed = readStore(dir)
upsertExperience(seed, { intent: '做研学课PPT', action: '先定主题色', type: '研学课件', typeDescription: '研学课课件制作' })
upsertExperience(seed, { intent: '写教案', action: '先列目标', type: '研学教案', typeDescription: '研学课教案' })
upsertExperience(seed, { intent: '再做个PPT', action: '复用模板', type: '研学课件' })
writeStore(dir, seed)

check('tool 存在且参数形状正确', () => {
  assert.ok(typeTool)
  assert.equal(typeTool.parameters.action.required, true)
  assert.ok(Array.isArray(typeTool.parameters.action.enum))
})

check('list：返回类型与使用条数，system 排最后', () => {
  const out = typeTool.execute({ action: 'list' })
  assert.ok(out.types.length >= 3)
  const course = out.types.find((type) => type.name === '研学课件')
  assert.equal(course.count, 2)
  assert.equal(out.types.at(-1).name, '未分类')
  assert.equal(out.typeCount, 2)
})

check('create：新建类型，重复名报错', () => {
  const out = typeTool.execute({ action: 'create', name: '研学流程', description: '研学活动流程' })
  assert.equal(out.created, '研学流程')
  assert.equal(out.typeCount, 3)
  assert.throws(() => typeTool.execute({ action: 'create', name: '研学流程' }), /已存在/)
})

check('rename：改名并同步经验引用', () => {
  const out = typeTool.execute({ action: 'rename', name: '研学流程', newName: '研学流程设计' })
  assert.equal(out.from, '研学流程')
  assert.equal(out.to, '研学流程设计')
  const store = readStore(dir)
  assert.ok(store.types.some((type) => type.name === '研学流程设计'))
})

check('merge：经验批量改挂到目标，源类型删除', () => {
  const out = typeTool.execute({ action: 'merge', names: ['研学教案'], newName: '研学课件' })
  assert.equal(out.target, '研学课件')
  assert.ok(out.moved >= 1)
  const store = readStore(dir)
  assert.equal(store.types.some((type) => type.name === '研学教案'), false)
  const lesson = store.experiences.find((item) => item.intent === '写教案')
  assert.equal(lesson.typeName, '研学课件')
})

check('delete：经验归未分类，系统类型不可删', () => {
  const out = typeTool.execute({ action: 'delete', name: '研学流程设计' })
  assert.equal(out.deleted, '研学流程设计')
  const store = readStore(dir)
  assert.equal(store.types.some((type) => type.name === '研学流程设计'), false)
  assert.throws(() => typeTool.execute({ action: 'delete', name: '未分类' }), /系统类型/)
})

check('异常：未知动作 / 未知类型', () => {
  assert.throws(() => typeTool.execute({ action: 'explode' }), /不支持/)
  assert.throws(() => typeTool.execute({ action: 'delete', name: '不存在' }), /没有这个类型/)
})

try {
  fs.rmSync(dir, { recursive: true, force: true })
} catch {}

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
