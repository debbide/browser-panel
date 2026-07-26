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

// 1x1 PNG (transparent) — enough to probe vision endpoints without shipping assets.
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

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
    image: { ok: false, ms: null, supported: false, preview: '', detail: '' },
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
  if (testImage) {
    if (!model) {
      result.image.detail = '未填写 Model，跳过识图测试';
    } else {
      try {
        const body = {
          model,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:image/png;base64,${TINY_PNG_B64}`,
                  },
                },
                {
                  type: 'text',
                  text: 'This is a 1x1 test image. Reply with exactly one word: OK',
                },
              ],
            },
          ],
          temperature: 0,
          max_tokens: 32,
        };
        const res = await httpJson('POST', ep.chatUrl, {
          headers: authHeaders,
          body,
          timeoutMs: 45000,
        });
        result.image.ms = res.ms;
        if (res.ok) {
          const text = extractChatText(res.json);
          result.image.ok = true;
          result.image.supported = true;
          result.image.preview = text.slice(0, 120);
          result.image.detail = text
            ? `识图接口可用 · ${res.ms}ms · 回复: ${text.slice(0, 40)}`
            : `HTTP 200 但 content 为空 · ${res.ms}ms（部分模型仍可能可用）`;
        } else {
          result.image.ok = false;
          result.image.supported = false;
          const snippet = (res.text || '').slice(0, 200);
          result.image.detail = `HTTP ${res.status}: ${snippet}`;
          // Heuristic: common "vision not supported" phrases
          if (/vision|image|multimodal|not support|不支持/i.test(snippet)) {
            result.image.detail = `可能不支持图片: ${snippet}`;
          }
        }
      } catch (err) {
        result.image.ok = false;
        result.image.detail = err.message || String(err);
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
