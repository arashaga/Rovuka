// Native memory regressions. Called by test-agent.cjs with its disposable browser and mock provider.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(probe, label, timeout = 20000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const result = await probe();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}
async function exists(file) {
  try { await fs.stat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

module.exports = async function memoryChecks(test) {
  const { rpc, navigate, start, approve, terminal, pending, tabSnapshot, trustedClick, fixtureBase, send } = test;
  let assistant;
  const evaluate = async (connection, expression) => {
    const result = await connection.command('Runtime.evaluate', { expression, returnByValue: true });
    assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  };
  const ui = expression => evaluate(assistant, expression);
  const chrome = expression => evaluate(test.chrome(), expression);
  const put = (route, body, expected = 200) => rpc(route, body, expected, {}, 'PUT');
  const search = (q = '', kind = 'all', after = '') => rpc(`/api/memory/search?${new URLSearchParams({ q, kind, after })}`);
  const config = (captureEnabled, excludedSites = [], retentionDays = 30) =>
    put('/api/memory/config', { captureEnabled, excludedSites, retentionDays });
  const ready = route => waitFor(async () => {
    const state = await tabSnapshot();
    return state?.tabs.find(tab => tab.id === state.active && !tab.loading && tab.url === `${fixtureBase}${route}`);
  }, `settled memory page: ${route}`);
  const openMemory = async () => {
    await send({ type: 'openAssistant', panel: 'memory' });
    assistant ||= await waitFor(() => test.connect('assistant'), 'memory assistant connection');
    await waitFor(() => ui('!!document.querySelector(".memory-panel") && !!document.querySelector(".memory-search button:not(:disabled)")'), 'local memory UI ready');
  };
  const clickText = async text => {
    const selector = await ui(`(() => {
      const buttons=Array.from(document.querySelectorAll("button"));
      const button=buttons.find(button=>button.textContent===${JSON.stringify(text)});
      if(!button) return null;
      button.dataset.memoryTestClick="target";
      return '[data-memory-test-click="target"]';
    })()`);
    assert(selector, `Missing control: ${text}`);
    try { await trustedClick(assistant, selector); }
    finally { await ui('document.querySelector("[data-memory-test-click]")?.removeAttribute("data-memory-test-click")'); }
  };
  const setField = (id, value) => ui(`(() => {
    const field=document.getElementById(${JSON.stringify(id)});
    const prototype=field instanceof HTMLSelectElement?HTMLSelectElement.prototype:
      field instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype,"value").set.call(field,${JSON.stringify(value)});
    field.dispatchEvent(new Event(field instanceof HTMLSelectElement?"change":"input",{bubbles:true}));
  })()`);
  const selection = async ids => (await rpc('/api/agent/tabs')).filter(tab => ids.includes(tab.target.id)).map(tab => tab.target);
  const noPrivate = value => {
    const text = JSON.stringify(value);
    for (const sentinel of test.privateValues) assert(!text.includes(sentinel), `Private fixture value was stored/shared: ${sentinel}`);
  };
  const tabChecks = async () => {
    for (let n = 0; n < 9; n++) {
      await send({ type: 'newTab', url: `${fixtureBase}/memory/tabs-${n}` });
      await ready(`/memory/tabs-${n}`);
    }
    for (const theme of ['light', 'dark']) {
      for (const width of [1008, 320]) {
        await test.chrome().command('Emulation.setDeviceMetricsOverride', { width, height: 84, deviceScaleFactor: 1, mobile: false });
        await chrome(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
        try {
          await waitFor(() => chrome(`(() => {
            const list=document.querySelector(".browser-tabs"),active=document.querySelector(".tab.active");
            if(!list || !active) return false;
            const box=active.getBoundingClientRect(),edge=list.getBoundingClientRect();
            return document.querySelectorAll(".tab-scroll").length===2 && box.left>=edge.left-1 && box.right<=edge.right+1;
          })()`), `active tab stays visible after ${width}px resize`);
        } catch (error) {
          console.error('Tab visibility failure:', await chrome(`(() => {
            const list=document.querySelector(".browser-tabs"),active=document.querySelector(".tab.active");
            return {width:innerWidth,theme:document.documentElement.dataset.theme,arrows:document.querySelectorAll(".tab-scroll").length,
              list:list?.getBoundingClientRect().toJSON(),active:active?.getBoundingClientRect().toJSON(),
              scrollLeft:list?.scrollLeft,scrollWidth:list?.scrollWidth,clientWidth:list?.clientWidth,
              rootScroll:document.documentElement.scrollLeft,activeId:active?.querySelector("[data-tab-id]")?.dataset.tabId};
          })()`));
          throw error;
        }
        const layout = await chrome(`(() => {
          const active=document.querySelector(".tab.active"),inactive=document.querySelector(".tab:not(.active)");
          return {bordered:Array.from(document.querySelectorAll(".tab")).every(tab=>parseFloat(getComputedStyle(tab).borderTopWidth)>=1),
            distinct:getComputedStyle(active).borderTopColor!==getComputedStyle(inactive).borderTopColor,
            aria:document.querySelectorAll('[role="tab"][aria-selected="true"]').length===1,
            toolbarTop:document.querySelector(".toolbar").getBoundingClientRect().top,
            toolbarBottom:document.querySelector(".toolbar").getBoundingClientRect().bottom,
            fits:document.documentElement.scrollWidth<=innerWidth,
            newTabVisible:document.querySelector(".new-tab").getBoundingClientRect().right<=innerWidth};
        })()`);
        assert.deepEqual(layout, { bordered: true, distinct: true, aria: true, toolbarTop: 38, toolbarBottom: 84, fits: true, newTabVisible: true });
        if (process.env.AIB_TEST_TABS_SCREENSHOT) {
          const file = process.env.AIB_TEST_TABS_SCREENSHOT;
          assert(path.isAbsolute(file));
          const parsed = path.parse(file);
          const image = await test.chrome().command('Page.captureScreenshot', { format: 'png' });
          await fs.writeFile(path.join(parsed.dir, `${parsed.name}-${theme}-${width}${parsed.ext}`), Buffer.from(image.data, 'base64'));
        }
      }
    }
    await test.chrome().command('Emulation.clearDeviceMetricsOverride');
    const tabs = (await tabSnapshot()).tabs;
    await send({ type: 'activateTab', tabId: tabs[0].id });
    await waitFor(async () => (await tabSnapshot()).active === tabs[0].id, 'first tab selected');
    const focusTab = async id => {
      await send({ type: 'focusOmnibox' });
      await waitFor(() => chrome('document.hasFocus() && document.activeElement===document.querySelector(".omnibox input")'), 'native chrome focus before keyboard tab navigation');
      await chrome(`document.querySelector('[data-tab-id="${id}"]').focus()`);
      await waitFor(() => chrome(`document.hasFocus() && document.activeElement===document.querySelector('[data-tab-id="${id}"]')`), 'focused tab before trusted key input');
    };
    await focusTab(tabs[0].id);
    await test.chrome().command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    await test.chrome().command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    await waitFor(async () => (await tabSnapshot()).active === tabs[1].id, 'keyboard selects next tab');
    await waitFor(() => chrome(`document.hasFocus() && document.activeElement===document.querySelector('[data-tab-id="${tabs[1].id}"]')`), 'keyboard tab selection preserves native chrome focus');
    await test.chrome().command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35 });
    await test.chrome().command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35 });
    await waitFor(async () => (await tabSnapshot()).active === tabs.at(-1).id, 'keyboard selects last overflowing tab');
    for (const [key, code, target] of [['Home', 36, tabs[0].id], ['ArrowLeft', 37, tabs.at(-1).id], ['ArrowRight', 39, tabs[0].id]]) {
      await waitFor(() => chrome('document.hasFocus() && document.activeElement?.matches(".tab-select")'), 'continuous tab keyboard focus without refocusing');
      await test.chrome().command('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: code });
      await test.chrome().command('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code });
      await waitFor(async () => (await tabSnapshot()).active === target, `${key} continuously selects the expected tab`);
    }
    const beforeNew = (await tabSnapshot()).tabs.length;
    await trustedClick(test.chrome(), '.new-tab');
    await waitFor(async () => (await tabSnapshot()).tabs.length === beforeNew + 1, 'new tab remains accessible while overflowing');
    await trustedClick(test.chrome(), '.tab.active .tab-close');
    await waitFor(async () => (await tabSnapshot()).tabs.length === beforeNew, 'tab close remains accessible');
    console.log('PASS: browser tab borders/active rose cue, overflow arrows, active visibility, native 84px chrome, keyboard navigation and new/close controls work in both themes');
  };
  try {
    if (test.tabsOnly) {
      await tabChecks();
      return;
    }
    const baseline = test.stats();
    for (const route of ['/api/memory', '/api/memory/search', '/api/memory/preferences', '/api/memory/item?id=1']) {
      await rpc(route, undefined, 403, { 'x-aib-token': 'not-the-launch-token' });
    }
    const initial = await rpc('/api/memory');
    const headers = await test.chrome().command('Runtime.evaluate', {
      expression: `fetch("/api/memory",{headers:{"x-aib-token":new URL(location.href).searchParams.get("token")}})
        .then(response=>response.headers.get("cache-control"))`, awaitPromise: true, returnByValue: true,
    });
    assert.equal(headers.result?.value, 'no-store');
    assert.equal(initial.config.captureEnabled, false);
    assert.equal(initial.pages, 0);
    assert.equal(initial.research, 0);
    assert.equal(await exists(test.memoryDirectory), false);
    console.log('PASS: memory APIs require launch authentication; opening metadata is lazy, default-off and model-free');

    await navigate('/memory/public');
    let page = await ready('/memory/public');
    await delay(400);
    assert.equal((await search('BorealisKeyword')).items.length, 0);
    assert.equal(await exists(test.memoryDirectory), false);
    await openMemory();
    assert.equal(await ui('Array.from(document.querySelectorAll(".memory-select input")).some(input=>input.checked)'), false);
    assert.equal(await ui('document.querySelector("#memory-include-preferences").checked'), false);
    await clickText('Save current page locally');
    const manual = await waitFor(async () => (await search('BorealisKeyword', 'page')).items[0], 'manual page snapshot saved');
    const manualItem = await rpc(`/api/memory/item?id=${manual.id}`);
    noPrivate(manualItem);
    assert(manualItem.excerpt.includes('[redacted]'));
    assert.equal(manualItem.url, `${fixtureBase}/memory/public`);
    assert.equal((await tabSnapshot()).active, page.id, 'Saving must not activate another page');
    assert.equal(test.stats().modelCalls, baseline.modelCalls);
    assert.equal(test.stats().readerCalls, baseline.readerCalls);
    console.log('PASS: trusted Save current page captures bounded form-free/redacted text without model calls or tab navigation');

    await config(true);
    await navigate('/memory/automatic');
    await ready('/memory/automatic');
    const automatic = await waitFor(async () => (await search('', 'page')).items.find(item => item.url.endsWith('/memory/automatic')), 'automatic public capture');
    assert(automatic);
    await config(false);
    const countBefore = (await rpc('/api/memory')).pages;
    await navigate('/memory/paused');
    await ready('/memory/paused');
    await delay(400);
    assert.equal((await rpc('/api/memory')).pages, countBefore);
    console.log('PASS: opt-in automatic public capture works; pause prevents future page capture without deleting old memory');

    await config(true);
    await navigate('/memory/slow');
    await config(false);
    await ready('/memory/slow');
    await delay(400);
    assert(!(await search('', 'page')).items.some(item => item.url.endsWith('/memory/slow')));
    console.log('PASS: pausing while a document loads prevents its late memory snapshot');

    await config(false, ['127.0.0.1']);
    assert.equal((await search()).items.length, 0);
    const excluded = await rpc('/api/memory/page', { tabId: (await tabSnapshot()).active }, 409);
    assert(excluded.error.includes('excluded'));
    await config(false);
    await navigate('/checkout');
    await ready('/checkout');
    await rpc('/api/memory/page', { tabId: (await tabSnapshot()).active }, 409);
    await put('/api/memory/config', { captureEnabled: false, retentionDays: 0, excludedSites: [] }, 409);
    await put('/api/memory/config', { captureEnabled: false, retentionDays: 30, excludedSites: ['example.com/path'] }, 409);
    await rpc('/api/memory/search?after=2026-02-30', undefined, 409);
    await rpc('/api/memory/search?q=!!!', undefined, 409);
    assert.equal((await search('Rust OR NOT "x"')).items.length, 0);
    console.log('PASS: exclusions purge matching memory, manual capture respects account/payment policy, and search/config invalid inputs fail explicitly');

    const preferences = { travel: 'Prefer aisle seats and nonstop flights. MEMORY_PREFERENCE_ONLY',
      shopping: 'Prefer repairable products.', research: 'Prefer official sources.' };
    await put('/api/memory/preferences', preferences);
    await put('/api/memory/preferences', { ...preferences, travel: 'password=memoryPrivatePlain' }, 409);
    await put('/api/memory/preferences', { ...preferences, travel: 'x'.repeat(501) }, 409);
    assert.deepEqual(await rpc('/api/memory/preferences'), preferences);
    console.log('PASS: personal preferences are editable local notes; recognizable secrets and oversized fields are refused');

    await send({ type: 'newTab', url: `${fixtureBase}/compare/a` });
    const alpha = await ready('/compare/a');
    await send({ type: 'newTab', url: `${fixtureBase}/compare/b` });
    const beta = await ready('/compare/b');
    await send({ type: 'openAssistant', panel: 'task' });
    await waitFor(() => ui('!!document.querySelector(".task-mode") || !!document.querySelector(".research-results")'), 'task workspace mounted');
    if (!await ui('!!document.querySelector("#task-goal")')) await clickText('New task');
    await waitFor(() => ui('!!document.querySelector("#task-goal")'), 'task panel before comparison starts');
    await rpc('/api/agent', { goal: 'memory archive compare these hotel tabs', sharePage: true,
      startMode: 'selectedTabs', mode: 'research', selectedTabs: await selection([alpha.id, beta.id]) });
    let task = await pending();
    await waitFor(() => ui('!!document.querySelector(".task-approval")'), 'native comparison approval visible before completing');
    await rpc('/api/memory/research', { taskId: task.id }, 409);
    await rpc('/api/agent/approve', { taskId: task.id, approvalId: task.pending.id, allow: true, approveAll: true });
    task = await terminal();
    assert.equal(task.status, 'completed', task.error);
    await waitFor(() => ui('!!document.querySelector(".research-results .comparison-table") && !!document.querySelector(".research-results .memory-save button:not(:disabled)")'), 'settled findings with explicit save action');
    await clickText('Save research to Memory');
    const comparisonRecord = await waitFor(async () => (await search('archive', 'research')).items[0], 'saved comparison');
    const comparisonSaved = await rpc(`/api/memory/item?id=${comparisonRecord.id}`);
    assert.deepEqual(comparisonSaved.research.comparison, task.comparison);
    assert.deepEqual(comparisonSaved.research.sources, task.sources);
    assert.deepEqual(Object.keys(comparisonSaved.research).sort(),
      ['answer', 'capturedAt', 'comparison', 'goal', 'message', 'model', 'report', 'sources'].sort());
    noPrivate(comparisonSaved);
    console.log('PASS: native finished comparison saves its exact source-bound table, not pending approvals, action permits or diagnostics');

    await navigate('/offers');
    await ready('/offers');
    await rpc('/api/agent', { goal: 'priced shopping options memory archive', sharePage: true,
      startMode: 'currentPage', compareOptions: true });
    task = await terminal();
    assert.equal(task.status, 'completed', task.error);
    const shoppingSave = await rpc('/api/memory/research', { taskId: task.id });
    const shoppingSaved = await rpc(`/api/memory/item?id=${shoppingSave.id}`);
    assert.deepEqual(shoppingSaved.research.report, task.report);
    assert(shoppingSaved.research.report.options.every(option => option.links.length > 0));
    await rpc('/api/memory/research', { taskId: task.id, result: 'client supplied result must be refused' }, 422);
    console.log('PASS: ordinary research saves price/source/link output losslessly; the API refuses client-supplied result contents');

    await openMemory();
    await waitFor(() => ui(`!!document.querySelector('[data-memory-id="${comparisonRecord.id}"]')`), 'saved comparison in memory list');
    await trustedClick(assistant, `[data-memory-id="${comparisonRecord.id}"] .memory-item-title`);
    await waitFor(() => ui('!!document.querySelector(".memory-detail .comparison-table")'), 'archived comparison rendered without fake live task');
    assert(await ui('document.querySelector(".memory-detail").textContent.includes("have not been reverified")'));
    assert(await ui('document.querySelector(".memory-detail").textContent.includes("Prices, availability and facts may be stale")'));
    const beforeSource = await tabSnapshot();
    await trustedClick(assistant, '.memory-detail .comparison-source');
    await waitFor(async () => {
      const state = await tabSnapshot();
      return state.tabs.length === beforeSource.tabs.length + 1 && state.tabs.find(tab => tab.id === state.active)?.url === `${fixtureBase}/compare/a`;
    }, 'archive source opens a new tab');
    for (const tab of beforeSource.tabs) assert.equal((await tabSnapshot()).tabs.find(item => item.id === tab.id)?.url, tab.url);
    console.log('PASS: archived comparison is visibly historical; original source links open new tabs without replacing existing pages');

    await trustedClick(assistant, `[data-memory-id="${comparisonRecord.id}"] .memory-select input`);
    await trustedClick(assistant, '#memory-include-preferences');
    const callsBeforePreview = test.stats();
    await clickText('Preview selected context');
    const previewContext = await waitFor(() => ui('document.querySelector(".memory-preview textarea")?.value'), 'exact native memory preview');
    const context = JSON.parse(previewContext);
    assert.equal(context.items.length, 1);
    assert.deepEqual(context.preferences, preferences);
    assert(context.items[0].excerpt.includes('Total USD 240.'), 'Comparison context includes historical table facts');
    noPrivate(context);
    assert.equal(test.stats().modelCalls, callsBeforePreview.modelCalls);
    await clickText('Use in a new research draft');
    await waitFor(() => ui('!!document.querySelector(".memory-task-context") && !!document.querySelector("#task-goal")'), 'memory research-only draft');
    assert.equal(await ui('document.querySelector(".memory-task-context input").checked'), false);
    assert.equal(await ui('document.querySelector(".task-form button[type=submit]").disabled'), true);
    await setField('task-goal', 'finish here memory context only');
    await setField('task-start', 'currentPage');
    await trustedClick(assistant, '.memory-task-context input');
    await trustedClick(assistant, '.task-form > .check-label input');
    assert.equal(await ui('document.querySelector(".task-form button[type=submit]").disabled'), false);
    await setField('task-goal', 'finish here memory context only after edit');
    assert.equal(await ui('document.querySelector(".memory-task-context input").checked'), false);
    assert.equal(await ui('document.querySelector(".task-form button[type=submit]").disabled'), true);
    await trustedClick(assistant, '.memory-task-context input');
    await navigate('/memory/public');
    await ready('/memory/public');
    await trustedClick(assistant, '.task-form button[type=submit]');
    task = await terminal();
    assert.equal(task.status, 'completed', task.error);
    assert.deepEqual(task.memoryContext, context);
    assert.equal(task.sources.length, 1);
    assert.equal(task.sources[0].url, `${fixtureBase}/memory/public`, 'Archive URLs never become current source evidence');
    assert.equal(task.actions.length, 0);
    assert.equal(task.taskPermission, 'askEach');
    const shared = test.stats().sharedContextInputs.slice(callsBeforePreview.sharedContextInputs.length);
    assert.equal(shared.length, 2, 'The mock brief requires exactly one bounded options-format correction');
    assert.equal(task.modelUsage.repairs, 1);
    for (const input of shared) {
      assert.deepEqual(input.savedContext, context, 'Initial and correction requests share the same frozen task-scoped selection');
      assert.equal(input.visitedPages.length, 1);
    }
    console.log('PASS: preview/draft are model-free and unconsented; trusted task consent shares only the exact selected context, never fresh citations or action authority');

    const deniedPreview = await rpc('/api/memory/preview', { ids: [comparisonRecord.id], includePreferences: false });
    const deniedBaseline = test.stats().modelCalls;
    await rpc('/api/agent', { goal: 'finish here unconsented memory', sharePage: true, startMode: 'currentPage',
      memoryPreviewId: deniedPreview.id, shareMemory: false }, 409);
    await rpc('/api/agent', { goal: 'finish here forged memory', sharePage: true, startMode: 'currentPage',
      memoryPreviewId: 'not-a-native-preview', shareMemory: true }, 409);
    await rpc('/api/agent', { goal: 'Prepare Cancun', sharePage: true, startMode: 'currentPage', mode: 'prepare',
      memoryPreviewId: deniedPreview.id, shareMemory: true }, 409);
    await put('/api/memory/preferences', preferences);
    await rpc('/api/agent', { goal: 'finish here stale memory', sharePage: true, startMode: 'currentPage',
      memoryPreviewId: deniedPreview.id, shareMemory: true }, 409);
    assert.equal(test.stats().modelCalls, deniedBaseline);
    await rpc('/api/memory/preview', { ids: [comparisonRecord.id, comparisonRecord.id], includePreferences: false }, 409);
    await rpc('/api/memory/preview', { ids: [], includePreferences: false }, 409);
    console.log('PASS: missing consent, forged/stale previews, duplicate selections and preparation-context sharing fail before any model request');

    await navigate('/start');
    await ready('/start');
    await start('finish here without remembered context');
    task = await terminal();
    assert.equal(task.status, 'completed', task.error);
    assert.equal(task.memoryContext, null);
    assert.equal(test.stats().sharedContextInputs.length, callsBeforePreview.sharedContextInputs.length + shared.length);
    const auditFiles = await fs.readdir(test.auditDirectory);
    for (const file of auditFiles.filter(file => file.endsWith('.json'))) {
      const audit = await fs.readFile(path.join(test.auditDirectory, file), 'utf8');
      assert(!audit.includes('MEMORY_PREFERENCE_ONLY') && !audit.includes('savedContext') && !audit.includes('memoryContext'));
    }
    console.log('PASS: ordinary tasks do not inherit previous context; metadata-only task audit does not persist shared preference text');

    assistant.close();
    assistant = null;
    await test.restartBrowser();
    assert.equal(await rpc('/api/agent'), null, 'Saved research is not replayed as a live task after restart');
    assert.deepEqual((await rpc(`/api/memory/item?id=${comparisonRecord.id}`)).research, comparisonSaved.research);
    assert.deepEqual((await rpc(`/api/memory/item?id=${shoppingSave.id}`)).research, shoppingSaved.research);
    assert.deepEqual(await rpc('/api/memory/preferences'), preferences);
    assert((await search('archive', 'research')).items.some(item => item.id === comparisonRecord.id));
    assert.equal((await search('archive', 'research', '2999-01-01')).items.length, 0);
    console.log('PASS: real application restart preserves comparisons, research links/prices, preferences and keyword/date retrieval without replaying authority');

    await openMemory();
    await trustedClick(assistant, `[data-memory-id="${shoppingSave.id}"] .memory-item-title`);
    await waitFor(() => ui('document.querySelector(".memory-detail")?.textContent.includes("Historical subtotal")'), 'saved price report after restart');
    for (const theme of ['light', 'dark']) {
      await assistant.command('Emulation.setDeviceMetricsOverride', { width: 320, height: 780, deviceScaleFactor: 1, mobile: false });
      await ui(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      await waitFor(() => ui('document.querySelector(".memory-panel").scrollWidth<=document.querySelector(".memory-panel").clientWidth'), `memory fits 320px ${theme}`);
      assert(await ui('Array.from(document.querySelectorAll(".assistant-tabs button")).every(button=>parseFloat(getComputedStyle(button).borderTopWidth)>=1)'));
      if (process.env.AIB_TEST_MEMORY_SCREENSHOT) {
        const file = process.env.AIB_TEST_MEMORY_SCREENSHOT;
        assert(path.isAbsolute(file));
        const parsed = path.parse(file);
        await ui('document.querySelector(".memory-panel").scrollTop=0');
        const image = await assistant.command('Page.captureScreenshot', { format: 'png' });
        await fs.writeFile(theme === 'light' ? file : path.join(parsed.dir, `${parsed.name}-dark${parsed.ext}`), Buffer.from(image.data, 'base64'));
      }
    }
    await assistant.command('Emulation.clearDeviceMetricsOverride');
    console.log('PASS: memory and visibly bordered assistant tabs fit 320px in both themes');

    await tabChecks();

    await send({ type: 'openAssistant', panel: 'memory' });
    await rpc('/api/memory/forget', { id: comparisonRecord.id, confirm: false }, 409);
    assert((await rpc(`/api/memory/item?id=${comparisonRecord.id}`)).research);
    const stale = await rpc('/api/memory/preview', { ids: [comparisonRecord.id], includePreferences: false });
    await clickText('Refresh memory');
    await waitFor(() => ui(`!!document.querySelector('[data-memory-id="${comparisonRecord.id}"]')`), 'comparison available for deletion');
    await trustedClick(assistant, `[data-memory-id="${comparisonRecord.id}"] > .assistant-secondary`);
    await clickText('Confirm deletion');
    await waitFor(async () => !(await search('archive', 'research')).items.some(item => item.id === comparisonRecord.id), 'deleted comparison absent from index');
    await rpc(`/api/memory/item?id=${comparisonRecord.id}`, undefined, 409);
    await rpc('/api/agent', { goal: 'finish here deleted context', sharePage: true, startMode: 'currentPage',
      memoryPreviewId: stale.id, shareMemory: true }, 409);
    console.log('PASS: confirmed individual forgetting removes archive and full-text matches and invalidates its pending sharing preview');

    await config(true);
    await rpc('/api/memory/clear', { confirm: false }, 409);
    await clickText('Clear all local memory');
    await clickText('Confirm deletion');
    await waitFor(async () => (await search()).items.length === 0, 'all memory cleared');
    assert.deepEqual(await rpc('/api/memory/preferences'), { travel: '', shopping: '', research: '' });
    assert.equal((await rpc('/api/memory')).config.captureEnabled, false);
    assistant.close();
    assistant = null;
    await test.restartBrowser();
    assert.equal((await search()).items.length, 0);
    assert.equal((await rpc('/api/memory')).config.captureEnabled, false);
    console.log('PASS: confirmed clear-all deletes pages/research/preferences, pauses capture, and remains cleared after a second real restart');

    const corrupt = Buffer.from('Deliberately corrupt disposable memory database');
    await test.restartBrowser(() => fs.writeFile(test.memoryFile, corrupt));
    await rpc('/api/agent');
    const unavailable = await rpc('/api/memory', undefined, 409);
    assert(/memory is unavailable|not a database/i.test(unavailable.error));
    assert.deepEqual(await fs.readFile(test.memoryFile), corrupt, 'Corrupt memory must not be silently replaced');
    await navigate('/memory/recovery');
    await ready('/memory/recovery');
    await send({ type: 'openAssistant', panel: 'memory' });
    assistant = await waitFor(() => test.connect('assistant'), 'corrupt memory UI connection');
    await waitFor(() => ui('document.querySelector(".memory-panel [role=alert]")?.textContent.includes("unavailable")'), 'explicit memory storage failure in UI');
    console.log('PASS: corrupt storage is preserved and visibly reported; ordinary browser navigation and authenticated task APIs remain responsive');
    return { unavailableError: unavailable.error };
  } finally {
    assistant?.close();
    if (test.chrome()) await test.chrome().command('Emulation.clearDeviceMetricsOverride');
  }
};
