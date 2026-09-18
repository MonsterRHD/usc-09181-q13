# 跨境流动性压力沙盘

面向集团资金委员会的压力沙盘服务：在汇率跳变、海外账户冻结、融资窗口关闭等假设下，评估未来两周（可配置 1–62 天）按 **国家 / 币种 / 日期** 的现金缺口。所有假设版本化留痕，结果可追溯到每个输入与公式，会议上引用的数字以已发布版本为准。

零依赖（仅 Node ≥ 18 标准库），数据以 JSON 原子落盘，重启后可恢复。

## 运行

```bash
npm start                 # PORT=3000 DATA_DIR=./data
npm test                  # 单元 / API / 恢复测试
npm run verify            # 投产前核对：并发、撤销额度、极端汇率回放、缺口/版本/权限、恢复
```

## 概念与不变量

- **情景（Scenario）**：一次压力评估的上下文（基期、报告币种、 horizon）。
- **版本（Version）**：情景的假设快照。`draft` 可改（乐观锁），`published` 永不修改；**发布后再修改自动分叉新草稿版本**，原始基线不受复制、修订、缺失数据、跨日滚动影响。
- **输入（Inputs）**：账户余额 `balances`、到期债务 `debts`、承诺额度 `facilities`、可变汇率假设 `fxRates`、冲击假设 `shocks`（极端汇率回放 `fx`、账户冻结 `frozenAccounts`、撤销额度 `revokedFacilities`、融资窗口关闭 `financingClosed`）。
- **计算（Run）**：异步作业，对输入快照逐日滚动：今日开盘 = 昨日收盘；承诺额度随提取递减；冻结资金在生效日锁定。每个结果格带 `lineage`（公式 + 引用的输入 id），每次计算记录 `inputHash`。
- **缺失数据不致命**：缺余额按 0 计并打标，缺汇率的日期向前沿用并打标 `fx_rate_carried_forward`，完全无汇率则该桶不折算、汇总标记 `incomplete`。
- **审批与发布**：审批绑定当前 `revision`（审批后再改输入则审批失效）；只有 `publisher`/`admin` 可发布。
- **导出与提醒**：永远标注采用的版本（`情景名 · vN`）与输入哈希。
- **恢复**：每次变更同步原子落盘；重启时中断的 `running` 作业重置为 `queued` 继续执行，已发布版本与报告原样恢复。

## 角色（请求头 `x-user` / `x-role`）

| 角色 | 权限 |
|---|---|
| `viewer` | 只读 |
| `analyst` | 建情景、改草稿、复制、发起计算、导出、提醒 |
| `approver` | 审批版本 |
| `publisher` | 发布版本 |
| `admin` | 全部 |

未带 `x-user` 的变更请求返回 401，越权返回 403。

## API 摘要

```
GET    /health
POST   /scenarios                          { name, baseDate, reportingCurrency, horizonDays? }
GET    /scenarios  /scenarios/:id
POST   /scenarios/:id/copy                 { name? }        深拷贝，不动原基线
GET    /scenarios/:id/versions             /versions/:n
PUT    /scenarios/:id/versions/:n/inputs   { expectedRevision, patch }
                                           草稿原地改；已发布则 201 自动分叉新版本；
                                           revision 冲突 409
POST   /scenarios/:id/versions/:n/approve  { decision: approved|rejected, comment? }
POST   /scenarios/:id/versions/:n/publish                   需当前 revision 的通过审批
POST   /scenarios/:id/versions/:n/runs                      202 排队计算作业
GET    /runs/:id                                            作业状态与结果
GET    /scenarios/:id/versions/:n/result                    最近一次完成的结果（含 lineage）
POST   /scenarios/:id/versions/:n/exports  { type? }        导出，标注版本
POST   /scenarios/:id/versions/:n/reminders { message, audience? }
GET    /scenarios/:id/exports  /reminders
GET    /audit?scenarioId=...                                审计日志
```

### 输入格式要点

- 日期 `YYYY-MM-DD`；国家两位大写码；币种三位大写码；金额为数值。
- `fxRates[].rate`：1 单位外币 = rate × 报告币种。
- `shocks.fx[].pct`：汇率跳变幅度（`0.08` = +8%），自 `fromDate` 起乘法叠加。
- `facilities` 为窗口期内可循环提取的承诺额度，随提取递减。
- 未提供 `id` 的输入项由系统分配，用于结果追溯。

## 目录

```
src/engine.mjs   纯函数计算引擎（不修改输入）
src/domain.mjs   情景/版本/审批/发布/导出领域规则与校验
src/store.mjs    JSON 原子落盘与查询
src/jobs.mjs     计算作业队列与崩溃恢复
src/app.mjs      路由装配（createApp 供测试复用）
src/server.mjs   服务入口
scripts/preprod-check.mjs  投产前核对清单
test/            引擎、API、恢复测试
```

敏感配置放本地环境文件（`.env` 已在 `.gitignore`），运行数据默认写入 `./data`（已忽略提交）。
