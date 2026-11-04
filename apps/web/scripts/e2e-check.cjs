/**
 * End-to-end check of the static build on the stand-ins (100 examples): a new project through
 * Setup, Dataset, Gold labels, scoring and the optimiser; the prompt preview; an agent question
 * answered with a read tool; model answers for the test set; then the final run (train + test)
 * watched from a second tab, interrupted by a reload and resumed from the other tab; the exports.
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
const errors = [];

(async () => {
  fs.mkdirSync(SHOTS, {recursive: true});
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tsp-e2e-'));
  const ctx = await chromium.launchPersistentContext(profile, {viewport: {width: 1440, height: 900}, deviceScaleFactor: 2});
  const watch = p => {
    p.on('pageerror', e => errors.push(e.message));
    p.on('console', m => m.type() === 'error' && errors.push(m.text()));
  };
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  watch(page);
  const shot = (p, name) => p.screenshot({path: path.join(SHOTS, `${name}.png`)});
  const main = p => p.locator('main').innerText();
  const progress = async p => ((await main(p)).match(/(Generating the training and test sets|Generating the sets is paused)|\d+ of \d+(?= *\n)/g) || []).join(' · ');
  const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

  // Setup
  await page.goto(BASE + '/');
  await page.getByPlaceholder('For example: Short-video tagging').fill('Short-video tagging');
  await page.getByRole('button', {name: 'Create project'}).click();
  await page.waitForURL(/setup/);
  const pid = new URL(page.url()).searchParams.get('p');
  const url = p => `${BASE}${p}?p=${pid}`;
  await page.getByRole('textbox').first().fill('Tag short videos by what the viewer gets from them: primary value, format and topics.');
  await page.keyboard.press('Enter');
  await page.getByRole('button', {name: 'Approve'}).click({timeout: 20000});
  await page.getByRole('button', {name: 'Next step: Evaluation'}).click();
  await page.getByRole('button', {name: 'Continue: Models'}).click();
  await page.getByRole('button', {name: 'Next step: Dataset'}).click();
  log('setup done');

  // Dataset: sample all 100, recommended eval size, 10 test
  await page.waitForURL(/dataset/);
  await page.getByRole('button', {name: /^Use 100/}).click();
  await page.getByRole('button', {name: 'Sample examples'}).click();
  await page.getByRole('button', {name: 'Use 10'}).waitFor({timeout: 60000});
  await page.waitForTimeout(1000);
  await page.getByRole('button', {name: 'Use 10'}).click();
  await page.waitForTimeout(300);
  await page.getByRole('button', {name: 'Apply', exact: true}).click();
  await page.getByText(/\d+ eval · 10 test · \d+ train/).waitFor();
  log('dataset:', ((await main(page)).match(/\d+ eval · 10 test · \d+ train/) || [''])[0]);
  await page.getByRole('button', {name: 'Next step: Gold Labels'}).click();

  // Gold labels: use the answers bundled with the sample file
  await page.waitForURL(/gold/);
  await page.getByRole('button', {name: 'Upload labels'}).click();
  await page.getByRole('button', {name: 'Use the answers that came with the examples'}).click();
  await page.getByRole('button', {name: /Prompt Engineering$/}).click({timeout: 30000});

  // Prompt: agent draft, create v1.0, scoring runs on both models at once
  await page.waitForURL(/prompt/);
  await page.getByPlaceholder('Message the assistant').fill('Please draft a starting prompt for these labels.');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => (document.querySelector('textarea')?.value ?? '').includes('{{'), null, {timeout: 20000});
  await page.getByRole('button', {name: 'Create', exact: true}).click();
  await page.getByText(/Labeling \d+\/\d+/).first().waitFor();
  await page.waitForTimeout(3500);
  await shot(page, '1-scoring-both-models');
  log('scoring started');

  // Let the optimiser run until a version passes (resume it if it pauses)
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(5000);
    const t = await main(page);
    if (/Make the training and test sets/.test(t) && !/Labeling \d+\//.test(t)) break;
    if (i % 6 === 0) log('optimising:', (t.match(/Optimiser is working[^\n]*/) || ['waiting'])[0]);
    const again = page.getByRole('button', {name: /^(Resume|Restart run|Run the optimiser for Model \w)$/});
    if (!/Optimiser is working|Labeling \d+\//.test(t) && (await again.count())) await again.first().click();
  }
  await shot(page, '2-optimiser-passed');
  log('advice:', ((await main(page)).match(/Make the training and test sets[^\n]*/) || ['none'])[0]);

  // The editor marks image placeholders and previews the prompt for one example
  await page.goto(url('/prompt/edit/'));
  await page.getByRole('heading', {name: 'Preview with an example'}).waitFor();
  await page.locator('[aria-label="Preview with an example"]').getByRole('button', {name: 'Show'}).click();
  await page.getByTestId('prompt-preview').waitFor();
  const preview = await page.getByTestId('prompt-preview').evaluate(el => ({images: el.querySelectorAll('img').length, captions: [...el.querySelectorAll('.preview-img .cap')].map(f => f.textContent).slice(0, 3), chips: document.querySelectorAll('.layer .ph.img').length}));
  log('preview:', JSON.stringify(preview));
  await page.locator('[aria-label="Preview with an example"]').scrollIntoViewIfNeeded();
  await shot(page, '6-prompt-preview');

  // An agent question the page view doesn't answer: the evaluation agent reads the report with a tool
  await page.goto(url('/prompt/'));
  await page.getByPlaceholder('Message the assistant').fill('Is the score good enough to pass?');
  await page.keyboard.press('Enter');
  await page.getByText(/has a lowest field macro-F1 of/).last().waitFor({timeout: 20000});
  const agentReply = await page.getByText(/has a lowest field macro-F1 of/).last().innerText();
  log('evaluation agent:', agentReply.slice(0, 160));
  await shot(page, '7-agent-reads-report');

  // Gold Labels: get model answers for the test set (optional, with a cost confirm)
  await page.goto(url('/gold/'));
  await page.getByRole('button', {name: 'Get model answers'}).click();
  await page.getByRole('button', {name: /^Approve \$.* and start$/}).click();
  await page.getByText(/Model answers ready from Model/).waitFor({timeout: 120000});
  log('test answers:', ((await main(page)).match(/Model answers ready[^\n.]*/) || [''])[0]);

  // Final run: start in tab 1 (the test answers above are reused)
  await page.goto(url('/training-set/'));
  await page.getByText(/already have a model answer and are reused/).waitFor({timeout: 10000});
  log('plan:', ((await main(page)).match(/Test examples\n[^\n]*/) || [''])[0].replace('\n', ' '));
  await page.getByRole('button', {name: 'Approve and generate'}).click();
  const cont = page.getByRole('button', {name: /^Continue with Model/});
  if (await cont.count()) await cont.click();
  await page.getByRole('button', {name: /^Approve \$.* and generate$/}).click();
  await page.waitForTimeout(4000);
  log('tab 1 runs:', await progress(page));

  // Tab 2 watches; it does not start a second runner
  const tab2 = await ctx.newPage();
  watch(tab2);
  await tab2.goto(url('/training-set/'));
  await tab2.waitForTimeout(4000);
  log('tab 2 sees:', await progress(tab2));
  await shot(tab2, '3-second-tab-watching');

  // Reload tab 1 mid-run: the run pauses, both tabs show it
  log('reload tab 1 at:', await progress(page));
  await page.reload();
  await page.getByText('Generating the sets is paused').waitFor({timeout: 15000});
  await tab2.getByText('Generating the sets is paused').waitFor({timeout: 15000});
  log('after reload, tab 1:', await progress(page), '| tab 2:', await progress(tab2));
  await shot(page, '4-paused-after-reload');

  // Resume from tab 2; tab 1 follows
  await tab2.getByRole('button', {name: /^(Resume|Retry failed)$/}).click();
  await page.waitForTimeout(5500);
  log('resumed in tab 2, tab 1 sees:', await progress(page));
  await tab2.getByRole('button', {name: 'Test set (JSONL)'}).waitFor({timeout: 120000});
  await tab2.waitForTimeout(1000);
  await shot(tab2, '5-training-set-done');
  const download = async name => {
    const [d] = await Promise.all([tab2.waitForEvent('download'), tab2.getByRole('button', {name}).click()]);
    return fs.readFileSync(await d.path(), 'utf8').trim().split('\n');
  };
  const trainLines = await download('Training set (JSONL)');
  const testLines = await download('Test set (JSONL)');
  const csvLines = await download('Both (CSV)');
  const exportFacts = {train: trainLines.length, test: testLines.length, testWithGold: testLines.filter(l => JSON.parse(l).gold).length, csvRows: csvLines.length - 1, csvHead: csvLines[0].split(',').slice(0, 3).join(',')};
  log('exports:', JSON.stringify(exportFacts));

  const facts = await tab2.evaluate(() => {
    const docs = k => JSON.parse(localStorage.getItem('tsp-doc:' + k) || '[]').map(d => d.data);
    const task = docs('labeling_tasks').filter(t => t.purpose === 'training').pop();
    const testTask = docs('labeling_tasks').filter(t => t.purpose === 'test').pop();
    const tools = docs('audit_log').filter(a => a.action === 'agent.tool').map(a => a.data?.name);
    const preds = docs('predictions').filter(p => p.promptVersionId === task.promptVersionId && p.endpoint === task.endpoint && p.settingsHash === task.settingsHash && task.exampleIds.includes(p.exampleId));
    const ids = JSON.parse(localStorage.getItem('tsp-doc:predictions') || '[]').map(d => d.data._appId);
    return {state: task.state, done: task.done, total: task.total, failed: task.failed, costUsd: +task.costUsd.toFixed(3), budgetUsd: +task.budgetUsd.toFixed(3), predictions: preds.length, uniqueExamples: new Set(preds.map(p => p.exampleId)).size, duplicatePredictionIds: ids.length - new Set(ids).size, testTask: testTask && {state: testTask.state, done: testTask.done, total: testTask.total, sameVersion: testTask.promptVersionId === task.promptVersionId && testTask.endpoint === task.endpoint}, toolCalls: tools};
  });
  log('training task:', JSON.stringify(facts));
  log('console errors:', errors.length ? errors : 'none');
  await ctx.close();
  const ok =
    facts.state === 'done' &&
    facts.done === facts.total &&
    facts.predictions === facts.total &&
    facts.uniqueExamples === facts.total &&
    facts.duplicatePredictionIds === 0 &&
    facts.testTask?.state === 'done' &&
    exportFacts.train + exportFacts.test === exportFacts.csvRows &&
    exportFacts.test > 0 &&
    preview.images > 0 &&
    !errors.length;
  console.log(ok ? 'E2E PASSED' : 'E2E FAILED');
  process.exit(ok ? 0 : 1);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
