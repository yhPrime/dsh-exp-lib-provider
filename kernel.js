/**
 * exp-lib kernel — JitRL maths.
 *
 * JS mirror of the Python reference core (`经验库/exp-lib/scripts/jitrl_memory.py`).
 * Pure functions: no fs, no state, no imports from the plugin host.
 *
 * Parity: `tests/tools/gen-golden.py` exports fixed cases from Python; `tests/jitrl.test.mjs`
 * compares this module against them. Python rounds its public numbers to 4 decimals, so the
 * comparison tolerance is 2e-4 — tight enough to catch a wrong formula, loose enough to
 * survive banker's rounding.
 *
 * Paper → code map (arXiv:2601.18510):
 *   §3.1 state abstraction / discounted return   → abstractState / computeReturn
 *   §3.2 Jaccard top-k retrieval                 → retrieve
 *   §3.2 non-parametric critic V̂ / Q̂              → estimateStateValue / estimateActionValue
 *   §3.3 optimistic estimate for unseen actions   → the `verified_advs` cap branch
 *   §3.4 advantage Â = Q̂ − V̂                      → estimateAdvantages
 */

/* -------------------------------------------------------------------------- */
/* Constants (keep in sync with jitrl_memory.py)                              */
/* -------------------------------------------------------------------------- */

export const DEFAULT_K = 8
export const DEFAULT_GAMMA = 0.9
export const DEFAULT_ALPHA = 0.5
export const DEFAULT_EPS = 1e-6
/** Evidence count that counts as "well supported". */
export const SUPPORT_FULL = 3
/** Mean similarity that counts as "highly relevant evidence". */
export const SIM_FULL = 0.35
/** Rank discount for an unverified action: optimism means "worth trying", not "best". */
export const UNVERIFIED_DISCOUNT = 0.5
/** Neighbours below this similarity never enter the estimate. */
export const MIN_SIMILARITY = 0.05

/** Outcome keyword → reward table. */
export const OUTCOME_SCORES = {
  accepted: 1.0,
  success: 0.8,
  partial: 0.3,
  unknown: 0.0,
  failed: -0.6,
  corrected: -0.8,
  aborted: -1.0,
}

const STOPWORDS = new Set(
  (
    '的 了 是 在 和 与 或 一个 我 你 他 她 它 我们 你们 他们 这 那 这个 那个 ' +
    '请 帮 帮忙 需要 想要 想 做 制作 生成 处理 写 一下 一个 一些 进行 使用 ' +
    '给 把 被 让 使 到 从 对 与 为 以 及 或 但 而 就 都 还 很 太 更 最 ' +
    'a an the and or of to for in on at by with is are was were be been ' +
    'do does did can could would should will shall may might must please ' +
    'i you he she it we they this that these those my your his her our'
  ).split(/\s+/).filter(Boolean),
)

/** Longer stopwords first: stripping "制作" before "做" keeps the remainder stable. */
const MULTI_STOPWORDS = [...STOPWORDS]
  .filter((word) => word.length > 1)
  .sort((a, b) => b.length - a.length)

/** Artifact hints: what the task produces. High-signal dimension of a task fingerprint. */
const ARTIFACT_HINTS = [
  'ppt', 'pptx', 'docx', 'doc', 'xlsx', 'xls', 'csv', 'pdf', 'md', 'html',
  '代码', '脚本', '教案', '课件', '任务卡', '讲义', '笔记', '表格', '文档',
  '图片', '视频', '音频', '网页', '网站', '程序', '固件', '动作',
]

/** Action hints: what kind of procedure the task needs. */
const ACTION_HINTS = [
  '新建', '生成', '修改', '编辑', '修复', '检查', '体检', '转换', '导出',
  '下载', '上传', '同步', '提取', '抽取', '批处理', '重排', '美化', '制作',
  '替换', '增删', '对齐', '校验', '索引', '归档', '部署', '打包',
]

const TOKEN_RE = /[A-Za-z0-9_]+|[\u4e00-\u9fff]/g
const CJK_RUN_RE = /[\u4e00-\u9fff]+/g

/* -------------------------------------------------------------------------- */
/* Text → state                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Split mixed Chinese/English text into normalized tokens.
 *
 * Chinese is split per character (no segmenter dependency), Latin words keep their
 * boundaries, stopwords are dropped. Multi-character stopwords are stripped **inside
 * Chinese runs only**: a blanket replace would eat "in" out of "python" (`pyth`) or "an"
 * out of "yanxue" (`y`), and procedure names are the most common action strings.
 *
 * @param {string} text - Raw text.
 * @returns {string[]} Tokens, in order of appearance.
 */
export function tokenize(text) {
  if (!text) return []
  let body = String(text)
  body = body.replace(CJK_RUN_RE, (run) => {
    let next = run
    for (const word of MULTI_STOPWORDS) {
      if (next.includes(word)) next = next.split(word).join(' ')
    }
    return next
  })
  const tokens = []
  for (const match of body.matchAll(TOKEN_RE)) {
    const token = match[0].toLowerCase()
    if (STOPWORDS.has(token)) continue
    tokens.push(token)
  }
  return tokens
}

/**
 * Chinese bigrams, the secondary ("phrase-level") similarity signal.
 * @param {string} text - Raw text.
 * @returns {string[]} Sorted unique bigrams.
 */
export function cjkBigrams(text) {
  const grams = new Set()
  for (const run of String(text).matchAll(CJK_RUN_RE)) {
    const value = run[0]
    for (let index = 0; index + 1 < value.length; index += 1) {
      grams.add(value.slice(index, index + 2))
    }
  }
  return [...grams].sort()
}

/**
 * Abstract one task intent into the compact state stored per experience.
 * @param {string} intent - Task intent.
 * @param {string} [actionHint] - Optional procedure hint.
 * @returns {{tokens: string[], cgrams: string[], artifacts: string[], actions: string[]}} State.
 */
export function abstractState(intent, actionHint = '') {
  const text = `${intent || ''} ${actionHint || ''}`
  const lowered = text.toLowerCase()
  return {
    tokens: [...new Set(tokenize(text))].sort(),
    cgrams: cjkBigrams(lowered),
    artifacts: ARTIFACT_HINTS.filter((hint) => lowered.includes(hint)).sort(),
    actions: ACTION_HINTS.filter((hint) => lowered.includes(hint)).sort(),
  }
}

/** Flatten a state into prefixed sets; mirrors `_state_signature`. */
export function stateSignature(state) {
  const tokens = new Set((state.tokens || []).map((token) => `t:${token}`))
  const artifacts = new Set((state.artifacts || []).map((item) => `a:${item}`))
  const grams = new Set((state.cgrams || []).map((gram) => `g:${gram}`))
  return { tokens, artifacts, grams }
}

/** Jaccard index over two string sets; 0 when either side is empty. */
export function jaccard(left, right) {
  if (left.size === 0 || right.size === 0) return 0
  let intersection = 0
  for (const value of left) if (right.has(value)) intersection += 1
  if (intersection === 0) return 0
  return intersection / (left.size + right.size - intersection)
}

/**
 * Weighted state similarity: 0.75 · main Jaccard + 0.25 · bigram Jaccard.
 * Mirrors `_weighted_similarity` in the Python core.
 * @param {object} query - Abstracted query state.
 * @param {object} candidate - Stored state.
 * @returns {number} Similarity in [0, 1].
 */
export function stateSimilarity(query, candidate) {
  const left = stateSignature(query || {})
  const right = stateSignature(candidate || {})
  const mainLeft = new Set([...left.tokens, ...left.artifacts])
  const mainRight = new Set([...right.tokens, ...right.artifacts])
  return 0.75 * jaccard(mainLeft, mainRight) + 0.25 * jaccard(left.grams, right.grams)
}

/* -------------------------------------------------------------------------- */
/* Return                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Discounted return G = Σ γ^i · r_i.
 * @param {number[]} rewards - Step rewards, earliest first.
 * @param {number} [gamma] - Discount factor.
 * @returns {number} Return.
 */
export function computeReturn(rewards, gamma = DEFAULT_GAMMA) {
  let total = 0
  rewards.forEach((reward, index) => {
    total += Math.pow(gamma, index) * Number(reward || 0)
  })
  return total
}

/**
 * Resolve one reward from an outcome keyword and an optional explicit score.
 * Explicit score wins; otherwise the keyword table decides.
 * @param {string} outcome - Outcome keyword.
 * @param {number|null} [explicit] - Explicit score in [-1, 1].
 * @returns {number} Reward.
 */
export function inferScore(outcome, explicit) {
  if (explicit !== null && explicit !== undefined && explicit !== '') {
    return Math.max(-1, Math.min(1, Number(explicit)))
  }
  const key = String(outcome || '').trim().toLowerCase()
  if (Object.prototype.hasOwnProperty.call(OUTCOME_SCORES, key)) return OUTCOME_SCORES[key]
  for (const [name, value] of Object.entries(OUTCOME_SCORES)) {
    if (key.includes(name)) return value
  }
  return 0
}

/* -------------------------------------------------------------------------- */
/* Retrieval                                                                  */
/* -------------------------------------------------------------------------- */

/** The action key one experience aggregates under (trimmed action). */
export function actionKey(experience) {
  return String((experience && experience.action) || '').trim()
}

/** Round to 4 decimals, the precision the Python core exposes. */
function round4(value) {
  return Math.round(Number(value) * 1e4) / 1e4
}

/**
 * Jaccard top-k retrieval (§3.2 of the paper).
 *
 * Keeps only neighbours at or above MIN_SIMILARITY, orders by similarity descending and
 * breaks ties by timestamp ascending — the exact order the Python core produces.
 *
 * @param {object[]} experiences - Stored experiences.
 * @param {string} intent - Query intent.
 * @param {{k?: number, actionHint?: string}} [options] - Neighbour count and action hint.
 * @returns {Array<{experience: object, similarity: number}>} Neighbours, best first.
 */
export function retrieve(experiences, intent, options = {}) {
  const list = Array.isArray(experiences) ? experiences : []
  if (list.length === 0) return []
  const k = Math.max(1, Math.trunc(Number(options.k) || DEFAULT_K))
  const query = abstractState(intent, options.actionHint || '')
  const scored = []
  for (const experience of list) {
    const similarity = stateSimilarity(query, experience.state || {})
    if (similarity >= MIN_SIMILARITY) scored.push({ experience, similarity })
  }
  scored.sort((left, right) => {
    if (right.similarity !== left.similarity) return right.similarity - left.similarity
    const leftTs = String(left.experience.ts || '')
    const rightTs = String(right.experience.ts || '')
    if (leftTs < rightTs) return -1
    if (leftTs > rightTs) return 1
    return 0
  })
  return scored.slice(0, k)
}

/* -------------------------------------------------------------------------- */
/* Non-parametric critic                                                      */
/* -------------------------------------------------------------------------- */

/**
 * State value V̂(s): mean return of the neighbours.
 * @param {Array<{experience: object, similarity: number}>} neighbors - Retrieved neighbours.
 * @returns {number} V̂.
 */
export function estimateStateValue(neighbors) {
  if (!neighbors || neighbors.length === 0) return 0
  let total = 0
  for (const { experience } of neighbors) total += Number(experience.G) || 0
  return total / neighbors.length
}

/**
 * Action value Q̂(s,a).
 *
 * Seen action: similarity-weighted mean of that action's neighbour returns, so a weakly
 * related high-return experience cannot drown strong evidence. Unseen action: optimistic
 * V̂ + α/|N(s)|, **capped** at the best verified advantage × 0.9 — without the cap the
 * ranking degenerates into "always recommend the untried", which is the opposite of what
 * an experience library is for.
 *
 * @param {string} action - Candidate action.
 * @param {Array<{experience: object, similarity: number}>} neighbors - Retrieved neighbours.
 * @param {number} [alpha] - Optimism strength.
 * @returns {{q: number, unverified: boolean, support: number, meanSimilarity: number}} Q̂.
 */
export function estimateActionValue(action, neighbors, alpha = DEFAULT_ALPHA) {
  const key = String(action || '').trim()
  const same = (neighbors || []).filter((entry) => actionKey(entry.experience) === key)
  if (same.length > 0) {
    let weightSum = 0
    for (const entry of same) weightSum += entry.similarity
    const q = weightSum > 0
      ? same.reduce((sum, entry) => sum + (Number(entry.experience.G) || 0) * entry.similarity, 0) / weightSum
      : same.reduce((sum, entry) => sum + (Number(entry.experience.G) || 0), 0) / same.length
    const meanSimilarity = same.reduce((sum, entry) => sum + entry.similarity, 0) / same.length
    return { q, unverified: false, support: same.length, meanSimilarity }
  }

  const value = estimateStateValue(neighbors)
  const denominator = Math.max((neighbors || []).length, 1)
  const bonus = alpha / denominator

  const verifiedAdvantages = []
  const actions = new Set((neighbors || []).map((entry) => actionKey(entry.experience)))
  for (const candidate of actions) {
    const sameAction = (neighbors || []).filter((entry) => actionKey(entry.experience) === candidate)
    if (sameAction.length === 0) continue
    let weightSum = 0
    for (const entry of sameAction) weightSum += entry.similarity
    const q = weightSum > 0
      ? sameAction.reduce((sum, entry) => sum + (Number(entry.experience.G) || 0) * entry.similarity, 0) / weightSum
      : sameAction.reduce((sum, entry) => sum + (Number(entry.experience.G) || 0), 0) / sameAction.length
    verifiedAdvantages.push(q - value)
  }
  const cap = verifiedAdvantages.length > 0
    ? Math.max(...verifiedAdvantages) * 0.9
    : bonus
  return {
    q: value + Math.min(bonus, Math.max(cap, 0)),
    unverified: true,
    support: 0,
    meanSimilarity: 0,
  }
}

/* -------------------------------------------------------------------------- */
/* Advantage                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Estimate and rank candidate actions by advantage Â = Q̂ − V̂ (§3.4).
 *
 * The paper's Â is a relative value in a given state; in an open-ended setting that
 * misranks weak-but-lucky evidence above strongly related evidence. So the **rank score**
 * multiplies Â by an evidence-confidence factor (Â itself still follows the paper and is
 * returned unchanged):
 *   verified   — confidence = (0.5 + 0.5·count) · (0.5 + 0.5·similarity)
 *   unverified — confidence = UNVERIFIED_DISCOUNT
 *
 * @param {object[]} experiences - Stored experiences.
 * @param {string} intent - Current task intent.
 * @param {{candidateActions?: string[], k?: number, alpha?: number, actionHint?: string}} [options] - Options.
 * @returns {object} `{intent, V, neighborCount, neighbors, candidates, k, alpha}`.
 */
export function estimateAdvantages(experiences, intent, options = {}) {
  const k = Math.max(1, Math.trunc(Number(options.k) || DEFAULT_K))
  const alpha = Number.isFinite(Number(options.alpha)) ? Number(options.alpha) : DEFAULT_ALPHA
  const neighbors = retrieve(experiences, intent, { k, actionHint: options.actionHint || '' })
  const vHat = estimateStateValue(neighbors)

  const candidates = []
  for (const raw of options.candidateActions || []) {
    const action = String(raw || '').trim()
    if (action !== '' && !candidates.includes(action)) candidates.push(action)
  }
  for (const entry of neighbors) {
    const action = actionKey(entry.experience)
    if (action !== '' && !candidates.includes(action)) candidates.push(action)
  }

  const results = []
  for (const action of candidates) {
    const estimate = estimateActionValue(action, neighbors, alpha)
    const advantage = estimate.q - vHat
    const evidence = neighbors
      .filter((entry) => actionKey(entry.experience) === action)
      .map((entry) => ({
        id: entry.experience.id,
        ts: entry.experience.ts,
        G: round4(Number(entry.experience.G) || 0),
        similarity: round4(entry.similarity),
        outcome: entry.experience.outcome,
        source: entry.experience.source,
        note: entry.experience.note,
      }))
    results.push({
      action,
      Q: round4(estimate.q),
      V: round4(vHat),
      advantage: round4(advantage),
      unverified: estimate.unverified,
      support: estimate.support,
      mean_similarity: round4(estimate.meanSimilarity),
      evidence,
    })
  }

  const largest = results.reduce((max, item) => Math.max(max, Math.abs(item.advantage)), 0)
  for (const item of results) {
    item.advantage_norm = round4(item.advantage / (largest + DEFAULT_EPS))
    if (item.unverified) {
      item.confidence = round4(UNVERIFIED_DISCOUNT)
    } else {
      const countFactor = Math.min(1, item.support / SUPPORT_FULL)
      const similarityFactor = Math.min(1, item.mean_similarity / SIM_FULL)
      item.confidence = round4((0.5 + 0.5 * countFactor) * (0.5 + 0.5 * similarityFactor))
    }
    item.rank_score = round4(item.advantage * item.confidence)
  }

  results.sort((left, right) => (
    right.rank_score - left.rank_score
    || right.support - left.support
    || right.mean_similarity - left.mean_similarity
    || (left.action < right.action ? -1 : left.action > right.action ? 1 : 0)
  ))

  return {
    intent,
    V: round4(vHat),
    neighbor_count: neighbors.length,
    neighbors: neighbors.map((entry) => ({
      id: entry.experience.id,
      action: actionKey(entry.experience),
      G: round4(Number(entry.experience.G) || 0),
      similarity: round4(entry.similarity),
    })),
    candidates: results,
    k,
    alpha,
  }
}
