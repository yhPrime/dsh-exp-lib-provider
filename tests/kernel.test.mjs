/**
 * Kernel parity: the JS port must reproduce the Python reference core.
 *
 * The fixture is generated from `经验库/exp-lib/scripts/jitrl_memory.py` by
 * `tests/tools/gen-golden.py`; Python exposes 4-decimal numbers, so numbers are compared
 * with a 2e-4 tolerance while structure, ordering and flags must match exactly.
 *
 * Run with the bundled Node: node tests/kernel.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'

import {
  DEFAULT_ALPHA,
  DEFAULT_GAMMA,
  abstractState,
  estimateAdvantages,
  estimateActionValue,
  retrieve,
} from '../kernel.js'

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/golden-advantages.json', import.meta.url), 'utf8'))
const TOLERANCE = 2e-4
/**
 * `advantage_norm` divides by the largest absolute advantage, which in these fixtures is
 * ~0.13 — so a 1e-4 difference at the 4th decimal (banker's vs half-up rounding) becomes
 * ~8e-4 here. `rank_score` multiplies by a confidence in [0.5, 1], so it stays tight.
 */
const RATIO_TOLERANCE = 2e-3

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

function close(actual, expected, where) {
  const left = Number(actual)
  const right = Number(expected)
  if (Math.abs(left - right) > TOLERANCE) {
    throw new Error(`${where}: ${left} vs ${right} (diff ${Math.abs(left - right)})`)
  }
}

/** Same as `close`, for ratios that amplify a 4th-decimal rounding difference. */
function closeRatio(actual, expected, where) {
  const left = Number(actual)
  const right = Number(expected)
  if (Math.abs(left - right) > RATIO_TOLERANCE) {
    throw new Error(`${where}: ${left} vs ${right} (diff ${Math.abs(left - right)})`)
  }
}

/* ---------------------------------------------------------------- states --- */

check('状态抽象与 Python 逐字段一致（tokens / cgrams / artifacts / actions）', () => {
  assert.ok(fixture.texts.length > 0)
  for (const { text, state } of fixture.texts) {
    const js = abstractState(text)
    assert.deepEqual(js.tokens, state.tokens, `tokens: ${text}`)
    assert.deepEqual(js.cgrams, state.cgrams, `cgrams: ${text}`)
    assert.deepEqual(js.artifacts, state.artifacts, `artifacts: ${text}`)
    assert.deepEqual(js.actions, state.actions, `actions: ${text}`)
  }
})

/* ----------------------------------------------------------- advantages --- */

check('黄金样例来自本地 fixture，且规模符合预期', () => {
  assert.equal(fixture.reference, 'jitrl_memory.py')
  assert.equal(fixture.gamma, DEFAULT_GAMMA)
  assert.ok(fixture.experiences.length >= 20, `experiences=${fixture.experiences.length}`)
  assert.ok(fixture.cases.length >= 10, `cases=${fixture.cases.length}`)
  assert.ok(fixture.cases.some((item) => item.k !== 8), '应有不同 k 的样例')
})

for (const testCase of fixture.cases) {
  const label = `优势估计对齐：${testCase.intent}（k=${testCase.k}）`

  check(label, () => {
    const options = {
      k: testCase.k,
      alpha: testCase.alpha,
      candidateActions: testCase.candidateActions === null ? undefined : testCase.candidateActions,
    }
    const js = estimateAdvantages(fixture.experiences, testCase.intent, options)
    const py = testCase.expected

    assert.equal(js.neighbor_count, py.neighbor_count, 'neighbor_count')
    close(js.V, py.V, 'V')
    close(js.k, py.k, 'k')
    close(js.alpha, py.alpha, 'alpha')

    assert.equal(js.neighbors.length, py.neighbors.length, 'neighbors.length')
    js.neighbors.forEach((entry, index) => {
      const expected = py.neighbors[index]
      assert.equal(entry.id, expected.id, `neighbors[${index}].id`)
      assert.equal(entry.action, expected.action, `neighbors[${index}].action`)
      close(entry.G, expected.G, `neighbors[${index}].G`)
      close(entry.similarity, expected.similarity, `neighbors[${index}].similarity`)
    })

    assert.equal(js.candidates.length, py.candidates.length, 'candidates.length')
    js.candidates.forEach((entry, index) => {
      const expected = py.candidates[index]
      const at = `candidates[${index}] (${entry.action})`
      assert.equal(entry.action, expected.action, `${at}.action`)
      assert.equal(entry.unverified, expected.unverified, `${at}.unverified`)
      assert.equal(entry.support, expected.support, `${at}.support`)
      close(entry.Q, expected.Q, `${at}.Q`)
      close(entry.V, expected.V, `${at}.V`)
      close(entry.advantage, expected.advantage, `${at}.advantage`)
      closeRatio(entry.advantage_norm, expected.advantage_norm, `${at}.advantage_norm`)
      close(entry.confidence, expected.confidence, `${at}.confidence`)
      close(entry.mean_similarity, expected.mean_similarity, `${at}.mean_similarity`)
      closeRatio(entry.rank_score, expected.rank_score, `${at}.rank_score`)
      assert.equal(entry.evidence.length, expected.evidence.length, `${at}.evidence.length`)
      entry.evidence.forEach((item, position) => {
        const evidence = expected.evidence[position]
        assert.equal(item.id, evidence.id, `${at}.evidence[${position}].id`)
        close(item.G, evidence.G, `${at}.evidence[${position}].G`)
        close(item.similarity, evidence.similarity, `${at}.evidence[${position}].similarity`)
      })
    })
  })
}

/* ------------------------------------------------------------- behaviour --- */

check('未验证做法被标 unverified，且置信度折减', () => {
  const testCase = fixture.cases.find((item) => (item.candidateActions || []).includes('brand-new-action'))
  assert.ok(testCase, 'fixture 里应有含未见做法的样例')
  const js = estimateAdvantages(fixture.experiences, testCase.intent, {
    k: testCase.k,
    alpha: testCase.alpha,
    candidateActions: testCase.candidateActions,
  })
  const unseen = js.candidates.filter((item) => item.unverified)
  assert.ok(unseen.length > 0, '样例里应至少有一个没历史证据的候选做法')
  for (const item of unseen) {
    assert.equal(item.support, 0)
    assert.ok(item.confidence < 0.6, `未验证做法的置信度应被折减：${item.confidence}`)
  }
})

check('乐观估计有封顶：未验证做法的优势不超过已验证最大优势 × 0.9（Q̂ 层面）', () => {
  const testCase = fixture.cases.find((item) => (item.candidateActions || []).includes('brand-new-action'))
  const neighbors = retrieve(fixture.experiences, testCase.intent, { k: testCase.k })
  const js = estimateAdvantages(fixture.experiences, testCase.intent, {
    k: testCase.k,
    alpha: testCase.alpha,
    candidateActions: testCase.candidateActions,
  })
  const verified = js.candidates.filter((item) => !item.unverified)
  const unseen = js.candidates.find((item) => item.unverified)
  assert.ok(verified.length > 0, '该样例应有已验证候选')
  assert.ok(unseen, '该样例应有未验证候选')
  const bestVerifiedAdvantage = Math.max(...verified.map((item) => item.advantage))
  const estimate = estimateActionValue(unseen.action, neighbors, testCase.alpha)
  const value = js.V
  assert.ok(
    estimate.q - value <= Math.max(bestVerifiedAdvantage * 0.9, 0) + TOLERANCE,
    `封顶失效：${estimate.q - value} > ${bestVerifiedAdvantage * 0.9}`,
  )
})

check('空库不抛错：无邻居时 V̂ 为 0，候选按乐观值排', () => {
  const result = estimateAdvantages([], '做个新东西', { candidateActions: ['a', 'b'], k: 8, alpha: DEFAULT_ALPHA })
  assert.equal(result.neighbor_count, 0)
  assert.equal(result.V, 0)
  assert.equal(result.candidates.length, 2)
  assert.ok(result.candidates.every((item) => item.unverified))
})

check('同一输入两次调用结果一致（纯函数、无隐藏状态）', () => {
  const first = estimateAdvantages(fixture.experiences, fixture.cases[0].intent, { k: 8 })
  const second = estimateAdvantages(fixture.experiences, fixture.cases[0].intent, { k: 8 })
  assert.deepEqual(second, first)
})

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
