#!/usr/bin/env node
/**
 * 簇路由离线评估：跑标定集，输出 hit@1、回退正确率、分数余量。
 *
 *   node tools/eval-routing.mjs [--fixture tests/fixtures/labeled-intents.json] [--data-dir <dir>] [--min-score 0.18]
 *
 * 退出码：0 = hit@1 ≥ 0.75 且余量 ≥ 0.10；1 = 不达标（G1 闸门）。
 * 只读，不写真实库。
 */
import fs from 'node:fs'
import path from 'node:path'

import { ROUTE_MIN_SCORE, routeCluster } from '../cluster.js'
import { readStore, resolveToolDataDir } from '../store.js'

/** 解析 `--flag value` 形式的参数。 */
function parseArgs(argv) {
  const out = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next
      index += 1
    } else {
      out[key] = true
    }
  }
  return out
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const fixturePath = path.resolve(String(args.fixture || 'tests/fixtures/labeled-intents.json'))
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'))
  const dataDir = path.resolve(String(args['data-dir'] || resolveToolDataDir({})))
  const minScore = Number(args['min-score'] || ROUTE_MIN_SCORE)
  const store = readStore(dataDir)
  const cases = Array.isArray(fixture.cases) ? fixture.cases : []

  console.log(`路由评估：${cases.length} 条标定集｜库 ${dataDir}`)
  console.log(`簇 ${store.clusters.length}｜有经验的簇 ${store.clusters.filter((cluster) => cluster.stats.count > 0).length}｜门槛 ${minScore}`)
  console.log(`标定集阈值字段 ${fixture.thresholdAtCalibration ?? '-'}（与 --min-score 一致才算复算）`)
  console.log('')

  let correct = 0
  let routedCorrect = 0
  let routedWrong = 0
  let fallbackExpected = 0
  let fallbackHit = 0
  let fallbackMaxScore = 0
  let correctMinScore = Infinity
  const misses = []

  for (const item of cases) {
    const route = routeCluster(store, item.intent, { minScore })
    if (item.expectFallback === true) {
      fallbackExpected += 1
      if (route.fallback) {
        correct += 1
        fallbackHit += 1
        fallbackMaxScore = Math.max(fallbackMaxScore, route.score)
        console.log(`  √ 回退 ${route.score.toFixed(3)}  ${item.intent}`)
      } else {
        misses.push({ intent: item.intent, why: `应回退，实际路由到 ${route.name}(${route.score.toFixed(3)})` })
        console.log(`  × 回退 ${route.score.toFixed(3)}  ${item.intent} → ${route.name}`)
      }
      continue
    }
    const expected = Array.isArray(item.expected) ? item.expected : []
    const hit = route.fallback === false && expected.includes(route.name)
    if (hit) {
      correct += 1
      routedCorrect += 1
      correctMinScore = Math.min(correctMinScore, route.score)
      console.log(`  √ 路由 ${route.score.toFixed(3)}  ${item.intent} → ${route.name}`)
    } else {
      if (route.fallback === false) routedWrong += 1
      misses.push({ intent: item.intent, why: route.fallback ? `应路由到 ${expected.join('/')}，实际回退(${route.score.toFixed(3)})` : `路由到 ${route.name}，期望 ${expected.join('/')}` })
      console.log(`  × ${route.fallback ? '回退' : '路由'} ${route.score.toFixed(3)}  ${item.intent} → ${route.fallback ? '(无)' : route.name}`)
    }
  }

  const hitAt1 = cases.length === 0 ? 0 : correct / cases.length
  const margin = Number.isFinite(correctMinScore) && routedCorrect > 0 ? correctMinScore - fallbackMaxScore : 0

  console.log('')
  console.log(`hit@1 ${(hitAt1 * 100).toFixed(1)}%（${correct}/${cases.length}）`)
  console.log(`路由正确 ${routedCorrect}｜路由错误 ${routedWrong}｜回退正确 ${fallbackHit}/${fallbackExpected}`)
  console.log(`正确路由最低分 ${Number.isFinite(correctMinScore) ? correctMinScore.toFixed(3) : '-'}｜回退最高分 ${fallbackMaxScore.toFixed(3)}｜余量 ${margin.toFixed(3)}`)
  if (misses.length > 0) {
    console.log('')
    console.log(`未命中 ${misses.length} 条：`)
    for (const miss of misses) console.log(`  - ${miss.intent}：${miss.why}`)
  }

  const ok = hitAt1 >= 0.75 && routedWrong === 0 && fallbackHit === fallbackExpected && correctMinScore > fallbackMaxScore
  console.log('')
  console.log(ok
    ? `结论：通过 G1（hit@1 ≥0.75、误路由 0、回退全对、正确最低分 > 回退最高分）`
    : `结论：未过 G1（要求 hit@1 ≥0.75、误路由 0、回退全对、正确最低分 > 回退最高分；当前 hit ${(hitAt1 * 100).toFixed(1)}%、误路由 ${routedWrong}、回退 ${fallbackHit}/${fallbackExpected}）`)
  if (!ok) process.exit(1)
}

main()
