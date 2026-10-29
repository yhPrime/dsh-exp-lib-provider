/**
 * 工具面：exp_record / exp_recall。
 *
 * 同一份数据、同一套语义；写入只走 exp_record（Provider 的通用 remember 被禁用）。
 * SDK 由 index.js 注入，测试用桩。
 */

import {
  createType,
  deleteType,
  listTypes,
  mergeTypes,
  rankExperiences,
  readStore,
  renameType,
  resolveToolDataDir,
  scoreOf,
  upsertExperience,
  writeStore,
} from './store.js'

const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true }

function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/**
 * @param {Function} defineTool - `@deepseek-ai/dsh-tools` 的 defineTool
 * @param {{dataDir?: string, mergeThreshold?: number, replaceThreshold?: number}} config
 */
export function buildTools(defineTool, config = {}) {
  // 跟随记忆插件里的 Provider 服务设置（用户改数据目录后工具自动跟随），读不到才退回插件配置。
  const dataDirOf = () => resolveToolDataDir(config)

  const record = defineTool({
    name: 'exp_record',
    description: '记录一条工作经验（做法 + 结果）。同一做法会就地更新 hits，近似替换会写新条并标记旧条被取代。',
    parameters: {
      intent: { type: 'string', required: true, description: '要做的任务/意图。' },
      action: { type: 'string', required: true, description: '采取的做法或方案名。' },
      outcome: { type: 'string', enum: ['accepted', 'success', 'partial', 'unknown', 'failed', 'corrected', 'aborted'], description: '结果；影响回报 G。' },
      type: { type: 'string', description: '类型名（可选）。不填归「未分类」；填了新名字会按需新建类型（受上限与近似合并限制）。' },
      typeDescription: { type: 'string', description: '新建类型时的描述（≤120 字）：这个类型收什么、召回时怎么用。复用已有类型时忽略。' },
      note: { type: 'string', description: '关键步骤、为什么有效、踩了什么坑。' },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    execute(args = {}) {
      const dataDir = dataDirOf()
      const store = readStore(dataDir)
      const result = upsertExperience(store, {
        intent: args.intent,
        action: args.action,
        outcome: args.outcome,
        type: args.type,
        typeDescription: args.typeDescription,
        note: args.note,
      }, {
        mergeThreshold: config.mergeThreshold,
        replaceThreshold: config.replaceThreshold,
        maxTypes: config.maxTypes,
        newTypesPerDay: config.newTypesPerDay,
        typeSimilarity: config.typeSimilarity,
      })
      writeStore(dataDir, store)
      const typeInfo = result.type || {}
      return {
        action: result.action,
        id: result.experience.id,
        hits: result.experience.hits,
        outcome: result.experience.outcome,
        G: result.experience.G,
        typeName: result.experience.typeName,
        typeCreated: typeInfo.created === true,
        typeMergedInto: typeInfo.mergedInto || null,
        typeWarning: typeInfo.rejected ? `${typeInfo.reason}（已归「未分类」）` : null,
        typeCount: store.types.filter((type) => type.system !== true && type.id !== 'ty_other').length,
        typeLimit: Math.max(1, Math.trunc(Number(config.maxTypes) || 24)),
        supersededId: result.supersededId || null,
        count: store.experiences.filter((item) => !item.deleted_at && !item.superseded_by).length,
      }
    },
  })

  const recall = defineTool({
    name: 'exp_recall',
    description: '按任务意图召回历史经验，按 JitRL 优势排序（Â = Q̂ − V̂，乘置信度）。返回做法与证据。',
    parameters: {
      intent: { type: 'string', required: true, description: '当前任务意图。' },
      limit: { type: 'number', description: '返回几条候选做法，默认 8。' },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    execute(args = {}) {
      const dataDir = dataDirOf()
      const store = readStore(dataDir)
      return rankExperiences(store, String(args.intent || ''), args.limit || 8)
    },
  })

  const typeTool = defineTool({
    name: 'exp_type',
    description: '管理经验类型：list 列表（含条数）/ create 新建 / rename 改名 / merge 合并（经验批量改挂，源类型删除）/ delete 删除（经验归「未分类」）。',
    parameters: {
      action: { type: 'string', enum: ['list', 'create', 'rename', 'merge', 'delete'], required: true, description: '要执行的动作。' },
      name: { type: 'string', description: 'create/rename/delete 时的类型名或 id（rename 时是旧名）。' },
      newName: { type: 'string', description: 'rename 的新名；merge 的目标类型名（不存在会新建）。' },
      names: { type: 'array', description: 'merge 时的来源类型名/id 列表。' },
      description: { type: 'string', description: 'create/rename 时可选写描述（≤120 字）。' },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    execute(args = {}) {
      const dataDir = dataDirOf()
      const store = readStore(dataDir)
      const action = String(args.action || '').trim()
      let result
      if (action === 'list') {
        result = { action, types: listTypes(store) }
      } else if (action === 'create') {
        const type = createType(store, args.name, args.description)
        result = { action, created: type.name, typeId: type.id }
      } else if (action === 'rename') {
        const renamed = renameType(store, args.name, args.newName, args.description)
        result = { action, from: renamed.oldName, to: renamed.type.name }
      } else if (action === 'merge') {
        result = { action, ...mergeTypes(store, args.names, args.newName, args.description) }
      } else if (action === 'delete') {
        result = { action, ...deleteType(store, args.name) }
      } else {
        throw new Error(`不支持的类型动作：${action}`)
      }
      writeStore(dataDir, store)
      result.typeCount = store.types.filter((type) => type.system !== true && type.id !== 'ty_other').length
      result.typeLimit = Math.max(1, Math.trunc(Number(config.maxTypes) || 24))
      return result
    },
  })

  return [record, recall, typeTool]
}

/** 供外部（如管理/调试）复用的回报推断。 */
export { scoreOf }
