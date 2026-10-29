# dsh-exp-lib-provider

把「经验库」做成 **dsh-mnemon 的一个记忆空间 Provider**：空间由一个 JSON 文件存储，面板可观可管，模型的写入只走 `exp_record`，读取走 `exp_recall` 或记忆插件的通用检索（同一套语义）。排序分两种模式：有成败对照时按 JitRL 优势（`Â = Q̂ − V̂`）；没有对照时明说「Â 不具区分度」，改按证据强度排序——不假装有区分度。

## 它提供什么

| 项 | 值 |
|---|---|
| `typeId` / 包名 | `exp-lib` / `dsh-exp-lib-provider` |
| 形态 | 本地 Provider（`locality: local`，`workspaceBinding: optional-override`） |
| 能力 | search / browse / graph / entities / forget；**remember: false**；`writeMode: exact`、`deletionMode: soft` |
| 配置字段 | `dataDir`（可选，默认 `$DSH_HOME/exp-lib/provider-data`，支持 `~` 开头；一般不用配，跟随记忆引擎里的设置） |
| 工具 | `exp_record`、`exp_recall`、`exp_type`（与本 Provider 共用同一份数据） |
| 数据 | `<dataDir>/exp-lib.json`：`{ version, types[], experiences[] }` |

## 安装

前置：DSH 里已装 `dsh-mnemon`（记忆插件）。本包是它的记忆空间 Provider，同时也自己注册三个工具，所以装法是「普通插件」+「挂一次 Provider」。

```powershell
# 1) 装进目标 profile（tgz 文件，或 git 仓库地址）
dsh plugin --profile <profile> add ./dsh-exp-lib-provider-0.2.2.tgz
```

> 为什么用 tarball 而不是目录：`dsh plugin add <目录>` 会做 pnpm link，运行时按真实路径解析依赖，宿主提供的 `dsh-mnemon-source-memory-spaces` 会找不到。tarball 装的是包副本，依赖从 profile 的 `node_modules` 解析。**改完代码要重新 pack + add 才会生效。**

2) 在插件管理里启用 `dsh-exp-lib-provider`。`dsh plugin add` 只是转发 pnpm，不会把包写进 `dsh.profile.bundles`；没启用的话三个工具和每轮提示段都不会出现。

3) 把 Provider 挂进 memory-spaces（一次性；改前备份 profile 的 `cordis.patch.yml`）。在已有的 `- id: mnemon-source-memory-spaces` 条目里，给 `providers` 列表末尾补一条：

```yaml
      - use: dsh-exp-lib-provider
        instanceId: exp-lib
```

   - 数据目录不用写在这里：装完在面板里建空间，再在「记忆引擎 → Provider → 经验库」里设路径，工具会自动跟随（见下节）。
   - 只有记忆插件用了自定义存储根、自动找不到 `memory-providers.json` 时，才在这里补 `config: { mnemonDataDir: ~/.mnemon }`。

4) 重启 DSH。

## 两层开关（都能在界面里启停）

| 层 | 位置 | 控制什么 |
|---|---|---|
| **DSH 插件** | 插件管理（bundles 里能看到 `dsh-exp-lib-provider`） | 工具面：`exp_recall` / `exp_record` / `exp_type` 是否可用 |
| **记忆 Provider** | 记忆引擎 → Provider 列表里的「经验库」 | 存储/空间：这个 Provider 是否参与记忆空间 |

装好后两处都要开：插件管理里启用插件；记忆引擎里把「经验库」的开关打开。Provider 卡片显示「未启用」是正常的，点右侧开关即可。

## 数据目录从哪来（优先级）

工具面与 Provider 读的是同一份配置：

1. 记忆引擎里「经验库」Provider 的数据目录（`memory-providers.json` 的 `services["exp-lib"].dataDir`）——改了它，工具自动跟随；
2. 读不到时退回插件 `cordis.patch.yml` 里的 `dataDir`；
3. 再退回默认 `$DSH_HOME/exp-lib/provider-data`（宿主没注入 `DSH_HOME` 时用 `~/.dsh`）。

`memory-providers.json` 按顺序找：`mnemonDataDir` 配置 → `DSH_MNEMON_DATA_DIR` → `MNEMON_DATA_DIR` → profile 的 `cordis.patch.yml` 里记忆插件条目的 `dataDir` → 工作区 `.mnemon` → `~/.mnemon`。所以**记忆插件用默认或自定义存储根都能自动找到**，换机器不用重新打包，改面板里的路径即可。

## 创建空间

重启后：**记忆插件 → 记忆空间 → 新建**，选 Provider「经验库」，名称填 `经验库`，描述用默认或自己写：

> 存放工作的经验：每条记录做法与结果，按 JitRL 优势召回，供接同类任务前参考。

启用后，模型的数据会写在 `<dataDir>/exp-lib.json`。

## 每轮提示层

插件启用时会向系统提示追加一段有界文本（`order: 160`）：类型目录 + 用法提示（`exp_recall` / `exp_record` / `exp_type`）。提示里明确要求「成功/失败/被纠正都要记，同一意图换做法时复用同一 intent」，否则库里只有成功样本、排序永远没有区分度。内容每轮动态读当前数据文件，条数会跟着变；`config.hint: false` 可关掉。它不经过记忆组合（不需要 scoped 策略），**禁用插件即消失**。

## 类型：不预设，按需创建 + 四道限制

安装后只有系统兜底类型「未分类」。业务类型由模型在 `exp_record` 时给名字，必要时自动创建；为防止「无限分类」有四道限制：

1. **规范化与长度**：NFKC、去控制字符、压缩空白，2–16 字符；
2. **近似合并**：与已有类型互为子串，或字符二元组 Jaccard ≥ 0.8 → 归到已有类型，不新建；
3. **泛化名归兜底**：其他 / 其它 / 杂项 / 随便 / 未分类… 直接归「未分类」；
4. **数量与频率**：业务类型上限 24 个（`config.maxTypes`），每天最多新建 6 个（`config.newTypesPerDay`），超限归「未分类」并在返回里给 `typeWarning`。

`exp_record` 新增可选 `typeDescription`（≤120 字）：新建类型时写清“收什么、召回怎么用”；复用已有类型时忽略。返回里带 `typeCreated` / `typeMergedInto` / `typeWarning` / `typeCount` / `typeLimit`。

> 升级不会删已有库里的类型；新环境从「未分类」开始。

### 类型管理工具 `exp_type`

| action | 作用 |
|---|---|
| `list` | 列出类型与使用条数（system 排最后） |
| `create` | 新建类型（`name` + 可选 `description`） |
| `rename` | 改名，引用它的经验同步更新 |
| `merge` | `names[]` 合并到 `newName`（不存在会新建），经验批量改挂、源类型删除 |
| `assign` | `id` + `name`：把**单条**经验改挂到指定类型；不动 `hits`，不新增条（修「记错类型」用） |
| `delete` | 删除类型，经验归「未分类」；系统类型不可删 |
## 语义

- **写入唯一入口**：`exp_record(intent, action, outcome?, type?, note?)`
  - 重复（同做法、相似度 ≥ 0.9）→ 就地更新 `hits / outcome / note`；
  - 近似替换（同意图、同类型、不同做法）→ 新条 + 旧条 `superseded_by`，**但只在两边都是正回报时才取代**：一旦有一条失败，两条都留着当对照（否则库里永远没有负样本）；
  - 其他 → 追加。
- **写入卫生**：`note` / `intent` / `action` 里混进的工具调用残渣（`</note>`、`<parameter name="type">…`）会被剥掉；若 `type` 丢了但残渣里有，会**捞回来**（返回值 `noteSanitized` / `typeRecoveredFromNote`）。真实踩过：一条 PPT 经验因为残渣掉进「未分类」，`ty_ppt` 计数一直为 0。
- **读取**：`exp_recall(intent, limit?)` → 召回层 v2 检索邻居 → 排序。返回值顶层的 `mode` 说明用了哪套口径：
  - `advantage`：邻居里有成败对照（advantage 极差 ≥ 0.05）→ `Â = Q̂ − V̂`，`rank_score = Â × confidence`；
  - `evidence`：样本回报几乎相同（实测全是 success/accepted 时 `Â` 恒为 0）→ 改按「相似度 × 支持度 × 证据质量」，并在 `note` 里写明「Â 不具区分度」。
  默认过滤已删与已被取代的旧条；召回为空时 `note` 会说明「没有相似度 ≥ 0.12 的历史经验」。
- **召回层 v2**（`retrieval.js`，与 kernel 的论文数学解耦）：
  - 相似度 = 0.4 查询覆盖 + 0.25 对称 Jaccard + 0.2 artifact 覆盖 + 0.15 二元组 Jaccard；
  - artifact 按语义组归一（`ppt` / `doc` / `sheet` / `code` / `git` / `env` …）：`pptx`、`幻灯片`、`课件` 都算 ppt，`任务单`、`任务卡`、`教案` 都算 doc；
  - 只共享单个汉字不算信号（`sharesSignal`），避免短查询靠虚词拼出假分数。
  旧实现用对称 Jaccard：「做个研学课 PPT」在 17 条真实库上**召回过阈 0/17**（最强 0.0375 < 0.05）；v2 上真实库 17/17 top-1、5 条噪声意图 0/5。
- **通用 `remember` 被禁用**：面板不出现通用写入入口；若宿主仍调用，返回错误提示改用 `exp_record`。
- **契约：adapter 方法一律 async**（返回 Promise）——`discover / status / search / list / graph / entityIndex / remember / forget`。memory-spaces 会把返回值直接当 Promise 用（`untilAborted(discover())`、`status().catch(...)`），同步值会报 `… is not a function`；这类坑已踩过两次（2026-10-29 的 discover 与本日的 status）。
- **忘记 = 软删墓碑**：`deleted_at` 置位，保留 30 天后启动时清理；`forget` 后检索与内容页都不再显示。
- **回报口径只有一份**：`store.scoreOf` 直接用 kernel 的 `OUTCOME_SCORES`（accepted +1.0 / success +0.8 / partial +0.3 / unknown 0 / failed −0.6 / corrected −0.8 / aborted −1.0）。此前 store 自己写了一套（success 也按 1.0、aborted 按 −0.3），和文档/内核都对不上。

## 面板能看到的

| 位置 | 数据 |
|---|---|
| 记忆 Provider 列表 | 经验库（exp-lib）开关与 `dataDir` 配置 |
| 记忆空间 → 检索 | JitRL 优势排序结果 |
| 记忆空间 → 内容 | 全部可见经验（类型、结果、备注） |
| 记忆空间 → 实体 | 意图/做法里的高频词 |
| 记忆空间 → 图谱 | 经验节点 + 「取代」边 |
| 删除 | 软删（可恢复；TTL 后物理清理） |

## 测试与体检

```powershell
npm test                          # 76 项断言（在开发工作区跑，GitHub 发布树不含 tests/）
node tools/audit.mjs <dataDir>    # 只读体检，有问题退出码 1
```

**76 项全绿**：kernel 19 / recall 11 / store 14 / provider 13 / tools 7 / plugin 5 / type-tool 7。

- `tests/kernel.test.mjs` 是**与 Python 参考实现的逐字段对拍**（fixture 由 `jitrl_memory.py` 生成）。改 kernel 的论文数学要同步改 Python 并重生成 fixture；
- `tests/recall.test.mjs` 是 2026-10-29 加的回归面：自然短意图召回、artifact 别名归一、噪声不假召回、degenerate 降级、成败对照不被取代、写入清洗、`exp_type assign`、回报口径一致；
- `tools/audit.mjs` 把「靠人读召回输出」换成指标：类型分布、G 分布、负样本数、对照覆盖、工具残渣、固定 12 条意图的召回率。

内核（JitRL 数学）随包自带，Provider 不依赖其他插件包。

## 边界

- 只做**一个空间**：所有数据写同一个 `exp-lib.json`；多空间共用会混在一起。
- 没有单条「改内容」入口（协议没有 update）：改类型用 `exp_type assign`，改内容 = 再记一次（就地更新或取代）。
- `kernel.js` 与 `jitrl_memory.py` 保持逐字段对拍；**召回层 v2 在 `retrieval.js`**，只改「谁算邻居、相似度怎么算」，不需要动 Python 参考实现。
- 没有成败对照时，排序只能按证据强度，不能分辨「哪种打法更好」——这是数据问题，不是代码能绕过的；提示层和 `exp_record` 的回执都会提醒记负样本。
- `dataDir` 默认落在 `$DSH_HOME` 下；想放工作台内便于 Git 与备份，在记忆引擎里改一次即可，插件不强制位置。
