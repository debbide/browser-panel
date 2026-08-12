(function initAutomaExportCore(root) {
  const selectorUtils = (() => {
    if (root.AutomaSelectorUtils) return root.AutomaSelectorUtils;
    if (typeof module === 'object' && module && typeof require === 'function') {
      try {
        return require('../../exporter/selector-utils');
      } catch (_e) {
        return {};
      }
    }
    return {};
  })();
  const selectorCandidates = selectorUtils.selectorCandidates || (() => []);

  function q(value) {
    return JSON.stringify(value === undefined || value === null ? '' : String(value));
  }

  function numberOr(defaultValue, raw) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : defaultValue;
  }

  function waitStrategyOf(step) {
    const raw = String(step?.wait_for || '').trim();
    return raw || 'timeout';
  }

  function locatorExprPlaywrightInScope(scopeExpr, selector) {
    const first = selectorCandidates(selector)[0];
    if (!first) return null;
    const type = String(first.type || 'css').toLowerCase();
    const value = String(first.value || '').trim();
    if (!value) return null;
    if (type === 'xpath') return `${scopeExpr}.locator(${q(`xpath=${value}`)})`;
    if (type === 'text') return `${scopeExpr}.getByText(${q(value)})`;
    if (type === 'role') {
      const m = value.match(/^([^:]+):(.+)$/);
      if (m) return `${scopeExpr}.getByRole(${q(m[1].trim())}, { name: ${q(m[2].trim())} })`;
      return `${scopeExpr}.getByRole(${q(value)})`;
    }
    if (type === 'testid') return `${scopeExpr}.getByTestId(${q(value)})`;
    return `${scopeExpr}.locator(${q(value)})`;
  }

  function frameScopePlaywright(step) {
    const frame = step?.frame;
    if (!frame || frame.in_iframe !== true) return 'page';
    if (frame.selector) return `page.frameLocator(${q(frame.selector)})`;
    if (frame.name) return `page.frame({ name: ${q(frame.name)} })`;
    if (frame.url) return `page.frame({ url: ${q(frame.url)} })`;
    return 'page';
  }

  function maybeWaitVisiblePlaywright(step, locatorExpr) {
    if (!locatorExpr) return '';
    const type = String(step?.type || '').trim();
    const needsWait = ['click', 'input', 'hover', 'select', 'check', 'uncheck', 'assert_text', 'press'].includes(type);
    if (!needsWait) return '';
    return `  await ${locatorExpr}.waitFor({ state: 'visible' });\n`;
  }

  function emitPlaywrightWait(step) {
    const strategy = waitStrategyOf(step);
    if (strategy === 'url_change') {
      const timeoutMs = numberOr(12000, step.timeout_ms);
      return `  await page.waitForURL(url => url.toString() !== ${q(step.page_url || '')}, { timeout: ${timeoutMs} });`;
    }
    if (strategy === 'ready_state') {
      const timeoutMs = numberOr(12000, step.timeout_ms);
      return `  await page.waitForFunction(() => document.readyState === 'complete', { timeout: ${timeoutMs} });`;
    }
    if (strategy === 'selector') {
      const scope = frameScopePlaywright(step);
      const sel = locatorExprPlaywrightInScope(scope, step?.selector);
      if (!sel) return '  // invalid wait(selector): missing selector';
      const timeoutMs = numberOr(12000, step.timeout_ms);
      const fallbackMs = numberOr(1200, step.fallback_ms);
      return `  try {\n    await ${sel}.waitFor({ state: 'visible', timeout: ${timeoutMs} });\n  } catch (e) {\n    await page.waitForTimeout(${fallbackMs});\n  }`;
    }
    return `  await page.waitForTimeout(${numberOr(500, step.ms)});`;
  }

  function emitPlaywrightStep(step) {
    if (step?.enabled === false) return `  // skipped step: ${step.type || 'unknown'} (disabled)`;
    const t = String(step?.type || '').trim();
    const scope = frameScopePlaywright(step);
    const sel = locatorExprPlaywrightInScope(scope, step?.selector);
    const prefix = [];
    if (step?.group) prefix.push(`  // group: ${step.group}`);
    if (step?.comment) prefix.push(`  // note: ${step.comment}`);
    const head = prefix.length ? `${prefix.join('\n')}\n` : '';

    if (t === 'goto') return `${head}  await page.goto(${q(step.url || '')});`;
    if (t === 'click') return sel ? `${head}${maybeWaitVisiblePlaywright(step, sel)}  await ${sel}.click();` : `${head}  // invalid click: missing selector`;
    if (t === 'input') return sel ? `${head}${maybeWaitVisiblePlaywright(step, sel)}  await ${sel}.fill(${q(step.value || '')});` : `${head}  // invalid input: missing selector`;
    if (t === 'wait') return `${head}${emitPlaywrightWait(step)}`;
    if (t === 'scroll') return `${head}  await page.evaluate(() => window.scrollTo(${numberOr(0, step.x)}, ${numberOr(0, step.y)}));`;
    if (t === 'hover') return sel ? `${head}${maybeWaitVisiblePlaywright(step, sel)}  await ${sel}.hover();` : `${head}  // invalid hover: missing selector`;
    if (t === 'press') return sel ? `${head}${maybeWaitVisiblePlaywright(step, sel)}  await ${sel}.press(${q(step.key || 'Enter')});` : `${head}  // invalid press: missing selector`;
    if (t === 'select') return sel ? `${head}${maybeWaitVisiblePlaywright(step, sel)}  await ${sel}.selectOption(${q(step.value || '')});` : `${head}  // invalid select: missing selector`;
    if (t === 'check') return sel ? `${head}${maybeWaitVisiblePlaywright(step, sel)}  await ${sel}.check();` : `${head}  // invalid check: missing selector`;
    if (t === 'uncheck') return sel ? `${head}${maybeWaitVisiblePlaywright(step, sel)}  await ${sel}.uncheck();` : `${head}  // invalid uncheck: missing selector`;
    if (t === 'assert_url_contains') return `${head}  if (!page.url().includes(${q(step.value || '')})) throw new Error('URL assertion failed');`;
    if (t === 'assert_text') {
      if (String(step.value || '') === '__turnstile_token_ready__') {
        return `${head}  await page.waitForFunction(() => {\n    const el = document.querySelector('input[name="cf-turnstile-response"]');\n    return !!(el && el.value && el.value.length > 20);\n  }, { timeout: 20000 });`;
      }
      if (!sel) return `${head}  // invalid assert_text: missing selector`;
      return `${head}${maybeWaitVisiblePlaywright(step, sel)}  if (!((await ${sel}.innerText()).includes(${q(step.value || '')}))) throw new Error('Text assertion failed');`;
    }
    if (t === 'screenshot') return `${head}  await page.screenshot({ path: ${q(`${step.name || 'step'}.png`)}, fullPage: ${step.fullPage ? 'true' : 'false'} });`;
    return `${head}  // unsupported step: ${t || 'unknown'}`;
  }

  function generatePlaywrightScript(ir) {
    const startUrl = ir?.meta?.start_url || 'about:blank';
    const steps = Array.isArray(ir?.steps) ? ir.steps : [];
    const lines = [];
    lines.push("const { chromium } = require('playwright');");
    lines.push('');
    lines.push('(async () => {');
    lines.push('  const browser = await chromium.launch({ headless: false });');
    lines.push('  const context = await browser.newContext();');
    lines.push('  const page = await context.newPage();');
    lines.push(`  await page.goto(${q(startUrl)});`);
    lines.push('');
    for (const step of steps) lines.push(emitPlaywrightStep(step));
    lines.push('');
    lines.push('  // await browser.close();');
    lines.push('})();');
    lines.push('');
    return lines.join('\n');
  }

  function escapeXPathLiteral(value) {
    const text = String(value || '');
    if (!text.includes("'")) return `'${text}'`;
    const parts = text.split("'").map(part => `'${part}'`);
    return `concat(${parts.join(`, "'", `)})`;
  }

  function selectorExprSeleniumBase(selector) {
    const first = selectorCandidates(selector)[0];
    if (!first) return '';
    const type = String(first.type || 'css').toLowerCase();
    const value = String(first.value || '').trim();
    if (!value) return '';
    if (type === 'xpath') return `xpath=${value}`;
    if (type === 'text') return `xpath=//*[contains(normalize-space(.), ${escapeXPathLiteral(value)})]`;
    if (type === 'role') {
      const m = value.match(/^([^:]+):(.+)$/);
      if (m) return `[role='${m[1].trim()}']`;
      return `[role='${value}']`;
    }
    if (type === 'testid') return `[data-testid='${value}']`;
    return value;
  }

  function maybeSwitchFrameSeleniumBase(step) {
    const frame = step?.frame;
    if (!frame || frame.in_iframe !== true) return '';
    if (frame.selector) return `        sb.switch_to_frame(${q(frame.selector)})\n`;
    if (frame.name) return `        sb.switch_to_frame(${q(frame.name)})\n`;
    return '';
  }

  function maybeResetFrameSeleniumBase(step) {
    const frame = step?.frame;
    if (!frame || frame.in_iframe !== true) return '';
    return '        sb.switch_to_default_content()\n';
  }

  function maybeWaitVisibleSeleniumBase(step, selector) {
    if (!selector) return '';
    const type = String(step?.type || '').trim();
    const needsWait = ['click', 'input', 'hover', 'select', 'check', 'uncheck', 'assert_text', 'press'].includes(type);
    if (!needsWait) return '';
    return `        sb.wait_for_element_visible(${q(selector)}, timeout=12)\n`;
  }

  function emitSeleniumBaseWait(step) {
    const strategy = waitStrategyOf(step);
    if (strategy === 'url_change') {
      const timeoutSec = Math.max(1, Math.ceil(numberOr(12000, step.timeout_ms) / 1000));
      const baseline = JSON.stringify(String(step.page_url || ''));
      const condition = `return window.location.href !== ${baseline};`;
      return `        sb.wait_for_ready_state_complete()\n        sb.wait_for_condition(${q(condition)}, timeout=${timeoutSec})`;
    }
    if (strategy === 'ready_state') {
      return '        sb.wait_for_ready_state_complete()';
    }
    if (strategy === 'selector') {
      const sel = selectorExprSeleniumBase(step?.selector);
      if (!sel) return '        # invalid wait(selector): missing selector';
      const timeoutSec = Math.max(1, Math.ceil(numberOr(12000, step.timeout_ms) / 1000));
      const fallbackSec = Math.max(0.5, numberOr(1200, step.fallback_ms) / 1000);
      return `        try:\n            sb.wait_for_element_visible(${q(sel)}, timeout=${timeoutSec})\n        except Exception:\n            sb.sleep(${fallbackSec.toFixed(2)})`;
    }
    const sec = Math.max(0, numberOr(500, step.ms) / 1000);
    return `        sb.sleep(${sec.toFixed(2)})`;
  }

  function emitSeleniumBaseStep(step) {
    if (step?.enabled === false) return `        # skipped step: ${step.type || 'unknown'} (disabled)`;
    const t = String(step?.type || '').trim();
    const sel = selectorExprSeleniumBase(step?.selector);
    const frameIn = maybeSwitchFrameSeleniumBase(step);
    const frameOut = maybeResetFrameSeleniumBase(step);
    const prefix = [];
    if (step?.group) prefix.push(`        # group: ${step.group}`);
    if (step?.comment) prefix.push(`        # note: ${step.comment}`);
    const head = prefix.length ? `${prefix.join('\n')}\n` : '';
    if (t === 'goto') return `${head}        sb.open(${q(step.url || '')})`;
    if (t === 'click') return sel ? `${head}${frameIn}${maybeWaitVisibleSeleniumBase(step, sel)}        sb.click(${q(sel)})\n${frameOut}`.trimEnd() : `${head}        # invalid click: missing selector`;
    if (t === 'input') return sel ? `${head}${frameIn}${maybeWaitVisibleSeleniumBase(step, sel)}        sb.type(${q(sel)}, ${q(step.value || '')})\n${frameOut}`.trimEnd() : `${head}        # invalid input: missing selector`;
    if (t === 'wait') return `${head}${emitSeleniumBaseWait(step)}`;
    if (t === 'scroll') return `${head}        sb.execute_script("window.scrollTo(arguments[0], arguments[1]);", ${numberOr(0, step.x)}, ${numberOr(0, step.y)})`;
    if (t === 'hover') return sel ? `${head}${frameIn}${maybeWaitVisibleSeleniumBase(step, sel)}        sb.hover(${q(sel)})\n${frameOut}`.trimEnd() : `${head}        # invalid hover: missing selector`;
    if (t === 'press') return sel ? `${head}${frameIn}${maybeWaitVisibleSeleniumBase(step, sel)}        sb.press_keys(${q(sel)}, ${q(step.key || 'Enter')})\n${frameOut}`.trimEnd() : `${head}        # invalid press: missing selector`;
    if (t === 'select') return sel ? `${head}${frameIn}${maybeWaitVisibleSeleniumBase(step, sel)}        sb.select_option_by_value(${q(sel)}, ${q(step.value || '')})\n${frameOut}`.trimEnd() : `${head}        # invalid select: missing selector`;
    if (t === 'check') return sel ? `${head}${frameIn}${maybeWaitVisibleSeleniumBase(step, sel)}        sb.check_if_unchecked(${q(sel)})\n${frameOut}`.trimEnd() : `${head}        # invalid check: missing selector`;
    if (t === 'uncheck') return sel ? `${head}${frameIn}${maybeWaitVisibleSeleniumBase(step, sel)}        sb.uncheck_if_checked(${q(sel)})\n${frameOut}`.trimEnd() : `${head}        # invalid uncheck: missing selector`;
    if (t === 'assert_url_contains') return `${head}        sb.assert_true(${q(step.value || '')} in sb.get_current_url())`;
    if (t === 'assert_text') {
      if (String(step.value || '') === '__turnstile_token_ready__') {
        return `${head}        sb.wait_for_condition("return !!(document.querySelector('input[name=\\\\'cf-turnstile-response\\\\']') && document.querySelector('input[name=\\\\'cf-turnstile-response\\\\']').value && document.querySelector('input[name=\\\\'cf-turnstile-response\\\\']').value.length > 20);", timeout=20)`;
      }
      return sel ? `${head}${frameIn}${maybeWaitVisibleSeleniumBase(step, sel)}        sb.assert_text(${q(step.value || '')}, ${q(sel)})\n${frameOut}`.trimEnd() : `${head}        # invalid assert_text: missing selector`;
    }
    if (t === 'screenshot') return `${head}        sb.save_screenshot(${q(`${step.name || 'step'}.png`)})`;
    return `${head}        # unsupported step: ${t || 'unknown'}`;
  }

  function generateSeleniumBaseScript(ir) {
    const startUrl = ir?.meta?.start_url || 'about:blank';
    const steps = Array.isArray(ir?.steps) ? ir.steps : [];
    const lines = [];
    lines.push('from seleniumbase import SB');
    lines.push('');
    lines.push('');
    lines.push('def run():');
    lines.push('    with SB(uc=True, test=True, headless2=False) as sb:');
    lines.push(`        sb.open(${q(startUrl)})`);
    for (const step of steps) lines.push(emitSeleniumBaseStep(step));
    lines.push('');
    lines.push('');
    lines.push("if __name__ == '__main__':");
    lines.push('    run()');
    lines.push('');
    return lines.join('\n');
  }

  function generateScriptByTarget(target, ir) {
    const t = String(target || '').toLowerCase();
    if (t === 'playwright') return generatePlaywrightScript(ir);
    if (t === 'seleniumbase') return generateSeleniumBaseScript(ir);
    throw new Error(`Unsupported export target: ${target}`);
  }

  const api = {
    generatePlaywrightScript,
    generateSeleniumBaseScript,
    generateScriptByTarget,
  };

  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  }

  root.AutomaExportCore = api;
})(globalThis);
