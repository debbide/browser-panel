(function initClipboard(global) {
  async function copyText(text) {
    if (global.navigator.clipboard && global.isSecureContext) {
      await global.navigator.clipboard.writeText(text);
      return;
    }
    const textarea = global.document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    global.document.body.appendChild(textarea);
    textarea.select();
    global.document.execCommand('copy');
    textarea.remove();
  }

  global.Clipboard = { copyText };
}(window));
