#!/usr/bin/env node
/**
 * 经验库体检（只读）：把「靠人读召回输出」换成可复跑的一组指标。
 *
 *   node tools/audit.mjs [dataDir]
 *
 * 默认 dataDir 跟随 Provider 服务设置，读不到再用插件配置/当前目录。
 * 退出码：0 = 无 FAIL；1 = 有 FAIL（脏数据 / 完全召回空转）。
 *
 * 检查项：
 *  1. 条目与类型分布（含 0 条目的业务类型）
 *  2. 回报分布与负样本数（没有负样本 → 排序无区分度）
 *  3. 对照覆盖：同类型下相似度 ≥ 0.45 且符号相反的经验对
 *  4. 工具调用残渣（</note> / <parameter）
 *  5. 固定意图集召回：过阈条数、top1、mode（衡量「库是不是真的召得回」）
 */
import path from 'node:path'

import {
  DEGENERATE_ADV_SPREAD,
  rankExperiences,
  readStore,
  resolveToolDataDir,
  visibleExperiences,
} from '../store.js'
import { RECALL_MIN_SIMILARITY, similarityV2, stateOf } from '../retrieval.js'

/** 固定体检意图：覆盖库里常见主题；不为具体条目写死 id，看的是「召不召得回」。 */
export const AUDIT_INTENTS = [
  '做个研学课 PPT',
  '给课件插一页过渡页',
  '改 PPT 页码',
  '把插件发布到 GitHub',
  '给插件跑自动化测试',
  '清理临时 worktree',
  '写 bat 和 ps1 脚本',
  '经验库写入语义怎么设计',
  '安装本地第三方插件',
  '在沙箱里推 GitHub',
  '做一节课的任务单',
  '改一条史实锚点',
]

const RESIDUE_RE = /<\/?\s*note\s*>|<\s*parameter\b/i

function main() {
  const dataDir = path.resolve(process.argv[2] || resolveToolDataDir({}))
  const store = readStore(dataDir)
  const active = visibleExperiences(store)
  const fails = []
  const warns = []

  console.log(`经验库体检：${dataDir}`)
  console.log(`条目 ${active.length}（总 ${store.experiences.length}）｜类型 ${store.types.length}`)

  /* ---- 1. 类型分布 ---- */
  const counts = new Map()
  for (const item of active) counts.set(item.typeId, (counts.get(item.typeId) || 0) + 1)
  const userTypes = store.types.filter((type) => type.system !== true && type.id !== 'ty_other')
  console.log('\n[类型分布]')
  const emptyTypes = []
  for (const type of store.types) {
    const count = counts.get(type.id) || 0
    if (type.system !== true && count === 0) emptyTypes.push(type.name)
    console.log(`  ${type.system === true ? '·' : ' '} ${type.name}: ${count}`)
  }
  console.log(`  业务类型 ${userTypes.length}/24${emptyTypes.length > 0 ? `｜0 条的类型：${emptyTypes.join('、')}` : ''}`)

  /* ---- 1b. 簇一致性（cluster 是 type 的派生视图，两者必须对齐） ---- */
  const clusters = Array.isArray(store.clusters) ? store.clusters : []
  const clusterSum = clusters.reduce((sum, cluster) => sum + (Number(cluster.stats && cluster.stats.count) || 0), 0)
  const orphan = active.filter((item) => !store.types.some((type) => type.id === item.typeId))
  const emptyClusters = clusters.filter((cluster) => (Number(cluster.stats && cluster.stats.count) || 0) === 0 && cluster.system !== true)
  const blankSignature = clusters.filter((cluster) => (Number(cluster.stats && cluster.stats.count) || 0) > 0
    && (cluster.signature.artifacts.length + cluster.signature.tokens.length + cluster.signature.cgrams.length) === 0)
  console.log('\n[簇一致性]')
  console.log(`  簇 ${clusters.length}（类型 ${store.types.length}）｜归属合计 ${clusterSum}（可见 ${active.length}）｜空簇 ${emptyClusters.length}`)
  if (clusters.length !== store.types.length) fails.push(`簇数 ${clusters.length} 与类型数 ${store.types.length} 不一致`)
  if (clusterSum !== active.length) fails.push(`簇归属合计 ${clusterSum} ≠ 可见经验 ${active.length}（有经验没归入任何簇）`)
  if (orphan.length > 0) fails.push(`${orphan.length} 条经验的 typeId 不在类型表里（${orphan.slice(0, 3).map((item) => item.id).join('、')}）`)
  if (blankSignature.length > 0) warns.push(`有 ${blankSignature.length} 个簇签名全空（intent/action 太短？）`)

  /* ---- 2. 回报分布 ---- */
  const Gs = active.map((item) => Number(item.G) || 0)
  const get = (n) => active.filter((item) => item.outcome === n).length
  const negatives = Gs.filter((g) => g < 0).length
  console.log('\n[回报分布]')
  console.log(`  accepted ${get('accepted')}｜success ${get('success')}｜partial ${get('partial')}｜unknown ${get('unknown')}`)
  console.log(`  failed ${get('failed')}｜corrected ${get('corrected')}｜aborted ${get('aborted')}`)
  console.log(`  G 区间 ${Gs.length ? Math.min(...Gs).toFixed(2) : '-'} .. ${Gs.length ? Math.max(...Gs).toFixed(2) : '-'}｜负样本 ${negatives}`)
  const withFeedback = active.filter((item) => item.feedback !== null && typeof item.feedback === 'object'
    && (Number(item.feedback.helped) || 0) + (Number(item.feedback.hurt) || 0) + (Number(item.feedback.neutral) || 0) > 0)
  const sumFeedback = (key) => withFeedback.reduce((total, item) => total + (Number(item.feedback[key]) || 0), 0)
  const feedbackRewritten = active.filter((item) => item.GSource === 'feedback').length
  console.log(`  用后反馈：${withFeedback.length} 条｜helped ${sumFeedback('helped')}｜hurt ${sumFeedback('hurt')}｜neutral ${sumFeedback('neutral')}｜G 被反馈改写过 ${feedbackRewritten}`)
  if (active.length >= 4 && negatives === 0) warns.push('没有失败/纠正样本：召回会退化到 mode=evidence（Â 不具区分度）')

  /* ---- 3. 对照覆盖 ---- */
  let contrastPairs = 0
  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      const left = active[i]
      const right = active[j]
      if (left.typeId !== right.typeId) continue
      if (Math.sign(Number(left.G) || 0) === Math.sign(Number(right.G) || 0)) continue
      const similarity = similarityV2(stateOf(left.intent, left.action), stateOf(right.intent, right.action))
      if (similarity >= 0.45) contrastPairs += 1
    }
  }
  console.log('\n[对照覆盖]')
  console.log(`  同类型、意图相似 ≥0.45 的正负样本对：${contrastPairs}`)
  if (active.length >= 6 && contrastPairs === 0) warns.push('没有任何成败对照对：库只能教「坑」，教不了「哪种打法更好」')

  /* ---- 4. 残渣 ---- */
  const dirty = active.filter((item) => RESIDUE_RE.test(`${item.intent}\n${item.action}\n${item.note || ''}`))
  console.log('\n[写入卫生]')
  console.log(`  含工具残渣的条目：${dirty.length}`)
  for (const item of dirty.slice(0, 5)) {
    console.log(`   FAIL ${item.id} [${item.typeName}] ${String(item.intent).slice(0, 30)}`)
    fails.push(`条目 ${item.id} 含工具调用残渣（note/intent/action）`)
  }

  /* ---- 5. 固定意图集召回 ---- */
  console.log('\n[固定意图集召回]')
  let recalled = 0
  for (const intent of AUDIT_INTENTS) {
    const ranked = rankExperiences(store, intent, 5)
    const top = ranked.candidates[0]
    const hit = ranked.neighbor_count > 0
    if (hit) recalled += 1
    console.log(
      `  ${hit ? '√' : '×'} ${intent}: 邻居 ${ranked.neighbor_count}｜${ranked.mode}${top ? `｜${String(top.action).slice(0, 24)}` : ''}`,
    )
  }
  console.log(`  召回率 ${recalled}/${AUDIT_INTENTS.length}`)
  if (active.length >= 6 && recalled === 0) fails.push(`固定意图集全部召回空转（阈值 ${RECALL_MIN_SIMILARITY}）`)
  else if (active.length >= 6 && recalled < AUDIT_INTENTS.length / 2) warns.push(`固定意图集召回率偏低：${recalled}/${AUDIT_INTENTS.length}`)

  /* ---- 汇总 ---- */
  console.log('')
  if (warns.length > 0) {
    console.log(`WARN ${warns.length} 条：`)
    for (const message of warns) console.log(`  - ${message}`)
  }
  if (fails.length > 0) {
    console.log(`FAIL ${fails.length} 条：`)
    for (const message of fails) console.log(`  - ${message}`)
    console.log(`\n结论：有问题（degenerate 阈值 ${DEGENERATE_ADV_SPREAD}）`)
    process.exit(1)
  }
  console.log('结论：无 FAIL。')
}

main()
