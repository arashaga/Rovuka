(request => {
  const visible = element => {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return element.isConnected && box.width > 0 && box.height > 0
      && style.display !== 'none' && style.visibility !== 'hidden'
      && !element.closest('[inert], [aria-hidden="true"]');
  };
  const text = value => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  const labelText = label => {
    const copy = label.cloneNode(true);
    copy.querySelectorAll('input,select,textarea,button').forEach(control => control.remove());
    return copy.textContent;
  };
  const name = element => text(element.getAttribute('aria-label')
    || (element.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
      .map(id => document.getElementById(id)?.textContent || '').join(' ')
    || Array.from(element.labels || []).map(labelText).join(' ')
    || element.textContent || element.getAttribute('placeholder') || element.getAttribute('title'));
  const sensitive = /password|passcode|token|secret|session|csrf|otp|one.time|card|credit|payment|passport|social.security|email|phone|address|given.name|family.name|username|account|upload|checkout|purchase|buy.now|book.now|reserve|confirm.booking|send|delete|unsubscribe|sign.?in|log.?in|sign.?out|log.?out/i;
  const searchName = /search|find|check.?in|check.?out|arrival|depart|destination|origin|location|guest|adult|child|room|night|date|filter|query|city|place|budget/i;
  const widget = /^(?:open|show|choose|select|change|close|next|previous|more|less|increase|decrease|add|subtract)\b.*(?:calendar|date|month|guest|adult|child|room|filter|option)|^(?:next|previous) month$/i;
  const hotelForm = request.hotelSite ? Array.from(document.forms).find(form => {
    const action = new URL(form.action, location.href);
    return form.method.toLowerCase() === 'get' && action.origin === location.origin
      && action.pathname === '/Hotel-Search' && !action.search && !action.hash
      && form.id === 'lodging_search_form' && form.querySelector('input[name="destination_form_field"]')
      && Array.from(form.querySelectorAll('button[type="submit"]')).some(button => name(button) === 'Search');
  }) : undefined;
  const hotelSourceInput = hotelForm?.querySelector('input[name="destination_form_field"]');
  const hotelTrigger = hotelForm?.querySelector('button[type="button"][data-stid="destination_form_field-dialog-trigger"]');
  const destinationDialog = hotelTrigger && Array.from(document.querySelectorAll('[role="dialog"]'))
    .find(dialog => visible(dialog)
      && dialog.querySelector('input[id="destination_form_field"][data-stid="destination_form_field-dialog-input"]'));
  const hotelInput = destinationDialog?.querySelector('input[data-stid="destination_form_field-dialog-input"]') || hotelSourceInput;
  const hotelState = () => {
    const value = part => String(hotelForm?.querySelector(
      `input[type="hidden"][name="EGDSSearchFormLocationField-${part}-destination_form_field"]`)?.value || '');
    const query = String(hotelInput?.value || '');
    const destination = value('Location'), regionId = value('RegionId');
    return { action: hotelForm?.action || '', query, destination, regionId,
      selected: !!regionId && query === destination };
  };
  const hotelControl = element => !!hotelForm && (element === hotelForm || element === hotelInput
    || element === hotelSourceInput || element === hotelTrigger
    || element.getAttribute('data-stid') === 'destination_form_field-result-item-button'
      && (element.closest('form') === hotelForm || destinationDialog?.contains(element)));
  const hotelSearch = () => ({ id: 0, label: 'Hotels.com public hotel search', kind: 'hotelSearch',
    inputType: '', blocked: hotelForm ? null : 'The verified public GET hotel form is no longer available.',
    destination: hotelForm?.action || null, choices: [], fields: [],
    query: null, primary: null });
  let state = globalThis.__rovukaOperator;
  if (!state || state.document !== document || state.lease !== request.lease) {
    state?.observer.disconnect();
    state?.listeners.abort();
    state = { document, lease: request.lease, revision: 0, nodes: new Map(), manual: false,
      listeners: new AbortController() };
    state.observer = new MutationObserver(records => { if (records.length) state.revision++; });
    state.observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    for (const event of ['pointerdown', 'keydown', 'wheel']) {
      document.addEventListener(event, e => {
        if (e.isTrusted && !state.manual) {
          state.manual = true;
          state.manualEvent = e.type;
        }
      },
        { capture: true, passive: true, signal: state.listeners.signal });
    }
    globalThis.__rovukaOperator = state;
  }
  if (state.observer.takeRecords().length) state.revision++;
  const fail = (code, message, detail) => ({ ok: false, code, message, detail });
  if (state.manual) return { ...fail('takeover', 'You interacted with the webpage. Preparation stopped; you have control.'),
    eventType: state.manualEvent };

  const describe = element => {
    const label = name(element);
    const tag = element.tagName.toLowerCase();
    const type = String(element.type || '').toLowerCase();
    const form = element.form;
    const hint = `${label} ${element.id} ${element.getAttribute('name') || ''} ${element.getAttribute('autocomplete') || ''}`;
    const privacyHint = element === hotelInput || element === hotelSourceInput || element === hotelTrigger
      ? hint.replace(/City,\s*hotel name,\s*or address/ig, 'Hotel destination')
      : tag === 'input' && type === 'date'
        ? hint.replace(/check[-_\s]?out(?:date)?/ig, 'departure-date') : hint;
    const data = { id: 0, label, kind: 'unsupported', inputType: type, blocked: null,
      destination: null, choices: [], fields: [], query: null, primary: null };
    const disabled = element.disabled || element.getAttribute('aria-disabled') === 'true'
      || element.readOnly || element.closest('fieldset:disabled');
    if (disabled) data.blocked = 'This control is disabled or read-only.';
    else if (!label) data.blocked = 'This control has no accessible label.';
    else if (sensitive.test(privacyHint)) data.blocked = 'Sensitive or transactional controls require manual use.';
    const searchField = element === hotelInput || searchName.test(hint) || form?.getAttribute('role') === 'search'
      || /(?:^|\/)search(?:\/|$)/i.test(new URL(form?.action || location.href, location.href).pathname);
    if (tag === 'a') {
      data.kind = 'link';
      data.destination = element.href;
      if (element.hasAttribute('download')) data.blocked = 'Downloads require manual use.';
    } else if (tag === 'input' && type !== 'submit') {
      data.kind = 'field';
      if (!['text', 'search', 'date', 'number', 'time', 'month'].includes(type) || !searchField)
        data.blocked = 'Only labeled public search/date/guest/filter fields can be prepared.';
    } else if (tag === 'select') {
      data.kind = 'select';
      data.choices = Array.from(element.options).slice(0, 50).map((option, index) => ({
        id: index, label: text(option.label), value: option.value,
        disabled: option.disabled || !!option.closest('optgroup:disabled'),
      }));
      if (element.multiple || !searchField) data.blocked = 'Only single-choice public search filters are supported.';
    } else if (tag === 'summary') {
      data.kind = 'button';
    } else if (tag === 'button' || tag === 'input' && type === 'submit') {
      data.kind = 'button';
      if (element === hotelTrigger) {
        data.kind = 'button';
      } else if (hotelControl(element) && element.getAttribute('data-stid') === 'destination_form_field-result-item-button'
        && type === 'button') {
        data.kind = 'choice';
        data.query = String(hotelInput.value || '');
        data.primary = text(element.parentElement.querySelector('.uitk-type-bold')?.textContent);
        if (!data.primary || !data.query) data.blocked = 'The destination suggestion has no verifiable search context.';
      } else if (hotelForm && form === hotelForm && type === 'submit') {
        data.blocked = 'Use the reviewed Hotels.com hotelSearch handoff; raw internal form fields are not submitted.';
      } else if (type === 'submit' && form) {
        data.kind = 'search';
        const method = element.getAttribute('formmethod') || form.method;
        const destination = new URL(element.getAttribute('formaction') || form.action, location.href);
        if (method.toLowerCase() !== 'get' || !/(?:search|find|check availability|show results|compare)/i.test(label)
          || !(form.getAttribute('role') === 'search' || /(?:^|\/)(?:search|results)(?:\/|$)/i.test(destination.pathname))) {
          data.blocked = 'Only an explicitly reviewed public GET search can be opened. Other submissions require manual use.';
        }
        for (const field of Array.from(form.elements)) {
          if (!field.name || field.disabled || field === element || ['submit', 'button', 'reset'].includes(field.type)) continue;
          if (field.closest('fieldset:disabled')) continue;
          if (['checkbox', 'radio'].includes(field.type) && !field.checked) continue;
          const fieldHint = `${field.name} ${field.type} ${field.autocomplete || ''}`;
          const privateFieldHint = field.type === 'date'
            ? fieldHint.replace(/check[-_\s]?out(?:date)?/ig, 'departure-date') : fieldHint;
          if (field.tagName === 'SELECT' && field.multiple || field.type === 'file'
            || sensitive.test(privateFieldHint)) {
            data.blocked = 'The search form contains unsupported or sensitive fields; use it manually.';
            continue;
          }
          const value = String(field.value || '');
          data.fields.push({ name: field.name, value });
          destination.searchParams.append(field.name, value);
        }
        if (element.name) {
          data.fields.push({ name: element.name, value: element.value });
          destination.searchParams.append(element.name, element.value);
        }
        data.destination = destination.href;
        if (data.fields.length > 20) data.blocked = 'The search form has too many fields to review safely.';
      } else if (type !== 'button' || !widget.test(label)) {
        data.blocked = 'Only public search widgets and disclosure controls can be clicked. Use other buttons manually.';
      }
    }
    if (data.kind === 'unsupported') data.blocked = 'This control is not supported by preparation mode.';
    return data;
  };
  const fingerprint = (element, virtual = false) => JSON.stringify({
    data: virtual ? hotelSearch() : describe(element),
    value: ['INPUT', 'SELECT', 'TEXTAREA'].includes(element.tagName) ? element.value : null,
    hotel: hotelControl(element) ? hotelState() : null,
  });
  if (request.mode === 'inspect') {
    state.snapshot = request.snapshotId;
    state.nodes.clear();
    const controls = [];
    const selector = 'a[href], input:not([type=hidden]), select, button, summary';
    const candidates = new Set([...(destinationDialog?.querySelectorAll(selector) || []),
      ...(hotelForm?.querySelectorAll(selector) || []), ...document.querySelectorAll(selector)]);
    for (const element of candidates) {
      if (!visible(element)) continue;
      const data = describe(element);
      data.id = controls.length + 1;
      controls.push(data);
      state.nodes.set(data.id, { element, fingerprint: fingerprint(element), hotel: hotelControl(element),
        form: hotelForm, dialog: destinationDialog });
      if (controls.length === (hotelForm ? 79 : 80)) break;
    }
    let hotel = null;
    if (hotelForm) {
      const data = hotelSearch();
      data.id = controls.length + 1;
      controls.push(data);
      state.nodes.set(data.id, { element: hotelForm, fingerprint: fingerprint(hotelForm, true), hotel: true, virtual: true,
        form: hotelForm, dialog: destinationDialog });
      hotel = { ...hotelState(), searchId: data.id,
        inputId: controls.find(control => !control.blocked && state.nodes.get(control.id).element === hotelInput)?.id || null,
        openId: controls.find(control => !control.blocked && state.nodes.get(control.id).element === hotelTrigger)?.id || null };
    }
    const display = selector => {
      const element = hotelForm?.querySelector(selector);
      const label = element?.getAttribute('aria-label') || '';
      return text(/\d/.test(label) ? label : element?.textContent || label);
    };
    const hotelResult = hotelForm && location.pathname === '/Hotel-Search' ? {
      dates: display('[data-stid="uitk-date-selector-input1-default"]'),
      party: display('[data-stid="open-room-picker"]'),
    } : null;
    return { ok: true, snapshotId: state.snapshot, url: location.href, revision: state.revision, controls, hotelSearch: hotel, hotelResult };
  }
  if (state.snapshot !== request.snapshotId || location.href !== request.url)
    return fail('stale', 'The page changed after it was observed. The old approval cannot be reused.', 'documentChanged');
  const action = request.operation;
  if (action.kind === 'scroll') {
    if (state.revision !== request.revision) return fail('stale', 'The page changed before the scroll was approved.', 'domChanged');
    scrollBy({ top: action.direction === 'down' ? 600 : -600, behavior: 'instant' });
    return { ok: true, navigation: null };
  }
  const target = state.nodes.get(action.targetId);
  const rendered = element => element.isConnected && element.getBoundingClientRect().width > 0
    && element.getBoundingClientRect().height > 0 && getComputedStyle(element).display !== 'none';
  // Known hotel controls revalidate their full form state; unrelated ads need not invalidate them.
  const changed = !target ? 'controlMissing'
    : target.hotel && target.form !== hotelForm ? 'hotelFormChanged'
    : target.hotel && target.dialog !== destinationDialog ? 'hotelDialogChanged'
    : !(target.virtual ? rendered(target.element) : visible(target.element)) ? 'controlNotVisible'
    : fingerprint(target.element, target.virtual) !== target.fingerprint ? 'controlStateChanged'
    : !target.hotel && state.revision !== request.revision ? 'domChanged' : null;
  if (changed)
    return fail('stale', 'The exact control or its value changed. A new observation and approval are required.', changed);
  const element = target.element;
  const data = target.virtual ? hotelSearch() : describe(element);
  if (data.blocked) return fail('blocked', data.blocked);
  if (action.kind === 'hotelSearch' && target.virtual && action.hotel && hotelState().selected) {
    const current = hotelState(), query = action.hotel;
    const expected = new URL(current.action);
    for (const [key, value] of [
      ['destination', current.destination], ['regionId', current.regionId], ['flexibility', '0_DAY'],
      ['d1', query.checkIn], ['startDate', query.checkIn], ['d2', query.checkOut],
      ['endDate', query.checkOut], ['adults', query.adults], ['rooms', query.rooms],
    ]) expected.searchParams.append(key, String(value));
    if (expected.href !== request.destination) return fail('stale', 'The reviewed hotel destination or search parameters changed.', 'destinationChanged');
    return { ok: true, navigation: expected.href };
  }
  if (action.kind === 'click' && data.kind === 'link' || action.kind === 'submitSearch' && data.kind === 'search')
    return { ok: true, navigation: data.destination };
  if (action.kind === 'click' && ['button', 'choice'].includes(data.kind)) {
    element.click();
    return { ok: true, navigation: null };
  }
  if (action.kind === 'fill' && data.kind === 'field') {
    element.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    element.focus({ preventScroll: true });
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, action.value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    if (element.value !== action.value) return fail('notApplied', 'The webpage did not retain the approved value.');
    return { ok: true, navigation: null };
  }
  if (action.kind === 'select' && data.kind === 'select') {
    const option = Array.from(element.options).find(option => text(option.label) === action.value
      && !option.disabled && !option.closest('optgroup:disabled'));
    if (!option) return fail('stale', 'The approved choice is no longer available.');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(element, option.value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    if (element.value !== option.value) return fail('notApplied', 'The webpage did not retain the approved choice.');
    return { ok: true, navigation: null };
  }
  return fail('blocked', 'The action does not match the observed control. Nothing was executed.');
})
