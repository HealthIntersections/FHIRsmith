//
// Cache Control Worker - Handles the $cache-control operation
//
// GET  /$cache-control?mode=start   - create a cache, return its (server-issued) id
// POST /$cache-control?mode=start   - as above, optionally front-loading resources
// GET  /$cache-control?mode=end     - tell the server it can release the cache now
// POST /$cache-control?mode=end
// GET  /$cache-control?mode=check   - is this cache still alive? (and keep it alive)
// POST /$cache-control?mode=check
//
// This is the explicit replacement for the implicit `cache-id` parameter protocol:
// the server owns the cache-id namespace, so it can authoritatively reject an
// unknown/expired cache later instead of failing obscurely deep inside a validation.
//

const { TerminologyWorker, CACHE_ID_HEADER } = require('./worker');
const { Parameters } = require('../library/parameters');
const { Issue, buildOperationOutcome, outcomeFromError } = require('../library/operation-outcome');
const { debugLog } = require('../operation-context');

class CacheControlWorker extends TerminologyWorker {
  /**
   * @param {OperationContext} opContext - Operation context
   * @param {Logger} log - Logger instance
   * @param {Provider} provider - Provider for code systems and resources
   * @param {LanguageDefinitions} languages - Language definitions
   * @param {I18nSupport} i18n - Internationalization support
   */
  constructor(opContext, log, provider, languages, i18n) {
    super(opContext, log, provider, languages, i18n);
  }

  opName() {
    return 'cache-control';
  }

  // Not a value-set operation; the base class requires this to be implemented.
  vsHandle() {
    return null;
  }

  /**
   * Express entry point for /$cache-control (GET and POST).
   * Dispatches on the `mode` query parameter.
   * @param {express.Request} req - Express request
   * @param {express.Response} res - Express response
   */
  async handle(req, res) {
    try {
      const mode = this.getMode(req);
      // GET is accepted as well as POST, for consistency with the server's other
      // operations (which are all browsable) and the convenience of poking
      // $cache-control from a browser. The operation is declared affectsState=true
      // in its OperationDefinition, so conformant clients POST; an accidental
      // GET-created cache is an empty entry that self-expires.
      switch (mode) {
        case 'start':
          return await this.start(req, res);
        case 'end':
          return await this.end(req, res);
        case 'check':
          return await this.check(req, res);
        default:
          return res.status(400).json(this.operationOutcome('error', 'invalid',
            `$cache-control requires a 'mode' of 'start', 'end' or 'check'` +
            (mode ? ` (got '${mode}')` : ` (none supplied)`)));
      }
    } catch (error) {
      this.log.error(error);
      debugLog(error);
      req.logInfo = this.usedSources.join('|') + ' - error' + (error.msgId ? ' ' + error.msgId : '');
      const statusCode = error.statusCode || 500;
      return res.status(statusCode).json(
        outcomeFromError(error));
    }
  }

  /**
   * Determine the requested mode. The cache-control mode travels in the query
   * string (?mode=start) so it survives even when a Parameters resource is POSTed
   * as the body; a `mode` parameter in the body is accepted as a fallback.
   * @param {express.Request} req
   * @returns {string|null}
   */
  getMode(req) {
    if (req.query && req.query.mode) {
      return String(req.query.mode);
    }
    if (req.body && req.body.resourceType === 'Parameters') {
      const p = this.findParameter(req.body, 'mode');
      if (p) {
        return this.getParameterValue(p);
      }
    }
    return null;
  }

  /**
   * mode=start: mint a server-issued cache-id, create the (per-endpoint) cache,
   * front-load any supplied resources into it, and return the id in the body.
   *
   * The id is returned in the body rather than a header to keep it readable by
   * browser clients without CORS expose-header configuration; subsequent calls
   * carry it back as the `${CACHE_ID_HEADER}` request header.
   *
   * The cache is created even when no resources are front-loaded: an explicitly
   * empty cache must still *exist* so the server can later tell "cache I issued,
   * currently empty" from "cache-id I never issued". That's why this uses
   * ResourceCache.set (which always creates the entry) rather than add (which
   * ignores empty resource lists).
   *
   * @param {express.Request} req
   * @param {express.Response} res
   */
  async start(req, res) {
    const cache = this.opContext.resourceCache;
    if (!cache) {
      return res.status(500).json(this.operationOutcome('error', 'exception',
        'No resource cache is available on this endpoint'));
    }

    const params = new Parameters(this.buildParameters(req));
    const { txResources, primaryResources } = this.collectSuppliedResources(params.jsonObj);
    const resources = txResources.concat(primaryResources);

    // `sealed` controls whether the cache may grow after creation. When sealed,
    // the cache holds only the resources front-loaded here; when unsealed, later
    // operations accumulate every resource they see into it (see
    // setupAdditionalResources).
    //
    // NOTE: the protocol default is `true`, but the server default here is
    // deliberately `false` during the transition: existing clients that rely on
    // incremental population and do not yet send `sealed` must keep working.
    // Flip this to default-true once all clients send an explicit value.
    const sealed = this.readSealed(params.jsonObj);

    // "<instanceCode>.<uuid>" when this server has an instance code, else a bare UUID
    const cacheId = cache.newCacheId();
    cache.set(cacheId, resources, sealed);

    return res.status(200).json({
      resourceType: 'Parameters',
      parameter: [
        { name: 'cache-id', valueId: cacheId },
        { name: 'sealed', valueBoolean: sealed }
      ]
    });
  }

  /**
   * Read the `sealed` boolean from the start request's Parameters.
   *
   * Server-side default is FALSE (transitional — see start()): a cache is only
   * sealed if the client explicitly asks for it. Accepts a real JSON boolean or
   * the string "true"/"false" for robustness across clients.
   *
   * @param {Object} params - Parameters resource (jsonObj)
   * @returns {boolean}
   */
  readSealed(params) {
    const p = this.findParameter(params, 'sealed');
    if (!p) return false;
    const v = this.getParameterValue(p);
    return v === true || v === 'true';
  }

  /**
   * mode=end: release the cache named by the `${CACHE_ID_HEADER}` header so the
   * server can reclaim it now rather than waiting for the idle timeout.
   *
   * Releasing is idempotent: ending an id the server doesn't have is not an error
   * here (the authoritative "unknown cache" signal belongs on the validation path,
   * a later step). A missing header is a client error, though.
   *
   * @param {express.Request} req
   * @param {express.Response} res
   */
  async end(req, res) {
    const cache = this.opContext.resourceCache;
    if (!cache) {
      return res.status(500).json(this.operationOutcome('error', 'exception',
        'No resource cache is available on this endpoint'));
    }

    const cacheId = req.headers[CACHE_ID_HEADER];
    if (!cacheId) {
      return res.status(400).json(this.operationOutcome('error', 'invalid',
        `$cache-control mode=end requires the cache-id in the '${CACHE_ID_HEADER}' header`));
    }

    cache.clear(cacheId);

    return res.status(200).json({ resourceType: 'Parameters', parameter: [] });
  }

  /**
   * mode=check: report whether the cache named by the `${CACHE_ID_HEADER}` header is
   * still alive, and - if it is - reset its idle clock.
   *
   * This is a keepalive as much as a probe, and deliberately so. A client's own
   * local cache absorbs most of its terminology work, so the server can see nothing
   * from a client that is still very much running and still relying on its cache;
   * the cache then times out mid-job and the next request that finally does reach
   * the server fails. Checking is exactly what a client that still cares about its
   * cache does, so a check counts as use. (The alternative - a read-only `check`
   * plus a separate `touch` - is two operations for one job, and there is no useful
   * case for asking "is my cache alive?" while wanting it to expire anyway.)
   *
   * An unknown cache-id here is a 200 with `valid` = false, NOT the 404 that the
   * validation path returns. A probe must be able to tell "the server is up and
   * says my cache is gone" from "I could not reach the server" - those call for
   * opposite responses, and collapsing them into one failure loses that. This also
   * matches mode=end, which likewise tolerates an id the server doesn't have. The
   * `outcome` parameter carries the same coded issue the validation path would have
   * raised, so a client that wants the reason (never issued here / closed by the
   * client / expired after N minutes idle) has it without a second call.
   *
   * @param {express.Request} req
   * @param {express.Response} res
   */
  async check(req, res) {
    const cache = this.opContext.resourceCache;
    if (!cache) {
      return res.status(500).json(this.operationOutcome('error', 'exception',
        'No resource cache is available on this endpoint'));
    }

    const cacheId = req.headers[CACHE_ID_HEADER];
    if (!cacheId) {
      return res.status(400).json(this.operationOutcome('error', 'invalid',
        `$cache-control mode=check requires the cache-id in the '${CACHE_ID_HEADER}' header`));
    }

    // Read the status BEFORE touching: the idle time is the interesting part of the
    // answer, and refreshing first would report zero every time.
    const status = cache.status(cacheId);

    if (!status.exists) {
      const { messageId, params } = cache.describeMissing(cacheId);
      const issue = new Issue('error', 'not-found', null, messageId,
        this.i18n.translate(messageId, this.opContext.langs, params),
        'cache-id-unknown', 404).asIssue();
      this.log.info(`cache-id '${cacheId}': check -> not valid (${messageId})`);
      return res.status(200).json({
        resourceType: 'Parameters',
        parameter: [
          { name: 'cache-id', valueId: cacheId },
          { name: 'valid', valueBoolean: false },
          { name: 'outcome', resource: { resourceType: 'OperationOutcome', issue: [issue] } }
        ]
      });
    }

    cache.touch(cacheId);

    const parameter = [
      { name: 'cache-id', valueId: cacheId },
      { name: 'valid', valueBoolean: true },
      { name: 'sealed', valueBoolean: status.sealed },
      { name: 'resource-count', valueUnsignedInt: status.resources },
      { name: 'idle', valueUnsignedInt: Math.floor(status.idleMs / 1000) }
    ];
    // The timeout lets a client work out how often it needs to check, instead of
    // guessing against a number it cannot see. Omitted if this server isn't saying.
    if (status.timeoutMs !== null && status.timeoutMs !== undefined) {
      parameter.push({ name: 'timeout', valueUnsignedInt: Math.floor(status.timeoutMs / 1000) });
    }

    return res.status(200).json({ resourceType: 'Parameters', parameter });
  }

  /**
   * Build an OperationOutcome.
   * @param {string} severity - error, warning, information
   * @param {string} code - Issue code
   * @param {string} message - Diagnostic message
   * @returns {Object} OperationOutcome resource
   */
  operationOutcome(severity, code, message, txIssueType = null) {
    // the shared builder, so that every outcome has details.text and a tx-issue-type coding
    return buildOperationOutcome(severity, code, message, txIssueType);
  }
}

module.exports = { CacheControlWorker, CACHE_ID_HEADER };
