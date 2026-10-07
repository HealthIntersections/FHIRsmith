/**
 * icd11-expressions.js -- postcoordinated ICD-11 expressions: parse, bind to axes, render.
 *
 * ICD-11 postcoordination has two levels of punctuation and one spelling per linearization:
 *
 *   1A00&XN8P1                          MMS: a stem, then a value on one of its axes
 *   NC53.Y&XK8G&XJ778/PA71&XE5UF&XE4TZ  a cluster: two stems, each with its own values
 *   1D01.0Y/1G41/1G40                   a cluster whose later members are values of the first
 *   d5409.qp3                           ICF spells the same thing with a dot
 *   http://.../257068234 & http://.../194483911     any of it may be written as entity uris
 *
 * `&` says "this is a postcoordination value of the stem to my left": if it is not a value
 * on any axis of that stem, the expression is wrong and says so. `/` says only "this is
 * another element of the cluster": a member that happens to be a value on an unfilled axis
 * of the current stem is taken as one (this is what the ICD Browser does, and it is what
 * makes 1D01.0Y/1G41/1G40 mean what a coder means by it), and a member that is not simply
 * starts a new stem.
 *
 * The syntax and the semantics are kept apart on purpose. The display renders the syntax --
 * cluster members joined by " / ", values in brackets -- because that is what the coder
 * wrote. The properties report the semantics: which value went on which axis. The two
 * disagree for 1D01.0Y/1G41/1G40, and both are right.
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
  }
}

/**
 * A parsed expression. `tokens` and `members` are the syntax; `stems` is the semantics.
 * The context object the provider hands around for a postcoordinated code.
 */
class ICD11Expression {
  constructor(raw, tokens, members, stems) {
    this.raw = raw;
    this.tokens = tokens;
    this.members = members;   // [{ head: Token, tail: [Token] }] -- as written
    this.stems = stems;       // [{ stem: Token, bindings: [{ axis, token }] }] -- as meant
  }

  /** The short-code spelling: the form $lookup echoes back, whichever form came in. */
  get canonicalCode() {
    return this.tokens.map((t, i) => (i ? t.sep : '') + t.concept.canonicalCode).join('');
  }

  /**
   * The entity-uri spelling. ICF's dot is the same operator as MMS's `&`, so it renders as
   * `&` here -- the uri form has only the one spelling.
   */
  get uriForm() {
    return this.tokens
      .map((t, i) => (i ? ` ${t.sep === '.' ? '&' : t.sep} ` : '') + t.concept.uri)
      .join('');
  }

  /** True when nothing was postcoordinated after all -- a bare code in expression clothing. */
  get isTrivial() {
    return this.tokens.length === 1;
  }
}

/**
 * Split the written form into tokens. A uri is one token including its slashes -- the `/`
 * inside `http://id.who.int/icd/release/11/mms/257068234` is not a cluster separator -- so
 * a uri runs to the next `&` or space. That leaves `/` between two uris ambiguous, which is
 * a property of WHO's syntax rather than of this parser; the uri form in practice uses `&`.
 *
 * Returns null if the text is not shaped like an expression at all.
 */
function tokenize(text) {
  const tokens = [];
  const n = text.length;
  let i = 0, sep = null;
  while (i < n) {
    while (i < n && text[i] === ' ') i++;
    if (i >= n) return null;                       // trailing separator
    const start = i;
    const isUri = /^https?:\/\//.test(text.slice(i));
    while (i < n && text[i] !== '&' && text[i] !== ' ' && (isUri || text[i] !== '/')) i++;
    tokens.push(new ExpressionToken(text.slice(start, i), sep));
    while (i < n && text[i] === ' ') i++;
    if (i >= n) break;
    if (text[i] !== '&' && text[i] !== '/') return null;
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
 * The postcoordination axes a stem declares. Required axes come first, then WHO's own
 * order. That ordering is what decides where an ambiguous value lands: 1D01.0Y declares
 * hasManifestation (optional, second) and hasCausingCondition (required, fourth), 1G40 and
 * 1G41 are both legal on either, and the ICD Browser reads 1D01.0Y/1G41/1G40 as causing
 * condition then manifestation. An axis that must be filled is the one a coder is most
 * likely to have been filling, so it gets first refusal.
 */
async function axesOf(ctx, concept) {
  return ctx.all(
    `SELECT id, axis, axis_name, required, allow_multiple, value_set_uri
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
 * Put a value on an axis of the stem. An axis not yet used is always preferred over one
 * that is, which is what keeps the two values of 1D01.0Y/1G41/1G40 apart: both are legal on
 * hasCausingCondition and on hasManifestation, and coalescing them onto the first is the
 * thing the ICD-API gets wrong (see doco.txt item 13). The same rule sends the second
 * XM4SL9 of PB20&XM4SL9&XM4SL9&... to a second axis rather than dropping it.
 *
 * Returns the axis, or null when the value is on none of them.
 */
async function bind(ctx, stem, token) {
  let fallback = null;
  for (const axis of stem.axes) {
    if (!await permitted(ctx, axis, token.concept)) continue;
    if (!stem.used.has(axis.id)) {
      stem.used.add(axis.id);
      stem.bindings.push({ axis, token });
      return axis;
    }
    if (fallback === null) fallback = axis;
  }
  if (fallback === null) return null;
  // every axis this value fits is already carrying one. allowMultipleValues decides whether
  // that is legal; nothing in the suite pins it yet, so the value is kept rather than lost.
  stem.bindings.push({ axis: fallback, token });
  return fallback;
}

/**
 * Parse and bind. Returns an ICD11Expression, or null when the text does not resolve (which
 * the caller reports as an ordinary unknown code). Throws an Issue when the text does
 * resolve but says something that is not true -- a value on no axis of its stem -- because
 * "not found" would hide the reason.
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

  // syntax: cluster members, split at '/'
  const members = [];
  for (const t of tokens) {
    if (t.sep === '/' || members.length === 0) members.push({ head: t, tail: [] });
    else members[members.length - 1].tail.push(t);
  }

  // semantics: which member is a stem, and which value went on which axis
  const stems = [];
  let cur = null;
  for (let k = 0; k < members.length; k++) {
    const m = members[k];
    if (k > 0 && m.tail.length === 0 && cur && await bind(ctx, cur, m.head)) {
      continue;                                    // a cluster member that is a value
    }
    cur = { stem: m.head, axes: await axesOf(ctx, m.head.concept), bindings: [], used: new Set() };
    stems.push(cur);
    for (const t of m.tail) {
      if (!await bind(ctx, cur, t)) {
        throw notOnAnyAxis(ctx, cur, t);
      }
    }
  }
  return new ICD11Expression(text, tokens, members, stems);
}

/**
 * `&` asserted that this value belongs on an axis of the stem, and it does not. Say which
 * value, and which axes the stem actually has: "could not be found in the CodeSystem" is
 * the answer that sends people looking in the wrong place (doco.txt item 15).
 */
function notOnAnyAxis(ctx, stem, token) {
  const axes = stem.axes.map(a => a.axis_name).join(', ');
  const msg = axes
    ? `'${token.text}' is not a permitted value on any postcoordination axis of `
      + `'${stem.stem.text}'. That stem declares: ${axes}`
    : `'${token.text}' cannot be postcoordinated onto '${stem.stem.text}': that concept `
      + `declares no postcoordination axes`;
  return new Issue('error', 'code-invalid', null, null, msg, 'invalid-code', 400).handleAsOO(400);
}

module.exports = { ICD11Expression, ExpressionToken, parseExpression, tokenize, SCHEMA_NS };
