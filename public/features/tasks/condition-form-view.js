(function exposeTaskConditionFormView(global) {
  function applyFormValues(elements, values) {
    const valueBindings = {
      type: elements.type,
      checkInterval: elements.checkInterval,
      checkUnit: elements.checkUnit,
      cooldown: elements.cooldown,
      cooldownUnit: elements.cooldownUnit,
      url: elements.url,
      proxy: elements.proxy,
      method: elements.method,
      timeout: elements.timeout,
      successStatuses: elements.successStatuses,
      expectBody: elements.expectBody,
      windowValue: elements.windowValue,
      windowUnit: elements.windowUnit,
      jitterMin: elements.jitterMin,
      jitterMax: elements.jitterMax,
      jitterUnit: elements.jitterUnit,
    };
    if (elements.enabled) elements.enabled.checked = values.enabled;
    for (const [key, element] of Object.entries(valueBindings)) {
      if (element) element.value = values[key];
    }
    if (elements.triggerIfExpired) elements.triggerIfExpired.checked = values.triggerIfExpired;
  }

  function setPanelVisible(element, visible) {
    if (!element) return;
    element.hidden = !visible;
    element.style.display = visible ? '' : 'none';
  }

  function renderFieldsState(elements, state) {
    setPanelVisible(elements.fields, state.fieldsVisible);
    if (elements.fields) elements.fields.style.opacity = '1';
    setPanelVisible(elements.httpFields, state.httpVisible);
    setPanelVisible(elements.remainingFields, state.remainingVisible);
    if (elements.hint) elements.hint.textContent = state.hint;
    if (elements.testLabel) {
      elements.testLabel.textContent = state.testLabel;
    } else if (elements.testButton) {
      const icon = elements.testButton.querySelector('i');
      elements.testButton.textContent = '';
      if (icon) elements.testButton.appendChild(icon);
      elements.testButton.append(` ${state.testLabel}`);
    }
    if (elements.testButton) elements.testButton.disabled = false;
  }

  global.TaskConditionFormView = { applyFormValues, renderFieldsState };
})(window);
