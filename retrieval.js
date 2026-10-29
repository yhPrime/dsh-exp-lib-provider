/**
 * 召回层 v2：面向「中文短意图」的邻居检索。
 *
 * 与 kernel.js 的分工（重要，别再混）：
 *  - kernel.js 保持与 `jitrl_memory.py` 的逐字段对拍（论文数学：V̂ / Q̂ / Â / 乐观封顶），
 *    它的 `retrieve()` 仍用对称 Jaccard，用于黄金样例回归；
 *  - 本文件只回答「哪些历史条目算邻居、相似度怎么算」，不改 Â 公式。
 *
 * 为什么需要 v2（2026-10-29 实测）：
 *  对称 Jaccard 拿 5 个 token 的短意图去比 12+ token 的长 intent，分母被稀释，
 *  「做个研学课 PPT」过阈 0/17（最强 0.0375 < 0.05），只有近乎照抄库内长句才召得回。
 *  另外 artifact 只做字面包含：`ppt` ≠ `pptx`，`任务单` 根本不在旧表里。
 *
 * v2 的两处实质改动：
 *  1. 相似度里加「查询覆盖率」|Q∩D|/|Q|，短查询不再被长文档惩罚；
 *  2. artifact 归到语义组（ppt / doc / sheet / code …），`pptx`、`幻灯片`、`课件` 都算 ppt。
 */

import { abstractState, jaccard } from './kernel.js'

/**
 * artifact 语义组：组内任一别名命中即算该组。
 * 顺序无关；一个文本可命中多组（如「PPT 课件」命中 ppt）。
 */
export const ARTIFACT_GROUPS = Object.freeze({
  ppt: ['ppt', 'pptx', '幻灯片', '演示文稿', '课件', '汇报'],
  doc: ['doc', 'docx', 'word', '文档', '教案', '讲义', '任务单', '任务卡', '学习单', '记录单'],
  sheet: ['xls', 'xlsx', 'excel', 'csv', '表格', '报表', '数据表'],
  pdf: ['pdf'],
  code: ['代码', '脚本', '插件', '程序', '固件', 'js', 'ts', 'py', 'python', 'node'],
  html: ['html', '网页', '网站', 'h5'],
  image: ['图片', '图标', '海报', '视觉'],
  web: ['抓取', '爬取', '浏览器'],
  robot: ['机器人', '动作', 'aelos', '舞蹈'],
  git: ['git', 'github', '仓库', '分支', '提交', '推送'],
  env: ['沙箱', '环境', '部署', '安装', '依赖'],
})

/** 相似度权重：覆盖率占主导，保证短意图召得回；artifact 命中几乎等于定了类型。 */
export const SIMILARITY_WEIGHTS = Object.freeze({
  coverage: 0.4,
  jaccard: 0.25,
  artifact: 0.2,
  bigram: 0.15,
})

/** 邻居门槛：低于它的条目直接不参与估计（0.12 由 12 条自然意图 + 5 条噪声意图标定）。 */
export const RECALL_MIN_SIMILARITY = 0.12

/** 文本 → artifact 语义组。 */
export function canonicalArtifacts(text) {
  const lowered = String(text || '').toLowerCase()
  const found = []
  for (const [group, aliases] of Object.entries(ARTIFACT_GROUPS)) {
    if (aliases.some((alias) => lowered.includes(alias))) found.push(group)
  }
  return found.sort()
}

/** 文本 → 检索状态（tokens / cgrams 用 kernel 的分词，artifacts 用语义组）。 */
export function stateOf(intent, action = '') {
  const text = `${intent || ''} ${action || ''}`
  const base = abstractState(text)
  return {
    tokens: base.tokens,
    cgrams: base.cgrams,
    artifacts: canonicalArtifacts(text),
  }
}

function mainSet(state) {
  const set = new Set()
  for (const token of state.tokens || []) set.add(`t:${token}`)
  for (const artifact of state.artifacts || []) set.add(`a:${artifact}`)
  return set
}

function intersectionSize(left, right) {
  let count = 0
  for (const item of left) if (right.has(item)) count += 1
  return count
}

/** v2 相似度：0.4 查询覆盖 + 0.25 对称 Jaccard + 0.2 artifact 覆盖 + 0.15 二元组 Jaccard。 */
export function similarityV2(query, candidate) {
  const qMain = mainSet(query || {})
  const cMain = mainSet(candidate || {})
  if (qMain.size === 0 && cMain.size === 0) return 0
  const shared = intersectionSize(qMain, cMain)
  const coverage = qMain.size === 0 ? 0 : shared / qMain.size
  const symmetric = jaccard(qMain, cMain)

  const qArtifacts = new Set(query.artifacts || [])
  const cArtifacts = new Set(candidate.artifacts || [])
  const artifact = qArtifacts.size === 0 ? 0 : intersectionSize(qArtifacts, cArtifacts) / qArtifacts.size

  const gram = jaccard(new Set(query.cgrams || []), new Set(candidate.cgrams || []))
  const w = SIMILARITY_WEIGHTS
  return w.coverage * coverage + w.jaccard * symmetric + w.artifact * artifact + w.bigram * gram
}

/**
 * 是否共享「有信息量」的信号：中文二元组、artifact 组、或 2 字符以上的拉丁词。
 *
 * 只共享单个汉字不算（如「翻译一段英文合同」与史实条目共享「一/段」），
 * 否则短查询会靠虚词拼出一个假分数（实测 0.215，虽过阈值但明显不相关）。
 */
export function sharesSignal(query, candidate) {
  const qArtifacts = new Set(query.artifacts || [])
  if ((candidate.artifacts || []).some((artifact) => qArtifacts.has(artifact))) return true
  const cGrams = new Set(candidate.cgrams || [])
  if ((query.cgrams || []).some((gram) => cGrams.has(gram))) return true
  const cTokens = new Set((candidate.tokens || []).filter((token) => token.length >= 2))
  return (query.tokens || []).some((token) => token.length >= 2 && cTokens.has(token))
}

/**
 * 取与 intent 最相似的 k 条历史经验。
 * @param {object[]} experiences - 可见经验。
 * @param {string} intent - 当前任务意图。
 * @param {{k?: number, minSimilarity?: number}} [options]
 * @returns {Array<{experience: object, similarity: number}>}
 */
export function retrieveV2(experiences, intent, options = {}) {
  const list = Array.isArray(experiences) ? experiences : []
  if (list.length === 0) return []
  const k = Math.max(1, Math.trunc(Number(options.k) || 8))
  const minSimilarity = Number.isFinite(Number(options.minSimilarity))
    ? Number(options.minSimilarity)
    : RECALL_MIN_SIMILARITY
  const query = stateOf(intent)
  const scored = []
  for (const experience of list) {
    const candidate = stateOf(experience.intent, experience.action)
    const similarity = similarityV2(query, candidate)
    if (similarity >= minSimilarity && sharesSignal(query, candidate)) scored.push({ experience, similarity })
  }
  scored.sort((left, right) => (
    right.similarity - left.similarity
    || String(right.experience.ts || '').localeCompare(String(left.experience.ts || ''))
    || String(left.experience.id).localeCompare(String(right.experience.id))
  ))
  return scored.slice(0, k)
}
