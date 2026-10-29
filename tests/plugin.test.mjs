/**
 * DSH 插件入口测试：apply 注册工具（直接 ctx.tools 或经 inject 回退），不依赖宿主 SDK。
 * Run: node tests/plugin.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-provider-plugin-'))
const mod = await import('../plugin.js')
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

function ctxWithTools(registered) {
  return { tools: { register: (tool) => registered.push(tool) } }
}

await check('插件入口：name / inject / apply 存在', () => {
  assert.equal(mod.name, 'dsh-exp-lib-provider')
  assert.deepEqual(mod.inject, ['tools', 'systemPrompt'])
  assert.equal(typeof mod.apply, 'function')
})

await check('apply：ctx.tools 直接注册 exp_record 与 exp_recall', async () => {
  const registered = []
  await mod.apply(ctxWithTools(registered), { dataDir: dir })
  assert.deepEqual(registered.map((tool) => tool.name).sort(), ['exp_recall', 'exp_record'])
  assert.ok(registered.every((tool) => typeof tool.execute === 'function'))
})

await check('apply：没有 ctx.tools 时经 inject 回退注册', async () => {
  const registered = []
  const sections = []
  const ctx = {
    inject(deps, cb) {
      if (deps.includes('tools')) cb({ tools: { register: (tool) => registered.push(tool) } })
      if (deps.includes('systemPrompt')) cb({ systemPrompt: { section: (section) => sections.push(section) } })
    },
  }
  await mod.apply(ctx, { dataDir: dir })
  assert.deepEqual(registered.map((tool) => tool.name).sort(), ['exp_recall', 'exp_record'])
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'exp-lib')
})

await check('每轮提示：renderHint 含类型目录且有长度上限', async () => {
  const { renderHint } = await import('../store.js')
  const hint = renderHint({ dataDir: dir, providerStateFile: path.join(dir, 'none.json'), mnemonDataDir: path.join(dir, 'none') })
  assert.ok(hint.includes('PPT / 课件'))
  assert.ok(hint.includes('exp_recall'))
  assert.ok(hint.length <= 900)
})

await check('apply：工具写读同一 dataDir', async () => {
  const registered = []
  await mod.apply(ctxWithTools(registered), { dataDir: dir })
  const record = registered.find((tool) => tool.name === 'exp_record')
  const recall = registered.find((tool) => tool.name === 'exp_recall')
  record.execute({ intent: '做一份任务卡', action: 'task-card-builder', outcome: 'success', type: '文档 / 教案' })
  const out = recall.execute({ intent: '做一份任务卡', limit: 3 })
  assert.ok(out.candidates.length >= 1)
  assert.ok(fs.existsSync(path.join(dir, 'exp-lib.json')))
})

try {
  fs.rmSync(dir, { recursive: true, force: true })
} catch {}

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
