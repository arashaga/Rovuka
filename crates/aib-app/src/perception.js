(() => {
  const clip = (text, limit) => {
    let result = text.slice(0, limit);
    const last = result.charCodeAt(result.length - 1);
    if (last >= 0xD800 && last <= 0xDBFF) result = result.slice(0, -1);
    return result;
  };
  const visible = element => {
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' &&
      element.getClientRects().length > 0 && !element.closest('[hidden],[aria-hidden="true"]');
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
  const headings = Array.from(document.querySelectorAll('h1,h2,h3,[role="heading"]'))
    .filter(e => visible(e) && !e.closest(forbidden)).slice(0, 40)
    .map(e => readText(e, 160, 500).text.trim()).filter(Boolean);
  const links = [], seen = new Set();
  for (const anchor of document.querySelectorAll('a[href]')) {
    if (links.length >= 80) { truncated = true; break; }
    if (!visible(anchor) || anchor.hasAttribute('download') || anchor.closest(forbidden)) continue;
    const url = new URL(anchor.href, document.baseURI);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || seen.has(url.href)) continue;
    const name = clip((readText(anchor, 160, 500).text || anchor.getAttribute('aria-label') || '').trim(), 160);
    if (!name) continue;
    seen.add(url.href);
    links.push({ id: links.length + 1, name, url: url.href });
  }
  return { url: location.href, title: clip(document.title, 300),
    text: content.text, headings, links, truncated };
})()
