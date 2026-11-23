# Decisions

Product and design decisions behind the MVP, newest first. Each line says what was decided and,
where it matters, why. The code follows these; change a line here when a decision changes.

## 2026-11-23 (Prompt Design on Astryx, #96)

- **Versions show flat numbers** (v1, v2…; wireframes v346): one per major. A save over a version is the next minor of its major (`kind: 'minor'`), so the version keeps its number on screen and shows its newest save; every save stays in the records. An Optimiser run's major shows the best try it kept, never its tries one by one. `shownVersions` in `@yushiguang/sprint-domain` is the one rule the pages use. No contract change.
- **Prompt Design is one prompt card beside Ask AI**: Sections (the parts, no XML tags), Changes (word marks against the version it was made from, or the saved version while editing) and Full prompt (the text the model reads). Each part is edited in its own dialog; the card's Save keeps the version. The first save is v1; Approve and "Next: Dataset" are gone (the step bar moves on).
- **Save asks before it costs something**: over a version that is still labeling it asks to stop the run first ("Stop and save"), and when the label change clears gold labels it says how many first (`goldLabelsCleared`). A save labels the dataset again at once.
- **Discard** shows while the card holds unsaved edits or a helper's draft, so a draft can be closed without saving (the helper can still recall it, #39).

## 2026-11-23 (One file is one data source, #95)

- **A data source is the one file it was made from**: pages no longer add files to a source (`addSourceFile` is deprecated and kept for sources made before). The list shows each source's file name, whether its file is still being read or could not be read (with the reason), and how many projects use it.
- **Tenant admins rename and delete data sources.** A name is checked like a new one (not blank, not another source's of the tenant, in any case). Delete cannot be undone: the source leaves every list and read, and no dataset takes from it again, but examples already taken stay and keep its name, so the record is kept and its name is free again. A file still being read stops. The built-in sample data is neither renamed nor deleted.

## 2026-11-23 (App shell on Astryx, #91)

- **One frame for every page** (wireframes v346): a taller top bar with a full-width line under it, naming 「Sprint / tenant / project」 on the left (the project name opens a switch menu: search, recent projects, All projects), the four steps in the centre with arrows between them, and Ask AI, language and the avatar on the right. Pages are white and centred, at most 1200 wide.
- **Step 2 is called Dataset** (数据集). In Chinese, Gold Labels the step is 人工标注 and a gold label is 人工标签; 评测集 is no longer used.
- **A project opens on its overview**, which names the next unfinished step and holds Project settings; the step pages no longer have a Settings button.
- **Ask AI is a full-height panel on the right**, under the top bar. On Prompt Design it is part of the page: always open, with no close button and no Ask AI button.
- **The prompt editor lives on Prompt Design** (`/prompt-design?v=<version>`); the separate edit page is gone, and the agents' links point there.
- **A refused action shows the "insufficient access" dialog**, whose Request access sends the request to the permission platform.
- **Pages take Astryx only through `@/ui/astryx`**, so an upgrade or a wrapper of our own changes one file. The old kit stays in the `legacy` layer until the lanes have moved every page.

## 2026-11-23 (Current tenant and access requests, #91)

- **Pages know the caller's tenant and role** from the runtime info: the top bar names the tenant, and admin entries show only to admins (holders of tenant write). Until tenants are records of their own, the name is the organization's name from the identity.
- **Request access goes to the permission platform**: any signed-in person may send one, with an optional reason; Sprint passes it on and keeps nothing. The dialog links to the platform's page for the request when the platform has one.

## 2026-11-23 (Scores from label sets and Rescore, #86)

- **Scores are made only once every label set is finished**, on the eval samples inside label sets (a removed sample counts nowhere, a sample in no set waits for one). A project with no label set yet keeps the rule from before label sets (scores on the samples with a gold label), until the label set pages ship.
- **A score says what it rests on**: the samples with their halves, their gold labels, and the thresholds. A changed basis leaves earlier scores as they are, shown but never passing; changing the thresholds no longer re-judges them.
- **Rescore is a queued job**, one per basis however often it is pressed, and works the out-of-date scores out again from the saved answers; a version missing answers is skipped and needs scoring again. New scoring uses the new basis straight away.

## 2026-11-23 (Sample numbers and label sets, #82)

- **Samples have numbers that never change**: from 1 in the order taken; a save that failed leaves a gap; removing a sample shifts nothing. Older datasets are numbered once, in saved order, on first read.
- **A label set is a fixed range of sample numbers** that starts after the last set and takes the next samples not removed. Removed samples inside a range are hidden and come back on restore; samples added later wait for a new set. Sets are never deleted or resized; only the name and labeler change.
- **One labeler per set for now**, a tenant member, granted project write before anything is saved; a labeler taken off keeps project write (it may have been given for other work). The person making the change is not notified about their own change.
- **A label change clears only the gold labels it makes wrong**: labels whose answer still answers the new label carry over to the new schema version; the rest stay as hidden hints. The count is shown before saving.

## 2026-11-23 (Tenant models, #69)

- **A tenant calls its own models and the platform's defaults.** Projects store the model's generated id, never the Endpoint text, so job keys and limits never collide or break on odd characters. The gateway reads a tenant's models per tenant and keeps them 30 s, and reads again at once for an id it does not hold, so an added model works without a restart.
- **Tenant models are managed by tenant admins**: the first added (or the next added while the tenant has none) becomes the default; removing the default does not pick another; a model a project uses cannot be removed. Tenant models carry no price and take no temperature for now.
- **Rate limits are counted per tenant and endpoint**, also on the platform's defaults: a tenant's registered QPM/TPM is its own, and a busy reply slows down only that tenant.

## 2026-11-22 (Server design after the frontend review, #59)

- **Three permission points only**: read (every tenant member), project write (requested; the creator and labelers get it), tenant write (tenant admins). All are kept on an external permission platform; the gateway checks each interface, and the server checks again through `AuthorizationPort` because agent tools and jobs bypass the gateway.
- **A data source is one file of sample IDs.** Features are fetched by ID when examples join the dataset and frozen in object storage.
- **No approvals.** A step is done when its condition holds; scores are built only when every label set is done; a changed scoring basis is applied to history only by a manual Rescore.
- **Jobs are queued in MySQL with a concurrency key**: tenant + endpoint for model work (limit 1, first in first out), tenant + compute for the rest (limit 10). Workers poll and claim with `FOR UPDATE SKIP LOCKED` on a per-key lock row; no message queue for now, because a partitioned queue cannot cap per-key concurrency, cancel a queued job or report a queue position.
- **Write-once bulk data goes to object storage** (feature snapshots, model answers, training sets); records that are queried or edited one by one stay in MySQL.
- **Configuration moves to a config platform** read by string key with a local cache; job limits are config keys.
- **Tenant configuration is read explicitly, never through a global** (#61): `systemConfig()` stays the synchronous process-level value, refreshed by `@yushiguang/sprint-config`; tenant keys are read only through `config.forTenant(tenantId)` on the workflow scope and the job control, so concurrent requests of two tenants cannot see each other's values. `TenantConfigPort` is removed: it had no caller, and its merged-struct shape could not be cached per key.
- **Every project belongs to a tenant** (#63): `Project.tenantId` is required. Records saved before it belong to `DEFAULT_TENANT` (`default`, the tenant of a caller with none, as data sources already used); each workflow instance writes it once before its first read of projects.
- **The Optimiser runs as the person who started the run** (#63), not as a fixed `optimiser` identity: `OptimiserContract.startRun` / `execute` / `stopRun` and every `OptimiserHost` call take the caller's context, and `execute` gets the `optimiser.run` job's. Its helper (`reflectPrompt`) is asked with the same context. Otherwise the permission checks would see a caller that holds no permission, or one that holds every tenant's.
- **The workflow checks every entry point, reads included** (#63): contract methods by `WORKFLOW_PERMISSIONS`, agent tools (read tools need read, start tools project write), workflow jobs again as their caller when they run, and every Optimiser step. The permission point is checked before any record is read, and another tenant's project reads exactly as a missing one, so ids cannot be probed. Every Optimiser step needs project write (a run edits the project and spends), and a refused job fails at once instead of retrying. Sprint's own work (the sweep, the work a page's tick queues) runs as `SYSTEM_CALLER` in the project's tenant and is checked for the tenant only, so a read-only member opening a page still lets automatic starts queue.
- **Creating a project grants the creator project write; a grant that fails after 3 retries removes the project** (#63), so no project is left that its creator cannot open.
- **Every job names its concurrency key; the store enforces the key's limit at the claim** (#66): `model:<tenantId>:<endpointId>` or `compute:<tenantId>`, built by whoever queues the job; the limit is read from configuration on every claim, so raising it takes effect at once. Keys take turns by when they were last claimed (no tenant waits behind another's queue); within a key, oldest first by `createdAt` then `id` (job ids sort by time, so jobs of one runner keep their order within a millisecond).
- **An Optimiser run is a chain of jobs, never a job that waits** (#79): `optimiser.run` only computes (`compute:<tenantId>`); each labeling step is a `labeling.runTask` job on the model's key, and its `finally` queues the `optimiser.run` that goes on from `(runId, round, step)`. A job that held the endpoint's only slot while waiting for labeling queued behind it would deadlock, and labeling inside the run's job would bypass the endpoint's limit. The follow-up only reads how its labeling ended (Retry queues it again), so a lost or repeated follow-up never labels twice; a labeling step whose examples another job is already labeling queues a task of its own behind it, which reuses those answers. A labeling step never waits on another job's labeling (scoring, a run just stopped): it queues a task of its own behind it, which reuses those answers. A job that leaves the run waiting ends `paused` (no end), so only the job that ends the run queues the notice. A run left with no job and no labeling job is continued by the sweep at a labeling step (its own idempotency key), else Failed with Retry under the run's lock. Stop never races a runner's save: with the run's lock free it saves the run as stopped under the lock; while a runner holds it, it saves only `stopRequested`, a field runners never write, and the runner ends the run as stopped under its lock at its next save. Whoever queues labeling reads the run before and after queueing and does not queue (or cancels) for a stopped run, so no paid labeling of a stopped run slips through. Optimiser labeling tasks are never resumed by automatic starts, only with their run.
- **`finally` follows every end of a job** (#66): done, failed or cancelled, including a sweep that fails it and a cancel before it started; not `paused`, which is not an end. `then` still follows done only.
- **Notifications are best effort and tell whoever started the work** (#71): scoring and Auto Optimise send one notification when they end, finished or failed, through the `finally` of their job; a Stop the user pressed sends nothing. Work Sprint queued itself (scoring after a Save, the sweep) goes to the project's creator, since no person queued it. A failed send is counted and logged and never fails or retries anything, because a missed card costs less than a failed run.
- **Write-once data is packed in segment files behind one `ObjectStorePort`** (#72): frozen features one segment per take batch, with each example keeping its byte range; model answers one segment per batch of up to 50 (or 10 s), with a pointer record per segment. A task's counters are added only after its batch is saved, so they never count an answer that is not stored; a crash loses at most one unsaved batch, labeled again. Batching is safe because the queue runs one task per tenant and endpoint at a time. Without object storage everything stays in the document store, as before.
- **Permission writes go through `PermissionAdminPort`** (#63): members and roles of a tenant, project write grants. Idempotent, the caller's context first on every change; the in-process stand-in is `memoryPermissionAdmin`.

## 2026-11-20 (Dataset feature missingness and zero-feature exclusion, #48)

- **Zero-feature items are excluded at take time and counted** (explicitly superseding #32's "kept, with none" clause). After lookup, any item with `hasAnyFeature(features) === false` — including one that passed item checks with a type but was omitted by lookup — is left out instead of saved as an empty example, incrementing `DatasetSnapshot.counts.checks.noFeatures` (omitted when 0) and `DatasetSnapshot.featureMissingness.zeroFeatureExcluded[type]`. "Missing" is the exact emptiness rule `renderPrompt` uses (`isFeatureEmpty` in `packages/domain/src/template.ts`).
- **Feature missingness is stored as exact integer counts on `DatasetSnapshot.featureMissingness`** (version 1: per-type `examples` and per-key `missing`, plus `zeroFeatureExcluded`), never pre-rounded rates, so appends, removals and restores never accumulate rounding drift; callers compute rates on read (`summarizeMissingness`, `featureMissingForGroup`). Legacy snapshots without `featureMissingness` stay `undefined` when they already have valid examples.
- **Removals and restores live-adjust `byType` counts** via batched by-id `featuresOf` reads (`dataset.featureBatch`) with clamped subtraction on remove and merge on restore (best-effort, so a stats failure never blocks removing or restoring examples). `pruneDataset` inherits this through `removeExamples`.
- **`EvalReport.snapshotId` joins reports to their snapshot**, stamped in `buildReport` from the scored examples' snapshot.
- **Helpers receive aggregates only** (`missingnessView`: per-type counts, features with `missing > 0` as `{key, missing, total, rate}`, and `zeroFeatureExcluded`, never example ids) on `dataset`, `prompt_design`, and `prompt_edit` page views and `get_dataset_stats`, without triggering `lockHoldout`. `get_upload_result` also explains `noFeatures`.

## 2026-11-19 (Labeling across processes, #46)

- **Named locks are a platform port, shared by every process.** `LockStorePort` (additive contract change, its own pull request first) gives acquire/renew/release/isHeld as atomic per-name lease operations, like the job and limiter stores; `@yushiguang/sprint-platform` brings the memory stand-in and `leaseLocks`, and every composition passes one such locks object to labeling, the workflow and the Optimiser. Before this, locks were per browser or per process, so a BFF replica read a worker's running task as abandoned and persisted it `paused`/`closed`, and after a job-lease takeover or in a second Optimiser worker two runners could both pay for one example.
- **`listTasks` never falsifies live work.** It reaps a `running` task only when no runner holds it through the shared locks and the composition's `liveElsewhere` reports no queued or running job for it (`labeling.runTask` by task; since #79 an Optimiser run's labeling is such a job too, so `optimiser.run` no longer counts), so closed-page and dead-worker tasks still become `paused`/`closed` — a dead worker's only after its lock lease ends — while live runs keep their state in every unit.
- **The lease fencing residual is accepted.** A runner frozen longer than its lock lease can lose the lock mid-call and duplicate that one call, the same limit the job and limiter leases already accept. Saving a prediction re-reads first, so such a duplicate (or one from per-process locks) still leaves one document and one counted answer; a hard no-duplicate guarantee would need an atomic create-if-absent on the document contract, deferred as its own contract change.

## 2026-11-19 (Collaboration rules, #41)

- **No code before a go.** Work was being built before it was investigated or agreed, and more branches and pull requests were opened than a maintainer could follow. Every issue now gets a first comment by its kind (Analysis, Design review, Findings and plan, or an answer) and waits for a maintainer's go on the issue.
- **Five kinds of issue** (idea, design, bug, task, question), because an idea needs discussion before design while a finished design needs review and a plan. The shape follows the Go proposal process, Rust RFCs and Kubernetes triage.
- **One open pull request at a time, small, with evidence.** The maintainer checks evidence (tests, checks, screenshots) rather than code, and tries the product as a whole at intervals.
- **No specs in `docs/`, no one-time docs in the repo.** Designs live on their issues; `docs/tmp/` is removed and `docs/specs/` is kept as history.

## 2026-11-18 (Frozen dataset snapshots, #32)

- **An example's features are fetched once, when it is taken, and frozen** in their own document (`example_features`, id `snapshotId:externalId`), apart from the product records. The `examples` records are the dataset's index (id, kind, title, half, source) and never hold features; project state carries the index only. Scoring is reproducible and the feature service is not read again for every run.
- **Every read is by id, a batch at a time** (`dataset.featureBatch`, 50): a labeling run reads its own examples' features in batches as it goes; Gold Labels reads the one example shown (`getExampleFeatures`); the helpers and the Optimiser read the few examples they brief, the optimiser half only. No query scans a snapshot.
- **Items are checked when they are taken** (`ExampleSource.check`, optional): not found, a creator under 18, not publicly recommendable. What is left out is counted per check on the dataset and shown on Eval Dataset ("6 items left out", why on hover), never dropped silently. The check gives the item's kind. An item that passes its checks but whose features do not come back is kept, with none *(superseded on 2026-11-20 by #48: zero-feature items are excluded and counted under `noFeatures`)*. A feature service call that throws is tried twice more, then the take fails.
- **No expiry** (Evelyn): frozen features are kept as long as their dataset. The retention and TTL parts of #32 are dropped.
- **Estimates use average feature sizes** kept on the dataset per kind of example (`featureSizes`, video and photo-and-text apart, each averaged over its own examples), since they can no longer read every example. An image feature counts its images (a single URL as one), any other feature its text.
- **A batch read that fails is tried twice more** before the labeling workers waiting on it fail, and an example whose answer is already saved never reads its features. Deleting a project removes the features documents by their ids from the dataset's index, never by a query on the features collection.
- **Large fields overflow to object storage in a server adapter** (`dataset.overflowFieldBytes`, set from `scripts/feature-size-report.mjs` over a real sample). The stand-in keeps every field in the document.
- **Breaking contract change:** `Example` has no `features` (`ExampleWithFeatures` where they are needed); new `CatalogContract.exampleFeatures`, `BffContract.getExampleFeatures`, `OptimiserHost.exampleFeatures`, `ExampleSource.check`; `DatasetSnapshot.counts.checks` and `featureSizes`. Examples saved before #32 keep their features on their own record and are still read.

## 2026-11-18 (Data Source, #29 and #30)

- **Data Source is a page of the tenant**, next to Projects in the top island (title case in the UI). A data source belongs to a tenant, never to a project, and another tenant cannot see it.
- **A data source has no versions.** It is a name plus the files uploaded to it, and they all count together. Add a file appends to the source; an item already in it is counted as a repeat and left out. Each file shows its items, bad rows (no usable item id) and repeats. Files are CSV, JSONL or TXT with one item id per row, up to 100,000 rows. A file is imported as a `source.ingest` job with progress.
- **No delete or rename of data sources yet.**
- **Datasets and data sources are many to many.** A dataset takes examples from one or more sources, when it is created and later with Add examples (which brings back adding to an existing dataset, deferred on 2026-11-06). Each example records its source and file. An item in two sources counts once.
- **Cuts are continuous over an order shuffled once at import.** Each file's new items are shuffled with a recorded seed and appended to the source's one order; a dataset takes the next unused segment. Uploaded files are often sorted (by time or creator), so a plain continuous cut would take a biased slice; shuffling once keeps the cut fair, two datasets never share an item, and the same cut gives the same items. An item already in the dataset is skipped and still uses its position.
- **A deleted project's segments are retired**, never handed out again. Asking for more than is left is refused, with the counts.
- **With no data source yet, the empty Eval Dataset page takes a file**, and it becomes a data source of the team.
- **The sample data is a built-in data source** of every tenant (`ExampleSource.builtIn`); files cannot be added to it. The global sample pool (`ExampleSource.available` and `sample`, `getSamplePoolSize`) is gone, and so are Upload dataset, Auto sampling, Add from file and Add sampled: every dataset now comes from data sources.
- **Breaking contract change:** `takeExamples({projectId, picks: [{sourceId, count}]})` replaces `startSampleDataset`, `appendSample`, `uploadDatasetText` and `appendUpload`; `listDataSources`, `getDataSource`, `createDataSource` and `addSourceFile` are new.
- **Large files still go through the bff** in this version: the file store has no read side yet, so a file is read in the request and staged as chunks. Uploading straight to file storage waits for that.
- **The tenant is the signed-in user's organization** (`Identity.currentUser().organization`, set as `RequestContext.tenantId` by the bff); with none it is `default`.
- **An import that fails is tried twice more, then its file is marked failed** (review of #35). What it wrote stays in the source and can be taken; a cut skips the rest of its positions, and uploading the file again adds the rest. An import whose job ended without it is marked failed when the source is next read. Reserving positions is written on the source in the same update as its size, so an import cut short never reserves them twice or loses them.
- **A failed take shows on the Eval Dataset page** ("Taking examples failed: …") until the next take. Add examples whose items are all in the dataset already succeeds and adds nothing. The per-source counts on the page are the dataset's live examples (removed ones leave them, restored ones come back).

## 2026-11-18 (Upload labels, #31)

- **Upload labels is its own action on Gold Labels**, apart from Upload dataset: datasets decide which examples exist, labels decide their gold answers. A label file never adds examples; a row for an item not in the dataset is counted and skipped.
- **Rows are checked one by one.** A value outside the label (or the wrong number of values) refuses that row, named by its row number; the other rows still save. The last row for an item wins. A row that changes an item's label replaces the earlier one (the newest label counts, as when labeling by hand), the same label again saves nothing, and each upload is audited (`gold_labels.uploaded`).
- **Files:** CSV with an `item_id` and an `answer` column (several values separated by `|` or `;`), or JSONL lines. The file is read on the server (`uploadGoldText`), so a server bff reads it the same way.

## 2026-11-18 (fixes from the maintainers' issues)

- **Next stays on a version with no known advisory, and its security check stays on** (#28). Next stops a build with a security notice only when it sees a coding agent run it (an unpatched version, an agent's terminal); CI and people's terminals never stop on it. So the fix is upgrading, not turning the check off or retrying the build: 16.4.4 had two moderate advisories (cached data across root params, which a static export does not use) and 16.4.6 has none. A build that stops on the notice again means a new advisory: upgrade Next in a pull request.
- **Deleting a project waits for its running work to end** (#24) before deleting, and tries again later if it does not end in time; saved answers carry their project, so a late one is still found.
- **An automatic resume goes on with the task that paused** (#25), never with a new scoring of the version.
- **A job whose end could not be saved still gets its chained job, once** (#26): the runner tries three times, then the sweep's re-run chains it, or the runner itself on the job's last attempt.
- **A package release is resumed by running it again** with the same version (#27); packages already published are skipped.

## 2026-11-16 (workflow resilience and single or multi select)

- **The one label is single select or multi select.** A project still has one label and is never mixed with another; a multi-select label says how many values an answer holds (at least, at most). Answers are lists everywhere (`Answer = string[]`), one value long for single select. A value can be marked "Only on its own" (exclusive): a catch-all such as "None" is never chosen next to another value.
- **Multi-select scores** count each value wherever it sits in the list (per-value F1, Macro-F1 over values); accuracy needs the exact set. Mix-ups name a value that was added when it did not apply, or missed. In the Optimiser an example scores the F1 of its values, so a partly right answer earns part.
- **The approved Prompt Design page has no Edit prompt**; versions are edited from Prompt Tuning.
- **Sampling and uploads keep their progress on screen until the dataset is saved** (a "Saving the examples" step with no Stop). One example that fails to save is tried once more, then skipped and counted as "could not be saved", apart from invalid rows; the halves are evened over the saved ones. Only a task that saved nothing fails.
- **Gold Labels has an Open item link** to the item's own page for when the player cannot be embedded. The player gets only the site's origin, over https (`strict-origin`), and may autoplay.
- **Nothing is scored by itself before Gold Labels is approved.**
- **The Optimiser drops a change only when it scores lower in the dry run**; a tie goes on to full labeling (this replaces R5-6's tie handling, and the tie limit is gone). Whether a kept change is progress is judged on the optimiser half's Macro-F1, never the held-out half, which no helper or Optimiser step reads. A kept change with no gain shows "No gain" and counts as a wasted round.
- **Rebuild scores is on only when scores are out of date.** The AI Suggestion stays while they are, read from each version's newest score, and Edit prompt, Improve with AI and Auto Optimise ask "Rebuild scores first?" (Cancel, Continue anyway, Rebuild scores).
- **A failed action reads "{Action} failed. {why}"**, and the banner's Retry spins while the action runs again.

## 2026-11-16 (single-label projects and helper alignment)

- **A project classifies exactly one label**, with mutually exclusive values, and the model answers one plain string (later the same day the label became single or multi select, and answers lists; see above). Projects are never mixed or merged, so there is no label combining and no multi-project merge; another label is another project.
- **The Prompt helper suggests a catch-all value** ("Other" or "None") when the values may not cover every item, so every item can get one.
- **Old projects are test data and start fresh**: the stored-data prefix changed and nothing is migrated. Old gold upload files (`{"name": ["value"]}`) still import.
- **Value-specific rules go into the value's definition**; rule groups hold rules across values. A long pasted prompt is treated as an import whatever the user asked.
- **The values are stacked cards** (name, definition, Move up / Move down / Remove), the version card scores each value, and Gold Labels shows one answer per item.
- **The chat panel shows no page tag and no helper lines** ("Prompt helper answers", "Helpers read your recent messages"). Shift+Enter sends and Enter adds a line.

## 2026-11-16 (acceptance refinements)

- **No page renders before the signed-in user is known**; the identity is read once per page load and kept, so the avatar never flashes empty. Sign out shows only when the platform can end the session.
- **A new project ticks no features.** A pre-ticked feature can break a task's own rules (for example a cover-only check that forbids on-screen text); the user or the Prompt helper ticks them.
- **The prompt reads in authoring order**: Persona & Task, Input Features, Output Labels & Definitions, Rule Groups.
- **Rules live in groups the user names**, replacing the per-field tie-break box and the one general-rules box, because real prompts organise their rules by topic, with paragraphs and nested bullets. An import keeps each rules section as its own group.
- **The compiled prompt uses XML-style sections**, for clear boundaries and so that item text cannot pass for an instruction.
- **Project Settings is three sections set apart by a line**; Default/Custom is a switch beside the Evaluation heading; no intro line and no model description; the checks show their names only, with no explanation line and no line between rows; the Model list is the site's own dropdown.

## 2026-11-14 (1.1.0: creator, languages, problem reports)

- **The Projects list shows who created each project**, nothing more until tenants arrive; the id is stored too, for ownership checks later.
- **Rename lives in Project Settings**, as a Name field, not on the top island.
- **English and Chinese now; more languages later**, as new catalog files. The switch sits in a menu under the avatar.
- **Reporting a problem is a tool every helper has**, not a separate helper, because users get stuck on any page. The site defines the ticket submission interface; the internal platform files the ticket and the user gets its id. There is no reports page.
- **A report needs the user's yes**, enforced in code: a draft first, a send only after the user writes again. The prompt goes along only when the user agrees; examples and gold labels never do.

## 2026-11-14 (building 1.0.0 phases 3 and 4)

- **Unlabeled examples never make a score stale.** Scores rest on gold-labeled eval examples only; an added example waits for its gold label and is counted next to the score.
- **The halves are fixed at the first helper read**, not at the first score: until then they are rebalanced by gold label when Gold Labels is left.
- **Removing is a soft delete with a trail**, restorable, and the score line says how many gold-labeled examples were removed before it.
- **The "Why" on Mismatches is a comment.** Comments are append-only and reach the helpers for the readable half only.
- **Gold Labels saves only on Save**, on both tabs; "Use the model's answer" is gone.
- **Motion lives in code only** until the canvas has a way to show it.

## 2026-11-13 (building 1.0.0 phase 2)

- **The structured prompt is the only thing edited**; the text sent to the model is compiled from it and shown read-only.
- **Only a changed field or value starts a new schema version.** New wording keeps gold labels and scores valid.
- **The Optimiser and Improve with AI change wording only.** Fields and values are changed by people, on Prompt Design or in the editor.
- **Project Settings are confirmed once, before the first paid run**; nothing paid starts before that.
- **No Approve card in the chat.** A draft is approved on its page.
- **Existing 0.x projects are not migrated** (assumed test data, to be discarded).
- **The UI canvas was updated from the built site** (59 boards): the 1.0.0 screens are boards made from the pages' own markup.

## 2026-11-12 (review of the 1.0.0 spec)

- **No pass verdict under 20 scored examples.** The score shows as a rough reading and Finish stays closed.
- **Appending examples never freezes scoring.** Versions are scored on gold-labeled examples; new ones are pending; changed scores are stale until Rebuild scores.
- **Every example removal is recorded and restorable**, and the removed count shows next to the score.
- **The held-out half is not a test set.** Confirm a pass stays; an untouched test set comes with the batch labeling project.
- **Prompt import lists what it could not carry over.**
- **1.0.0 ships in four phases**, the first a contract and service refactor with no behaviour change.
- **A task that just finished is never marked as left behind** (found by the browser check during phase 1): the check that pauses tasks of closed pages reads the task again before it writes.
- **Three 0.x UI rules change in 1.0.0:** Enter sends in Ask AI (Shift+Enter adds a line, input-method safe); user-written content wraps; the Project Settings default panel shows explanations as subtitles.

## 2026-11-11

- **Gold Labels is an ordinary step** (acceptance R5-8): not optional or "recommended", and no
  way to skip it (the "None" pass rule is gone). Scores, mismatch review and the Optimiser all
  rest on gold labels.
- **Scores are rebuilt by hand** (Evelyn, 2026-11-12, replacing the 1.5 s timer and the lazy
  rebuild of 2026-11-11). A Rebuild scores button on Prompt versions works every score out again
  from saved answers. Why: gold edits, Setup changes (thresholds) and code changes all move scores,
  and it is hard to sense every case and trigger a rebuild for it. Gold Labels only writes, so the
  user never waits between edits.
- **One workflow owner starts auto tasks**, woken by events and a sweep, with keyed (idempotent)
  starts and a manual button for each auto task as the fallback. Why: one place can always say
  why a task waits.
- **A tied dry run goes on** (R5-6): it may hold what the parent lacks, so it is labeled in full
  and joins the pool, but it is not progress (a wasted round; 2 ties in a row end the run).
  Replaced on 2026-11-16: every tie goes on, progress is judged on the optimiser half, and there
  is no tie limit.
- **Round 1 changes the version the user started from** (R5-7); later rounds pick from the
  Pareto front, weighted by the examples each version wins, and the panel says which and why.
- **Invalid and filtered answers are left out of scores** (acceptance R4-6). They are counted on
  their own next to the score. A version passes only when at most 1% of its answers are invalid
  (or the project's own limit). Why: an unreadable answer is a format problem, not a wrong label,
  and it must not pass a version on a technicality either.
- **"Score" stays as the label**, with the real metric in small grey text next to it (R4-1).
- **A mismatch review belongs to a gold label and a version** (Evelyn). "Compare with" is one
  picker for the whole Gold Labels page; To review and Reviewed are for the picked version. A
  review can be reopened; a changed label then goes back to what it was (R4-5).
- **The labeler can say why** on Mismatches (R4-4). The note goes to the Optimiser and Improve with
  AI as the person's own reading of the label, for optimiser-half examples only. The helpers build
  it into the prompt and never argue with it.
- **Max rounds is asked in the Auto Optimise dialog**, with the start version (R4-3).
- **No helper sees the held-out half of the eval set** (review finding 3). Not the Assistant, the
  Labels, Prompt or Scores helper, nor the Optimiser: no example, gold label or model answer from
  it. They may read scores and counts built on it. Users still see every example on the pages.
  Why: the held-out half scores every version, and a helper that read it could write prompts that
  fit those examples, so the score would no longer say how the prompt does on new data.
- **The Optimiser reads why the model answered as it did.** The site adds one line after every
  labeling prompt asking the model for a short "reason" (one sentence) before its values. The
  reason is kept with each answer and given to the Optimiser and Improve with AI with the wrong
  examples. It is never a label and never in the exported files. Why: GEPA works best when the
  optimiser sees the trace, not only the result and the score.
- **Invalid reasons go to the helpers too** ("Not valid JSON", a value that is not in the labels);
  answers the safety filter stopped are left out, since no prompt can fix them.
- **The Optimiser's pool is every scored version**, not only its own run: the start version, the
  run's kept versions, and any other version with a current score on the model. The user's own
  versions and earlier runs may hold rules the best version lacks.
- **Gold labels are judged by people only.** No helper says a gold label is right or wrong. A
  helper that meets a label that looks odd against its definition writes no rule for it and moves
  on; people review such labels on the Mismatches tab.
- **The helpers' instructions were rewritten** (`apps/agents/src/presets.ts`): each helper is told
  why its job matters, what good output looks like, and what it must not do. The user's job is
  business knowledge and gold labels; tuning prompts is the site's job.
- **A score from fewer than about 50 examples is called a rough reading** by the Scores helper.
- **The report helpers read says whether a pass was confirmed** (`confirmed`: true, false, or
  null when there was no second labeling). The Scores helper never recommends a version whose
  pass was not confirmed.

## 2026-11-10: MVP review

- **Real eval sets have 1,000 to 3,000 examples.** Small sets are for tests only, so the minimum
  eval size stays as it is. Two needs follow, not in the MVP: uploading gold labels, and labeling
  in a worker outside the browser tab.
- **A pass is confirmed before the training set starts.** The held-out half is labeled a second
  time with the same version and settings, and both labelings must pass. The test set is not
  used for this.
- **Mismatches on Gold Labels.** The user can see where a version's answers differ from their
  gold labels, keep their label or change it. This is part of making good gold labels, not
  prompt work: tuning prompts stays the Optimiser's job. The helpers point to it after the first
  score and when Auto Optimise ends without a pass, give counts only and never say which side is
  right. Every decision is recorded.
- **Gold Labels picks the version to compare with.** Default: the best scored version.
- **Document links.** The helpers read linked documents through a document interface; the
  deployment connects the real document service.
- **Merging.** The stacked pull requests are merged in order.

## 2026-11-09

- **One labeling model per project.** Comparing models comes later.
- **The Optimiser is GEPA**, ported to TypeScript: a dry run on a small batch, a pool of
  candidates, merges. Every round makes a visible version and report; the user starts it, sets
  the most rounds, and can stop it.
- **The platform is called Sprint.**

## 2026-11-06

- **Every paid task starts by itself**, with no cost limit and no Approve card: the cost can't be
  predicted and the goal is speed. Every task has a Stop button.
- **All user input goes through Ask AI** (text or document links); pages have no input cards.
  Internal video is not a supported input type in the MVP.
- **The coded site must look exactly like the canvas.** What can't match is recorded in
  docs/ui-gaps.md and discussed after coding.
- **Test set threshold** for the MVP: 5 examples.

## 2026-11-05

- **Never show estimated time or cost to users.**
- **Defaults go straight into the input boxes**, prefilled and editable; no "Use N" buttons.

## 2026-11-04

- **Hover text has a dashed underline**; explanatory text is one short line, details on hover.
- **Two browsers labeling the same version can pay twice.** Accepted for the MVP.
- **Rate limits** (QPM, TPM) are enforced in llm-gateway per endpoint; chat and labeling use
  separate endpoints; reasoning tokens count in TPM.
- **Agents are hand-written, no framework**, all on the reasoning model. They read a page view
  built by the backend and read tools only; changes are proposals the user approves.
- **Outputs** are a labeled training set and a test set (test gold labels optional).
- **Images** go inline as content parts; labels are never sent to the labeling model.

## 2026-10-29

- **The MVP is training-set production only**, as a website with the agent built in (not an
  agent chat), with a fixed workflow and gates. Gold labels may be skipped.
- **UI terms are plain** (for example "Optimiser", "Score"); precise terms go in hovers and
  design docs.
