# Optional external captcha bank

Host2Play DP can call a **private sidecar** for static reCAPTCHA grid reuse.

This repository does **not** ship the bank, samples, or review UI.

## Enable (task or global env)

```text
CAPTCHA_BANK_URL=http://127.0.0.1:3920
CAPTCHA_BANK_TOKEN=<shared secret>
CAPTCHA_BANK_MATCH=1
CAPTCHA_BANK_RECORD=1
CAPTCHA_BANK_TIMEOUT_MS=2000
```

If `CAPTCHA_BANK_URL` is empty, behavior is unchanged (Vision only).

## Client

Runtime client (deployed with tasks on your server):

- `tasks/host2play_dp/captcha_bank_client.py`

Hooks:

- before static clicks → `match`
- after Verify success (vision path) → `record`
- after Verify when match was used → `report`

## Private service

Deploy separately (private git). Intranet for scripts; expose review UI yourself with your own auth (e.g. Cloudflare Access).

See your private `captcha-bank` README.
