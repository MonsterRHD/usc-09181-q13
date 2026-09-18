# 跨境流动性压力沙盘

为集团资金委员会在**汇率跳变、海外账户冻结、融资窗口关闭**等冲击下评估未来两周（可配 1–62 天）现金缺口的服务。

核心能力：

- **数据导入**：账户余额、到期债务、承诺额度、汇率假设；逐行校验，无效行进入 `rejected`，部分数据缺失不污染基线。
- **情景与版本**：按国家/币种/日期设定范围与压力假设；情景可复制、输入可修订，原始基线（v1）与已发布版本永不被破坏。
- **缺口计算**：逐日滚动头寸，输出 日期 × 国家 × 币种 的缺口矩阵；每一行都可追溯到具体输入记录、汇率来源与公式。
- **审批与发布**：基于角色的权限控制；只有授权角色可发布；发布后再修改必须派生新版本；提醒与导出均标注采用的版本。
- **并发与恢复**：乐观锁防止并发编辑互相覆盖；计算任务入队即落盘，应用重启后未完成任务自动续跑，已发布报告原样恢复。

## 运行

```bash
npm start                 # 默认端口 3000，数据目录 ./data
PORT=8080 DATA_DIR=/var/sandbox npm start
npm test                  # 验收测试（19 个用例）
```

所有接口（除 `/health`）都需要请求头 `x-user-id` 与 `x-role`（接入企业 SSO 时在 `src/app.mjs` 替换为令牌校验）。

## 角色与权限

| 角色 | 权限 |
| --- | --- |
| `viewer` | 只读：结果、提醒、导出、审计 |
| `analyst` | viewer + 数据导入、情景/版本编辑、计算、撤销额度 |
| `approver` | 只读 + 审批版本 |
| `publisher` | 只读 + 发布版本 |
| `admin` | 全部 |

## 主要接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/datasets/:kind` | 导入数据，`kind` ∈ `balances` / `debts` / `credit-lines` / `fx`；带 `id` 的行做替换式修订 |
| POST | `/api/datasets/credit-lines/:id/revoke` | 数据集级撤销承诺额度（只影响之后的新计算） |
| POST | `/api/scenarios` | 创建情景（含 v1 基线），可设 `baseCurrency` `startDate` `horizonDays` `scope` `adjustments` |
| POST | `/api/scenarios/:id/copy` | 复制情景为新情景，原情景不受影响 |
| POST | `/api/scenarios/:id/versions` | 派生新版本（发布后修改的唯一入口；同时只允许一个草稿） |
| PUT | `/api/scenarios/:id/versions/:n/params` | 修订参数，必须带 `baseRevision`（乐观锁） |
| PUT/POST | `/api/scenarios/:id/versions/:n/adjustments` | 整体替换 / 追加压力假设 |
| POST | `/api/scenarios/:id/versions/:n/calculate` | 计算（`?async=1` 异步，任务可在 `/api/jobs` 跟踪） |
| GET | `/api/scenarios/:id/versions/:n/result` | 计算结果，支持 `?country=&currency=&from=&to=` 过滤 |
| POST | `/api/scenarios/:id/versions/:n/approve` | 审批（approver/admin，每人限一次） |
| POST | `/api/scenarios/:id/versions/:n/publish` | 发布（publisher/admin；需有审批且计算未过期） |
| GET | `/api/scenarios/:id/versions/:n/reminders` | 缺口/到期/额度到期/缺汇率提醒，标注版本 |
| GET | `/api/scenarios/:id/versions/:n/export?format=json\|csv` | 导出，头部标注版本与发布状态 |
| GET | `/api/reminders` | 汇总所有情景最新已发布版本的提醒 |
| GET | `/api/audit` | 操作审计日志 |

## 压力假设（版本级调整项）

```json
{ "type": "freeze-account", "accountId": "BAL-0003" }
{ "type": "revoke-credit-line", "creditLineId": "CL-0002" }
{ "type": "fx-shock", "currency": "USD", "pct": 0.1 }
{ "type": "fx-override", "currency": "USD", "date": "2026-09-20", "rate": 8.0 }
```

## 计算口径

```
opening[d] = closing[d-1]；首日 opening = Σ 可用账户余额（冻结账户不计入）
debtOut[d] = Σ 到期日等于 d 的债务
creditAvailable[d] = Σ 当日有效且未撤销的承诺额度 (limit - drawn)
closing[d] = opening[d] - debtOut[d]
shortfall[d] = max(0, -closing[d])
fundingGap[d] = max(0, shortfall[d] - creditAvailable[d])
valueBase = value × fxRate(currency, d)
```

- 汇率解析顺序：`fx-override`（终态，不再叠加冲击）→ 当日精确 → 向前滚动沿用最近可用 → 向后回填（告警）→ 缺失（该币种单列 `unconverted`，不进基准币合计）。
- `fx-shock` 按 `(1+pct)` 顺序叠乘。
- 金额保留两位小数；结果内嵌**输入快照**（深拷贝），数据集后续变更不会回写已产生的结果。

## 版本与发布规则

- 每个情景至多一个草稿版本；草稿可自由修订（乐观锁 `baseRevision` 防并发覆盖）。
- 发布需满足：至少一条审批 + 当前输入已完成计算（计算后又有修改则视为过期，需重算）。
- 已发布版本不可变；任何后续修改必须通过 `POST /api/scenarios/:id/versions` 派生新版本。
- 提醒与导出均携带 `versionNo / versionState / revision / stale` 标识。

## 恢复机制

- 状态全量落盘 `./data/store.json`（临时文件 + 原子改名，写盘崩溃不留半文件；文件损坏自动备份后重建）。
- 计算任务入队即落盘；启动时 `queued/running` 任务自动重跑，已发布报告随状态直接恢复。
- `GET /health` 返回最近一次启动的恢复报告。

## 目录结构

```
src/
  server.mjs   入口：加载 → 恢复 → 监听
  app.mjs      HTTP 路由、身份与角色权限
  domain.mjs   领域用例：导入、情景/版本、审批发布、计算任务、提醒导出
  calc.mjs     缺口计算引擎（纯函数，逐行 trace + 输入快照）
  store.mjs    JSON 原子写持久化
  util.mjs     错误、日期与校验工具
test/
  sandbox.test.mjs  验收测试（缺口、版本、权限、并发、恢复）
```
