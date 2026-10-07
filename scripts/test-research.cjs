const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

function createResearchFixtures({ base }) {
  let held = null;
  const state = { pending: false, feedback: [], progress: [], reads: [], redirects: [], requests: 0 };
  const choices = {
    products: ['Cedar Audio', 'Grove Audio'],
    courses: ['Sable Workshop', 'Birch Workshop'],
    software: ['Mica Library', 'Quartz Library'],
    unpriced: ['Cedar Audio', 'Grove Audio'],
    starting: ['Cedar Audio', 'Grove Audio'],
  };
  const kindOf = goal => Object.keys(choices).find(kind => goal.includes(` ${kind}`)) || 'products';
  const facts = (kind, index) => {
    const name = choices[kind][index];
    if (kind === 'courses') return `${name} includes a live tutor and project review.`;
    if (kind === 'software') return `${name} supports offline storage and versioned exports.`;
    if (kind === 'unpriced') return `${name} supports ExampleMeet. Its price is not published.`;
    if (kind === 'starting') return `${name} supports ExampleMeet. Prices start from $${index ? '149' : '119'}.00 USD; the exact variant price is unknown.`;
    return `${name} supports ExampleMeet. The reviewed USB variant costs $${index ? '149' : '119'}.00 USD for one headset.`;
  };
  const pageUrl = (kind, index) => `${base()}/quality/${kind}/${index ? 'b' : 'a'}`;
  const leadUrl = (kind, index) => index ? pageUrl(kind, index) : `${base()}/quality/goto/${kind}/a`;
  const html = (title, paragraphs, links) => `<!doctype html><meta charset="utf-8"><title>${title}</title><h1>${title}</h1>${
    paragraphs.map(text => `<p>${text}</p>`).join('')
  }${links.map(([url, name]) => `<p><a href="${url}">${name}</a></p>`).join('')}`;

  function serve(req, res, url) {
    const parts = url.pathname.split('/');
    const search = url.pathname === '/search' && url.searchParams.get('q')?.startsWith('quality ');
    if (!search && !url.pathname.startsWith('/quality/')) return false;
    if (parts[2] === 'goto') {
      res.writeHead(302, { location: pageUrl(parts[3], 0) });
      res.end();
      return true;
    }
    if (parts[2] === 'redirects') {
      const index = Number(parts[3]);
      state.redirects.push(index);
      const next = new URL(`${base()}/quality/redirects/${index + 1}`);
      next.hostname = index % 2 ? '127.0.0.1' : 'localhost';
      res.writeHead(302, { location: next.href });
      res.end();
      return true;
    }
    const kind = search ? kindOf(url.searchParams.get('q')) : parts[2];
    const names = choices[kind] || choices.products;
    const links = names.map((name, index) => [leadUrl(kind in choices ? kind : 'products', index), `Read ${name}`]);
    let title;
    let paragraphs;
    if (search || parts[3] === 'catalogue') {
      title = search ? 'Search discovery leads' : 'All available choices';
      paragraphs = names.map((_, index) => facts(kind, index));
    } else if (parts[2] === 'navigation') {
      title = 'Navigation only';
      paragraphs = ['This fixture intentionally has no accepted factual reader quotes.'];
    } else {
      const index = parts[3] === 'b' ? 1 : 0;
      title = names[index];
      paragraphs = [facts(kind, index)];
      state.reads.push(`${kind}/${parts[3]}`);
    }
    links.push([`${base()}/quality/${kind}/catalogue`, 'View all available choices']);
    if (search && url.searchParams.get('q').includes(' redirect-recovery')) {
      links.push([`${base()}/quality/redirects/0`, 'Candidate with bounded redirects']);
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html(title, paragraphs, links));
    return true;
  }

  function finish(input, kind, { searchOnly = false, shared = false, forged = false, single = false } = {}) {
    const sources = input.sources;
    const named = choices[kind];
    const options = named.slice(0, single ? 1 : 2).map((name, index) => {
      const direct = sources.find(source => source.url === pageUrl(kind, index));
      const source = searchOnly ? sources[0] : shared ? sources.at(-1) : direct;
      assert(source, 'Fixture needs a genuinely observed source');
      const lead = sources.find(source => source.kind === 'search');
      const leadLink = lead && input.pages[lead.id - 1].links.find(link => link.name === `Read ${name}`);
      const sourceIds = lead ? [lead.id, source.id].filter((id, position, ids) => ids.indexOf(id) === position) : [source.id];
      const proof = input.goal.includes(' quote-refs') && !searchOnly
        ? input.pages[source.id - 1].factualQuotes.find(quote => quote.quote.includes('supports ExampleMeet'))
        : null;
      return {
        name, fit: 'Matches the stated capability', details: facts(kind, index),
        tradeoffs: kind === 'unpriced' ? 'The provider does not publish a price.' : kind === 'starting'
          ? 'Only a starting price is published; the exact variant price is unknown.' : 'Review the exact version before choosing.',
        sources: sourceIds,
        evidence: [proof ? { sourceId: source.id, quoteId: proof.quoteId, quote: null }
          : { sourceId: source.id, quote: forged ? `${name} has an invented lifetime guarantee.` : facts(kind, index) }],
        destinations: [{
          sourceId: shared ? source.id : leadLink ? lead.id : source.id,
          linkId: shared ? null : leadLink?.id ?? null,
          label: shared ? 'View all available choices' : `View ${name}`,
        }],
        offer: kind === 'products' || kind === 'starting' ? {
          currency: 'USD', basis: 'itemTotal', scope: 'One headset, shipping and stock unchecked',
          exclusions: 'Shipping, tax, stock and live availability are unchecked.',
          components: [{ kind: 'product', name, detail: 'One reviewed USB headset', unitAmountMinor: index ? 14900 : 11900,
            quantity: 1, sourceId: source.id, quote: kind === 'starting' ? `$${index ? '149' : '119'}.00` : facts(kind, index) }],
        } : null,
      };
    });
    const cited = [...new Set(options.flatMap(option => option.sources))];
    const claims = [...new Set(options.flatMap(option => option.evidence.map(quote => quote.sourceId)))];
    return {
      action: 'finish', answer: `Options from the pages actually read ${claims.map(id => `[${id}]`).join(' ')}.`, sources: cited,
      report: {
        intent: kind === 'products' || kind === 'unpriced' || kind === 'starting' ? 'shopping' : 'general',
        title: 'Reviewed choices', summary: 'Review the exact variant and supporting evidence.',
        recommendedOption: 0, options, findings: [],
        gaps: kind === 'unpriced' ? ['Prices are not published, so no cheapest option is claimed.'] : ['Suitability is a model judgement, not an independent certification.'],
      },
    };
  }

  async function decide(input) {
    if (!input.userGoal?.startsWith('quality ')) return null;
    input = {
      ...input, goal: input.userGoal, pages: input.visitedPages,
      sources: input.visitedPages.map(page => ({ id: page.sourceId, url: page.url, title: page.title, kind: page.sourceKind })),
    };
    state.requests++;
    const kind = kindOf(input.goal);
    state.progress.push(input.researchProgress);
    if (input.researchFeedback) state.feedback.push(input.researchFeedback);
    if (input.goal.includes(' empty')) {
      if (input.sources.length === 1) {
        assert.deepEqual(input.researchProgress.sourcesWithoutFacts, [1]);
        const link = input.researchProgress.availableLinks.find(link => link.name === 'Read Cedar Audio');
        assert(link);
        return { action: 'followLink', sourceId: link.sourceId, linkId: link.linkId, reason: 'Read a factual candidate after the empty reader page' };
      }
      return finish(input, 'products', { single: true });
    }
    if (!input.sources.length) return { action: 'search', query: input.goal, reason: 'Discover general candidate leads' };
    if (input.goal.includes(' budget')) {
      if (input.sources.length < 6) return { action: 'search', query: `${input.goal} ${input.sources.length}`, reason: 'Read another discovery source' };
      if (!input.researchFeedback) return finish(input, kind, { searchOnly: true });
      return {
        action: 'finish', answer: 'The six-source limit was reached without specific candidate verification [6].', sources: [6],
        report: {
          intent: 'research', title: 'Limited discovery brief', summary: 'No verified recommendation is available.',
          recommendedOption: null, options: [], findings: [{ title: 'Discovery only', detail: facts(kind, 0), sources: [6] }],
          gaps: ['Six sources are discovery leads. Read specific candidate pages manually before choosing.'],
        },
      };
    }
    if (input.goal.includes(' foreign')) return {
      action: 'followLink', sourceId: 6, linkId: 1, reason: 'This unobserved source must be refused',
    };
    if (input.goal.includes(' catalogue')) {
      if (input.sources.length === 1) {
        const link = input.researchProgress.availableLinks.find(link => link.name === 'View all available choices');
        return { action: 'followLink', sourceId: link.sourceId, linkId: link.linkId, reason: 'Inspect the catalogue' };
      }
      return finish(input, kind, { shared: true });
    }
    if (input.goal.includes(' wrong-links') && input.sources.length >= 3) {
      if (input.sources.length < 6) return {
        action: 'search', query: `${input.goal} ${input.sources.length}`, reason: 'Exercise destination correction with no remaining reads',
      };
      const decision = finish(input, kind);
      decision.report.options.forEach(option => {
        const sourceId = option.evidence[0].sourceId;
        const link = input.pages[sourceId - 1].links.find(link => link.name === 'View all available choices');
        option.destinations = [{ sourceId, linkId: input.researchFeedback ? null : link.id, label: 'View candidate page' }];
      });
      return decision;
    }
    if (input.goal.includes(' redirect-recovery') && input.sources.length >= 3) {
      if (!input.researchProgress.unavailableRoutes.length) {
        const link = input.researchProgress.availableLinks.find(link => link.name === 'Candidate with bounded redirects');
        assert(link);
        return { action: 'followLink', sourceId: link.sourceId, linkId: link.linkId, reason: 'Exercise one unavailable candidate without losing prior evidence' };
      }
      assert(!input.researchProgress.availableLinks.some(link => link.name === 'Candidate with bounded redirects'));
      const decision = finish(input, kind);
      decision.report.gaps.push('Another candidate exceeded the native redirect limit and its content was not read.');
      return decision;
    }
    if (input.goal.includes(' unchecked')) return finish(input, kind, { searchOnly: true });
    if (input.sources.length === 1 && !input.researchFeedback && !input.goal.includes(' wrong-links') && !input.goal.includes(' redirect-recovery')) return finish(input, kind, { searchOnly: true });
    if (input.sources.length === 1 && (input.goal.includes(' revoke') || input.goal.includes(' stop'))) {
      state.pending = true;
      await new Promise(resolve => { held = resolve; });
      state.pending = false;
    }
    if (input.sources.length < 3) {
      const index = input.sources.length - 1;
      const link = input.researchProgress.availableLinks.find(link => link.name === `Read ${choices[kind][index]}`);
      assert(link, 'Earlier-source lead must remain available after reading another page');
      return { action: 'followLink', sourceId: link.sourceId, linkId: link.linkId, reason: 'Read the distinct candidate page' };
    }
    return finish(input, kind, { forged: input.goal.includes(' forged') });
  }

  function reader(input) {
    return input.goal?.startsWith('quality ') && input.untrustedPage.title === 'Navigation only' ? { quotes: [] } : null;
  }

  return {
    serve, decide, reader, state, pageUrl,
    release() { const resolve = held; held = null; resolve?.(); },
    clear() {
      assert(!held, 'Release held test requests before clearing fixtures');
      state.pending = false;
      state.feedback = [];
      state.progress = [];
      state.reads = [];
      state.redirects = [];
      state.requests = 0;
    },
  };
}

async function researchChecks({ rpc, navigate, waitFor, approve, send, tabSnapshot, connect, openResultTab, reopenFindings, trustedClick, fixtures }) {
  const task = () => rpc('/api/agent');
  const check = message => console.log(`PASS: ${message}`);
  const until = (probe, timeout, label) => waitFor(probe, label, timeout);
  let pane;
  const ui = async expression => {
    const value = await pane.command('Runtime.evaluate', { expression, returnByValue: true });
    assert(!value.exceptionDetails, JSON.stringify(value.exceptionDetails));
    return value.result?.value;
  };
  async function begin(goal, current = false, compareOptions = true) {
    fixtures.clear();
    await navigate(current ? '/quality/navigation' : '/unrelated');
    return rpc('/api/agent', {
      goal, sharePage: true, compareOptions, startMode: current ? 'currentPage' : 'webSearch', mode: 'research',
    });
  }
  async function settle(view, all = true) {
    const end = Date.now() + 60000;
    while (Date.now() < end) {
      view = await task();
      if (view.pending) {
        await approve(view, true, all);
      } else if (view.status !== 'running') return view;
      await delay(30);
    }
    assert.fail('Research quality fixture did not settle');
  }
  const baseline = await tabSnapshot();
  const originalIds = baseline.tabs.map(tab => tab.id);
  const frontier = await settle(await begin('quality products frontier'));
  assert.equal(frontier.status, 'completed', frontier.error);
  assert.equal(frontier.pagesRead, 3);
  assert.equal(frontier.searches.length, 1);
  assert.equal(fixtures.state.feedback.length, 1, 'The repaired completion must retain one bounded review feedback round');
  assert(fixtures.state.feedback.every(feedback => feedback.issues.length > 0 && feedback.issues.length <= 8));
  const report = frontier.report;
  assert.equal(report.options.length, 2);
  report.options.forEach((option, index) => {
    assert.equal(option.evidence[0].sourceId, index + 2);
    assert.equal(option.links[0].url, fixtures.pageUrl('products', index));
    assert.equal(option.links[0].sourceId, 1, 'Link IDs retain the original observed source scope');
    assert.equal(option.links[0].visited, true);
    assert(option.evidence[0].quote.includes(option.name));
    assert.equal(option.offer.totalMinor, index ? 14900 : 11900);
  });
  assert.equal(new Set(report.options.map(option => option.links[0].url)).size, 2);
  const tabs = await tabSnapshot();
  assert(originalIds.every(id => tabs.tabs.some(tab => tab.id === id)), 'Ordinary source tabs must remain available');
  check('research quality rejects discovery-only completion, reuses earlier-source leads, and resolves a native redirect to two specific pages');

  await send({ type: 'openAssistant', panel: 'chat' });
  pane = await until(() => connect('assistant'), 10000, 'research assistant connection');
  await until(() => ui('!!document.querySelector(".assistant-tabs")'), 10000, 'research workspaces ready');
  const taskTab = '.assistant-primary-tabs button:nth-of-type(2)';
  assert.equal(await ui(`document.querySelector(${JSON.stringify(taskTab)})?.textContent`), 'Task mode');
  await trustedClick(pane, taskTab);
  await until(() => ui('document.querySelectorAll(".findings-option").length === 2'), 10000, 'verified options workspace');
  await trustedClick(pane, '.option-details summary');
  assert.equal(await ui('document.querySelectorAll(".option-evidence-quotes p").length'), 2);
  assert((await ui('document.querySelector(".option-evidence-quotes").textContent')).includes('Observed on source [2]'));
  if (process.env.AIB_TEST_RESEARCH_SCREENSHOT) {
    assert(path.isAbsolute(process.env.AIB_TEST_RESEARCH_SCREENSHOT));
    const capture = await pane.command('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(process.env.AIB_TEST_RESEARCH_SCREENSHOT, Buffer.from(capture.data, 'base64'));
  }
  const models = fixtures.state.requests;
  const opened = await openResultTab(pane, 'document.querySelector(".option-open").click()', fixtures.pageUrl('products', 0));
  assert.equal((await tabSnapshot()).tabs.length, tabs.tabs.length + 1);
  await reopenFindings(pane, frontier);
  assert.equal(fixtures.state.requests, models);
  await send({ type: 'closeTab', tabId: opened });
  await until(async () => !(await tabSnapshot()).tabs.some(tab => tab.id === opened), 10000, 'result tab closes');
  check('research quote details and actual option links are retained without new model calls and open a new foreground tab');
  for (const theme of ['light', 'dark']) {
    await pane.command('Emulation.setDeviceMetricsOverride', { width: 320, height: 960, deviceScaleFactor: 1, mobile: false });
    await ui(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
    assert.equal(await ui('document.documentElement.scrollWidth <= innerWidth && Array.from(document.querySelectorAll(".option-evidence-quotes")).every(node => node.scrollWidth <= node.clientWidth)'), true);
  }
  await pane.command('Emulation.clearDeviceMetricsOverride');
  check('research source quotes and specific result controls fit both 320px themes without widening the findings workspace');

  for (const kind of ['courses', 'software', 'unpriced', 'starting']) {
    const result = await settle(await begin(`quality ${kind} frontier`));
    assert.equal(result.status, 'completed', result.error);
    assert.equal(result.report.options.length, 2);
    assert(result.report.options.every(option => option.evidence.length && option.links[0].visited));
    const sourceIds = result.report.options.map(option => option.evidence[0].sourceId);
    assert.deepEqual(sourceIds, [2, 3]);
    if (kind === 'unpriced' || kind === 'starting') {
      assert(result.report.options.every(option => !option.offer));
      if (kind === 'unpriced') {
        assert(result.report.options.every(option => option.tradeoffs.includes('does not publish')));
        assert(result.report.gaps.some(gap => gap.includes('no cheapest')));
      } else {
        assert(result.report.options.every(option => option.tradeoffs.includes('exact variant price is unknown')));
        assert(result.steps.some(step => step.includes('starting/from')));
      }
    } else {
      await until(() => ui('document.querySelector(".findings-section-heading")?.textContent.includes("Ordered by fit")'), 10000, 'non-shopping option heading');
      assert(!(await ui('document.querySelector("[aria-label=\\"Options comparison\\"]").textContent')).includes('Prices unavailable'));
    }
  }
  const corrected = await settle(await begin('quality products wrong-links'));
  assert.equal(corrected.status, 'completed', corrected.error);
  assert.equal(corrected.pagesRead, 6);
  assert.equal(fixtures.state.feedback.length, 0, 'Known candidate destinations should normalize without another model round');
  assert(corrected.steps.filter(step => step.includes('used the source-checked candidate page already read')).length === 2);
  assert(corrected.report.options.every(option => option.links[0].sourceId === option.evidence[0].sourceId && option.links[0].visited));
  const references = await settle(await begin('quality products quote-refs'));
  assert.equal(references.status, 'completed', references.error);
  assert.equal(references.report.options.length, 2);
  assert(references.report.options.every(option => option.evidence.some(proof => proof.quote.includes('supports ExampleMeet'))
    && option.evidence.every(proof => !('quoteId' in proof))));
  assert(references.steps.some(step => step.includes('source-assigned quote references')));
  const recovered = await settle(await begin('quality products redirect-recovery'));
  assert.equal(recovered.status, 'completed', recovered.error);
  assert.equal(recovered.pagesRead, 3, 'Unavailable navigation must not create factual sources or repeat prior reads');
  assert.equal(recovered.report.options.length, 2);
  assert(recovered.report.options.every(option => option.evidence[0].sourceId === option.links[0].sourceId || option.links[0].sourceId === 1));
  assert(recovered.sources.every(source => !source.url.includes('/quality/redirects/')));
  assert(recovered.steps.some(step => step.includes('three-cross-site-redirect limit') && step.includes('no permission or page budget was expanded')));
  assert(recovered.report.gaps.some(gap => gap.includes('content was not read')));
  assert.deepEqual(fixtures.state.redirects, [0, 1, 2, 3], 'The fourth cross-site destination must never load');
  const unavailable = fixtures.state.progress.at(-1).unavailableRoutes;
  assert.equal(unavailable.length, 1);
  assert.equal(unavailable[0].targets.length, 5);
  check('research evidence review handles courses, technical libraries, and explicit unavailable prices without product-specific routing');

  for (const [label, compareOptions] of [['unchecked', true], ['catalogue', true], ['forged', true], ['forged', false]]) {
    const result = await settle(await begin(`quality products ${label}`, false, compareOptions));
    assert.equal(result.status, 'noEvidence', result.error);
    assert.equal(result.report, null);
    assert.equal(result.answer, null);
    assert.equal(fixtures.state.feedback.at(-1).attempt, 2);
    assert.equal(fixtures.state.feedback.at(-1).remainingReviews, 0);
    assert(result.sources.length > 0);
    assert(fixtures.state.feedback.flatMap(feedback => feedback.issues).some(issue =>
      label === 'unchecked' ? issue.includes('directly read') : label === 'catalogue' ? issue.includes('specific observed') : issue.includes('failed native source checks')));
  }
  check('research refuses search-only rankings, shared generic catalogue buttons, and fabricated quotes in options/brief modes with bounded review and retained sources');

  const limited = await settle(await begin('quality products budget'));
  assert.equal(limited.status, 'completed', limited.error);
  assert.equal(limited.pagesRead, 6);
  assert.equal(limited.report.options.length, 0);
  assert.equal(limited.report.recommendedOption, null);
  assert(limited.report.gaps[0].includes('discovery leads'));
  assert.equal(fixtures.state.progress.at(-1).remainingPages, 0);
  check('research page exhaustion returns an honest sourced limited brief without inventing a verified winner');

  const empty = await settle(await begin('quality products empty', true));
  assert.equal(empty.status, 'completed', empty.error);
  assert.equal(empty.pagesRead, 2);
  assert.deepEqual(empty.report.options[0].sources, [2]);
  assert(!empty.answer.includes('[1]'));
  assert(empty.steps.some(step => step.includes('no factual quotes')));
  assert.equal(empty.modelUsage.readerRequests, 2);
  assert.equal(empty.modelUsage.repairs, 0);
  check('research valid-empty reader output keeps only observed navigation leads, counts the page, and never cites it as factual evidence');

  const foreign = await settle(await begin('quality products foreign'));
  assert.equal(foreign.status, 'failed');
  assert.equal(foreign.pagesRead, 1);
  assert.equal(fixtures.state.reads.length, 0);
  assert.match(foreign.protocolIssue, /sourceId.*not observed/);
  check('research earlier-source IDs cannot refer to unobserved pages or bypass the native observed-link scope');

  for (const action of ['revoke', 'stop']) {
    let view = await begin(`quality products ${action}`);
    view = await until(async () => {
      const current = await task();
      return current.pending ? current : null;
    }, 10000, 'research initial search approval');
    await approve(view, true, true);
    await until(async () => fixtures.state.pending, 10000, 'held evidence-feedback actor');
    const waiting = await task();
    assert.equal(waiting.report, null);
    assert.equal(waiting.answer, null);
    assert.equal(waiting.pagesRead, 1);
    if (action === 'revoke') {
      await rpc('/api/agent/revoke-research', { taskId: waiting.id });
      fixtures.release();
      const pending = await until(async () => {
        const current = await task();
        return current.pending ? current : null;
      }, 10000, 'fresh earlier-source link approval after revoke');
      assert.equal(pending.taskPermission, 'askEach');
      assert.equal(fixtures.state.reads.length, 0);
    }
    await rpc('/api/agent/stop', { taskId: waiting.id });
    fixtures.release();
    await delay(300);
    const stopped = await task();
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.report, null);
    assert.equal(stopped.answer, null);
    assert.equal(stopped.pagesRead, 1);
    assert.equal(stopped.taskPermission, 'askEach');
    assert.equal(fixtures.state.reads.length, 0);
  }
  check('research feedback and earlier-source navigation respect revoke, Stop, retired task grants, and no late result publication');
  assert((await tabSnapshot()).tabs.length > 0, 'Research checks must leave the native browser connected');
  pane.close();
}

module.exports = { createResearchFixtures, researchChecks };
