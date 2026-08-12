# Automa Recorder (MVP)

This folder is an isolated project for a browser action recorder.

Goal:
- Record real user actions from a browser extension.
- Save to a language-neutral IR JSON.
- Export IR to runnable scripts:
  - Playwright (JavaScript)
  - SeleniumBase (Python)

This is intentionally separated from the main panel runtime so the current project stays stable.

## Structure

- `extension/` Chrome/Edge extension (Manifest V3)
- `exporter/` IR to script generators
- `ir/` IR schema docs
- `examples/` sample IR and exported outputs

## Quick Start

1. Load extension:
- Open `chrome://extensions`
- Enable `Developer mode`
- Click `Load unpacked`
- Select `automa-recorder/extension`

2. Record:
- Open any page
- Click the extension icon
- Press `Start`
- Do actions
- Press `Stop`
- Press `Save IR`

3. Export scripts:

```bash
cd automa-recorder
npm run export:playwright
npm run export:seleniumbase
```

Generated files:
- `examples/out.playwright.js`
- `examples/out.seleniumbase.py`

## Current Limits

- No captcha bypass automation.
- No full cross-origin iframe deep recording.
- Rich editor/canvas/drag interactions are not fully covered yet.
- Input steps are recorded from `change` events (not every key stroke).

## Recorder Capabilities (Current)

- Recorded step types:
  - `click`
  - `input`
  - `select`
  - `hover`
  - `press` (Enter / Tab / Escape)
  - `check` / `uncheck`
  - `scroll`
  - `wait` with strategy (`timeout`, `url_change`, `ready_state`, `selector`)
- Selector payload:
  - weighted primary order: stable `data-*` / `id` / `name` / `aria` > `role` > short css > anchored css > text > full css > xpath
  - fallback chain preserved in IR
  - noisy node targets (`svg/use/path`) are auto-lifted to useful clickable ancestors
  - obvious dynamic tokens are avoided where possible (long random id/class patterns)
- Basic dedup:
  - drop same-step bursts in a short window
  - scroll and hover throttling
- Sensitive values:
  - password / otp / token / secret-like fields are masked as `{{SECRET}}`

## Performance Behavior

- Content script listeners are mounted only when recording is active.
- When recording stops, listeners are removed to reduce page overhead.
- Recording state is broadcast from background to all tabs.

## Popup Editor (Current)

- Inline step edit:
  - type / selector / value / key / scroll coords / wait strategy fields
  - enable/disable
- Group actions:
  - collapse/expand
  - enable/disable all steps
  - delete group
  - rename group
  - merge group into another group (including `ungrouped`)
- Script utilities:
  - export Playwright / SeleniumBase files
  - preview generated Playwright / SeleniumBase scripts directly in popup

## Shared Export Logic

- Extension export now uses shared generator modules under `extension/shared/`.
- Browser extension and CLI exporter follow the same step semantics and selector normalization strategy.

## Regression Coverage (Current)

- Consistency tests under `tests/` now cover:
  - support vs exporter consistency
  - CLI smoke export
  - iframe/frame scope handling
  - selector target mapping (css/xpath/text/testid/role)
  - wait(selector) + turnstile token special path
- Real recorded-style IR smoke set:
  - `examples/real-samples/*.ir.json`
  - dual target generation check (Playwright + SeleniumBase)
- CI:
  - GitHub Actions workflow: `.github/workflows/automa-recorder-ci.yml`
  - runs `npm ci` + `npm test` inside `automa-recorder/`

## Next Iteration

- Add replay checker in extension (single-step and full flow dry run).
- Add dedicated selector fallback-chain editor with priority tuning.
- Add richer wait/assert blocks (network idle, response status, element detached).
- Add CI smoke checks for real recorded IR samples (playwright + seleniumbase).
