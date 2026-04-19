/**
 * OpenAI-compatible chat completions proxy (server-side only; key never sent to the browser).
 *
 * Zarewa does not embed a custom language model — it calls a provider you run or subscribe to.
 *
 * Cloud (OpenAI): ZAREWA_AI_API_KEY=sk-...  (or OPENAI_API_KEY)
 *   Optional: ZAREWA_AI_BASE_URL, ZAREWA_AI_MODEL (default gpt-4o-mini when base is OpenAI).
 *
 * Local (Ollama OpenAI shim): run `ollama serve`, then e.g.
 *   ZAREWA_AI_BASE_URL=http://127.0.0.1:11434/v1
 *   ZAREWA_AI_API_KEY=ollama
 *   ZAREWA_AI_MODEL=llama3.2   (optional if base URL uses port 11434 — default becomes llama3.2)
 * Other gateways: same pattern if they expose POST /v1/chat/completions.
 */

const MAX_MESSAGES = 20;
const MAX_CONTENT_PER_MESSAGE = 8000;
const MAX_CONTEXT_LEN = 500;
const MAX_RETRIEVED_CONTEXT_LEN = 12000;

function trimBaseUrl(raw) {
  return String(raw || '')
    .trim()
    .replace(/\/+$/, '');
}

/**
 * When `ZAREWA_AI_MODEL` is unset, pick a sane default for the configured base URL.
 * (There is no “trained model” inside Zarewa — this is only the provider’s model id string.)
 */
export function defaultChatModelIdForBaseUrl(baseUrl) {
  const u = String(baseUrl || '').trim().toLowerCase();
  if (/:11434(?:\/|$)/.test(u)) return 'llama3.2';
  return 'gpt-4o-mini';
}

export function readAiAssistConfig() {
  const apiKey = String(process.env.ZAREWA_AI_API_KEY || process.env.OPENAI_API_KEY || '').trim();
  const baseUrl = trimBaseUrl(process.env.ZAREWA_AI_BASE_URL || 'https://api.openai.com/v1');
  const envModel = String(process.env.ZAREWA_AI_MODEL || '').trim();
  const model = envModel || defaultChatModelIdForBaseUrl(baseUrl);
  return { enabled: Boolean(apiKey), apiKey, baseUrl, model };
}

export function chatCompletionsUrl(baseUrl) {
  const b = trimBaseUrl(baseUrl);
  if (!b) return 'https://api.openai.com/v1/chat/completions';
  return b.endsWith('/v1') ? `${b}/chat/completions` : `${b}/v1/chat/completions`;
}

/**
 * When true, requests use `response_format: { type: 'json_object' }` (OpenAI). Many local/Ollama gateways reject this — leave unset (default) unless you use OpenAI and want stricter JSON.
 * If the first request fails with 400, we automatically retry once without `response_format`.
 */
export function aiJsonObjectModeEnabled() {
  return String(process.env.ZAREWA_AI_JSON_OBJECT_MODE || '').trim() === '1';
}

/**
 * @param {{ apiKey: string, baseUrl: string, model: string }} cfg
 * @param {Record<string, unknown>} bodyPayload — model, messages, max_tokens, temperature; optional response_format added internally
 * @returns {Promise<{ ok: boolean, status: number, json: object | null, raw: string }>}
 */
export async function postChatCompletions(cfg, bodyPayload) {
  const url = chatCompletionsUrl(cfg.baseUrl);
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.apiKey}`,
  };

  const tryJson = aiJsonObjectModeEnabled();
  const withFormat =
    tryJson && !bodyPayload.response_format
      ? { ...bodyPayload, response_format: { type: 'json_object' } }
      : { ...bodyPayload };

  const doFetch = async (payload) => {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    const raw = await res.text();
    let json = null;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch {
      json = null;
    }
    return { res, raw, json };
  };

  let { res, raw, json } = await doFetch(withFormat);

  if (!res.ok && withFormat.response_format) {
    const errMsg = String(json?.error?.message || raw || '').toLowerCase();
    const retry =
      res.status === 400 ||
      res.status === 422 ||
      errMsg.includes('response_format') ||
      errMsg.includes('json_object') ||
      errMsg.includes('unknown parameter');
    if (retry) {
      const { response_format: _rf, ...rest } = withFormat;
      ({ res, raw, json } = await doFetch(rest));
    }
  }

  return { ok: res.ok, status: res.status, json, raw };
}

export function sanitizeClientMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const out = [];
  for (const m of messages.slice(-MAX_MESSAGES)) {
    const role = String(m?.role || '').toLowerCase();
    if (role !== 'user' && role !== 'assistant') continue;
    let content = String(m?.content ?? '');
    if (content.length > MAX_CONTENT_PER_MESSAGE) {
      content = `${content.slice(0, MAX_CONTENT_PER_MESSAGE)}…`;
    }
    content = content.trim();
    if (!content) continue;
    out.push({ role, content });
  }
  return out;
}

const MEMO_POLISH_MAX = 12_000;

/** Normalize OpenAI-style message.content (string or multimodal array). */
export function normalizeCompletionContent(message) {
  const c = message?.content;
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          if (part.type === 'text' && part.text != null) return String(part.text);
          if (typeof part.text === 'string') return part.text;
          if (typeof part.content === 'string') return part.content;
        }
        return '';
      })
      .join('');
  }
  return String(c);
}

/**
 * Parse {"subject","body"} from model output; tolerate markdown fences and surrounding text.
 * @param {string} rawText
 * @param {string} fallbackSubject
 * @param {string} fallbackBody
 */
export function parseMemoPolishJson(rawText, fallbackSubject, fallbackBody) {
  const text = String(rawText || '').trim();
  if (!text) {
    const err = new Error('Empty response from AI provider.');
    err.code = 'AI_EMPTY';
    throw err;
  }
  let stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    const i = stripped.indexOf('{');
    const j = stripped.lastIndexOf('}');
    if (i === -1 || j <= i) {
      const err = new Error('AI returned text that is not valid JSON.');
      err.code = 'AI_BAD_REQUEST';
      throw err;
    }
    try {
      parsed = JSON.parse(stripped.slice(i, j + 1));
    } catch {
      const err = new Error('AI returned text that is not valid JSON.');
      err.code = 'AI_BAD_REQUEST';
      throw err;
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    const err = new Error('AI returned invalid JSON shape.');
    err.code = 'AI_BAD_REQUEST';
    throw err;
  }
  const subRaw = parsed.subject != null ? String(parsed.subject).trim().slice(0, 500) : '';
  const bodRaw = parsed.body != null ? String(parsed.body).trim().slice(0, MEMO_POLISH_MAX) : '';
  const fbSub = String(fallbackSubject ?? '').trim().slice(0, 500);
  const fbBod = String(fallbackBody ?? '').trim().slice(0, MEMO_POLISH_MAX);
  const deriveSubject = (bodyText) => {
    const b = String(bodyText || '').trim();
    if (!b) return '';
    const line = b.split(/\r?\n/).find((l) => String(l || '').trim()) || '';
    return line.trim().slice(0, 500);
  };
  const nextBody = bodRaw.length > 0 ? bodRaw : fbBod;
  let nextSubject = subRaw.length > 0 ? subRaw : fbSub;
  if (!nextSubject && nextBody) nextSubject = deriveSubject(nextBody);
  if (!nextSubject && fbBod) nextSubject = deriveSubject(fbBod);
  return {
    subject: nextSubject,
    body: nextBody,
  };
}

export function buildSystemPrompt(context, userDisplay, opts = {}) {
  const ctx = String(context || '').trim().slice(0, MAX_CONTEXT_LEN);
  const who = String(userDisplay || '').trim().slice(0, 120);
  const mode = String(opts.mode || '').trim().toLowerCase();
  const retrievedContext = String(opts.retrievedContext || '').trim().slice(0, MAX_RETRIEVED_CONTEXT_LEN);
  const lines = [
    'You are a concise assistant for Zarewa System users (sales, procurement, operations, finance, HR).',
    'You cannot run actions in the app, mutate records, or approve anything. You are a read-only assistant.',
    'Explain concepts, summarize live workspace context when provided, suggest workflows, and help interpret terminology. For balances, tax, legal, disciplinary, or payroll-finalizing matters, tell the user to verify in the system or with qualified staff.',
    'Keep answers short unless the user asks for detail. Use clear headings or bullets when helpful.',
    'When live workspace context is provided, ground your answer in it and avoid making up records that are not shown.',
    'If the live context seems incomplete or missing, say so plainly instead of guessing.',
  ];
  if (who) lines.push(`The signed-in user is referred to as: ${who}.`);
  if (ctx) lines.push(`The user is currently viewing: ${ctx}.`);
  if (mode) lines.push(`Assistant mode: ${mode}.`);
  if (retrievedContext) {
    lines.push('Live workspace context from the server:');
    lines.push(retrievedContext);
  } else {
    lines.push('No live workspace context was supplied for this request.');
  }
  return lines.join('\n');
}

/**
 * @param {{ messages: unknown[], context?: string, userDisplay?: string, mode?: string, retrievedContext?: string }} opts
 * @returns {Promise<{ content: string }>}
 */
export async function runAiChat(opts) {
  const cfg = readAiAssistConfig();
  if (!cfg.enabled) {
    const err = new Error('AI assistant is not configured.');
    err.code = 'AI_DISABLED';
    throw err;
  }

  const sanitized = sanitizeClientMessages(opts.messages);
  if (sanitized.length === 0) {
    const err = new Error('Send at least one user message.');
    err.code = 'AI_BAD_REQUEST';
    throw err;
  }

  const system = buildSystemPrompt(opts.context, opts.userDisplay, {
    mode: opts.mode,
    retrievedContext: opts.retrievedContext,
  });
  const url = chatCompletionsUrl(cfg.baseUrl);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: 'system', content: system }, ...sanitized],
      max_tokens: 1200,
      temperature: 0.25,
    }),
  });

  const raw = await res.text();
  let json;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    const msg =
      (json && json.error && (json.error.message || json.error)) ||
      (raw ? raw.slice(0, 240) : '') ||
      `HTTP ${res.status}`;
    const err = new Error(String(msg));
    err.code = 'AI_UPSTREAM';
    throw err;
  }

  const content = normalizeCompletionContent(json?.choices?.[0]?.message);
  if (!String(content).trim()) {
    const err = new Error('Empty response from AI provider.');
    err.code = 'AI_EMPTY';
    throw err;
  }

  return { content: String(content) };
}

/**
 * Polish memo subject/body only; fixed system prompt (no user-controlled system text).
 * @param {{ subject: string, body: string }} opts
 */
export async function runOfficeMemoPolish(opts) {
  const cfg = readAiAssistConfig();
  if (!cfg.enabled) {
    const err = new Error('AI assistant is not configured.');
    err.code = 'AI_DISABLED';
    throw err;
  }
  const subject = String(opts?.subject ?? '').trim().slice(0, 500);
  const body = String(opts?.body ?? '').trim().slice(0, MEMO_POLISH_MAX);
  if (!subject && !body) {
    const err = new Error('Subject or message body is required.');
    err.code = 'AI_BAD_REQUEST';
    throw err;
  }

  const system = [
    'You improve internal office memos for grammar, clarity, and professional tone.',
    'Polish BOTH the subject line and the message body. The subject should stay concise (one line, like an email subject).',
    'Do not invent facts, people, amounts, dates, or references. Do not remove or alter numbers, IDs, or quoted text.',
    'Keep the same intent and level of detail.',
    'Return a single JSON object with keys "subject" and "body" (both strings). No markdown, no code fences.',
    'If the user left the subject empty, propose a short professional subject from the body.',
  ].join('\n');

  const user = [
    'Polish this memo. Respond with JSON only: {"subject":"...","body":"..."}',
    '',
    `SUBJECT:\n${subject || '(none — derive from body)'}`,
    '',
    `BODY:\n${body || '(none)'}`,
  ].join('\n');

  const reqPayload = {
    model: cfg.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_tokens: 4096,
    temperature: 0.2,
  };

  const { ok, status, json, raw } = await postChatCompletions(cfg, reqPayload);
  if (!ok) {
    const msg =
      (json && json.error && (json.error.message || json.error)) ||
      (raw ? raw.slice(0, 400) : '') ||
      `HTTP ${status}`;
    const err = new Error(String(msg));
    err.code = 'AI_UPSTREAM';
    throw err;
  }

  const content = normalizeCompletionContent(json?.choices?.[0]?.message);
  return parseMemoPolishJson(content, subject, body);
}

const FILING_TRANSCRIPT_MAX = 64_000;

const FILING_CATEGORY_KEYS = new Set([
  'fuel_request',
  'generator_repair',
  'machine_repair',
  'office_expense',
  'procurement',
  'hr_benefit',
  'logistics',
  'utilities',
  'other',
]);

/**
 * Parse filing extract JSON from model output.
 * @param {string} rawText
 */
export function parseOfficeFilingExtractJson(rawText) {
  const text = String(rawText || '').trim();
  if (!text) {
    const err = new Error('Empty response from AI provider.');
    err.code = 'AI_EMPTY';
    throw err;
  }
  let stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    const i = stripped.indexOf('{');
    const j = stripped.lastIndexOf('}');
    if (i === -1 || j <= i) {
      const err = new Error('AI returned text that is not valid JSON.');
      err.code = 'AI_BAD_REQUEST';
      throw err;
    }
    parsed = JSON.parse(stripped.slice(i, j + 1));
  }
  if (!parsed || typeof parsed !== 'object') {
    const err = new Error('AI returned invalid JSON shape.');
    err.code = 'AI_BAD_REQUEST';
    throw err;
  }

  let categoryKey = String(parsed.categoryKey || 'other')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
  if (!FILING_CATEGORY_KEYS.has(categoryKey)) categoryKey = 'other';

  const costRaw = parsed.costNgn;
  let costNgn = null;
  if (costRaw != null && costRaw !== '') {
    const n = Math.round(Number(costRaw));
    if (Number.isFinite(n) && n >= 0 && n < 1e12) costNgn = n;
  }

  const tags = Array.isArray(parsed.tags)
    ? parsed.tags.map((t) => String(t || '').trim()).filter(Boolean).slice(0, 16)
    : [];

  const keyFacts =
    parsed.keyFacts != null && typeof parsed.keyFacts === 'object' && !Array.isArray(parsed.keyFacts)
      ? parsed.keyFacts
      : {};

  return {
    categoryKey,
    categoryLabel: String(parsed.categoryLabel || categoryKey.replace(/_/g, ' ')).trim().slice(0, 200),
    summary: String(parsed.summary || '').trim().slice(0, 4000),
    costNgn,
    tags,
    keyFacts,
    followUp: String(parsed.followUp || '').trim().slice(0, 1500),
  };
}

/**
 * Structured “filing cabinet” extract from a full thread transcript (server-side only).
 * @param {{ threadSubject: string, transcript: string, relatedPaymentRequestId?: string }} opts
 */
export async function runOfficeThreadFilingExtract(opts) {
  const cfg = readAiAssistConfig();
  if (!cfg.enabled) {
    const err = new Error('AI assistant is not configured.');
    err.code = 'AI_DISABLED';
    throw err;
  }
  const threadSubject = String(opts?.threadSubject ?? '').trim().slice(0, 500);
  const transcript = String(opts?.transcript ?? '').trim().slice(0, FILING_TRANSCRIPT_MAX);
  const pr = String(opts?.relatedPaymentRequestId ?? '').trim();
  if (!transcript) {
    const err = new Error('Thread transcript is empty.');
    err.code = 'AI_BAD_REQUEST';
    throw err;
  }

  const system = [
    'You classify and summarize internal office memo threads for a filing / retrieval system.',
    'Extract only information that appears or is clearly implied in the transcript. Do not invent amounts, approvals, or people.',
    'If a Nigerian Naira amount is mentioned (₦, NGN, naira), put the best single number in costNgn; otherwise null.',
    'categoryKey must be one of: fuel_request, generator_repair, machine_repair, office_expense, procurement, hr_benefit, logistics, utilities, other.',
    'Return a single JSON object with keys: categoryKey, categoryLabel, summary (string), costNgn (number or null), tags (string array), keyFacts (object with optional string fields like vendor, item, quantityUnit, datesMentioned, approvalStatus, paymentRef), followUp (string, optional).',
    'summary should read like a filing card: what was requested, status if stated, and cost if known.',
  ].join('\n');

  const user = [
    `THREAD_SUBJECT: ${threadSubject || '(none)'}`,
    pr ? `LINKED_PAYMENT_REQUEST_ID: ${pr}` : '',
    '',
    'TRANSCRIPT (newest messages may be at the end):',
    transcript,
  ]
    .filter(Boolean)
    .join('\n');

  const reqPayload = {
    model: cfg.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_tokens: 2500,
    temperature: 0.15,
  };

  const { ok, status, json, raw } = await postChatCompletions(cfg, reqPayload);
  if (!ok) {
    const msg =
      (json && json.error && (json.error.message || json.error)) ||
      (raw ? raw.slice(0, 400) : '') ||
      `HTTP ${status}`;
    const err = new Error(String(msg));
    err.code = 'AI_UPSTREAM';
    throw err;
  }

  const content = normalizeCompletionContent(json?.choices?.[0]?.message);
  const parsed = parseOfficeFilingExtractJson(content);
  return { ...parsed, modelHint: cfg.model };
}
