// Native integration test with disposable settings/profile and loopback-only fixtures.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { execFileSync } = require('node:child_process');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}

async function connectCdp(url) {
  const ws = new WebSocket(url);
  await once(ws, 'open');
  let next = 0;
  const pending = new Map();
  ws.addEventListener('message', event => {
    const result = JSON.parse(event.data);
    const item = pending.get(result.id);
    if (item) {
      pending.delete(result.id);
      clearTimeout(item.timer);
      if (result.error) item.reject(new Error(JSON.stringify(result.error)));
      else item.resolve(result.result);
    }
  });
  return {
    close: () => ws.close(),
    command: (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    }),
  };
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'aib-agent-test-'));
  const hits = new Map();
  let fixtureError, modelCalls = 0, child, browserSocket, cdpSocket, token, base, nativePort;
  const fixture = http.createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, undefined, 'Cloud key must not reach fixtures');
      const route = req.url.split('?')[0];
      hits.set(route, (hits.get(route) || 0) + 1);
      if (route === '/v1/chat/completions') {
        modelCalls++;
        let body = '';
        for await (const chunk of req) body += chunk;
        const request = JSON.parse(body);
        const prompt = request.messages.find(message => message.role === 'user').content;
        const firstLine = prompt.split('\n')[0];
        const input = firstLine.startsWith('{') ? JSON.parse(firstLine) : null;
        const repairing = prompt.includes('Native protocol feedback:');
        let decision;
        if (!input?.userGoal) decision = 'mock page answer';
        else {
          assert(!prompt.includes('PRIVATE_INPUT_SENTINEL'), 'Input values were disclosed');
          assert(!prompt.includes('HIDDEN_TEXT_SENTINEL'), 'Hidden text was disclosed');
          assert(!prompt.includes('EDITABLE_SENTINEL'), 'Editable text was disclosed');
          const pages = input.visitedPages;
          const replies = input.conversation?.filter(message => message.role === 'user').slice(1) || [];
          const requirements = [input.userGoal, ...replies.map(message => message.content)].join(' ');
          const current = pages.at(-1);
          pages.forEach((page, index) => assert.equal(page.sourceId, index + 1, 'Missing explicit source ID'));
          if (current) {
            assert(current.headings.length > 0, 'Missing structured headings');
            assert(!current.links.some(link => link.url.startsWith('javascript:')), 'Unsafe link included');
          }
          if (input.userGoal.includes('slow')) await delay(2500);
          if (input.userGoal.includes('clarify evidence') && !replies.length) decision = '{"action":"needsInput","message":"What cancellation terms matter?"}';
          else if (input.userGoal.includes('clarify evidence')) {
            assert.equal(pages.length, 1, 'Clarification reread or discarded evidence');
            assert.equal(replies[0].content, 'Free cancellation');
            decision = '{"action":"finish","answer":"The observed option costs $42 [1]. Cancellation still needs verification.","sources":[1]}';
          }
          else if (input.userGoal.includes('repeat questions')) decision = '{"action":"needsInput","message":"One more detail?"}';
          else if (input.userGoal.includes('fenced grouped')) decision = '```json\n{"action":"finish","answer":"Observed price [1, 1].","sources":[1]}\n```';
          else if (input.userGoal.includes('malformed')) decision = '{"action":"click","id":1}';
          else if (input.userGoal.includes('bad citation')) decision = '{"action":"finish","answer":"Unvisited evidence [99]","sources":[1]}';
          else if (input.userGoal.includes('repair missing sources')) decision = repairing
            ? '{"action":"finish","answer":"The observed option costs $42 [1].","sources":[1]}'
            : '{"action":"finish","answer":"The observed option costs $42.","sources":[]}';
          else if (input.userGoal.includes('repair no evidence')) decision = repairing
            ? '{"action":"unable","message":"The starting page has no flight or hotel evidence. No live availability or prices were verified."}'
            : '{"action":"finish","answer":"There is no travel evidence here.","sources":[]}';
          else if (requirements.includes('Austin to Cancun') && !requirements.includes('Nov 20')) {
            assert.equal(pages.length, 0, 'An unrelated starting page was read before asking for dates');
            decision = '{"action":"needsInput","message":"What are your departure and return dates, number of travelers and hotel rooms, and budget? I have not searched flights or hotels yet."}';
          }
          else if (requirements.includes('Austin to Cancun') && !requirements.includes('room')) {
            decision = '{"action":"needsInput","message":"How many hotel rooms do you need? Your dates and traveler count are already noted."}';
          }
          else if (!pages.length) decision = JSON.stringify({ action: 'search', query: requirements, reason: 'Find relevant web evidence rather than reading the starting page' });
          else if ((input.userGoal.includes('search travel') || replies.length) && pages.length === 1) {
            assert(current.url.includes('/search?'), 'Search page was not opened');
            assert(!pages.some(page => page.url.endsWith('/unrelated')), 'Unrelated page shared in search-first mode');
            decision = JSON.stringify({ action: 'followLink', linkId: current.links.find(link => link.name === 'Travel details').id, reason: 'Read the travel planning page' });
          }
          else if (input.userGoal.includes('search travel') || replies.length) decision = '{"action":"finish","answer":"The page describes an Austin-Cancun route and hotel planning resources [2]. It does not establish live availability or confirmed prices.","sources":[2]}';
          else if (input.userGoal.includes('no evidence')) decision = '{"action":"unable","message":"This page contains no relevant evidence. A booking comparison cannot be verified here."}';
          else if (input.userGoal.includes('chain')) decision = JSON.stringify({ action: 'followLink', linkId: 1, reason: 'Read next page' });
          else if (pages.length > 1 || input.userGoal.includes('finish here')) {
            decision = JSON.stringify({ action: 'finish', answer: pages.length > 1
              ? 'The option costs $42 and includes breakfast [1]. Details confirm free cancellation [2].'
              : 'The option costs $42 and includes breakfast [1].',
              sources: pages.map((_, i) => i + 1) });
          } else {
            const name = input.userGoal.includes('redirect') ? 'Redirect test'
              : input.userGoal.includes('download') ? 'Download test' : 'Details';
            const link = current.links.find(link => link.name === name);
            assert(link, `Missing observed ${name} link`);
            decision = JSON.stringify({ action: 'followLink', linkId: link.id, reason: 'Verify the details before answering' });
          }
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: decision } }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      if (route === '/redirect') { res.writeHead(302, { Location: '/landing' }); res.end(); return; }
      if (route === '/download') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="aib-agent-test-forbidden.txt"' });
        res.end('This download must be blocked'); return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      const chain = route.match(/^\/chain\/(\d+)$/);
      const title = route === '/unicode' ? 'a'.repeat(299) + '😀' : route === '/details' ? 'Booking details' : 'Local research fixture';
      if (route === '/search' || route === '/travel' || route === '/unrelated') {
        res.end(route === '/unrelated' ? '<!doctype html><title>Example Domain</title><h1>Example Domain</h1><p>This domain is for illustrative examples.</p>'
          : `<!doctype html><title>Travel planning</title><h1>Austin to Cancun planning</h1><p>No confirmed prices or availability. Check airline and hotel sites with dates.</p><a href="/travel">Travel details</a>`);
        return;
      }
      res.end(`<!doctype html><title>${title}</title>
        <h1>Local research fixture<span hidden>HIDDEN_TEXT_SENTINEL</span></h1><p>An option costs $42, includes breakfast. ${route === '/details' ? 'Free cancellation is confirmed.' : ''}</p>
        <div hidden>HIDDEN_TEXT_SENTINEL</div><input type="password" value="PRIVATE_INPUT_SENTINEL">
        <textarea>PRIVATE_INPUT_SENTINEL</textarea><div contenteditable role="heading">EDITABLE_SENTINEL</div>
        ${route === '/unicode' ? `<p>${'あ'.repeat(12000)}😀</p><h2>${'b'.repeat(159)}😀</h2>` : ''}
        <a href="javascript:alert(1)">Unsafe</a>
        ${chain ? `<a href="/chain/${Number(chain[1]) + 1}">Next</a>` : '<a href="/details">Details</a><a href="/redirect">Redirect test</a><a href="/download">Download test</a>'}`);
    } catch (error) {
      fixtureError = error;
      res.writeHead(500); res.end('Fixture assertion failed');
    }
  });
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  const fixtureBase = `http://127.0.0.1:${fixture.address().port}`;
  const settings = path.join(temp, 'models.json');
  await fs.writeFile(settings, JSON.stringify({ provider: 'openAiCompatible', baseUrl: `${fixtureBase}/v1`, model: 'agent-fixture', apiVersion: '' }));
  const reservation = http.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const debugPort = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  let logs = '';
  try {
    child = spawn(path.join(root, 'target', 'debug', 'aibrowser.exe'),
      ['--graphics=software', `--remote-debugging-port=${debugPort}`, `--profile-dir=${path.join(temp, 'Profile')}`, `--url=${fixtureBase}/start`],
      { cwd: root, env: { ...process.env, AIB_MODEL_SETTINGS_FILE: settings, AIB_AGENT_TEST_SEARCH_URL: `${fixtureBase}/search` }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => { logs += chunk; });
    child.stderr.on('data', chunk => { logs += chunk; });
    await waitFor(() => {
      assert(child.exitCode === null, `Browser exited early:\n${logs}`);
      const plain = logs.replace(/\u001b\[[0-9;]*m/g, '');
      const uiMatch = plain.match(/UI server listening.*?port[=\s]+(\d+)/);
      const cdpMatch = plain.match(/ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser/);
      if (uiMatch && cdpMatch) { base = `http://127.0.0.1:${uiMatch[1]}`; nativePort = Number(cdpMatch[1]); return true; }
    }, 'browser servers');
    const chrome = await waitFor(async () => {
      const tabs = await (await fetch(`http://127.0.0.1:${nativePort}/json/list`)).json();
      return tabs.find(tab => tab.type === 'page' && tab.url.startsWith(base));
    }, 'trusted chrome');
    token = new URL(chrome.url).searchParams.get('token');
    assert(token, 'Missing trusted UI token');
    browserSocket = await connectCdp(chrome.webSocketDebuggerUrl);
    await waitFor(async () => {
      const result = await browserSocket.command('Runtime.evaluate', {
        expression: `location.origin === ${JSON.stringify(base)} && document.readyState === 'complete'`, returnByValue: true });
      return result.result?.value === true;
    }, 'trusted UI document ready');
    const wsUrl = `${base.replace('http:', 'ws:')}/ws?token=${token}`;
    const auth = await fetch(`${base}/api/agent`, { headers: { 'x-aib-token': token } });
    assert.equal(auth.status, 200, 'UI token must authorize native API');
    const connected = await browserSocket.command('Runtime.evaluate', {
      expression: `new Promise((resolve, reject) => {
        window.__agentTestDownloads = [];
        window.__agentTestConnection = new WebSocket(${JSON.stringify(wsUrl)});
        window.__agentTestConnection.onopen = () => resolve(true);
        window.__agentTestConnection.onerror = () => reject(new Error('IPC connection failed'));
        window.__agentTestConnection.onmessage = event => {
          const value = JSON.parse(event.data);
          if (value.type === 'download') window.__agentTestDownloads.push(value.download);
        };
      })`, awaitPromise: true, returnByValue: true,
    });
    assert(!connected.exceptionDetails, JSON.stringify(connected.exceptionDetails));
    const rpc = async (route, body, expected = 200, headers = {}) => {
      const response = await fetch(`${base}${route}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', 'x-aib-token': token, ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await response.json().catch(() => null);
      assert.equal(response.status, expected, JSON.stringify(data));
      return data;
    };
    const terminal = () => waitFor(async () => {
      const view = await rpc('/api/agent');
      return view && ['completed', 'failed', 'stopped', 'needsInput', 'noEvidence'].includes(view.status) && view;
    }, 'terminal task status', 40000);
    const pending = () => waitFor(async () => {
      const view = await rpc('/api/agent');
      if (view?.status === 'failed') throw new Error(view.error);
      return view?.pending && view;
    }, 'navigation proposal');
    const navigate = async (route = '/start') => {
      const destination = `${fixtureBase}${route}`;
      await browserSocket.command('Runtime.evaluate', { expression:
        `window.__agentTestConnection.send(${JSON.stringify(JSON.stringify({ type: 'navigate', input: destination }))})` });
      await delay(400);
      await waitFor(async () => {
        const tabs = await (await fetch(`http://127.0.0.1:${nativePort}/json/list`)).json();
        return tabs.find(tab => tab.url === destination);
      }, 'fixture navigation');
      await delay(200);
    };
    const start = (goal, startMode = 'currentPage') => rpc('/api/agent', { goal, sharePage: true, startMode });
    const approve = (view, allow = true) => rpc('/api/agent/approve', { taskId: view.id, approvalId: view.pending.id, allow });
    const replyTo = (view, message, expected = 200) => rpc('/api/agent/reply',
      { taskId: view.id, questionId: view.questionId, message }, expected);
    execFileSync('powershell', ['-NoProfile', '-File', path.join(root, 'scripts', 'test-window.ps1'), '-ProcessId', String(child.pid)], { stdio: 'inherit' });
    await rpc('/api/agent', undefined, 403, { 'x-aib-token': '' });
    await rpc('/api/agent', undefined, 403, { Origin: 'http://untrusted.test' });
    await rpc('/api/agent', { goal: 'test', sharePage: false }, 400);
    await navigate();
    await start('Verify the details');
    let view = await pending();
    assert.equal(view.sources.length, 1);
    assert.equal(hits.get('/details') || 0, 0, 'Navigated before approval');
    await rpc('/api/agent', { goal: 'duplicate task', sharePage: true }, 409);
    await rpc('/api/agent/approve', { taskId: view.id, approvalId: 'stale', allow: true }, 409);
    await approve(view);
    view = await terminal();
    assert.equal(view.status, 'completed', view.error);
    assert.equal(view.sources.length, 2);
    assert(view.answer.includes('$42'));
    console.log('PASS: structured observation -> approval -> verified navigation -> sourced answer');

    await navigate(); await start('Decline this navigation');
    view = await pending();
    const beforeDecline = hits.get('/details');
    await approve(view, false);
    assert.equal((await terminal()).status, 'stopped');
    await delay(400);
    assert.equal(hits.get('/details'), beforeDecline);
    console.log('PASS: declined navigation never executes');

    await navigate(); await start('Stop this task');
    view = await pending();
    await rpc('/api/agent/stop', { taskId: view.id });
    await rpc('/api/agent/approve', { taskId: view.id, approvalId: view.pending.id, allow: true }, 409);
    assert.equal((await terminal()).status, 'stopped');
    console.log('PASS: stop invalidates pending approval');

    await navigate(); const callsBefore = modelCalls;
    view = await start('slow response');
    await waitFor(() => modelCalls > callsBefore, 'slow model call');
    await rpc('/api/agent/stop', { taskId: view.id });
    await delay(2800);
    assert.equal((await rpc('/api/agent')).status, 'stopped');
    console.log('PASS: cancellation during model latency prevents later actions');

    await navigate(); await start('manual takeover');
    await pending(); await navigate('/details');
    assert.equal((await terminal()).status, 'stopped');
    console.log('PASS: manual navigation takes over and stops task');

    await navigate(); await start('reload takeover');
    await pending();
    await browserSocket.command('Runtime.evaluate', { expression:
      `window.__agentTestConnection.send(${JSON.stringify(JSON.stringify({ type: 'reload' }))})` });
    assert.equal((await terminal()).status, 'stopped');
    console.log('PASS: browser reload command takes over and stops task');

    await navigate(); await start('redirect test');
    view = await pending(); await approve(view);
    view = await terminal();
    assert.equal(view.status, 'failed');
    assert(view.error.includes('blocked'), view.error);
    assert.equal(hits.get('/landing') || 0, 0, 'Unapproved redirect reached destination');
    console.log('PASS: unapproved redirect blocked natively');

    await navigate(); await start('download test');
    view = await pending(); await approve(view);
    view = await terminal();
    assert.equal(view.status, 'failed');
    assert(view.error.toLowerCase().includes('download'), view.error);
    const downloadEvents = await browserSocket.command('Runtime.evaluate', { expression: 'window.__agentTestDownloads', returnByValue: true });
    for (const download of downloadEvents.result.value) {
      assert.notEqual(download.state, 'complete', 'Reader task completed a download');
      if (download.fullPath) {
        try { await fs.access(download.fullPath); assert.fail('Reader task wrote a download file'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    console.log('PASS: download blocked during reader task');

    await navigate(); await start('malformed decision');
    view = await terminal();
    assert.equal(view.status, 'failed');
    assert(view.error.includes('twice'));
    assert(view.protocolIssue.includes('unknown variant'), view.protocolIssue);
    console.log('PASS: unsupported model actions fail explicitly');

    await navigate(); await start('bad citation');
    view = await terminal();
    assert.equal(view.status, 'failed');
    assert(view.error.includes('twice'), view.error);
    console.log('PASS: unvisited inline citations rejected');

    await navigate('/unrelated');
    const searchesBefore = hits.get('/search') || 0;
    // Omit startMode to verify the API default as well as the UI default.
    await rpc('/api/agent', { goal: 'Find flights and hotels Austin to Cancun', sharePage: true });
    view = await terminal();
    assert.equal(view.status, 'needsInput', view.error);
    assert.equal(view.pagesRead, 0);
    assert.equal(view.answer, null);
    assert.equal(view.pending, null);
    assert(view.message.includes('dates'));
    assert.equal(hits.get('/search') || 0, searchesBefore);
    console.log('PASS: Austin-Cancun from Example Domain asks for dates/travelers, reads zero starting-page content, no fake result');
    await replyTo(view, '', 409);
    await rpc('/api/agent/reply', { taskId: view.id, questionId: 'stale', message: 'details' }, 409);
    const originalId = view.id;
    await replyTo(view, 'Nov 20 to Nov 27 2026 two travelers one room');
    await replyTo(view, 'duplicate details', 409);
    view = await pending();
    assert.equal(view.id, originalId);
    assert(view.pending.url.includes('Nov+20'), view.pending.url);
    assert.equal(view.conversation.length, 3);
    await approve(view, false);
    console.log('PASS: inline clarification keeps task ID and original goal, includes reply in search, rejects empty/stale/duplicate replies');

    await navigate(); await start('clarify evidence');
    view = await terminal();
    assert.equal(view.status, 'needsInput');
    await replyTo(view, 'Free cancellation');
    view = await terminal();
    assert.equal(view.status, 'completed', view.error);
    assert.equal(view.pagesRead, 1);
    assert.equal(view.sources.length, 1);
    console.log('PASS: clarification preserves observations without rereading or resetting the page budget');

    await navigate('/unrelated'); await start('Find flights Austin to Cancun', 'webSearch');
    view = await terminal();
    await rpc('/api/agent/stop', { taskId: view.id });
    await replyTo(view, 'Nov 20', 409);
    await navigate('/details');
    console.log('PASS: stop while waiting rejects late replies and releases the tab');

    await navigate(); await start('repeat questions');
    for (let question = 0; question < 5; question++) {
      view = await terminal();
      assert.equal(view.status, 'needsInput', view.error);
      await replyTo(view, `Detail ${question}`);
    }
    view = await terminal();
    assert.equal(view.status, 'failed');
    assert(view.error.includes('five-question limit'));
    console.log('PASS: repeated clarification questions are bounded');

    await navigate(); await start('fenced grouped citations');
    view = await terminal();
    assert.equal(view.status, 'completed', view.error);
    console.log('PASS: complete JSON fences and grouped citations accepted without inventing sources');

    await start('Search planning resources', 'webSearch');
    view = await pending();
    assert.equal(view.pending.kind, 'search');
    await approve(view, false);
    assert.equal((await terminal()).status, 'stopped');
    assert.equal(hits.get('/search') || 0, searchesBefore);
    console.log('PASS: declining a web search sends no query to the search site');

    await start('search travel Austin to Cancun Nov 20 to Nov 27 2026 two travelers one room', 'webSearch');
    view = await pending();
    assert.equal(view.pagesRead, 0);
    assert.equal(view.pending.kind, 'search');
    assert.equal(new URL(view.pending.url).searchParams.get('q'), view.goal);
    assert.equal(hits.get('/search') || 0, searchesBefore, 'Search executed before approval');
    await approve(view);
    view = await pending();
    assert.equal(view.pagesRead, 1);
    assert.equal(view.pending.kind, 'link');
    await approve(view);
    view = await terminal();
    assert.equal(view.status, 'completed', view.error);
    assert.equal(view.pagesRead, 2);
    assert.equal(view.sources.length, 1);
    assert.equal(view.sources[0].id, 2);
    assert(view.answer.includes('does not establish live availability'));
    console.log('PASS: approved search -> relevant link -> source IDs, no invented booking prices or unrelated page');

    await navigate(); await start('repair missing sources');
    const repairCalls = modelCalls;
    view = await terminal();
    assert.equal(view.status, 'completed', view.error);
    assert.equal(modelCalls - repairCalls, 2);
    assert(view.steps.some(step => step.includes('Requesting one correction')));
    console.log('PASS: missing source list corrected once against explicit observed source IDs');

    await navigate(); await start('slow repair missing sources');
    await waitFor(async () => {
      const state = await rpc('/api/agent');
      return state?.steps.some(step => step.includes('Requesting one correction'));
    }, 'citation repair began');
    view = await rpc('/api/agent');
    await rpc('/api/agent/stop', { taskId: view.id });
    await delay(2800);
    assert.equal((await rpc('/api/agent')).status, 'stopped');
    assert.equal((await rpc('/api/agent')).answer, null);
    console.log('PASS: stopping during correction cannot accept a later repaired answer');

    await navigate('/unrelated'); await start('repair no evidence');
    view = await terminal();
    assert.equal(view.status, 'noEvidence', view.error);
    assert.equal(view.answer, null);
    assert(view.message.includes('No live availability'));
    console.log('PASS: unsourced failure recovers to explicit no-evidence outcome, not success');

    await navigate('/unicode'); await start('finish here with Unicode');
    view = await terminal();
    assert.equal(view.status, 'completed', view.error);
    assert.equal(view.sources[0].title, 'a'.repeat(299));
    console.log('PASS: Unicode-safe bounded snapshots');

    await navigate('/chain/0'); await start('chain until limit');
    for (let i = 0; i < 5; i++) { view = await pending(); await approve(view); }
    view = await terminal();
    assert.equal(view.status, 'failed');
    assert(view.error.includes('six-page limit'), view.error);
    assert.equal(view.sources.length, 6);
    assert.equal(hits.get('/chain/6') || 0, 0);
    console.log('PASS: six-page bound enforced');
    const chat = await fetch(`${base}/api/chat/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-aib-token': token },
      body: JSON.stringify({ question: 'Summarize the page', pageText: 'Fixture page' }) });
    assert((await chat.text()).includes('mock page answer'));
    assert(!fixtureError, fixtureError?.stack);
    console.log('PASS: existing page Q&A preserved; no credentials disclosed to fixtures');

    await navigate();
    await browserSocket.command('Runtime.evaluate', { expression: "document.querySelector('.ask-ai').click()" });
    const assistantTarget = await waitFor(async () => {
      const targets = await (await fetch(`http://127.0.0.1:${nativePort}/json/list`)).json();
      return targets.find(target => target.url.startsWith(base) && target.url.includes('surface=assistant'));
    }, 'native assistant');
    const assistant = await connectCdp(assistantTarget.webSocketDebuggerUrl);
    try {
      await waitFor(async () => {
        const state = await assistant.command('Runtime.evaluate', { expression: '!!document.querySelector(".assistant-tabs")', returnByValue: true });
        return state.result?.value === true;
      }, 'assistant rendered');
      await assistant.command('Emulation.setDeviceMetricsOverride', { width: 320, height: 780, deviceScaleFactor: 1, mobile: false });
      await assistant.command('Runtime.evaluate', { expression:
        'Array.from(document.querySelectorAll(".assistant-tabs button")).find(button=>button.textContent==="Task mode").click()' });
      await waitFor(async () => {
        const state = await assistant.command('Runtime.evaluate', { expression:
          'Array.from(document.querySelectorAll(".task-run button")).some(button=>button.textContent==="Start a new task")', returnByValue: true });
        return state.result?.value === true;
      }, 'existing task restored without setup clutter');
      await assistant.command('Runtime.evaluate', { expression:
        'Array.from(document.querySelectorAll(".task-run button")).find(button=>button.textContent==="Start a new task").click()' });
      await waitFor(async () => {
        const state = await assistant.command('Runtime.evaluate', { expression: '!!document.querySelector("#task-goal") && !document.querySelector("#task-goal").disabled', returnByValue: true });
        return state.result?.value === true;
      }, 'task form ready');
      await assistant.command('Runtime.evaluate', { expression: 'document.querySelector("#task-goal").focus()' });
      const defaultStart = await assistant.command('Runtime.evaluate', { expression: 'document.querySelector("#task-start").value', returnByValue: true });
      assert.equal(defaultStart.result.value, 'webSearch');
      await assistant.command('Input.insertText', { text: 'Find flights and hotels Austin to Cancun' });
      await assistant.command('Runtime.evaluate', { expression: 'document.querySelector(".task-form input[type=checkbox]").click()' });
      await waitFor(async () => {
        const state = await assistant.command('Runtime.evaluate', { expression: '!document.querySelector(".task-form button").disabled', returnByValue: true });
        return state.result?.value === true;
      }, 'consented task submit');
      await assistant.command('Runtime.evaluate', { expression: 'document.querySelector(".task-form").requestSubmit()' });
      assert.equal((await terminal()).status, 'needsInput');
      await waitFor(async () => {
        const state = await assistant.command('Runtime.evaluate', { expression:
          'document.activeElement.id==="task-reply" && document.querySelector(".task-status").textContent==="More details needed"', returnByValue: true });
        return state.result?.value === true;
      }, 'missing travel details shown and focused');
      const uiTaskId = (await rpc('/api/agent')).id;
      await assistant.command('Input.insertText', { text: 'Nov 20 to Nov 27 2026 two travelers' });
      await assistant.command('Runtime.evaluate', { expression: 'document.querySelector(".task-reply").requestSubmit()' });
      view = await terminal();
      assert.equal(view.status, 'needsInput');
      assert.equal(view.id, uiTaskId);
      assert(view.message.includes('rooms'));
      await waitFor(async () => {
        const state = await assistant.command('Runtime.evaluate', { expression:
          'document.activeElement.id==="task-reply" && document.querySelectorAll(".task-message").length===4 && document.querySelector("#task-reply").value===""', returnByValue: true });
        return state.result?.value === true;
      }, 'second question focused with preserved conversation');
      await assistant.command('Input.insertText', { text: 'one room' });
      await assistant.command('Runtime.evaluate', { expression: 'document.querySelector(".task-reply").requestSubmit()' });
      view = await pending();
      assert.equal(view.id, uiTaskId);
      assert.equal(view.conversation.length, 5);
      assert.equal(view.pending.kind, 'search');
      assert.equal(view.pagesRead, 0);
      await waitFor(async () => {
        const state = await assistant.command('Runtime.evaluate', { expression: 'document.activeElement.getAttribute("aria-label")==="Navigation approval"', returnByValue: true });
        return state.result?.value === true;
      }, 'approval focus');
      await waitFor(async () => {
        const state = await assistant.command('Runtime.evaluate', { expression:
          'document.querySelector(".task-approval h3").getBoundingClientRect().top >= document.querySelector(".task-run-heading").getBoundingClientRect().bottom', returnByValue: true });
        return state.result?.value === true;
      }, 'approval title not obscured by sticky stop bar');
      const layout = await assistant.command('Runtime.evaluate', { expression: `(() => {
        const pane=document.querySelector('.task-mode'), stop=document.querySelector('.task-run-heading');
        const button=stop.querySelector('button'), bounds=button.getBoundingClientRect(), viewport=pane.getBoundingClientRect();
        const hit=document.elementFromPoint(bounds.x+bounds.width/2,bounds.y+bounds.height/2);
        return { noOverflow:pane.clientWidth===pane.scrollWidth, sticky:getComputedStyle(stop).position==='sticky',
          stopVisible:bounds.top>=viewport.top && bounds.bottom<=viewport.bottom && button.contains(hit) };
      })()`, returnByValue: true });
      assert.deepEqual(layout.result.value, { noOverflow: true, sticky: true, stopVisible: true });
      await assistant.command('Runtime.evaluate', { expression: 'document.querySelector(".task-approval .assistant-primary").click()' });
      view = await pending();
      assert.equal(view.pending.kind, 'link');
      await waitFor(async () => {
        const state = await assistant.command('Runtime.evaluate', { expression: 'document.querySelector(".task-approval h3")?.textContent==="Follow this link?"', returnByValue: true });
        return state.result?.value === true;
      }, 'observed-link approval');
      await assistant.command('Runtime.evaluate', { expression: 'document.querySelector(".task-approval .assistant-primary").click()' });
      assert.equal((await terminal()).status, 'completed');
      await waitFor(async () => {
        const state = await assistant.command('Runtime.evaluate', { expression:
          'document.activeElement.getAttribute("aria-label")==="Research brief" && document.querySelectorAll(".task-source").length===1', returnByValue: true });
        return state.result?.value === true;
      }, 'result focus and source cards');
      const dark = await assistant.command('Runtime.evaluate', { expression: `(() => {
        document.documentElement.dataset.theme='dark';
        const pane=document.querySelector('.task-mode');
        return pane.clientWidth===pane.scrollWidth;
      })()`, returnByValue: true });
      assert.equal(dark.result.value, true);
      console.log('PASS: native UI question -> inline reply -> same-task search/link -> brief, sticky stop, focus and 320px light/dark layout');
      await navigate(); await start('malformed decision');
      assert.equal((await terminal()).status, 'failed');
      await waitFor(async () => {
        const state = await assistant.command('Runtime.evaluate', { expression:
          'document.querySelector(".task-protocol")?.textContent.includes("unknown variant") && document.activeElement.getAttribute("aria-label")==="Task failure" && !document.querySelector(".task-activity").open && document.querySelector(".task-mode").clientWidth===document.querySelector(".task-mode").scrollWidth', returnByValue: true });
        return state.result?.value === true;
      }, 'specific failure diagnostic and compact activity layout');
      console.log('PASS: native UI failure shows specific protocol diagnostic, collapses activity and preserves narrow layout');
    } finally { assistant.close(); }
    if (process.argv.includes('--inspect')) {
      await navigate();
      await start('Verify the details for my research brief');
      await pending();
      console.log(`INSPECT_UI=${chrome.url}&surface=assistant`);
      console.log(`INSPECT_CDP_PORT=${nativePort}`);
      await Promise.race([delay(120000), once(child, 'exit')]);
    }
    // Close only the browser created by this test, via its CDP browser connection.
    if (child.exitCode === null) {
      const version = await (await fetch(`http://127.0.0.1:${nativePort}/json/version`)).json();
      cdpSocket = new WebSocket(version.webSocketDebuggerUrl);
      await once(cdpSocket, 'open');
      cdpSocket.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
      await waitFor(() => child.exitCode !== null, 'clean browser shutdown', 10000);
    }
  } catch (error) {
    console.error(logs.replace(/\u001b\[[0-9;]*m/g, ''));
    console.error(error);
    throw error;
  } finally {
    browserSocket?.close();
    cdpSocket?.close();
    if (child && child.exitCode === null) {
      const cleanup = spawn('powershell.exe', ['-NoProfile', '-Command',
        `$all=Get-CimInstance Win32_Process; $ids=[System.Collections.Generic.HashSet[int]]::new(); $null=$ids.Add(${child.pid}); do { $added=$false; foreach($p in $all) { if($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)) { $added=$true } } } while($added); foreach($id in $ids) { Stop-Process -Id $id -ErrorAction SilentlyContinue }`],
        { stdio: 'ignore' });
      await once(cleanup, 'exit');
    }
    fixture.closeAllConnections();
    await new Promise(resolve => fixture.close(resolve));
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
