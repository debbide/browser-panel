const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function loadView() {
  const context = vm.createContext({ window: {} });
  vm.runInContext(fs.readFileSync('public/features/tasks/condition-form-view.js', 'utf8'), context);
  return context.window.TaskConditionFormView;
}

function element() {
  return { checked: false, hidden: false, style: {}, value: '' };
}

{
  const view = loadView();
  const elements = {
    enabled: element(),
    type: element(),
    url: element(),
    triggerIfExpired: element(),
  };
  view.applyFormValues(elements, {
    enabled: true,
    type: 'remaining_callback',
    url: 'https://example.test',
    triggerIfExpired: true,
  });
  assert.equal(elements.enabled.checked, true);
  assert.equal(elements.type.value, 'remaining_callback');
  assert.equal(elements.url.value, 'https://example.test');
  assert.equal(elements.triggerIfExpired.checked, true);
}

{
  const view = loadView();
  const elements = {
    fields: element(),
    httpFields: element(),
    remainingFields: element(),
    hint: { textContent: '' },
    testLabel: { textContent: '' },
    testButton: { disabled: true },
  };
  view.renderFieldsState(elements, {
    fieldsVisible: true,
    httpVisible: false,
    remainingVisible: true,
    hint: '回调条件',
    testLabel: '测试回调',
  });
  assert.equal(elements.fields.hidden, false);
  assert.equal(elements.fields.style.opacity, '1');
  assert.equal(elements.httpFields.hidden, true);
  assert.equal(elements.httpFields.style.display, 'none');
  assert.equal(elements.remainingFields.hidden, false);
  assert.equal(elements.hint.textContent, '回调条件');
  assert.equal(elements.testLabel.textContent, '测试回调');
  assert.equal(elements.testButton.disabled, false);
}

{
  const html = fs.readFileSync('public/index.html', 'utf8');
  const model = html.indexOf('/features/tasks/condition-model.js?v=20260908a');
  const presentation = html.indexOf('/features/tasks/condition-presentation.js?v=20260908a');
  const formView = html.indexOf('/features/tasks/condition-form-view.js?v=20260908a');
  const runtime = html.indexOf('/panel-runtime.js');
  assert.ok(model >= 0 && presentation > model && formView > presentation && runtime > formView);
}
