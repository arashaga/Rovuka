(() => {
  const clip = (text, limit) => {
    let result = text.slice(0, limit);
    const last = result.charCodeAt(result.length - 1);
    if (last >= 0xD800 && last <= 0xDBFF) result = result.slice(0, -1);
    return result;
  };
  // aria-hidden is not used: modal dialogs set it on the still-visible page behind them
  // (Google Hotels hid every result this way). Rendering decides visibility.
  const visible = element => {
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' &&
      element.getClientRects().length > 0 && !element.closest('[hidden]');
  };
  const forbidden = 'script,style,noscript,input,textarea,select,[contenteditable]:not([contenteditable="false"])';
  const readText = (root, limit, budget) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let text = '', count = 0, truncated = false;
    while (walker.nextNode()) {
      if (++count > budget || text.length >= limit) { truncated = true; break; }
      const node = walker.currentNode, parent = node.parentElement;
      if (!parent || parent.closest(forbidden) || !visible(parent)) continue;
      const value = node.textContent.replace(/\s+/g, ' ').trim();
      if (value) text += value + '\n';
    }
    return { text: clip(text, limit), truncated: truncated || text.length > limit };
  };
  const content = readText(document.body || document.documentElement, 12000, 20000);
  let truncated = content.truncated;
  // Google Hotels shows only nightly rates on result cards; the stay total with taxes is in each
  // card's hover panel. Surface just those strictly patterned price facts, on Google travel pages
  // (and loopback test fixtures) only, so prices can be quoted and verified.
  const priceCards = [], seenCards = new Set();
  if (/^(www\.google\.com|127\.0\.0\.1)$/.test(location.hostname) && location.pathname.startsWith('/travel/')) {
    for (const anchor of document.querySelectorAll('a[aria-label^="Prices starting from"]')) {
      if (priceCards.length >= 30) break;
      const name = clip((anchor.getAttribute('aria-label') || '')
        .replace(/^Prices starting from \$[\d,.]+,\s*/, '').replace(/\s+/g, ' ').trim(), 120);
      const facts = {};
      const walker = document.createTreeWalker(anchor, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const value = walker.currentNode.textContent.replace(/\s+/g, ' ').trim();
        const price = value.match(/^(\$\d{1,3}(?:,\d{3})*(?:\.\d{2})?) (nightly|total)$/);
        if (price) facts[price[2]] ??= price[1];
        else if (/^\d{1,2} nights? with taxes \+ fees$/.test(value)) facts.stay ??= value;
      }
      if (!name || !facts.total || seenCards.has(`${name}|${facts.total}`)) continue;
      seenCards.add(`${name}|${facts.total}`);
      priceCards.push(`${name}: ${facts.nightly ? `${facts.nightly} nightly · ` : ''}${facts.total} total${facts.stay ? ` (${facts.stay})` : ''}`);
    }
  }
  const digest = priceCards.length
    ? `Google Hotels price cards for the searched dates and guests:\n${priceCards.join('\n')}\n\n` : '';
  const headings = Array.from(document.querySelectorAll('h1,h2,h3,[role="heading"]'))
    .filter(e => visible(e) && !e.closest(forbidden)).slice(0, 40)
    .map(e => readText(e, 160, 500).text.trim()).filter(Boolean);
  const links = [], seen = new Set();
  const here = new URL(location.href);
  here.hash = '';
  for (const anchor of document.querySelectorAll('a[href]')) {
    if (links.length >= 80) { truncated = true; break; }
    if (!visible(anchor) || anchor.hasAttribute('download') || anchor.closest(forbidden)) continue;
    const url = new URL(anchor.href, document.baseURI);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || seen.has(url.href)) continue;
    // "#section" links only scroll this page; reading them again wastes the page budget.
    const document_url = new URL(url.href);
    document_url.hash = '';
    if (document_url.href === here.href) continue;
    const name = clip((readText(anchor, 160, 500).text || anchor.getAttribute('aria-label') || '').trim(), 160);
    if (!name) continue;
    seen.add(url.href);
    links.push({ id: links.length + 1, name, url: url.href });
  }
  return { url: location.href, title: clip(document.title, 300),
    text: digest + content.text, headings, links, truncated };
})()
