/**
 * 簇（cluster）：type 的派生视图 —— 分区 + 签名 + 统计。
 *
 * 与论文 Routed CL 的对应：论文的 cluster 是「一种记忆系统的隔离实例」，
 * 带 state、不可变描述 δc、trajectory_count。本插件只有一种记忆系统（经验条目），
 * 所以簇 = type 的派生视图：
 *   - 签名（artifacts / tokens / cgrams）承担 δc 的角色，用来判断「哪些任务该共享经验」；
 *   - 统计（条数 / 成败 / 最近使用）承担 state 的角色。
 *
 * 为什么派生而不落盘：`readStore` / `writeStore` 的 schema 一行不动 → 旧库零迁移、
 * 回滚只需删本文件；32 条库重算一次在毫秒级。`writeStore` 只序列化固定字段，
 * 内存里挂的 `store.clusters` 不会被写进 exp-lib.json。
 */

import { abstractState, tokenize, cjkBigrams } from './kernel.js'
import { canonicalArtifacts, sharesSignal, similarityV2, stateOf } from './retrieval.js'

/** 签名各部分的条目上限：太小区分不出簇，太大会把无关词也带进来。 */
export const SIGNATURE_TOKEN_LIMIT = 16
export const SIGNATURE_GRAM_LIMIT = 24
export const SIGNATURE_ARTIFACT_LIMIT = 6
/** 记忆系统标识：本版本只有一种；P3 若上 fact 型再扩展。 */
export const CLUSTER_SYSTEM = 'experience'
/** 簇的 schema 版本（description 允许改，改了就 +1；论文的 δc 不可变，这里折中）。 */
export const CLUSTER_VERSION = 1

/** 经验 → 所属簇 id（簇与 type 一一对应，旧数据按 typeId 直接归属）。 */
export function clusterIdOf(typeId) {
  const key = String(typeId || '').trim()
  return key === '' ? 'ty_other' : key
}

function bump(counts, key) {
  counts.set(key, (counts.get(key) || 0) + 1)
}

function topByFrequency(counts, limit) {
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    .slice(0, limit)
    .map(([key]) => key)
}

/**
 * 从簇内经验聚合签名。只用 intent + action，与召回口径一致；不掺 note
 * （note 里是命令、路径、坑，噪声大于信号）。
 * @param {object[]} rows - 该簇的可见经验。
 * @returns {{artifacts: string[], tokens: string[], cgrams: string[]}}
 */
export function signatureOf(rows) {
  const tokens = new Map()
  const grams = new Map()
  const artifacts = new Map()
  for (const row of rows || []) {
    const text = `${row.intent || ''} ${row.action || ''}`
    for (const token of new Set(tokenize(text))) {
      if (token.length >= 2) bump(tokens, token)
    }
    for (const gram of new Set(cjkBigrams(text.toLowerCase()))) bump(grams, gram)
    for (const artifact of new Set(canonicalArtifacts(text))) bump(artifacts, artifact)
  }
  return {
    artifacts: topByFrequency(artifacts, SIGNATURE_ARTIFACT_LIMIT),
    tokens: topByFrequency(tokens, SIGNATURE_TOKEN_LIMIT),
    cgrams: topByFrequency(grams, SIGNATURE_GRAM_LIMIT),
  }
}

/**
 * 簇签名 → 检索状态（供 `similarityV2` 直接比较）。
 *
 * artifacts 是「簇的身份」而不是「簇里出现过的产物」：
 *  - 手写类型描述声明的产物永远保留（人定义的任务族）；
 *  - 经验聚合出的主产物（signature.artifacts[0]）只在它是区分性标签时保留——
 *    跨簇出现 ≥ 一半的泛标签（ppt / code）不能当身份，否则「导 ppt」会被代码簇抢、
 *    「画一张海报」会被 PPT 簇接住（45 条标定集实测）。
 * @param {object} cluster
 * @param {{artifacts?: string[]}} [options] 路由侧传入已算好的身份（含跨簇泛标签剔除）。
 */
export function clusterStateOf(cluster, options = {}) {
  const signature = (cluster && cluster.signature) || {}
  const name = (cluster && cluster.name) || ''
  const description = (cluster && cluster.description) || ''
  const meta = abstractState(`${name} ${description}`)
  const artifacts = Array.isArray(options.artifacts)
    ? [...options.artifacts]
    : canonicalArtifacts(`${name} ${description}`)
  return {
    tokens: [...new Set([...(signature.tokens || []), ...meta.tokens])].sort(),
    cgrams: [...new Set([...(signature.cgrams || []), ...meta.cgrams])].sort(),
    artifacts: [...new Set(artifacts)].sort(),
  }
}

function statsOf(rows) {
  // 按任务统计：同一 taskId 的多条步骤只算一次成败（否则 6 步任务给类型记 6 票）。
  // 整条任务条优先用它的 G；只有步骤时取最弱一步（min），与 upsert 的口径一致。
  const groups = new Map()
  for (const row of rows) {
    const key = String(row.taskId || row.id)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }
  let success = 0
  let fail = 0
  let uses = 0
  let lastUsedAt = ''
  for (const group of groups.values()) {
    const taskRow = group.find((row) => (row.kind || 'task') === 'task')
    const rewards = group.map((row) => Number(row.G)).filter(Number.isFinite)
    const reward = taskRow !== undefined ? Number(taskRow.G) : (rewards.length > 0 ? Math.min(...rewards) : NaN)
    if (Number.isFinite(reward)) {
      if (reward > 0) success += 1
      else if (reward < 0) fail += 1
    }
    for (const row of group) {
      uses += Math.max(1, Math.trunc(Number(row.hits) || 1))
      const seen = String(row.lastSeenAt || row.ts || '')
      if (seen > lastUsedAt) lastUsedAt = seen
    }
  }
  return { count: groups.size, success, fail, uses, lastUsedAt, steps: rows.filter((row) => (row.kind || 'task') === 'step').length || rows.length }
}

function buildCluster(type, rows) {
  return {
    id: type.id,
    name: type.name,
    description: String(type.description || ''),
    system: CLUSTER_SYSTEM,
    version: Number(type.version) || CLUSTER_VERSION,
    signature: signatureOf(rows),
    stats: statsOf(rows),
  }
}

/**
 * 在 store 上挂 `clusters`（幂等；每次读都从 types + 可见经验重算）。
 * 经验里出现但 types 里没有的 typeId（损坏数据）不另建簇，归入「未分类」统计口径之外，
 * 由 audit 单独报告。
 * @param {{types?: object[], experiences?: object[]}} store
 * @returns {object[]} 簇列表
 */
export function ensureClusters(store) {
  const types = Array.isArray(store.types) && store.types.length > 0 ? store.types : []
  const rows = (Array.isArray(store.experiences) ? store.experiences : [])
    .filter((item) => item && !item.deleted_at && !item.superseded_by && !item.retired_at)
  const byType = new Map()
  const known = new Set(types.map((type) => String(type.id)))
  for (const row of rows) {
    const raw = String(row.typeId || '')
    const id = known.has(raw) ? raw : 'ty_other'
    if (!byType.has(id)) byType.set(id, [])
    byType.get(id).push(row)
  }
  const clusters = types.map((type) => buildCluster(type, byType.get(type.id) || []))
  store.clusters = clusters
  return clusters
}

/** 显式刷新（改名 / 合并 / 删类型 / 改挂之后同一 store 对象复用）。 */
export function refreshClusters(store) {
  return ensureClusters(store)
}

/**
 * 路由门槛：top-1 簇得分低于它 → 不路由，回退全库检索。
 *
 * 取值依据（2026-11-03 本机 45 条标定集，`node tools/eval-routing.mjs`）：
 * 应回退类的最高分 0.145（「今天天气怎么样」），应路由类的最低分 0.173（「查论文消融」），
 * 门槛取 0.17 落在两者之间：hit@1 75.6%、误路由 0、回退类 11/11 全对（2026-11-07 复测；
 * 余量只剩 0.027，再加一条「心跳式」经验就可能把「推送到 GitHub」重新拉过门槛——扩容后必须重核）。
 * 标定集扩缩后必须重核（见 tests/fixtures/labeled-intents.json）。
 */
export const ROUTE_MIN_SCORE = 0.17

/**
 * 簇的规模权重：1 条经验的簇签名只由那一条经验决定，容易与任意提到同一产物的查询撞高分
 * （实测：1 条经验的「文档 / 教案」簇在「改 PPT 页码」上压过 5 条经验的「PPT / 课件」簇）。
 * 5 条以上视为证据充分，不降权。1 条取 0.6 而不是 0.5：降太狠会让冷启动簇永远接不住。
 */
export function clusterWeightOf(count) {
  const n = Math.max(0, Math.trunc(Number(count) || 0))
  return 0.6 + 0.4 * Math.min(1, Math.max(0, n - 1) / 4)
}

function round4(value) {
  return Math.round(Number(value) * 1e4) / 1e4
}

/**
 * 确定性簇路由：替代论文里的 LLM router（论文 §C.2 实测对自带检索的系统加路由无收益、成本 +8–29%）。
 *
 * 只把「有经验的簇」纳入候选：空簇没有签名，分数来自手写描述，不可信。
 * @param {{clusters?: object[], types?: object[], experiences?: object[]}} store
 * @param {string} intent
 * @param {{minScore?: number}} [options]
 * @returns {{clusterId: string|null, name: string, score: number, fallback: boolean, candidates: Array<{clusterId: string, name: string, score: number}>}}
 */
export function routeCluster(store, intent, options = {}) {
  const clusters = Array.isArray(store.clusters) ? store.clusters : ensureClusters(store)
  const minScore = Number.isFinite(Number(options.minScore)) ? Number(options.minScore) : ROUTE_MIN_SCORE
  const query = stateOf(intent)
  const active = clusters.filter((cluster) => (Number(cluster.stats && cluster.stats.count) || 0) > 0)
  // 簇身份：手写描述声明的产物 + 经验主产物（跨簇泛标签剔除）。
  const artifactDf = new Map()
  for (const cluster of active) {
    for (const artifact of cluster.signature.artifacts || []) artifactDf.set(artifact, (artifactDf.get(artifact) || 0) + 1)
  }
  const genericThreshold = Math.max(2, Math.ceil(active.length / 2))
  const scored = active
    .map((cluster) => {
      const declared = canonicalArtifacts(`${cluster.name} ${cluster.description}`)
      const primary = (cluster.signature.artifacts || [])[0]
      const identity = new Set(declared)
      if (primary !== undefined && (artifactDf.get(primary) || 0) < genericThreshold) identity.add(primary)
      const state = clusterStateOf(cluster, { artifacts: [...identity] })
      // 与召回同一口径：不共享有信息量的信号（中文二元组 / artifact / ≥2 字母词）就不是同族，直接 0 分。
      const raw = sharesSignal(query, state) ? similarityV2(query, state) : 0
      return { clusterId: cluster.id, name: cluster.name, score: round4(raw * clusterWeightOf(cluster.stats.count)) }
    })
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name, 'zh'))
  const best = scored[0]
  if (best === undefined || best.score < minScore) {
    return { clusterId: null, name: '', score: best === undefined ? 0 : best.score, fallback: true, candidates: scored.slice(0, 3) }
  }
  return { clusterId: best.clusterId, name: best.name, score: best.score, fallback: false, candidates: scored.slice(0, 3) }
}

/**
 * 任务前的记忆简报（Context Memory Adapter 的本地版）：给模型一句话结论，而不是让它读完整个 JSON。
 * 模板生成，不调 LLM；有界 300 字符。
 * @param {{clusters?: object[]}} store
 * @param {{clusterId: string|null, name: string, fallback: boolean}|null} route
 * @param {object[]} candidates - `rankExperiences` 的候选
 * @param {number} [maxCharacters]
 */
export function buildBrief(store, route, candidates = [], maxCharacters = 300) {
  const list = Array.isArray(candidates) ? candidates : []
  const lines = []
  if (route === null || route === undefined || route.fallback) {
    lines.push(`【经验库】没有同族经验，已全库检索（${list.length} 条候选；无成败对照时参考证据而非排名）。`)
  } else {
    const cluster = (Array.isArray(store.clusters) ? store.clusters : []).find((item) => item.id === route.clusterId)
    const stats = cluster === undefined ? { count: 0, success: 0, fail: 0 } : cluster.stats
    lines.push(`【簇】${route.name}（${stats.count} 条｜成功 ${stats.success}｜失败 ${stats.fail}）`)
    const top = list[0]
    if (top !== undefined) {
      const evidence = (top.evidence || [])[0] || {}
      lines.push(`做法：${String(top.action).slice(0, 60)}（${evidence.outcome || '未验证'}）`)
      // 分层反馈：计数是终身的，窗口是参与 G 重放的最近事件数；两者不可互推，必须标清。
      const fb = evidence.feedback
      if (fb !== undefined && fb !== null && typeof fb === 'object') {
        lines.push(`反馈（终身）：helped ${Number(fb.helped) || 0}｜hurt ${Number(fb.hurt) || 0}｜neutral ${Number(fb.neutral) || 0}（窗口 ${Number(fb.window) || 0} 条参与重放）`)
      }
    }
    const negative = list.find((item) => (item.evidence || []).some((evidence) => Number(evidence.G) < 0))
    if (negative !== undefined) lines.push(`反例：${String(negative.action).slice(0, 50)}（失败过）`)
    // 生命周期提示：簇里有做法「复活过」，说明它曾失效、后来又被验证。
    const revived = list.find((item) => (item.evidence || []).some((evidence) => evidence.lifecycle && evidence.lifecycle.type === 'revived'))
    if (revived !== undefined) lines.push(`注意：${String(revived.action).slice(0, 30)} 复活过（曾失效，后来又被验证）。`)
  }
  let text = lines.join('\n')
  if (text.length > maxCharacters) text = `${text.slice(0, Math.max(0, maxCharacters - 1))}…`
  return text
}
