function escPy(value) {
  return JSON.stringify(String(value ?? ''));
}

function timeoutPy(step, fallback = 10) {
  const t = Number(step?.timeoutMs || 0);
  if (!Number.isFinite(t) || t <= 0) return fallback;
  return Math.max(1, Math.ceil(t / 1000));
}

function stepToPy(step, index) {
  const action = String(step?.action || '').trim();
  const selector = String(step?.selector || '');
  const url = String(step?.url || '');
  const value = String(step?.value || '');
  const valueFrom = String(step?.valueFrom || '');
  const name = String(step?.name || `field_${index + 1}`);
  const path = String(step?.path || '');

  if (action === 'open') {
    return `        sb.open(${escPy(url)})`;
  }
  if (action === 'wait') {
    return `        sb.wait_for_element_visible(${escPy(selector)}, timeout=${timeoutPy(step, 15)})`;
  }
  if (action === 'click') {
    return `        sb.click(${escPy(selector)})`;
  }
  if (action === 'type') {
    if (valueFrom) {
      return `        sb.type(${escPy(selector)}, str(input_data.get(${escPy(valueFrom)}, "")))`;
    }
    return `        sb.type(${escPy(selector)}, ${escPy(value)})`;
  }
  if (action === 'extract') {
    return `        output[${escPy(name)}] = sb.get_text(${escPy(selector)}).strip()`;
  }
  if (action === 'check') {
    return `        if not sb.is_element_present(${escPy(selector)}):\n            raise Exception(${escPy(step?.message || `check failed: ${selector}`)})`;
  }
  if (action === 'screenshot') {
    const targetPath = path ? escPy(path) : `os.getenv("SCREENSHOT_PATH", "screenshot.png")`;
    return `        sb.save_screenshot(${targetPath})`;
  }
  return `        # Unsupported action: ${action}`;
}

function exportPySeleniumBase(ir) {
  const steps = Array.isArray(ir?.steps) ? ir.steps : [];
  const lines = steps.map((step, idx) => stepToPy(step, idx)).join('\n');
  return `import os
import json
from seleniumbase import SB

def run():
    input_data = {
        "username": os.getenv("WF_USERNAME", ""),
        "password": os.getenv("WF_PASSWORD", ""),
        "login_url": os.getenv("WF_LOGIN_URL", ""),
        "signin_url": os.getenv("WF_SIGNIN_URL", ""),
    }
    output = {}
    with SB(headless=True, test=True) as sb:
${lines}
    print(json.dumps({"ok": True, "output": output}, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    run()
`;
}

module.exports = {
  exportPySeleniumBase,
};
