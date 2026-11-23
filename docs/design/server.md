# 服务端设计：提示词优化项目

> 描述的版本：计划中，按 #59 的交付计划分 PR 实现，每个 PR 合并时把对应章节改成已实现的样子。已实现：第 2 节（权限，#63）、第 5 节（异步任务，#66）、第 7 节（配置，#61）、第 4.2 节（数据集和标注集，#82）、第 4.3 节（分数和重新计分，#86）、第 4.4 节（链式优化器，#79）。

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
| 读 | 列表和读取（`listProjects`、`getProject`、`loadProjectState`、`projectStatus`、数据源列表和详情、模型列表（`listModels`）、样本、特征、不一致、预测、聊天记录、提议列表）；`createProject`（任何成员都能建）；`tick`；`sendUserMessage`（问 AI 是读，AI 要开始工作时它的工具再查项目写） |
| 项目写 | 其余改项目的方法：下一步、改名、删除、设置、取样本和增删、人工标签、复核、重建分数、建版本、打分、停止、优化器开始 / 停止 / 重试、Improve with AI、写评论、处理提议 |
| 租户写 | `createDataSource`、`addSourceFile`、`addModel`、`updateModel`、`removeModel`、`setDefaultModel` |

**校验在哪里做**（`apps/workflow/src/services/access.ts` 的 `authorize`）：

1. 先查权限点：调用方不是 `SYSTEM_CALLER` 且接了 `AuthorizationPort` 时，调 `allowed(ctx, {action, permission, projectId})`，不通过抛 `AccessDeniedError`。这一步在读任何记录之前，所以没有权限的人不管传哪个 id（本租户的、别的租户的、不存在的）都得到同样的拒绝，探测不出哪些 id 存在。没接 `AuthorizationPort` 时（浏览器版本）全放行；系统调用方跳过这一步。
2. 再查租户：带 `projectId` 的，读项目记录（包括正在删除的），`project.tenantId` 和调用方的租户（`ctx.tenantId`，没有时是 `default`）不一致就当作项目不存在：`getProject` / `loadProjectState` / `projectStatus` 返回 null，其余报“This project does not exist.”。项目不存在或正在删除时，contract 方法的回答和别的租户的项目完全一样（读返回 null，`tick` 什么都不做，其余报“不存在”），所以本租户的成员也探测不出别的租户有哪些 id；任务执行器和工具宿主遇到不存在的项目时交给自己的逻辑处理。

用到 `authorize` 的入口：

- `createWorkflow` 的每个 contract 方法，按表校验（`action = workflow.<方法>`）。`listProjects` 另外按调用方租户过滤。
- AI 工具宿主（`agentToolHost`）每次工具调用，以发起这一轮的用户身份：读工具要读，开始工作的工具（`try_prompt`、`score_version`、`start_optimiser`）要项目写（`action = tool.<工具名>`）。用户在一轮对话中途被移出租户，下一次工具调用就被拦下。
- 工作流的异步任务执行时，以入队人的 `JobContext` 再查一次（`action = job.<类型>`）：`report.build`、`dataset.sample`、`project.delete` 要项目写，`source.ingest` 要租户写。`notify.send` 要读，被拒绝时直接丢弃（不算失败）。被拒绝的任务直接失败、不重试；被拒绝的导入会把文件标成失败。`labeling.runTask` 在打标模块里执行，不经过工作流，它的入队入口已经查过。
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
| 人工标注 | 所有标注集都标完（见第 4.3 节） |
| 提示词调优 | 有一个版本达到全部阈值 |

### 4.2 数据集和标注集

- 样本有固定序号，从 1 开始，永不改变。移除只打标记（软删除），序号不移位；被移除的样本在标注集里看不到，也不参与任何指标。可以从“已移除”里恢复。
- 标注集是数据集的一段连续样本，互不重叠，范围创建后不能改，也不能删除。
- 本次每个标注集只有一个标注人。设为标注人时 Sprint 直接给他项目写权限。
- 创建标注集或添加标注人时发通知（第 8 节）。

#### 4.2.1 实现（#82 已完成）

**样本序号和软删除**

- `Example.number`：新数据集按取样顺序从 1 编号，追加的样本接在最大序号后面（同一个项目同时只有一个取样任务）。保存失败、被跳过的样本留下空号，不重排；空号在最后时，下一次追加会用上它（那条样本从没存进去，不会和别的样本串号）。新样本都显式写 `removed: false`，数据集记 `DatasetSnapshot.numbered`。
- 旧数据补号：没有 `numbered` 的数据集第一次被读（`loadProjectState`、`listSamples`、`listLabelSets`、追加样本、建标注集）时，在 `samples:<snapshotId>` 锁里按存储里保存的顺序补号、补 `removed`，再标 `numbered`；再执行一次什么都不改。
- 软删除和恢复沿用 `removeExamples` / `restoreExamples`（`apps/workflow/src/services/governance.ts`）：只改标记、写移除记录，序号不变，恢复回原来的一半。被移除的样本不在 `ProjectState.examples` 里，所以不进任何指标。
- **分页读取** `listSamples`（读权限，`apps/workflow/src/services/samples.ts`）：按序号排列，在存储里筛选和分页（`CatalogContract.page`），不读整个数据集。`filter` 为 `live`（默认）或 `removed`；`labelSetId` 只看一个标注集；`query` 是样本 ID 或序号（`12` 或 `#12`，纯数字时两种都匹配）；每页默认 50 条，最多 500 条。每行带序号、样本 ID、类型、数据源、是否有当前标签下的人工标签；被移除的样本还带移除记录（恢复时传它的 ID）、原因、移除人和时间。

**标注集**（`LabelSet`，catalog 的 `label_sets`，`apps/workflow/src/services/label-sets.ts`）

- 记录：项目内的编号 `number`（1、2、3……，没起名时页面显示 `#1`）、名称（可空，最多 80 字）、样本序号闭区间 `first`–`last`、标注人 `labelerIds`、创建人和时间。
- `createLabelSet({projectId, count, name?, labelerIds?})`：从上一个标注集之后开始，取接下来 `count` 条没被移除的样本，`last` 是第 `count` 条的序号，所以范围里可能夹着被移除的样本（看不到、不计数，恢复后回到这个标注集）。剩下的不够时报“只剩 N 条样本没有标注集”。
- `createLabelSets({projectId, sets} | {projectId, perSet})`：把剩下的样本全部切开。按个数切时各标注集的样本数尽量平均（多出来的从前往后各加一条）；按每个的样本数切时最后一个可以少一些。两个参数必须且只能给一个。
- 创建和修改都在 `label-sets:<projectId>` 锁里，所以两个人同时创建也不会重叠，编号连续。切分时在里面再拿数据集的 `samples:<snapshotId>` 锁（加锁顺序固定），所以不会在取样任务还在写样本时切出范围；批量切分的各标注集大小在锁里按当时剩下的样本数计算。范围创建后不能改，也不能删除（只随项目一起删除）。在一个标注集之后追加的样本不属于任何标注集，等新的标注集。
- `updateLabelSet({projectId, labelSetId, name?, labelerIds?})`：只改名称和标注人，没给的字段不变。
- `listLabelSets(projectId)`（读权限）：按编号排列，每个带样本数（不含被移除的）和已有人工标签的条数，另给出还没分配的样本数。
- 创建、修改都要项目写权限。

**标注人**

- 本次每个标注集最多一个标注人（`labelerIds` 是列表，以后可以放多个）。有 `PermissionAdminPort` 时，标注人必须在 `listTenantMembers` 里，否则报错。
- 新加的标注人先通过 `grantProjectWrite` 授予项目写权限（`withRetries`，最多重试 3 次）；授权失败时整个操作报错，什么都不保存。被换下的标注人保留项目写权限，因为不知道这个权限是不是因为别的原因给的。
- 通知（第 8 节，尽力而为）：创建带标注人的标注集时发 `label_set_created` 给标注人；修改时只发 `labeler_added` 给新加的人。操作人自己不收。链接到 `/gold/?p=<projectId>&set=<labelSetId>`（以后的标注集详情页），内容只有标注集名称、样本序号范围和项目名。

**受影响的人工标签**（第 4.3 节第二条，`apps/workflow/src/services/settings.ts`）

- 标签签名变化时，`schemaVersion` 取“当前值和已有人工标签里最大的值”再加一（一次中途失败的保存留下的标签不会落到下一次保存的版本号上）；当前的人工标签里答案在新标签下仍然成立的（`readGoldAnswer` 能读出来）复制一份到新的 `schemaVersion`，在新的设置版本生效前写好；不成立的（值被删除或改名、多选改单选后有两个值等）留在旧的 `schemaVersion`，作为隐藏的提示（`staleGold`）。
- `goldLabelsCleared({projectId, structured})`（读权限）：保存前的确认框用，返回会被清空的条数（只算没被移除的样本，标签先按保存时的规则整理首尾空格）；签名不变时是 0。

### 4.3 分数

- 所有标注集都标完才算分，只用标注集里的样本。
- 改了标签值，受影响的人工标签会被清空（保留为隐藏的提示）。保存前确认框显示要清空多少条。
- 算分依据（人工标签、阈值、样本）变了之后，历史版本的分数不会自动重算。提示词调优页显示横幅，用户点 Rescore 重算。新建的任务自动用新依据。

#### 4.3.1 实现（#86 已完成）

**算分依据**（`ScoreBasis`，`packages/domain/src/scoring.ts`）

- 一个分数依赖三样东西，各存一个哈希：`samples`（算分的样本和它们属于哪一半）、`gold`（这些样本当前的人工标签）、`thresholds`（阈值；缺的字段和 `null` 一样，字段顺序不影响）。`contextId` 是这三样加上标签的 `schemaVersion`，每份报告都带（`EvalReport.basis`、`EvalReport.contextId`；#86 之前的报告没有 `basis`）。
- **算分的样本**：没被移除、落在某个标注集范围里的评测样本。项目还没有标注集时沿用以前的规则：有人工标签的样本就参与算分，追加没标的样本不影响分数（过渡：前端的标注集页面上线前，现有页面照常能用；页面上线后去掉）。
- 标注集没标完时算分依据里样本是空的，所以不会出新分数，也不会显示过期横幅。

**什么时候算分**（`labelSetProgress`）

- 一个标注集算标完 = 范围里每条没被移除的样本都有当前标签下的人工标签（里面的样本全被移除了也算标完）。所有标注集都标完才算分（`ScoringState.ready`、`WorkflowFacts.scoringReady`）。
- 人工标注这一步的完成条件（第 4.1 节）就是它，加上原来的最少条数（`canScore`）：标够了但还有标注集没标完时，下一步按钮提示“所有标注集都标完才能继续”。自动打分（`dueStarts`）也等它。
- 标注集之后追加的样本不在任何标注集里，所以不影响分数，也不会让已有分数过期，等新的标注集。

**分数过期和 Rescore**（`staleScores`、`apps/workflow/src/services/scores.ts`）

- 一份报告的 `contextId` 和当前的不一样就是过期（`ProjectState.reports[].archivedNow`），只显示不判定通过。同一依据上重算出的新报告替换旧的（旧的标成 `archived`）；别的依据上的报告保留，过期的不会盖住当前的。同一个版本 + 模型同时只有一处在算分（共享锁 `report:<projectId>:<versionId>:<endpoint>`），两次算分不会都保存，也不会互相归档。
- `ScoringState`（`ProjectState.scoring`）给页面：是否可以算分、标注集范围和个数、标完几个、标注集里的样本数和已标数、当前依据、分数过期的版本 `staleVersionIds`、变的是什么 `changed`（`gold` / `samples` / `thresholds`；样本变了就不再单说人工标签变了）、Rescore 是不是在排队或运行 `rescoring`。`#86` 之前的报告没有 `basis`，所以只说过期、不说变了什么。
- 历史分数永不自动重算：`rescore(projectId)`（项目写）入队一个 `report.rescore`，并发键是常规任务的键（租户 + `compute`），幂等键带当前 `contextId`，所以连点只排一个，依据再变之后点会排新的一个。标注集没标完、或者某一半有人工标签的样本不到 2 条（算不出分数）时拒绝，这时也不列过期版本。`rescoring` = 还有排队中或运行中、没标记结束的 `report.rescore`：任务结束前在共享状态里标记自己结束（`rescore-ended:<jobId>:<attempt>`，10 分钟；失去租约的那次不标记，接手的那次自己算）并发变更事件，读不到共享状态时按没结束算。
- 执行时按运行那一刻的依据，用已保存的答案重算每个当前标签下、在项目当前模型上打完标的版本，不重新打标；换掉的模型上的旧分数不算过期，也不重算。答案不全的版本跳过，记在共享状态里（每个版本 + 模型一个键 `cannot-build:<projectId>:<contextId>:<versionId>|<endpoint>`，30 天），所以不管页面由哪个进程读，这个版本都不再算过期（重新打分会补打缺的样本，再按新依据算分）。
- 一个项目同时只有一个 Rescore 在跑（共享锁 `rescore:<projectId>`）：第二个等第一个结束；跑的过程中依据又变了，就按新依据再跑一遍（最多 3 遍）。
- 新建的打分任务直接用当前依据：打标仍覆盖整个评测集，算分只用标注集里的样本。
- 现在页面上的 “Rebuild scores” 按钮（`rebuildReports`，在请求里同步重算）保留给改版前的页面，前端改版时删除。

### 4.4 优化器

- 一启动就创建并显示一个新版本。
- 每次尝试都是一个 `PromptVersion`，被丢弃只改状态，不删除。
- 每一轮的打标是一个单独的打标任务，和普通打标任务进同一个队列（第 5 节）。
- 优化器不再在自己的任务里等打标：等打标的父任务会占着 endpoint 的唯一名额又等排在后面的子任务（死锁），在任务里直接打标又会绕过 endpoint 的并发上限。所以一次运行是一串链式任务。

#### 实现（#79 已完成）

- **只做计算**：`optimiser.run` 是常规任务（`compute:<tenantId>`），只做生成候选、比较分数、决定下一步。启动、Retry、Resume 入队的幂等键还是 `optimiser:<projectId>`。
- **位置**：运行按 `(runId, round, step)` 推进，位置就是运行记录上已经保存的 `round` 和 `step`。要打标的步骤（`OptimiserLabelingStep`）是 `parent`、`dry_run`、`full`、`confirm`。每个步骤开始时先保存 `step`，再请求打标，所以入队时位置已经在库里。试跑挑的样本存在这一轮的 `dryRunIds` 上，接着跑时比的是同一批。
- **入队打标**（`apps/workflow/src/services/work.ts` 的 `queueOptimiserLabeling`，`OptimiserHost.label` 调它）：按版本、模型、设置和样本找到或新建打标任务（已有答案照样复用）。任务已经完成就直接往下走；否则入队一个 `labeling.runTask`（模型任务的键 `model:<tenantId>:<endpointId>`），`args` 带 `optimiserRunId`、`round`、`step`，幂等键 `label:<taskId>`，`finally` 是接着跑的 `optimiser.run`（幂等键 `optimiser:<runId>:<round>:<step>`）。然后这次 `optimiser.run` 保存位置并以 `paused` 结束（不算终态，不触发 `finally`），不等待，运行状态仍是 `running`。运行只用这几种任务：已完成的、正由它自己的打标任务在打的、空闲且没有待处理停止请求的。别的任务正在打标这些样本时（同一版本的评分、刚停止的上一次运行），运行不等它（它的 `finally` 不会接着跑这次运行），而是另建一个自己的任务排在它后面；同一个键按先后执行，复用前面的答案。入队时幂等键撞上别人刚入队的同一任务，也改用新任务。
- **接着跑**：`OptimiserContract.execute(ctx, runId, at)`。运行已经不在 `at`（已经往下走了、已结束、已停止）时什么都不做。在 `at` 时只读打标结果，不重新入队（`start: false`）：答案齐了就往下走；任务失败、被停止或任务丢了（没有活跃任务又没打完）就把运行标为 Failed，错误写明哪一步。Retry 从同一步开始，重新入队打标（失败的样本重打，已完成的保留）。运行的锁还被上一个任务占着时，接着跑的任务抛错，由任务模块延迟重试（最多 3 次）；巡检兜底。
- **巡检**（`drive`）：运行是 `running`，没有活跃的 `optimiser.run`，也没有 `args.optimiserRunId` 是它的活跃打标任务，本进程没在跑，锁也没人拿着，才算孤儿。停在打标步骤的，它的打标任务若在 1 分钟内刚结束，先留给那个任务结束时入队的后续任务（它可能还没入队），下次巡检再看；否则按它的位置入队接着跑的任务（幂等键另加 `:sweep`，不会顶掉打标任务结束时以发起人身份入队的那个；两个都跑时，后跑的发现位置已变，什么都不做），由它按打标结果推进或标为 Failed（打标任务失联 3 次被标为失败也走这条路）；停在其它步骤的（比如生成候选时 worker 丢了、页面关了），在运行的锁下重新读任务和运行，确认仍是孤儿才标为 Failed，这一轮记为失败，可以 Retry。巡检以 `SYSTEM_CALLER` 运行，所以它入队的后续任务和通知按系统任务处理（第 8 节）。
- **停止**（`stopOptimiser`）：不依赖进程内存。运行的锁空闲时，在锁下重读运行，直接存为“已停止”（这一轮也记为已停止），并记结束指标；有执行者拿着锁时，只在记录上写 `stopRequested`（`OptimisationRun.stopRequested`，执行者从不写这个字段，所以不会被它的保存覆盖），执行者每次保存前都先读记录，读到停止请求就在自己的锁下以“已停止”结束运行。两边都不会在没锁的情况下覆盖对方写的状态。然后取消这次运行排队中和运行中的 `optimiser.run` 和打标任务（`args.optimiserRunId`），并停止对应的打标任务，运行中的打标不再调用模型。入队打标的一方在入队前和入队后各读一次运行，已停止或有停止请求就不入队，或取消刚入队的任务，所以停止和入队同时发生时也不会有付费打标漏网。被取消的打标任务的 `finally` 入队的接着跑任务，读到已停止就什么都不做，读到停止请求就以“已停止”结束运行。巡检遇到有停止请求、执行者已不在的运行，也直接存为“已停止”。Ask AI 的“停止了优化器”在这里记一次；结束指标由真正把运行存为“已停止”的一方记一次。优化器的打标任务不会被自动开始（`dueStarts`）当作评分续跑，只随运行的 Retry 继续。打标任务被停止时，任务以 `cancelled` 结束（以前是 `paused`），所以它的 `finally` 一定会执行。
- **页面**：运行在等自己的打标任务时，优化器面板显示那个打标任务的排队位置（`withQueue`）。
- **通知**：每个 `optimiser.run` 都带 `finally: notifyWhenEnded(..., {about: 'optimiser', runId})`；让运行等打标的任务以 `paused` 结束，不触发 `finally`，所以只有结束运行的那个任务入队通知（第 8.2 节）。

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

- **并发键**：`JobRequest.concurrencyKey` / `Job.concurrencyKey` 必填，类型是 `ConcurrencyKey`（`packages/contracts/src/jobs-api.ts`）。`packages/domain` 的 `jobConcurrencyKey(tenantId, target)` 拼键、`parseConcurrencyKey(key)` 反解；租户 ID 不能含 `:`，endpoint ID 是第二个 `:` 之后的全部。入队方在 `apps/workflow/src/services/queue.ts` 用 `modelKey` / `computeKey` 算，租户取调用方的（`authorize` 已经校验过它就是项目的租户）。`labeling.runTask` 是模型任务，其余是常规任务（`optimiser.run` 在第 5 步改为常规任务，见 4.4）。endpoint ID 现在是项目设置里的 `EndpointId`，第 4 步换成按租户的模型配置 ID。任务模块拒绝入队格式不对的键。
- **按键限并发**：`JobStorePort.claimNext(kinds, owner, leaseMs, now, limitOf)`。任务模块的 `limitOf` 反解键，调 `config.forTenant(tenantId).jobLimit(target)`，每次取任务都现读，调大上限立刻生效。内存替身按 5.2 的两段实现：先列出候选键并读好上限（不加锁），再逐个键在不 `await` 的一段里数运行数、取最早的任务（这一段相当于持有键行锁的短事务）。键按上次被取的时间轮流（从没取过的排最前），键内按 `createdAt`、再按 `id`。任务 ID 按时间可排序，同一个 worker 同一毫秒入队的任务也按先后执行。进程总并发（默认 16）保留。
- **排队位置**：`JobStorePort.countAhead(concurrencyKey, createdAt, id)`（比设计多一个 `id`，同一毫秒创建的任务按取任务的顺序算），`JobsContract.ahead(ctx, jobId)`（不在排队时是 null）。工作流的 `loadProjectState` / `projectStatus` 给排队中的打标任务（`LabelingRun.queue`）和优化器运行（`OptimisationRun.queue`）加上 `{ahead}`，只出现在页面视图里，记录和工作流自己的规则看不到。Prompt Tuning 页面显示 “Queued” 或 “Queued · 2 ahead”（排队中 · 前面还有 2 个），优化器面板显示“在等模型空出来”。
- **`finally`**：`JobRequest.finally` 在任务以完成、失败、取消结束时入队一次，幂等键默认 `finally:<jobId>`；`paused` 不是终态，不触发。巡检判失败或取消、排队中直接取消的任务也会触发，所以 `recoverExpired` 返回它结束的任务（`ended`），`requestCancel` 返回 `{job, ended}`。`then` 仍然只在完成时入队。
- **失败状态统一**：打标的 `needs_attention` 在页面视图里显示为 Failed（`apps/workflow/src/services/views.ts` 的 `jobState`），打标执行器也按失败结束任务，有测试锁住。打标任务被停止时，任务以 `cancelled` 结束（第 5 步，#79）。
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

### 6.1 实现（#72 已完成）

- **通用接口** `ObjectStorePort`（`packages/contracts/src/platform-api.ts`，`Platform.objectStore` 可选）：`put` / `get` / `getRange` / `delete` / `deleteBatch`，可选 `signUrl`。字符串按 UTF-8 存，`size` 是字节数；`getRange` 在对象末尾截断，起点在末尾或之后返回空，没有对象返回 null；`delete` 和 `deleteBatch` 遇到不存在的 key 不报错，`deleteBatch` 不返回个数（S3 的批量删除分辨不出哪些 key 原本存在）。Sprint 不列前缀，需要的 key 都记在自己的记录里。
- **替身和一致性测试**：`memoryObjectStore()`（`packages/platform`）；`packages/platform/src/standins/object-store.test.ts` 的 `objectStoreCases(name, make)` 只依赖端口，部署方的 S3 适配器可以复制过去跑同一组用例。
- **不配对象存储**（浏览器版本）：特征快照和答案照旧存文档库，行为和以前一样。

**特征快照**（`FeatureStorePort`，`apps/catalog/src/feature-store.ts`）：

- `objectFeatureStore(objectStore, docFeatureStore(db))`：取样时每批（`dataset.featureBatch`，默认 50 个）写一个段文件 `features/<snapshotId>/<段 ID>.jsonl`，每行一个样本的 `ExampleFeatures`。样本记录存这一行的字节范围 `Example.featureRef {key, offset, length}`。
- 写入顺序：先整批写段文件，再写带 `featureRef` 的样本记录，样本永远不会在特征之前出现。段文件写失败重试一次，再失败这一批跳过（和以前单条跳过的规则一样）；失败时可能留下一个没人引用的段文件，不会被读到。
- 读：同一个段文件只读一次，范围从第一个要的行到最后一个要的行。没有 `featureRef` 的样本（对象存储之前保存的）按 `featureDocId` 从文档库读。
- 删项目：按样本索引找到段文件整个删掉，旧的特征文档按 ID 删，最后删样本索引；删到一半中断可以再删一次。
- 组合根只在配了对象存储时建这个特征存储，同一个实例传给 `createCatalog`（`features`）和 `createWorkflow`（`features`）；不配时两边都不传，特征照旧逐条写、单条失败只跳过自己。

**打标任务和答案**（`LabelingStorePort`，`apps/labeling/src/store.ts`）：

- `createLabeling` 的 `store` 可选，默认 `docLabelingStore(db)`（任务和答案都是文档，行为和以前一样）。`objectLabelingStore(db, objectStore)`：任务和段指针存文档库（部署方是 MySQL），答案存对象存储。
- 答案按批写：`createLabeling` 的 `answerBatch {size, maxWaitMs}`，组合根配对象存储时用 50 个、10 秒。一批写成一个段文件 `answers/<projectId>/<版本 ID>/<段 ID>.jsonl`，然后写一条段指针 `prediction_segments`（项目、版本、模型、设置、段 key、答案 ID 列表）。先文件后指针：没有指针的文件不会被读到。
- 一批在满 `size`、第一条答案等了 `maxWaitMs`（随 Stop 检查的计时器）、或者运行结束（跑完、Stop、失败太多）时写出。写成之后才给任务加这一批的计数，所以页面进度按批前进；进程崩溃最多丢一批没写出的答案，下次运行重新打。
- 一批写失败重试一次，再失败这一批的样本记为失败（错误写进任务），Retry failed 会重新打。
- 不配 `answerBatch` 时每条答案在它的锁里立刻写（浏览器：多个标签页之间没有队列）。按批写不会让两个任务给同一个样本付两次钱，因为第 3 步的队列对同一个租户 + endpoint 只放一个任务。**约束**：启用 `answerBatch` 时模型任务的并发上限（`jobs.limit.model` 及租户、endpoint 覆盖）要保持 1；调大后两个同版本的任务可能给同一个样本各付一次钱，读答案时同一 ID 只算一次（取最早保存的）。
- 一批写成但加计数失败（重试一次）时，运行结束前按已存的答案重算任务计数（和新一次运行开始时一样）；连重算也读不到时任务留在暂停，下次运行重算。
- 读：按“版本 + 模型 + 设置”读出所有段指针，每个段文件整个读一次，和对象存储之前的答案文档合在一起按时间排序。按 ID 找一条答案时用指针的 ID 列表定位段文件。页面级的 Redis 缓存还没有做，读路径已经是整批读，之后加在适配器里即可。
- 删项目：先删段文件，再删指针，再删旧的答案文档和任务。

**还没有放进对象存储的**：数据源的 ID 文件、大的工具结果、训练集。它们在各自的步骤里建在同一个 `ObjectStorePort` 上。

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

### 8.1 规则

- 平台提供可选的 `NotificationPort`，发送是尽力而为：失败只记日志和指标，不影响主操作，也不重试。
- 目前的通知：打标（评分）和自动优化结束时，告诉发起这次任务的人结果是完成还是失败。用户自己按了停止的、还没真正结束的（暂停、失联后放回队列）不发。
- 标注集通知：创建标注集时通知标注人、添加标注人时通知被添加的人（第 8 步已完成，见第 4.2.1 节）。
- 默认替身只写日志；具体即时通讯工具的适配器由部署方提供（`docs/integration.md` 的 Notifications 一节）。

### 8.2 实现（#71 已完成）

- **Contract**（`packages/contracts/src/platform-api.ts`，新增）：`Platform.notifications?: NotificationPort`，`send(n)` 发不出去就抛错。`Notification = {userIds, kind, projectId, text, link, title?, msg?}`：`text` 是英文纯文本，`msg` 是同一句话的可翻译消息（`Msg`），卡片可以按收件人的语言显示；`title` 是英文标题（本身也是目录里的 key）；`link` 是站内路径（`/prompt/?p=<projectId>`），适配器在前面拼站点地址。内容只有项目名、版本号、模型名这类站内词，没有提示词、样本和标签。
- **`NotificationKind`**：`scoring_finished`、`scoring_failed`、`optimiser_finished`、`optimiser_failed`，以及第 8 步用的 `label_set_created`、`labeler_added`。
- **挂在任务的 `finally` 上**：`labeling.runTask` 和 `optimiser.run` 入队时带 `finally: notify.send`（`apps/workflow/src/services/notify.ts` 的 `notifyWhenEnded`），这是一个常规任务（`compute:<tenantId>`）。任务以任何终态结束都会入队一次（第 5.4 节）。执行器先看前一个任务（幂等键 `finally:<jobId>`）：只有它以完成或失败结束才发，被取消的（用户停止、发现别的执行者已在做）不发，即使记录上还留着上一次的失败。说“完成”还是“失败”由前一个任务的结果决定，记录的当前状态必须和它一致，否则不发（比如失败的通知排队时 Retry 已经成功）。记录：打标任务 `done` 发“完成”，`failed` / `needs_attention` 发“失败”，`stopped` 等其它状态不发；优化器运行 `done` / `failed` 同理。Retry 是新的任务，结束时再发一次。
- **收件人**：任务的调用方，也就是入队的人。Sprint 自己入队的任务（保存版本后页面检查自动开始的评分、服务端巡检）以 `SYSTEM_CALLER` 运行，发给项目创建人（`Project.createdById`），发之前用创建人的身份再查一次读权限，已经没有读权限（比如被移出租户）就不发；没有记录创建人的老项目不发。
- **尽力而为**：工作流的 `notify(w, n)` 捕获发送错误，记 `sprint_notifications_total{notification, outcome="error"}` 和一行日志；成功记 `outcome="ok"`。`notify.send` 执行器总是以 done 结束、不重试；调用方已经没有读权限或项目已不在租户里时直接丢弃（done），不算失败。没有配置端口时什么都不发。第 8 步的标注集通知直接调 `notify`。
- **链式的优化器**（#79）：一次运行是一串 `optimiser.run`，每个都带这个 `finally`，因为入队时不知道哪一个会结束运行。中间各环让运行去等打标，以 `paused` 结束，`paused` 不是终态，不触发 `finally`；只有结束运行的那个任务（`done` / `failed`）入队通知。被取消的（停止、已无事可做）入队了也不发。巡检把丢失的运行标为 Failed 时没有任务结束它，不发通知。

## 9. 租户和模型

- 模型在租户设置里手动填：名称、Endpoint、QPM、TPM。
- 租户有默认模型：第一个添加的模型自动成为默认，可以“设为默认”。新项目用租户默认模型。
- 被项目使用的模型不能删除。

### 9.1 实现（#69 已完成）

- **记录**：`TenantModel`（`packages/contracts/src/types.ts`）：系统生成的 `id`、`tenantId`、`name`、`endpoint`（管理员填的 Endpoint）、`qpm`、`tpm`、`default`、创建和修改时间。存在 catalog 的 `tenant_models` 集合。项目设置的 `ModelSettings.endpoint` 存模型的 `id`，不存 Endpoint 文字，所以任务并发键 `model:<tenantId>:<endpointId>` 和限流键都用它。
- **管理接口**（`apps/workflow/src/services/models.ts`）：`listModels`（`read`，租户成员都能看；默认在前，每个带 `usedBy`：当前设置用它的项目数）、`addModel`、`updateModel`（没给的字段不变）、`removeModel`、`setDefaultModel`（这四个要 `tenant_write`）。租户还没有默认模型时，新加的模型成为默认（也就是第一个）；删掉默认模型后不自动换。名称在租户内不能重复（不分大小写），QPM / TPM 必须是正整数。被项目使用的模型删除时返回原因，不删。别的租户的模型 ID 和不存在的 ID 回答一样。表单错误通过返回值的 `error` 给出，页面直接显示。
- **加锁**：每次增删改、新项目取默认模型、保存项目设置选模型、保存版本时同步标签写新的设置版本，都持有 `models:<tenantId>` 锁（`withModelsLock`），所以不会出现“刚检查没人用就删掉、同时有项目选了它”。保存设置时直接从 catalog 读模型校验，不用网关缓存。
- **新项目和设置页**：新项目用租户默认模型，没有就用平台第一个默认模型。`loadProjectState` 的 `endpoints` 先列租户自己的模型，再列平台默认模型（租户模型读不出来时只列平台默认，页面照常打开）。租户模型没有价格（费用按 0 算），不支持温度（`temperature` 为 null）。
- **网关**（`apps/llm-gateway/src/gateway.ts`）：`createGateway` 的 `tenantModels`（`TenantModelSource.list(tenantId)`，组合根用 catalog 实现）按租户读取并缓存 `gateway.tenantModelsTtlMs`（默认 30 秒）；请求缓存里没有的模型 ID 时立刻重读（同一租户最多每秒一次），所以新加的模型马上能用；读失败时继续用上次读到的。工作流每次增删改后调 `forgetTenant`，本进程立刻重读；别的进程最迟一个缓存周期生效，不用重启。一个租户能调用自己的模型和平台默认模型（`Platform.endpoints` / `LabelingModels.endpoints()`，只作为平台默认保留），别的租户的模型被拒绝。`labelingEndpointsFor(tenantId)` 给出这个列表。
- **动态 Endpoint**：`ChatRequest.endpoint` 是调用时决定的目标：租户模型是管理员填的 Endpoint，平台默认是它的 ID；同时带上 `tenantId`。`AgentChatOptions.model` 是租户模型 ID 时，网关把它的 Endpoint 放在 `AgentChatOptions.endpoint` 交给适配器（调用方传的会被丢掉）。适配器不能要求 Endpoint 在启动时登记过。
- **请求带租户**：`LabelCallRequest.tenantId`（必填）、`TryTemplateInput.tenantId`、`CreateTaskInput.tenantId` / `LabelingTask.tenantId`（旧任务没有时按 `default`）、`AgentChatOptions.tenantId`。工作流创建打标任务和试跑时传调用方的租户（`authorize` 已经校验过它就是项目的租户）；agents 运行时按每次请求的 `ctx.tenantId` 包一层模型（`modelForTenant`），助手和优化器反思的每次调用都带租户。
- **限流键**：`<tenantId>:<endpointId>`，`LimiterStorePort` 接口不变。两个租户用同一个 endpoint（包括平台默认）时各用各的 QPM / TPM，429 降速只影响触发它的租户。租户模型改了 QPM / TPM 后，同一个键换用新的上限。租户模型 ID 不作为指标标签，统一记为 `tenant_model`。

## 10. Contract 改动

按 CONTRIBUTING，每个 contract 改动单独一个 PR，标明是新增还是破坏性：

| 改动 | 类型 |
| --- | --- |
| `Project.tenantId` | 破坏性：现有记录要迁移（第 2 步，#63 已完成） |
| `PermissionAdminPort`；`AuthorizationRequest.permission` | 新增（第 2 步，#63 已完成） |
| `JobRequest.concurrencyKey` 和 `finally`、`claimNext` 按键限并发、`countAhead`、`requestCancel` / `recoverExpired` 返回结束的任务、`JobsContract.ahead` | 破坏性：部署方的 `JobStorePort` 要改（第 3 步，#66 已完成） |
| `ConfigPort`（`get`，可选 `getMany` / `subscribe`），移除 `TenantConfigPort` | 破坏性（第 1 步，#61 已完成） |
| `NotificationPort`（尽力而为）、任务类型 `notify.send` | 新增（第 6 步，#71 已完成） |
| `OptimiserContract.startRun` / `execute` / `stopRun`、`OptimiserHost` 每次调用和 `reflectPrompt` 带调用方上下文 | 破坏性（第 2 步，#63 已完成） |
| `OptimiserHost.label` 改为入队打标任务（`OptimiserLabelRequest` 带 `runId`、`at`、`start`，返回 `OptimiserLabeling`：`done` / `queued` / `unfinished`），打标任务 `args` 带 `optimiserRunId` / `round` / `step`；`OptimiserContract.execute(ctx, runId, at?)`；`OptimiserRound.dryRunIds` | 破坏性：只有工作流实现 `OptimiserHost`，部署方的适配器不用改（第 5 步，#79 已完成） |
| `OptimisationRun.stopRequested`（可选） | 新增（第 5 步，#79，随 #81 合入） |
| `LabelCallRequest`、对话请求和 `TryTemplateInput`（Prompt helper 的试跑）带 `tenantId`；模型按租户读取；`LabelingModels` / `AgentModel` 接受动态 endpoint；限流键改为“租户 + endpoint” | 破坏性：部署方的网关适配和限流存储要改（第 4 步，#69 已完成） |
| 模型管理接口 `listModels` / `addModel` / `updateModel` / `removeModel` / `setDefaultModel`；`CatalogContract.remove('tenant_models', id)` | 新增（第 4 步，#69 已完成） |
| `ObjectStorePort`（`Platform.objectStore` 可选）；基于它的 `LabelingStorePort`、`FeatureStorePort`；`Example.featureRef` 可选 | 新增（第 7 步，#72） |
| `Example.number`（样本序号，可选，旧样本第一次读时补上）、`DatasetSnapshot.numbered`、`LabelSet` 和 catalog 的 `label_sets` 集合、`CatalogContract.page`（分页读取） | 新增：catalog 在本仓库实现，部署方的文档库适配器不用改（第 8 步，#82 已完成） |
| `ScoreBasis`、`EvalReport.basis`（可选，旧报告没有）、`ScoringState`、任务类型 `report.rescore`、`ProjectState.scoring`、`WorkflowFacts.scoringReady`、`rescore` 接口 | 新增：只有工作流产出和读取，部署方的适配器不用改（第 9 步，#86 已完成） |

## 11. 交付计划

#59 是父 issue，下面每一步对应一个子 issue 和一个 PR，一个合并了再开下一个：

1. 配置模块：`ConfigPort` 和替身，进程级刷新、`config.forTenant`。
2. 权限和租户隔离：`Project.tenantId`、`createWorkflow` 读写都接入 `AuthorizationPort`、按租户过滤和校验、系统调用方规则、接口权限点表、`PermissionAdminPort`。同一步把调用方上下文传给优化器（`OptimiserContract.startRun` / `execute` / `stopRun`、`OptimiserHost`、`reflectPrompt`），否则这一步合并后优化器会被权限校验拒绝。放在任务队列前面，因为并发键要用到项目的租户。
3. 任务队列：`concurrencyKey`、`finally`（任何终态都续链）、按键限并发的 `claimNext`、排队位置、失败状态统一。（#66 已完成）
4. 模型和网关：模型按租户读取、请求带 `tenantId`、限流键改为“租户 + endpoint”。（#69 已完成）
5. 优化器改为按 `(runId, round, step)` 推进的链式任务：每个打标阶段入队，巡检识别等打标的运行，Stop 取消排队中和运行中的打标。（#79 已完成）
6. 通知端口：评分和自动优化结束时通知发起人。（#71 已完成）
7. 存储接口：`ObjectStorePort`，以及基于它的 `LabelingStorePort`、`FeatureStorePort`（issue #58）。（#72 已完成）
8. 数据集和标注集：样本序号、软删除、标注集、清空受影响的人工标签。（#82 已完成）
9. 分数和 Rescore：标注集全部完成才算分、Rescore 横幅所需的“分数是否过期”。（#86 已完成）

前端按 shell / 导航 → 租户和项目 → 数据源 → 第 1 到 4 步的顺序另开 PR，在对应的后端 PR 合并之后做。

## 12. 待定

- 训练集是否写 Hive（做训练集项目类型时再定）。
- 外部权限平台的接口格式，等对接时确认。
