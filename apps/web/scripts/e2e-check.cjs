/**
 * End-to-end check of the static build on the stand-ins, on the 1.0.0 four-step flow: the Projects
 * list (create, and Delete with the exact-name confirmation), Prompt Design (an existing prompt
 * pasted into Ask AI is imported with its "Not carried over" list; a prompt drafted from a
 * description is approved as v1 with the page's Approve button, never in the chat), Eval Dataset
 * (auto sampling, no split), Gold Labels (labeled on the page with the answers bundled with the
 * sample file), the Project Settings confirmation before the first paid run, then Prompt Tuning:
 * scoring, the fixed AI Suggestion cards, Mismatches, Improve with AI with word marks, Auto
 * Optimise until a version passes, Copy prompt and Finish; and the telemetry events and metrics.
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
/** Examples in the eval dataset of this check. */
const N = 40;
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
  // Screenshots wait for the entrance motion (at most 220ms) to end.
  // With E2E_DUMP set to a folder, each screenshot also saves the page's markup there (media
  // replaced by their size), which is how the UI canvas boards are made from the build.
  const shot = async (p, name) => {
    await p.waitForTimeout(260);
    await p.screenshot({path: path.join(SHOTS, `${name}.png`)});
    if (process.env.E2E_DUMP) {
      const d = await p.evaluate(() => {
        const marked = [];
        for (const el of document.querySelectorAll('img, iframe, video')) {
          const r = el.getBoundingClientRect();
          el.setAttribute('data-ph', `${Math.round(r.width)}x${Math.round(r.height)}`);
          marked.push(el);
        }
        for (const el of document.querySelectorAll('input, textarea')) {
          if (el.type === 'checkbox' || el.type === 'radio' || el.type === 'file') continue;
          if (el.tagName === 'TEXTAREA') el.textContent = el.value;
          else el.setAttribute('value', el.value);
        }
        const html = document.body.innerHTML;
        for (const el of marked) el.removeAttribute('data-ph');
        return {html, h: document.documentElement.scrollHeight, cls: document.body.className};
      });
      fs.mkdirSync(process.env.E2E_DUMP, {recursive: true});
      fs.writeFileSync(path.join(process.env.E2E_DUMP, `${name}.json`), JSON.stringify(d));
    }
  };
  const main = p => p.locator('main').innerText();
  const progress = async p => ((await p.locator('main .progress small').allInnerTexts()) || []).join(' · ') || 'none';
  const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
  const button = (p, name) => p.getByRole('button', {name, exact: true});
  const ask = async (p, text) => {
    await p.locator('aside.chat, button.ask').first().waitFor();
    if (!(await p.locator('aside.chat').count())) await button(p, 'Ask AI').click();
    // Spec 6.1: Shift+Enter adds a line; an Enter that ends an input method's composition never
    // sends; Enter sends.
    const before = await p.locator('aside.chat .msg-u').count();
    const box = p.locator('#chat-input');
    await box.fill(text);
    await box.press('Shift+Enter');
    if (!(await box.inputValue()).endsWith('\n')) throw new Error('Shift+Enter did not add a line');
    await box.dispatchEvent('compositionstart');
    await box.press('Enter');
    await box.dispatchEvent('compositionend');
    await box.evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', keyCode: 229, isComposing: true, bubbles: true})));
    await p.waitForTimeout(150);
    if ((await p.locator('aside.chat .msg-u').count()) !== before) throw new Error('Enter sent the message while composing');
    await box.fill(text);
    await box.press('Enter');
    await p.locator('aside.chat .msg-u').nth(before).waitFor({timeout: 5000});
  };

  // Projects: one light list; Delete asks for the exact project name
  await page.goto(BASE + '/');
  await page.getByPlaceholder('Short-video tagging').fill('Scratch project');
  await button(page, 'Create project').click();
  await page.waitForURL(/prompt-design/);
  await page.goto(BASE + '/');
  await page.getByRole('link', {name: 'Scratch project'}).waitFor();
  if (await page.getByText('Current step', {exact: true}).count()) throw new Error('the Projects list still has a Current step column');
  await page.getByRole('button', {name: 'Delete Scratch project'}).click();
  const del = page.getByRole('dialog');
  await del.waitFor();
  if (!(await button(del, 'Delete project').isDisabled())) throw new Error('Delete project is on before the name is typed');
  await del.getByLabel('Project name').fill('scratch project');
  if (!(await button(del, 'Delete project').isDisabled())) throw new Error('Delete project accepts a name that is not exact');
  await shot(page, '0-delete-project');
  await del.getByLabel('Project name').fill('Scratch project');
  await button(del, 'Delete project').click();
  await del.waitFor({state: 'detached', timeout: 10000});
  await page.getByRole('link', {name: 'Scratch project'}).waitFor({state: 'detached', timeout: 10000});
  log('project deleted after typing its exact name');

  await page.getByPlaceholder('Short-video tagging').fill('Short-video tagging');
  await button(page, 'Create project').click();
  await page.waitForURL(/prompt-design/);
  const pid = new URL(page.url()).searchParams.get('p');
  const url = p => `${BASE}${p}?p=${pid}`;
  const approveBtn = page.locator('main').getByRole('button', {name: 'Approve', exact: true});

  // Prompt Design: an existing prompt pasted into Ask AI is sorted into the structured parts,
  // and what has no place is listed word for word (spec 3.2).
  const pasted = [
    'You label customer messages for a support team.',
    '',
    '## Intent',
    '- Complaint: something went wrong and the customer wants it fixed',
    '- Question: the customer asks how to do something',
    'When a message does both, choose Complaint.',
    '',
    '## Rules',
    '- If the message is empty, choose Question.',
    '',
    '## Examples',
    'Message: "my order is late" -> Complaint',
    '',
    '## Output',
    'Return JSON only.',
  ].join('\n');
  await ask(page, pasted);
  const lost = page.locator('section[aria-label="Not carried over"]');
  await lost.waitFor({timeout: 20000});
  const lostText = await lost.innerText();
  if (!/2 passages/.test(lostText) || !lostText.includes('my order is late') || !lostText.includes('Return JSON only.')) throw new Error(`the Not carried over list is wrong: ${lostText}`);
  if ((await page.getByLabel('Field name').inputValue()) !== 'intent') throw new Error('the imported field is missing');
  // Approval is the page's button, with its attention halo; the chat never shows an Approve card.
  if (await page.locator('aside.chat').getByRole('button', {name: 'Approve', exact: true}).count()) throw new Error('the chat shows an Approve card');
  if (!(await approveBtn.evaluate(el => el.classList.contains('btn-cue')))) throw new Error('Approve has no attention halo while a draft waits');
  log('import:', (await page.locator('aside.chat .msg-a').last().innerText()).replace(/\n/g, ' ').slice(0, 200));
  await shot(page, '1-import-not-carried-over');
  await button(page, 'Discard').click();
  await lost.waitFor({state: 'detached', timeout: 10000});

  // The prompt for this project: drafted from a description, checked as full text, approved as v1
  await ask(page, 'Tag short videos by what the viewer gets from them: primary value, format and topics.');
  await page.getByText('AI draft', {exact: true}).waitFor({timeout: 20000});
  await page.waitForFunction(() => document.querySelector('[aria-label="Field name"]')?.value === 'primary_value', null, {timeout: 10000});
  // Long definitions are multi-line boxes, never clipped (spec 3.3)
  const clipped = await page.locator('textarea[aria-label="Definition"]').evaluateAll(els => els.filter(el => el.scrollHeight > el.clientHeight + 2).length);
  if (clipped) throw new Error(`${clipped} definitions are clipped`);
  await shot(page, '1b-prompt-design-draft');
  await button(page, 'View full prompt').click();
  const full = page.getByRole('dialog');
  const fullText = await full.locator('pre').innerText();
  if (!fullText.includes('{{Description}}') || !fullText.includes('Return JSON only') || !fullText.includes('primary_value')) throw new Error('the full prompt is not compiled from the parts');
  await shot(page, '1c-full-prompt');
  await button(full, 'Copy prompt').click();
  await button(full, 'Close').click();
  await approveBtn.click();
  await page.getByText('Approved as v1', {exact: true}).waitFor({timeout: 10000});
  // The helper says what comes next (spec 6.2)
  await page.locator('aside.chat').getByText(/v1 is saved\. Next, click "Next: Eval Dataset" at the top right/).waitFor({timeout: 10000});
  await shot(page, '1d-prompt-approved');
  await button(page, 'Next: Eval Dataset').click();
  log('prompt design done');

  // Eval Dataset: auto sampling; every example is used for evaluation, there is no split to set
  await page.waitForURL(/dataset/);
  // The default is prefilled: every example available
  await page.waitForFunction(() => +document.querySelector('[aria-label="Example count"]')?.value > 0, null, {timeout: 10000});
  await page.getByLabel('Example count').fill(String(N));
  await button(page, 'Auto sampling').click();
  const next = button(page, 'Next: Gold Labels');
  await next.waitFor({timeout: 60000});
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent === 'Next: Gold Labels' && !b.disabled), null, {timeout: 10000});
  if (await page.getByText('Split', {exact: true}).count()) throw new Error('the Eval Dataset page still has a split');
  if (await button(page, 'Check labels').count()) throw new Error('the Eval Dataset page still has the Check labels card');
  log('dataset:', (await page.locator('main .metrics').innerText()).replace(/\s+/g, ' '));
  await shot(page, '2-dataset');
  await next.click();

  // Gold Labels: every eval example and some test examples, picked on the page
  await page.waitForURL(/gold/);
  // Spec 5.3: nothing saves before Save; in To label, Save moves on to the next example.
  const labelSet = async n => {
    for (let i = 0; i < n; i++) {
      const id = (await page.locator('.media small').innerText()).trim();
      const answer = LABELS.get(id);
      if (!answer) throw new Error(`No bundled label for ${id}`);
      for (const [field, values] of Object.entries(answer))
        for (const v of values) await page.getByRole('group', {name: field}).getByRole('button', {name: v, exact: true}).click();
      if (i === 0) {
        await page.waitForTimeout(400);
        if (await page.getByText('Saved', {exact: true}).count()) throw new Error('a label saved before Save');
      }
      await button(page, 'Save').click();
      if (i < n - 1) await page.waitForFunction(was => document.querySelector('.media small')?.textContent?.trim() !== was, id, {timeout: 5000});
      else await page.getByText('Every example is labeled', {exact: true}).waitFor({timeout: 5000});
    }
  };
  const nEval = +((await page.getByRole('tab', {name: /^Eval set/}).innerText()).match(/\/\s*(\d+)/) || [0, 0])[1];
  if (nEval !== N) throw new Error(`the eval set has ${nEval} examples, not ${N}`);
  if (await page.getByRole('tab', {name: /^Test set/}).count()) throw new Error('Gold Labels still has a Test set tab');
  if (!(await page.getByRole('button', {name: `To label ${N}`}).count())) throw new Error('Gold Labels has no To label filter');
  if (await page.getByText("Use the model's answer").count()) throw new Error("Use the model's answer is still there");
  await shot(page, '3-gold-labels');
  await labelSet(nEval);
  log('gold labels:', await page.getByRole('tablist', {name: 'Sets'}).innerText());
  // Labeled: Save updates in place; a comment is added and listed with who and when (spec 5.4).
  await page.getByRole('button', {name: /^Labeled \d+$/}).click();
  const firstId = (await page.locator('.media small').innerText()).trim();
  await page.getByLabel('Add a comment').fill('Shot at home, so it counts as a vlog');
  await page.getByText('Not saved', {exact: true}).waitFor();
  await button(page, 'Save').click();
  await page.locator('.cmts').getByText('Shot at home, so it counts as a vlog').waitFor({timeout: 5000});
  if ((await page.locator('.media small').innerText()).trim() !== firstId) throw new Error('saving in Labeled moved to another example');
  await shot(page, '3a-gold-comment');
  // Remove example: out of scope; it leaves the eval set and shows under Removed on Eval Dataset.
  await button(page, 'Next').click();
  await button(page, 'Remove example').click();
  const rm = page.getByRole('dialog');
  await rm.getByRole('radio', {name: /Out of scope/}).click();
  await shot(page, '3c-remove-example');
  await button(rm, 'Remove').click();
  await page.getByRole('button', {name: `Labeled ${N - 1}`}).waitFor({timeout: 5000});
  log('removed one example; gold labels:', await page.getByRole('tablist', {name: 'Sets'}).innerText());

  // The first paid run is about to start: Project Settings opens once, to be confirmed (spec 2.3)
  await button(page, 'Next: Prompt Tuning').click();
  const set = page.getByRole('dialog');
  await set.getByText('Project Settings', {exact: true}).waitFor({timeout: 5000});
  // Default shows its exact thresholds, locked; each check's meaning is a line under its name
  const f1 = set.getByLabel('Macro-F1 threshold');
  if ((await f1.inputValue()) !== '0.80' || !(await f1.isDisabled())) throw new Error('Default does not show Macro-F1 0.80 locked');
  if ((await set.getByLabel('Value F1 threshold').inputValue()) !== '–') throw new Error('Default does not show Value F1 as off');
  if ((await set.getByLabel('Invalid outputs limit').inputValue()) !== '≤ 1%') throw new Error('Invalid outputs is not shown as locked at 1%');
  if (!(await set.getByText('Per field. Every value counts the same, so rare values matter.').count())) throw new Error('a check has no plain subtitle');
  if (await set.locator('.hov').count()) throw new Error('Project Settings still uses hover text');
  await shot(page, '3b-project-settings');
  await set.getByRole('radio', {name: /^Custom/}).click();
  if (await f1.isDisabled()) throw new Error('Custom does not unlock the thresholds');
  await set.getByRole('radio', {name: /^Default/}).click();
  await button(set, 'Confirm').click();
  await page.waitForURL(/\/prompt\/?\?/);
  await page.locator('nav.vlist').waitFor();
  log('settings confirmed; scoring starts by itself');

  const suggestion = async () => ((await page.locator('.card.ai').count()) ? page.locator('.card.ai').first().innerText() : '');
  // Right after the first score, the model disagrees with some gold labels: Review labels opens
  // Gold Labels' Mismatches tab (review finding 2). One label is kept, one takes the model's answer.
  for (let i = 0; i < 30 && !(await button(page, 'Review labels').count()) && !(await button(page, 'Improve with AI').count()); i++) await page.waitForTimeout(1000);
  if (await button(page, 'Review labels').count()) {
    log('suggestion:', (await suggestion()).replace(/\n/g, ' | '));
    // R4-6: the version card says what the score rests on.
    log('left out:', await page.getByText(/^Scored on \d+ of \d+ examples/).first().innerText());
    await shot(page, '4b-disagree');
    await button(page, 'Review labels').click();
    await page.waitForURL(/gold/);
    const tab = page.getByRole('tab', {name: /^Mismatches/});
    await tab.waitFor();
    const before = +((await tab.innerText()).match(/(\d+)\s*$/) || [0, 0])[1];
    await page.getByLabel('Compare with').waitFor();
    log('mismatches:', before, '· compare with', await page.getByLabel('Compare with').locator('option:checked').innerText());
    const why = await page.locator('section.card', {hasText: 'Model answer'}).innerText();
    log('model answer card:', why.replace(/\n/g, ' | ').slice(0, 200));
    if (!/Model's reason|Not readable/.test(why)) throw new Error("the Model answer card shows no reason");
    await page.getByLabel('Add a comment').fill('The clip is cut from a show');
    await shot(page, '4c-mismatches');
    const tabCount = n => page.waitForFunction(k => +((document.querySelector('[role=tab][aria-selected=true]')?.textContent ?? '').match(/(\d+)\s*$/) || [0, 0])[1] === k, n, {timeout: 10000});
    // R6-3: nothing saves before Save.
    await button(page, 'Save').click();
    await tabCount(before - 1);
    // The review shows under Reviewed with its comment listed; Save adds a review in place.
    await page.getByRole('button', {name: /^Reviewed \d+$/}).click();
    await page.getByText('Kept my label', {exact: true}).waitFor({timeout: 5000});
    await page.locator('.cmts').getByText('The clip is cut from a show').waitFor({timeout: 5000});
    if (!(await button(page, 'Save').isDisabled())) throw new Error('Save is on before anything changed');
    await page.getByLabel('Add a comment').fill('Looked again: it is cut from a show');
    await page.getByText('Not saved', {exact: true}).waitFor();
    await shot(page, '4d-reviewed-editing');
    const reviewedTab = await page.getByRole('button', {name: /^Reviewed \d+$/}).innerText();
    await button(page, 'Save').click();
    await page.getByText('2 reviews', {exact: true}).waitFor({timeout: 5000});
    if ((await page.getByRole('button', {name: /^Reviewed \d+$/}).innerText()) !== reviewedTab) throw new Error('editing a review moved it');
    log('reviewed item edited in place:', reviewedTab);
    await page.getByRole('button', {name: /^To review \d+$/}).click();
    if (before > 1) {
      // Take the model's answer by picking its chips (the shortcut button is gone, spec 5.3).
      const picks = await page.locator('section.card', {hasText: 'Model answer'}).evaluate(card =>
        [...card.querySelectorAll('.row')].map(r => [r.querySelector('.code')?.textContent?.trim(), [...r.querySelectorAll('.ch')].map(c => c.textContent.trim())]).filter(([f, v]) => f && v.length),
      );
      const ours = page.locator('section.card', {hasText: 'Your answer'});
      for (const [field, values] of picks) {
        const group = ours.getByRole('group', {name: field});
        for (const b of await group.getByRole('button').all()) if ((await b.getAttribute('aria-pressed')) === 'true' && !values.includes((await b.innerText()).trim())) await b.click();
        for (const v of values) if ((await group.getByRole('button', {name: v, exact: true}).getAttribute('aria-pressed')) !== 'true') await group.getByRole('button', {name: v, exact: true}).click();
      }
      await button(page, 'Save').click();
      await page.waitForFunction(n => +((document.querySelector('[role=tab][aria-selected=true]')?.textContent ?? '').match(/(\d+)\s*$/) || [0, 0])[1] === n - 2, before, {timeout: 10000});
    }
    log('mismatches after review:', await tab.innerText());
    await page.goto(url('/prompt/'));
    await page.locator('nav.vlist').waitFor();
    // 2026-11-12: a gold change leaves scores out of date until Rebuild scores is pressed.
    if (before > 1) {
      await page.getByText('Scores out of date', {exact: true}).first().waitFor({timeout: 5000});
      await shot(page, '4e-scores-out-of-date');
      await button(page, 'Rebuild scores').click();
      await page.getByText('Scores out of date', {exact: true}).first().waitFor({state: 'detached', timeout: 10000});
      log('scores rebuilt by hand');
    }
  }

  // Below the bar: Improve with AI puts the Prompt helper's draft in the editor, saved as v1.1
  for (let i = 0; i < 30 && !(await button(page, 'Improve with AI').count()); i++) await page.waitForTimeout(1000);
  if ((await button(page, 'Auto Optimise').count()) > 0) {
    await button(page, 'Improve with AI').first().click();
    await page.waitForURL(/prompt\/edit/);
    await page.getByText('Draft from Prompt helper', {exact: true}).waitFor({timeout: 20000});
    await page.locator('.sp-marks ins').first().waitFor({timeout: 10000});
    log('improve with AI:', await page.locator('.sp-marks ins').count(), 'changes marked');
    // Each change carries its reason
    const why = page.locator('.sp-marks ins.why').first();
    if (!(await why.count())) throw new Error('the helper draft has no change with a reason');
    log('change reason:', await why.getAttribute('title'));
    // Improve with AI changes wording only: no warning about the label fields
    if (await page.getByText(/This changes the label fields or values/).count()) throw new Error('Improve with AI changed the label fields');
    if (!(await button(page, 'Save').evaluate(el => el.classList.contains('btn-cue')))) throw new Error('Save has no attention halo for a helper draft');
    await shot(page, '5a-improve-draft');
    if (!(await page.getByRole('button', {name: /^Save as v\d+$/}).count())) throw new Error('Save as vN (next major) is missing');
    await page.getByRole('button', {name: 'Save', exact: true}).click();
    await page.waitForURL(/\/prompt\/?\?/);
  }

  // Auto Optimise until a version passes: the card then says to use it as the final prompt (T6)
  let optimised = false;
  for (let i = 0; i < 360; i++) {
    await page.waitForTimeout(1500);
    const text = await suggestion();
    if (/as your final prompt/.test(text)) break;
    const panel = page.locator('section[aria-label="Optimiser"]');
    if (await panel.count()) {
      if (i % 4 === 0) log('optimiser:', (await panel.innerText()).replace(/\n/g, ' ').slice(0, 160));
      if (!optimised) await shot(page, '5b-optimiser-running');
      optimised = true;
      if (await button(page, 'Retry').count()) throw new Error(`the Optimiser failed: ${await panel.innerText()}`);
      // Round 6: a run that ended without a pass keeps its panel and says how it ended, until a
      // version is picked.
      if (await panel.getByText('Finished', {exact: true}).count()) {
        const end = panel.getByRole('button', {name: /^Show v/});
        await end.waitFor({timeout: 5000});
        log('run ended:', (await panel.locator('.hov').first().innerText()).trim());
        await shot(page, '5g-run-end');
        await end.click();
        await panel.waitFor({state: 'detached', timeout: 5000});
      }
      continue;
    }
    const auto = button(page, 'Auto Optimise');
    if (await auto.count()) {
      await auto.click();
      // R4-3: Auto Optimise always opens one dialog: Start from (only when a better minor of the
      // selected major exists) and Max rounds.
      const dlg = page.getByRole('dialog');
      await dlg.waitFor({timeout: 5000});
      if ((await dlg.getByLabel('Max rounds').inputValue()) !== '10') throw new Error('Max rounds is not prefilled with 10');
      log('start dialog:', (await dlg.innerText()).replace(/\n/g, ' | '));
      await shot(page, '5e-start-dialog');
      await dlg.getByRole('button', {name: 'Start', exact: true}).click();
      log('auto optimise started');
    }
  }
  await shot(page, '5-prompt-versions');
  log('suggestion:', (await suggestion()).replace(/\n/g, ' | '));
  log('versions:', (await page.locator('nav.vlist').innerText()).replace(/\n/g, ' '));
  if (optimised) {
    await button(page, 'Major').click();
    await shot(page, '5c-versions-major');
    await button(page, 'All').click();
    const dropped = page.locator('nav.vlist').getByText('Dropped', {exact: true}).first();
    if (await dropped.count()) {
      await dropped.click();
      await page.getByText('Dropped after dry run', {exact: true}).first().waitFor();
      // A dropped version gets a suggestion too: switch back to the best one (T5), and its badge says why on hover
      const back = page.getByRole('button', {name: /^Switch to v/});
      await back.waitFor({timeout: 5000});
      log('dropped suggestion:', (await suggestion()).replace(/\n/g, ' | '));
      await page.locator('nav.vlist .hov', {hasText: 'Dropped'}).first().hover();
      await page.getByRole('tooltip').getByText(/In the dry run/).waitFor({timeout: 5000});
      await shot(page, '5d-dropped');
      await page.mouse.move(5, 5);
      await back.click();
      await page.getByText('Dropped after dry run', {exact: true}).first().waitFor({state: 'detached', timeout: 5000});
      await page.locator('nav.vlist button').first().click();
      // R6-2: the eye button hides dropped versions, and shows them again.
      await page.getByRole('button', {name: 'Hide dropped versions'}).click();
      if (await page.locator('nav.vlist').getByText('Dropped', {exact: true}).count()) throw new Error('dropped versions still show');
      await shot(page, '5f-dropped-hidden');
      await page.getByRole('button', {name: 'Show dropped versions'}).click();
      await page.locator('nav.vlist').getByText('Dropped', {exact: true}).first().waitFor();
      log('hide dropped: works');
    }
  }

  // T6: copy the final prompt, then mark the project finished
  await page.locator('nav.vlist button').first().click();
  await page.getByRole('button', {name: 'Copy prompt', exact: true}).click();
  await page.getByRole('button', {name: 'Copied', exact: true}).waitFor({timeout: 5000});
  await button(page, 'Finish').click();
  await page.locator('.card.ai').getByText('Finished', {exact: true}).waitFor({timeout: 10000});
  await shot(page, '5h-finished');

  // The prompt editor for a version: the same three parts, with word marks against the saved text
  await page.locator('main').getByRole('link', {name: 'Edit prompt', exact: true}).click();
  await page.waitForURL(/prompt\/edit/);
  await page.getByLabel('Task summary').waitFor();
  log('opened version marks:', await page.locator('.sp-marks').count(), (await page.locator('.ph-actions .badge').allInnerTexts()).join(', ') || '(no badge)');
  await shot(page, '6-prompt-edit');
  // Your own edits: new wording is marked, and it does not touch gold labels
  const def = page.locator('textarea[aria-label="Definition"]').first();
  const before = await def.inputValue();
  await def.fill(`${before}, such as jokes`);
  await page.getByText('Unsaved changes', {exact: true}).waitFor();
  await page.locator('.sp-marks ins', {hasText: 'jokes'}).waitFor({timeout: 5000});
  if (await page.getByText(/This changes the label fields or values/).count()) throw new Error('new wording was treated as a change to the labels');
  // A renamed value changes the labels: the page says what that costs before the save
  const value = page.locator('input[aria-label="Value"]').first();
  const name = await value.inputValue();
  await value.fill(`${name} content`);
  const warn = page.getByText(/This changes the label fields or values\. After you save, \d+ gold labels need a re-check/);
  await warn.waitFor({timeout: 5000});
  log('label change warning:', await warn.innerText());
  await shot(page, '6b-prompt-edit-label-change');
  await button(page, 'Discard').click();
  await page.getByText('Unsaved changes', {exact: true}).waitFor({state: 'detached'});

  // Eval dataset governance (spec 4.3, 4.4): the removed example is named next to the score; added
  // examples wait for gold labels without making scores stale; removals are listed and restorable.
  await page.goto(url('/prompt/'));
  await page.locator('nav.vlist').waitFor();
  await page.getByText(/1 gold-labeled example removed/).first().waitFor({timeout: 10000});
  await page.goto(url('/dataset/'));
  await page.getByRole('heading', {name: 'Removed (1)'}).waitFor({timeout: 10000});
  await page.getByRole('heading', {name: 'Label balance'}).waitFor();
  await shot(page, '2b-dataset-balance');
  await page.waitForFunction(() => +document.querySelector('[aria-label="Examples to add"]')?.value > 0, null, {timeout: 10000});
  await page.getByLabel('Examples to add').fill('5');
  await button(page, 'Add sampled').click();
  await page.getByRole('heading', {name: 'Examples'}).waitFor({timeout: 30000});
  await page.waitForFunction(() => /Waiting for gold labels\s*5(?!\d)/.test(document.querySelector('main .metrics')?.textContent ?? ''), null, {timeout: 30000});
  log('dataset after adding:', (await page.locator('main .metrics').innerText()).replace(/\s+/g, ' '));
  await page.goto(url('/prompt/'));
  await page.locator('nav.vlist').waitFor();
  await page.getByText(/5 new examples wait for gold labels/).first().waitFor({timeout: 10000});
  if (await page.getByText('Scores out of date', {exact: true}).count()) throw new Error('adding unlabeled examples made scores stale');
  await shot(page, '5i-pending');
  await page.goto(url('/dataset/'));
  await button(page, 'Remove unlabeled').click();
  const prune = page.getByRole('dialog');
  await prune.getByLabel('Unlabeled examples to keep').fill('0');
  await button(prune, 'Remove').click();
  await page.getByRole('heading', {name: 'Removed (6)'}).waitFor({timeout: 10000});
  await page.locator('tr', {hasText: 'Unlabeled extra'}).first().getByRole('button', {name: 'Restore'}).click();
  await page.getByRole('heading', {name: 'Removed (5)'}).waitFor({timeout: 10000});
  await shot(page, '2c-dataset-removed');
  log('dataset after pruning and one restore:', (await page.locator('main .metrics').innerText()).replace(/\s+/g, ' '));

  // Settings at the top opens Project Settings at any time
  await button(page, 'Settings').click();
  const again = page.getByRole('dialog');
  await again.getByText('Project Settings', {exact: true}).waitFor();
  if (!(await button(again, 'Save').count())) throw new Error('Project Settings has no Save');
  await button(again, 'Cancel').click();

  // An agent question: the evaluation agent reads the report with a tool
  await page.goto(url('/prompt/'));
  await ask(page, 'Is the score good enough to pass?');
  await page.locator('aside.chat').getByText('Scores helper joined to answer').waitFor({timeout: 20000});
  await page.locator('aside.chat').getByText(/macro-F1/i).last().waitFor({timeout: 20000});
  if (!(await page.locator('aside.chat .chat-who').innerText()).startsWith('Scores helper')) throw new Error('the helper that joined does not stay on the page');
  log('scores helper:', (await page.locator('aside.chat .msg-a').last().innerText()).replace(/\n/g, ' ').slice(0, 160));
  await shot(page, '7-ask-ai');

  // An agent start: runs at once, with no Approve card
  await ask(page, 'Please try the current prompt on model A.');
  const tried = await page
    .locator('aside.chat')
    .getByText(/I tried it on \d+ eval examples/)
    .last()
    .innerText({timeout: 30000})
    .catch(() => 'no result');
  if (await page.locator('aside.chat').getByRole('button', {name: 'Approve', exact: true}).count()) throw new Error('an agent start asked for approval');
  if (tried === 'no result') throw new Error(`the agent start gave no result: ${(await page.locator('aside.chat').innerText()).slice(-300)}`);
  // The staying helper passed it on, and the paid start left an action line.
  await page.locator('aside.chat .evt').getByText(/^Prompt helper tried the prompt on \d+ eval examples?/).waitFor({timeout: 5000});
  log('agent start:', tried.split('\n')[0], '|', (await page.locator('aside.chat .evt').allInnerTexts()).map(t => t.replace(/\n/g, ' ')).join(' / '));
  await shot(page, '7b-ask-ai-actions');

  const facts = await page.evaluate(() => {
    const docs = k => JSON.parse(localStorage.getItem('tsp-doc:' + k) || '[]').map(d => d.data);
    const project = docs('projects').find(p => p.name === 'Short-video tagging');
    const mine = k => docs(k).filter(d => d.projectId === project.id);
    const versions = mine('prompt_versions');
    const ids = JSON.parse(localStorage.getItem('tsp-doc:predictions') || '[]').map(d => d.data._appId);
    const audit = mine('audit_log').map(a => a.action);
    return {
      projects: docs('projects').length,
      kind: project.kind,
      settingsConfirmed: project.settingsConfirmed,
      approved: project.approvedNodes,
      versions: versions.length,
      structured: versions.every(v => v.structured && v.structured.fields.length === 3 && typeof v.template === 'string'),
      schemaVersions: [...new Set(versions.map(v => v.schemaVersion))],
      reports: mine('eval_reports').length,
      proposals: mine('agent_proposals').map(p => `${p.kind}:${p.state}`),
      duplicatePredictionIds: ids.length - new Set(ids).size,
      toolCalls: mine('audit_log').filter(a => a.action === 'agent.tool').map(a => a.data?.name),
      autoStarts: audit.filter(a => a === 'auto_start').length,
      actionLines: mine('chat_messages').filter(m => m.role === 'event' && m.event).length,
      leftovers: ['training_sets', 'setup'].filter(k => localStorage.getItem('tsp-doc:' + k)),
      removals: mine('dataset_removals').map(r => `${r.reason}${r.restoredAt ? ':restored' : ''}`),
      comments: mine('label_comments').length,
      holdoutLocked: !!project.holdoutLocked,
    };
  });
  log('project:', JSON.stringify(facts));
  // Telemetry: flush, then read what the stand-in sink kept (events in localStorage, metrics text)
  await page.evaluate(
    () =>
      new Promise(r => {
        document.dispatchEvent(new Event('visibilitychange'));
        setTimeout(r, 300);
      }),
  );
  const tel = await page.evaluate(() => {
    const ev = JSON.parse(localStorage.getItem('tsp-telemetry-events') || '[]');
    const names = {};
    for (const e of ev) names[e.event] = (names[e.event] || 0) + 1;
    const leaks = ev.filter(e => /Short-video tagging|Scratch project|Tag short videos|customer messages/.test(JSON.stringify(e))).length;
    const text = globalThis.__tspMetrics || '';
    const series = [...new Set(text.split('\n').filter(l => l && !l.startsWith('#')).map(l => l.split(/[{ ]/)[0].replace(/_(bucket|sum|count)$/, '')))];
    // Labels whose values come from the running apps: none should fall back to "other".
    const undeclared = [...new Set([...text.matchAll(/\b(endpoint|model|method|op|collection)="other"/g)].map(m => m[1]))];
    return {events: ev.length, names, leaks, undeclared, metricNames: series.length, sample: series.filter(s => /tsp_(llm_requests|labeling_examples|agent_turns|bff_calls|web_page_views|auto_starts)/.test(s))};
  });
  log('telemetry:', JSON.stringify(tel));
  log('console errors:', errors.length ? errors : 'none');
  await ctx.close();
  const need = ['project_deleted', 'settings_saved', 'full_prompt_opened', 'prompt_copied', 'prompt_proposal_shown', 'signature_changed', 'version_scored'];
  const missing = need.filter(n => !tel.names[n]);
  if (missing.length) log('missing events:', missing.join(', '));
  const ok =
    facts.projects === 1 &&
    facts.kind === 'prompt_tuning' &&
    facts.settingsConfirmed === true &&
    ['prompt_design', 'dataset', 'gold', 'prompt'].every(n => facts.approved.includes(n)) &&
    facts.versions >= 2 &&
    facts.structured &&
    facts.schemaVersions.length === 1 &&
    facts.reports > 0 &&
    facts.proposals.every(p => p.startsWith('prompt:') && !p.endsWith(':open')) &&
    facts.duplicatePredictionIds === 0 &&
    facts.autoStarts > 0 &&
    facts.actionLines > 0 &&
    facts.leftovers.length === 0 &&
    missing.length === 0 &&
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
