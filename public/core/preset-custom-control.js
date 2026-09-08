(function initPresetCustomControl(global) {
  function setup(selectEl, inputEl, value = '', onChange) {
    if (!selectEl || !inputEl) return;
    const raw = String(value || '').trim();
    const known = Array.from(selectEl.options).some((option) => option.value === raw);
    selectEl.value = raw && known ? raw : (raw ? '__custom__' : '');
    inputEl.value = raw && !known ? raw : '';
    inputEl.hidden = selectEl.value !== '__custom__';
    inputEl.disabled = selectEl.value !== '__custom__';
    if (onChange !== undefined) selectEl._presetCustomOnChange = onChange;
    if (!selectEl.dataset.presetCustomBound) {
      selectEl.addEventListener('change', () => {
        const custom = selectEl.value === '__custom__';
        inputEl.hidden = !custom;
        inputEl.disabled = !custom;
        if (!custom) inputEl.value = '';
        if (typeof selectEl._presetCustomOnChange === 'function') {
          selectEl._presetCustomOnChange();
        }
      });
      inputEl.addEventListener('input', () => {
        if (typeof selectEl._presetCustomOnChange === 'function') {
          selectEl._presetCustomOnChange();
        }
      });
      selectEl.dataset.presetCustomBound = '1';
    }
  }

  function getValue(selectEl, inputEl) {
    if (!selectEl) return '';
    return selectEl.value === '__custom__'
      ? String(inputEl?.value || '').trim()
      : String(selectEl.value || '').trim();
  }

  global.PresetCustomControl = { setup, getValue };
}(window));
