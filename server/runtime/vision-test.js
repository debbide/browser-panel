/**
 * Vision channel diagnostics for the panel UI:
 *  1) connectivity + model list  (GET .../models)
 *  2) image understanding        (POST .../chat/completions with a tiny PNG)
 *
 * OpenAI-compatible APIs only (same contract as vision_common / scripts).
 */

'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

// Real 64x64 RGB PNG (red field, blue centre square). Degenerate 1x1/2x2 images get
// rejected with a bare HTTP 400 by several gateways, so the default probe is a normal image.
const PROBE_PNG_64_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAWUlEQVR42u3XMQ0AMAwEsUcSJOWPImCKoVOVyNIR8HjpqtEFAAAAAAAAAAAAAAAAAAAAAOArIKefAgAAAAAAAAAAAADYA3BkAAAAAAAAAAAAAAAAAAAAAKO6NR2BAAw6GngAAAAASUVORK5CYII=';
// Legacy 2x2 probe, kept as a last-resort shape for gateways that cap image bytes hard.
const PROBE_PNG_2X2_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR42mP8z8BQz0A0YMQo+M8ABYwD/Qb9fQAAAABJRU5ErkJggg==';
const PROBE_TEXT = 'Describe this image in one short English word only.';

/**
 * Model field may list alternatives ("a,b" / "a|b"), and a single id may be
 * vendor-prefixed ("x-ai/grok-4"). Keep the FULL id first — OpenRouter / one-api style
 * relays only accept the prefixed form — then fall back to the bare tail segment.
 */
function splitModelCandidates(modelField) {
  const raw = String(modelField || '').trim();
  if (!raw) return [];
  const listed = raw.split(/[|,，、]+/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  const seen = new Set();
  const push = (id) => {
    const v = String(id || '').trim();
    if (!v || seen.has(v)) return;
    seen.add(v);
    out.push(v);
  };
  for (const id of (listed.length ? listed : [raw])) {
    push(id);
    if (id.includes('/')) push(id.split('/').pop());
  }
  return out;
}

function trimSlash(s) {
  return String(s || '').trim().replace(/\/+$/, '');
}

/** Derive API root and chat/completions URL from user-entered base. */
function resolveEndpoints(baseUrl) {
  let raw = trimSlash(baseUrl);
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;

  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }

  let pathname = (u.pathname || '').replace(/\/+$/, '') || '';
  // If user pasted full .../chat/completions, strip to root for /models.
  if (/\/chat\/completions$/i.test(pathname)) {
    pathname = pathname.replace(/\/chat\/completions$/i, '');
  }
  // Common: .../v1
  const rootPath = pathname || '';
  const root = `${u.origin}${rootPath}`;
  const modelsUrl = `${root}/models`;
  const chatUrl = /\/chat\/completions$/i.test(raw)
    ? raw
    : `${root}/chat/completions`;
  return { root, modelsUrl, chatUrl, origin: u.origin };
}

function httpJson(method, urlStr, { headers = {}, body = null, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch (e) {
      reject(new Error(`Invalid URL: ${urlStr}`));
      return;
    }
    const lib = u.protocol === 'http:' ? http : https;
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const reqHeaders = { ...headers };
    if (payload) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = String(payload.length);
    }
    const started = Date.now();
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: `${u.pathname}${u.search || ''}`,
        method,
        headers: reqHeaders,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const ms = Date.now() - started;
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            ms,
            text: text.slice(0, 2000),
            json,
          });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout after ${timeoutMs}ms`));
    });
    req.on('error', (err) => reject(err));
    if (payload) req.write(payload);
    req.end();
  });
}

function latencyLabel(ms) {
  if (ms == null || !Number.isFinite(ms)) return '';
  if (ms < 1500) return '快';
  if (ms < 4000) return '一般';
  if (ms < 8000) return '偏慢';
  return '很慢';
}

function extractModelIds(json) {
  const ids = [];
  const arr = json && Array.isArray(json.data) ? json.data : Array.isArray(json) ? json : [];
  for (const item of arr) {
    if (!item) continue;
    const id = typeof item === 'string' ? item : item.id || item.name || item.model;
    if (id) ids.push(String(id));
  }
  // de-dupe preserve order
  const seen = new Set();
  return ids.filter((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function extractChatText(json) {
  try {
    const msg = json?.choices?.[0]?.message || {};
    const content = (msg.content || msg.text || '').toString().trim();
    const reasoning = (msg.reasoning_content || '').toString().trim();
    return content || reasoning || '';
  } catch {
    return '';
  }
}

/**
 * @param {{ baseUrl: string, apiKey: string, model?: string }} channel
 * @param {{ fetchModels?: boolean, testImage?: boolean, model?: string }} opts
 */
async function testVisionChannel(channel, opts = {}) {
  const baseUrl = String(channel.baseUrl || '').trim();
  const apiKey = String(channel.apiKey || '').trim();
  const model = String(opts.model || channel.model || '').trim();
  const fetchModels = opts.fetchModels !== false;
  const testImage = opts.testImage !== false;

  const result = {
    ok: false,
    baseUrl,
    model: model || null,
    connectivity: { ok: false, ms: null, label: '', detail: '' },
    models: { ok: false, count: 0, ids: [], detail: '' },
    image: {
      ok: false,
      ms: null,
      supported: false,
      preview: '',
      detail: '',
      shape: '',
      tried: [],
      textOnly: null,
      modelInList: null,
    },
    summary: '',
  };

  if (!baseUrl) {
    result.summary = '缺少 Base URL';
    result.connectivity.detail = result.summary;
    return result;
  }
  if (!apiKey) {
    result.summary = '缺少 API Key（表单留空且未保存过 key）';
    result.connectivity.detail = result.summary;
    return result;
  }

  const ep = resolveEndpoints(baseUrl);
  if (!ep) {
    result.summary = 'Base URL 无效';
    result.connectivity.detail = result.summary;
    return result;
  }

  const authHeaders = { Authorization: `Bearer ${apiKey}` };

  // ----- 1) connectivity + models -----
  if (fetchModels) {
    try {
      const res = await httpJson('GET', ep.modelsUrl, {
        headers: authHeaders,
        timeoutMs: 20000,
      });
      result.connectivity.ms = res.ms;
      result.connectivity.label = latencyLabel(res.ms);
      if (res.ok) {
        result.connectivity.ok = true;
        result.connectivity.detail = `HTTP ${res.status} · ${res.ms}ms`;
        const ids = extractModelIds(res.json);
        result.models.ok = true;
        result.models.count = ids.length;
        result.models.ids = ids.slice(0, 100);
        result.models.detail = ids.length
          ? `读到 ${ids.length} 个模型`
          : '连通成功，但 /models 列表为空（仍可手填模型）';
      } else {
        result.connectivity.ok = false;
        result.connectivity.detail = `HTTP ${res.status}: ${(res.text || '').slice(0, 180)}`;
        result.models.detail = result.connectivity.detail;
        // Some gateways have no /models — still try chat if model given
        if (res.status === 404 && model) {
          result.connectivity.ok = true;
          result.connectivity.detail = `/models 404，将仅测试 chat（${res.ms}ms）`;
          result.models.detail = '接口无 /models，跳过列表';
        }
      }
    } catch (err) {
      result.connectivity.ok = false;
      result.connectivity.detail = err.message || String(err);
      result.models.detail = result.connectivity.detail;
    }
  }

  // ----- 2) image chat -----
  // 400 Upstream error often means bad probe payload (1x1 image / model id / max_tokens),
  // NOT "provider has no vision". Retry a few shapes before concluding failure.
  if (testImage) {
    if (!model) {
      result.image.detail = '未填写 Model，跳过识图测试';
    } else {
      const modelCandidates = splitModelCandidates(model);
      const listedIds = Array.isArray(result.models.ids) ? result.models.ids : [];
      if (listedIds.length) {
        result.image.modelInList = modelCandidates.some((mid) => listedIds.includes(mid));
      }

      const imgPart = (b64, detail) => ({
        type: 'image_url',
        image_url: detail
          ? { url: `data:image/png;base64,${b64}`, detail }
          : { url: `data:image/png;base64,${b64}` },
      });
      const txtPart = (text) => ({ type: 'text', text });

      // Ordered most-compatible first. A bare body (no sampling params) is what thin
      // web-API relays accept — several reject max_tokens/temperature with a plain 400.
      const variants = [
        {
          tag: 'png64 bare',
          build: (mid) => ({
            model: mid,
            messages: [{ role: 'user', content: [imgPart(PROBE_PNG_64_B64), txtPart(PROBE_TEXT)] }],
          }),
        },
        {
          tag: 'png64 text-first detail=low',
          build: (mid) => ({
            model: mid,
            messages: [{ role: 'user', content: [txtPart(PROBE_TEXT), imgPart(PROBE_PNG_64_B64, 'low')] }],
          }),
        },
        {
          tag: 'png64 max_tokens=256 temp=0',
          build: (mid) => ({
            model: mid,
            messages: [{ role: 'user', content: [imgPart(PROBE_PNG_64_B64), txtPart(PROBE_TEXT)] }],
            temperature: 0,
            max_tokens: 256,
          }),
        },
        {
          tag: 'png2x2 max_tokens=128',
          build: (mid) => ({
            model: mid,
            messages: [{ role: 'user', content: [imgPart(PROBE_PNG_2X2_B64), txtPart(PROBE_TEXT)] }],
            max_tokens: 128,
          }),
        },
      ];

      const attempts = [];
      for (const mid of modelCandidates.slice(0, 3)) {
        for (const v of variants) {
          attempts.push({ label: `model=${mid} · ${v.tag}`, body: v.build(mid) });
        }
      }

      let lastFail = '';
      const tried = result.image.tried;
      let authBlocked = false;
      for (const attempt of attempts.slice(0, 8)) {
        try {
          const res = await httpJson('POST', ep.chatUrl, {
            headers: authHeaders,
            body: attempt.body,
            timeoutMs: 60000,
          });
          result.image.ms = res.ms;
          if (res.ok) {
            const text = extractChatText(res.json);
            result.image.ok = true;
            result.image.supported = true;
            result.model = attempt.body.model;
            result.image.shape = attempt.label;
            result.image.preview = text.slice(0, 120);
            result.image.detail = text
              ? `识图接口可用 · ${res.ms}ms · ${attempt.label} · 回复: ${text.slice(0, 40)}`
              : `HTTP 200 但 content 为空 · ${res.ms}ms（${attempt.label}）`;
            tried.push({ label: attempt.label, status: res.status, detail: text.slice(0, 60) || '(空 content)' });
            break;
          }
          const snippet = (res.text || '').slice(0, 240);
          lastFail = `HTTP ${res.status}: ${snippet}`;
          tried.push({ label: attempt.label, status: res.status, detail: snippet });
          // Auth errors: no point retrying other shapes with same key
          if (res.status === 401 || res.status === 403) {
            authBlocked = true;
            result.image.ok = false;
            result.image.supported = false;
            result.image.detail = lastFail;
            break;
          }
          // Keep trying other model names / body shapes on 400
          result.image.detail = lastFail;
        } catch (err) {
          lastFail = err.message || String(err);
          tried.push({ label: attempt.label, status: 0, detail: lastFail });
          result.image.detail = lastFail;
        }
      }

      // Control probe: plain text, same model/route. Without this a 400 cannot be told
      // apart from "this relay is broken for every request", which reads as "no vision".
      if (!result.image.ok && tried.length && !authBlocked) {
        try {
          const res = await httpJson('POST', ep.chatUrl, {
            headers: authHeaders,
            body: {
              model: modelCandidates[0],
              messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
            },
            timeoutMs: 30000,
          });
          result.image.textOnly = {
            ok: res.ok,
            status: res.status,
            detail: res.ok
              ? `纯文本可用 · ${res.ms}ms · 回复: ${extractChatText(res.json).slice(0, 30)}`
              : `HTTP ${res.status}: ${(res.text || '').slice(0, 180)}`,
          };
        } catch (err) {
          result.image.textOnly = { ok: false, status: 0, detail: err.message || String(err) };
        }
      }

      if (!result.image.ok && tried.length) {
        result.image.ok = false;
        result.image.supported = false;
        const snip = result.image.detail || lastFail || '';
        const textOnly = result.image.textOnly;
        if (authBlocked) {
          result.image.detail = snip;
        } else if (textOnly && textOnly.ok) {
          result.image.detail =
            `${snip}（对照：同模型纯文本可用 → 被拒的是图片本身。该中转多半不支持内联 data-url 图，`
            + `或上游要求先上传图片再引用；业务脚本走同一路由时识图同样会失败）`;
        } else if (textOnly && !textOnly.ok) {
          result.image.detail =
            `${snip}（对照：同模型纯文本也失败 → 与图片无关。该 id 可能只在 /models 里列出但未开通，`
            + `或此中转的 chat/completions 路由本身不通：${textOnly.detail}）`;
        } else if (result.image.modelInList === false) {
          result.image.detail = `${snip}（该模型名不在 /models 列表内，先从下方可用模型里点一个填入）`;
        } else if (/vision|image|multimodal|not support|不支持/i.test(snip)) {
          result.image.detail = `可能不支持图片: ${snip}`;
        }
      }
    }
  }

  const parts = [];
  if (result.connectivity.ok) {
    parts.push(`连通正常(${result.connectivity.ms ?? '?'}ms${result.connectivity.label ? ', ' + result.connectivity.label : ''})`);
  } else {
    parts.push(`连通失败: ${result.connectivity.detail}`);
  }
  if (result.models.ok || result.models.count) {
    parts.push(result.models.detail || `模型 ${result.models.count}`);
  } else if (fetchModels && result.models.detail) {
    parts.push(result.models.detail);
  }
  if (testImage) {
    if (result.image.supported) {
      parts.push(`图片识别支持(模型: ${model})`);
    } else if (model) {
      parts.push(`图片识别未通过: ${result.image.detail}`);
    }
  }
  if (result.connectivity.ok && (result.image.supported || !testImage || !model)) {
    parts.push('可用于面板 Vision 任务');
  }
  result.ok = Boolean(
    result.connectivity.ok && (!testImage || !model || result.image.supported || result.image.ok)
  );
  // Stricter: if image was requested with a model, require image ok for overall ok
  if (testImage && model) {
    result.ok = Boolean(result.connectivity.ok && result.image.ok);
  }
  result.summary = parts.filter(Boolean).join('；');

  return result;
}

module.exports = {
  testVisionChannel,
  resolveEndpoints,
  extractModelIds,
};
