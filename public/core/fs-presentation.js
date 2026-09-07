(function exposeFsPresentation(global) {
  function formatBytes(size) {
    const value = Number(size) || 0;
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }

  function formatFsMtime(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      const text = String(value);
      return text.length >= 16 ? text.slice(0, 16).replace('T', ' ') : text;
    }
    const pad = (part) => String(part).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function promptFsName(title, placeholder) {
    return new Promise((resolve) => {
      const mask = document.createElement('div');
      mask.className = 'modal-mask open';
      mask.style.zIndex = '10050';
      const dialog = document.createElement('div');
      dialog.className = 'modal open';
      dialog.style.cssText = 'z-index:10051; max-width:420px; width:min(420px,92vw);';
      dialog.innerHTML = `
        <div class="modal-header">
          <h2>${global.escapeHtml(title)}</h2>
          <button type="button" class="icon-btn fs-nm-close"><i data-lucide="x" class="icon-md"></i></button>
        </div>
        <div class="modal-body">
          <input type="text" class="fs-nm-input" placeholder="${global.escapeHtml(placeholder || '')}" spellcheck="false" autocomplete="off" style="width:100%" />
          <div class="row" style="margin-top:12px; gap:8px; justify-content:flex-end;">
            <button type="button" class="alt fs-nm-cancel">取消</button>
            <button type="button" class="btn-primary fs-nm-ok">确定</button>
          </div>
        </div>
      `;
      document.body.appendChild(mask);
      document.body.appendChild(dialog);
      if (global.lucide) global.lucide.createIcons({ root: dialog });
      const input = dialog.querySelector('.fs-nm-input');
      const done = (value) => { mask.remove(); dialog.remove(); resolve(value); };
      dialog.querySelector('.fs-nm-close').addEventListener('click', () => done(null));
      dialog.querySelector('.fs-nm-cancel').addEventListener('click', () => done(null));
      mask.addEventListener('click', () => done(null));
      dialog.querySelector('.fs-nm-ok').addEventListener('click', () => done(String(input.value || '').trim()));
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); done(String(input.value || '').trim()); }
      });
      setTimeout(() => input.focus(), 40);
    });
  }

  global.FsPresentation = { formatBytes, formatFsMtime, promptFsName };
  Object.assign(global, global.FsPresentation);
})(window);
