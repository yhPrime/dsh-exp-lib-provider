# dsh-exp-lib-provider

把「经验库」做成 **dsh-mnemon 的一个记忆空间 Provider**：空间由一个 JSON 文件存储，面板可观可管；写入只走 `exp_record`，读取走 `exp_recall`（或记忆插件的通用检索）。

机制来自 JitRL（arXiv:2601.18510）：把「状态-做法-回报」存成非参数记忆，需要时按 **优势 Â = Q̂ − V̂** 排序；没有成败对照时明说「Â 不具区分度」，改按证据强度排——不假装有区分度。这条链对应人的经验循环：**收集 → 使用 → 更新**。

## 它提供什么

| 项 | 值 |
|---|---|
| `typeId` / 包名 | `exp-lib` / `dsh-exp-lib-provider` |
| 形态 | 本地 Provider（`locality: local`，`workspaceBinding: optional-override`） |
| 能力 | search / browse / graph / entities / forget；**remember: false**；`writeMode: exact`、`deletionMode: soft` |
| 工具 | `exp_record`、`exp_recall`、`exp_feedback`、`exp_type`（与 Provider 共用同一份数据） |
| 数据 | `<dataDir>/exp-lib.json`：`{ version, types[], experiences[] }` |

## 安装

前置：DSH 里已装 `dsh-mnemon`。

```powershell
dsh plugin --profile <profile> add ./dist/dsh-exp-lib-provider-<版本>.tgz
```

用 tarball 而不是目录：`dsh plugin add <目录>` 会 pnpm link，运行时按真实路径解析，宿主提供的 `dsh-mnemon-source-memory-spaces` 会找不到。改完代码要重新 pack + add 才生效。

2) 插件管理里启用 `dsh-exp-lib-provider`（`dsh plugin add` 不会自动写进 bundles）。  
3) 在 `cordis.patch.yml` 的 `mnemon-source-memory-spaces` 条目里给 `providers` 末尾补：

```yaml
      - use: dsh-exp-lib-provider
        instanceId: exp-lib
```

4) 重启 DSH。

**两层开关**：插件管理（工具面）与记忆引擎 → Provider 列表（存储面）都要开。

## 数据目录

工具与 Provider 读同一份配置，优先级：

1. 记忆引擎里「经验库」Provider 的数据目录（`memory-providers.json` 的 `services["exp-lib"].dataDir`）——改了工具自动跟随；
2. 插件 `cordis.patch.yml` 的 `dataDir`；
3. 默认 `$DSH_HOME/exp-lib/provider-data`。

`memory-providers.json` 按顺序找：`mnemonDataDir` → 环境变量 → profile 配置 → 工作区 `.mnemon` → cwd 祖先链 → `~/.mnemon`。换机器不用重新打包。

## 创建空间

**记忆插件 → 记忆空间 → 新建**，选 Provider「经验库」，名称 `经验库`，描述：

> 存放工作的经验：每条记录做法与结果，按 JitRL 优势召回，供接同类任务前参考。

## 提示层与类型

插件向系统提示追加一段有界文本（`order: 160`）：类型目录 + 工具用法 + 「成功/失败/被纠正都要记；同一意图换做法时复用同一 intent」；`config.hint: false` 可关。

类型不预设：模型在 `exp_record` 给名字，必要时自动创建，四道限制——规范化（2–16 字符）、近似合并（子串 / 二元组 Jaccard ≥0.8）、泛化名归「未分类」、上限 24 个（`config.maxTypes`）且每天最多 6 个（`config.newTypesPerDay`）。`exp_type` 管 list / create / rename / merge / assign / delete。

## 语义

- **写入**：`exp_record(intent, action, outcome?, type?, note?, taskId?, kind?, stepIndex?, stepTotal?, failedStep?, stepRewards?)`
  - 同做法且相似度 ≥0.9，且**回报符号相同** → 就地更新 `hits / outcome`；
  - 同意图、同类型、不同做法 → 新条 + 旧条 `superseded_by`，**只在两边都是正回报时取代**（留负样本做对照）；
  - 其余追加。
- **读取**：`exp_recall(intent, limit?)` → 召回层 v2 → 排序。`mode` 说明口径：
  - `advantage`：有成败对照（advantage 极差 ≥0.05）→ `Â = Q̂ − V̂`，`rank_score = Â × confidence`；
  - `evidence`：回报几乎相同 → 「相似度 × 支持度 × 证据质量」，`note` 写明「Â 不具区分度」。
- **召回层 v2**（`retrieval.js`）：0.4 查询覆盖 + 0.25 Jaccard + 0.2 artifact 覆盖 + 0.15 二元组；artifact 按语义组归一（ppt/doc/sheet/code/git/env），只收产物名词（`推送` 2026-11-07 已从 git 别名移除，误路由从 3 条降到 0）。
- **回报口径只有一份**：`OUTCOME_SCORES`（accepted +1.0 / success +0.8 / partial +0.3 / unknown 0 / failed −0.6 / corrected −0.8 / aborted −1.0）。
- **软删**：`forget` 置 `deleted_at`，30 天后启动清理。
- **写入卫生**：note/intent 里的工具调用残渣会被剥掉；`type` 丢了但残渣里有会捞回来。

## 机制

只覆盖三条线：**收集**（情景/程序性）、**使用**（同类线索 + Â 排序）、**更新**（误差反馈 + 衰减 + 退休/复活），外加**巩固**（候选规则）。不做：自动注入、LLM 路由/归纳、技能自动落盘、向量检索——理由与逐条对照见 `归档/过程/exp-lib-机制对齐-2026-11-07.md`。


### 用后反馈（收集之后的第一层更新）

`exp_feedback(id, helped | hurt | neutral)`：

- `G` 不是随手改的数，而是 **`GOutcome`（基准，由 outcome 决定）+ `feedback_log`（事件）** 重放出来：记录/重记只改基准，反馈历史保留；
- 事件带 `{at, result, eta}`，按 EMA 逐步重放（默认 η=0.35，`config.feedbackEta`）；`neutral` 不改 G；
- 计数（helped/hurt/neutral）终身，`feedback_log` 只留最近 20 条（先淘汰 neutral 再淘汰最老信号事件）；两者不可互推，证据里用 `feedback.window` 标窗口；
- **写时衰减**：超过 30 天（`config.feedbackDecayDays`）的事件在写入时折叠进 `GOutcome`，读时绝不折叠——G 不随日历漂移；
- 只接受 `exp_recall` 给出的 id；已删除 / 已被取代 / 已退休的条目拒绝反馈。

### 任务与步骤（人的多步经验）

一条经验可以是整条任务或其中一步：

| 字段 | 含义 |
|---|---|
| `taskId` | 任务 id；不填默认=自身 id；`kind=step` 没给时按意图自动归组（`auto_<hash>`） |
| `kind` | `task`（默认）/ `step` |
| `stepIndex` / `stepTotal` | 步骤序号与总数 |
| `failedStep` | 整条记录时失败发生在第几步 |
| `stepRewards` | 分步回报；给了它，整条 `G = min(outcome 回报, 最弱一步)`，与「一步砸了整件事没成」一致 |

统计按 `taskId` 去重（6 步任务算 1 票，另报 `steps`）；合并与取代限同任务（步骤还限同 stepIndex）；跨任务同名做法不合并。

### 生命周期（取代 / 复活 / 退休 / 删除）

- 取代：新正条取代旧正条，旧条隐藏保留（对照）；
- 复活：同一做法又做成 → 解除隐藏、`hits+1`，并**顶替现任**（当前可见的同类做法被隐掉）；
- **负样本退休**：同一做法已有成功 → 旧失败条退休（`retired_at`，软隐、不召回、不计统计）；同一做法再次失败 → 自动复活那条退休负样本，不新开重复条（从退休复活不顶替成功现任）；
- 所有生命周期事件写 `history`（`created/superseded/revived/retired/forgotten`，封顶 50）；反馈事件只留在 `feedback_log`，不重复入史。

### 证据与简报

`exp_recall` 的 evidence 带：`id/intent/action/outcome/G/note/similarity/typeName/taskId/kind/stepIndex/stepTotal/failedStep`，有反馈时带 `feedback{helped,hurt,neutral,window}`，有生命周期时带 `lifecycle{type,at,reason?}`（`hits` 与 `revived_at` 已并入 `lifecycle`，不再单列）。

`brief`（≤300 字符）给一行摘要：簇名与任务级统计、一条做法、一条反例、有复活过的提示、有反馈时的「终身计数 + 重放窗口」。

### 归纳提示

同族 ≥3 条时多返回一句 `induction`：报「本次可见 N 条｜类型｜正/负回报」，要求模型动手前先自己写一句共性——不做结论、零 LLM。`config.induction: false` 可关。

### 巩固：候选规则（不写库）

同族 ≥3 条且**同时有正负对照**时，`exp_recall` 多返回一个 `consolidated`：从正例的共同中文二元组与负例独有词里抽一条可检验的规则候选，例如「候选规则（3 条：正 2/负 1）；优先 克隆、相邻；避免 套模板。未经验证，请先自己确认再采信。」。

- 零 LLM、不写库、文本 ≤200 字符；`config.consolidation: false` 可关；
- 全成功/全失败/样本不足时不给——「哪种更好」无从谈起（对应 ExpeL 的洞察抽取，但我们不做自动技能固化成文件）。

## 分簇路由

簇是类型的派生视图（签名 = 产物/高频词/中文二元组 + 统计）。`exp_recall` 默认确定性路由：意图与簇身份相似度过 0.17 就只在主簇（+ ≥0.7×主簇的次簇）检索，否则回退全库；不调 LLM（依据 arXiv:2610.38796 §C.2：加 LLM 路由奖励无提升、成本 +8–29%）。

`exp_record` 没给类型时按同一路由自动归族。`routing: 'on' | 'shadow' | 'off'`（默认 on）。

标定集 `tests/fixtures/labeled-intents.json`（45 条），当前 **hit@1 75.6%、误路由 0、回退 11/11**，余量 0.027（扩容后必须重核）。

## 用法统计与迁移留痕

- `usage.jsonl`（零 token、可关）：四个工具每次调用一行；recall 记 hit/candidates/mode/route/route_score/limit/ids/induction，record 记 op/outcome/typeName/hits，feedback 记 result 与 G 前后，type 记 op/target；失败调用记 `ok:false`；intent/action 截 120 字、家目录折叠、凭据打码；1MB 轮转；
- `audit` 的「迁移留痕」行：读时迁移重算了几行 G、最大 Δ、样例 id（读时不落盘）。

## 测试与体检

```powershell
npm test                          # 234 项断言（开发工作区；发布树不含 tests/）
node tools/audit.mjs <dataDir>    # 只读体检，有问题退出码 1
node tools/eval-routing.mjs       # 路由标定：hit@1 / 误路由 / 回退
node tools/fix-residue.mjs [--write]  # 残渣修复，默认 dry-run
```

测试面：kernel 与 Python 参考逐字段对拍（含巩固 5 项）（`tests/fixtures/golden-advantages.json`）、召回回归、簇视图、反馈重放/衰减/台账、任务步骤、生命周期、行为模拟、归纳、用法日志、迁移留痕、页脚补丁。`audit` 覆盖类型分布、簇一致性、G 分布、负样本、对照覆盖、残渣、固定 12 意图召回率、退休/复活、迁移。

## 参考与致谢

本包不包含第三方代码；下面这些项目与论文在设计与机制上给过参照，按 MIT / 学术引用惯例致谢。逐项许可证与「参考了什么、没采用什么」见 [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md)。

- **JitRL: Just-in-Time Reinforcement Learning for LLM Agent** —— `kernel.js` 的数学来源（状态抽象、折扣回报、非参数 critic、`Â = Q̂ − V̂`）。本包注释标 **arXiv:2601.18510**；公开的 [jitrl-skill](https://github.com/babushkai/jitrl-skill) 引 **arXiv:2501.18510**，两个编号尚待核实是否同一篇，对外引用前先确认。
- [libiwolve/dsh-experience-library](https://github.com/libiwolve/dsh-experience-library)（MIT）——经验验证固化层的定位与三层检验思路。
- [creativedswork/dsh-expmem](https://github.com/creativedswork/dsh-expmem)（MIT）——经验记录的信任状态 / 取代关系只追加不改写。
- [pk14742952-AD/dsh-host-rsi](https://github.com/pk14742952-AD/dsh-host-rsi)（MIT）——L1/L2/L3 信号阶梯；用后反馈只取其中一层。
- [GIT121995/dsh-memory-gate](https://github.com/GIT121995/dsh-memory-gate)（MIT）——「检索到 ≠ 注入」与用后反馈修正置信度。
- [superSizzzz/dsh-pitfalls](https://github.com/superSizzzz/dsh-pitfalls)（MIT）——负样本档案结构与「宁可空手不给错答案」的阈值口径。
- [zilliztech/memsearch](https://github.com/zilliztech/memsearch)（MIT）——memory → skill 自进化路线的方向对照。
- [EvoMap/evolver-dsh-plugin](https://github.com/EvoMap/evolver-dsh-plugin)（MIT）——按证据分级给策略打分。
- [babushkai/jitrl-skill](https://github.com/babushkai/jitrl-skill)（MIT）——同一算法在 Claude Code 上的形态与「上下文注入近似 logit 调整」的说明。
- [Phant0Meow/dsh-meow-memory](https://github.com/Phant0Meow/dsh-meow-memory)（MIT）——分层记忆 / lesson 层 / dream 调度思路。
- [bugtakue/dsh-ronge-adaptive-skill-archive](https://github.com/bugtakue/dsh-ronge-adaptive-skill-archive)（MIT）——技能推荐 + 经验权重 + 探索配额的方向对照。
- [omdsh-dev/dsh-mnemon](https://github.com/omdsh-dev/dsh-mnemon)（MIT）——本包对接的记忆空间宿主；页脚补丁作用于本机已装副本。
- 分簇路由不引入 LLM 路由器的依据：**arXiv:2610.38796** §C.2。
- **未采用**：[dsh-brainagent](https://github.com/stas130286-blip/dsh-brainagent) 为非商业许可，只读不抄。

## 边界

- 只做**一个空间**：所有数据写同一个 `exp-lib.json`。
- 簇是派生视图，不落盘；回滚 `routing: 'off'` 即可。
- 没有单条「改内容」入口：改类型用 `exp_type assign`，改内容 = 再记一次。
- 没有成败对照时排序只能按证据强度——数据问题，代码绕不过；提示层与 `exp_record` 回执会提醒记负样本。
- 反馈是自报的：它改的是排序依据，不是事实。
- `dataDir` 默认在 `$DSH_HOME` 下，想放工作台内便于 Git 备份，在记忆引擎里改一次即可。

（巩固机制的最小版见上「候选规则」；历史版本的逐条变更已移到 `归档/过程/exp-lib-README-版本史.md`。）
