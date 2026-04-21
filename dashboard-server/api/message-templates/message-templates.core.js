'use strict';

const MAX_BODY_LENGTH = 1024;
const NAME_PATTERN = /^[a-z0-9_]+$/;
const NAME_MAX_LENGTH = 512;
const MAX_BUTTONS = 3;
const BUTTON_LABEL_MAX = 20;
const VALID_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED'];
const PLACEHOLDER_PATTERN = /\{\{(\d+)\}\}/g;

// Returns the 1-based placeholder indices used in `body`, in sorted order.
// Facebook requires a sample value per unique placeholder.
function extractPlaceholderIndices(body) {
  const indices = new Set();
  let match;
  PLACEHOLDER_PATTERN.lastIndex = 0;
  while ((match = PLACEHOLDER_PATTERN.exec(body)) !== null) {
    indices.add(Number(match[1]));
  }
  return Array.from(indices).sort((a, b) => a - b);
}

function validateButtons(buttons) {
  if (buttons === undefined || buttons === null) return { valid: true, normalized: [] };
  if (!Array.isArray(buttons)) return { valid: false, error: 'buttons must be an array' };
  if (buttons.length > MAX_BUTTONS) {
    return { valid: false, error: `at most ${MAX_BUTTONS} buttons are allowed on a utility template` };
  }

  const seen = new Set();
  const normalized = [];
  for (let i = 0; i < buttons.length; i++) {
    const b = buttons[i];
    if (!b || typeof b.label !== 'string' || !b.label.trim()) {
      return { valid: false, error: `buttons[${i}] must have a non-empty label` };
    }
    const label = b.label.trim();
    if (label.length > BUTTON_LABEL_MAX) {
      return { valid: false, error: `buttons[${i}] label exceeds ${BUTTON_LABEL_MAX} characters` };
    }
    if (seen.has(label)) {
      return { valid: false, error: `duplicate button label "${label}"` };
    }
    seen.add(label);
    normalized.push({ label });
  }
  return { valid: true, normalized };
}

function validateCreateInput({ pageId, name, language, body, buttons, examples }) {
  if (!pageId) return { valid: false, error: 'pageId is required' };
  if (!name) return { valid: false, error: 'name is required' };
  if (name.length > NAME_MAX_LENGTH) return { valid: false, error: `name exceeds ${NAME_MAX_LENGTH} characters` };
  if (!NAME_PATTERN.test(name)) {
    return { valid: false, error: 'name must be lowercase letters, digits, and underscores only (snake_case)' };
  }
  if (!language) return { valid: false, error: 'language is required' };
  if (!body) return { valid: false, error: 'body is required' };
  if (body.length > MAX_BODY_LENGTH) {
    return { valid: false, error: `body exceeds maximum length of ${MAX_BODY_LENGTH} characters` };
  }

  const indices = extractPlaceholderIndices(body);
  // Facebook requires placeholders to be sequential starting from {{1}}.
  for (let i = 0; i < indices.length; i++) {
    if (indices[i] !== i + 1) {
      return { valid: false, error: `body placeholders must be sequential starting from {{1}} (found {{${indices[i]}}} at position ${i + 1})` };
    }
  }

  const exampleList = Array.isArray(examples) ? examples : [];
  if (indices.length > 0) {
    if (exampleList.length !== indices.length) {
      return { valid: false, error: `body has ${indices.length} placeholder(s); examples must provide ${indices.length} sample value(s)` };
    }
    for (let i = 0; i < exampleList.length; i++) {
      if (typeof exampleList[i] !== 'string' || !exampleList[i].trim()) {
        return { valid: false, error: `examples[${i}] must be a non-empty string` };
      }
    }
  } else if (exampleList.length > 0) {
    return { valid: false, error: 'examples must be empty when body has no {{N}} placeholders' };
  }

  const btn = validateButtons(buttons);
  if (!btn.valid) return btn;
  return { valid: true, buttons: btn.normalized, examples: exampleList };
}

function buildFacebookCreatePayload({ name, language, body, buttons, examples }) {
  const bodyComponent = { type: 'BODY', text: body };
  // Facebook requires sample values for every {{N}} placeholder; templates
  // without them are rejected with TEMPLATE_VARIABLES_MISSING_SAMPLE_VALUES.
  // The `example.body_text` field is an array-of-arrays (outer = variation,
  // inner = positional samples matching {{1}}, {{2}}, …). We send one variation.
  if (Array.isArray(examples) && examples.length > 0) {
    bodyComponent.example = { body_text: [examples.map(String)] };
  }
  const components = [bodyComponent];
  if (Array.isArray(buttons) && buttons.length > 0) {
    // POSTBACK buttons are the only interactive type Messenger utility
    // templates accept (QUICK_REPLY is rejected with a "Fatal" error at
    // creation time). POSTBACK requires a payload at template time, so we
    // bake in the per-button value and leave a {{1}} placeholder for the
    // survey field ref — the ref is identical across all buttons of one
    // field, so a single placeholder suffices. At send time, translate-
    // typeform substitutes the real ref.
    components.push({
      type: 'BUTTONS',
      buttons: buttons.map(b => ({
        type: 'POSTBACK',
        text: b.label,
        payload: JSON.stringify({ value: b.label, ref: '{{1}}' }),
      })),
    });
  }
  return {
    name,
    language,
    category: 'UTILITY',
    components,
  };
}

function parseCreateResponse(fbResponseBody) {
  if (!fbResponseBody) {
    return { ok: false, error: { message: 'Empty response from Facebook' } };
  }
  if (fbResponseBody.error) {
    return { ok: false, error: fbResponseBody.error };
  }
  // FB returns { id: "...", status: "APPROVED|PENDING|REJECTED", category: "UTILITY" }
  return {
    ok: true,
    fbTemplateId: fbResponseBody.id || null,
    status: normalizeStatus(fbResponseBody.status) || 'PENDING',
  };
}

function normalizeStatus(s) {
  if (!s) return null;
  const upper = String(s).toUpperCase();
  return VALID_STATUSES.includes(upper) ? upper : null;
}

function parseListResponse(fbResponseBody) {
  if (!fbResponseBody) return [];
  if (fbResponseBody.error) return [];
  const data = fbResponseBody.data || [];
  return data.map(entry => ({
    fbTemplateId: entry.id || null,
    name: entry.name,
    language: entry.language,
    status: normalizeStatus(entry.status) || 'PENDING',
    rejectionReason: entry.rejected_reason || null,
  }));
}

function matchFbEntry(row, fbEntries) {
  return fbEntries.find(e => e.name === row.name && e.language === row.language) || null;
}

function formatRecord(row) {
  return {
    id: row.id,
    facebook_page_id: row.facebook_page_id,
    fb_template_id: row.fb_template_id,
    name: row.name,
    language: row.language,
    body: row.body,
    status: row.status,
    rejection_reason: row.rejection_reason,
    buttons: Array.isArray(row.buttons) ? row.buttons : [],
    created: row.created,
    updated: row.updated,
  };
}

module.exports = {
  MAX_BODY_LENGTH,
  NAME_PATTERN,
  MAX_BUTTONS,
  BUTTON_LABEL_MAX,
  VALID_STATUSES,
  extractPlaceholderIndices,
  validateButtons,
  validateCreateInput,
  buildFacebookCreatePayload,
  parseCreateResponse,
  parseListResponse,
  matchFbEntry,
  formatRecord,
  normalizeStatus,
};
