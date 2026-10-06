// Reference-design checks in the disposable native browser, not a parallel HTML mock.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(probe, label, timeout = 20000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = await probe();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}

module.exports = async function redesignChecks(test) {
  const { rpc, send, tabSnapshot, trustedClick, navigate, start, pending, terminal } = test;
  const original = await tabSnapshot();
  const originalIds = new Set(original.tabs.map(tab => tab.id));
  const callsBefore = test.stats();
  let home, assistant;
  const evaluate = async (connection, expression) => {
    const result = await connection.command('Runtime.evaluate', { expression, returnByValue: true });
    assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  };
  const ui = expression => evaluate(assistant, expression);
  const startUi = expression => evaluate(home, expression);
  const chrome = expression => evaluate(test.chrome(), expression);
  const open = async panel => {
    await send({ type: 'openAssistant', panel });
    assistant ||= await waitFor(() => test.connect('assistant'), 'redesign assistant connection');
  };
  const focusHome = async () => {
    await send({ type: 'focusContent' });
    await waitFor(() => startUi('document.hasFocus()'), 'native start-page focus');
  };
  const clickText = async (connection, text) => {
    const selector = await evaluate(connection, `(() => {
      const button=Array.from(document.querySelectorAll('button')).find(node=>node.textContent===${JSON.stringify(text)});
      if(!button) return null;
      button.dataset.redesignClick='target';
      return '[data-redesign-click="target"]';
    })()`);
    assert(selector, `Missing redesigned control: ${text}`);
    try { await trustedClick(connection, selector); }
    finally { await evaluate(connection, 'document.querySelector("[data-redesign-click]")?.removeAttribute("data-redesign-click")'); }
  };
  const capture = async (connection, suffix) => {
    if (!process.env.AIB_TEST_REDESIGN_SCREENSHOT) return;
    const file = process.env.AIB_TEST_REDESIGN_SCREENSHOT;
    assert(path.isAbsolute(file), 'Redesign screenshot prefix must be absolute');
    const parsed = path.parse(file);
    const image = await connection.command('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(parsed.dir, `${parsed.name}-${suffix}${parsed.ext}`), Buffer.from(image.data, 'base64'));
  };
  const key = (connection, name, code, virtual, modifiers = 0) => connection.command('Input.dispatchKeyEvent', {
    type: 'rawKeyDown', key: name, code, windowsVirtualKeyCode: virtual, nativeVirtualKeyCode: virtual, modifiers,
  }).then(() => connection.command('Input.dispatchKeyEvent', {
    type: 'keyUp', key: name, code, windowsVirtualKeyCode: virtual, nativeVirtualKeyCode: virtual, modifiers,
  }));
  const editableModel = async name => {
    await open('settings');
    await waitFor(() => ui('!!document.querySelector(".model-settings input[required]") && document.hasFocus()'), 'model settings ready for native typing');
    await trustedClick(assistant, '.model-settings input[required]');
    await key(assistant, 'a', 'KeyA', 65, 2);
    await assistant.command('Input.insertText', { text: name });
    assert.equal(await ui('document.querySelector(".model-settings input[required]").value'), name);
    await trustedClick(assistant, '.model-settings button[type="submit"]');
    await waitFor(() => ui('!!document.querySelector(".assistant-composer")'), 'successful settings save returns to page chat');
    await waitFor(() => chrome(`document.querySelector(".chrome-model span")?.textContent===${JSON.stringify(name)}`), 'real model selection reaches native chrome');
  };
  const noAutomaticModelUse = () => {
    const stats = test.stats();
    assert.equal(stats.modelCalls, callsBefore.modelCalls, 'Redesigned controls must not automatically start inference');
    assert.equal(stats.readerCalls, callsBefore.readerCalls, 'Redesigned controls must not read page content without consent');
  };
  try {
    await send({ type: 'newTab' });
    home = await waitFor(() => test.connect('start'), 'redesigned trusted start surface');
    await waitFor(() => startUi('!!document.querySelector(".start-workspaces")'), 'reference start layout ready');
    await open('chat');
    await waitFor(() => ui('!!document.querySelector(".assistant-header")'), 'reference assistant header ready');
    await assistant.command('Page.reload');
    await waitFor(() => ui('!!document.querySelector(".assistant-header")'), 'reloaded native assistant ready');
    await open('chat');
    await waitFor(() => ui('!!document.querySelector(".assistant-composer")'), 'page chat visible without a model call');
    assert.equal(await ui('innerWidth'), 384, 'Native assistant geometry must match the new 384-DIP design');
    for (const theme of ['light', 'dark']) {
      for (const width of [1280, 640, 320]) {
        await test.chrome().command('Emulation.setDeviceMetricsOverride', { width, height: 84, deviceScaleFactor: 1, mobile: false });
        await chrome(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
        const layout = await chrome(`(() => {
          const strip=document.querySelector('.tabstrip'), toolbar=document.querySelector('.toolbar');
          const controls=Array.from(document.querySelectorAll('.toolbar button,.omnibox input,.new-tab'))
            .map(node=>node.getBoundingClientRect()).filter(box=>box.width>0);
          return {strip:getComputedStyle(strip).backgroundColor,top:toolbar.getBoundingClientRect().top,
            bottom:toolbar.getBoundingClientRect().bottom,body:document.documentElement.scrollWidth,
            fits:controls.every(box=>box.left>=0 && box.right<=innerWidth+1),
            svg:document.querySelectorAll('.nav > svg').length,
            addressLabel:document.querySelector('.omnibox input').getAttribute('aria-label')};
        })()`);
        assert.deepEqual(layout, { strip: 'rgb(28, 31, 38)', top: 38, bottom: 84, body: width, fits: true,
          svg: 4, addressLabel: 'Search or enter address' }, JSON.stringify({ theme, width, layout }));
        await capture(test.chrome(), `chrome-${theme}-${width}`);
      }
    }
    await test.chrome().command('Emulation.clearDeviceMetricsOverride');
    console.log('PASS: reference dark chrome stays 84 DIP with native icons, labelled address input and visible controls at 1280, 640 and 320px in both themes');

    for (const theme of ['light', 'dark']) {
      for (const width of [1280, 640, 320]) {
        await home.command('Emulation.setDeviceMetricsOverride', { width, height: 960, deviceScaleFactor: 1, mobile: false });
        await startUi(`document.documentElement.dataset.theme=${JSON.stringify(theme)}; document.querySelector('.start-page').scrollTop=0`);
        const layout = await startUi(`(() => {
          const box=selector=>document.querySelector(selector).getBoundingClientRect();
          const hero=box('.start-hero'), studio=box('.start-composer'), shell=box('.start-shell');
          const controls=Array.from(document.querySelectorAll('.start-page button,.start-page textarea')).map(node=>node.getBoundingClientRect());
          return {fits:document.querySelector('.start-page').scrollWidth<=innerWidth && document.documentElement.scrollWidth<=innerWidth,
            controlsFit:controls.every(box=>box.left>=0 && box.right<=innerWidth+1),
            belowHero:studio.top>=hero.bottom,fullWidth:Math.abs(studio.width-shell.width)<1,
            modes:document.querySelectorAll('.start-intent-modes [role=tab]').length,
            workspaces:document.querySelector('.start-workspace-grid').children.length,
            upright:getComputedStyle(document.querySelector('.start-art-float')).transform==='none',
            canvas:getComputedStyle(document.documentElement).getPropertyValue('--cp-bg').trim(),
            accent:getComputedStyle(document.documentElement).getPropertyValue('--cp-accent').trim(),
            externalAssets:Array.from(document.querySelectorAll('script[src],link[rel=stylesheet]'))
              .some(node=>new URL(node.src||node.href).origin!==location.origin)};
        })()`);
        assert.deepEqual(layout, { fits: true, controlsFit: true, belowHero: true, fullWidth: true, modes: 4,
          workspaces: 3, upright: true, canvas: theme === 'light' ? '#faf8f5' : '#171a21',
          accent: theme === 'light' ? '#e11d48' : '#fb7185', externalAssets: false }, JSON.stringify({ theme, width, layout }));
        await capture(home, `home-${theme}-${width}`);
      }
    }
    await home.command('Emulation.clearDeviceMetricsOverride');
    const unavailableError = test.memoryUnavailableError;
    const memory = unavailableError ? null : await rpc('/api/memory');
    const memoryError = unavailableError || memory.lastError;
    if (unavailableError) {
      assert.deepEqual(await rpc('/api/memory', undefined, 409), { error: unavailableError });
    }
    await focusHome();
    await waitFor(() => startUi(memoryError
      ? `document.querySelector('.start-memory-error')?.textContent.includes(${JSON.stringify(memoryError)})`
      : `document.querySelector('.start-workspace-card p')?.textContent.includes(${JSON.stringify(`${memory.research} saved research`)})`),
    'home displays real local archive counts or the explicit native storage error');
    assert(!(await startUi('document.querySelector(".start-page").textContent')).match(/zero.telemetry|live tracker|biometric|Pro v2|14ms|vetted engines/i));
    noAutomaticModelUse();
    console.log('PASS: warm rose canvas, upright local artwork and full-width intent studio match the supplied layout; workspace counts are real and no CDN or fabricated feature claim is shipped');

    for (const theme of ['light', 'dark']) {
      for (const width of [384, 320]) {
        await assistant.command('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await ui(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
        const layout = await ui(`(() => {
          const controls=Array.from(document.querySelectorAll('.assistant-header button,.assistant-tabs button,.assistant-composer button,.assistant-composer textarea'))
            .map(node=>node.getBoundingClientRect());
          return {fits:document.documentElement.scrollWidth<=innerWidth,
            controlsFit:controls.every(box=>box.left>=0 && box.right<=innerWidth+1),
            primary:document.querySelector('.assistant-primary-tabs').children.length,
            secondary:document.querySelector('.assistant-secondary-tabs').children.length,
            context:!!document.querySelector('.assistant-context-page'),suggestions:document.querySelectorAll('.assistant-suggestions > button').length,
            questionLabel:document.querySelector('.assistant-composer textarea').getAttribute('aria-label')};
        })()`);
        assert.deepEqual(layout, { fits: true, controlsFit: true, primary: 3, secondary: 3, context: true, suggestions: 3, questionLabel: 'Ask a question' });
        await capture(assistant, `assistant-${theme}-${width}`);
      }
    }
    await assistant.command('Emulation.clearDeviceMetricsOverride');
    for (const [name, selector] of [['Memory', '.memory-panel'], ['Local models', '.local-models'],
      ['Safety', '.safety-center'], ['Reliability', '.reliability-center'], ['Ask this page', '.assistant-composer']]) {
      await clickText(assistant, name);
      await waitFor(() => ui(`!!document.querySelector(${JSON.stringify(selector)})`), `real redesigned ${name} workspace`);
    }
    noAutomaticModelUse();
    console.log('PASS: split assistant navigation, honest page context and bottom composer fit 384px and 320px in both themes; all six production workspaces remain reachable');

    await focusHome();
    await startUi('document.querySelector(\'[data-intent="options"]\').focus()');
    await key(home, 'ArrowLeft', 'ArrowLeft', 37);
    await waitFor(() => startUi('document.activeElement.dataset.intent==="research" && document.activeElement.getAttribute("aria-selected")==="true"'), 'intent tabs move left with native keyboard input');
    await key(home, 'End', 'End', 35);
    await waitFor(() => startUi('document.activeElement.dataset.intent==="tabs"'), 'intent End');
    await key(home, 'ArrowRight', 'ArrowRight', 39);
    await waitFor(() => startUi('document.activeElement.dataset.intent==="research"'), 'intent wrapping right');
    assert.equal(await startUi('document.querySelectorAll(".start-intent-modes button[tabindex=\'0\']").length'), 1);
    await trustedClick(home, '#start-goal');
    await home.command('Input.insertText', { text: 'Design regression: editable goal with no automatic research' });
    for (const [id, mode, startingPoint, format] of [
      ['research', 'research', 'webSearch', 'brief'], ['options', 'research', 'webSearch', 'options'],
      ['prepare', 'prepare', 'currentPage', null], ['tabs', 'research', 'selectedTabs', null],
    ]) {
      await focusHome();
      await trustedClick(home, `[data-intent="${id}"]`);
      await trustedClick(home, '.start-composer button[type="submit"]');
      await waitFor(() => ui(`document.querySelector('#task-goal')?.value.includes('Design regression:') &&
        document.querySelector('#task-mode')?.value===${JSON.stringify(mode)} &&
        document.querySelector('#task-start')?.value===${JSON.stringify(startingPoint)}`), `native ${id} draft handoff`);
      const draft = await ui(`(() => {
        const form=document.querySelector('.task-form');
        return {sharing:Array.from(form.querySelectorAll('input[type=checkbox]')).some(input=>input.checked),
          disabled:form.querySelector('button[type=submit]').disabled,focus:document.activeElement.id,
          format:document.querySelector('#task-format')?.value||null,selected:document.querySelector('.tab-selection-count')?.textContent||null};
      })()`);
      assert.equal(draft.sharing, false);
      assert.equal(draft.disabled, true);
      assert.equal(draft.focus, 'task-goal');
      assert.equal(draft.format, format);
      if (id === 'tabs') assert(draft.selected.startsWith('0/6 selected'));
      noAutomaticModelUse();
    }
    console.log('PASS: native intent keyboard navigation and all four draft modes preserve the exact goal, real starting point and format; sharing, selected tabs and Start stay unapproved');

    await open('chat');
    await waitFor(() => ui('!!document.querySelector(".assistant-suggestions")'), 'real page suggestions visible');
    await trustedClick(assistant, '.assistant-suggestions > button:first-of-type');
    await waitFor(() => ui('document.querySelector(".assistant-composer textarea").value.startsWith("Summarize the key takeaways")'), 'summary action prefills an editable question');
    await trustedClick(assistant, '.assistant-suggestions > button:last-of-type');
    await waitFor(() => ui('document.querySelector(".assistant-composer textarea").value.startsWith("Explain the main claims")'), 'claims action prefills an editable question');
    await trustedClick(assistant, '.assistant-suggestions > button:nth-of-type(2)');
    await waitFor(() => ui('document.querySelector("#task-start")?.value==="selectedTabs" && document.querySelector(".tab-selection-count")?.textContent.startsWith("0/6 selected")'), 'comparison suggestion opens an unselected native draft');
    assert.equal(await ui('document.querySelector(".task-form button[type=submit]").disabled'), true);
    noAutomaticModelUse();
    console.log('PASS: suggested actions edit questions or open explicit tab-selection drafts without inference, page extraction or inherited sharing permission');

    if (memory && !memory.lastError) {
      await open('memory');
      await waitFor(() => ui('!!document.querySelector(".memory-badge") && document.hasFocus()'), 'native memory capture controls');
      const enabled = memory.config.captureEnabled;
      await clickText(assistant, enabled ? 'Pause automatic capture' : 'Enable automatic capture');
      await waitFor(() => startUi(`document.querySelector('.start-workspace-state')?.textContent===${JSON.stringify(enabled ? 'Capture paused' : 'Capture on')}`),
        'memory change reaches the visible start surface without refocusing it');
      assert.equal(await startUi('document.hasFocus()'), false, 'Cross-surface refresh must not steal content focus');
      await clickText(assistant, enabled ? 'Enable automatic capture' : 'Pause automatic capture');
      await waitFor(() => startUi(`document.querySelector('.start-workspace-state')?.textContent===${JSON.stringify(enabled ? 'Capture on' : 'Capture paused')}`),
        'restored capture status reaches the start surface');
      assert.equal((await rpc('/api/memory')).config.captureEnabled, enabled);
    }
    noAutomaticModelUse();
    console.log('PASS: local memory privacy changes refresh the real home status without focus theft or model use; unavailable storage keeps its explicit native error');

    const settings = await rpc('/api/settings');
    await open('settings');
    await assistant.command('Page.reload');
    await waitFor(() => ui('!!document.querySelector(".model-settings input[required]")'), 'fresh saved model configuration loaded');
    const model = `${settings.model}-design-check`;
    await editableModel(model);
    assert.equal((await rpc('/api/settings')).model, model);
    await editableModel(settings.model);
    assert.equal((await rpc('/api/settings')).model, settings.model);
    noAutomaticModelUse();
    console.log('PASS: real native typing and settings saves update the configured model badge across trusted surfaces, with no invented latency or inference call');

    await navigate();
    await send({ type: 'openAssistant', panel: 'task', goal: '' });
    await waitFor(() => ui('!!document.querySelector(".task-form")'), 'fresh task UI before explicit regression task');
    await start('slow approve all design fixture');
    const proposal = await pending();
    await waitFor(() => ui('!!document.querySelector(".approval-allow-all:not(:disabled)")'), 'Approve all in redesigned real task approval');
    for (const theme of ['light', 'dark']) {
      await assistant.command('Emulation.setDeviceMetricsOverride', { width: 320, height: 900, deviceScaleFactor: 1, mobile: false });
      await ui(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      const controls = await ui(`(() => {
        const box=document.querySelector('.approval-allow-all').getBoundingClientRect();
        return {fits:document.documentElement.scrollWidth<=innerWidth,left:box.left,right:box.right,
          text:document.querySelector('.approval-allow-all').textContent};
      })()`);
      assert(controls.fits && controls.left>=0 && controls.right<=320, JSON.stringify(controls));
      assert.equal(controls.text, 'Approve all for this task');
      await ui('document.querySelector(".approval-allow-all").scrollIntoView({block:"center",behavior:"instant"})');
      await capture(assistant, `approval-${theme}-320`);
    }
    await trustedClick(assistant, '.approval-allow-all');
    await waitFor(() => ui('!!document.querySelector(".research-grant")'), 'visible task-only permission after native approval');
    assert.equal((await rpc('/api/agent')).id, proposal.id);
    await clickText(assistant, 'Ask before each navigation');
    await waitFor(async () => (await rpc('/api/agent')).researchPermission !== 'allResearch', 'revocation reaches the native task');
    await clickText(assistant, 'Stop / take over');
    const stopped = await terminal();
    assert.equal(stopped.id, proposal.id);
    assert.equal(stopped.status, 'stopped');
    await waitFor(() => ui('document.querySelector(".task-status")?.textContent==="Stopped"'), 'explicit stopped state in redesigned task');
    console.log('PASS: 320px task approvals keep Approve all visible in both themes; native grant, revoke and Stop remain functional and never imply booking permission');

    await assistant.command('Emulation.clearDeviceMetricsOverride');
    await send({ type: 'newTab' });
    await open('chat');
    await waitFor(() => ui('!!document.querySelector(".assistant-composer")'), 'final native split workspace');
    await focusHome();
    await trustedClick(home, '#start-goal');
    await key(home, 'a', 'KeyA', 65, 2);
    await key(home, 'Backspace', 'Backspace', 8);
    await trustedClick(home, '[data-intent="options"]');
    await ui('document.activeElement?.blur()');
    for (const theme of ['light', 'dark']) {
      await chrome(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      await startUi(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.querySelector('.start-page').scrollTop=0`);
      await ui(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      await capture(test.chrome(), `split-chrome-${theme}`);
      await capture(home, `split-home-${theme}`);
      await capture(assistant, `split-assistant-${theme}`);
    }
  } finally {
    if (home) { await home.command('Emulation.clearDeviceMetricsOverride'); home.close(); }
    if (assistant) { await assistant.command('Emulation.clearDeviceMetricsOverride'); assistant.close(); }
    await test.chrome().command('Emulation.clearDeviceMetricsOverride');
    const state = await tabSnapshot();
    for (const tab of state.tabs) if (!originalIds.has(tab.id)) await send({ type: 'closeTab', tabId: tab.id });
    if (original.active !== null && (await tabSnapshot()).tabs.some(tab => tab.id === original.active)) {
      await send({ type: 'activateTab', tabId: original.active });
    }
  }
};
