/**
 * 工具面：exp_record / exp_recall。
 *
 * 同一份数据、同一套语义；写入只走 exp_record（Provider 的通用 remember 被禁用）。
 * SDK 由 index.js 注入，测试用桩。
 */

import {
  rankExperiences,
  readStore,
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
      type: { type: 'string', description: '经验类型名称或 id（可选，认不得归「未分类」）。' },
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
        note: args.note,
      }, { mergeThreshold: config.mergeThreshold, replaceThreshold: config.replaceThreshold })
      writeStore(dataDir, store)
      return {
        action: result.action,
        id: result.experience.id,
        hits: result.experience.hits,
        outcome: result.experience.outcome,
        G: result.experience.G,
        typeName: result.experience.typeName,
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

  return [record, recall]
}

/** 供外部（如管理/调试）复用的回报推断。 */
export { scoreOf }
