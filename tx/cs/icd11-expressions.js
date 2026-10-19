/**
 * icd11-expressions.js -- postcoordinated ICD-11 expressions: parse, bind to axes, normalise,
 * render.
 *
 *   1A00&XN8P1                          MMS: a stem, then a value on one of its axes
 *   NA00.2&XK8G&XJ9NV/PG50&XE3HC&XE266  a root with its qualifiers, then a cluster member with its own
 *   CA40.00/MG51.00/1B10.0              a root and two cluster members
 *   d5409.qp3                           ICF spells a qualifier with a dot
 *   257068234&194483911                 the same, written with entity ids (the code form)
 *   1363559646/other&194483911          a residual's id carries its own slash
 *
 * There are no spaces in the syntax, and entity uris are not part of it.
 *
 * How it is read (the October 2026 WHO meeting):
 *   - the first code is the root. Everything after a `/` qualifies the root: there is no
 *     nesting, and nothing qualifies a qualifier.
 *   - `&` (and ICF's `.`) attaches qualifiers to the code before it: the root, or the `/`
 *     member they follow. That grouping matters; the order within a group does not, and nor
 *     does the order of the `/` members.
 *   - a `&` qualifier must be a value on an axis of the code it qualifies, or the expression
 *     is wrong. A `/` member is placed on an axis of the root if it fits one, and may fit none.
 *
 * The normal form (the code) fixes an order that carries no meaning:
 *   - the root first;
 *   - each group of qualifiers in the order the qualified code defines its axes, and within
 *     one axis by entity id (string order - the ids are tails of the entity uris);
 *   - the `/` members the same way against the root's axes, a member on no axis after all
 *     those that are, each member carrying its own qualifiers, normalised the same way;
 *   - duplicates deleted: the same code twice in one group, or two identical members. A member
 *     with different qualifiers is a different member, not a duplicate.
 *   - the syntax is kept: `&`, `/` and ICF's `.` are not interchangeable. ICF dot qualifiers
 *     stay in the order written, directly after the code they qualify.
 * Which axis a value goes on is decided in id order too, so that the binding - and so the
 * normal form - does not depend on the order the codes were written in.
 */

'use strict';

const { Issue } = require('../library/operation-outcome');

const SCHEMA_NS = 'http://id.who.int/icd/schema';

/** One element of the written expression, with the separator that introduced it. */
class ExpressionToken {
  constructor(text, sep) {
    this.text = text;
    this.sep = sep;          // null for the first token, otherwise '&', '/' or '.'
    this.concept = null;     // the ICD11Concept it names, once resolved
    this.axis = null;        // the axis it was bound to, if any
  }
}

/**
 * A parsed expression. `tokens` and `members` are the syntax; `stems` is the semantics.
 * The context object the provider hands around for a postcoordinated code.
 */
class ICD11Expression {
  constructor(raw, tokens, members, stems, issues) {
    this.raw = raw;
    this.tokens = tokens;     // the normal form, in order (idForm and classificationCode)
    this.members = members;   // [{ head: Token, tail: [Token] }] -- as written (the display)
    this.stems = stems;       // [{ stem: Token, axes, bindings: [{ axis, token }] }] -- as meant: the
                              // root first, then one per `/` member
    this.issues = issues;     // [{ severity, msgId, params }] - things validation should say
  }

  /** The expression's code: the id form (the October 2026 decisions; see idForm). */
  get canonicalCode() {
    return this.idForm;
  }

  /**
   * The expression written with short codes (1A00&XN8P1), or null when any part of it has
   * no short code - then there is no classification-code form to report.
   */
  get classificationCode() {
    if (!this.tokens.every(t => t.concept.code)) return null;
    return this.tokens.map((t, i) => (i ? t.sep : '') + t.concept.code).join('');
  }

  /** The entity-id spelling, in normal order - the expression's code: 257068234&194483911. */
  get idForm() {
    return this.tokens.map((t, i) => (i ? t.sep : '') + t.concept.canonicalCode).join('');
  }

  /** True when nothing was postcoordinated after all -- a bare code in expression clothing. */
  get isTrivial() {
    return this.tokens.length === 1;
  }
}

// A residual's entity id is its parent's id with /other or /unspecified after it.
const RESIDUAL = /^\/(other|unspecified)(?=$|[&/.])/;

/**
 * Split the written form into tokens at `&` and `/`. One `/` is not a separator: the one
 * in a residual's entity id, 1363559646/other or 1363559646/unspecified. That is read as
 * part of the id when it follows an all-digit token (an entity id; no short code is all
 * digits) and is followed by the end or a separator, so 1363559646/other&XN8P1 is two
 * tokens and 1363559646/1G41 is a cluster.
 *
 * Returns null if the text is not shaped like an expression at all -- an empty part, or a
 * space anywhere: the syntax has none.
 */
function tokenize(text) {
  if (!text || /\s/.test(text)) return null;
  const tokens = [];
  const n = text.length;
  let i = 0, sep = null;
  while (i <= n) {
    const start = i;
    while (i < n && text[i] !== '&' && text[i] !== '/') i++;
    if (i < n && text[i] === '/' && /^\d+$/.test(text.slice(start, i))) {
      const m = RESIDUAL.exec(text.slice(i));
      if (m) {
        i += m[0].length;
        while (i < n && text[i] !== '&' && text[i] !== '/') i++;  // e.g. an ICF .qualifier
      }
    }
    if (i === start) return null;                  // empty part, or a trailing separator
    tokens.push(new ExpressionToken(text.slice(start, i), sep));
    if (i >= n) break;
    sep = text[i];
    i++;
  }
  return tokens.length ? tokens : null;
}

/**
 * ICF writes `d5409.qp3` where MMS writes `d5409&qp3`. A dot is only a separator when the
 * whole token is not itself a code -- `1D01.0Y` is one code, and `BD11.2` is another -- so
 * the longest prefix that resolves wins, and what is left becomes dot-separated values.
 *
 * Returns the tokens this one expands to, or null if nothing resolves.
 */
async function resolveToken(ctx, token) {
  const whole = await ctx.resolve(token.text);
  if (whole) {
    token.concept = whole;
    return [token];
  }
  if (!token.text.includes('.')) return null;
  const parts = token.text.split('.');
  for (let take = parts.length - 1; take >= 1; take--) {
    const head = parts.slice(0, take).join('.');
    const concept = await ctx.resolve(head);
    if (!concept) continue;
    const out = [new ExpressionToken(head, token.sep)];
    out[0].concept = concept;
    for (const rest of parts.slice(take)) {
      const value = await ctx.resolve(rest);
      if (!value) return null;                    // e.g. the pre-2026 ICF form d5409.3
      const t = new ExpressionToken(rest, '.');
      t.concept = value;
      out.push(t);
    }
    return out;
  }
  return null;
}

/**
 * The postcoordination axes a stem declares, in binding preference: required axes first, then
 * WHO's own order. When a value fits more than one free axis, an axis that must be filled is
 * the one a coder is most likely to have been filling, so it gets first refusal. `seq` keeps
 * the definition order, which is the order the normal form sorts by.
 */
async function axesOf(ctx, concept) {
  return ctx.all(
    `SELECT id, seq, axis, axis_name, required, allow_multiple, value_set_uri
       FROM pc_scale WHERE concept = ? ORDER BY required DESC, seq`, [concept.id]);
}

/** Is `value` one of the permitted values of this axis -- a scale root or a descendant? */
async function permitted(ctx, axis, value) {
  const row = await ctx.get(
    `SELECT 1 AS ok FROM pc_scale_entity e
       JOIN concept_closure cl ON cl.ancestor = e.target
      WHERE e.scale = ? AND cl.descendant = ? LIMIT 1`, [axis.id, value.id]);
  return !!row;
}

/**
 * Put a value on an axis of the stem. An axis not yet used is always preferred over one that
 * is, which is what keeps the two values of 1D01.0Y/1G41/1G40 apart: both are legal on
 * hasCausingCondition and on hasManifestation. When every axis the value fits is already
 * taken it goes on the first of them anyway; if that axis does not allow several values the
 * expression still parses, and validation says so.
 *
 * Returns the axis, or null when the value is on none of them.
 */
async function bind(ctx, stem, token) {
  let fallback = null;
  for (const axis of stem.axes) {
    if (!await permitted(ctx, axis, token.concept)) continue;
    if (!stem.used.has(axis.id)) {
      stem.used.set(axis.id, 1);
      stem.bindings.push({ axis, token });
      token.axis = axis;
      return axis;
    }
    if (fallback === null) fallback = axis;
  }
  if (fallback === null) return null;
  stem.used.set(fallback.id, stem.used.get(fallback.id) + 1);
  stem.bindings.push({ axis: fallback, token });
  token.axis = fallback;
  return fallback;
}

/** Entity ids compare as strings: they are the tails of the entity uris. */
const byId = (a, b) => {
  const x = a.concept.entityId, y = b.concept.entityId;
  return x < y ? -1 : x > y ? 1 : 0;
};

/** Normal-form order of things bound (or not) to one code's axes: axis definition order, then id. */
const byAxisThenId = (a, b) => {
  const sa = a.axis ? a.axis.seq : Infinity, sb = b.axis ? b.axis.seq : Infinity;
  return sa !== sb ? sa - sb : byId(a, b);
};

/** A group with its duplicates deleted - the same code with the same separator. */
function dedupe(tokens) {
  const seen = new Set();
  return tokens.filter(t => {
    const k = t.sep + '|' + t.concept.id;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * A qualifier group in normal order. ICF's dot qualifiers keep the order written and come
 * first; the `&` ones are sorted by axis, then id.
 */
function orderGroup(tokens) {
  return [...tokens.filter(t => t.sep === '.'), ...tokens.filter(t => t.sep !== '.').sort(byAxisThenId)];
}

/**
 * Bind one code's `&`/`.` qualifiers to its axes, in id order. Throws when one is on none of
 * them: the `&` asserted it was.
 */
async function bindQualifiers(ctx, stem, tail) {
  for (const t of [...tail].sort(byId)) {
    if (!await bind(ctx, stem, t)) throw notOnAnyAxis(ctx, stem, t);
  }
}

/** What validation has to say about a stem: several values on an axis that takes one. */
function axisIssues(stem, issues) {
  for (const axis of stem.axes) {
    if ((stem.used.get(axis.id) || 0) > 1 && axis.allow_multiple === 'NotAllowed') {
      const values = stem.bindings.filter(b => b.axis === axis).map(b => b.token.text);
      issues.push({ severity: 'warning', msgId: 'ICD11_PC_AXIS_NOT_MULTIPLE',
        params: [stem.stem.text, axis.axis_name, values.join(', ')] });
    }
  }
}

/**
 * Parse, bind and normalise. Returns an ICD11Expression, or null when the text does not
 * resolve (which the caller reports as an ordinary unknown code). Throws an Issue when the
 * text does resolve but says something that is not true -- a qualifier on no axis of the
 * code it qualifies -- because "not found" would hide the reason.
 */
async function parseExpression(ctx, text) {
  const raw = tokenize(text);
  if (!raw) return null;

  const tokens = [];
  for (const t of raw) {
    const resolved = await resolveToken(ctx, t);
    if (!resolved) return null;
    tokens.push(...resolved);
  }
  if (tokens.length === 1) return null;           // a plain code, already handled

  // syntax: the members as written, split at '/'; the first is the root
  const members = [];
  for (const t of tokens) {
    if (t.sep === '/' || members.length === 0) members.push({ head: t, tail: [] });
    else members[members.length - 1].tail.push(t);
  }

  // duplicates go before anything is bound, so a repeated code never takes a second axis
  const groups = members.map(m => ({ head: m.head, tail: dedupe(m.tail) }));
  const root = groups[0];
  const others = [];
  const seenMember = new Set();
  for (const g of groups.slice(1)) {
    const k = g.head.concept.id + '|' + g.tail.map(t => t.sep + t.concept.id).sort().join(',');
    if (seenMember.has(k)) continue;
    seenMember.add(k);
    others.push(g);
  }

  // semantics: the root's qualifiers, then the members, go on the root's axes; each member's
  // own qualifiers go on its axes. All in id order, so the order written changes nothing.
  const issues = [];
  const rootStem = { stem: root.head, axes: await axesOf(ctx, root.head.concept), bindings: [], used: new Map() };
  await bindQualifiers(ctx, rootStem, root.tail);
  for (const g of [...others].sort((a, b) => byId(a.head, b.head))) {
    await bind(ctx, rootStem, g.head);            // may fit no axis of the root: that is allowed
  }
  // every member is a code in its own right, with its own axes (and its qualifiers on them)
  const stems = [rootStem];
  for (const g of others) {
    const st = { stem: g.head, axes: await axesOf(ctx, g.head.concept), bindings: [], used: new Map() };
    await bindQualifiers(ctx, st, g.tail);
    stems.push(st);
  }
  for (const st of stems) axisIssues(st, issues);

  // the normal form
  const memberKey = g => g.head.concept.entityId + orderGroup(g.tail).map(t => t.sep + t.concept.entityId).join('');
  const ordered = [...others].sort((a, b) => byAxisThenId(a.head, b.head) || (memberKey(a) < memberKey(b) ? -1 : memberKey(a) > memberKey(b) ? 1 : 0));
  const normal = [root.head, ...orderGroup(root.tail)];
  for (const g of ordered) normal.push(g.head, ...orderGroup(g.tail));

  return new ICD11Expression(text, normal, members, stems, issues);
}

/**
 * `&` asserted that this value belongs on an axis of the stem, and it does not. Say which
 * value, and which axes the stem actually has: "could not be found in the CodeSystem" is
 * the answer that sends people looking in the wrong place (doco.txt item 15).
 */
function notOnAnyAxis(ctx, stem, token) {
  const axes = stem.axes.map(a => a.axis_name).join(', ');
  const [msgId, params] = axes
    ? ['ICD11_PC_VALUE_NOT_ON_AXIS', [token.text, stem.stem.text, axes]]
    : ['ICD11_PC_NO_AXES', [token.text, stem.stem.text]];
  return new Issue('error', 'code-invalid', null, msgId, ctx.translate(msgId, params),
    'invalid-code', 400).handleAsOO(400);
}

/**
 * A display for an axis, from WHO's name for it - WHO publishes no labels for the axes:
 * specificAnatomy -> Specific anatomy, hasGCSEyeScore -> Has GCS eye score.
 */
function axisLabel(name) {
  const words = name
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .split(' ')
    .map(w => (w.length > 1 && w === w.toUpperCase()) ? w : w.toLowerCase());
  const text = words.join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

module.exports = { ICD11Expression, ExpressionToken, parseExpression, tokenize, axisLabel, SCHEMA_NS };
