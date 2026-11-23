/**
 * End-to-end check of the static build on the stand-ins, on the 1.0.0 four-step flow: the Projects
 * list (create, and Delete with the exact-name confirmation), Prompt Design (an existing prompt
 * pasted into Ask AI is imported with its "Not carried over" list; a prompt drafted from a
 * description is approved as v1 with the page's Approve button, never in the chat), Dataset
 * (auto sampling, no split), Gold Labels (labeled on the page with the answers bundled with the
 * sample file), the Project Settings confirmation before the first paid run, then Prompt Tuning:
 * scoring, the fixed AI Suggestion cards, Mismatches, Improve with AI with word marks, Auto
 * Optimise until a version passes, Copy prompt and Finish; and the telemetry events and metrics.
 * 1.1.0: the Created by column, renaming in Project Settings, a problem report from Ask AI, and the
 * switch to Chinese (no catalog misses on the pages visited) and back.
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sprint-e2e-'));
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
    await p.locator('aside.chat, button.sp-ask').first().waitFor();
    if (!(await p.locator('aside.chat').count())) await button(p, 'Ask AI').click();
    // 2026-11-16: Enter adds a line and Shift+Enter sends; a Shift+Enter that ends an input
    // method's composition never sends.
    const before = await p.locator('aside.chat .msg-u').count();
    const box = p.locator('#chat-input');
    await box.fill(text);
    await box.press('Enter');
    await p.waitForTimeout(150);
    if (!(await box.inputValue()).endsWith('\n')) throw new Error('Enter did not add a line');
    if ((await p.locator('aside.chat .msg-u').count()) !== before) throw new Error('Enter sent the message');
    await box.dispatchEvent('compositionstart');
    await box.press('Shift+Enter');
    await box.dispatchEvent('compositionend');
    await box.evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', shiftKey: true, keyCode: 229, isComposing: true, bubbles: true})));
    await p.waitForTimeout(150);
    if ((await p.locator('aside.chat .msg-u').count()) !== before) throw new Error('Shift+Enter sent the message while composing');
    await box.fill(text);
    await box.press('Shift+Enter');
    await p.locator('aside.chat .msg-u').nth(before).waitFor({timeout: 5000});
  };

  // Projects: one light list; Delete asks for the exact project name
  // Home (#91): the user's tenant opens its projects.
  await page.goto(BASE + '/');
  await page.getByRole('heading', {name: 'Your tenants'}).waitFor();
  await shot(page, '0a-home');
  // #94: a tenant is made from Home (a blank name is refused in the field) and opens on its tenant
  // page; the tenant menu in the top bar switches back.
  await button(page, 'Create a tenant').click();
  await page.getByLabel('Tenant name').fill('   ');
  await button(page, 'Create').click();
  await page.getByText('Enter a name. Spaces alone are not a name.').first().waitFor();
  await page.getByLabel('Tenant name').fill('Search Ads');
  await button(page, 'Create').click();
  await page.waitForURL(/\/tenant\/\?t=tn_/);
  await page.getByRole('button', {name: 'Switch Search Ads'}).waitFor();
  await page.goto(BASE + '/');
  await page.getByRole('link', {name: 'Open Search Ads'}).waitFor();
  await page.getByRole('heading', {name: 'My team'}).click();
  await page.waitForURL(/\?t=default/);
  await page.getByRole('button', {name: 'Switch My team'}).click();
  await page.getByRole('menuitem', {name: 'Search Ads'}).waitFor();
  await page.keyboard.press('Escape');
  await page.goto(BASE + '/tenant/');
  await page.getByPlaceholder('Short-video tagging').fill('Scratch project');
  await button(page, 'Create project').click();
  await page.waitForURL(/prompt-design/);
  await page.goto(BASE + '/tenant/');
  await page.getByRole('link', {name: 'Scratch project'}).waitFor();
  if (await page.getByText('Current step', {exact: true}).count()) throw new Error('the Projects list still has a Current step column');
  // 1.1.0: the list says who created each project.
  const byCell = await page.locator('tr', {hasText: 'Scratch project'}).locator('td').nth(1).innerText();
  if (!(await page.getByRole('columnheader', {name: 'Created by'}).count()) || !byCell.trim()) throw new Error('the Projects list has no Created by column');
  await shot(page, '0b-projects-created-by');
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
  // Prompt Design (wireframes v346): a new project shows the empty prompt card and three starters in Ask AI; Save is off.
  await page.getByText('The prompt appears here', {exact: true}).waitFor({timeout: 10000});
  const saveBtn = page.locator('main').getByRole('button', {name: 'Save', exact: true});
  if ((await saveBtn.getAttribute('aria-disabled')) !== 'true') throw new Error('Save is on for an empty prompt');
  if ((await page.locator('aside.chat .chip').count()) !== 3) throw new Error('Ask AI does not offer the three starters');
  await shot(page, '1a-prompt-design-start');
  const url = p => `${BASE}${p}?p=${pid}`;
  const card = page.locator('main');
  const partEdit = async name => {
    await card.locator('h3', {hasText: name}).locator('xpath=ancestor::*[.//button][1]').getByRole('button', {name: 'Edit', exact: true}).click();
    const d = page.getByRole('dialog');
    await d.waitFor();
    return d;
  };
  const viewTab = name => card.getByRole('radio', {name, exact: true});
  const fullPrompt = async () => {
    await viewTab('Full prompt').click();
    // The code block's text, without its language label and the blank lines' zero-width spaces.
    const text = (await card.locator('pre').first().innerText()).replace(/\u200b/g, '').replace(/^xml\n/, '');
    await viewTab('Sections').click();
    return text;
  };

  // An existing prompt pasted into Ask AI is sorted into the parts, and what has no place is listed word for word (spec 3.2).
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
  if (!lostText.includes('my order is late') || !lostText.includes('Return JSON only.')) throw new Error(`the Not carried over list is wrong: ${lostText}`);
  await card.getByText('intent · Single selection', {exact: true}).waitFor();
  await card.getByText('AI draft · not saved', {exact: true}).waitFor();
  // The chat never shows an Approve card: the page's Save keeps the prompt.
  if (await page.locator('aside.chat').getByRole('button', {name: 'Approve', exact: true}).count()) throw new Error('the chat shows an Approve card');
  if (await page.locator('aside.chat .ctx').count()) throw new Error('the chat still shows the page tag');
  log('import:', (await page.locator('aside.chat .msg-a').last().innerText()).replace(/\n/g, ' ').slice(0, 200));
  await shot(page, '1-import-not-carried-over');
  await button(card, 'Discard').click();
  await lost.waitFor({state: 'detached', timeout: 10000});

  // The prompt for this project: drafted from a description, each part edited in its own dialog, saved as v1.
  await ask(page, 'Tag short videos by what the viewer gets from them: primary value, format and topics.');
  await card.getByText('primary_value · Single selection', {exact: true}).waitFor({timeout: 20000});
  // Output Labels: the label and single or multiple selection, then one card per value; add and remove work.
  let partDlg = await partEdit('Output Labels');
  const valueNames = () => partDlg.getByLabel('Value name', {exact: true}).evaluateAll(els => els.map(e => e.value));
  const names0 = await valueNames();
  if (names0.length !== 4) throw new Error(`the values are not one card each: ${names0.join(', ')}`);
  await button(partDlg, 'Add value').click();
  if ((await valueNames()).length !== 5) throw new Error('Add value did not add a card');
  await partDlg.getByRole('button', {name: 'Remove Value name', exact: true}).click();
  if ((await valueNames()).join() !== names0.join()) throw new Error('the values did not come back to the draft');
  // Resilience spec, 1: multiple selection asks how many, and a value can stand on its own (a catch-all such as None).
  await partDlg.getByRole('radio', {name: 'Multiple selection', exact: true}).click();
  await partDlg.getByLabel('At most', {exact: true}).waitFor({timeout: 5000});
  if ((await partDlg.getByRole('checkbox', {name: /Only on its own/}).count()) !== 4) throw new Error('multiple selection has no "Only on its own" per value');
  await partDlg.getByRole('checkbox', {name: /Only on its own/}).last().click();
  await shot(page, '1b2-multi-select');
  await button(partDlg, 'Save').click();
  await partDlg.waitFor({state: 'detached'});
  const multiText = await fullPrompt();
  if (!/<output_labels name="primary_value" selection="multi" min="1" max="3">/.test(multiText) || !multiText.includes('exclusive="true"')) throw new Error('the full prompt does not ask for a multi-select answer');
  partDlg = await partEdit('Output Labels');
  await partDlg.getByRole('radio', {name: 'Single selection', exact: true}).click();
  if (await partDlg.getByRole('checkbox', {name: /Only on its own/}).count()) throw new Error('single selection still shows "Only on its own"');
  await button(partDlg, 'Save').click();
  await partDlg.waitFor({state: 'detached'});
  // Input Features: the fixed catalogue as checkboxes, per example type.
  partDlg = await partEdit('Input Features');
  if ((await partDlg.getByRole('checkbox').count()) < 20) throw new Error('the features dialog does not list the catalogue');
  await shot(page, '1b3-features');
  await button(partDlg, 'Cancel').click();
  await shot(page, '1b-prompt-design-draft');
  const fullText = await fullPrompt();
  if (!fullText.includes('{{Description}}') || !fullText.includes('Return one JSON object only') || !fullText.includes('<output_labels name="primary_value" selection="single">')) throw new Error('the full prompt is not compiled from the parts');
  if (!/^<persona_and_task>[\s\S]*<\/persona_and_task>\n\n<input_features>[\s\S]*<output_labels [\s\S]*<output_format>[\s\S]*<\/output_format>$/.test(fullText.trim())) throw new Error('the full prompt is not in XML sections');
  await viewTab('Full prompt').click();
  await shot(page, '1c-full-prompt');
  await viewTab('Sections').click();
  await saveBtn.click();
  await card.getByText('Prompt v1', {exact: true}).waitFor({timeout: 10000});
  await card.getByText('Saved', {exact: true}).waitFor({timeout: 10000});
  // The helper says what comes next (spec 6.2)
  await page.locator('aside.chat').getByText(/v1 is saved\. Next, open Dataset in the step bar/).waitFor({timeout: 10000});
  await shot(page, '1d-prompt-saved');
  await page.goto(url('/dataset/'));
  log('prompt design done');

  // Dataset (#29, #100): examples come from the team's data sources through Append examples. The
  // built-in sample data is ticked with a count in the box; a count over what is left is refused.
  await page.waitForURL(/dataset/);
  await button(page, 'Append examples').click();
  const app = page.locator('dialog[open]');
  await app.getByRole('checkbox', {name: /Sample data/}).waitFor({timeout: 10000});
  if (!(await app.getByRole('checkbox', {name: /Sample data/}).isChecked())) throw new Error('the sample data is not ticked');
  // The box takes its number when it loses focus.
  const howMany = async (box, n) => (await box.fill(n), await box.press('Tab'));
  await howMany(app.getByLabel('Examples to add', {exact: true}), '999999');
  await app.getByText(/^Only [\d,]+ are left in the ticked data sources\.$/).first().waitFor();
  if (!(await app.getByRole('button', {name: /^Append/}).isDisabled())) throw new Error('Append is on for more items than are left');
  await howMany(app.getByLabel('Examples to add', {exact: true}), String(N));
  await shot(page, '2a-dataset-pick');
  await button(app, `Append ${N}`).click();
  await app.waitFor({state: 'detached', timeout: 10000});
  const next = button(page, 'Next: Gold Labels');
  await next.waitFor({timeout: 60000});
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent === 'Next: Gold Labels' && !b.disabled), null, {timeout: 10000});
  await page.getByRole('radio', {name: `All ${N}`}).waitFor({timeout: 10000});
  if (await page.getByText('Split', {exact: true}).count()) throw new Error('the Dataset page still has a split');
  log('dataset:', (await page.locator('main [role=radiogroup]').first().innerText()).replace(/\s+/g, ' '));
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
      await page.getByRole('group', {name: 'primary_value'}).getByRole('button', {name: answer, exact: true}).click();
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
  // Upload labels (#31): rows are matched to the dataset; an unknown item is skipped, a value
  // outside the label is refused by row, and the same label again saves nothing.
  const labelsFile = (name, text) => page.locator('input[aria-label="Upload labels"]').setInputFiles({name, mimeType: 'text/csv', buffer: Buffer.from(text)});
  const firstAnswer = LABELS.get(firstId);
  await labelsFile('labels.csv', `item_id,answer\nnot_in_this_dataset,${firstAnswer}\n${firstId},Not a value\n`);
  await page.getByText(/1 item is not in the dataset and was skipped/).waitFor({timeout: 10000});
  await page.getByText(new RegExp(`Row 3 \\(item ${firstId}\\) was refused`)).waitFor({timeout: 5000});
  await shot(page, '3d-gold-upload-refused');
  await labelsFile('labels.csv', `item_id,answer\n${firstId},${firstAnswer}\n`);
  await page.getByText(/Saved 0 labels\. 1 row already had this label\./).waitFor({timeout: 10000});
  await shot(page, '3e-gold-upload-saved');
  await button(page, 'Dismiss').click();
  if (await page.getByText(/already had this label/).count()) throw new Error('Dismiss left the upload result');
  if ((await page.locator('.media small').innerText()).trim() !== firstId) throw new Error('uploading labels moved to another example');
  // Remove example: out of scope; it leaves the eval set and shows under Removed on Dataset.
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
  // 2026-11-16 refinements, 3: no intro line, no model description, no native select; Default/Custom sits by the Evaluation heading.
  if (await set.getByText(/Check these once before the first scoring run/).count()) throw new Error('Project Settings still has its intro line');
  if (await set.locator('select').count()) throw new Error('Project Settings still uses a native select');
  if (!(await set.locator('.set-sec-h').filter({hasText: 'Evaluation'}).getByRole('group', {name: 'Pass rule'}).count())) throw new Error('the Default/Custom switch is not beside the Evaluation heading');
  if ((await set.locator('section.set-sec').count()) !== 3) throw new Error('Project Settings does not have three sections');
  // 2026-11-16: the checks show their names only, with no line between them.
  if (await set.locator('.set-checks .set-sub').count()) throw new Error('a check still has an explanation line');
  if ((await set.locator('.set-checks .tbl td').first().evaluate(el => getComputedStyle(el).borderBottomWidth)) !== '0px') throw new Error('the checks still have lines between them');
  if (await set.locator('.hov').count()) throw new Error('Project Settings still uses hover text');
  await shot(page, '3b-project-settings');
  const passRule = set.getByRole('group', {name: 'Pass rule'});
  await passRule.getByRole('button', {name: 'Custom', exact: true}).click();
  if (await f1.isDisabled()) throw new Error('Custom does not unlock the thresholds');
  await shot(page, '3c-project-settings-custom');
  // The model list is the site's own: it opens under the button, the arrows move, Escape closes it and not the dialog.
  await set.locator('.select-btn').click();
  const listbox = page.getByRole('listbox');
  await listbox.waitFor({timeout: 5000});
  if (!(await listbox.getByRole('option').count())) throw new Error('the model list has no options');
  await shot(page, '3d-model-list');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  await listbox.waitFor({state: 'detached', timeout: 5000});
  if (!(await set.isVisible())) throw new Error('Escape in the model list closed Project Settings');
  await passRule.getByRole('button', {name: 'Default', exact: true}).click();
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
    // 2026-11-16: the version card scores the label (Macro-F1) and lists every value.
    const head = await page.locator('main .tbl thead').first().innerText();
    if (!/Value[\s\S]*F1[\s\S]*Precision[\s\S]*Recall[\s\S]*Examples/.test(head)) throw new Error(`the version card is not per value: ${head}`);
    if (await page.getByText('Lowest field macro-F1').count()) throw new Error('the version card still says lowest field');
    // R4-6: the version card says what the score rests on.
    log('left out:', await page.getByText(/^Scored on \d+ of \d+ examples/).first().innerText());
    await shot(page, '4b-disagree');
    await button(page, 'Review labels').click();
    await page.waitForURL(/gold/);
    const tab = page.getByRole('tab', {name: /^Mismatches/});
    await tab.waitFor();
    const before = +((await tab.innerText()).match(/(\d+)\s*$/) || [0, 0])[1];
    const cmp = page.locator('.select-sm .select-btn');
    await cmp.waitFor();
    if (await page.locator('select').count()) throw new Error('Gold Labels still uses a native select');
    log('mismatches:', before, '· compare with', await cmp.innerText());
    await cmp.click();
    await page.locator('.select-pop [role=option]').first().waitFor();
    await shot(page, '4c-compare-with');
    await page.keyboard.press('Escape');
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
      const model = page.locator('section.card', {hasText: 'Model answer'});
      if (await model.locator('.code').count()) throw new Error('the Model answer card still names a field');
      // An invalid model answer has no value to take: move on to one that has.
      for (let k = 0; k < 10 && !(await model.locator('.ch').count()); k++) {
        await page.getByRole('button', {name: 'Next', exact: true}).click();
        await page.waitForTimeout(400);
      }
      const pick = (await model.locator('.ch').first().innerText()).trim();
      await page.locator('section.card', {hasText: 'Your answer'}).getByRole('group', {name: 'primary_value'}).getByRole('button', {name: pick, exact: true}).click();
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
      // Resilience spec, 7: the advice stays, and its actions ask to rebuild first.
      const act = (await button(page, 'Improve with AI').count()) ? 'Improve with AI' : (await button(page, 'Auto Optimise').count()) ? 'Auto Optimise' : null;
      if (act) {
        await button(page, act).first().click();
        const dlg = page.getByRole('dialog');
        await dlg.getByText('Rebuild scores first?', {exact: true}).waitFor({timeout: 5000});
        await shot(page, '4f-rebuild-first');
        await button(dlg, 'Rebuild scores').click();
        await dlg.waitFor({state: 'detached', timeout: 10000});
      } else {
        log('no advice action while scores were out of date');
        await button(page, 'Rebuild scores').click();
      }
      await page.getByText('Scores out of date', {exact: true}).first().waitFor({state: 'detached', timeout: 10000});
      if (!(await button(page, 'Rebuild scores').isDisabled())) throw new Error('Rebuild scores is on with scores up to date');
      log('scores rebuilt by hand', act ? `(asked from ${act})` : '');
    }
  }

  // Improve with AI puts the Prompt helper's draft in the editor, saved as v1.1. It is offered
  // below the bar and on a passing version too, so the check runs it whether or not v1 passed.
  for (let i = 0; i < 30 && !(await button(page, 'Improve with AI').count()); i++) await page.waitForTimeout(1000);
  if (await button(page, 'Improve with AI').count()) {
    // Discard first (#39, T8): the draft closes as discarded and does not come back on reload.
    await button(page, 'Improve with AI').first().click();
    await page.waitForURL(/prompt-design\/?\?.*v=/);
    await page.getByText('AI draft · not saved', {exact: true}).waitFor({timeout: 20000});
    await button(page.locator('main'), 'Discard').click();
    await page.getByText('AI draft · not saved', {exact: true}).waitFor({state: 'detached'});
    await page.waitForTimeout(500);
    await page.reload();
    await page.locator('main h3', {hasText: 'Persona & Task'}).waitFor();
    await page.waitForTimeout(1500);
    if (await page.getByText('AI draft · not saved', {exact: true}).count()) throw new Error('a discarded draft came back on reload');
    log('improve with AI: discarded draft stays discarded');
    await page.goto(url('/prompt/'));
    for (let i = 0; i < 30 && !(await button(page, 'Improve with AI').count()); i++) await page.waitForTimeout(1000);
    await button(page, 'Improve with AI').first().click();
    await page.waitForURL(/prompt-design\/?\?.*v=/);
    await page.getByText('AI draft · not saved', {exact: true}).waitFor({timeout: 20000});
    // The helper's draft opens on its marks against the saved version, each change with its reason.
    await page.locator('main .sp-pd-ins').first().waitFor({timeout: 10000});
    log('improve with AI:', await page.locator('main .sp-pd-ins').count(), 'changes marked');
    const why = page.locator('main .sp-pd-ins.why').first();
    if (!(await why.count())) throw new Error('the helper draft has no change with a reason');
    log('change reason:', await why.getAttribute('title'));
    await shot(page, '5a-improve-draft');
    await saveBtn.click();
    // Saving over a version that is still labeling asks first; wording changes clear no gold labels.
    const stop = page.getByRole('dialog').getByRole('button', {name: 'Stop and save', exact: true});
    await page.waitForTimeout(400);
    if (await stop.count()) await stop.click();
    if (await page.getByRole('dialog').getByText(/gold labels?\?$/).count()) throw new Error('Improve with AI changed the label fields');
    await page.getByText('AI draft · not saved', {exact: true}).waitFor({state: 'detached', timeout: 10000});
    await page.goto(url('/prompt/'));
  }

  // Auto Optimise until a version passes: the card then says to use it as the final prompt (T6)
  let optimised = false;
  let starts = 0;
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
      if (++starts > 8) throw new Error(`no version passed after 8 Optimiser runs: ${text.replace(/\n/g, ' | ')}`);
      log('auto optimise started:', text.replace(/\n/g, ' | ').slice(0, 200));
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

  // A version opens on Prompt Design: each part edited in its dialog, word marks against the saved text.
  await page.locator('main').getByRole('link', {name: 'Edit prompt', exact: true}).click();
  await page.waitForURL(/prompt-design\/?\?.*v=/);
  await page.locator('main h3', {hasText: 'Persona & Task'}).waitFor();
  await shot(page, '6-prompt-edit');
  // Your own edits: new wording is marked, and it clears no gold labels.
  let edit = await partEdit('Output Labels');
  const def = edit.getByLabel(/^Definition of /).first();
  await def.fill(`${await def.inputValue()}, such as jokes`);
  await button(edit, 'Save').click();
  await page.getByText('Edited · not saved', {exact: true}).waitFor();
  await viewTab('Changes').click();
  await page.locator('main .sp-pd-ins', {hasText: 'jokes'}).waitFor({timeout: 5000});
  await viewTab('Sections').click();
  // A renamed value changes the labels: Save says how many gold labels it clears before anything is saved.
  edit = await partEdit('Output Labels');
  const value = edit.getByLabel('Value name', {exact: true}).first();
  await value.fill(`${await value.inputValue()} content`);
  await button(edit, 'Save').click();
  await saveBtn.click();
  await page.waitForTimeout(400);
  const stopFirst = page.getByRole('dialog').getByRole('button', {name: 'Stop and save', exact: true});
  if (await stopFirst.count()) throw new Error('a finished version asks to stop its run');
  const clear = page.getByRole('dialog');
  const clearTitle = clear.getByText(/^Clear [\d,]+ gold labels?\?$/);
  await clearTitle.waitFor({timeout: 5000});
  log('label change confirm:', await clearTitle.innerText());
  await shot(page, '6b-prompt-edit-label-change');
  await button(clear, 'Keep editing').click();
  await button(page.locator('main'), 'Discard').click();
  await page.getByText('Edited · not saved', {exact: true}).waitFor({state: 'detached'});

  // Eval dataset governance (spec 4.3, 4.4): the removed example is named next to the score; added
  // examples wait for gold labels without making scores stale; removals are listed and restorable.
  await page.goto(url('/prompt/'));
  await page.locator('nav.vlist').waitFor();
  await page.getByText(/1 gold-labeled example removed/).first().waitFor({timeout: 10000});
  await page.goto(url('/dataset/'));
  const tab = name => page.getByRole('radio', {name});
  await tab(`Removed 1`).waitFor({timeout: 10000});
  await page.getByRole('heading', {name: 'Label Distribution'}).waitFor();
  await page.getByText(new RegExp(`Model \\(v\\d+(\\.\\d+)?, best\\)`)).waitFor({timeout: 10000});
  await shot(page, '2b-dataset-balance');
  // Append examples (#29): more from a data source; they wait for gold labels.
  await button(page, 'Append examples').click();
  await howMany(page.locator('dialog[open]').getByLabel('Examples to add', {exact: true}), '5');
  await button(page.locator('dialog[open]'), 'Append 5').click();
  await tab('No label 5').waitFor({timeout: 30000});
  await tab(`All ${N + 5 - 1}`).waitFor({timeout: 10000});
  await shot(page, '2d-dataset-add-examples');
  await page.goto(url('/prompt/'));
  await page.locator('nav.vlist').waitFor();
  await page.getByText(/5 new examples wait for gold labels/).first().waitFor({timeout: 10000});
  if (await page.getByText('Scores out of date', {exact: true}).count()) throw new Error('adding unlabeled examples made scores stale');
  await shot(page, '5i-pending');
  // Remove (W-EvalDataset-Remove): one unlabeled sample, for another reason with a note; it keeps
  // its number under Removed and comes back with Restore.
  await page.goto(url('/dataset/'));
  await tab('No label 5').click();
  const firstNew = page.locator('main tbody tr').first();
  const removedNumber = (await firstNew.locator('td').first().innerText()).trim();
  await firstNew.hover();
  await firstNew.getByRole('button', {name: 'Remove', exact: true}).click();
  const rmd = page.locator('dialog[open]');
  await rmd.getByRole('radio', {name: /Other/}).click();
  await rmd.getByRole('textbox', {name: /Note/}).fill('A duplicate upload');
  await shot(page, '2e-dataset-remove');
  await button(rmd, 'Remove').click();
  await tab('Removed 2').waitFor({timeout: 10000});
  await tab('Removed 2').click();
  const back = page.locator('main tbody tr', {hasText: 'Other'});
  if ((await back.locator('td').first().innerText()).trim() !== removedNumber) throw new Error('the removed sample lost its number');
  await shot(page, '2c-dataset-removed');
  await back.hover();
  await back.getByRole('button', {name: 'Restore'}).click();
  await tab('Removed 1').waitFor({timeout: 10000});
  log('dataset after one removal and its restore:', await page.locator('main [role=radiogroup]').first().innerText().then(x => x.replace(/\s+/g, ' ')));

  // #91: Project settings opens from the project overview, and the project name in the top bar follows a rename.
  await page.goto(url('/overview/'));
  await button(page, 'Project settings').click();
  const again = page.getByRole('dialog');
  await again.getByText('Project Settings', {exact: true}).waitFor();
  if (!(await button(again, 'Save').count())) throw new Error('Project Settings has no Save');
  const nameBox = again.getByLabel('Name', {exact: true});
  if ((await nameBox.inputValue()) !== 'Short-video tagging') throw new Error('the Name field is not prefilled with the project name');
  await nameBox.fill('  Short-video tags  ');
  await shot(page, '2d-settings-name');
  await button(again, 'Save').click();
  await again.waitFor({state: 'detached', timeout: 10000});
  const crumb = page.locator('.sp-crumb-project .sp-crumb-name');
  await crumb.filter({hasText: /^Short-video tags$/}).waitFor({timeout: 10000});
  await shot(page, '2e-overview');
  await button(page, 'Project settings').click();
  await page.getByRole('dialog').getByLabel('Name', {exact: true}).fill('Short-video tagging');
  await button(page.getByRole('dialog'), 'Save').click();
  await crumb.filter({hasText: /^Short-video tagging$/}).waitFor({timeout: 10000});
  // The project name opens the switch menu: recent projects and All projects.
  await page.locator('.sp-crumb-project').click();
  await page.getByRole('menu').getByText('All projects', {exact: true}).waitFor();
  await shot(page, '2f-project-switch');
  await page.keyboard.press('Escape');
  log('renamed from Project settings and back; the top bar follows');

  // An agent question: the evaluation agent reads the report with a tool
  await page.goto(url('/prompt/'));
  await ask(page, 'Is the score good enough to pass?');
  await page.locator('aside.chat').getByText('Scores helper joined to answer').waitFor({timeout: 20000});
  await page.locator('aside.chat').getByText(/macro-F1/i).last().waitFor({timeout: 20000});
  if ((await page.locator('aside.chat .msg-a .agent-k b').last().innerText()) !== 'Scores helper') throw new Error('the helper that joined does not answer');
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

  // 1.1.0: a problem told to Ask AI becomes a draft; only the user's yes sends it, and the reply
  // gives the ticket id. The stored ticket holds the page and the browser's record, and no prompt.
  await ask(page, 'The Save button does nothing');
  await page.locator('aside.chat .msg-a', {hasText: 'Shall I send it?'}).last().waitFor({timeout: 20000});
  const sentBefore = await page.evaluate(() => JSON.parse(localStorage.getItem('sprint-tickets') || '[]').length);
  if (sentBefore) throw new Error('a report was sent before the user said yes');
  await shot(page, '8-report-draft');
  await ask(page, 'yes');
  const sentLine = await page.locator('aside.chat .msg-a', {hasText: /T-[A-Z0-9]{6}/}).last().innerText({timeout: 20000});
  await page.locator('aside.chat .evt', {hasText: /You sent a problem report T-/}).waitFor({timeout: 5000});
  const ticket = await page.evaluate(() => JSON.parse(localStorage.getItem('sprint-tickets') || '[]').at(-1));
  if (!ticket || ticket.where?.page !== 'prompt' || !ticket.diagnostics?.pages?.length || ticket.content !== null || !ticket.actions?.length) throw new Error(`the stored ticket is not complete: ${JSON.stringify(ticket).slice(0, 400)}`);
  await shot(page, '8b-report-sent');
  log('problem report:', sentLine.replace(/\n/g, ' ').slice(0, 120), '| ticket keeps', Object.keys(ticket).join(','));

  // 1.1.0: the avatar menu switches the site to Chinese; every page visited has all its texts in
  // the catalog, then the switch goes back to English. A second tab, so this page keeps its metrics.
  const zp = await ctx.newPage();
  watch(zp);
  await zp.goto(url('/prompt/'));
  await zp.locator('.sp-steps').waitFor();
  const avatar = zp.locator('button.sp-avatar');
  await avatar.click();
  await zp.getByRole('menu').waitFor();
  // The avatar names the user at once (the identity is read once and kept).
  const who = (await avatar.getAttribute('aria-label')) || '';
  if (!/\S: account$/.test(who)) throw new Error(`the avatar is labeled "${who}"`);
  // The stand-in identity cannot end a session, so there is no Sign out.
  if (await zp.getByRole('menuitem', {name: 'Sign out'}).count()) throw new Error('Sign out shows although the platform cannot sign out');
  await shot(zp, '9-avatar-menu');
  await zp.keyboard.press('Escape');
  // The language button switches the site to Chinese.
  const language = async name => {
    await zp.locator('button.sp-lang').click();
    await zp.getByRole('menuitem', {name}).click();
  };
  await language('中文');
  await zp.waitForFunction(() => document.documentElement.lang === 'zh-CN');
  const english = [];
  const visit = async (path, name) => {
    await zp.goto(url(path));
    await zp.locator('.sp-steps').waitFor();
    await zp.waitForTimeout(600);
    await shot(zp, name);
    // Text still in English (data such as field names and versions aside), for the log.
    english.push(...(await zp.evaluate(() => [...document.querySelectorAll('main *')].filter(el => el.children.length === 0 && /[A-Za-z]{3,} [A-Za-z]{3,} [A-Za-z]{3,}/.test(el.textContent || '')).map(el => el.textContent.trim().slice(0, 60)))));
  };
  await visit('/prompt/', '9b-zh-prompt-tuning');
  if (await zp.locator('.sp-steps').getByText('Prompt Design', {exact: true}).count()) throw new Error('the step names are still in English after switching to Chinese');
  await visit('/gold/', '9c-zh-gold');
  await visit('/dataset/', '9d-zh-dataset');
  await visit('/prompt-design/', '9e-zh-prompt-design');
  await visit('/overview/', '9g-zh-overview');
  await button(zp, '项目设置').click();
  await zp.getByRole('dialog').waitFor();
  await shot(zp, '9f-zh-settings');
  await zp.keyboard.press('Escape');
  const missed = await zp.evaluate(() => globalThis.__sprintI18nMissing || []);
  if (missed.length) throw new Error(`texts missing from the Chinese catalog: ${missed.join(' | ')}`);
  log('Chinese: no catalog misses; English left on the pages:', [...new Set(english)].slice(0, 12).join(' | ') || 'none');
  await language('English');
  await zp.waitForFunction(() => document.documentElement.lang === 'en');
  await zp.locator('.sp-steps').getByText('Prompt Design', {exact: true}).waitFor();
  log('switched back to English');
  await zp.close();

  // #91: a refused change opens the "insufficient access" dialog, and Request access sends the
  // request on. The stand-in permission check refuses every change while this browser is a viewer.
  const vp = await ctx.newPage();
  watch(vp);
  await vp.goto(url('/overview/'));
  await vp.evaluate(() => localStorage.setItem('sprint-standin-access', 'viewer'));
  await vp.reload();
  await button(vp, 'Project settings').click();
  const vs = vp.getByRole('dialog');
  await vs.getByLabel('Name', {exact: true}).fill('Viewer rename');
  await button(vs, 'Save').click();
  const denied = vp.getByRole('dialog', {name: /You can't edit this project/});
  await denied.waitFor({timeout: 10000});
  await denied.getByLabel(/Why you need it/).fill('I label the Food examples this week');
  await shot(vp, '9h-no-access');
  await button(denied, 'Request access').click();
  await vp.getByRole('dialog', {name: /Request sent/}).waitFor({timeout: 10000});
  await shot(vp, '9i-no-access-sent');
  await button(vp.getByRole('dialog', {name: /Request sent/}), 'Done').click();
  await vp.evaluate(() => localStorage.removeItem('sprint-standin-access'));
  await vp.close();
  log('a refused change opened the access dialog; the request was sent');

  const facts = await page.evaluate(() => {
    const docs = k => JSON.parse(localStorage.getItem('sprint-doc:' + k) || '[]').map(d => d.data);
    const project = docs('projects').find(p => p.name === 'Short-video tagging');
    const mine = k => docs(k).filter(d => d.projectId === project.id);
    const versions = mine('prompt_versions');
    const ids = JSON.parse(localStorage.getItem('sprint-doc:predictions') || '[]').map(d => d.data._appId);
    const audit = mine('audit_log').map(a => a.action);
    return {
      projects: docs('projects').length,
      kind: project.kind,
      settingsConfirmed: project.settingsConfirmed,
      approved: project.approvedNodes,
      versions: versions.length,
      structured: versions.every(v => v.structured && v.structured.label?.values.length === 4 && typeof v.template === 'string'),
      schemaVersions: [...new Set(versions.map(v => v.schemaVersion))],
      reports: mine('eval_reports').length,
      proposals: mine('agent_proposals').map(p => `${p.kind}:${p.state}`),
      duplicatePredictionIds: ids.length - new Set(ids).size,
      toolCalls: mine('audit_log').filter(a => a.action === 'agent.tool').map(a => a.data?.name),
      autoStarts: audit.filter(a => a === 'auto_start').length,
      actionLines: mine('chat_messages').filter(m => m.role === 'event' && m.event).length,
      leftovers: ['training_sets', 'setup'].filter(k => localStorage.getItem('sprint-doc:' + k)),
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
  // The sink is written every 10 seconds: wait for the last events of this run to land.
  await page.bringToFront();
  await page.waitForFunction(() => (localStorage.getItem('sprint-telemetry-events') || '').includes('problem_reported'), null, {timeout: 15000}).catch(() => undefined);
  const tel = await page.evaluate(() => {
    const ev = JSON.parse(localStorage.getItem('sprint-telemetry-events') || '[]');
    const names = {};
    for (const e of ev) names[e.event] = (names[e.event] || 0) + 1;
    const leaks = ev.filter(e => /Short-video tagging|Scratch project|Tag short videos|customer messages/.test(JSON.stringify(e))).length;
    const text = globalThis.__sprintMetrics || '';
    const series = [...new Set(text.split('\n').filter(l => l && !l.startsWith('#')).map(l => l.split(/[{ ]/)[0].replace(/_(bucket|sum|count)$/, '')))];
    // Labels whose values come from the running apps: none should fall back to "other".
    const undeclared = [...new Set([...text.matchAll(/\b(endpoint|model|method|op|collection)="other"/g)].map(m => m[1]))];
    return {events: ev.length, names, leaks, undeclared, metricNames: series.length, sample: series.filter(s => /sprint_(llm_requests|labeling_examples|agent_turns|bff_calls|web_page_views|auto_starts)/.test(s))};
  });
  log('telemetry:', JSON.stringify(tel));
  // Data sources (#29, #95), after the telemetry read (a page load clears the in-memory metrics): one
  // uploaded file is one data source. Upload goes through a dialog (name from the file name); the
  // source page counts sample IDs, repeats kept once and rows without an ID. #91: the tenant page links here.
  await page.goto(BASE + '/tenant/');
  await page.locator('main').getByRole('link', {name: 'Data sources'}).click();
  await page.waitForURL(/\/sources\//, {timeout: 10000});
  await page.getByRole('heading', {name: 'Data sources', level: 1}).waitFor({timeout: 10000});
  await page.locator('tr', {hasText: 'Sample data'}).waitFor({timeout: 10000});
  const cells = async name => (await page.locator('tr', {hasText: name}).locator('td').allInnerTexts()).map(x => x.trim());
  await page.getByRole('button', {name: 'Upload file'}).click();
  const dlg = page.locator('dialog[open]');
  await dlg.locator('input[type=file]').setInputFiles({name: 'safety.csv', mimeType: 'text/csv', buffer: Buffer.from('id,creator\nc1,a\nc2,b\nc1,c\nbad id,d\nc3,e\n')});
  if ((await dlg.getByRole('textbox', {name: 'Name'}).inputValue()) !== 'safety') throw new Error('the name does not come from the file name');
  await dlg.getByRole('textbox', {name: 'Name'}).fill('Creator safety review');
  await shot(page, '6a-data-source-upload');
  await dlg.getByRole('button', {name: 'Upload', exact: true}).click();
  await dlg.waitFor({state: 'detached', timeout: 10000});
  await page
    .waitForFunction(() => [...document.querySelectorAll('main tr')].some(r => r.textContent.includes('Creator safety review') && [...r.querySelectorAll('td')].some(c => c.textContent.trim() === '3')), null, {timeout: 20000})
    .catch(async e => {
      throw new Error(`the new source was not read: ${(await page.locator('main').innerText()).replace(/\s+/g, ' ')} (${e.message})`);
    });
  if ((await cells('Sample data'))[2] !== '1 project') throw new Error(`the sample data says it is used by ${(await cells('Sample data'))[2]}`);
  await shot(page, '6c-data-sources');
  await page.getByRole('link', {name: 'Creator safety review'}).click();
  await page.waitForURL(/\/source\//, {timeout: 10000});
  await page.getByText('Rows without an ID').waitFor({timeout: 10000});
  const counts = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
  if (!/Sample IDs 3 Repeated, kept once 1 Rows without an ID 1/.test(counts)) throw new Error(`the source page says ${counts}`);
  await page.getByRole('button', {name: 'Rename'}).click();
  await page.locator('dialog[open]').getByRole('textbox', {name: 'Name'}).fill('Creator safety');
  await page.locator('dialog[open]').getByRole('button', {name: 'Save'}).click();
  await page.getByRole('heading', {name: 'Creator safety', level: 1}).waitFor({timeout: 10000});
  await shot(page, '6b-data-source');
  await page.goto(BASE + '/sources/');
  await page.locator('tr', {hasText: 'Creator safety'}).waitFor({timeout: 10000});
  log('data sources:', (await page.locator('main tbody').innerText()).replace(/\s+/g, ' '));

  log('console errors:', errors.length ? errors : 'none');
  await ctx.close();
  const need = ['project_deleted', 'settings_saved', 'full_prompt_opened', 'prompt_copied', 'prompt_proposal_shown', 'signature_changed', 'version_scored', 'project_renamed', 'locale_changed', 'problem_report_drafted', 'problem_reported'];
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
