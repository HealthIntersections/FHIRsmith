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

// Org-only visibility policy: an artifact is expected to live in an organization
// to be visible through the terminology service. User-owned repos (/users/...)
// are experimental by convention and are excluded from discovery AND resolution.
const REPO_PATH_PATTERN = /^\/orgs\/[^/]+\//;

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
 * organization-owned one (`/orgs/CIEL/sources/CIEL/`). User-owned paths
 * (`/users/joe/...`) are rejected by policy.
 */
function isOclRepoPath(value) {
  return REPO_PATH_PATTERN.test(String(value == null ? '' : value).trim());
}

/**
 * Org-only policy check for an OCL repo payload or resolve result. Prefers the
 * explicit owner_type when present; falls back to the path shape.
 */
function isOrgOwned(repo) {
  if (!repo || typeof repo !== 'object') {
    return false;
  }
  const ownerType = repo.owner_type || repo.ownerType || null;
  if (ownerType) {
    return ownerType === 'Organization';
  }
  return isOclRepoPath(repo.url);
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

function unresolved(request) {
  return {
    resolved: false,
    repoUrl: null,
    canonical: null,
    ownerType: null,
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

  return {
    resolved: Boolean(entry.resolved) && Boolean(repoUrl),
    repoUrl,
    // OCL returns the repo's own canonical_url and owner_type (richer than the
    // documented example). Prefer them over echoing the request back: they are
    // authoritative, the request is just whatever spelling the caller used.
    canonical: result ? (result.canonical_url || result.canonicalUrl || null) : null,
    ownerType: result ? (result.owner_type || result.ownerType || null) : null,
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
  #enabled;
  #disabledReason = null;

  /**
   * @param {object} options
   * @param {object} options.httpClient - axios instance from createOclHttpClient
   * @param {string} [options.token] - when absent the resolver stays disabled:
   *   $resolveReference is authenticated on every OCL instance probed, while the
   *   listing endpoints it replaces are public, so a tokenless call is a
   *   guaranteed 401
   * @param {object} [options.logger]
   */
  constructor({ httpClient, token = null, logger = console } = {}) {
    if (!httpClient) {
      throw new Error('OCL reference resolver requires an http client');
    }

    this.#httpClient = httpClient;
    this.#logger = logger;
    this.#enabled = Boolean(token);
    if (!this.#enabled) {
      this.#disabledReason = 'no token configured';
    }
  }

  isEnabled() {
    return this.#enabled;
  }

  get disabledReason() {
    return this.#disabledReason;
  }

  #disable(reason) {
    this.#enabled = false;
    this.#disabledReason = reason;
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
    if (!this.#enabled) {
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
      const key = cacheKey(body);
      if (!bypassCache && this.#cache.has(key)) {
        output[index] = this.#cache.get(key);
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
        `[OCL] $resolveReference returned ${payload.length} result(s) for ${chunk.length} reference(s); discarding to avoid misaligned results`
      );
      for (const { body, index } of chunk) {
        output[index] = unresolved(body);
      }
      return output;
    }

    chunk.forEach(({ body, index }, position) => {
      let value = normalizeResult(payload[position], body);
      // Org-only policy: a canonical resolving to a user-owned repo is treated as
      // unresolved — user artifacts are experimental and not visible through the
      // terminology service. Cached: the policy outcome is deterministic.
      if (value.resolved && !isOrgOwned({ owner_type: value.ownerType, url: value.repoUrl })) {
        this.#logger.info(
          `[OCL] $resolveReference resolved ${cacheKey(body)} to a user-owned repo (${value.repoUrl}); org-only policy treats it as unresolved`
        );
        value = unresolved(body);
      }
      this.#cache.set(cacheKey(body), value);
      output[index] = value;
    });

    return output;
  }

  #handleError(error, misses, output) {
    const status = error?.response?.status;

    if (status === 404) {
      this.#disable('endpoint not implemented (404)');
      this.#logger.info(
        `[OCL] $resolveReference is not available on this instance (404); using listing search instead`
      );
      return null;
    }

    if (status === 401 || status === 403) {
      this.#disable(`not authorised (${status})`);
      this.#logger.warn(
        `[OCL] $resolveReference rejected our credentials (${status}); using listing search instead`
      );
      return null;
    }

    if (status === 400) {
      // Our request body is wrong — a bug on this side. Don't disable: a later,
      // well-formed batch may be fine.
      const detail = error?.response?.data?.detail || error.message;
      this.#logger.error(`[OCL] $resolveReference rejected the request body: ${detail}`);
      for (const { body, index } of misses) {
        output[index] = unresolved(body);
      }
      return output;
    }

    this.#logger.warn(`[OCL] $resolveReference failed: ${error.message}`);
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
