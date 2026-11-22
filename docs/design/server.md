# 服务端设计：提示词优化项目

> 描述的版本：计划中，尚未实现。按 #59 的交付计划分 PR 实现，每个 PR 合并时把对应章节改成已实现的样子。

本文把前端整体评审（2026-11-22）里定下的规则落到服务端：权限、项目类型、数据源与特征、工作流规则、异步任务、批量数据存储、配置和通知。页面的设计见 [ui.md](ui.md)，现有架构见 [../architecture.md](../architecture.md)。

## 1. 范围

- 本次只做“提示词优化”项目（代码里的 `ProjectKind = 'prompt_tuning'`）。优化好的提示词会创建训练集生产任务，那是将来的另一种项目类型（`batch_labeling`），本文只预留接口，不实现。
- 不做：审批流程、标注集删除、复制项目、人工标签导入、训练集写 Hive（做训练集项目类型时再定）。

## 2. 权限

### 2.1 权限点

只有三个权限点：

| 权限点 | 谁有 | 能做什么 |
| --- | --- | --- |
| 读 | 租户的所有成员 | 看到租户下的全部内容 |
| 项目写 | 申请后获得；项目创建者自动获得；被设为标注人时由 Sprint 直接授予 | 编辑这个项目，包括删除项目 |
| 租户写 | 租户管理员 | 租户设置、成员、模型、数据源 |

- 租户管理员也要申请项目写权限才能编辑项目。
- 任何租户成员都能创建项目，不需要租户写权限。
- 页面上只有“管理员 / 成员”两种角色；“管理员”就是有租户写权限。

### 2.2 存在哪、谁来查

- 所有权限都存在外部权限平台，Sprint 不存权限表。
- 申请和审批都在外部平台完成。Sprint 只在用户缺权限时弹出“权限不足”对话框，按钮跳到外部平台。
- 成员页面的添加和移除保留，由 Sprint 调外部平台的接口写入。
- 每个后端请求带用户信息，由网关按接口所需的权限点校验。
- 后端内部也要校验一次（`AuthorizationPort`），读和写都校验，因为 AI 工具调用（包括 AI 的读工具）和异步任务不经过网关。异步任务以入队人的身份执行，执行时按 `JobContext` 校验。
- **租户隔离**：网关只知道接口要什么权限点，不知道某个 `projectId` 属于哪个租户。所以服务端每个按 `projectId` 读或写的入口都要校验 `project.tenantId === ctx.tenantId`，`listProjects` 按 `ctx.tenantId` 过滤。用户被移出租户后，AI 的读工具也会被拦下。
- **系统自己触发的工作**：定时巡检（`workflow.sweep()`）和优化器不是某个用户发起的。巡检按项目取出 `project.tenantId`，以内部系统调用方（`caller = 'system'`，网关外部无法伪造）的身份执行；`AuthorizationPort` 对内部系统调用方只校验租户一致，不查外部平台。优化器不再用固定的系统身份，而是把 `optimiser.run` 任务的 `JobContext`（真实入队人和租户）传给 `OptimiserHost` 的每次调用和 `reflectPrompt`。

### 2.3 代码改动

- `AuthorizationPort.allowed(ctx, {action, projectId})` 已有，但 `createWorkflow` 还没有接入，现在是全放行的替身。要在 `createWorkflow` 里接入，在每个读和写操作前调用，包括 AI 工具宿主（`agentToolHost`）的读工具。
- 每个 `service.method` 标注所需的权限点（读 / 项目写 / 租户写），生成一张表给网关用。
- `Project` 加 `tenantId`（必填）。
- 新增 `PermissionAdminPort`，给成员页面和“设为标注人”用，替身实现放在 `packages/platform`：
  - 租户：`listTenantMembers(tenantId)`、`addTenantMember(tenantId, userId, role)`、`removeTenantMember(tenantId, userId)`、`setTenantRole(tenantId, userId, role)`，`role` 是 `admin` 或 `member`。
  - 项目：`listProjectWriters(tenantId, projectId)`、`grantProjectWrite(tenantId, projectId, userId)`、`revokeProjectWrite(tenantId, projectId, userId)`。
  - 每个方法都是幂等的，重复调用结果一样。
- **外部授权失败时**：授权调用自动重试 3 次。设标注人时先授权、成功后再保存，授权失败就不保存并提示用户。创建项目时先建项目、再给创建者授权，授权失败就删掉刚建的项目并提示用户，不会留下一个创建者进不去的项目。

## 3. 数据源与特征

- 一个文件就是一个数据源，只支持 CSV 和 JSONL，每行一个样本 ID（字段名 `id`）。数据源不能替换文件，要换就重新上传一个。
- 只有租户管理员能添加数据源。
- 上传后由 `source.ingest` 任务读取：去重、统计“重复的 ID”和“没有 ID 的行”，整理成一个 ID 文件放对象存储。某行没有 ID 时任务失败，原因写成“第 1,204 行没有样本 ID”。
- 加入数据集时，异步任务按样本 ID 调特征接口（`ExampleSource.lookup`，每批 `dataset.featureBatch` 个）取全部特征，写成特征快照存对象存储（见第 6 节）。
- 不做字段映射：特征的名字和类型都以特征接口为准。

## 4. 工作流规则

### 4.1 每一步什么时候算完成

没有审批，满足条件就打勾：

| 步骤 | 完成条件 |
| --- | --- |
| 提示词设计 | 保存过一个版本。保存至少要有标签名和一个带定义的标签值 |
| 数据集 | 至少有 1 条样本 |
| 人工标注 | 所有标注集都标完 |
| 提示词调优 | 有一个版本达到全部阈值 |

### 4.2 数据集和标注集

- 样本有固定序号，从 1 开始，永不改变。移除只打标记（软删除），序号不移位；被移除的样本在标注集里看不到，也不参与任何指标。可以从“已移除”里恢复。
- 标注集是数据集的一段连续样本，互不重叠，范围创建后不能改，也不能删除。
- 本次每个标注集只有一个标注人。设为标注人时 Sprint 直接给他项目写权限。
- 创建标注集或添加标注人时发通知（第 8 节）。

### 4.3 分数

- 所有标注集都标完才算分，只用标注集里的样本。
- 改了标签值，受影响的人工标签会被清空（保留为隐藏的提示）。保存前确认框显示要清空多少条。
- 算分依据（人工标签、阈值、样本）变了之后，历史版本的分数不会自动重算。提示词调优页显示横幅，用户点 Rescore 重算。新建的任务自动用新依据。

### 4.4 优化器

- 一启动就创建并显示一个新版本。
- 每次尝试都是一个 `PromptVersion`，被丢弃只改状态，不删除。
- 每一轮的打标是一个单独的打标任务，和普通打标任务进同一个队列（第 5 节）。
- 现在 `optimiser.run` 是一个长驻任务，在进程里直接调用打标（`OptimiserHost.label` → `labeling.runTask`），不经过队列。要改成分轮的链式任务，避免两种问题：父任务占着 endpoint 的唯一名额又等子任务（死锁），或者优化器打标绕过 endpoint 的并发上限。
  1. `optimiser.run` 只做计算（生成候选、比较分数、决定下一轮），并发键是“租户 + compute”。
  2. 一轮里每个要打标的候选都入队一个 `labeling.runTask`（“租户 + endpoint”），然后这一轮的 `optimiser.run` 结束，不等待。
  3. 每个打标任务结束时检查这一轮的打标是否都结束了；都结束就入队下一轮的 `optimiser.run`（幂等键是 `运行 ID + 轮次`，只会入队一次）。
  4. 停止优化器 = 取消排队中的打标任务并标记这次运行已停止，下一轮不会再入队。

## 5. 异步任务

### 5.1 两类任务

| 类型 | 例子 | 并发键 | 并发上限（默认） |
| --- | --- | --- | --- |
| 模型任务：要用模型资源 | 打标、优化器每一轮的打标、AI 评估 | 租户 + endpoint | 1（按创建时间先后执行） |
| 常规任务：只要计算资源 | 数据源读取、抓特征写快照、算分、Rescore、删除项目 | 租户 + `compute` | 10 |

- 同一个 endpoint 配到多个租户时，各租户的资源量独立，不共享。
- AI 评估用对话 endpoint，所以有自己的队列，不会排在打标后面。Ask AI 对话是即时请求，不进队列，只受网关限流。
- 任务内部同时发几个请求，由网关按 QPM / TPM 自动调节，不属于任务并发。

### 5.2 队列和 worker

- 任务存在 MySQL 的 `jobs` 表，按 `concurrency_key` 区分。另有一张 `job_keys` 表，每个键一行，只用来加锁。
- 并发上限从配置读（第 7 节），不存在表里。
- 先不引入消息队列。worker 每 1 到 2 秒轮询一次，有任务就一直取，直到没有空位或没有任务。
- 入队时用 `INSERT IGNORE INTO job_keys` 建好这个键的行，否则新键永远不会被取到。
- 每个 worker 进程跑同一个循环，不需要按 endpoint 起队列。一次取任务分两段：
  1. 先不加锁地列出候选键：有排队任务、任务类型是本 worker 注册过的（`kind IN (...)`）、运行数小于上限的键，按 `last_claimed_at` 排序。
  2. 按顺序逐个试，每个键一个短事务（隔离级别 READ COMMITTED，避免读到旧快照）。这个键满了或被别人锁着就试下一个，直到取到一个任务或候选键用完。这样一个满了的键不会挡住后面的键。

```sql
-- 第 1 段：候选键（不加锁）
SELECT j.concurrency_key, COUNT(*) AS queued
  FROM jobs j JOIN job_keys k ON k.concurrency_key = j.concurrency_key
 WHERE j.state = 'queued' AND j.kind IN (?)
   AND (j.not_before IS NULL OR j.not_before <= NOW())
 GROUP BY j.concurrency_key, k.last_claimed_at
 ORDER BY k.last_claimed_at;
-- 程序里再去掉运行数已达上限的键（上限从配置读）

-- 第 2 段：对每个候选键
BEGIN;
SELECT concurrency_key FROM job_keys WHERE concurrency_key = ? FOR UPDATE SKIP LOCKED;  -- 拿不到锁就换下一个键
SELECT COUNT(*) FROM jobs WHERE concurrency_key = ? AND state = 'running';             -- 不小于上限就提交并换下一个键
SELECT id FROM jobs WHERE concurrency_key = ? AND state = 'queued' AND kind IN (?)
   AND (not_before IS NULL OR not_before <= NOW())
 ORDER BY created_at, id LIMIT 1 FOR UPDATE;
UPDATE jobs SET state = 'running', lease_owner = ?, lease_until = ?, attempts = attempts + 1 WHERE id = ?;
UPDATE job_keys SET last_claimed_at = NOW() WHERE concurrency_key = ?;
COMMIT;
```

- 键行上的锁保证同一个键同时只有一个 worker 在判断空位，运行数是现算的，不会漂移。
- 按 `last_claimed_at` 排序让各个键轮流被取，一个键排了很多任务也不会饿死别的键。
- 需要的索引：`jobs(concurrency_key, state, created_at)`。
- 排队位置 = 同一个键下创建时间更早的排队任务数，页面显示“Queued · 2 ahead”。
- 取消排队中的任务直接改状态，不产生费用。

### 5.3 失败规则

下层先自己重试，不过才往上报：

1. 单次模型调用：模型忙、被限流、超时或服务端出错时，网关重试最多 4 次（`gateway.retryDelaysMs`）。还不行，这条样本记为失败。答案解析不出来记为“无效答案”，被安全过滤拦下记为“已过滤”，都不算失败，不会阻止算分。和现在一样，这两类不计入 Macro-F1 / Precision / Recall，单独统计：无效答案率参与达标判断，已过滤只计数。
2. 一个打标任务：失败超过总数的 5%（`labeling.maxFailedShare`），或连续 20 条失败（`labeling.maxFailedInARow`），立刻停下标为 Failed。跑完时还有失败的样本也标为 Failed，因为缺答案没法算分。Retry 只重打失败的那些，已完成的保留，重试排到队尾。提示词版本被删、模型被移除这类配置问题直接 Failed，不重试。
3. 执行进程：worker 30 秒没有心跳，任务放回队列，从已保存的答案接着跑；失联 3 次（`maxAttempts`）标为 Failed。用户看不到这一层。

常规任务：存储或接口的偶发错误自动重试 3 次；数据本身的问题不重试，直接 Failed 并写明原因。页面统一显示 Failed、一句原因和 Retry。

### 5.4 代码改动

- `JobRequest` 加 `concurrencyKey`，由入队方按第 5.1 节算出。
- `JobStorePort.claimNext` 改为按键限并发：参数加上限查询函数，MySQL 实现用上面的 SQL；内存替身按同样的规则实现，并补一致性测试。
- 现在的打标状态 `needs_attention` 在页面上统一显示为 Failed。
- `apps/jobs` 的进程总并发（默认 16）保留，作为单个进程的上限。

## 6. 批量数据存储

原则：要按条查询、筛选、修改的放 MySQL；写一次、整批读的放对象存储，MySQL 只存指针。

| 数据 | 存储 | 说明 |
| --- | --- | --- |
| 上传的数据源文件 | 对象存储 | 原文件 |
| 数据源的样本 ID 列表 | 对象存储，MySQL 存条目数和状态 | 只在加入数据集时整批读 |
| 数据集样本（序号、样本 ID、来源、是否移除、原因） | MySQL | 分页、筛选、软删除、恢复 |
| 特征快照 | 对象存储，按批打包成段文件；样本表存段文件和位置 | 写一次、长期保留 |
| 人工标签和评论 | MySQL | 经常修改 |
| 版本的模型答案 | 对象存储，每批写一个段文件；MySQL 存进度和段指针 | 写一次、整批读；页面把一个版本的答案整批载入 Redis 缓存 |
| 分数 | MySQL | 页面直接读 |
| 训练集（将来） | 对象存储段文件 | 平台只显示路径或对象 ID，不提供下载 |
| 对话和 AI 动作记录 | MySQL，大的工具结果放对象存储 | 按项目查历史 |
| 锁、限流计数、短期状态 | Redis | |

对应 issue #58 的几个接口：`LabelingStorePort`（打标任务和答案）、`FeatureStorePort`（`putBatch` / `getBatch` / `deleteBatch`）。

## 7. 配置模块

- 新增配置基建模块。配置从文件迁到配置平台，按字符串 key 查字符串 value。
- 新接口 `ConfigPort.get(key): Promise<string | null>`，带本地缓存（默认 30 秒过期），配置平台不可用时用缓存里的旧值。
- 现在的 `SystemConfig` 每一项对应一个 key（例如 `labeling.maxFailedShare`），值是字符串，由模块按类型解析；没配置的用 `DEFAULT_SYSTEM_CONFIG`。
- 分两层读：
  - **进程级默认值**：配置模块在服务端应用里定时刷新（`packages/domain` 是纯逻辑包，不能做 I/O），刷新后通过 `configureSystem` 注入。`systemConfig()` 仍然无参、同步，只返回进程级的值。
  - **租户级覆盖**：key 加租户前缀，例如 `tenant.<tenantId>.jobs.limit.model`。只能显式按租户读：请求的 `Scope` 和任务上下文提供 `config.forTenant(tenantId)`。不在请求里改全局值，避免并发请求之间串租户。
- 本次支持租户覆盖的只有任务并发上限（`jobs.limit.*`），其余配置项只有进程级的值。以后哪一项要按租户覆盖，再把它的调用方改成从 `Scope` 读。
- `TenantConfigPort` 由 `ConfigPort` 取代。
- 并发上限的 key：`jobs.limit.model`（默认 1）、`jobs.limit.compute`（默认 10），可按键覆盖：`jobs.limit.<tenantId>.<endpointId>`。

## 8. 通知

- 新增 `NotificationPort.send({userIds, kind, projectId, text, link})`。
- 本次的两个通知：创建标注集时通知标注人；添加标注人时通知被添加的人。
- 默认替身只写日志；具体即时通讯工具的适配器由部署方提供。

## 9. 租户和模型

- 模型在租户设置里手动填：名称、Endpoint、QPM、TPM。
- 租户有默认模型：第一个添加的模型自动成为默认，可以“设为默认”。新项目用租户默认模型。
- 被项目使用的模型不能删除。
- **网关要改**：现在 `createGateway` 启动时建一次静态的模型注册表，`LabelCallRequest` 不带租户，限流键只有 endpoint ID。要改成：
  - 模型配置按租户从模型表读取并缓存，租户新加或修改的模型不用重启就能调用。
  - `LabelCallRequest` 和对话请求带上 `tenantId`，打标和工作流调用网关时传入。
  - `LimiterStorePort` 的限流键改成“租户 + endpoint”，两个租户配同一个 endpoint 时各用各的 QPM / TPM，一个租户触发限流降速不影响另一个。

## 10. Contract 改动

按 CONTRIBUTING，每个 contract 改动单独一个 PR，标明是新增还是破坏性：

| 改动 | 类型 |
| --- | --- |
| `Project.tenantId` | 破坏性：现有记录要迁移 |
| `PermissionAdminPort` | 新增 |
| `JobRequest.concurrencyKey`、`claimNext` 按键限并发 | 破坏性：部署方的 `JobStorePort` 要改 |
| `ConfigPort`，移除 `TenantConfigPort` | 破坏性 |
| `NotificationPort` | 新增 |
| `OptimiserHost` 每次调用和 `reflectPrompt` 带 `JobContext`；`OptimiserHost.label` 改为入队打标任务 | 破坏性 |
| `LabelCallRequest` 和对话请求带 `tenantId`；模型按租户读取；限流键改为“租户 + endpoint” | 破坏性：部署方的网关适配和限流存储要改 |
| `LabelingStorePort`、`FeatureStorePort` | 新增（issue #58） |
| 样本序号和软删除、标注集 | 新增 |

## 11. 交付计划

#59 是父 issue，下面每一步对应一个子 issue 和一个 PR，一个合并了再开下一个：

1. 配置模块：`ConfigPort` 和替身，进程级刷新、`config.forTenant`。
2. 权限和租户隔离：`Project.tenantId`、`createWorkflow` 读写都接入 `AuthorizationPort`、按租户过滤和校验、系统调用方规则、接口权限点表、`PermissionAdminPort`。放在任务队列前面，因为并发键要用到项目的租户。
3. 任务队列：`concurrencyKey`、按键限并发的 `claimNext`、排队位置、失败状态统一。
4. 模型和网关：模型按租户读取、请求带 `tenantId`、限流键改为“租户 + endpoint”。
5. 优化器改为分轮链式任务：`OptimiserHost` 带 `JobContext`，每轮打标入队。
6. 通知端口。
7. 存储接口：`LabelingStorePort`、`FeatureStorePort`（issue #58）。
8. 数据集和标注集：样本序号、软删除、标注集、清空受影响的人工标签。
9. 分数和 Rescore：标注集全部完成才算分、Rescore 横幅所需的“分数是否过期”。

前端按 shell / 导航 → 租户和项目 → 数据源 → 第 1 到 4 步的顺序另开 PR，在对应的后端 PR 合并之后做。

## 12. 待定

- 训练集是否写 Hive（做训练集项目类型时再定）。
- 外部权限平台的接口格式，等对接时确认。
