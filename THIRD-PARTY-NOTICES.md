# 第三方声明与参考致谢（THIRD-PARTY NOTICES）

本仓库 / 本 npm 包 `dsh-exp-lib-provider` 以 **MIT** 许可证发布（见 [LICENSE](./LICENSE)）。

**本包不包含下表任何项目的源代码。** 下表记录的是设计与机制的参考来源，以及运行时会对哪个上游做本机补丁。若将来引入第三方代码，必须在此处补上其版权声明与许可证全文，并在文件头保留原作者信息。

## 一 参考过的项目（均为 MIT，未复制代码）

| 项目 | 许可证 | 参考的是什么 |
|---|---|---|
| [libiwolve/dsh-experience-library](https://github.com/libiwolve/dsh-experience-library) | MIT（Copyright (c) 2026 libiwolve） | 「程序性经验」与「陈述性记忆」分层的定位；三层检验（清单可见 → 触发翻书 → 抽样验证）与「空闲派活」思路——本包**未实现**空闲派活，仅在调研中对照 |
| [creativedswork/dsh-expmem](https://github.com/creativedswork/dsh-expmem) | MIT（Copyright (c) 2026 Creative DSWork contributors） | 经验记录的信任状态与「取代」关系只追加不改写；检索的 recency/importance/relevance 三因子思路（本包用 JitRL 的 Â 排序，未采用其打分） |
| [pk14742952-AD/dsh-host-rsi](https://github.com/pk14742952-AD/dsh-host-rsi) | MIT（Copyright (c) 2026 DSH HOST RSI contributors） | L1/L2/L3 信号阶梯与「未验证进隔离区」的取舍；本包 v0.4.0 的 `exp_feedback` 只取「用后回报」这一层，未实现自动捕获与隔离区 |
| [GIT121995/dsh-memory-gate](https://github.com/GIT121995/dsh-memory-gate) | MIT | 「检索到 ≠ 注入」的裁决立场；用后 helped/harmful 反馈修正置信度的思路（本包用 EMA 修正回报 G，算法与实现均为自写） |
| [superSizzzz/dsh-pitfalls](https://github.com/superSizzzz/dsh-pitfalls) | MIT | 负样本档案例（现象 / 根因 / 解法）的结构；「宁可空手也不给错答案」的检索阈值口径 |
| [zilliztech/memsearch](https://github.com/zilliztech/memsearch) | MIT（Copyright (c) 2025 Zilliz Inc.） | memory → skill 自进化路线的方向对照（本包未实现技能固化） |
| [EvoMap/evolver-dsh-plugin](https://github.com/EvoMap/evolver-dsh-plugin) | MIT | 按证据分级（L1 检查通过 / L2 改动保留 / L3 用户纠正）给策略打分的做法；本包只保留 outcome 与用后反馈两层 |
| [babushkai/jitrl-skill](https://github.com/babushkai/jitrl-skill) | MIT | 同一 JitRL 算法在 Claude Code 上的实现形态（双索引 / episode 加权 / 动态阈值）与「用上下文注入近似 logit 调整」的说明；本包 kernel 为独立实现，见下节 |
| [Phant0Meow/dsh-meow-memory](https://github.com/Phant0Meow/dsh-meow-memory) | MIT | 七层记忆与 lesson 层的分层方式；dream 整理调度思路（本包未实现） |
| [bugtakue/dsh-ronge-adaptive-skill-archive](https://github.com/bugtakue/dsh-ronge-adaptive-skill-archive) | MIT | 技能推荐 + 经验权重学习 + 探索配额的方向对照（本包未实现） |
| [omdsh-dev/dsh-mnemon](https://github.com/omdsh-dev/dsh-mnemon) | MIT（Copyright (c) 2026 dsh-external contributors） | 本包是其记忆空间 Provider 的对接方；页脚补丁针对其 `dsh-mnemon-source-memory-spaces` 客户端 bundle（见第三节） |

**明确不采用的**：[stas130286-blip/dsh-brainagent](https://github.com/stas130286-blip/dsh-brainagent) 使用 BrainAgent Noncommercial License（非商业免费、商用需协议）。本包为 MIT，不能容纳其代码；仅阅读过其机制描述，未复制任何代码，也不会复制。

## 二 论文与方法来源

- **JitRL: Just-in-Time Reinforcement Learning for LLM Agent** —— `kernel.js` 的数学映射（状态抽象、折扣回报、非参数 critic、Â = Q̂ − V̂）。本包注释标的是 **arXiv:2601.18510**；公开的 `jitrl-skill` 引用 **arXiv:2501.18510**。两者编号不一致，**尚未核实是否为同一篇的不同版本**；对外引用前须先确认，确认后本文件与 `kernel.js` 注释一并订正。
- 分簇路由的门槛与「不引入 LLM 路由器」的判断依据：**arXiv:2610.38796** §C.2（对自带相似度检索的系统加路由无一致奖励、成本 +8–29%）。

算法与思想本身不受版权保护；本包的实现是独立的，未复制上述论文作者或第三方仓库的代码。论文正文与图表的引用遵循学术引用惯例。

## 三 运行时对本机上游文件的补丁（不随包分发上游代码）

`tools/patch-memory-spaces-footer.mjs` 只做一件事：在**用户本机已安装**的 `dsh-mnemon-source-memory-spaces` 客户端 bundle 上，把页脚渲染条件从「仅 native 显示统计」改成「有 stats 就显示」，让第三方记忆空间也能显示条数/连接/大小。

- 上游 [dsh-mnemon](https://github.com/omdsh-dev/dsh-mnemon) 为 MIT，允许修改；补丁只在本机执行。
- **本包不分发、不内嵌上游文件**；脚本在用户机器上原地改、备份到 `./备份/<日期>/`，锚点找不到就报错退出，不静默改错。
- 上游升级会覆盖补丁，重跑脚本即可；卸载本包不还原补丁，需用备份恢复。

## 四 兼容性说明

上述 MIT 项目的条款与本包 MIT 相容。若未来引入 Apache-2.0 代码，需补 NOTICE 文件；若遇到 GPL/AGPL 或无许可证的仓库，则只读思路、不复制代码。本文件不是法律意见。
