/**
 * Provider 存储与语义：一个 JSON 文件 = 一个「经验库」空间。
 *
 * 与 Source 方案的 store 不同点：
 *  - 写入是 upsert：重复就地更新、近似替换写新条并标记旧条 superseded_by、其余追加；
 *  - 软删是墓碑：deleted_at + tombstoneDays 后物理清理；
 *  - 读时过滤 deleted_at 与 superseded_by，排序仍用 JitRL（Â × confidence）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

// 内核随包自带（与 dsh-exp-lib-source/kernel.js 同源），Provider 不依赖别的插件包。
import { OUTCOME_SCORES, abstractState, estimateAdvantages, stateSimilarity, tokenize } from './kernel.js'
import { RECALL_MIN_SIMILARITY, retrieveV2 } from './retrieval.js'
import { ensureClusters, refreshClusters, routeCluster, buildBrief } from './cluster.js'

/** 只有系统兜底类型；业务类型不再预设，由模型在记录时按需创建（带防膨胀限制）。 */
export const SYSTEM_TYPE = Object.freeze({
  id: 'ty_other',
  name: '未分类',
  description: '兜底：没给类型或新类型被拒绝/超限时归到这里。',
  system: true,
})

/** 类型防膨胀：上限、每天新增上限、名称近似判定阈值。 */
export const DEFAULT_MAX_TYPES = 24
export const DEFAULT_NEW_TYPES_PER_DAY = 6
export const DEFAULT_TYPE_SIMILARITY = 0.8

/** 这些名字太泛，直接归「未分类」，不新建类型。 */
const GENERIC_TYPE_NAMES = new Set(['其他', '其它', '杂项', '别的', '临时', '随便', '未分类', 'other', 'misc'])

export const FILE_NAME = 'exp-lib.json'
export const SPACE_NAME = '经验库'
export const SPACE_DESCRIPTION = '存放工作的经验：每条记录做法与结果，按 JitRL 优势召回，供接同类任务前参考。'
export const DEFAULT_MERGE_THRESHOLD = 0.9
export const DEFAULT_REPLACE_THRESHOLD = 0.9
export const DEFAULT_TOMBSTONE_DAYS = 30

/**
 * 优势极差低于此值 → 样本没有成败对照，Â 不具区分度（同意图邻居回报近似相同）。
 * 召回改用「相似度 × 证据强度」排序，并在输出里明示，别让模型误以为 Â 排序有意义。
 */
export const DEGENERATE_ADV_SPREAD = 0.05
/** 证据强度里「支持条数」的饱和点，与 kernel 的 SUPPORT_FULL 对齐。 */
const EVIDENCE_SUPPORT_FULL = 3

/**
 * 用后反馈（0.4.0）：只认这三种结果。neutral 只计数、不动 G。
 * 映射到信号 ±1 / 0，按 EMA 修正回报 G。
 */
export const FEEDBACK_RESULTS = Object.freeze({ helped: 1, hurt: -1, neutral: 0 })
/** EMA 强度：一次 helped/hurt 把 G 拉向对应端点 35%（G=0.8 一次 hurt → 0.17，两次 → 负）。 */
export const FEEDBACK_ETA = 0.35
/** 每条经验保留的反馈日志条数（审计用；超出丢最旧）。 */
export const FEEDBACK_LOG_LIMIT = 20

/** DSH 家目录：宿主会注入 DSH_HOME；没有时退回 ~/.dsh。换机器不用改任何配置。 */
function dshHome() {
  const fromEnv = String(process.env.DSH_HOME || '').trim()
  if (fromEnv !== '') return path.resolve(fromEnv.replace(/^~(?=$|[\\/])/, os.homedir()))
  return path.join(os.homedir(), '.dsh')
}

/** 默认数据目录：配置优先，其次 $DSH_HOME/exp-lib/provider-data（可用 EXP_LIB_PROVIDER_DIR 覆盖）。 */
export function resolveDataDir(config = {}) {
  const configured = String(config.dataDir || process.env.EXP_LIB_PROVIDER_DIR || '').trim()
  if (configured !== '') return path.resolve(configured.replace(/^~(?=$|[\\/])/, os.homedir()))
  return path.join(dshHome(), 'exp-lib', 'provider-data')
}

/**
 * 从某个 `cordis.patch.yml` 里读出记忆插件（mnemon）条目的 `dataDir`（可能多条）。
 *
 * 只扫 `- id: mnemon` / `- name: dsh-mnemon` 那一块，遇到下一条顶层条目就停；读不到返回空数组。
 */
function mnemonDataDirsFromPatchFile(file) {
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const dirs = []
  let inMnemon = false
  for (const line of text.split(/\r?\n/)) {
    if (/^-\s/u.test(line)) {
      inMnemon = /^-\s+(?:id:\s*mnemon|name:\s*dsh-mnemon)\s*$/u.test(line)
      continue
    }
    if (!inMnemon) continue
    const match = /^\s+dataDir:\s*(.+?)\s*$/u.exec(line)
    if (match === null) continue
    const value = match[1].replace(/^['"]|['"]$/gu, '')
    if (value === '' || value.includes('${')) continue
    const resolved = path.resolve(value.replace(/^~(?=$|[\\/])/u, os.homedir()))
    if (!dirs.includes(resolved)) dirs.push(resolved)
  }
  return dirs
}

/**
 * 记忆插件（mnemon）存储根的候选：profile 的 `cordis.patch.yml` 里 mnemon 条目的 `dataDir`。
 *
 * 两个来源，缺一不可：
 *   ① 环境变量 `DSH_PROFILE_DIR` / `DSH_PROFILE` 指向的 profile；
 *      这两个变量是宿主给「模型发起的 shell」注入的，插件代码所在进程里**不一定有**
 *      （2026-10-30 实测：运行中的工具实例就这样退回了默认空目录）。
 *   ② 环境缺省时扫 `$DSH_HOME/profiles/*`（跳过 `backup-*` 备份目录）。
 *      不猜「当前是哪个 profile」——只把每个候选根都交给调用方，哪个根里真有带
 *      `services["exp-lib"]` 的 `memory-providers.json`，就用哪个。
 */
function mnemonDataDirsFromProfilePatches() {
  const files = []
  const profileDir = String(process.env.DSH_PROFILE_DIR || '').trim()
  if (profileDir !== '') files.push(path.join(profileDir, 'cordis.patch.yml'))
  const profile = String(process.env.DSH_PROFILE || '').trim()
  if (profile !== '') files.push(path.join(dshHome(), 'profiles', profile, 'cordis.patch.yml'))
  const profilesRoot = path.join(dshHome(), 'profiles')
  let names = []
  try {
    names = fs.readdirSync(profilesRoot).sort()
  } catch {
    names = []
  }
  for (const name of names) {
    if (/^backup/iu.test(name)) continue
    files.push(path.join(profilesRoot, name, 'cordis.patch.yml'))
  }
  const dirs = []
  for (const file of files) {
    for (const dir of mnemonDataDirsFromPatchFile(file)) {
      if (!dirs.includes(dir)) dirs.push(dir)
    }
  }
  return dirs
}

/**
 * 从记忆插件的 Provider 服务设置里读 exp-lib 的数据目录。
 *
 * 这是「工具跟随配置」的关键：用户在记忆引擎里改了「经验库」的数据目录，
 * 工具不需要重新打包/改 profile，直接读同一份服务设置。
 * 候选位置：显式 providerStateFile → mnemonDataDir → DSH_MNEMON_DATA_DIR → MNEMON_DATA_DIR
 * → profile 里 mnemon 配置的 dataDir（含扫 profiles/* 的兜底）→ 工作区/.mnemon →
 * cwd 祖先链里的 .mnemon → 家目录/.mnemon。
 */
export function dataDirFromProviderState(config = {}) {
  const files = []
  if (typeof config.providerStateFile === 'string' && config.providerStateFile.trim() !== '') {
    files.push(path.resolve(config.providerStateFile))
  }
  // 显式配了数据目录/存储根时不再去 profile 里猜：配置优先，避免测试与自定义配置被真实 profile 覆盖。
  const explicit = String(config.dataDir || '').trim() !== '' || String(config.mnemonDataDir || '').trim() !== ''
  const roots = [
    config.mnemonDataDir,
    process.env.DSH_MNEMON_DATA_DIR,
    process.env.MNEMON_DATA_DIR,
    ...(explicit ? [] : mnemonDataDirsFromProfilePatches()),
    path.join(process.cwd(), '.mnemon'),
    path.join(os.homedir(), '.mnemon'),
  ]
  for (const root of roots) {
    if (typeof root === 'string' && root.trim() !== '') {
      files.push(path.join(root.trim(), 'state', 'memory-providers.json'))
    }
  }
  // 兜底：从 cwd 往上找 `.mnemon`——记忆插件存储根常在工作区根上（如 <工作区根>/.mnemon），
  // 进程工作目录在工作区里时祖先链就能命中，不依赖宿主注入环境变量。
  if (!explicit) {
    let current = path.resolve(process.cwd())
    for (let i = 0; i < 8; i += 1) {
      files.push(path.join(current, '.mnemon', 'state', 'memory-providers.json'))
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
  }
  // 兜底：从配置的数据目录往上找 `.mnemon`（宿主没把存储根传进来时也能定位到服务设置）。
  const configuredDir = typeof config.dataDir === 'string' ? config.dataDir.trim() : ''
  if (configuredDir !== '') {
    let current = path.resolve(configuredDir)
    for (let i = 0; i < 6; i += 1) {
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
      files.push(path.join(current, '.mnemon', 'state', 'memory-providers.json'))
      files.push(path.join(current, 'state', 'memory-providers.json'))
    }
  }
  for (const file of new Set(files)) {
    try {
      const state = JSON.parse(fs.readFileSync(file, 'utf8'))
      const dir = state && state.services && state.services['exp-lib'] && state.services['exp-lib'].dataDir
      if (typeof dir === 'string' && dir.trim() !== '') {
        return path.resolve(dir.trim().replace(/^~(?=$|[\\/])/, os.homedir()))
      }
    } catch {
      // 该候选不存在或不可读，继续下一个。
    }
  }
  return ''
}

/** 工具用：优先跟随记忆插件里的 Provider 设置，读不到再退回插件自己的配置。 */
export function resolveToolDataDir(config = {}) {
  return dataDirFromProviderState(config) || resolveDataDir(config)
}

export function storeFile(dataDir) {
  return path.join(dataDir, FILE_NAME)
}

export function readStore(dataDir) {
  const file = storeFile(dataDir)
  let store
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const types = (Array.isArray(raw.types) && raw.types.length > 0 ? raw.types : [{ ...SYSTEM_TYPE }]).map((type) => (type && type.id === SYSTEM_TYPE.id ? { ...type, system: true } : type))
    const experiences = Array.isArray(raw.experiences) ? raw.experiences.filter((item) => item && typeof item === 'object') : []
    // 旧数据迁移：GOutcome 缺失时按 outcome 基准补上；有反馈日志就以日志重放为准，
    // 让「G 与 feedback 计数」读到的是同一份真相（日志封顶 20 条）。
    for (const item of experiences) {
      const log = trimFeedbackLog(item.feedback_log)
      const signalCount = log.filter((event) => event && FEEDBACK_RESULTS[event.result] !== 0).length
      if (signalCount > 0) {
        // 有信号事件：基准由 outcome 决定，G 由日志重放（单一真相）。
        item.feedback_log = log
        item.GOutcome = round4(scoreOf(item.outcome))
        item.G = replayFeedback(item.GOutcome, log)
        item.GSource = 'feedback'
        const counts = { helped: 0, hurt: 0, neutral: 0 }
        for (const event of log) if (counts[event.result] !== undefined) counts[event.result] += 1
        const last = log[log.length - 1]
        const previous = item.feedback !== null && typeof item.feedback === 'object' ? item.feedback : null
        item.feedback = previous !== null
          ? { ...previous, lastAt: last.at, lastResult: last.result }
          : { ...counts, lastAt: last.at, lastResult: last.result }
      } else {
        // 没有信号事件（无日志 / 只有 neutral / 历史 G 无法还原）：保持原 G，
        // 只在缺 GOutcome 时用它补基准；绝不把 1 静默读成 0.8（2026-11-07 验收）。
        if (item.GOutcome === undefined || item.GOutcome === null) {
          item.GOutcome = Number.isFinite(Number(item.G)) ? round4(Number(item.G)) : round4(scoreOf(item.outcome))
        }
        item.G = item.GOutcome
        item.GSource = 'outcome'
        if (log.length > 0) item.feedback_log = log
      }
    }
    store = { version: Number(raw.version) || 1, types, experiences }
  } catch {
    store = { version: 1, types: [{ ...SYSTEM_TYPE }], experiences: [] }
  }
  // 簇是派生视图：每次读都从 types + 可见经验重算，不落盘（writeStore 只写固定字段）。
  ensureClusters(store)
  return store
}

export function writeStore(dataDir, store) {
  const file = storeFile(dataDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  const payload = {
    version: 1,
    updated_at: new Date().toISOString(),
    types: Array.isArray(store.types) && store.types.length > 0 ? store.types : [{ ...SYSTEM_TYPE }],
    experiences: Array.isArray(store.experiences) ? store.experiences : [],
  }
  fs.writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  fs.renameSync(temp, file)
  return payload
}

/** 用法日志（2026-11-07）：零 token 的调用计数，用来回答「召回到底有没有被用起来」。 */
export const USAGE_FILE_NAME = 'usage.jsonl'
/** 单文件上限：超过就轮转到 usage.jsonl.1，避免无限长。 */
export const USAGE_MAX_BYTES = 1024 * 1024
/** 日志里 intent / action 的截断长度（action 也要截：实测有 604 字的做法说明）。 */
export const USAGE_TEXT_LIMIT = 120

const USAGE_REDACTIONS = [
  [/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***'],
  [/\bgh[pousr]_[A-Za-z0-9]{8,}/g, 'gh***'],
  [/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer ***'],
  [/(password|passwd|token|secret|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi, '$1=***'],
]

/** 日志文本脱敏 + 截断：家目录折叠成 ~，常见凭据样式打码，再截长度。 */
export function sanitizeUsageText(raw, limit = USAGE_TEXT_LIMIT) {
  let text = String(raw === undefined || raw === null ? '' : raw).replace(/\s+/g, ' ').trim()
  try {
    const home = os.homedir()
    if (home && text.includes(home)) text = text.split(home).join('~')
  } catch {
    // 拿不到家目录就不折叠。
  }
  for (const [pattern, replacement] of USAGE_REDACTIONS) text = text.replace(pattern, replacement)
  const max = Math.max(0, Math.trunc(Number(limit) || USAGE_TEXT_LIMIT))
  return text.length > max ? text.slice(0, max) : text
}

/**
 * 追加一行用法日志（同步、失败静默——统计不能影响工具本身）。
 * 只记结论性字段，不记 note / 文件内容；intent 与 action 都脱敏并截断。
 * @param {string} dataDir
 * @param {{tool: string} & Record<string, unknown>} entry
 * @param {{enabled?: boolean, maxBytes?: number, now?: Date}} [options]
 * @returns {boolean} 是否真的写入
 */
export function logUsage(dataDir, entry, options = {}) {
  if (options.enabled === false) return false
  try {
    const file = path.join(dataDir, USAGE_FILE_NAME)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const maxBytes = Number.isFinite(Number(options.maxBytes)) ? Math.max(1024, Number(options.maxBytes)) : USAGE_MAX_BYTES
    try {
      if (fs.statSync(file).size >= maxBytes) fs.renameSync(file, `${file}.1`)
    } catch {
      // 文件还不存在 / 轮转失败都不影响写入。
    }
    const line = { at: (options.now instanceof Date ? options.now : new Date()).toISOString(), ...entry }
    if (typeof line.intent === 'string') line.intent = sanitizeUsageText(line.intent)
    if (typeof line.action === 'string') line.action = sanitizeUsageText(line.action)
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/** 读回用法日志（供体检/测试）：当前文件 + 轮转文件 .1 一起读，按时间顺序返回最后 limit 行。 */
export function readUsage(dataDir, limit = 200) {
  const max = Math.max(1, Math.trunc(Number(limit) || 200))
  const rows = []
  for (const file of [`${path.join(dataDir, USAGE_FILE_NAME)}.1`, path.join(dataDir, USAGE_FILE_NAME)]) {
    try {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '')
      for (const line of lines) {
        try {
          rows.push(JSON.parse(line))
        } catch {
          // 跳过损坏行，不因一行坏掉整个统计。
        }
      }
    } catch {
      // 文件不存在就跳过。
    }
  }
  return rows.slice(-max)
}


export function findType(types, value) {
  const key = String(value || '').trim().toLowerCase()
  if (key === '') return null
  return (types || []).find((type) => String(type.id).toLowerCase() === key || String(type.name).toLowerCase() === key) || null
}

/** 类型名规范化：NFKC、去控制字符、压空白、限长。返回 '' 表示无效。 */
export function normalizeTypeName(raw) {
  if (typeof raw !== 'string') return ''
  const cleaned = raw.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/\s+/g, ' ')
  if (cleaned.length < 2) return ''
  return cleaned.slice(0, 16)
}

function typeBigrams(name) {
  const text = normalizeTypeName(name).toLowerCase().replace(/\s+/g, '')
  const set = new Set()
  if (text.length <= 1) {
    if (text !== '') set.add(text)
    return set
  }
  for (let i = 0; i < text.length - 1; i += 1) set.add(text.slice(i, i + 2))
  return set
}

/** 两个类型名的字符二元组 Jaccard 相似度。 */
export function typeNameSimilarity(left, right) {
  const a = typeBigrams(left)
  const b = typeBigrams(right)
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const gram of a) if (b.has(gram)) intersection += 1
  return intersection / (a.size + b.size - intersection)
}

function ensureSystemType(types) {
  if (!types.some((type) => type.system === true || type.id === SYSTEM_TYPE.id)) types.push({ ...SYSTEM_TYPE })
}

function startOfToday(now) {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/**
 * 决定一条经验该用哪个类型；没有就按需创建，但有四道防膨胀限制：
 *  1. 规范化 + 长度限制（2–16 字符）；
 *  2. 与现有类型近似（二元组 Jaccard ≥ similarity）→ 归到已有的，不新建；
 *  3. 泛化名（其他/杂项/随便…）→ 未分类；
 *  4. 数量上限（maxTypes）与每日新增上限（newTypesPerDay）→ 超限归未分类并给出原因。
 * @returns {{type: object, created: boolean, mergedInto?: string, rejected?: string, reason?: string}}
 */
export function resolveTypeForRecord(store, rawName, options = {}) {
  ensureSystemType(store.types)
  const fallback = store.types.find((type) => type.id === SYSTEM_TYPE.id)
  const name = normalizeTypeName(rawName)
  if (name === '') return { type: fallback, created: false, reason: name === '' && String(rawName || '').trim() !== '' ? 'invalid-name' : 'no-type' }
  if (GENERIC_TYPE_NAMES.has(name.toLowerCase())) return { type: fallback, created: false, reason: 'generic-name' }

  const existing = findType(store.types, name)
  if (existing !== null) return { type: existing, created: false }

  const similarity = Number.isFinite(Number(options.similarity)) ? Number(options.similarity) : DEFAULT_TYPE_SIMILARITY
  const lowered = name.toLowerCase()
  for (const type of store.types) {
    if (type.system === true || type.id === SYSTEM_TYPE.id) continue
    const existingName = String(type.name).toLowerCase()
    if (existingName !== '' && (existingName.includes(lowered) || lowered.includes(existingName))) {
      return { type, created: false, mergedInto: type.name, reason: 'similar-name' }
    }
  }
  let nearest = null
  let nearestScore = 0
  for (const type of store.types) {
    if (type.system === true || type.id === SYSTEM_TYPE.id) continue
    const score = typeNameSimilarity(name, type.name)
    if (score > nearestScore) {
      nearestScore = score
      nearest = type
    }
  }
  if (nearest !== null && nearestScore >= similarity) {
    return { type: nearest, created: false, mergedInto: nearest.name, reason: 'similar-name' }
  }

  const userTypes = store.types.filter((type) => type.system !== true && type.id !== SYSTEM_TYPE.id)
  const maxTypes = Math.max(1, Math.trunc(Number(options.maxTypes) || DEFAULT_MAX_TYPES))
  if (userTypes.length >= maxTypes) {
    return { type: fallback, created: false, rejected: 'limit', reason: `已达到类型上限 ${maxTypes}` }
  }
  const perDay = Math.max(1, Math.trunc(Number(options.newTypesPerDay) || DEFAULT_NEW_TYPES_PER_DAY))
  const today = startOfToday(Date.now())
  const createdToday = userTypes.filter((type) => {
    const at = Date.parse(type.createdAt || '')
    return Number.isFinite(at) && at >= today
  }).length
  if (createdToday >= perDay) {
    return { type: fallback, created: false, rejected: 'rate', reason: `每天最多新建 ${perDay} 个类型` }
  }

  const type = {
    id: `ty_${createHash('sha1').update(name.toLowerCase()).digest('hex').slice(0, 8)}`,
    name,
    description: String(options.typeDescription || '').normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, 120),
    createdAt: new Date().toISOString(),
    source: 'model-created',
  }
  store.types.push(type)
  refreshClusters(store)
  return { type, created: true }
}

function actionKeyOf(action) {
  return String(action || '').trim().toLowerCase()
}

function newId() {
  return `ex_${createHash('sha1').update(`${Date.now()}|${Math.random()}`).digest('hex').slice(0, 12)}`
}

/** 回报：显式 1..-1，或按结果推断。口径只有一份：kernel 的 OUTCOME_SCORES。 */
export function scoreOf(outcome, explicit) {
  if (Number.isFinite(Number(explicit))) return Math.max(-1, Math.min(1, Number(explicit)))
  return OUTCOME_SCORES[String(outcome || 'unknown')] ?? 0
}

/**
 * 清洗工具调用残渣：真实踩过——`note` 里粘了 `</note>` 与 `<parameter name="type">…`，
 * 结果类型丢了、note 变脏。这里只做恢复性清洗，不改用户写的正常文字。
 * @returns {{text: string, sanitized: boolean}}
 */
export function sanitizeField(raw) {
  if (raw === undefined || raw === null) return { text: '', sanitized: false }
  let text = String(raw)
  let sanitized = false
  const cut = text.search(/<\s*parameter\b/i)
  if (cut >= 0) {
    text = text.slice(0, cut)
    sanitized = true
  }
  const withoutNoteTags = text.replace(/<\/?\s*note\s*>/gi, '')
  if (withoutNoteTags !== text) {
    text = withoutNoteTags
    sanitized = true
  }
  const withoutClose = text.replace(/<\/\s*parameter\s*>/gi, '')
  if (withoutClose !== text) {
    text = withoutClose
    sanitized = true
  }
  return { text: text.trim(), sanitized }
}

/** 从残渣里捞回本该在参数里的值（如 `<parameter name="type">PPT / 课件`）。 */
export function extractParameter(raw, name) {
  const pattern = new RegExp(`<\\s*parameter[^>]*name\\s*=\\s*["']${String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>([^<]*)`, 'i')
  const match = pattern.exec(String(raw || ''))
  return match ? match[1].trim() : ''
}

function round4(value) {
  return Math.round(Number(value) * 1e4) / 1e4
}

/** 召回展示用的 note 上限：只截展示、不删数据；保首尾，长路径/命令不至于被切在开头。 */
export const RECALL_NOTE_LIMIT = 300

function truncateNote(raw) {
  const text = String(raw || '')
  if (text.length <= RECALL_NOTE_LIMIT) return text
  const head = Math.floor(RECALL_NOTE_LIMIT * 0.65)
  const tail = RECALL_NOTE_LIMIT - head - 1
  return `${text.slice(0, head)}…${text.slice(-tail)}`
}

/** 证据质量：(加权平均 G + 1) / 2，映射到 [0,1]，负回报会被压到 0.2 以下。 */
function evidenceQuality(candidate) {
  if (!Array.isArray(candidate.evidence) || candidate.evidence.length === 0) return 0
  let weightSum = 0
  let total = 0
  for (const item of candidate.evidence) {
    const weight = Number(item.similarity) > 0 ? Number(item.similarity) : 1
    total += (Number(item.G) || 0) * weight
    weightSum += weight
  }
  const meanG = weightSum > 0 ? total / weightSum : 0
  return Math.max(0, Math.min(1, (meanG + 1) / 2))
}

/**
 * 证据强度：advantage 无区分度时的排序依据。
 * = 平均相似度 × 支持度因子 × 证据质量；没有历史证据的候选（support=0）为 0，排在已验证之后。
 */
export function evidenceStrengthOf(candidate) {
  const meanSimilarity = Number(candidate.mean_similarity) || 0
  const support = Math.max(0, Math.trunc(Number(candidate.support) || 0))
  if (support === 0) return 0
  const supportFactor = 0.55 + 0.45 * Math.min(1, support / EVIDENCE_SUPPORT_FULL)
  return round4(meanSimilarity * supportFactor * evidenceQuality(candidate))
}

/**
 * 「候选规则」（2026-11-07，巩固机制的最小版，对应 ExpeL 的洞察抽取）：
 * 同族 ≥N 条且有正负对照时，从共同词里抽一条可检验的规则候选；不写库、不调 LLM。
 * 没有对照（全成功/全失败）就不归纳——「哪种更好」无从谈起。
 * @returns {string|null}
 */
export function buildConsolidation(candidates, options = {}) {
  const minSamples = Math.max(2, Math.trunc(Number(options.minSamples) || 3))
  const maxChars = Math.max(60, Math.trunc(Number(options.maxChars) || 200))
  const rows = []
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    for (const evidence of candidate.evidence || []) {
      if (!rows.some((row) => row.id === evidence.id)) rows.push(evidence)
    }
  }
  const groups = new Map()
  for (const row of rows) {
    const key = String(row.typeName || '未分类')
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }
  let best = null
  for (const [typeName, list] of groups) {
    if (best === null || list.length > best.list.length) best = { typeName, list }
  }
  if (best === null || best.list.length < minSamples) return null
  const positives = best.list.filter((row) => (Number(row.G) || 0) > 0)
  const negatives = best.list.filter((row) => (Number(row.G) || 0) < 0)
  if (positives.length < 2 || negatives.length === 0) return null
  const tokenFreq = (subset) => {
    const freq = new Map()
    for (const row of subset) {
      // 中文按二元组（单字没有区分度），拉丁词保留；与召回层口径一致。
      const state = abstractState(`${row.intent || ''} ${row.action || ''}`)
      const tokens = new Set([...(state.tokens || []).filter((token) => String(token).length >= 2), ...(state.cgrams || [])])
      for (const token of tokens) if (String(token).length >= 2) freq.set(token, (freq.get(token) || 0) + 1)
    }
    return freq
  }
  const posFreq = tokenFreq(positives)
  const negFreq = tokenFreq(negatives)
  const need = Math.max(2, Math.ceil(positives.length * 0.6))
  const shared = [...posFreq.entries()].filter(([, count]) => count >= need).map(([token]) => token)
  const avoid = [...negFreq.keys()].filter((token) => !shared.includes(token))
  if (shared.length === 0 && avoid.length === 0) return null
  const parts = [`候选规则（${best.list.length} 条：正 ${positives.length}/负 ${negatives.length}）`]
  if (shared.length > 0) parts.push(`优先 ${shared.slice(0, 4).join('、')}`)
  if (avoid.length > 0) parts.push(`避免 ${avoid.slice(0, 3).join('、')}`)
  let text = `${parts.join('；')}。未经验证，请先自己确认再采信。`
  if (text.length > maxChars) text = `${text.slice(0, Math.max(0, maxChars - 1))}…`
  return text
}


/**
 * 「归纳提示」（2026-11-07 实验 v2）：同族样本够多时，只给**一句**提示，让模型自己归纳。
 *
 * v1 曾把做法/反例摊开（≤400 字符），实测性价比低：内容全是候选里已有的信息，
 * 且相似度闸门挡不住「主题重叠但不贴题」的反例（查「改 PPT 页码」时差点贴上「问题页答案上屏」）。
 * 于是降级成一句：只报同族计数 + 要求模型先归纳，不注入任何原料。
 *
 * @param {object[]} candidates - `rankExperiences` 的候选（每个带 evidence[]）
 * @param {{minSamples?: number, maxChars?: number}} [options]
 * @returns {string|null} 有足够样本时返回一句归纳提示；否则 null
 */
export function buildInduction(candidates, options = {}) {
  const minSamples = Math.max(2, Math.trunc(Number(options.minSamples) || 3))
  const maxChars = Math.max(40, Math.trunc(Number(options.maxChars) || 160))
  const rows = []
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    for (const evidence of candidate.evidence || []) {
      if (rows.some((item) => item.id === evidence.id)) continue
      rows.push(evidence)
    }
  }
  // 按类型分组，取样本最多的那一族（跨类型的「规则」没有意义）。
  const groups = new Map()
  for (const row of rows) {
    const key = String(row.typeName || '未分类')
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }
  let best = null
  for (const [typeName, list] of groups) {
    if (best === null || list.length > best.list.length) best = { typeName, list }
  }
  if (best === null || best.list.length < minSamples) return null
  const success = best.list.filter((row) => (Number(row.G) || 0) > 0).length
  const fail = best.list.filter((row) => (Number(row.G) || 0) < 0).length
  const head = `【本次可见 ${best.list.length} 条｜${best.typeName}｜正回报 ${success}｜负回报 ${fail}】`
  const body = '动手前先自己写一句共性（哪些是共性、哪些是条件差异），别把这里当成结论。'
  let text = head + body
  if (text.length > maxChars) text = `${text.slice(0, Math.max(0, maxChars - 1))}…`
  return text
}


/**
 * 写入一条经验（upsert）。
 * 写入前先清洗工具调用残渣：`</note>`、`<parameter name="type">…` 这类串味会把类型和正文一起弄脏。
 * @returns {{experience: object, action: 'updated'|'superseded'|'added', supersededId?: string, sanitized: {intent: boolean, action: boolean, note: boolean}, typeRecoveredFromNote: boolean}}
 */
export function upsertExperience(store, input, options = {}) {
  const rawNote = input.note === undefined || input.note === null ? '' : String(input.note)
  const cleanIntent = sanitizeField(input.intent)
  const cleanAction = sanitizeField(input.action)
  const cleanNote = sanitizeField(rawNote)
  const intent = cleanIntent.text
  const action = cleanAction.text
  if (intent === '' || action === '') throw new Error('intent 与 action 必填')
  const mergeThreshold = Number.isFinite(Number(options.mergeThreshold)) ? Number(options.mergeThreshold) : DEFAULT_MERGE_THRESHOLD
  const replaceThreshold = Number.isFinite(Number(options.replaceThreshold)) ? Number(options.replaceThreshold) : DEFAULT_REPLACE_THRESHOLD
  const outcome = String(input.outcome || 'unknown')
  // 类型丢了但残渣里有（`<parameter name="type">PPT / 课件`）→ 捞回来，别让它掉进「未分类」。
  const explicitType = String(input.type || '').trim()
  const recoveredType = explicitType === '' ? extractParameter(rawNote, 'type') : ''
  const typeName = explicitType !== '' ? explicitType : recoveredType
  const resolved = resolveTypeForRecord(store, typeName, {
    typeDescription: input.typeDescription,
    maxTypes: options.maxTypes,
    newTypesPerDay: options.newTypesPerDay,
    similarity: options.typeSimilarity,
  })
  let type = resolved.type
  const hasExplicitType = typeName !== ''
  const state = abstractState(intent, action)
  // 没给类型时，若同做法已有归属明确的经验，就继承它的类型再走合并/取代判断；
  // 否则第二次不带 type 重记会被当成「未分类的新条」，hits 永远不涨（2026-11-07 回归测出来）。
  if (!hasExplicitType) {
    const owner = store.experiences.find((item) => !item.deleted_at && !item.superseded_by
      && item.typeId && item.typeId !== SYSTEM_TYPE.id
      && actionKeyOf(item.action) === actionKeyOf(action)
      && stateSimilarity(state, item.state || {}) >= mergeThreshold)
    if (owner !== undefined) type = (store.types || []).find((entry) => entry.id === owner.typeId) || undefined
  }
  const now = new Date().toISOString()
  const nowMs = Date.now()
  const decayDays = options.feedbackDecayDays === undefined ? DEFAULT_FEEDBACK_DECAY_DAYS : options.feedbackDecayDays
  const reward = scoreOf(outcome)
  // 任务/步骤结构（2026-11-07）：一条经验可以是「整条任务」或「任务里的一步」。
  // 旧数据没有这些字段 → 一律当独立的整条任务（task_id 默认=自己的 id）。
  const kind = input.kind === 'step' ? 'step' : 'task'
  const inputTaskId = String(input.taskId || '').trim()
  // 没给 taskId 的步骤：按意图自动归组，别让每一步各自成一个「任务」（2026-11-07 验收）。
  const autoTask = kind === 'step' && inputTaskId === '' ? autoTaskId(intent) : ''
  const stepIndexInput = Number(input.stepIndex)
  const stepIndex = Number.isInteger(stepIndexInput) && stepIndexInput > 0 ? stepIndexInput : null
  const stepTotalInput = Number(input.stepTotal)
  const stepTotal = Number.isInteger(stepTotalInput) && stepTotalInput > 0 ? stepTotalInput : null
  const failedStepInput = Number(input.failedStep)
  const failedStep = Number.isInteger(failedStepInput) && failedStepInput > 0 ? failedStepInput : null
  const stepRewardsInput = Array.isArray(input.stepRewards) ? input.stepRewards.map(Number).filter(Number.isFinite) : null
  // 多步的整条 G 取「最弱一步」：人也是一步做砸就整件事没成。
  // 但 outcome 自己就是失败时不能被分步回报「洗白」：所以取 min(reward, ...stepRewards)。
  const computedG = stepRewardsInput !== null && stepRewardsInput.length > 0
    ? Math.min(reward, ...stepRewardsInput)
    : reward
  // outcome 与分步回报反号：整条 G 会取到负值，返回给工具层做提示。
  const signOfValue = (value) => (Number(value) > 0 ? 1 : (Number(value) < 0 ? -1 : 0))
  // 反号指「outcome 的符号」与「分步回报的最弱一步」不一致（G 会取负值，统计按失败记）。
  const stepWeakest = stepRewardsInput !== null && stepRewardsInput.length > 0 ? Math.min(...stepRewardsInput) : reward
  const signMismatch = signOfValue(reward) !== signOfValue(stepWeakest)
  // 同任务：kind 相同、类型相同；step 还要 stepIndex 相同；taskId 显式给出时必须相等，
  // 且**不把没有 taskId 的新记挂到别人的任务上**（2026-11-07 验收：无 taskId 的 step 曾复活别人的 step1）。
  const sameTask = (item) => {
    if ((item.kind || 'task') !== kind) return false
    const rowTypeId = item.typeId || SYSTEM_TYPE.id
    const thisTypeId = type === undefined ? SYSTEM_TYPE.id : type.id
    if (rowTypeId !== thisTypeId) return false
    if (kind === 'step') {
      const rowIndex = item.stepIndex === undefined || item.stepIndex === null ? null : Number(item.stepIndex)
      // stepIndex 缺失时也只匹配缺失的：否则「没编号的几步」会被当成同一步互相取代。
      if (rowIndex !== stepIndex) return false
    }
    if (inputTaskId !== '') return String(item.taskId || '') === inputTaskId
    return item.taskId === undefined || item.taskId === null || item.taskId === '' || item.taskId === item.id
  }
  // 只在**可见**条里找重复 / 取代目标：已取代的条不能被再次更新，也不能当链条起点
  //（否则 A→B→C 时 C 会指回 A，B 永不下沉——2026-11-07 行为模拟测出来的）。
  const active = store.experiences.filter((item) => !item.deleted_at && !item.superseded_by && !item.retired_at)
  const sanitized = { intent: cleanIntent.sanitized, action: cleanAction.sanitized, note: cleanNote.sanitized }

  // 1) 重复：同做法 + 状态相似度达阈值 → 就地更新。
  //    但**只在回报符号相同**时才合并：正负翻转（先成功后失败 / 先失败后成功）必须新开一条，
  //    否则负样本会被下一次成功覆盖、失败教训直接消失（2026-11-07 多步验收实测）。
  const signOf = (value) => (Number(value) > 0 ? 1 : (Number(value) < 0 ? -1 : 0))
  // 分支判符号用**基准回报**（outcome 的符号），不用含反馈的 G：
  // 否则「成功但被 hurt 两次」的行会被当成负样本，重记失败原地合并、重记成功反而分裂（2026-11-07 验收实测）。
  const outcomeSignOf = (item) => signOf(item.GOutcome !== undefined && item.GOutcome !== null ? item.GOutcome : scoreOf(item.outcome))
  const duplicate = active.find((item) => sameTask(item)
    && actionKeyOf(item.action) === actionKeyOf(action)
    && outcomeSignOf(item) === signOf(reward)
    && stateSimilarity(state, item.state || {}) >= mergeThreshold)
  // 负样本退休（2026-11-07）：同一做法已有成功 → 旧的失败条转为历史（软隐、可复活），
  // 不再永远挡在召回前面。不按日历：失败被证明可绕过才算「学过了」。
  const retireNegatives = (keepId) => {
    const ids = []
    if (signOf(reward) <= 0) return ids
    for (const item of store.experiences) {
      if (item.id === keepId) continue
      if (item.deleted_at || item.superseded_by || item.retired_at) continue
      if (outcomeSignOf(item) >= 0) continue
      if (!sameTask(item)) continue
      if (actionKeyOf(item.action) !== actionKeyOf(action)) continue
      if (stateSimilarity(state, item.state || {}) < mergeThreshold) continue
      item.retired_at = now
      item.retired_reason = 'superseded-by-success'
      pushHistory(item, { type: 'retired', reason: 'superseded-by-success', by: keepId })
      ids.push(item.id)
    }
    return ids
  }
  if (duplicate !== undefined) {
    duplicate.hits = (Number(duplicate.hits) || 1) + 1
    duplicate.lastSeenAt = now
    duplicate.outcome = outcome
    duplicate.step_rewards = stepRewardsInput !== null ? stepRewardsInput : [reward]
    duplicate.GOutcome = computedG
    foldExpiredFeedback(duplicate, nowMs, decayDays)
    syncDerivedFeedback(duplicate)
    if (cleanNote.text !== '') duplicate.note = cleanNote.text
    if (hasExplicitType && type !== undefined) {
      duplicate.typeId = type.id
      duplicate.typeName = type.name
    }
    const retiredIds = retireNegatives(duplicate.id)
    refreshClusters(store)
    return { experience: duplicate, action: 'updated', retired: retiredIds, signMismatch, type: resolved, sanitized, typeRecoveredFromNote: recoveredType !== '' }
  }

  // 1b) 复活：同任务、同做法的**已被取代**条，如果又做成了 → 解除隐藏、就地更新，
  //     而不是新开一条（「这个做法当年被换掉，现在又有效了」）。删除的墓碑不自动复活。
  const revivable = store.experiences.find((item) => !item.deleted_at && (item.superseded_by || item.retired_at)
    && sameTask(item)
    && actionKeyOf(item.action) === actionKeyOf(action)
    && outcomeSignOf(item) === signOf(reward)
    && stateSimilarity(state, item.state || {}) >= mergeThreshold)
  if (revivable !== undefined) {
    const wasSuperseded = Boolean(revivable.superseded_by)
    revivable.superseded_by = null
    if (revivable.retired_at) {
      revivable.retired_at = null
      revivable.retired_reason = null
    }
    revivable.revived_at = now
    revivable.hits = (Number(revivable.hits) || 1) + 1
    revivable.lastSeenAt = now
    revivable.outcome = outcome
    revivable.step_rewards = stepRewardsInput !== null ? stepRewardsInput : [reward]
    revivable.GOutcome = computedG
    foldExpiredFeedback(revivable, nowMs, decayDays)
    syncDerivedFeedback(revivable)
    if (stepTotal !== null) revivable.stepTotal = stepTotal
    if (failedStep !== null) revivable.failedStep = failedStep
    if (cleanNote.text !== '') revivable.note = cleanNote.text
    // 先清掉「谁曾取代它」的指针，避免悬空链。
    for (const item of store.experiences) {
      if (item.supersedes === revivable.id && item.id !== revivable.id) item.supersedes = null
    }
    // 复活要**顶替现任**：取最近一条可见的同类同意图做法（与 replaceTarget 同口径），
    // 把它隐掉、复活条成为当前做法；否则旧条与现任并列，机器分不出新旧（2026-11-07 验收）。
    // 顶替现任只适用于「从取代里复活」；从退休里复活的是负样本，不该把成功现任隐掉。
    const head = !wasSuperseded || type === undefined ? undefined : [...active].reverse().find((item) => item.id !== revivable.id
      && item.typeId === type.id
      && sameTask(item)
      && actionKeyOf(item.action) !== actionKeyOf(revivable.action)
      && stateSimilarity(abstractState(intent), abstractState(item.intent)) >= replaceThreshold)
    revivable.supersedes = head === undefined ? null : head.id
    if (head !== undefined) {
      head.superseded_by = revivable.id
      pushHistory(head, { type: 'superseded', by: revivable.id, reason: 'revived' })
    }
    pushHistory(revivable, wasSuperseded
      ? { type: 'revived', displaced: head === undefined ? null : head.id }
      : { type: 'revived', reason: 'retired' })
    refreshClusters(store)
    return { experience: revivable, action: 'revived', signMismatch, type: resolved, sanitized, typeRecoveredFromNote: recoveredType !== '' }
  }

  // 2) 近似替换：同类型、做法不同、意图相似度达阈值 → 新条 + 旧条 superseded_by。
  //    但**只在两边都是正回报时才取代**：一旦有一条是失败的，两条都得留着当对照，
  //    否则库里永远没有负样本，Â 恒为 0，排序就退化成相似度排序。
  // 取代目标取**最近一条**可见匹配（数组顺序=写入顺序），而不是最早那条：
  // 否则刚复活的旧条会反复被新做法打回隐藏，记 A→C→A→D 可以无限抖动（2026-11-07 验收实测）。
  const replaceTarget = type === undefined ? undefined : (kind === 'step' && stepIndex === null ? undefined : [...active].reverse().find((item) => item.typeId === type.id
    && sameTask(item)
    && actionKeyOf(item.action) !== actionKeyOf(action)
    && reward >= 0
    && (Number(item.G) || 0) >= 0
    && stateSimilarity(abstractState(intent), abstractState(item.intent)) >= replaceThreshold))
  const experienceId = newId()
  const experience = {
    id: experienceId,
    taskId: inputTaskId || autoTask || experienceId,
    kind,
    stepIndex,
    stepTotal,
    failedStep,
    ts: now,
    lastSeenAt: now,
    hits: 1,
    intent,
    action,
    state,
    step_rewards: stepRewardsInput !== null ? stepRewardsInput : [reward],
    GOutcome: computedG,
    G: computedG,
    GSource: 'outcome',
    outcome,
    note: cleanNote.text,
    origin: input.origin === 'auto' ? 'auto' : input.origin === 'external' ? 'external' : 'manual',
    typeId: type === undefined ? SYSTEM_TYPE.id : type.id,
    typeName: type === undefined ? SYSTEM_TYPE.name : type.name,
    deleted_at: null,
    superseded_by: null,
  }
  if (replaceTarget !== undefined) {
    experience.supersedes = replaceTarget.id
    replaceTarget.superseded_by = experience.id
    pushHistory(replaceTarget, { type: 'superseded', by: experience.id })
    pushHistory(experience, { type: 'created', supersedes: replaceTarget.id })
  }
  store.experiences.push(experience)
  const retiredIds = retireNegatives(experience.id)
  refreshClusters(store)
  return { experience, action: replaceTarget === undefined ? 'added' : 'superseded', supersededId: replaceTarget === undefined ? undefined : replaceTarget.id, retired: retiredIds, signMismatch, type: resolved, sanitized, typeRecoveredFromNote: recoveredType !== '' }
}

/** 日志裁剪：优先淘汰 neutral（无信号），再淘汰最老的信号事件。
 *  否则「20 次 neutral」会把 hurt 挤出窗口，G 被洗白、反馈计数却还在（2026-11-07 验收实测）。 */
function trimFeedbackLogDetailed(log, limit = FEEDBACK_LOG_LIMIT) {
  const kept = Array.isArray(log) ? log.slice() : []
  const dropped = []
  while (kept.length > limit) {
    const neutralIndex = kept.findIndex((event) => event && FEEDBACK_RESULTS[event.result] === 0)
    if (neutralIndex >= 0) dropped.push(kept.splice(neutralIndex, 1)[0])
    else dropped.push(kept.shift())
  }
  return { kept, dropped }
}

function trimFeedbackLog(log, limit = FEEDBACK_LOG_LIMIT) {
  return trimFeedbackLogDetailed(log, limit).kept
}

/**
 * 反馈事件重放：G 不再是「随手改的一个数」，而是由「基准回报 + 事件日志」重算出来的。
 * 这样重记（更新 outcome）与反馈（改 G）不再有两套真相——基准变了、日志不变，G 自动重算。
 * @param {number} base - 由 outcome 得到的基准回报
 * @param {Array<{result: string}>} log - feedback_log（按时间顺序）
 * @param {number} [eta]
 */
/** 反馈事件默认衰减窗：超过这么多天的事件在**写入时**折叠进 GOutcome，不再逐条参与重放。 */
export const DEFAULT_FEEDBACK_DECAY_DAYS = 30

/**
 * 把超过衰减窗的事件折叠进 GOutcome：写入时调用，读时绝不做（否则 G 会随日历漂移）。
 * 折叠后的事件从日志移除，但终身计数保留；GOutcome 此时是「已浓缩的历史基准」，不再等于 outcome 分数。
 * @returns {boolean} 是否发生折叠
 */
export function foldExpiredFeedback(row, nowMs, decayDays) {
  const days = Number(decayDays)
  if (!Number.isFinite(days) || days <= 0) return false
  const log = Array.isArray(row.feedback_log) ? row.feedback_log : []
  if (log.length === 0) return false
  const cutoff = nowMs - days * 86400000
  const expired = []
  const kept = []
  for (const event of log) {
    const at = Date.parse(event && event.at)
    if (Number.isFinite(at) && at < cutoff) expired.push(event)
    else kept.push(event)
  }
  if (expired.length === 0) return false
  const base = Number.isFinite(Number(row.GOutcome)) ? Number(row.GOutcome) : scoreOf(row.outcome)
  row.GOutcome = replayFeedback(base, expired)
  row.feedback_log = kept
  row.lastDecayedAt = new Date(nowMs).toISOString()
  return true
}

/** 生命周期事件（0.11.0）：取代 / 复活 / 删除都留痕，光靠 GOutcome+feedback_log 重建不了。 */
export const HISTORY_LIMIT = 50

export function pushHistory(experience, event) {
  if (experience === undefined || experience === null) return
  const list = Array.isArray(experience.history) ? experience.history.slice() : []
  list.push({ at: new Date().toISOString(), ...event })
  experience.history = list.slice(-HISTORY_LIMIT)
}

/** 稳定的小哈希，给没有 taskId 的步骤自动归组（同一意图的步骤视为同一任务）。 */
function autoTaskId(intent) {
  let hash = 2166136261
  const text = String(intent || '')
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `auto_${(hash >>> 0).toString(36)}`
}

export function replayFeedback(base, log, eta = FEEDBACK_ETA) {
  let g = Number(base) || 0
  for (const event of Array.isArray(log) ? log : []) {
    const signal = Object.prototype.hasOwnProperty.call(FEEDBACK_RESULTS, event && event.result) ? FEEDBACK_RESULTS[event.result] : 0
    const eventEta = Number.isFinite(Number(event && event.eta)) ? Math.max(0, Math.min(1, Number(event.eta))) : eta
    if (signal !== 0) g = round4(Math.max(-1, Math.min(1, g + eventEta * (signal - g))))
  }
  return round4(g)
}

/** 把一行经验同步成「GOutcome + feedback_log → G」的一致状态。 */
function syncDerivedFeedback(row) {
  const base = Number.isFinite(Number(row.GOutcome)) ? Number(row.GOutcome) : scoreOf(row.outcome)
  row.GOutcome = round4(base)
  const log = trimFeedbackLog(row.feedback_log)
  row.feedback_log = log
  const signalCount = log.filter((event) => event && FEEDBACK_RESULTS[event.result] !== 0).length
  row.G = signalCount > 0 ? replayFeedback(row.GOutcome, log) : row.GOutcome
  row.GSource = signalCount > 0 ? 'feedback' : 'outcome'
  const counts = { helped: 0, hurt: 0, neutral: 0 }
  for (const event of log) {
    if (counts[event.result] !== undefined) counts[event.result] += 1
  }
  const previous = row.feedback !== null && typeof row.feedback === 'object' ? row.feedback : null
  const last = log[log.length - 1]
  // 计数是「一生」的，日志是最近 20 条：两者分工不同，不互相推导。
  row.feedback = previous !== null
    ? { ...previous, ...(last !== undefined ? { lastAt: last.at, lastResult: last.result } : {}) }
    : { ...counts, ...(last !== undefined ? { lastAt: last.at, lastResult: last.result } : {}) }
  return row
}

/**
 * 用后反馈：往 feedback_log 追加一条事件，再由「GOutcome + 全部事件」重算 G。
 *
 * 为什么改 G 而不是另加一个乘子：V̂ / Q̂ / Â、证据强度、簇统计（成败计数）全从 G 读，
 * 改 G 是一处改动、全链生效；再加一个乘子就是两套真相，迟早对不上。
 * 为什么不动 hits、不新建条目：hits 是「同一个做法被复现」的次数，反馈是「用过之后的再评估」；
 * 以前只能靠重记，那会把 hits 伪造 +1（2026-10-29 踩过）。
 * 为什么重写 outcome：不重写 —— outcome 是首次记录的结果，G 是含反馈的当前回报，
 * `GSource === 'feedback'` 标出这条被反馈修正过。
 *
 * @param {object} store
 * @param {string} id - 经验 id（取自 exp_recall 的 evidence[].id）
 * @param {{result?: string, intent?: string, note?: string}} input
 * @param {{eta?: number}} [options]
 * @returns {{id: string, result: string, G_before: number, G_after: number, changed: boolean, outcome: string, typeName: string, feedback: object}}
 */
export function applyFeedback(store, id, input = {}, options = {}) {
  const target = String(id || '').trim()
  if (target === '') throw new Error('id 必填（取自 exp_recall 的 evidence[].id）')
  const experience = (Array.isArray(store.experiences) ? store.experiences : []).find((item) => String(item.id) === target)
  if (experience === undefined) throw new Error(`没有这条经验：${target}（id 取自 exp_recall 的 evidence[].id）`)
  if (experience.deleted_at) throw new Error(`这条经验已删除，不能再反馈：${target}`)
  if (experience.superseded_by) throw new Error(`这条经验已被 ${experience.superseded_by} 取代，请给新条反馈：${target}`)
  if (experience.retired_at) throw new Error(`这条经验已退休（${experience.retired_reason || 'retired'}），不再参与召回；再次失败会自动复活：${target}`)
  const nowDate = options.now instanceof Date
    ? options.now
    : new Date(Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now())
  const now = nowDate.toISOString()
  const nowMs = nowDate.getTime()
  // 写入时衰减：超窗事件折叠进 GOutcome（读时不折叠，避免 G 随日历漂移）。
  foldExpiredFeedback(experience, nowMs, options.decayDays === undefined ? DEFAULT_FEEDBACK_DECAY_DAYS : options.decayDays)
  const result = String(input.result || '').trim().toLowerCase()
  if (!Object.prototype.hasOwnProperty.call(FEEDBACK_RESULTS, result)) {
    throw new Error(`result 只能是 helped / hurt / neutral，收到：${String(input.result)}`)
  }
  const etaRaw = Number(options.eta)
  const eta = Number.isFinite(etaRaw) ? Math.max(0, Math.min(1, etaRaw)) : FEEDBACK_ETA
  const before = round4(Number(experience.G) || 0)
  const entry = { at: now, result, eta }
  const auditIntent = sanitizeField(input.intent).text
  const auditNote = sanitizeField(input.note).text
  if (auditIntent !== '') entry.intent = auditIntent.slice(0, 120)
  if (auditNote !== '') entry.note = auditNote.slice(0, 200)
  // 单一真相：事件进日志，G 由「基准（GOutcome）+ 全部事件」重放得出；
  // 重记只改基准，不会把反馈历史抹掉，也不会出现「G 与 feedback 计数各说各话」。
  const base = Number.isFinite(Number(experience.GOutcome)) ? Number(experience.GOutcome) : scoreOf(experience.outcome)
  experience.GOutcome = round4(base)
  const log = trimFeedbackLogDetailed([...(Array.isArray(experience.feedback_log) ? experience.feedback_log : []), entry])
  experience.feedback_log = log.kept
  // 终身计数与 20 条重放窗口不可互推：裁剪量记成单条累计字段（不再往 history 塞重复事件）。
  if (log.dropped.length > 0) {
    const previousTrim = experience.feedbackTrimmed !== null && typeof experience.feedbackTrimmed === 'object'
      ? experience.feedbackTrimmed
      : { dropped: 0, byResult: {} }
    const byResult = { ...(previousTrim.byResult || {}) }
    for (const event of log.dropped) byResult[event.result] = (byResult[event.result] || 0) + 1
    experience.feedbackTrimmed = { dropped: (Number(previousTrim.dropped) || 0) + log.dropped.length, byResult, lastAt: now }
  }
  experience.lastFeedbackAt = now
  const keptLog = log.kept
  const signalCount = keptLog.filter((event) => event && FEEDBACK_RESULTS[event.result] !== 0).length
  experience.G = signalCount > 0 ? replayFeedback(base, keptLog, eta) : round4(base)
  experience.GSource = signalCount > 0 ? 'feedback' : 'outcome'
  const counts = { helped: 0, hurt: 0, neutral: 0 }
  const previous = experience.feedback !== null && typeof experience.feedback === 'object' ? experience.feedback : null
  if (previous !== null) {
    for (const key of Object.keys(counts)) counts[key] = Math.max(0, Math.trunc(Number(previous[key]) || 0))
    if (counts[result] !== undefined) counts[result] += 1
  } else {
    for (const event of keptLog) if (counts[event.result] !== undefined) counts[event.result] += 1
  }
  experience.feedback = { ...counts, lastAt: now, lastResult: result }
  refreshClusters(store)
  return {
    id: experience.id,
    result,
    G_before: before,
    G_after: experience.G,
    changed: experience.G !== before,
    outcome: String(experience.outcome || 'unknown'),
    typeName: experience.typeName || SYSTEM_TYPE.name,
    feedback: { ...experience.feedback },
  }
}

/** 软删一条（墓碑）。 */
export function forgetExperience(store, id) {
  const experience = store.experiences.find((item) => item.id === id)
  if (experience === undefined) return false
  if (experience.deleted_at) return true
  experience.deleted_at = new Date().toISOString()
  const now = new Date().toISOString()
  pushHistory(experience, { type: 'forgotten' })
  // 墓碑自己曾取代过谁：把那条放回可见，并清掉孤儿边（否则 graph 会连到被过滤的墓碑）。
  if (experience.supersedes !== undefined && experience.supersedes !== null) {
    const target = store.experiences.find((item) => item.id === experience.supersedes)
    if (target !== undefined) {
      target.superseded_by = null
      target.revived_at = now
      pushHistory(target, { type: 'revived', reason: 'superseder-deleted' })
    }
    experience.supersedes = null
  }
  for (const item of store.experiences) {
    if (item.supersedes === id) item.supersedes = null
    if (item.superseded_by === id) {
      item.superseded_by = null
      item.revived_at = now
      pushHistory(item, { type: 'revived', reason: 'superseder-deleted' })
    }
  }
  refreshClusters(store)
  return true
}

/** 物理清理超过 TTL 的墓碑，返回清理条数。 */
export function purgeTombstones(store, tombstoneDays = DEFAULT_TOMBSTONE_DAYS, now = Date.now()) {
  const ttl = Math.max(0, Number(tombstoneDays) || 0) * 24 * 60 * 60 * 1000
  const before = store.experiences.length
  store.experiences = store.experiences.filter((item) => {
    if (!item.deleted_at) return true
    const deletedAt = Date.parse(item.deleted_at)
    return Number.isFinite(deletedAt) ? now - deletedAt < ttl : true
  })
  const removed = before - store.experiences.length
  if (removed > 0) refreshClusters(store)
  return removed
}

/** 可见经验（未删、未被取代）。 */
export function visibleExperiences(store, options = {}) {
  return store.experiences.filter((item) => {
    if (item.deleted_at && !options.includeDeleted) return false
    if (item.superseded_by && !options.includeSuperseded) return false
    if (item.retired_at && !options.includeRetired) return false
    return true
  })
}

/**
 * 按意图召回并排序。
 *
 * 两种模式，输出的 `mode` 字段会说明用的是哪一种：
 *  - `advantage`：邻居里有成败对照（Â 极差 ≥ DEGENERATE_ADV_SPREAD）→ 按 JitRL 的 Â × 置信度；
 *  - `evidence`：样本回报几乎相同（实测全是 success/accepted 时 Â 恒为 0）→ Â 不具区分度，
 *    改按「相似度 × 支持度 × 证据质量」排序，并在 `note` 里明说。
 *
 * 不这么降级的话，模型会看到一排 `rank_score: 0` 却以为那是排序结果。
 */
export function rankExperiences(store, intent, limit = 8, options = {}) {
  const experiences = visibleExperiences(store, options)
  const routingMode = ['off', 'shadow', 'on'].includes(String(options.routing || '').toLowerCase())
    ? String(options.routing).toLowerCase()
    : 'off'
  // off：完全维持 v0.2.3 行为（G0 基线）；shadow：只附路由信息；on：簇内召回。
  const manualCluster = options.clusterId === undefined || options.clusterId === null || options.clusterId === ''
    ? null
    : (store.types || []).find((type) => type.id === options.clusterId) || null
  const route = routingMode === 'off'
    ? null
    : (manualCluster !== null
      ? { clusterId: manualCluster.id, name: manualCluster.name, score: 1, fallback: false, candidates: [] }
      : routeCluster(store, intent))
  const attach = (payload) => {
    if (route === null) return payload
    payload.route = route
    payload.brief = buildBrief(store, route, payload.candidates || [])
    return payload
  }
  if (experiences.length === 0) {
    return attach({ intent, V: 0, neighbor_count: 0, mode: 'evidence', degenerate: true, note: '经验库没有可见条目。', candidates: [] })
  }
  const k = Math.max(1, Math.trunc(Number(limit) || 8))
  // on 模式：主簇 + 次簇（分 ≥0.7×主簇）优先；合起来不足 3 条仍用全库，避免小簇丢召回。
  let pool = experiences
  if (routingMode === 'on' && route !== null && !route.fallback) {
    const primary = experiences.filter((item) => item.typeId === route.clusterId)
    const secondary = (route.candidates || [])[1]
    const secondaryRows = secondary !== undefined && secondary.clusterId !== route.clusterId && secondary.score >= route.score * 0.7
      ? experiences.filter((item) => item.typeId === secondary.clusterId)
      : []
    const merged = [...primary, ...secondaryRows]
    if (merged.length >= 3) pool = merged
  }
  const narrowed = routingMode === 'on' && route !== null && !route.fallback && pool !== experiences
  // 簇内召回不必再吐 8 条：主簇 3 + 次簇 1 是方案定下的配额（论文一个任务只用一个簇，我们放宽到主+次）。
  const effectiveK = narrowed ? Math.min(k, 4) : k
  // 排序用至少 8 个邻居算 Â：只回 1 条时若也只取 1 个邻居，Â 会退化成 evidence 排序，
  // 导致「limit 越小、排名越变」（2026-11-07 行为模拟测出来），所以计算量固定、输出再截。
  const computeK = Math.max(effectiveK, 8)
  const neighbors = retrieveV2(pool, intent, { k: computeK, minSimilarity: options.minSimilarity })
  const result = estimateAdvantages(pool, intent, { k: computeK, neighbors })
  const byId = new Map(pool.map((item) => [item.id, item]))
  const candidates = result.candidates.map((candidate) => {
    const row = byId.get((candidate.evidence[0] || {}).id) || null
    return {
      action: candidate.action,
      advantage: candidate.advantage,
      advantage_norm: candidate.advantage_norm,
      confidence: candidate.confidence,
      rank_score: candidate.rank_score,
      support: candidate.support,
      mean_similarity: candidate.mean_similarity,
      typeName: row ? row.typeName : '未分类',
      evidence: candidate.evidence.map((evidence) => {
        const experience = byId.get(evidence.id)
        const entry = {
          id: evidence.id,
          intent: experience ? experience.intent : '',
          action: experience ? experience.action : evidence.action,
          outcome: evidence.outcome,
          G: evidence.G,
          note: truncateNote(evidence.note),
          similarity: evidence.similarity,
          typeName: experience ? experience.typeName : '',
          taskId: experience ? (experience.taskId || experience.id) : undefined,
          kind: experience ? (experience.kind || 'task') : undefined,
          stepIndex: experience ? (experience.stepIndex === undefined ? null : experience.stepIndex) : undefined,
          stepTotal: experience ? (experience.stepTotal === undefined ? null : experience.stepTotal) : undefined,
          failedStep: experience ? (experience.failedStep === undefined ? null : experience.failedStep) : undefined,
        }
        // 生命周期摘要：让模型知道这条「被取代过 / 复活过 / 退休过」。
        const lifecycleTypes = ['superseded', 'revived', 'retired', 'forgotten']
        const lifecycleEvent = experience && Array.isArray(experience.history)
          ? [...experience.history].reverse().find((event) => event && lifecycleTypes.includes(event.type))
          : undefined
        if (lifecycleEvent !== undefined) {
          entry.lifecycle = { type: lifecycleEvent.type, at: lifecycleEvent.at }
          if (typeof lifecycleEvent.reason === 'string') entry.lifecycle.reason = lifecycleEvent.reason
        }
        // 有反馈才带：help/hurt/neutral 次数让模型知道这条被用过几次、结果如何（没反馈就不占字符）。
        const feedback = experience && experience.feedback !== null && typeof experience.feedback === 'object'
          ? experience.feedback
          : null
        if (feedback !== null) {
          entry.feedback = {
            helped: Number(feedback.helped) || 0,
            hurt: Number(feedback.hurt) || 0,
            neutral: Number(feedback.neutral) || 0,
            // 计数是终身的；window 是参与 G 重放的最近事件数，两者不可互推（2026-11-07）。
            window: Array.isArray(experience.feedback_log) ? experience.feedback_log.length : 0,
          }
        }
        return entry
      }),
    }
  })

  const verified = candidates.filter((item) => item.support > 0)
  const advantages = verified.map((item) => Number(item.advantage) || 0)
  const spread = advantages.length > 1 ? round4(Math.max(...advantages) - Math.min(...advantages)) : 0
  const degenerate = verified.length < 2 || spread < DEGENERATE_ADV_SPREAD

  for (const item of candidates) item.evidence_strength = evidenceStrengthOf(item)
  if (degenerate) {
    candidates.sort((left, right) => (
      right.evidence_strength - left.evidence_strength
      || right.support - left.support
      || right.mean_similarity - left.mean_similarity
      || (left.action < right.action ? -1 : left.action > right.action ? 1 : 0)
    ))
    for (const item of candidates) item.rank_score = item.evidence_strength
  }

  let note
  if (neighbors.length === 0) {
    note = `没有相似度 ≥ ${RECALL_MIN_SIMILARITY} 的历史经验；先按常规做法做，做完用 exp_record 记一条（失败/被纠正也要记，负样本才让排序有信息量）。`
  } else if (degenerate) {
    note = `无成败对照（advantage 极差 ${spread}），Â 不具区分度；已按「相似度 × 支持度 × 证据质量」排序，参考证据而非排名。`
  } else {
    note = `按 JitRL 优势排序（Â=Q̂−V̂，乘置信度；advantage 极差 ${spread}）。`
  }
  // 全族都是负回报时，排序仍会给出一个「最不坏」的——必须明说别照做，否则模型会把失败做法当推荐。
  const allNegative = candidates.length > 0 && candidates.every((item) => item.evidence.every((evidence) => (Number(evidence.G) || 0) < 0))
  const warning = allNegative
    ? '候选全是负回报：没有可推荐的做法，别照着做；建议换个做法并在做完后记录结果。'
    : null

  // mode / spread 必须按全部候选算完再截输出，否则 limit=1 时 verified<2 会被误判成 evidence。
  const truncated = candidates.slice(0, effectiveK)
  // 失败步骤必须留一席：簇内配额 4 条时，若所有候选都是正回报，
  // 那条负候选会被截掉，模型就永远看不到「上次错在哪」（2026-11-07 多步验收实测）。
  // limit=1 时不动：调用方明确只要一条，不能为了留负样本把 top1 换掉。
  if (truncated.length >= 2 && !truncated.some((item) => item.evidence.some((evidence) => (Number(evidence.G) || 0) < 0))) {
    const negativeCandidate = candidates.find((item) => item.evidence.some((evidence) => (Number(evidence.G) || 0) < 0))
    if (negativeCandidate !== undefined) truncated[truncated.length - 1] = negativeCandidate
  }

  const payload = attach({
    intent,
    V: result.V,
    neighbor_count: result.neighbor_count,
    mode: degenerate ? 'evidence' : 'advantage',
    degenerate,
    advantage_spread: spread,
    note,
    warning,
    candidates: truncated,
  })
  // 巩固：同族够多且有正负对照时给一条「候选规则」（不写库、零 LLM）。
  if (options.consolidation !== false) {
    const consolidated = buildConsolidation(truncated, { minSamples: options.consolidationMinSamples })
    if (consolidated !== null) payload.consolidated = consolidated
  }
  return payload
}

/** Insight 视图：给 Provider 的 list / search / graph 用。所有字段都必须是 JSON 值（不能出现 undefined）。 */
export function toInsight(experience, score) {
  const tokens = tokenize(`${experience.intent} ${experience.action}`)
  const insight = {
    id: experience.id,
    content: `[${experience.typeName}] ${experience.intent} → ${experience.action}（${experience.outcome}${experience.note ? `；${experience.note}` : ''}）`,
    category: 'insight',
    importance: 3,
    tags: [experience.typeName, experience.origin].filter(Boolean),
    entities: tokens.slice(0, 6),
    source: experience.origin === 'manual' ? 'user' : experience.origin === 'auto' ? 'agent' : 'external',
  }
  // 关键：无分数时**不要**写 `score: undefined`——宿主会报 "management result contains a non-JSON value"。
  if (Number.isFinite(score)) insight.score = score
  return insight
}

export function listInsights(store, options = {}) {
  const limit = Math.max(1, Math.trunc(Number(options.limit) || 100))
  const query = String(options.query || '').trim().toLowerCase()
  const rows = visibleExperiences(store, options)
    .filter((item) => query === '' || `${item.intent} ${item.action} ${item.note} ${item.typeName}`.toLowerCase().includes(query))
    .slice(-limit)
    .reverse()
  return rows.map((item) => toInsight(item))
}

export function graphSnapshot(store) {
  const rows = visibleExperiences(store)
  const nodes = rows.map((item) => ({ ...toInsight(item), color: '#818cf8', kind: 'memory' }))
  const edges = []
  for (const item of rows) {
    if (item.supersedes) {
      edges.push({ sourceId: item.supersedes, targetId: item.id, label: '取代', color: '#fb8f44', type: 'semantic' })
    }
  }
  return { nodes, edges, generatedAt: new Date().toISOString() }
}

export function entityIndex(store) {
  const memories = visibleExperiences(store).map((item) => toInsight(item))
  return { memories, complete: true }
}

export function statsOf(store, dataDir) {
  const rows = store.experiences
  const active = rows.filter((item) => !item.deleted_at && !item.superseded_by)
  const byType = {}
  for (const item of active) byType[item.typeName || '未分类'] = (byType[item.typeName || '未分类'] || 0) + 1
  const counts = new Map()
  for (const item of active) for (const token of new Set(tokenize(item.intent))) counts.set(token, (counts.get(token) || 0) + 1)
  const topEntities = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([entity, count]) => ({ entity, count }))
  let size = 0
  try {
    size = fs.statSync(storeFile(dataDir)).size
  } catch {
    size = 0
  }
  return {
    totalInsights: active.length,
    deletedInsights: rows.filter((item) => item.deleted_at).length,
    edgeCount: rows.filter((item) => item.supersedes).length,
    oplogCount: 0,
    dbSizeBytes: size,
    byCategory: byType,
    topEntities,
  }
}

/** 类型列表（含使用条数）；system 类型排在最后。 */
export function listTypes(store) {
  const counts = new Map()
  const taskSeen = new Map()
  for (const item of store.experiences) {
    if (item.deleted_at || item.superseded_by || item.retired_at) continue
    const key = item.taskId || item.id
    const perType = taskSeen.get(item.typeId) || new Set()
    if (perType.has(key)) continue
    perType.add(key)
    taskSeen.set(item.typeId, perType)
    counts.set(item.typeId, (counts.get(item.typeId) || 0) + 1)
  }
  return store.types
    .map((type) => ({
      id: type.id,
      name: type.name,
      description: type.description || '',
      system: type.system === true || type.id === SYSTEM_TYPE.id,
      source: type.source || 'preset',
      createdAt: type.createdAt || '',
      count: counts.get(type.id) || 0,
    }))
    .sort((left, right) => Number(left.system) - Number(right.system) || right.count - left.count || left.name.localeCompare(right.name, 'zh'))
}

function requireEditableType(store, nameOrId) {
  const type = findType(store.types, nameOrId)
  if (type === null) throw new Error(`没有这个类型：${String(nameOrId)}`)
  if (type.system === true || type.id === SYSTEM_TYPE.id) throw new Error('「未分类」是系统类型，不能改名/删除')
  return type
}

function ensureUniqueName(store, name, exceptId) {
  const existing = store.types.find((type) => type.id !== exceptId && String(type.name).toLowerCase() === name.toLowerCase())
  if (existing !== undefined) throw new Error(`类型名已存在：${name}（要合并请用 merge）`)
}

/** 新建一个管理动作显式指定的类型（不走每日创建配额）。 */
export function createType(store, rawName, description = '') {
  const name = normalizeTypeName(rawName)
  if (name === '') throw new Error('类型名无效（2–16 个字符）')
  if (findType(store.types, name) !== null) throw new Error(`类型已存在：${name}`)
  const type = {
    id: `ty_${createHash('sha1').update(name.toLowerCase()).digest('hex').slice(0, 8)}`,
    name,
    description: String(description || '').normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, 120),
    createdAt: new Date().toISOString(),
    source: 'model-created',
  }
  store.types.push(type)
  return type
}

/** 改名；同步更新引用它的经验。 */
export function renameType(store, nameOrId, rawNewName, description) {
  const type = requireEditableType(store, nameOrId)
  const newName = normalizeTypeName(rawNewName)
  if (newName === '') throw new Error('新类型名无效（2–16 个字符）')
  ensureUniqueName(store, newName, type.id)
  const oldName = type.name
  type.name = newName
  if (description !== undefined) type.description = String(description || '').normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, 120)
  for (const item of store.experiences) {
    if (item.typeId === type.id) item.typeName = newName
  }
  refreshClusters(store)
  return { type, oldName }
}

/** 合并多个类型到一个目标类型；经验批量改挂，源类型删除。 */
export function mergeTypes(store, names, rawTargetName, description) {
  ensureSystemType(store.types)
  const sources = [...new Set((Array.isArray(names) ? names : [names]).map((name) => findType(store.types, name)).filter((type) => type !== null))]
  if (sources.length === 0) throw new Error('没有找到要合并的类型')
  if (sources.some((type) => type.system === true || type.id === SYSTEM_TYPE.id)) throw new Error('「未分类」是系统类型，不能作为合并来源')

  const targetName = normalizeTypeName(rawTargetName) || sources[0].name
  let target = findType(store.types, targetName)
  if (target === null) target = createType(store, targetName, description || '')
  else if (target.system === true) throw new Error('不能合并到「未分类」；请指定一个业务类型作为目标')

  let moved = 0
  const sourceIds = new Set(sources.map((type) => type.id).filter((id) => id !== target.id))
  for (const item of store.experiences) {
    if (sourceIds.has(item.typeId)) {
      item.typeId = target.id
      item.typeName = target.name
      moved += 1
    }
  }
  store.types = store.types.filter((type) => !sourceIds.has(type.id))
  refreshClusters(store)
  return { target: target.name, targetId: target.id, moved, removed: sourceIds.size }
}

/** 删除类型；经验归「未分类」。 */
export function deleteType(store, nameOrId) {
  const type = requireEditableType(store, nameOrId)
  ensureSystemType(store.types)
  const fallback = store.types.find((item) => item.id === SYSTEM_TYPE.id)
  let moved = 0
  for (const item of store.experiences) {
    if (item.typeId === type.id) {
      item.typeId = fallback.id
      item.typeName = fallback.name
      moved += 1
    }
  }
  store.types = store.types.filter((item) => item.id !== type.id)
  refreshClusters(store)
  return { deleted: type.name, moved }
}



/**
 * 把单条经验改挂到另一个类型（定点修脏数据用）。
 *
 * 为什么需要它：以前一条记错类型的经验只能靠 exp_record 重记——那会把 hits 加 1，
 * 伪造出一次「复现」，把支持度统计弄脏。考点是「改挂」，不是「重记」。
 */
export function assignType(store, id, nameOrId) {
  ensureSystemType(store.types)
  const experience = store.experiences.find((item) => String(item.id) === String(id || '').trim())
  if (experience === undefined) throw new Error(`没有这条经验：${String(id)}`)
  const type = findType(store.types, nameOrId)
  if (type === null) throw new Error(`没有这个类型：${String(nameOrId)}（要新建请先 exp_type create）`)
  if (type.system === true || type.id === SYSTEM_TYPE.id) throw new Error('「未分类」不能作为改挂目标')
  const from = experience.typeName || SYSTEM_TYPE.name
  experience.typeId = type.id
  experience.typeName = type.name
  refreshClusters(store)
  return { id: experience.id, from, to: type.name, typeId: type.id, changed: from !== type.name }
}

/** 每轮提示段的文本：类型目录 + 用法提示（有界，读当前配置的数据文件）。 */
export function renderHint(config = {}, maxCharacters = 900) {
  let store
  try {
    store = readStore(resolveToolDataDir(config))
  } catch {
    store = { types: [{ ...SYSTEM_TYPE }], experiences: [] }
  }
  const active = visibleExperiences(store).length
  const userTypes = store.types.filter((type) => type.system !== true && type.id !== SYSTEM_TYPE.id)
  const maxTypes = Math.max(1, Math.trunc(Number(config.maxTypes) || DEFAULT_MAX_TYPES))
  const clusters = Array.isArray(store.clusters) ? store.clusters : []
  const nonEmptyClusters = clusters.filter((cluster) => (Number(cluster.stats && cluster.stats.count) || 0) > 0).length
  const lines = [
    "【经验库】接同类任务先用 exp_recall(intent)：mode=advantage 按 Â 排序；mode=evidence 表示没有成败对照，排的是证据强度。做完用 exp_record 记结果（成功/失败/被纠正都记；同一意图换做法复用同一 intent）；用过某条用 exp_feedback 报 helped/hurt。类型用 exp_type 管。",
    `共 ${active} 条（类型 ${userTypes.length}/${maxTypes}，簇 ${nonEmptyClusters}/${clusters.length}）；召回先按簇路由，无同族回退全库。`,
    "类型/簇（描述越具体，写入与召回越准）：",
  ]
  for (const type of store.types) {
    const description = String(type.description || "").replace(/\s+/g, " ").trim()
    lines.push(`- ${type.name}${description === "" ? "" : `：${description.length > 40 ? `${description.slice(0, 39)}…` : description}`}`)
  }
  let text = lines.join("\n")
  if (text.length > maxCharacters) text = `${text.slice(0, Math.max(0, maxCharacters - 1))}…`
  return text
}

