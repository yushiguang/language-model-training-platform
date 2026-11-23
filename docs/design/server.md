# 服务端设计：提示词优化项目

> 描述的版本：计划中，按 #59 的交付计划分 PR 实现，每个 PR 合并时把对应章节改成已实现的样子。已实现：第 2 节（权限，#63）、第 5 节（异步任务，#66）、第 7 节（配置，#61）。

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

### 2.3 实现（#63 已完成）

**Contract**（`packages/contracts`）：

- `Project.tenantId: string`（必填）。没有这个字段的旧记录，每个工作流实例在第一次读项目前补成 `DEFAULT_TENANT`（`default`，和没有租户的调用方、数据源用的是同一个值），写回存储，重复执行结果一样。
- `PermissionPoint = 'read' | 'project_write' | 'tenant_write'`；`AuthorizationRequest = {action, permission, projectId?}`，`permission` 由工作流填好，外部权限平台的适配器只回答“这个人在 `ctx.tenantId` 下有没有这个权限点”（项目写还要看 `projectId`）。
- `SYSTEM_CALLER = 'system'`：Sprint 自己的调用方。bff 总是写自己的 `caller`，所以外部无法伪造。
- `PermissionAdminPort`（`Platform.permissionAdmin`，替身 `memoryPermissionAdmin`）：`listTenantMembers(tenantId)`、`addTenantMember(ctx, tenantId, userId, role)`、`removeTenantMember(ctx, tenantId, userId)`、`setTenantRole(ctx, tenantId, userId, role)`、`listProjectWriters(tenantId, projectId)`、`grantProjectWrite(ctx, tenantId, projectId, userId)`、`revokeProjectWrite(ctx, tenantId, projectId, userId)`。`role` 是 `admin` 或 `member`；改动方法第一个参数是 `ctx`，供外部平台审计；全部幂等。
- `AccessDeniedError`：缺权限时抛出，`code = 'forbidden'`（跨 RPC 也保留），页面据此弹“权限不足”。
- 优化器：`OptimiserContract.startRun(ctx, …)` / `execute(ctx, runId)` / `stopRun(ctx, runId)`，`OptimiserHost` 每个方法第一个参数是 `ctx`。`optimiser.run` 任务把 `job.ctx`（入队人和租户）传给 `execute`，运行里每次调用 `OptimiserHost` 和 `reflectPrompt` 都用它，不再有固定的“优化器”身份。

**接口权限点表**：`packages/domain/src/permissions.ts` 的 `WORKFLOW_PERMISSIONS`，`WorkflowContract` 每个方法一行：权限点（`null` 只要求登录，目前只有 `runtimeInfo`）和项目 id 在哪（第一个参数、请求对象的 `projectId`，或不针对项目）。类型保证新方法必须登记。网关可以直接用这张表，两边不会不一致。要点：

| 权限点 | 方法 |
| --- | --- |
| 只要登录 | `runtimeInfo` |
| 读 | 列表和读取（`listProjects`、`getProject`、`loadProjectState`、`projectStatus`、数据源列表和详情、样本、特征、不一致、预测、聊天记录、提议列表）；`createProject`（任何成员都能建）；`tick`；`sendUserMessage`（问 AI 是读，AI 要开始工作时它的工具再查项目写） |
| 项目写 | 其余改项目的方法：下一步、改名、删除、设置、取样本和增删、人工标签、复核、重建分数、建版本、打分、停止、优化器开始 / 停止 / 重试、Improve with AI、写评论、处理提议 |
| 租户写 | `createDataSource`、`addSourceFile` |

**校验在哪里做**（`apps/workflow/src/services/access.ts` 的 `authorize`）：

1. 先查权限点：调用方不是 `SYSTEM_CALLER` 且接了 `AuthorizationPort` 时，调 `allowed(ctx, {action, permission, projectId})`，不通过抛 `AccessDeniedError`。这一步在读任何记录之前，所以没有权限的人不管传哪个 id（本租户的、别的租户的、不存在的）都得到同样的拒绝，探测不出哪些 id 存在。没接 `AuthorizationPort` 时（浏览器版本）全放行；系统调用方跳过这一步。
2. 再查租户：带 `projectId` 的，读项目记录（包括正在删除的），`project.tenantId` 和调用方的租户（`ctx.tenantId`，没有时是 `default`）不一致就当作项目不存在：`getProject` / `loadProjectState` / `projectStatus` 返回 null，其余报“This project does not exist.”。项目不存在或正在删除时，contract 方法的回答和别的租户的项目完全一样（读返回 null，`tick` 什么都不做，其余报“不存在”），所以本租户的成员也探测不出别的租户有哪些 id；任务执行器和工具宿主遇到不存在的项目时交给自己的逻辑处理。

用到 `authorize` 的入口：

- `createWorkflow` 的每个 contract 方法，按表校验（`action = workflow.<方法>`）。`listProjects` 另外按调用方租户过滤。
- AI 工具宿主（`agentToolHost`）每次工具调用，以发起这一轮的用户身份：读工具要读，开始工作的工具（`try_prompt`、`score_version`、`start_optimiser`）要项目写（`action = tool.<工具名>`）。用户在一轮对话中途被移出租户，下一次工具调用就被拦下。
- 工作流的异步任务执行时，以入队人的 `JobContext` 再查一次（`action = job.<类型>`）：`report.build`、`dataset.sample`、`project.delete` 要项目写，`source.ingest` 要租户写。被拒绝的任务直接失败、不重试；被拒绝的导入会把文件标成失败。`labeling.runTask` 在打标模块里执行，不经过工作流，它的入队入口已经查过。
- `OptimiserHost` 每次调用，以运行的上下文（`action = optimiser.<方法>`），全部要项目写：只有优化器运行会调它，而运行会改项目、会花钱。启动人中途失去项目写时，下一轮第一次调用（读状态）就被拦下，不会再调付费的 AI。

**系统调用方**：`sweep()` 列出所有租户的项目，每个项目用 `systemScope(项目的 tenantId)` 推进。页面的 `tick` 先按表要求调用方有读权限，再以同样的系统身份在项目的租户里推进，所以只读的成员打开页面也能让自动开始的工作排进队列，这些工作执行时只校验租户。

**创建项目**：先建项目和默认设置，再调 `grantProjectWrite(ctx, tenantId, projectId, 创建者)`，失败后再试 3 次（等待 200 ms 起翻倍）；还失败就删掉刚建的项目，提示“项目没能创建，再试一次”。重试工具 `withRetries` 第 8 步“设为标注人”也用：那时先授权，成功后再保存。

**没做的**：成员页面的接口和前端（前端 PR）；网关侧的校验（部署方按 `WORKFLOW_PERMISSIONS` 配置）。

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
  1. `optimiser.run` 只做计算（生成候选、比较分数、决定下一步），并发键是常规任务的键。
  2. 运行按状态机推进，位置是 `(runId, round, step)`；`step` 是一轮里的各个打标阶段（`parent`、`dry_run`、`full`、`confirm`）。每个要打标的阶段入队一个 `labeling.runTask`（模型任务的键），`args` 里带 `optimiserRunId`、`round`、`step`，然后这次 `optimiser.run` 结束，不等待。
  3. 打标任务结束（完成、失败或取消）时，入队下一次 `optimiser.run`，幂等键是 `runId + round + step`，只会入队一次。`optimiser.run` 读到打标失败，就把运行标为 Failed，用户可以 Retry。
  4. 巡检不能把等打标的运行误标为“已暂停”：判断孤儿运行时，除了看有没有活跃的 `optimiser.run`，还要看有没有带这个 `optimiserRunId` 的活跃打标任务。两样都没有时，巡检按最后一个打标任务的结果推进运行，或把运行标为 Failed。这也覆盖了 worker 失联 3 次、任务直接被标为失败的情况。
  5. 停止优化器：取消这次运行下所有排队中和运行中的打标任务和 `optimiser.run`，直接把运行状态存为“已停止”，不依赖进程内存。运行中的打标任务收到取消后停下，不再调用模型。

## 5. 异步任务

### 5.1 两类任务

| 类型 | 例子 | 并发键 | 并发上限（默认） |
| --- | --- | --- | --- |
| 模型任务：要用模型资源 | 打标、优化器每一轮的打标、AI 评估 | 租户 + endpoint | 1（按创建时间先后执行） |
| 常规任务：只要计算资源 | 数据源读取、抓特征写快照、算分、Rescore、删除项目 | 租户 + `compute` | 10 |

- 并发键带类型前缀：模型任务是 `model:<tenantId>:<endpointId>`，常规任务是 `compute:<tenantId>`。ID 用的是系统生成的租户 ID 和模型配置 ID，不是用户填的 Endpoint 文字，所以不会撞名，也不会被分隔符打乱。
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

### 5.4 实现（#66 已完成）

- **并发键**：`JobRequest.concurrencyKey` / `Job.concurrencyKey` 必填，类型是 `ConcurrencyKey`（`packages/contracts/src/jobs-api.ts`）。`packages/domain` 的 `jobConcurrencyKey(tenantId, target)` 拼键、`parseConcurrencyKey(key)` 反解；租户 ID 不能含 `:`，endpoint ID 是第二个 `:` 之后的全部。入队方在 `apps/workflow/src/services/queue.ts` 用 `modelKey` / `computeKey` 算，租户取调用方的（`authorize` 已经校验过它就是项目的租户）。`labeling.runTask` 和 `optimiser.run` 是模型任务（第 5 步之前优化器在自己的任务里直接打标，所以先占它的 endpoint），其余是常规任务。endpoint ID 现在是项目设置里的 `EndpointId`，第 4 步换成按租户的模型配置 ID。任务模块拒绝入队格式不对的键。
- **按键限并发**：`JobStorePort.claimNext(kinds, owner, leaseMs, now, limitOf)`。任务模块的 `limitOf` 反解键，调 `config.forTenant(tenantId).jobLimit(target)`，每次取任务都现读，调大上限立刻生效。内存替身按 5.2 的两段实现：先列出候选键并读好上限（不加锁），再逐个键在不 `await` 的一段里数运行数、取最早的任务（这一段相当于持有键行锁的短事务）。键按上次被取的时间轮流（从没取过的排最前），键内按 `createdAt`、再按 `id`。任务 ID 按时间可排序，同一个 worker 同一毫秒入队的任务也按先后执行。进程总并发（默认 16）保留。
- **排队位置**：`JobStorePort.countAhead(concurrencyKey, createdAt, id)`（比设计多一个 `id`，同一毫秒创建的任务按取任务的顺序算），`JobsContract.ahead(ctx, jobId)`（不在排队时是 null）。工作流的 `loadProjectState` / `projectStatus` 给排队中的打标任务（`LabelingRun.queue`）和优化器运行（`OptimisationRun.queue`）加上 `{ahead}`，只出现在页面视图里，记录和工作流自己的规则看不到。Prompt Tuning 页面显示 “Queued” 或 “Queued · 2 ahead”（排队中 · 前面还有 2 个），优化器面板显示“在等模型空出来”。
- **`finally`**：`JobRequest.finally` 在任务以完成、失败、取消结束时入队一次，幂等键默认 `finally:<jobId>`；`paused` 不是终态，不触发。巡检判失败或取消、排队中直接取消的任务也会触发，所以 `recoverExpired` 返回它结束的任务（`ended`），`requestCancel` 返回 `{job, ended}`。`then` 仍然只在完成时入队。
- **失败状态统一**：打标的 `needs_attention` 在页面视图里显示为 Failed（`apps/workflow/src/services/views.ts` 的 `jobState`），打标执行器也按失败结束任务，有测试锁住。打标任务被停止时的终态统一为 `cancelled` 在第 5 步做。
- **一致性测试**：`packages/platform/src/standins/job-store.test.ts` 的 `jobStoreCases(name, make)` 只依赖 `JobStorePort`，部署方的 MySQL 实现可以复制过去跑同一组用例。

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

所有放对象存储的数据共用一个通用接口 `ObjectStorePort`（`packages/contracts/src/platform-api.ts`，内存替身 `memoryObjectStore()` 放在 `packages/platform`）：

```ts
export interface ObjectStorePort {
  put(key: string, body: Uint8Array | string, opts?: {contentType?: string; contentEncoding?: string}): Promise<{key: string; size: number}>;
  get(key: string): Promise<Uint8Array | null>;
  /** 按字节范围读，用于打包的特征段和答案段（HTTP Range GET）。 */
  getRange(key: string, offset: number, length: number): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  deleteBatch(keys: string[]): Promise<number>;
  /** 可选：按需生成带签名的链接，用于图片或预览。 */
  signUrl?(key: string, expiresSec?: number): Promise<string>;
}
```

数据源的 ID 文件、特征快照段、答案段、大的工具结果和将来的训练集都建在它上面。issue #58 的 `LabelingStorePort`（打标任务和答案）和 `FeatureStorePort`（`putBatch` / `getBatch` / `deleteBatch`）也基于同一个 `ObjectStorePort` 适配器实现。

## 7. 配置模块

已实现（#61）。配置从文件迁到配置平台，按字符串 key 查字符串 value。

### 7.1 接口

`packages/contracts/src/platform-api.ts`：

```ts
export interface ConfigPort {
  /** 没配置的 key 返回 null（不抛“找不到”类错误）；配置平台不可用、超时或读取出错时抛错，由 Sprint 的缓存层接住并继续用旧值。 */
  get(key: string): Promise<string | null>;
  /** 可选：一次读多个 key，用于启动和定时刷新。 */
  getMany?(keys: string[]): Promise<Record<string, string | null>>;
  /** 可选：配置平台推送变更时回调，缓存马上作废。返回取消订阅的函数。 */
  subscribe?(onChange: () => void): () => void;
}

export type JobLimitTarget = {kind: 'model'; endpointId: string} | {kind: 'compute'};

export interface TenantConfig {
  /** 读 `tenant.<tenantId>.<key>`；没配置返回 null。平台不可用时用上次读到的值，从没读到过才抛错。 */
  get(key: string): Promise<string | null>;
  /** 任务并发上限，按 7.3 的顺序找，不抛错。 */
  jobLimit(target: JobLimitTarget): Promise<number>;
}

export interface ConfigReader {
  /** 没有租户时只用进程级的值。 */
  forTenant(tenantId: string | undefined): TenantConfig;
}
```

- `Platform.configStore?: ConfigPort` 是配置平台的适配器，替身是 `@yushiguang/sprint-platform` 的 `memoryConfig()`（进程内的 map，测试可以模拟推送和故障）。
- `TenantConfigPort` 和 `Platform.tenantConfig` 已删除。
- 很多配置平台要求事先登记固定的 key，不能按“租户 × endpoint”临时造 key。适配器可以把所有逻辑 key 放进配置平台里的一个 JSON 映射 key，Sprint 只认逻辑 key。

### 7.2 key 和值

- `SystemConfig` 每个叶子对应一个 key，就是它的点号路径，例如 `labeling.maxFailedShare`、`gateway.unknownModelLimits.tier`。key 不固定的映射整体是一个 key：`gateway.assumedLimits`，值是 JSON。
- 值按默认值的类型解析：数字、字符串、JSON（数组和 `gateway.assumedLimits`）。有几项查得更严：`jobs.limit.model` / `jobs.limit.compute` 必须是不小于 1 的整数，`gateway.unknownModelLimits.tier` 只能是 `fast` / `balanced` / `reasoning`，`gateway.assumedLimits` 的每一项都要有合法的 `tier` 和非负的 `qpm` / `tpm` / `maxConcurrency`。解析不了的值被忽略，用下一层的值，并通过 `onProblem` 报出来；一个坏值不影响其他 key。
- `SystemConfig` 新增 `jobs.limit.model`（默认 1）和 `jobs.limit.compute`（默认 10）。
- 规则都是 `packages/domain/src/config.ts` 里的纯函数：`systemConfigKeys`、`parseSystemConfig`、`tenantKey`、`jobLimitKeys`、`parseJobLimit`、`processConfigReader`。

### 7.3 两层读取

配置模块是新应用 `apps/config`（`@yushiguang/sprint-config`），`createConfig({port, base, ttlMs, refreshMs, onProblem})`：

- **进程级的值**：`refresh()` 读所有进程级 key（有 `getMany` 就一次读完），按“默认值 → `Platform.config` → 配置平台”的顺序合并，再通过 `configureSystem` 生效。`start()` 立刻刷新一次，之后每 30 秒一次，配置平台推送时也刷新。读失败时保留现在生效的值。`systemConfig()` 仍然无参、同步，`packages/domain` 不做 I/O。
- **租户级覆盖**：只能显式按租户读。工作流的 `Scope` 上是 `w.config.forTenant(w.ctx.tenantId)`，任务执行器拿到的 `JobControl` 上是 `ctl.config.forTenant(job.ctx.tenantId)`。不在请求里改全局值，避免并发请求之间串租户。每个 key 缓存 30 秒（`ttlMs`），同一个 key 同时只发一次读取。配置平台出错时用缓存里的旧值，5 秒（`retryMs`）内不再去问它。配置平台推送变更时只把缓存标为过期、不删旧值，所以推送后紧接着故障也还有旧值可用；推送前发出的读取不会把更旧的结果写回缓存，较早发出但较晚返回的 `refresh()` 也会被丢弃。
- 没有注入配置模块时（测试、没有 `configStore` 的部署），`createJobs` 和 `createWorkflow` 用 `processConfigReader()`：租户没有自己的值，只用进程级的值。
- 组合根（`apps/web/src/backend-api/in-process.ts`）在有 `configStore` 时建一个配置模块，把 `reader` 传给任务模块和工作流。

本次支持租户覆盖的只有任务并发上限，其余配置项只有进程级的值。以后哪一项要按租户覆盖，再把它的调用方改成从 `forTenant` 读。

并发上限的 key 和查找顺序（先找到合法值的生效；合法值是不小于 1 的整数）：

- 模型任务：`tenant.<tenantId>.jobs.limit.endpoint.<endpointId>` → `tenant.<tenantId>.jobs.limit.model` → `jobs.limit.model`（默认 1）。
- 常规任务：`tenant.<tenantId>.jobs.limit.compute` → `jobs.limit.compute`（默认 10）。

第 3 步的任务队列用 `jobLimit` 判断每个并发键的空位。

## 8. 通知

- 新增 `NotificationPort.send({userIds, kind, projectId, text, link, title?, msg?})`。`title` 是卡片标题；`msg` 是可翻译的消息（`Msg`），即时通讯卡片可以按收件人的语言显示。
- 发送是尽力而为：失败只记日志和指标，不影响主操作（比如创建标注集照样成功）。
- 本次的两个通知：创建标注集时通知标注人；添加标注人时通知被添加的人。
- 默认替身只写日志；具体即时通讯工具的适配器由部署方提供。

## 9. 租户和模型

- 模型在租户设置里手动填：名称、Endpoint、QPM、TPM。
- 租户有默认模型：第一个添加的模型自动成为默认，可以“设为默认”。新项目用租户默认模型。
- 被项目使用的模型不能删除。
- **网关要改**：现在 `createGateway` 启动时建一次静态的模型注册表，`LabelCallRequest` 不带租户，限流键只有 endpoint ID。要改成：
  - 模型配置按租户从模型表读取并缓存，租户新加或修改的模型不用重启就能调用。
  - `LabelingModels.chat` / `chatStream` 和 `AgentModel` 在调用时接受动态的 endpoint 标识（租户管理员填的 Endpoint），适配器不能要求所有 endpoint 在进程启动时登记在 `Platform.endpoints` 里。`Platform.endpoints` 和 `LabelingModels.endpoints()` 只作为平台默认模型保留。
  - `LabelCallRequest`、对话请求和 `TryTemplateInput` 带上 `tenantId`，打标、试跑（`try_prompt`）和工作流调用网关时传入。
  - `LimiterStorePort` 的限流键改成“租户 + endpoint”，两个租户配同一个 endpoint 时各用各的 QPM / TPM，一个租户触发限流降速不影响另一个。

## 10. Contract 改动

按 CONTRIBUTING，每个 contract 改动单独一个 PR，标明是新增还是破坏性：

| 改动 | 类型 |
| --- | --- |
| `Project.tenantId` | 破坏性：现有记录要迁移（第 2 步，#63 已完成） |
| `PermissionAdminPort`；`AuthorizationRequest.permission` | 新增（第 2 步，#63 已完成） |
| `JobRequest.concurrencyKey` 和 `finally`、`claimNext` 按键限并发、`countAhead`、`requestCancel` / `recoverExpired` 返回结束的任务、`JobsContract.ahead` | 破坏性：部署方的 `JobStorePort` 要改（第 3 步，#66 已完成） |
| `ConfigPort`（`get`，可选 `getMany` / `subscribe`），移除 `TenantConfigPort` | 破坏性（第 1 步，#61 已完成） |
| `NotificationPort`（尽力而为） | 新增 |
| `OptimiserContract.startRun` / `execute` / `stopRun`、`OptimiserHost` 每次调用和 `reflectPrompt` 带调用方上下文 | 破坏性（第 2 步，#63 已完成） |
| `OptimiserHost.label` 改为入队打标任务，打标任务 `args` 带 `optimiserRunId` / `round` / `step` | 破坏性（第 5 步） |
| `LabelCallRequest`、对话请求和 `TryTemplateInput`（Prompt helper 的试跑）带 `tenantId`；模型按租户读取；`LabelingModels` / `AgentModel` 接受动态 endpoint；限流键改为“租户 + endpoint” | 破坏性：部署方的网关适配和限流存储要改 |
| `ObjectStorePort`；基于它的 `LabelingStorePort`、`FeatureStorePort` | 新增（issue #58） |
| 样本序号和软删除、标注集 | 新增 |

## 11. 交付计划

#59 是父 issue，下面每一步对应一个子 issue 和一个 PR，一个合并了再开下一个：

1. 配置模块：`ConfigPort` 和替身，进程级刷新、`config.forTenant`。
2. 权限和租户隔离：`Project.tenantId`、`createWorkflow` 读写都接入 `AuthorizationPort`、按租户过滤和校验、系统调用方规则、接口权限点表、`PermissionAdminPort`。同一步把调用方上下文传给优化器（`OptimiserContract.startRun` / `execute` / `stopRun`、`OptimiserHost`、`reflectPrompt`），否则这一步合并后优化器会被权限校验拒绝。放在任务队列前面，因为并发键要用到项目的租户。
3. 任务队列：`concurrencyKey`、`finally`（任何终态都续链）、按键限并发的 `claimNext`、排队位置、失败状态统一。（#66 已完成）
4. 模型和网关：模型按租户读取、请求带 `tenantId`、限流键改为“租户 + endpoint”。
5. 优化器改为按 `(runId, round, step)` 推进的链式任务：每个打标阶段入队，巡检识别等打标的运行，Stop 取消排队中和运行中的打标。
6. 通知端口。
7. 存储接口：`ObjectStorePort`，以及基于它的 `LabelingStorePort`、`FeatureStorePort`（issue #58）。
8. 数据集和标注集：样本序号、软删除、标注集、清空受影响的人工标签。
9. 分数和 Rescore：标注集全部完成才算分、Rescore 横幅所需的“分数是否过期”。

前端按 shell / 导航 → 租户和项目 → 数据源 → 第 1 到 4 步的顺序另开 PR，在对应的后端 PR 合并之后做。

## 12. 待定

- 训练集是否写 Hive（做训练集项目类型时再定）。
- 外部权限平台的接口格式，等对接时确认。
