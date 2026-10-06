(request => {
  const state = globalThis.__rovukaOperator;
  if (!state || state.document !== document || state.lease !== request.lease)
    return { ok: false, code: 'stale', message: 'Independent verification lost the approved document.' };
  if (state.manual) return { ok: false, code: 'takeover', message: 'You have taken control of the page.',
    eventType: state.manualEvent };
  const nodes = state.verificationNodes ||= new Map();
  if (request.record) {
    const target = state.nodes.get(request.targetId);
    if (!target) return { ok: false, code: 'stale', message: 'The approved value target is no longer available.' };
    nodes.set(request.operationId, target.element);
  }
  const element = nodes.get(request.operationId);
  if (!element?.isConnected)
    return { ok: false, code: 'stale', message: 'The prepared field was replaced before its independent value check.' };
  return { ok: true, value: element.tagName === 'SELECT'
    ? element.selectedOptions[0]?.label?.replace(/\s+/g, ' ').trim()
    : element.value };
})
