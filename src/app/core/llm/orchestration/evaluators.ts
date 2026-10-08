import { ChatMessage } from '../../../models/chat';
import {
  extractLlmImages,
  extractLlmRefusal
} from '../llm-message';
import { extractLlmDelta } from '../llm-sse';
import type { LlmChunk } from '../llm-sse';
import { errorSlot, makeSlot, partialSlot, refusedSlot } from './slots';
import type { EvalSlots, PictureDescription, Slot } from './types';

/**
 * Response evaluators — PURE functions. They never throw, never mutate the
 * chat, never decide continuations. They only turn raw responses (or errors)
 * into named slots. Use-case policies read the slots to decide the next
 * intents. This is what keeps every use case independent of how errors
 * occur: an error is just another slot status.
 */

// ---------------------------------------------------------------------------
// Description parsing (ported from the planning pass)
// ---------------------------------------------------------------------------

const DESCRIPTION_KEYS = ['description', 'text', 'prompt', 'scene', 'caption', 'desc', 'image', 'picture', 'frame'];

/** Top-level object keys that may hold the list of picture descriptions. */
const DESCRIPTION_ARRAY_KEYS = ['pictures', 'descriptions', 'scenes', 'images'];

function descriptionFromEntry(x: unknown): string | null {
  if (x == null) return null;
  if (typeof x === 'string') {
    const t = x.trim();
    return t && t !== '[object Object]' ? t : null;
  }
  if (Array.isArray(x)) {
    // A one-element wrapper around a real description (e.g. [{ "description": "…" }]).
    if (x.length === 1) return descriptionFromEntry(x[0]);
    return null;
  }
  if (typeof x === 'object') {
    const obj = x as Record<string, unknown>;
    for (const k of DESCRIPTION_KEYS) {
      const v = obj[k];
      if (typeof v === 'string') {
        const t = v.trim();
        if (t && t !== '[object Object]') return t;
      } else if (v && typeof v === 'object') {
        const inner = descriptionFromEntry(v);
        if (inner) return inner;
      }
    }
  }
  return null;
}

/** Parse a JSON string strictly; returns the value or null. */
function parseJson(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Recursively collect the picture descriptions from a parsed JSON value.
 * The planning model is instructed to return `{"pictures": [...]}` — cover
 * the realistic shapes it actually emits:
 *  - the full object (as prompted),
 *  - a bare array at the top level (models often drop the wrapper),
 *  - a DOUBLE-ENCODED list: the `pictures` value is itself a JSON string
 *    (`"[\"desc 1\", ...]"`) instead of a real array,
 *  - a map keyed `0..n` instead of an array.
 */
function descriptionsFromValue(v: unknown): string[] | null {
  if (typeof v === 'string') {
    // Double-encoded: the JSON text is embedded in a string value.
    const t = v.trim();
    if (t.startsWith('[') || t.startsWith('{')) {
      return descriptionsFromValue(parseJson(t));
    }
    return null;
  }
  if (Array.isArray(v)) {
    const arr = v.map(descriptionFromEntry).filter((s): s is string => !!s);
    return arr.length ? arr : null;
  }
  if (v && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    for (const k of DESCRIPTION_ARRAY_KEYS) {
      const inner = descriptionsFromValue(obj[k]);
      if (inner) return inner;
    }
    // Some models hand back a map keyed 0..n rather than a real array.
    if (Object.keys(obj).length > 0) {
      const byIndex: string[] = [];
      for (let i = 0; i < 64; i++) {
        const s = descriptionFromEntry(obj[String(i)]);
        if (!s) break;
        byIndex.push(s);
      }
      if (byIndex.length > 0) return byIndex;
    }
  }
  return null;
}

/**
 * Find a balanced JSON `{...}` object or `[...]` array inside surrounding
 * prose (string-aware, so brackets inside a description do not break the
 * scan) and parse it. Returns the parsed value, or null.
 */
function parseJsonEmbedded(text: string): unknown | null {
  for (const open of ['{', '['] as const) {
    const close = open === '{' ? '}' : ']';
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== open) continue;
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let j = i; j < text.length; j++) {
        const ch = text[j];
        if (inString) {
          if (escaped) { escaped = false; continue; }
          if (ch === '\\') { escaped = true; continue; }
          if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === open) depth++;
        else if (ch === close) {
          depth--;
          if (depth === 0) {
            const parsed = parseJson(text.slice(i, j + 1));
            if (parsed != null) return parsed;
            break;
          }
        }
      }
    }
  }
  return null;
}

function parsePictureDescriptions(content: string): (string | null)[] {
  const trimmed = (content || '').trim();
  if (!trimmed) return [];
  const fenced = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '');

  let value = parseJson(fenced) ?? parseJson(trimmed);
  if (value == null) value = parseJsonEmbedded(trimmed);

  let arr = value == null ? null : descriptionsFromValue(value);
  if (!arr) {
    arr = fenced
      .split(/\r?\n/)
      .map(s => s.replace(/^\s*(?:\d+[.)]?|[-•*])\s*/, '').trim())
      .filter(s => s.length > 0);
    if (!arr.length) return [];
  }
  return arr.map(s => (s && s.trim()) ? s.trim() : null);
}

// ---------------------------------------------------------------------------
// Moderation detection (ported): provider error → readable reason | null
// ---------------------------------------------------------------------------

const MODERATION_HINT_PATTERNS = [
  /content[\s_-]*m[oö]derat/i,
  /\bmoderat(?:ed|ion)?\b/i,
  /content[\s_-]*policy[\s_-]*violation/i,
  /inappropriate\s+content/i,
  /unsafe\s+content/i,
];

function moderationTextFrom(candidate: unknown): string | null {
  if (!candidate || typeof candidate !== 'object') return null;
  const o = candidate as Record<string, any>;
  for (const key of ['error', 'message']) {
    const v = o[key];
    if (typeof v === 'string' && v.trim() && !/Provider returned error/i.test(v)) {
      return v.trim();
    }
  }
  const details = o['details'];
  if (details && typeof details === 'object') {
    for (const key of ['Moderation Reasons', 'moderation_reasons', 'reasons', 'reason', 'labels', 'classified_labels', 'categories']) {
      const v = (details as Record<string, any>)[key];
      if (Array.isArray(v) && v.length) return v.map(String).join(', ');
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (v && typeof v === 'object') {
        const hits: string[] = [];
        for (const [k, val] of Object.entries(v)) {
          if (val === true) hits.push(k);
        }
        if (hits.length) return hits.join(', ');
      }
    }
  }
  for (const key of ['reason', 'moderation_reasons', 'Moderation Reasons', 'labels', 'categories']) {
    const v = o[key];
    if (Array.isArray(v) && v.length) return v.map(String).join(', ');
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  if (typeof o['status'] === 'string' && /moderat/i.test(o['status'])) {
    return o['status'].trim();
  }
  return null;
}

function moderationReasonFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, any>;
  const error = (p['error'] && typeof p['error'] === 'object') ? p['error'] : undefined;
  const plainError = typeof p['error'] === 'string' ? p['error'] : undefined;
  const rawMeta = error?.['metadata']?.['raw'];
  let provider: unknown;
  if (typeof rawMeta === 'string') {
    try { provider = JSON.parse(rawMeta); } catch { provider = undefined; }
  } else if (rawMeta && typeof rawMeta === 'object') {
    provider = rawMeta;
  }
  for (const candidate of [provider, error, p]) {
    const reason = moderationTextFrom(candidate);
    if (reason) return reason;
  }
  if (plainError && !/Provider returned error/i.test(plainError)) return plainError.trim();
  return null;
}

/** True when a transport error is a content-moderation rejection → usable as `refused`. */
export function isContentModeration(raw: unknown): boolean {
  let rawText: string;
  if (typeof raw === 'string') rawText = raw;
  else if (raw instanceof Error) rawText = String(raw.message ?? raw);
  else rawText = JSON.stringify(raw ?? '');
  return MODERATION_HINT_PATTERNS.some(re => re.test(rawText));
}

/** Extract a readable moderation reason from a transport error, or null. */
export function moderationReason(raw: unknown): string | null {
  if (!isContentModeration(raw)) return null;
  let rawText: string;
  if (typeof raw === 'string') rawText = raw;
  else if (raw instanceof Error) rawText = String(raw.message ?? raw);
  else rawText = JSON.stringify(raw ?? '');

  const candidates: unknown[] = [];
  if (raw && typeof raw === 'object') candidates.push(raw);
  const brace = rawText.indexOf('{');
  if (brace >= 0) {
    try { candidates.push(JSON.parse(rawText.slice(brace))); } catch { /* keep going */ }
  }
  for (const candidate of candidates) {
    const reason = moderationReasonFromPayload(candidate);
    if (reason) return reason;
  }
  return 'Content policy: the provider rejected the picture request.';
}

// ---------------------------------------------------------------------------
// Evaluators
// ---------------------------------------------------------------------------

export interface EvaluateArgs {
  /** The raw response body (JSON) of a completion or images call. */
  raw?: unknown;
  /** Transport error, when the call failed (non-2xx, network, timeout). */
  error?: { status: number; text: string };
  /** True when the call was aborted (caller or internal timeout). */
  aborted?: boolean;
  /** The exact prompt sent (kept as provenance on image slots). */
  prompt?: string;
  /** Scene number this response belongs to (1-based). */
  scene?: number;
}

/**
 * Evaluate a chat-completions response that may carry TEXT, THINKING,
 * IMAGES (generated) or an embedded descriptions list. Always fills slots;
 * never throws.
 */
export function evaluateCompletion(args: EvaluateArgs): EvalSlots {
  const out: EvalSlots = {};

  // Failure / abort → error or refused slot. The SAME path, no branching.
  if (args.aborted) {
    out.error = errorSlot('aborted', args.error?.text ?? 'aborted');
    return out;
  }
  if (args.error) {
    const mod = moderationReason(args.error.text ?? args.error);
    if (mod) {
      out.images = refusedSlot<import('../llm-message').LlmImagePart[]>(mod, { prompt: args.prompt });
    } else {
      out.error = errorSlot('http', `${args.error.status}: ${args.error.text}`);
    }
    // We still surface any text/thinking the transport may have captured.
    return out;
  }

  // Success. One response may contain text + thinking + images.
  const delta = extractLlmDelta(args.raw);
  const content = delta.content.trim();
  const thinking = delta.thinking.trim();
  const images = extractLlmImages(args.raw);

  if (content) {
    out.text = makeSlot('ok', content, undefined, { scene: args.scene });
  } else if (images.length === 0) {
    const refusal = extractLlmRefusal(args.raw);
    out.text = refusedSlot<string>(refusal || '(no text response)', { scene: args.scene });
  }
  if (thinking) {
    out.thinking = makeSlot('ok', thinking, undefined, { scene: args.scene });
  }
  if (images.length > 0) {
    out.images = makeSlot('ok', images, undefined, { prompt: args.prompt, scene: args.scene });
  } else {
    out.images = refusedSlot<import('../llm-message').LlmImagePart[]>(refusalText(args.raw), { prompt: args.prompt, scene: args.scene });
  }
  return out;
}

function refusalText(raw: unknown): string {
  return extractLlmRefusal(raw) || '(no image returned)';
}

/**
 * Evaluate an OpenAI-Images response (`{ data: [{ b64_json | url }] }`).
 * Also accepts any chat-completion-like raw (extractLlmImages understands
 * both), filling the `images` slot.
 */
export function evaluateImagesResponse(args: EvaluateArgs): EvalSlots {
  const out: EvalSlots = {};
  if (args.aborted) {
    out.error = errorSlot('aborted', args.error?.text ?? 'aborted');
    return out;
  }
  if (args.error) {
    const mod = moderationReason(args.error.text ?? args.error);
    if (mod) {
      out.images = refusedSlot<import('../llm-message').LlmImagePart[]>(mod, { prompt: args.prompt, scene: args.scene });
    } else {
      out.error = errorSlot('http', `${args.error.status}: ${args.error.text}`);
    }
    return out;
  }
  const images = extractLlmImages(args.raw);
  out.images = images.length
    ? makeSlot('ok', images, undefined, { prompt: args.prompt, scene: args.scene })
    : refusedSlot<import('../llm-message').LlmImagePart[]>(refusalText(args.raw), { prompt: args.prompt, scene: args.scene });
  return out;
}

/**
 * Evaluate the PLANNING pass response: a text answer expected to contain a
 * JSON list of picture descriptions (plain strings or objects). Fills the
 * `descriptions` slot; a failed/empty parse yields a refused slot (use cases
 * then fall back to a generic per-scene instruction — decided by the POLICY,
 * not here).
 */
export function evaluateDescriptions(args: EvaluateArgs): EvalSlots {
  const out: EvalSlots = {};
  if (args.aborted) {
    out.error = errorSlot('aborted', args.error?.text ?? 'aborted');
    return out;
  }
  if (args.error) {
    // Planning is best-effort: refuse, never hard-error (policy falls back).
    out.descriptions = refusedSlot<PictureDescription[]>('Planning failed.', {});
    return out;
  }
  const delta = extractLlmDelta(args.raw);
  const content = delta.content.trim() || extractLlmRefusal(args.raw);
  const parsed = parsePictureDescriptions(content).filter((s): s is string => !!s);
  if (parsed.length === 0) {
    out.descriptions = refusedSlot<PictureDescription[]>('Planning returned nothing usable.');
    return out;
  }
  out.descriptions = makeSlot('ok', parsed.map((text, index) => ({ text, index })), undefined, {});
  return out;
}

// ---------------------------------------------------------------------------
// Streaming evaluators (the SSE constraint: data reaches the node DURING)
// ---------------------------------------------------------------------------

/**
 * Pure fold: append one SSE chunk onto the running text/thinking slots.
 * Keeps status 'partial' until finalize(). Use case / transport call this
 * per chunk; a view adapter (today the reveal pump) paints the node from the
 * partial slots.
 */
export function foldStreamChunk(running: EvalSlots, chunk: LlmChunk): EvalSlots {
  const next: EvalSlots = { ...running };
  if (chunk.content) {
    const prev = running.text;
    const text = (prev?.value ?? '') + chunk.content;
    next.text = partialSlot(text);
  }
  if (chunk.thinking) {
    const prev = running.thinking;
    const thinking = (prev?.value ?? '') + chunk.thinking;
    next.thinking = partialSlot(thinking);
  }
  return next;
}

/**
 * Settle a running partial stream into its final slots (text ok/refused/error,
 * plus any images the non-stream tail may carry). Never throws.
 */
export function finalizeStream(running: EvalSlots, args: EvaluateArgs): EvalSlots {
  const out: EvalSlots = { ...running };
  if (args.aborted) {
    out.error = errorSlot('aborted', args.error?.text ?? 'aborted');
    return out;
  }
  if (args.error && !isContentModeration(args.error.text ?? args.error)) {
    out.error = errorSlot('http', `${args.error.status}: ${args.error.text}`);
    return out;
  }
  const text = out.text?.value ?? '';
  out.text = text.trim()
    ? makeSlot('ok', text.trim(), undefined, {})
    : refusedSlot<string>(extractLlmRefusal(args.raw) || '(no response)');
  if (out.thinking?.value) {
    out.thinking = makeSlot('ok', out.thinking.value, undefined, {});
  }
  // An image-capable model may stream generated images back even in a text
  // use case (e.g. append). Surface them so they reach the caller + log.
  const images = extractLlmImages(args.raw);
  if (images.length > 0) {
    out.images = makeSlot('ok', images, undefined, { prompt: args.prompt, scene: args.scene });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Message helpers (small, pure)
// ---------------------------------------------------------------------------

/** Render a message's content as plain text (empty for media-only parts). */
export function messageToText(m: ChatMessage): string {
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .map(p => (p && typeof p === 'object' && 'text' in p && (p as { text?: string }).text) ? (p as { text: string }).text : '')
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/**
 * Parse an LLM answer into up to 3 suggestion strings (the corrected text
 * variants shared by "Check my English" and the rewrite-selection dialog).
 * Accepts fenced/raw JSON arrays, `{variants: [...]}` wrappers, an embedded
 * `[...]` inside prose, and finally a fallback line-split.
 */
export function parseSuggestionVariants(content: string): string[] {
  const trimmed = (content || '').trim();
  if (!trimmed) return [];
  const fenced = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '');

  const asStrings = (v: unknown): string[] | null => {
    if (v && typeof v === 'object' && Array.isArray((v as { variants?: unknown }).variants)) {
      return asStrings((v as { variants: unknown[] }).variants);
    }
    if (Array.isArray(v)) {
      const arr = v.map(x => String(x).trim()).filter(Boolean);
      return arr.length ? arr : null;
    }
    return null;
  };
  const parse = (raw: string): string[] | null => {
    try {
      return asStrings(JSON.parse(raw));
    } catch {
      return null;
    }
  };

  let arr = parse(fenced) ?? parse(trimmed);
  if (!arr) {
    const match = trimmed.match(/\[[\s\S]*\]/);
    if (match) arr = parse(match[0]);
  }
  if (!arr) {
    arr = fenced
      .split(/\r?\n/)
      .map(s => s.replace(/^[\s\-•·*\d.)]+/, '').trim())
      .filter(Boolean);
  }
  return (arr ?? []).slice(0, 3);
}

export type { Slot, EvalSlots };