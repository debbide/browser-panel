(function initProxyModeControl(global) {
  function update(modeEl, valueEl, fieldEl) {
    const mode = String(modeEl?.value || 'direct');
    const acceptsValue = mode === 'launch';
    if (!acceptsValue && valueEl) valueEl.value = '';
    if (fieldEl) fieldEl.hidden = !acceptsValue;
    if (valueEl) valueEl.disabled = !acceptsValue;
  }

  global.ProxyModeControl = { update };
}(window));
