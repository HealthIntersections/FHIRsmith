// Shared public-access gate for OCL repos.
//
// The configured OCL token can see every repo its account has access to, and both
// discovery (listing crawls) and $resolveReference answer anonymous terminology
// requests — so a PRIVATE repo the token can see must never be surfaced. OCL repo
// objects carry `public_access` (`View` | `Edit` | `None`; `None` = private), but
// the listing endpoints and $resolveReference results do NOT include it, so it is
// read from a per-repo GET. Results are cached by repoUrl (bounded LRU) and shared
// between the resolver gate and discovery; a GET error is NOT cached (so a transient
// blip is retried next time rather than pinning a repo as private), and batch checks
// run with a concurrency limit.
//
// Plain .js (not .cjs): jest's collectCoverageFrom globs **/*.js only.

const DEFAULT_CACHE_LIMIT = 5000;
const DEFAULT_CONCURRENCY = 8;

/**
 * Whether an OCL repo's public_access makes it publicly viewable. Fail-closed:
 * anything that is not an explicit public value (incl. null/unknown) is NOT public.
 */
function isPublicAccess(value) {
  const s = String(value == null ? '' : value).trim().toLowerCase();
  return s === 'view' || s === 'edit';
}

// Client input ends up in log lines; strip control characters / newlines and cap
// the length so a crafted reference cannot forge log entries or flood the log.
function safeForLog(value) {
  // Matching control characters is the whole point here (we are scrubbing them).
  // eslint-disable-next-line no-control-regex
  const s = String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]+/g, ' ');
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

// Run fn over items with at most `limit` in flight; preserves input order.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: size }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

class PublicAccessChecker {
  #httpClient;
  #logger;
  #cache = new Map();
  #cacheLimit;
  #concurrency;

  /**
   * @param {object} options
   * @param {object} options.httpClient - axios instance from createOclHttpClient
   * @param {object} [options.logger]
   * @param {number} [options.cacheLimit] - max repoUrls cached (bounded LRU)
   * @param {number} [options.concurrency] - max concurrent repo GETs in a batch
   */
  constructor({ httpClient, logger = console, cacheLimit = DEFAULT_CACHE_LIMIT, concurrency = DEFAULT_CONCURRENCY } = {}) {
    if (!httpClient) {
      throw new Error('PublicAccessChecker requires an http client');
    }
    this.#httpClient = httpClient;
    this.#logger = logger;
    this.#cacheLimit = cacheLimit > 0 ? cacheLimit : DEFAULT_CACHE_LIMIT;
    this.#concurrency = concurrency > 0 ? concurrency : DEFAULT_CONCURRENCY;
  }

  #touch(key) {
    const value = this.#cache.get(key);
    this.#cache.delete(key);
    this.#cache.set(key, value);
    return value;
  }

  #put(key, value) {
    if (this.#cache.has(key)) {
      this.#cache.delete(key);
    }
    this.#cache.set(key, value);
    if (this.#cache.size > this.#cacheLimit) {
      this.#cache.delete(this.#cache.keys().next().value);
    }
  }

  /**
   * Resolve a repo's public visibility.
   * @param {string} repoUrl - relative OCL repo path
   * @param {string|null} [inlineAccess] - public_access if already known (skips the GET)
   * @returns {Promise<{public: boolean, determined: boolean}>} determined=false when
   *   the check errored (not cached, so it is retried later).
   */
  async check(repoUrl, inlineAccess = null) {
    if (inlineAccess != null) {
      return { public: isPublicAccess(inlineAccess), determined: true };
    }
    if (!repoUrl || typeof repoUrl !== 'string') {
      return { public: false, determined: true };
    }
    if (this.#cache.has(repoUrl)) {
      return { public: this.#touch(repoUrl), determined: true };
    }
    try {
      const response = await this.#httpClient.get(repoUrl);
      const repo = response?.data && typeof response.data === 'object' ? response.data : null;
      const pub = isPublicAccess(repo ? (repo.public_access ?? repo.publicAccess ?? null) : null);
      this.#put(repoUrl, pub);
      return { public: pub, determined: true };
    } catch (error) {
      this.#logger.warn(`public_access check failed for ${safeForLog(repoUrl)}: ${safeForLog(error.message)}`);
      return { public: false, determined: false };
    }
  }

  async isPublic(repoUrl, inlineAccess = null) {
    return (await this.check(repoUrl, inlineAccess)).public;
  }

  /**
   * Keep only the repo-like items that are publicly viewable, concurrency-limited.
   * @param {Array} items
   * @param {function} [urlOf] - item -> repoUrl
   * @param {function} [accessOf] - item -> inline public_access (null if not present)
   */
  async filterPublic(items, urlOf = (x) => (x && x.url), accessOf = (x) => (x && (x.public_access ?? x.publicAccess ?? null))) {
    const list = Array.isArray(items) ? items : [];
    const verdicts = await mapLimit(list, this.#concurrency, (item) => this.isPublic(urlOf(item), accessOf(item)));
    return list.filter((_, index) => verdicts[index]);
  }
}

module.exports = {
  PublicAccessChecker,
  isPublicAccess,
  safeForLog,
  mapLimit
};
