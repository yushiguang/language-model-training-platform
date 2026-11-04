/**
 * End-to-end check of the static build on the stand-ins (100 examples): a new project through
 * Setup, Dataset, Gold labels, scoring and the optimiser, then a training set run watched from a
 * second tab, interrupted by a reload and resumed from the other tab.
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
  const progress = async p => ((await main(p)).match(/(Generating the training set|Training set generation paused)|\d+ of \d+(?= *\n)/g) || []).join(' · ');
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
    if (/Make the training set/.test(t) && !/Labeling \d+\//.test(t)) break;
    if (i % 6 === 0) log('optimising:', (t.match(/Optimiser is working[^\n]*/) || ['waiting'])[0]);
    const again = page.getByRole('button', {name: /^(Resume|Restart run|Run the optimiser for Model \w)$/});
    if (!/Optimiser is working|Labeling \d+\//.test(t) && (await again.count())) await again.first().click();
  }
  await shot(page, '2-optimiser-passed');
  log('advice:', ((await main(page)).match(/Make the training set[^\n]*/) || ['none'])[0]);

  // Training set: start in tab 1
  await page.goto(url('/training-set/'));
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
  await page.getByText('Training set generation paused').waitFor({timeout: 15000});
  await tab2.getByText('Training set generation paused').waitFor({timeout: 15000});
  log('after reload, tab 1:', await progress(page), '| tab 2:', await progress(tab2));
  await shot(page, '4-paused-after-reload');

  // Resume from tab 2; tab 1 follows
  await tab2.getByRole('button', {name: /^(Resume|Retry failed)$/}).click();
  await page.waitForTimeout(5500);
  log('resumed in tab 2, tab 1 sees:', await progress(page));
  await tab2.getByText('Labeled examples').waitFor({timeout: 120000});
  await tab2.waitForTimeout(1000);
  await shot(tab2, '5-training-set-done');

  const facts = await tab2.evaluate(() => {
    const docs = k => JSON.parse(localStorage.getItem('tsp-doc:' + k) || '[]').map(d => d.data);
    const task = docs('labeling_tasks').filter(t => t.purpose === 'training').pop();
    const preds = docs('predictions').filter(p => p.promptVersionId === task.promptVersionId && p.endpoint === task.endpoint && p.settingsHash === task.settingsHash && task.exampleIds.includes(p.exampleId));
    const ids = JSON.parse(localStorage.getItem('tsp-doc:predictions') || '[]').map(d => d.data._appId);
    return {state: task.state, done: task.done, total: task.total, failed: task.failed, costUsd: +task.costUsd.toFixed(3), budgetUsd: +task.budgetUsd.toFixed(3), predictions: preds.length, uniqueExamples: new Set(preds.map(p => p.exampleId)).size, duplicatePredictionIds: ids.length - new Set(ids).size};
  });
  log('training task:', JSON.stringify(facts));
  log('console errors:', errors.length ? errors : 'none');
  await ctx.close();
  const ok = facts.state === 'done' && facts.done === facts.total && facts.predictions === facts.total && facts.uniqueExamples === facts.total && facts.duplicatePredictionIds === 0 && !errors.length;
  console.log(ok ? 'E2E PASSED' : 'E2E FAILED');
  process.exit(ok ? 0 : 1);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
