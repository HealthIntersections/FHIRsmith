// Client for OCL's $resolveReference operation.
//
// Answers "which OCL repo holds this canonical URL?" authoritatively, so callers
// stop iterating source/collection listings to find a matching canonical_url. See
// https://docs.openconceptlab.org/en/latest/oclapi/apireference/resolveReference.html
//
// Namespace is deliberately NOT supported: FHIR operations carry no namespace
// parameter, so every resolution here runs in OCL's global namespace. Namespace
// semantics (multi-tenant discrimination, sandboxing) are an open discussion with
// the OCL team, not something to encode client-side yet.
//
// Plain .js rather than tx/ocl's .cjs+stub convention: jest's collectCoverageFrom
// globs **/*.js only, so a .cjs module would be invisible to coverage.

const RESOLVE_PATH = '/$resolveReference/';

// The live instance rejects large batches (403 somewhere between 150 and 200
// references); 100 resolved in ~1.1s. Chunking is transparent to callers.
const MAX_BATCH_SIZE = 100;

// Caps so that client-supplied references cannot grow memory or outbound traffic
// without bound (the resolver is reachable from any public terminology request):
//  - the cache is a bounded LRU, so distinct references evict the oldest rather
//    than accumulating forever;
//  - references longer than the limit are treated as unresolved and never sent to
//    OCL (nothing legitimate is anywhere near this long).
const DEFAULT_CACHE_LIMIT = 5000;
const MAX_REFERENCE_LENGTH = 2048;

// A transient 401/403 (rate limit, a brief credential hiccup, an oversized batch
// on a busy instance) backs the resolver off for a while rather than disabling it
// for the whole process life. 404 (endpoint not implemented) stays permanent.
const DEFAULT_AUTH_BACKOFF_MS = 60_000;

// Org-only visibility policy: an artifact is expected to live in an organization
// to be visible through the terminology service. The path must be a concrete
// /orgs/<org>/(sources|collections)/<id>/ repo path — this both enforces the
// policy and keeps repoUrl a safe relative OCL path (so it can never redirect an
// authenticated request, carrying our token, to an arbitrary host).
const REPO_PATH_PATTERN = /^\/orgs\/[^/]+\/(sources|collections)\/[^/]+\//;

// Reference object fields forwarded to OCL. `namespace` is intentionally absent.
const BODY_FIELDS = [
  'url',
  'version',
  'code',
  'display',
  'id',
  'filter',
  'cascade',
  'includeExclude',
  'resourceType'
];

/**
 * True for a relative OCL repo path the terminology service may serve — i.e. an
 * organization-owned source or collection (`/orgs/CIEL/sources/CIEL/`). User-owned
 * paths (`/users/joe/...`), absolute URLs, and anything containing path traversal
 * are rejected.
 */
function isOclRepoPath(value) {
  const s = String(value == null ? '' : value).trim();
  if (s.includes('..')) {
    // No legitimate OCL repo path contains `..`; reject traversal outright.
    return false;
  }
  return REPO_PATH_PATTERN.test(s);
}

/**
 * A repoUrl we can safely GET against the OCL base URL: a relative, same-host path
 * with no traversal. Absolute or protocol-relative URLs are rejected so an authed
 * request (carrying our token) can never be redirected to an arbitrary host. This
 * is the SSRF guard and is deliberately separate from the org-only policy: a
 * same-host `/users/...` path is "safe" here but still rejected by isOrgOwned.
 */
function isSafeRelativeOclPath(value) {
  const s = String(value == null ? '' : value).trim();
  return s.startsWith('/') && !s.startsWith('//') && !s.includes('..');
}

/**
 * Whether an OCL repo's public_access makes it publicly viewable. OCL uses
 * 'View' | 'Edit' | 'None' ('None' = private, members only). Fail-closed:
 * anything that is not an explicit public value (including null/unknown) is NOT
 * public, so a repo is only served when we can positively confirm it is.
 */
function isPublicAccess(value) {
  const s = String(value == null ? '' : value).trim().toLowerCase();
  return s === 'view' || s === 'edit';
}

/**
 * Org-only policy check for an OCL repo payload or resolve result. The path must
 * be a valid org repo path AND, when an explicit owner_type is present, it must be
 * an Organization. owner_type alone can never override the path check — a payload
 * claiming owner_type:"Organization" on a non-org (or off-host) URL is not served.
 */
function isOrgOwned(repo) {
  if (!repo || typeof repo !== 'object') {
    return false;
  }
  if (!isOclRepoPath(repo.url)) {
    return false;
  }
  const ownerType = repo.owner_type || repo.ownerType || null;
  return ownerType ? ownerType === 'Organization' : true;
}

/**
 * Accepts either a relative/canonical URL string or an expanded reference object,
 * returning the request-body form OCL expects.
 */
function normalizeReference(ref) {
  if (typeof ref === 'string') {
    const url = ref.trim();
    if (!url) {
      throw new Error('OCL reference string cannot be empty');
    }
    return url;
  }

  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) {
    throw new Error(`Invalid OCL reference: expected a string or object, got ${typeof ref}`);
  }

  const url = String(ref.url == null ? '' : ref.url).trim();
  if (!url) {
    throw new Error('OCL reference object requires a url');
  }

  const body = {};
  for (const field of BODY_FIELDS) {
    if (ref[field] !== undefined && ref[field] !== null) {
      body[field] = ref[field];
    }
  }
  return body;
}

function cacheKey(body) {
  return typeof body === 'string' ? body : JSON.stringify(body);
}

// Length of the reference's URL, used for the inbound length cap.
function referenceLength(body) {
  return (typeof body === 'string' ? body : String(body?.url ?? '')).length;
}

// Client input ends up in log lines; strip control characters / newlines and cap
// the length so a crafted reference cannot forge log entries or flood the log.
function safeForLog(value) {
  // Matching control characters is the whole point here (we are scrubbing them).
  // eslint-disable-next-line no-control-regex
  const s = String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]+/g, ' ');
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

function unresolved(request) {
  return {
    resolved: false,
    repoUrl: null,
    canonical: null,
    ownerType: null,
    publicAccess: null,
    resolutionUrl: null,
    registryEntry: null,
    referenceType: null,
    request,
    result: null
  };
}

function normalizeResult(entry, request) {
  if (!entry || typeof entry !== 'object') {
    return unresolved(request);
  }

  const result = entry.result && typeof entry.result === 'object' ? entry.result : null;
  const repoUrl = result && result.url ? result.url : null;

  // Only ever hand back a repoUrl that is a safe same-host relative path. Anything
  // absolute or off-host (or containing traversal) is treated as unresolved, so a
  // surprising OCL response can never cause a caller to issue an authenticated
  // request (with our token) to an arbitrary host. The org-only policy is applied
  // separately by the caller (isOrgOwned), so a same-host /users/ path survives to
  // there and is rejected with a logged reason.
  if (repoUrl && !isSafeRelativeOclPath(repoUrl)) {
    return unresolved(entry.request === undefined ? request : entry.request);
  }

  return {
    resolved: Boolean(entry.resolved) && Boolean(repoUrl),
    repoUrl,
    // OCL returns the repo's own canonical_url and owner_type (richer than the
    // documented example). Prefer them over echoing the request back: they are
    // authoritative, the request is just whatever spelling the caller used.
    canonical: result ? (result.canonical_url || result.canonicalUrl || null) : null,
    ownerType: result ? (result.owner_type || result.ownerType || null) : null,
    // public_access is not in the $resolveReference result today (the live capture
    // omits it), so this is usually null and the repo is fetched to check — kept
    // anyway so the gate is free the day OCL does inline it.
    publicAccess: result ? (result.public_access ?? result.publicAccess ?? null) : null,
    resolutionUrl: entry.resolution_url || null,
    // Kept even though every observed response so far carries null: whether a URL
    // Registry entry was involved is exactly what the OCL-team discussion needs.
    registryEntry: entry.url_registry_entry || null,
    referenceType: entry.reference_type || null,
    request: entry.request === undefined ? request : entry.request,
    result
  };
}

class OclReferenceResolver {
  #httpClient;
  #logger;
  #cache = new Map();
  #cacheLimit;
  #enabled;
  #disabledReason = null;
  #authBackoffMs;
  #backoffUntil = 0;

  /**
   * @param {object} options
   * @param {object} options.httpClient - axios instance from createOclHttpClient
   * @param {string} [options.token] - when absent the resolver stays disabled:
   *   $resolveReference is authenticated on every OCL instance probed, while the
   *   listing endpoints it replaces are public, so a tokenless call is a
   *   guaranteed 401
   * @param {object} [options.logger] - module logger; defaults to console only as
   *   a last resort (callers pass their child logger)
   * @param {number} [options.cacheLimit] - max cached references (bounded LRU)
   * @param {number} [options.authBackoffMs] - cooldown after a transient 401/403
   */
  constructor({ httpClient, token = null, logger = console, cacheLimit = DEFAULT_CACHE_LIMIT, authBackoffMs = DEFAULT_AUTH_BACKOFF_MS } = {}) {
    if (!httpClient) {
      throw new Error('OCL reference resolver requires an http client');
    }

    this.#httpClient = httpClient;
    this.#logger = logger;
    this.#cacheLimit = cacheLimit > 0 ? cacheLimit : DEFAULT_CACHE_LIMIT;
    this.#authBackoffMs = authBackoffMs >= 0 ? authBackoffMs : DEFAULT_AUTH_BACKOFF_MS;
    this.#enabled = Boolean(token);
    if (!this.#enabled) {
      this.#disabledReason = 'no token configured';
    }
  }

  isEnabled() {
    return this.#enabled && Date.now() >= this.#backoffUntil;
  }

  get disabledReason() {
    return this.#disabledReason;
  }

  // Permanent: no token, or the endpoint does not exist on this instance.
  #disable(reason) {
    this.#enabled = false;
    this.#disabledReason = reason;
  }

  // Transient: back off for a cooldown, then let requests resume.
  #backOff(reason) {
    this.#backoffUntil = Date.now() + this.#authBackoffMs;
    this.#disabledReason = reason;
  }

  #cacheTouch(key) {
    // Re-insert to mark most-recently-used.
    const value = this.#cache.get(key);
    this.#cache.delete(key);
    this.#cache.set(key, value);
    return value;
  }

  #cachePut(key, value) {
    if (this.#cache.has(key)) {
      this.#cache.delete(key);
    }
    this.#cache.set(key, value);
    if (this.#cache.size > this.#cacheLimit) {
      const oldest = this.#cache.keys().next().value;
      this.#cache.delete(oldest);
    }
  }

  /**
   * Resolve one reference. Returns null when the resolver is unavailable, so the
   * caller falls back to its existing path.
   */
  async resolve(ref) {
    const results = await this.resolveReferences([ref]);
    return results ? results[0] : null;
  }

  /**
   * Resolve many references, chunked into POSTs of at most MAX_BATCH_SIZE.
   * Results come back in the caller's order.
   *
   * @param {object} [options]
   * @param {boolean} [options.bypassCache] - re-ask OCL even for cached entries
   *   (the cache is still updated). Used by discovery refresh, where a source's
   *   default version may have changed since it was last resolved.
   * @returns {Promise<Array|null>} null when the resolver is unavailable (use fallback)
   */
  async resolveReferences(refs, { bypassCache = false } = {}) {
    if (!this.isEnabled()) {
      return null;
    }

    const list = Array.isArray(refs) ? refs : [refs];
    if (list.length === 0) {
      return [];
    }

    const bodies = list.map(normalizeReference);
    const output = new Array(bodies.length).fill(null);
    const misses = [];

    bodies.forEach((body, index) => {
      // Length cap: an over-long reference is never cached nor sent to OCL.
      if (referenceLength(body) > MAX_REFERENCE_LENGTH) {
        output[index] = unresolved(body);
        return;
      }
      const key = cacheKey(body);
      if (!bypassCache && this.#cache.has(key)) {
        output[index] = this.#cacheTouch(key);
      } else {
        misses.push({ body, index });
      }
    });

    for (let start = 0; start < misses.length; start += MAX_BATCH_SIZE) {
      const chunk = misses.slice(start, start + MAX_BATCH_SIZE);
      const outcome = await this.#resolveChunk(chunk, output);
      if (outcome === null) {
        // Resolver became unavailable; the caller falls back wholesale rather
        // than acting on a half-resolved set.
        return null;
      }
    }

    return output;
  }

  async #resolveChunk(chunk, output) {
    let response;
    try {
      response = await this.#httpClient.post(RESOLVE_PATH, chunk.map(m => m.body));
    } catch (error) {
      return this.#handleError(error, chunk, output);
    }

    const payload = Array.isArray(response?.data)
      ? response.data
      : response?.data == null
        ? []
        : [response.data];

    // Results are positional. On a count mismatch we cannot know which result
    // belongs to which reference, so treat the chunk as unresolved rather than
    // silently attributing a resolution to the wrong canonical.
    if (payload.length !== chunk.length) {
      this.#logger.error(
        `$resolveReference returned ${payload.length} result(s) for ${chunk.length} reference(s); discarding to avoid misaligned results`
      );
      for (const { body, index } of chunk) {
        output[index] = unresolved(body);
      }
      return output;
    }

    // Pass 1 (sync): normalize + org-only policy.
    const prelim = chunk.map(({ body, index }, position) => {
      let value = normalizeResult(payload[position], body);
      // Org-only policy: a canonical resolving to a user-owned repo is treated as
      // unresolved — user artifacts are experimental and not visible through the
      // terminology service. Cached: the policy outcome is deterministic.
      if (value.resolved && !isOrgOwned({ owner_type: value.ownerType, url: value.repoUrl })) {
        this.#logger.info(
          `$resolveReference resolved ${safeForLog(cacheKey(body))} to a user-owned repo (${safeForLog(value.repoUrl)}); org-only policy treats it as unresolved`
        );
        value = unresolved(body);
      }
      return { body, index, value };
    });

    // Pass 2 (async): public-access gate. A private repo (public_access other than
    // View/Edit) that the configured token can see must NOT be served through the
    // public terminology server, so anything not positively confirmed public is
    // dropped. public_access is not in the resolve result today, so for a resolved
    // repo we fetch it once (cached via the result below); done concurrently.
    await Promise.all(prelim.map(async entry => {
      if (!entry.value.resolved) {
        return;
      }
      const access = await this.#publicAccessOf(entry.value);
      if (!isPublicAccess(access)) {
        this.#logger.info(
          `$resolveReference resolved ${safeForLog(cacheKey(entry.body))} to a non-public repo ` +
          `(${safeForLog(entry.value.repoUrl)}, public_access=${safeForLog(access)}); not served`
        );
        entry.value = unresolved(entry.body);
      }
    }));

    for (const { body, index, value } of prelim) {
      this.#cachePut(cacheKey(body), value);
      output[index] = value;
    }

    return output;
  }

  // The repo's public_access, preferring the value inlined in the resolve result
  // and otherwise fetching the repo once. Returns null (→ fail-closed, not served)
  // when it cannot be determined, including on a fetch error.
  async #publicAccessOf(value) {
    if (value.publicAccess != null) {
      return value.publicAccess;
    }
    try {
      const response = await this.#httpClient.get(value.repoUrl);
      const repo = response?.data && typeof response.data === 'object' ? response.data : null;
      return repo ? (repo.public_access ?? repo.publicAccess ?? null) : null;
    } catch (error) {
      this.#logger.warn(
        `public_access check failed for ${safeForLog(value.repoUrl)}: ${safeForLog(error.message)}`
      );
      return null;
    }
  }

  #handleError(error, misses, output) {
    const status = error?.response?.status;

    if (status === 404) {
      this.#disable('endpoint not implemented (404)');
      this.#logger.info(
        `$resolveReference is not available on this instance (404); using listing search instead`
      );
      return null;
    }

    if (status === 401 || status === 403) {
      // Transient: back off and retry after a cooldown rather than disabling for
      // the life of the process. A busy public instance can 401/403 briefly (rate
      // limiting, an oversized batch) without our credentials being wrong.
      this.#backOff(`not authorised (${status})`);
      this.#logger.warn(
        `$resolveReference rejected our credentials (${status}); backing off, using listing search meanwhile`
      );
      return null;
    }

    if (status === 400) {
      // Our request body is wrong — a bug on this side. Don't disable: a later,
      // well-formed batch may be fine.
      const detail = error?.response?.data?.detail || error.message;
      this.#logger.error(`$resolveReference rejected the request body: ${safeForLog(detail)}`);
      for (const { body, index } of misses) {
        output[index] = unresolved(body);
      }
      return output;
    }

    this.#logger.warn(`$resolveReference failed: ${safeForLog(error.message)}`);
    return null;
  }
}

module.exports = {
  OclReferenceResolver,
  normalizeReference,
  isOclRepoPath,
  isOrgOwned,
  RESOLVE_PATH
};
