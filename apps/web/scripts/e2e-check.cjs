/**
 * End-to-end check of the static build on the stand-ins (100 examples), on the Unified UI pages:
 * a new project through Setup (schema drafted in Ask AI and approved), Dataset (auto sampling),
 * Gold Labels (labeled on the page with the answers bundled with the sample file), the first
 * prompt drafted in Ask AI, scoring and the optimiser until a version passes, an agent question,
 * an agent start (with its card when one asks), then the training set watched from a second tab,
 * interrupted by a reload and resumed from the other tab, the test set, the downloads, and the
 * telemetry events and metrics.
 *
 * Needs Playwright with Chromium. Run:
 *   npm run build && npx serve apps/web/out -l 4173   (any static server)
 *   node apps/web/scripts/e2e-check.cjs [http://localhost:4173] [screenshot dir]
 */
const {chromium} = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BASE = process.argv[2] || 'http://localhost:4173';
const SHOTS = process.argv[3] || path.join(__dirname, '..', '..', '..', 'docs', 'e2e');
const LABELS = new Map(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'sample-data', 'examples.json'), 'utf8')).labels.map(l => [l.externalId, l.answer]));
const errors = [];
let current = null;

(async () => {
  fs.mkdirSync(SHOTS, {recursive: true});
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tsp-e2e-'));
  const ctx = await chromium.launchPersistentContext(profile, {viewport: {width: 1920, height: 1080}, deviceScaleFactor: 1});
  const watch = p => {
    p.on('pageerror', e => errors.push(e.message));
    p.on('console', m => m.type() === 'error' && errors.push(m.text()));
  };
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  watch(page);
  current = page;
  const shot = (p, name) => p.screenshot({path: path.join(SHOTS, `${name}.png`)});
  const main = p => p.locator('main').innerText();
  const progress = async p => ((await p.locator('main .progress small').allInnerTexts()) || []).join(' · ') || 'none';
  const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
  const button = (p, name) => p.getByRole('button', {name, exact: true});
  const ask = async (p, text) => {
    await p.locator('aside.chat, button.ask').first().waitFor();
    if (!(await p.locator('aside.chat').count())) await button(p, 'Ask AI').click();
    await p.locator('#chat-input').fill(text);
    await p.keyboard.press('Enter');
  };

  // Projects
  await page.goto(BASE + '/');
  await page.getByPlaceholder('Short-video tagging').fill('Short-video tagging');
  await button(page, 'Create project').click();
  await page.waitForURL(/setup/);
  const pid = new URL(page.url()).searchParams.get('p');
  const url = p => `${BASE}${p}?p=${pid}`;

  // Setup: the task goes in Ask AI, the draft is approved there
  await ask(page, 'Tag short videos by what the viewer gets from them: primary value, format and topics.');
  await page.locator('aside.chat').getByRole('button', {name: 'Approve'}).click({timeout: 20000});
  await page.locator('aside.chat').getByText('Approved').waitFor();
  await shot(page, '1-schema-approved');
  await button(page, 'Next: Evaluation').click();
  await button(page, 'Next: Models').click();
  await button(page, 'Next: Dataset').click();
  log('setup done');

  // Dataset: auto sampling with the prefilled count; the recommended split saves by itself
  await page.waitForURL(/dataset/);
  await button(page, 'Auto sampling').click();
  const next = button(page, 'Next: Gold Labels');
  await next.waitFor({timeout: 60000});
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent === 'Next: Gold Labels' && !b.disabled), null, {timeout: 10000});
  log('dataset:', (await page.locator('main .legend').innerText()).replace(/\s+/g, ' '));
  await shot(page, '2-dataset');
  await next.click();

  // Gold Labels: every eval example and some test examples, picked on the page
  await page.waitForURL(/gold/);
  const labelSet = async n => {
    for (let i = 0; i < n; i++) {
      const id = (await page.locator('.media small').innerText()).trim();
      const answer = LABELS.get(id);
      if (!answer) throw new Error(`No bundled label for ${id}`);
      if (!(await page.getByText('Saved', {exact: true}).count()))
        for (const [field, values] of Object.entries(answer))
          for (const v of values) await page.getByRole('group', {name: field}).getByRole('button', {name: v, exact: true}).click();
      await page.getByText('Saved', {exact: true}).waitFor({timeout: 5000});
      const fwd = button(page, 'Next');
      if (await fwd.isEnabled()) {
        await fwd.click();
        await page.waitForTimeout(150);
      }
    }
  };
  const nEval = +((await page.getByRole('tab', {name: /^Eval set/}).innerText()).match(/\/\s*(\d+)/) || [0, 0])[1];
  await labelSet(nEval);
  await shot(page, '3-gold-labels');
  await page.getByRole('tab', {name: /^Test set/}).click();
  const nTest = +((await page.getByRole('tab', {name: /^Test set/}).innerText()).match(/\/\s*(\d+)/) || [0, 0])[1];
  const testGold = Math.max(0, nTest - 3);
  await labelSet(testGold);
  log('gold labels:', await page.getByRole('tablist', {name: 'Sets'}).innerText());
  await button(page, 'Next: Prompt Engineering').click();

  // First prompt: drafted in Ask AI, then Create and score
  await page.waitForURL(/prompt/);
  await ask(page, 'Please draft a starting prompt for these labels.');
  await page.waitForFunction(() => (document.querySelector('#tpl')?.value ?? '').includes('{{'), null, {timeout: 20000});
  const create = button(page, 'Create and score');
  if (!(await create.isEnabled())) log('checks:', await page.locator('[aria-label="Checks"]').innerText());
  await shot(page, '4-first-prompt');
  await create.click();
  await page.locator('nav.vlist').waitFor();
  log('scoring started');

  // The optimiser runs until a version passes (Keep improving when the suggestion asks)
  for (let i = 0; i < 80; i++) {
    await page.waitForTimeout(4000);
    const running = await page.locator('nav.vlist').getByText('Running').count();
    if (!running && (await button(page, 'Make training and test sets').count())) break;
    const keep = button(page, 'Keep improving');
    if (!running && (await keep.count()) && !(await page.locator('.card.ai').innerText()).includes('passes')) await keep.click();
    if (i % 5 === 0) log('versions:', (await page.locator('nav.vlist').innerText()).replace(/\n/g, ' ').slice(0, 120));
  }
  await shot(page, '5-prompt-versions');
  log('suggestion:', (await page.locator('.card.ai').innerText().catch(() => 'none')).replace(/\n/g, ' | '));

  // The prompt page for a version: editor, checks and features
  await page.getByRole('link', {name: 'Edit prompt'}).click();
  await page.waitForURL(/prompt\/edit/);
  await page.locator('[aria-label="Checks"]').waitFor();
  log('checks:', (await page.locator('[aria-label="Checks"]').innerText()).replace(/\n/g, ' | '));
  await shot(page, '6-prompt-edit');

  // An agent question: the evaluation agent reads the report with a tool
  await page.goto(url('/prompt/'));
  await ask(page, 'Is the score good enough to pass?');
  await page.locator('aside.chat').getByText(/macro-F1/i).last().waitFor({timeout: 20000});
  log('evaluation agent:', (await page.locator('aside.chat .msg-a').last().innerText()).replace(/\n/g, ' ').slice(0, 160));
  await shot(page, '7-ask-ai');

  // An agent start: runs within the caps, or asks with a card first
  await ask(page, 'Please try the current prompt on model A.');
  const approve = page.locator('aside.chat').getByRole('button', {name: 'Approve', exact: true});
  await Promise.race([approve.waitFor({timeout: 15000}).catch(() => undefined), page.locator('aside.chat').getByText(/Tried the draft on \d+ eval examples/).waitFor({timeout: 15000}).catch(() => undefined)]);
  if (await approve.count()) await approve.last().click();
  const tried = await page
    .locator('aside.chat')
    .getByText(/Tried the draft on \d+ eval examples/)
    .last()
    .innerText({timeout: 30000})
    .catch(() => 'no result');
  log('agent start:', tried.split('\n')[0]);

  // Training set: start in tab 1
  await page.goto(url('/training-set/'));
  await button(page, 'Start labeling').click();
  await page.locator('main .progress').waitFor();
  await page.waitForTimeout(4000);
  log('tab 1 runs:', await progress(page));
  await shot(page, '8-training-set-labeling');

  // Tab 2 watches; it does not start a second runner
  const tab2 = await ctx.newPage();
  watch(tab2);
  await tab2.setViewportSize({width: 1920, height: 1080});
  await tab2.goto(url('/training-set/'));
  await tab2.waitForTimeout(4000);
  log('tab 2 sees:', await progress(tab2));

  // Reload tab 1 mid-run: the run stops, both tabs show it
  log('reload tab 1 at:', await progress(page));
  await page.reload();
  await page.locator('main').getByText('Stopped', {exact: true}).waitFor({timeout: 15000});
  await tab2.locator('main').getByText('Stopped', {exact: true}).waitFor({timeout: 15000});
  log('after reload, tab 1:', await progress(page), '| tab 2:', await progress(tab2));

  // Resume from tab 2; tab 1 follows
  await button(tab2, 'Resume').click();
  await page.waitForTimeout(5500);
  log('resumed in tab 2, tab 1 sees:', await progress(page));
  await tab2.getByRole('tab', {name: /^Training set.*Finished/}).waitFor({timeout: 180000});
  await tab2.waitForTimeout(1000);
  await shot(tab2, '9-training-set-done');
  const download = async name => {
    const [d] = await Promise.all([tab2.waitForEvent('download'), button(tab2, name).click()]);
    return fs.readFileSync(await d.path(), 'utf8').trim().split('\n');
  };
  const trainLines = await download('Download JSONL');
  const trainCsv = await download('Download CSV');

  // Test set: its own labeling; gold labels are kept, the rest come from the model
  await tab2.getByRole('tab', {name: /^Test set/}).click();
  await button(tab2, 'Start labeling').click();
  await tab2.getByRole('tab', {name: /^Test set.*Finished/}).waitFor({timeout: 120000});
  await tab2.waitForTimeout(1000);
  await shot(tab2, '10-test-set-done');
  const testLines = await download('Download JSONL');
  const testCsv = await download('Download CSV');
  const sources = testLines.map(l => JSON.parse(l).label_source);
  const exportFacts = {train: trainLines.length, trainCsvRows: trainCsv.length - 1, test: testLines.length, testCsvRows: testCsv.length - 1, fromGold: sources.filter(s => s === 'gold').length, fromModel: sources.filter(s => s === 'model').length, testCsvHead: testCsv[0]};
  log('exports:', JSON.stringify(exportFacts));

  const facts = await tab2.evaluate(() => {
    const docs = k => JSON.parse(localStorage.getItem('tsp-doc:' + k) || '[]').map(d => d.data);
    const task = docs('labeling_tasks').filter(t => t.purpose === 'training').pop();
    const testTask = docs('labeling_tasks').filter(t => t.purpose === 'test').pop();
    const tools = docs('audit_log').filter(a => a.action === 'agent.tool').map(a => a.data?.name);
    const preds = docs('predictions').filter(p => p.promptVersionId === task.promptVersionId && p.endpoint === task.endpoint && p.settingsHash === task.settingsHash && task.exampleIds.includes(p.exampleId));
    const ids = JSON.parse(localStorage.getItem('tsp-doc:predictions') || '[]').map(d => d.data._appId);
    const audit = docs('audit_log').map(a => a.action);
    const ts = docs('training_sets').pop();
    return {state: task.state, done: task.done, total: task.total, failed: task.failed, predictions: preds.length, uniqueExamples: new Set(preds.map(p => p.exampleId)).size, duplicatePredictionIds: ids.length - new Set(ids).size, testTask: testTask && {state: testTask.state, done: testTask.done, total: testTask.total}, trainTotal: ts.trainTotal, toolCalls: tools, autoStarts: audit.filter(a => a === 'auto_start').length, cardsApproved: audit.filter(a => a === 'start_card.approve').length};
  });
  log('training task:', JSON.stringify(facts));
  // Telemetry: flush, then read what the stand-in sink kept (events in localStorage, metrics text)
  await tab2.evaluate(
    () =>
      new Promise(r => {
        document.dispatchEvent(new Event('visibilitychange'));
        setTimeout(r, 300);
      }),
  );
  const tel = await tab2.evaluate(() => {
    const ev = JSON.parse(localStorage.getItem('tsp-telemetry-events') || '[]');
    const names = {};
    for (const e of ev) names[e.event] = (names[e.event] || 0) + 1;
    const leaks = ev.filter(e => /Short-video tagging|Tag short videos/.test(JSON.stringify(e))).length;
    const text = globalThis.__tspMetrics || '';
    const series = [...new Set(text.split('\n').filter(l => l && !l.startsWith('#')).map(l => l.split(/[{ ]/)[0].replace(/_(bucket|sum|count)$/, '')))];
    // Labels whose values come from the running apps: none should fall back to "other".
    const undeclared = [...new Set([...text.matchAll(/\b(endpoint|model|method|op|collection)="other"/g)].map(m => m[1]))];
    return {events: ev.length, names, leaks, undeclared, metricNames: series.length, sample: series.filter(s => /tsp_(llm_requests|labeling_examples|agent_turns|bff_calls|web_page_views|auto_starts|cost_confirms)/.test(s))};
  });
  log('telemetry:', JSON.stringify(tel));
  log('console errors:', errors.length ? errors : 'none');
  await ctx.close();
  const ok =
    facts.state === 'done' &&
    facts.done === facts.total &&
    facts.predictions === facts.total &&
    facts.uniqueExamples === facts.total &&
    facts.duplicatePredictionIds === 0 &&
    facts.total === facts.trainTotal &&
    facts.testTask?.state === 'done' &&
    exportFacts.train === exportFacts.trainCsvRows &&
    exportFacts.test === exportFacts.testCsvRows &&
    exportFacts.test > 0 &&
    exportFacts.fromGold === testGold &&
    exportFacts.fromGold + exportFacts.fromModel === exportFacts.test &&
    tel.events > 0 &&
    tel.leaks === 0 &&
    tel.undeclared.length === 0 &&
    tel.sample.length >= 4 &&
    !errors.length;
  console.log(ok ? 'E2E PASSED' : 'E2E FAILED');
  process.exit(ok ? 0 : 1);
})().catch(async e => {
  console.error(e);
  if (current) await current.screenshot({path: path.join(SHOTS, 'failed.png')}).catch(() => undefined);
  process.exit(1);
});
