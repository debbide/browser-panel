# -*- coding: utf-8 -*-
"""
DrissionPage browser helpers — woiden_yolo 自有副本。
不依赖 host2play_dp / host2play_yolo；reCAPTCHA YOLO 也在本包内（captcha/dom/client）。
"""

import os
import re
import shutil
import tempfile
import time

from DrissionPage import ChromiumOptions, ChromiumPage


def log(msg, level="INFO"):
    try:
        from woiden_yolo.logutil import log as _ulog

        _ulog(msg, level=level, tag="browser")
    except Exception:
        print(f"[browser][{level}] {msg}", flush=True)


def env_flag(name, default=False):
    raw = os.environ.get(name)
    if raw is None:
        return default
    return str(raw).strip().lower() in {"1", "true", "yes", "on"}


def inject_hardware_fingerprint(page):
    """Removed WebGL/Canvas spoofing as it causes discrepancy in Xvfb"""
    pass


def _is_extension_dir(path):
    """Unpacked Chrome extension = folder with manifest.json."""
    try:
        return os.path.isdir(path) and os.path.isfile(os.path.join(path, "manifest.json"))
    except Exception:
        return False


def discover_extension_dirs():
    """Find unpacked extensions to load into Chrome.

    Default (automation-safe): ONLY `ublock_lite`.
    Full AdGuard often fails on Linux automation with:
      ruleset_0.json: Internal error while parsing rules / Could not load manifest

    Search order:
      1) BROWSER_EXTENSIONS env — explicit paths (| or ; separated)  [wins if set]
      2) tasks/woiden_yolo/extensions/ublock_lite   (default)
      3) If WOIDEN_LOAD_ADGUARD=1, also load extensions/adguard

    Set WOIDEN_LOAD_EXTENSIONS=0 to disable all.
    """
    if not env_flag("WOIDEN_LOAD_EXTENSIONS", True):
        log("extension loading disabled (WOIDEN_LOAD_EXTENSIONS=0)")
        return []

    found = []
    seen = set()

    def _add(p):
        try:
            ap = os.path.abspath(p)
        except Exception:
            return
        if ap in seen:
            return
        if _is_extension_dir(ap):
            seen.add(ap)
            found.append(ap)

    # 1) explicit env always wins (full control)
    raw = (os.environ.get("BROWSER_EXTENSIONS") or "").strip()
    if raw:
        for part in re.split(r"[|;]", raw):
            part = part.strip().strip('"').strip("'")
            if not part:
                continue
            if not os.path.isabs(part):
                for root in (
                    os.environ.get("APP_ROOT", ""),
                    os.path.join(os.environ.get("APP_ROOT", ""), "tasks") if os.environ.get("APP_ROOT") else "",
                    os.getcwd(),
                    os.path.join(os.getcwd(), "tasks"),
                ):
                    if not root:
                        continue
                    cand = os.path.join(root, part)
                    if _is_extension_dir(cand):
                        _add(cand)
                        break
                else:
                    _add(part)
            else:
                _add(part)
        return found

    # 2) default: lightweight ublock_lite only
    here = os.path.dirname(os.path.abspath(__file__))
    lite = os.path.join(here, "extensions", "ublock_lite")
    _add(lite)
    if found:
        log(f"default extension: ublock_lite ({found[0]})")

    # 3) optional full AdGuard (often broken under automation; opt-in)
    if env_flag("WOIDEN_LOAD_ADGUARD", False):
        adg = os.path.join(here, "extensions", "adguard")
        _add(adg)
        log("WOIDEN_LOAD_ADGUARD=1 — also loading full AdGuard")

    return found


def apply_extensions(co, extension_dirs=None):
    """Load unpacked extensions the way DrissionPage expects.

    Upstream DP:
      co.add_extension(path)  -> appends to co._extensions
      on launch, DP should turn _extensions into:
        --load-extension=p1,p2
        --disable-extensions-except=p1,p2

    Some installs / versions don't apply _extensions correctly under
    automation, so we ALSO set the CLI flags explicitly after add_extension.
    """
    dirs = extension_dirs if extension_dirs is not None else discover_extension_dirs()
    if not dirs:
        log("no Chrome extensions to load")
        return []

    loaded = []
    for d in dirs:
        ap = os.path.abspath(d)
        if not os.path.isdir(ap):
            log(f"扩展目录不存在: {ap}", "WARN")
            continue
        if not _is_extension_dir(ap):
            log(f"扩展目录无 manifest.json，跳过: {ap}", "WARN")
            continue

        # 1) Official API (same as your GitHub NopeCHA code)
        try:
            co.add_extension(ap)
            log(f"add_extension: {ap}")
        except Exception as e:
            log(f"add_extension 失败 {ap}: {e}", "WARN")

        # 2) Ensure path is on co._extensions even if add_extension was a no-op
        try:
            ext_list = getattr(co, "_extensions", None)
            if isinstance(ext_list, list) and ap not in ext_list:
                ext_list.append(ap)
                log(f"_extensions append: {ap}")
        except Exception:
            pass

        loaded.append(ap)

    if not loaded:
        log("未成功加载任何扩展", "WARN")
        return []

    # 3) Explicit CLI flags — critical on some DP/Chrome combos
    #    Chrome needs BOTH flags; bare --disable-extensions must not remain.
    joined = ",".join(loaded)
    for bad in (
        "--disable-extensions",
        "--disable-component-extensions-with-background-pages",
    ):
        try:
            co.remove_argument(bad)
        except Exception:
            pass
        # brute-remove from internal list if remove_argument is weak
        try:
            for attr in ("_arguments", "arguments", "_chrome_args"):
                lst = getattr(co, attr, None)
                if isinstance(lst, list):
                    kept = [x for x in lst if bad not in str(x) or "except" in str(x)]
                    if len(kept) != len(lst):
                        setattr(co, attr, kept)
        except Exception:
            pass

    # set_argument forms used by different DP versions
    for flag, val in (
        ("--load-extension", joined),
        ("--disable-extensions-except", joined),
    ):
        ok = False
        for setter in (
            lambda f=flag, v=val: co.set_argument(f"{f}={v}"),
            lambda f=flag, v=val: co.set_argument(f, v),
        ):
            try:
                setter()
                ok = True
                break
            except Exception:
                continue
        if not ok:
            log(f"failed to set {flag}", "ERROR")

    # 4) Dump state for debugging
    try:
        ext_attr = getattr(co, "_extensions", None)
        log(f"co._extensions = {ext_attr!r}")
    except Exception:
        pass
    try:
        args = []
        for attr in ("_arguments", "arguments", "_chrome_args"):
            lst = getattr(co, attr, None)
            if isinstance(lst, list):
                args = lst
                break
        ext_args = [str(a) for a in args if "extension" in str(a).lower()]
        log(f"extension-related args now: {ext_args}")
    except Exception as e:
        log(f"inspect args failed: {e}", "WARN")

    log(f"共加载 {len(loaded)} 个扩展: {loaded}")
    return loaded


# How browser ad extensions work (and what we reimplement in code):
#
#   Layer A — Network block (uBO/AdGuard declarativeNetRequest / webRequest)
#     Block URL patterns before they load (googlesyndication, doubleclick, …).
#     Code equivalent: CDP Network.setBlockedURLs.
#     Risk on woiden.id: anti-adblock may alert if ad scripts fail to load.
#
#   Layer B — Cosmetic filter (your screenshot: ##ins.adsbygoogle)
#     Hide/disable DOM nodes after page load so they don't cover buttons.
#     Code equivalent: inject CSS + MutationObserver (what AdGuard did on adsbygoogle).
#     Safer for automation: ads may still "load" but cannot steal clicks.
#
# Default: Layer B ON (cosmetic). Layer A OFF unless WOIDEN_AD_NETWORK_BLOCK=1.

_AD_COSMETIC_CSS = r"""
ins.adsbygoogle, ins.adsbygoogle-noablate,
iframe[id^="aswift_"], iframe[name^="aswift_"],
iframe[id^="google_ads"], iframe[name^="google_ads"],
iframe[id^="google_esf"], iframe[src*="zrt_lookup"],
iframe[src*="googlesyndication"], iframe[src*="doubleclick"],
iframe[src*="googleads"], iframe[src*="pagead"],
div[id^="google_ads"], div[id*="div-gpt-ad"],
div[class*="adsbygoogle"], .adsbygoogle,
[data-ad-client], [data-ad-slot], [data-adsbygoogle-status],
.wpbrad-zone, .site_ad-wrap, div[class*="ad-zone"],
div[id*="ad-container"], div[class*="ad-container"],
/* Google Funding Choices soft-paywall (Woiden "Unlock more content") & CMP Settings */
.fc-message-root, .fc-monetization-dialog-container,
.fc-monetization-dialog, .fc-dialog, .fc-dialog-overlay,
.fc-dialog-content, .fc-list-container, .fc-thank-you-snackbar,
.fc-manage-options, .fc-settings-root, .fc-consent-root,
#ft-floating-toolbar, #ft-reg-bubble, .ft-container,
div[aria-label="Privacy and cookie settings"],
div[aria-label*="cookie settings" i],
div[aria-label="Unlock more content"],
#fc-focus-trap-pre-div, #fc-focus-trap-post-div {
  pointer-events: none !important;
  opacity: 0 !important;
  max-height: 0 !important;
  max-width: 0 !important;
  overflow: hidden !important;
  position: absolute !important;
  left: -99999px !important;
  z-index: 0 !important;
  display: none !important;
  visibility: hidden !important;
}
"""

# Inject once per document: CSS + observer (cosmetic layer only; no adsbygoogle hijack)
_AD_COSMETIC_JS = r"""
(function() {
  if (window.__woidenCosmeticAdHide) return 'already';
  window.__woidenCosmeticAdHide = true;
  var css = %s;
  function inject() {
    try {
      if (!document.getElementById('__WOIDEN_ad_css')) {
        var s = document.createElement('style');
        s.id = '__WOIDEN_ad_css';
        s.textContent = css;
        (document.documentElement || document.head || document.body).appendChild(s);
      }
    } catch (e) {}
  }
  function scrub(root) {
    try {
      var sel = 'ins.adsbygoogle, iframe[id^="aswift_"], iframe[src*="googlesyndication"], iframe[src*="doubleclick"], [data-ad-client], [data-ad-slot], .wpbrad-zone';
      (root || document).querySelectorAll(sel).forEach(function(el) {
        try {
          el.style.setProperty('pointer-events', 'none', 'important');
          el.style.setProperty('opacity', '0', 'important');
          el.setAttribute('data-Woiden-ad-hidden', '1');
        } catch (e) {}
      });
    } catch (e) {}
  }
  inject();
  scrub(document);
  try {
    var mo = new MutationObserver(function(muts) {
      inject();
      for (var i = 0; i < muts.length; i++) {
        var ns = muts[i].addedNodes;
        if (!ns) continue;
        for (var j = 0; j < ns.length; j++) {
          if (ns[j] && ns[j].nodeType === 1) scrub(ns[j]);
        }
      }
    });
    mo.observe(document.documentElement || document, {childList: true, subtree: true});
  } catch (e) {}
  return 'ok';
})();
""" % (repr(_AD_COSMETIC_CSS),)

# Optional network block list (extension Layer A equivalent). Off by default.
_AD_NETWORK_BLOCK_URLS = [
    "*://*.googlesyndication.com/*",
    "*://pagead2.googlesyndication.com/*",
    "*://*.doubleclick.net/*",
    "*://securepubads.g.doubleclick.net/*",
    "*://*.googleadservices.com/*",
    "*://*.googletagservices.com/*",
    "*://googleads.g.doubleclick.net/*",
    "*://tpc.googlesyndication.com/*",
    "*://*.adservice.google.com/*",
    "*://fundingchoicesmessages.google.com/*",
    "*://*.amazon-adsystem.com/*",
    "*://*.adnxs.com/*",
    "*://*.taboola.com/*",
    "*://*.outbrain.com/*",
    "*://*.criteo.com/*",
    "*://*/pagead/js/adsbygoogle.js*",
]


def dismiss_js_alerts(page, max_rounds=2):
    """Dismiss at most a couple of native alerts (anti-adblock etc.)."""
    for _ in range(max_rounds):
        handled = False
        try:
            if hasattr(page, "handle_alert"):
                page.handle_alert(accept=True, timeout=0.2)
                handled = True
        except Exception:
            pass
        if not handled:
            try:
                page.run_cdp("Page.handleJavaScriptDialog", accept=True)
                handled = True
            except Exception:
                pass
        if not handled:
            break
        time.sleep(0.15)


def enable_ad_block(page):
    """Install code-side ad handling (extension-equivalent layers).

    Default:
      - Cosmetic hide ON  (WOIDEN_AD_COSMETIC default 1) — same idea as ##ins.adsbygoogle
      - Network block OFF (WOIDEN_AD_NETWORK_BLOCK default 0) — avoid anti-adblock alert

    Call once after browser start; hide_ads() re-applies cosmetic on each navigation.
    """
    if not page:
        return

    # Clear any leftover hard blocks from older runs unless user opts in
    net_on = env_flag("WOIDEN_AD_NETWORK_BLOCK", False)
    try:
        page.run_cdp("Network.enable")
        page.run_cdp(
            "Network.setBlockedURLs",
            urls=_AD_NETWORK_BLOCK_URLS if net_on else [],
        )
        if net_on:
            log(f"ad network block ON ({len(_AD_NETWORK_BLOCK_URLS)} patterns) — may trip anti-adblock")
        else:
            log("ad network block OFF (cosmetic-only; set WOIDEN_AD_NETWORK_BLOCK=1 to hard-block URLs)")
    except Exception as e:
        log(f"Network.setBlockedURLs setup: {e}", "WARN")

    # Register cosmetic injector for every new document
    cos_on = env_flag("WOIDEN_AD_COSMETIC", True)
    if cos_on:
        try:
            page.run_cdp("Page.addScriptToEvaluateOnNewDocument", source=_AD_COSMETIC_JS)
            log("ad cosmetic filter registered (ins.adsbygoogle / aswift_* hide)")
        except Exception:
            try:
                page.add_init_js(_AD_COSMETIC_JS)
                log("ad cosmetic filter via add_init_js")
            except Exception as e:
                log(f"ad cosmetic register failed: {e}", "WARN")
    else:
        log("ad cosmetic OFF (WOIDEN_AD_COSMETIC=0)")


# Aggressive popup killer — adapted from axenthost browser script killPopups():
#   - remove interstitial / gpt units
#   - click visible Close ad buttons
#   - remove high-z-index fixed/absolute parents of aswift iframes
#   - kill "Unlock more content / View a short ad" site-wide soft-paywall (Woiden)
_AD_KILL_POPUPS_JS = r"""
(function() {
  var n = 0;
  function visible(el) {
    if (!el) return false;
    try {
      var st = window.getComputedStyle(el);
      if (!st || st.display === 'none' || st.visibility === 'hidden') return false;
      if (parseFloat(st.opacity || '1') < 0.05) return false;
      var r = el.getBoundingClientRect();
      return r.width > 2 && r.height > 2;
    } catch (e) { return true; }
  }
  function kill(el) {
    if (!el || el === document.body || el === document.documentElement) return;
    try {
      el.style.setProperty('display', 'none', 'important');
      el.style.setProperty('pointer-events', 'none', 'important');
      el.style.setProperty('opacity', '0', 'important');
      el.style.setProperty('visibility', 'hidden', 'important');
      el.setAttribute('data-Woiden-ad-killed', '1');
      try { el.remove(); } catch (e2) {}
      n++;
    } catch (e) {}
  }

  // -1) GDPR / cookie consent FIRST (click Consent, not only hide)
  try {
    var consentClicked = false;
    var consentSels = [
      'button.fc-cta-consent',
      'button.fc-button.fc-cta-consent',
      '.fc-consent-root button.fc-cta-consent',
      'button[aria-label="Consent"]',
      'button[aria-label="Agree"]',
      'button[aria-label="Accept"]',
      'button[aria-label="Accept all"]',
    ];
    for (var ci = 0; ci < consentSels.length && !consentClicked; ci++) {
      try {
        var nodes = document.querySelectorAll(consentSels[ci]);
        for (var cj = 0; cj < nodes.length; cj++) {
          var b = nodes[cj];
          if (!visible(b)) continue;
          try { b.click(); consentClicked = true; n++; break; } catch (e) {}
        }
      } catch (e) {}
    }
    if (!consentClicked) {
      var btns = document.querySelectorAll('button, [role="button"], a.fc-button');
      for (var k = 0; k < btns.length; k++) {
        var el = btns[k];
        if (!visible(el)) continue;
        var lab = ((el.innerText || el.textContent || el.getAttribute('aria-label') || '') + '')
          .replace(/\s+/g, ' ').trim().toLowerCase();
        if (!lab || lab.length > 40) continue;
        if (lab === 'consent' || lab === 'accept' || lab === 'accept all'
            || lab === 'agree' || lab === 'i agree' || lab === 'allow all'
            || lab === '同意' || lab === '接受' || lab === '全部接受') {
          try { el.click(); consentClicked = true; n++; break; } catch (e) {}
        }
      }
    }
    if (!consentClicked) {
      document.querySelectorAll(
        '.fc-consent-root, .fc-dialog-container, div[class*="fc-consent"], div[aria-modal="true"]'
      ).forEach(function(root) {
        try {
          var t = ((root.innerText || '') + '').toLowerCase();
          if (t.indexOf('personal data') >= 0 || t.indexOf('consent to use') >= 0
              || t.indexOf('manage options') >= 0 || t.indexOf('asks for your consent') >= 0) {
            kill(root);
          }
        } catch (e) {}
      });
    }
  } catch (e) {}

  // 0) Google Funding Choices soft-paywall (live DOM on woiden.id):
  //    .fc-message-root > .fc-monetization-dialog-container
  //      .fc-dialog-overlay
  //      .fc-monetization-dialog[aria-label="Unlock more content"]
  //    + ins.adsbygoogle-noablate giant z-index covers
  try {
    var fcSels = [
      '.fc-message-root',
      '.fc-monetization-dialog-container',
      '.fc-monetization-dialog',
      '.fc-dialog-overlay',
      'div[aria-label="Unlock more content"]',
      '.fc-dialog-content',
      '.fc-list-container',
      '.fc-thank-you-snackbar',
      '#fc-focus-trap-pre-div',
      '#fc-focus-trap-post-div',
      'ins.adsbygoogle-noablate[data-anchor-status]',
      'ins.adsbygoogle-noablate[data-vignette-loaded]',
      'ins.adsbygoogle-noablate[data-ad-status="filled"]',
    ];
    fcSels.forEach(function(sel) {
      try {
        document.querySelectorAll(sel).forEach(function(el) { kill(el); });
      } catch (e) {}
    });
  } catch (e) {}

  // Text fallback if FC class names change
  try {
    var unlockHits = [];
    var walk = document.querySelectorAll('div,section,aside,dialog');
    for (var i = 0; i < walk.length; i++) {
      var el = walk[i];
      if (!visible(el)) continue;
      var t = ((el.innerText || el.textContent || '') + '').replace(/\s+/g, ' ').trim();
      if (!t || t.length > 800) continue;
      var low = t.toLowerCase();
      var isUnlock =
        (low.indexOf('unlock more content') >= 0) ||
        (low.indexOf('view a short ad') >= 0) ||
        (low.indexOf('site-wide access for 24 hours') >= 0) ||
        (low.indexOf('take action to continue accessing') >= 0);
      if (!isUnlock) continue;
      var root = el;
      for (var up = 0; up < 8 && root && root !== document.body; up++) {
        try {
          var st = window.getComputedStyle(root);
          var z = parseInt(st.zIndex, 10) || 0;
          var r = root.getBoundingClientRect();
          var covers =
            (st.position === 'fixed' || st.position === 'absolute') ||
            z >= 1000 ||
            (r.width > window.innerWidth * 0.4 && r.height > window.innerHeight * 0.25);
          if (covers) break;
        } catch (e) {}
        root = root.parentElement;
      }
      unlockHits.push(root || el);
    }
    unlockHits.forEach(function(root) {
      kill(root);
      try {
        var p = root && root.parentElement;
        if (!p) return;
        Array.prototype.slice.call(p.children || []).forEach(function(ch) {
          if (ch === root) return;
          try {
            var st = window.getComputedStyle(ch);
            var z = parseInt(st.zIndex, 10) || 0;
            var r = ch.getBoundingClientRect();
            var bg = (st.backgroundColor || '').toLowerCase();
            var darkish = /rgba?\(\s*\d+,\s*\d+,\s*\d+,\s*0\.[3-9]/.test(bg) || bg.indexOf('rgba(0') === 0;
            if ((st.position === 'fixed' || z >= 900) && (darkish || (r.width > window.innerWidth * 0.8 && r.height > window.innerHeight * 0.8))) {
              kill(ch);
            }
          } catch (e) {}
        });
      } catch (e) {}
    });
  } catch (e) {}

  try {
    document.querySelectorAll('[id*="interstitial"], ins[id^="gpt_unit_"], ins.adsbygoogle').forEach(function(ad) {
      try { ad.remove(); n++; } catch (e) {}
    });
  } catch (e) {}
  try {
    document.querySelectorAll(
      '[aria-label="Close ad"], [aria-label="Close"], #dismiss-button, .close-button, [aria-label="关闭"], [aria-label="Dismiss"], button[aria-label*="close" i]'
    ).forEach(function(button) {
      try {
        if (button.offsetWidth > 0 || button.offsetHeight > 0) {
          button.click();
          n++;
        }
      } catch (e) {}
    });
  } catch (e) {}
  try {
    document.querySelectorAll('iframe[id^="aswift"], iframe[name^="aswift"], iframe[src*="googlesyndication"], iframe[src*="doubleclick"]').forEach(function(iframe) {
      try {
        var parent = iframe.parentElement;
        while (parent && parent.tagName !== 'BODY') {
          var style = window.getComputedStyle(parent);
          var zIndex = parseInt(style.zIndex, 10);
          if (zIndex > 1000 && (style.position === 'fixed' || style.position === 'absolute')) {
            parent.remove();
            n++;
            break;
          }
          parent = parent.parentElement;
        }
        // if no high-z parent, still neuter the iframe
        iframe.style.setProperty('pointer-events', 'none', 'important');
        iframe.style.setProperty('opacity', '0', 'important');
      } catch (e) {}
    });
  } catch (e) {}

  // High-z full-viewport fixed overlays that are NOT recaptcha/turnstile
  try {
    document.querySelectorAll('div,section,aside').forEach(function(el) {
      try {
        if (el.getAttribute('data-Woiden-ad-killed') === '1') return;
        var st = window.getComputedStyle(el);
        if (st.position !== 'fixed' && st.position !== 'absolute') return;
        var z = parseInt(st.zIndex, 10) || 0;
        if (z < 1000) return;
        var r = el.getBoundingClientRect();
        if (r.width < window.innerWidth * 0.35 || r.height < window.innerHeight * 0.2) return;
        // never kill recaptcha / turnstile / telegram oauth
        var html = (el.innerHTML || '').slice(0, 500).toLowerCase();
        var idc = ((el.id || '') + ' ' + (el.className || '')).toLowerCase();
        if (html.indexOf('recaptcha') >= 0 || html.indexOf('g-recaptcha') >= 0) return;
        if (html.indexOf('cf-turnstile') >= 0 || html.indexOf('turnstile') >= 0) return;
        if (idc.indexOf('recaptcha') >= 0 || idc.indexOf('turnstile') >= 0) return;
        var t = ((el.innerText || '') + '').toLowerCase();
        // only kill if looks ad-ish / lock-ish / empty cover
        var adish =
          t.indexOf('unlock more content') >= 0 ||
          t.indexOf('view a short ad') >= 0 ||
          t.indexOf('site-wide access') >= 0 ||
          t.indexOf('continue accessing') >= 0 ||
          t.indexOf('advertisement') >= 0 ||
          t.indexOf('sponsored') >= 0 ||
          (t.length < 8 && r.width > window.innerWidth * 0.85 && r.height > window.innerHeight * 0.85);
        if (!adish) return;
        kill(el);
      } catch (e) {}
    });
  } catch (e) {}

  // Restore body scroll if interstitial locked it
  try {
    document.documentElement.style.removeProperty('overflow');
    document.body.style.removeProperty('overflow');
    document.documentElement.style.overflow = 'auto';
    document.body.style.overflow = 'auto';
  } catch (e) {}
  return n;
})();
"""


def page_has_content_lock_ad(page) -> bool:
    """Detect Google Funding Choices soft-paywall on Woiden (Unlock more content)."""
    if not page:
        return False
    try:
        return bool(
            page.run_js(
                """
                // Precise FC selectors (from live DOM)
                if (document.querySelector(
                  '.fc-message-root, .fc-monetization-dialog, .fc-monetization-dialog-container, '
                  + '.fc-dialog-overlay, div[aria-label="Unlock more content"]'
                )) return true;
                const body = ((document.body && (document.body.innerText || document.body.textContent)) || '')
                  .toLowerCase();
                if (body.includes('unlock more content')) return true;
                if (body.includes('view a short ad')) return true;
                if (body.includes('site-wide access for 24 hours')) return true;
                if (body.includes('take action to continue accessing')) return true;
                return false;
                """
            )
        )
    except Exception:
        return False


def dismiss_cookie_consent(page) -> bool:
    """Click GDPR Consent (Funding Choices personal-data dialog). Temp profiles always hit this."""
    if not page:
        return False
    try:
        ret = page.run_js(
            """
            function vis(el){
              if(!el) return false;
              try{
                var st=getComputedStyle(el);
                if(!st||st.display==='none'||st.visibility==='hidden') return false;
                var r=el.getBoundingClientRect();
                return r.width>4 && r.height>4;
              }catch(e){return true;}
            }
            var sels = [
              'button.fc-cta-consent',
              'button.fc-button.fc-cta-consent',
              '.fc-consent-root button.fc-cta-consent',
              'button[aria-label="Consent"]',
              'button[aria-label="Accept all"]',
              'button[aria-label="Accept"]',
              'button[aria-label="Agree"]'
            ];
            for (var i=0;i<sels.length;i++){
              var list=document.querySelectorAll(sels[i]);
              for (var j=0;j<list.length;j++){
                if(!vis(list[j])) continue;
                try{ list[j].click(); return 'click:'+sels[i]; }catch(e){}
              }
            }
            var nodes=document.querySelectorAll('button,[role="button"],a.fc-button');
            for (var k=0;k<nodes.length;k++){
              var el=nodes[k];
              if(!vis(el)) continue;
              var lab=((el.innerText||el.textContent||el.getAttribute('aria-label')||'')+'')
                .replace(/\\s+/g,' ').trim().toLowerCase();
              if(!lab||lab.length>40) continue;
              if (lab==='consent'||lab==='accept'||lab==='accept all'||lab==='agree'
                  ||lab==='i agree'||lab==='allow all'||lab==='同意'||lab==='接受'||lab==='全部接受'){
                try{ el.click(); return 'click-text:'+lab; }catch(e){}
              }
            }
            var open=false;
            document.querySelectorAll('div,section,dialog,aside').forEach(function(el){
              if(!vis(el)) return;
              var t=((el.innerText||'')+'').toLowerCase();
              if(t.indexOf('asks for your consent')>=0 || t.indexOf('personal data')>=0
                 || (t.indexOf('manage options')>=0 && t.indexOf('consent')>=0)){
                open=true;
              }
            });
            return open ? 'open-no-click' : 'none';
            """
        )
        if isinstance(ret, str) and ret.startswith("click"):
            log(f"cookie consent dismissed via {ret}")
            time.sleep(0.5)
            return True
        if ret == "open-no-click":
            page.run_js(
                """
                document.querySelectorAll('div,section,dialog,aside').forEach(function(el){
                  var t=((el.innerText||'')+'').toLowerCase();
                  if(t.indexOf('asks for your consent')>=0 || t.indexOf('personal data')>=0
                     || (t.indexOf('manage options')>=0 && t.indexOf('consent')>=0)){
                    el.style.setProperty('display','none','important');
                    el.style.setProperty('pointer-events','none','important');
                    try{el.remove();}catch(e){}
                  }
                });
                document.documentElement.style.overflow='auto';
                document.body.style.overflow='auto';
                """
            )
            log("cookie consent force-removed (no Consent button matched)", "WARN")
            return True
    except Exception as e:
        log(f"dismiss_cookie_consent failed: {e}", "WARN")
    return False


def hide_ads(page):
    """Re-apply ad hide on current page (call after navigations).

    Layers:
      0) GDPR cookie Consent click (temp profile always shows this)
      1) Cosmetic CSS + observer (WOIDEN_AD_COSMETIC, default ON)
      2) Aggressive remove/close of covering popups (WOIDEN_AD_KILL_POPUPS, default ON)
         including Woiden "Unlock more content / View a short ad" interstitial

    Does not block network by itself (see enable_ad_block / WOIDEN_AD_NETWORK_BLOCK).
    """
    if not page:
        return
    # One-shot alert dismiss only
    try:
        if hasattr(page, "handle_alert"):
            page.handle_alert(accept=True, timeout=0.2)
    except Exception:
        try:
            page.run_cdp("Page.handleJavaScriptDialog", accept=True)
        except Exception:
            pass

    if env_flag("WOIDEN_DISMISS_CONSENT", True):
        try:
            dismiss_cookie_consent(page)
        except Exception as e:
            log(f"consent dismiss error: {e}", "WARN")

    if env_flag("WOIDEN_AD_COSMETIC", True):
        try:
            page.run_js(_AD_COSMETIC_JS)
        except Exception:
            try:
                page.run_js(
                    """
                    document.querySelectorAll(
                      'ins.adsbygoogle, iframe[id^="aswift_"], iframe[src*="googlesyndication"], [data-ad-client]'
                    ).forEach(function(el){
                      el.style.pointerEvents='none';
                      el.style.opacity='0';
                    });
                    """
                )
            except Exception:
                pass

    # Aggressive: remove covering layers so Renew/login/YOLO shots work
    if env_flag("WOIDEN_AD_KILL_POPUPS", True):
        try:
            had_lock = page_has_content_lock_ad(page)
            n = page.run_js(_AD_KILL_POPUPS_JS)
            if n:
                log(f"killPopups removed/closed ~{n} ad nodes")
            if had_lock:
                # second pass — some modals re-inject once
                time.sleep(0.25)
                n2 = page.run_js(_AD_KILL_POPUPS_JS)
                still = page_has_content_lock_ad(page)
                log(
                    f"content-lock ad scrub: first={n} second={n2} still_visible={still}"
                )
                if still:
                    # last resort: hide any visible modal-like card with the texts
                    page.run_js(
                        """
                        document.querySelectorAll('div,section,aside,dialog').forEach(function(el){
                          var t=((el.innerText||'')+'').toLowerCase();
                          if(t.indexOf('unlock more content')>=0 || t.indexOf('view a short ad')>=0){
                            el.style.setProperty('display','none','important');
                            el.style.setProperty('pointer-events','none','important');
                            try{el.remove();}catch(e){}
                          }
                        });
                        document.documentElement.style.overflow='auto';
                        document.body.style.overflow='auto';
                        """
                    )
        except Exception as e:
            log(f"killPopups failed: {e}", "WARN")


def create_browser(user_data_dir=None, cleanup_user_data=None):
    """Create ChromiumPage from panel env.

    Returns (page, user_data_dir, should_cleanup_user_data)

    Profile rules:
      - USE_TEMP_PROFILE=1  -> always temp dir (cookies discarded)
      - USE_TEMP_PROFILE=0  + BROWSER_USER_DATA_DIR -> persistent profile
      - default: prefer BROWSER_USER_DATA_DIR when set (keep TG login)
    Incognito is OFF for persistent profiles (otherwise cookies never stick).
    """
    chrome_path = (
        os.environ.get("BROWSER_CHROME_PATH") or "/usr/bin/google-chrome"
    ).strip()
    proxy = (os.environ.get("BROWSER_PROXY") or "").strip()
    locale = (os.environ.get("BROWSER_LOCALE") or "en-US").strip() or "en-US"
    # Default False so panel-injected BROWSER_USER_DATA_DIR is actually used.
    # Old default True forced a fresh temp profile every run → TG never persisted.
    force_temp = env_flag("USE_TEMP_PROFILE", False)
    env_user_data_dir = (os.environ.get("BROWSER_USER_DATA_DIR") or "").strip()
    # Incognito kills cookie/session persistence; only allow when explicitly requested
    use_incognito = env_flag("BROWSER_INCOGNITO", False)

    should_cleanup = False
    if not user_data_dir and env_user_data_dir:
        # The panel may inject a per-run temporary profile together with
        # USE_TEMP_PROFILE=1. That directory is already panel-managed and must
        # not be replaced with a second /tmp profile, otherwise browser/session
        # state and the panel's runtime metadata point at different profiles.
        user_data_dir = env_user_data_dir
        log(
            f"browser profile: using panel-provided path {user_data_dir} "
            f"(USE_TEMP_PROFILE={int(force_temp)})"
        )

    if not user_data_dir:
        user_data_dir = tempfile.mkdtemp(prefix="dp_chrome_yolo_")
        should_cleanup = True
        log(f"browser profile: TEMP {user_data_dir}")
    else:
        os.makedirs(user_data_dir, exist_ok=True)
        # A panel-provided profile, including a per-run temporary one, is owned
        # and cleaned by the panel. Only locally-created profiles are removed
        # by close_browser().
        should_cleanup = bool(cleanup_user_data) if not env_user_data_dir else False
        log(f"browser profile: PERSISTENT {user_data_dir} cleanup={should_cleanup}")

    # Clear stale Chrome singleton locks that block reusing a persistent profile
    # (left behind when a previous run was SIGKILL'd). Safe no-op for temp dirs.
    if not should_cleanup and user_data_dir:
        for lock_name in ("SingletonLock", "SingletonCookie", "SingletonSocket", "lockfile"):
            lock_path = os.path.join(user_data_dir, lock_name)
            try:
                if os.path.exists(lock_path) or os.path.islink(lock_path):
                    os.unlink(lock_path)
                    log(f"removed stale profile lock: {lock_name}")
            except Exception as e:
                log(f"could not remove {lock_name}: {e}", "WARN")
        # Diagnose whether previous run wrote cookies into this profile
        for rel in (
            os.path.join("Default", "Cookies"),
            os.path.join("Default", "Network", "Cookies"),
            os.path.join("Default", "Cookies-journal"),
        ):
            p = os.path.join(user_data_dir, rel)
            if os.path.isfile(p):
                try:
                    st = os.stat(p)
                    log(
                        f"profile cookie file: {rel} size={st.st_size} "
                        f"mtime={time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(st.st_mtime))}"
                    )
                except Exception:
                    log(f"profile cookie file: {rel} (stat failed)")
            else:
                log(f"profile cookie file missing: {rel}", "WARN")

    # Minimal launch — copy your GitHub working pattern as closely as possible:
    #   co = ChromiumOptions()
    #   co.set_argument('--no-sandbox')
    #   co.set_argument('--disable-dev-shm-usage')
    #   co.set_argument('--disable-gpu')
    #   co.set_argument('--window-size=1280,900')
    #   co.set_user_data_path(PROFILE_DIR)
    #   if os.path.isdir(EXT): co.add_extension(EXT)
    #   page = ChromiumPage(addr_or_opts=co)
    #
    # DO NOT call auto_port() with persistent profiles — it rewrites
    # user-data-dir to /tmp/DrissionPage/autoPortData/<port>.
    # DO NOT call set_argument('--user-data-dir', path) two-arg form on this
    # DP build (causes: not enough values to unpack).
    # DO NOT also force --load-extension= after add_extension unless needed.
    co = ChromiumOptions()
    if chrome_path:
        try:
            co.set_browser_path(chrome_path)
        except Exception as e:
            log(f"set_browser_path failed: {e}", "WARN")

    for arg in (
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--window-size=1280,900",
        "--disable-popup-blocking",
        f"--lang={locale}",
        "--disable-blink-features=AutomationControlled",
        "--password-store=basic",
        "--use-mock-keychain",
    ):
        try:
            co.set_argument(arg)
        except Exception as e:
            log(f"set_argument({arg!r}) failed: {e}", "WARN")

    # Persistent profile — API only (sets path + internal flag correctly)
    try:
        co.set_user_data_path(user_data_dir)
        log(f"set_user_data_path OK: {user_data_dir}")
    except Exception as e:
        log(f"set_user_data_path failed: {e}", "ERROR")
        raise

    if proxy:
        try:
            co.set_proxy(proxy)
        except Exception as e:
            log(f"set_proxy failed: {e}", "WARN")
            try:
                co.set_argument(f"--proxy-server={proxy}")
            except Exception as e2:
                log(f"proxy arg failed: {e2}", "WARN")

    # Extensions — add_extension only (same as your NopeCHA script)
    loaded = []
    try:
        for d in discover_extension_dirs():
            ap = os.path.abspath(d)
            if not _is_extension_dir(ap):
                continue
            try:
                co.add_extension(ap)
                loaded.append(ap)
                log(f"加载扩展: {ap}")
            except Exception as e:
                log(f"add_extension 失败 {ap}: {e}", "ERROR")
        if loaded:
            log(f"共加载 {len(loaded)} 个扩展")
        else:
            log("未加载扩展（目录空或 WOIDEN_LOAD_EXTENSIONS=0）")
    except Exception as e:
        log(f"extension load block failed: {e}", "WARN")

    log(f"launching Chrome user-data-dir={user_data_dir!r} chrome={chrome_path!r}")
    try:
        page = ChromiumPage(addr_or_opts=co)
    except Exception as e:
        import traceback

        log(f"ChromiumPage launch failed: {e}", "ERROR")
        log(traceback.format_exc(), "ERROR")
        raise

    # Verify real chrome cmdline: user-data-dir + extension flags
    try:
        pid = getattr(page, "process_id", None)
        if hasattr(pid, "pid"):
            pid = pid.pid
        if not pid:
            try:
                pid = page.browser.process_id
            except Exception:
                pid = None
        if pid and os.path.exists(f"/proc/{int(pid)}/cmdline"):
            with open(f"/proc/{int(pid)}/cmdline", "rb") as f:
                cmd = f.read().replace(b"\x00", b" ").decode("utf-8", "ignore")
            for token in cmd.split():
                if "user-data-dir" in token.lower() or "extension" in token.lower():
                    log(f"cmdline: {token[:300]}")
            if "/tmp/DrissionPage/autoPortData" in cmd:
                log(
                    "BUG: Chrome still using /tmp/DrissionPage/autoPortData — profile NOT persistent",
                    "ERROR",
                )
            elif user_data_dir.replace("\\", "/") in cmd.replace("\\", "/"):
                log("Chrome user-data-dir matches persistent profile OK")
            if loaded and "load-extension" in cmd.lower():
                log("Chrome cmdline HAS --load-extension OK")
            elif loaded:
                log("Chrome cmdline MISSING --load-extension", "ERROR")
        else:
            log(f"chrome pid/cmdline unavailable (pid={pid!r})", "WARN")
    except Exception as e:
        log(f"post-launch cmdline check failed: {e}", "WARN")

    # Hard proof: open chrome://extensions and read page text.
    # cmdline flags alone are not enough — user reported ads still everywhere.
    if loaded:
        try:
            page.get("chrome://extensions/")
            time.sleep(2)
            # Expand developer mode details if present (best-effort)
            try:
                page.run_js(
                    """
                    const mgr = document.querySelector('extensions-manager');
                    if (!mgr || !mgr.shadowRoot) return 'no-manager';
                    const tb = mgr.shadowRoot.querySelector('extensions-toolbar');
                    if (tb && tb.shadowRoot) {
                      const tog = tb.shadowRoot.querySelector('#devMode');
                      if (tog && !tog.checked) tog.click();
                    }
                    return 'ok';
                    """
                )
            except Exception:
                pass
            time.sleep(0.5)
            info = page.run_js(
                """
                // chrome://extensions is all shadow DOM; scrape text from manager
                function deepText(root, depth) {
                  if (!root || depth > 8) return '';
                  let t = '';
                  try { t += (root.innerText || root.textContent || '') + '\\n'; } catch (e) {}
                  const kids = root.querySelectorAll ? root.querySelectorAll('*') : [];
                  for (const el of kids) {
                    if (el.shadowRoot) t += deepText(el.shadowRoot, depth + 1);
                  }
                  return t;
                }
                const mgr = document.querySelector('extensions-manager');
                const text = mgr ? deepText(mgr.shadowRoot || mgr, 0) : (document.body ? document.body.innerText : '');
                return {
                  href: location.href,
                  hasAdguard: /adguard/i.test(text),
                  hasUblock: /ublock|Woiden ad lite/i.test(text),
                  hasError: /error|无法|失败|corrupt|disabled/i.test(text),
                  sample: (text || '').replace(/\\s+/g, ' ').trim().slice(0, 400)
                };
                """
            )
            log(f"chrome://extensions check: {info!r}")
            # Also list Preferences Extensions settings if written
            try:
                pref = os.path.join(user_data_dir, "Default", "Preferences")
                secure = os.path.join(user_data_dir, "Default", "Secure Preferences")
                for p in (pref, secure):
                    if os.path.isfile(p):
                        with open(p, "r", encoding="utf-8", errors="ignore") as f:
                            raw = f.read()
                        if "adguard" in raw.lower() or "extensions" in raw.lower():
                            # crude: count extension ids mentioned
                            log(f"profile file has extensions data: {p} size={len(raw)}")
                        else:
                            log(f"profile file exists but no adguard string: {p}")
            except Exception as e:
                log(f"read Preferences failed: {e}", "WARN")
        except Exception as e:
            log(f"chrome://extensions inspection failed: {e}", "WARN")

    # Self-check: what profile Chrome actually opened
    try:
        actual = page.run_js(
            """
            // Chromium doesn't expose user-data-dir to JS; report cookies presence instead
            return {
              cookieLen: (document.cookie || '').length,
              href: location.href,
            };
            """
        )
        log(f"browser open self-check: {actual!r}")
    except Exception:
        pass

    try:
        # page_load kept modest: bare page.get on Woiden can still sit until this
        # budget even when DOM is ready. Prefer location.assign + poll in renew.py.
        page.set.timeouts(base=8, page_load=18, script=15)
    except Exception:
        pass

    _init_js = """
        // 1. 隐藏 webdriver
        Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
        
        // 2. 动态伪装 UA 和 Platform，保持真实的 Chrome 版本号防止特征不匹配
        const realUa = navigator.userAgent;
        const fakeUa = realUa.replace(/X11; Linux x86_64|X11; Ubuntu; Linux x86_64/, 'Windows NT 10.0; Win64; x64');
        Object.defineProperty(navigator, 'userAgent', {get: () => fakeUa});
        Object.defineProperty(navigator, 'platform', {get: () => 'Win32'});
        
        // 3. 伪造 Chrome 独有的 plugins 特征 (Linux Headless 经常为空)
        if (navigator.plugins.length === 0) {
            Object.defineProperty(navigator, 'plugins', {
                get: () => [
                    {name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format'},
                    {name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: 'Portable Document Format'},
                    {name: 'Native Client', filename: 'internal-nacl-plugin', description: ''}
                ]
            });
            Object.defineProperty(navigator, 'mimeTypes', {
                get: () => [
                    {type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format'}
                ]
            });
        }
        
        // 4. 掩盖 WebGL 软件渲染 (SwiftShader) 暴露
        const getParameter = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function(parameter) {
            if (parameter === 37445) return 'Google Inc. (NVIDIA)';
            if (parameter === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 Direct3D11 vs_5_0 ps_5_0, D3D11)';
            return getParameter.apply(this, [parameter]);
        };
        const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
        if (getParameter2) {
            WebGL2RenderingContext.prototype.getParameter = function(parameter) {
                if (parameter === 37445) return 'Google Inc. (NVIDIA)';
                if (parameter === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 Direct3D11 vs_5_0 ps_5_0, D3D11)';
                return getParameter2.apply(this, [parameter]);
            };
        }
        
        // 5. 伪造语言和硬件并发
        Object.defineProperty(navigator, 'languages', {get: () => ['zh-CN', 'zh', 'en']});
        Object.defineProperty(navigator, 'hardwareConcurrency', {get: () => 8});
        Object.defineProperty(navigator, 'deviceMemory', {get: () => 8});
    """
    injected = None
    try:
        page.run_cdp("Page.addScriptToEvaluateOnNewDocument", source=_init_js)
        injected = "run_cdp"
    except Exception as e1:
        try:
            page.add_init_js(_init_js)
            injected = "add_init_js"
        except Exception as e2:
            log(
                f"init script inject failed (run_cdp: {e1} / add_init_js: {e2}), fallback run_js",
                "WARN",
            )
    if not injected:
        try:
            page.run_js(_init_js)
            injected = "run_js(fallback)"
        except Exception:
            injected = "none"

    log(f"anti-detect inject path: {injected}")
    try:
        page.get("about:blank")
        wd = page.run_js("return navigator.webdriver;")
        log(f"anti-detect self-check navigator.webdriver = {wd!r}")
    except Exception as e:
        log(f"anti-detect self-check skipped: {e}", "WARN")

    # Block AdSense / trackers without extensions
    enable_ad_block(page)

    # Inject Hardware Fingerprints for Cloudflare bypass
    inject_hardware_fingerprint(page)

    return page, user_data_dir, should_cleanup


def close_browser(page, user_data_dir=None, cleanup=False):
    """Close browser gently so cookies flush into user-data-dir.

    Important for persistent profiles:
      - Do NOT SIGKILL immediately after quit — Chrome needs time to write Cookies/Network.
      - Only force-kill if process is still alive after a grace period.
      - Never delete user_data_dir unless cleanup=True (temp profiles only).
    """
    pid = None
    if page:
        try:
            if hasattr(page, "process_id"):
                pid = page.process_id
        except Exception:
            pid = None

        # Best-effort: visit a real Woiden origin so cookies for that host are dirty/flushed
        try:
            page.get("https://woiden.id/")
            time.sleep(1.0)
        except Exception:
            pass
        try:
            # CDP: force cookie flush if available
            page.run_cdp("Network.enable")
            # some builds support Storage / Browser close
        except Exception:
            pass
        try:
            page.get("about:blank")
        except Exception:
            pass
        time.sleep(1.0)

        try:
            # Prefer graceful quit (lets Chromium flush profile)
            # del_data=False is critical for persistent profiles
            try:
                page.quit(timeout=8, force=False, del_data=False)
            except TypeError:
                page.quit()
        except Exception:
            try:
                page.quit(force=True, del_data=False)
            except Exception:
                pass

        # Give Chromium time to write Cookies / Local Storage / Session Storage
        # (profile is often under /home/browser/... and disk flush is not instant)
        time.sleep(4.0)

        # Only force-kill if still hanging; never rmtree persistent profile
        if pid:
            try:
                import psutil

                if psutil.pid_exists(pid):
                    proc = psutil.Process(pid)
                    # try terminate first
                    try:
                        proc.terminate()
                        proc.wait(timeout=5)
                    except Exception:
                        pass
                    if psutil.pid_exists(pid):
                        log(f"Chrome pid={pid} still alive after quit — SIGKILL", "WARN")
                        try:
                            proc.kill()
                        except Exception:
                            pass
            except Exception:
                pass

    # Post-close diagnosis for persistent profiles
    if user_data_dir and not cleanup:
        for rel in (
            os.path.join("Default", "Cookies"),
            os.path.join("Default", "Network", "Cookies"),
        ):
            p = os.path.join(user_data_dir, rel)
            if os.path.isfile(p):
                try:
                    st = os.stat(p)
                    log(
                        f"after-close cookie file: {rel} size={st.st_size} "
                        f"mtime={time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(st.st_mtime))}"
                    )
                except Exception:
                    pass
            else:
                log(f"after-close cookie file missing: {rel}", "WARN")

    if cleanup and user_data_dir and os.path.exists(user_data_dir):
        # Only for TEMP profiles (caller passes cleanup=True)
        try:
            shutil.rmtree(user_data_dir, ignore_errors=True)
        except Exception:
            pass
