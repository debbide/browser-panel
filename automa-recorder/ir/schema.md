# IR Schema (MVP)

```json
{
  "version": "1.0",
  "meta": {
    "name": "task-name",
    "created_at": "2026-05-04T00:00:00.000Z",
    "start_url": "https://example.com"
  },
  "steps": [
    {
      "id": "step-1",
      "type": "goto",
      "url": "https://example.com/login"
    },
    {
      "id": "step-2",
      "type": "click",
      "selector": {
        "primary": "css",
        "value": "#login-btn",
        "fallbacks": []
      }
    },
    {
      "id": "step-3",
      "type": "input",
      "selector": {
        "primary": "css",
        "value": "#email",
        "fallbacks": []
      },
      "value": "user@example.com"
    },
    {
      "id": "step-4",
      "type": "wait",
      "wait_for": "url_change",
      "timeout_ms": 12000,
      "fallback_ms": 1200,
      "group": "post-navigation",
      "comment": "auto wait(url_change) after navigation-like click"
    }
  ]
}
```

## Wait Step Strategy Fields

- `wait_for`: `timeout` | `url_change` | `ready_state` | `selector`
- `ms`: used when `wait_for=timeout`
- `timeout_ms`: used by `url_change` / `ready_state` / `selector`
- `fallback_ms`: optional fallback delay for `selector`
- `selector`: required for `wait_for=selector`

## Supported Step Types (MVP)

- `goto`
- `click`
- `input`
- `wait`
- `scroll`
- `hover`
- `press`
- `select`
- `check`
- `uncheck`
- `assert_url_contains`
- `assert_text`
- `screenshot`
