'use strict';

/**
 * Limits on a request to another server, and saying in words which one it hit.
 *
 * axios's `timeout` only covers the wait for the response headers: a server that sends its
 * headers and then a byte now and then holds the request (and whatever waits on it) for as long
 * as it likes. A deadline for the whole request is an AbortSignal (requestDeadline). And axios
 * reports the limits it enforces in its own terms ("maxContentLength size of 10485760 exceeded",
 * "canceled"), which read badly in a log or a report: describeRequestFailure says what happened.
 */

/**
 * A deadline for the whole request, body included, as an AbortSignal for axios's `signal`;
 * joined with another signal (a crawl that can be stopped), if there is one.
 *
 * @param {number} ms - how long the whole request may take
 * @param {AbortSignal} [outer] - another reason to stop (aborting it stops the request too)
 * @returns {{signal: AbortSignal, expired: function(): boolean}} expired: whether it was the
 *   deadline (not the outer signal) that stopped it
 */
function requestDeadline(ms, outer = null) {
  const deadline = AbortSignal.timeout(ms);
  return {
    signal: outer ? AbortSignal.any([outer, deadline]) : deadline,
    expired: () => deadline.aborted
  };
}

function mb(bytes) {
  const n = bytes / (1024 * 1024);
  return `${Number.isInteger(n) ? n : n.toFixed(1)} MB`;
}

/**
 * What went wrong with a request, in words: the response was larger than maxBytes, it didn't
 * finish within timeoutMs, or otherwise the error's own message
 *
 * @param {Error} error - what axios threw
 * @param {Object} limits
 * @param {number} [limits.timeoutMs] - the deadline, and axios's timeout
 * @param {number} [limits.maxBytes] - axios's maxContentLength
 * @param {Object} [limits.deadline] - from requestDeadline
 * @returns {string}
 */
function describeRequestFailure(error, { timeoutMs, maxBytes, deadline } = {}) {
  const message = (error && error.message) || String(error);
  if (/maxContentLength/.test(message)) {
    return maxBytes ? `the response is more than ${mb(maxBytes)}` : 'the response is too large';
  }
  const expired = deadline && deadline.expired();
  // ECONNABORTED: axios's own timeout (no headers in time); canceled: the deadline
  if (expired || (error && error.code === 'ECONNABORTED' && /timeout/i.test(message))) {
    return timeoutMs ? `no complete response within ${timeoutMs / 1000} s` : 'no complete response in time';
  }
  return message;
}

module.exports = { requestDeadline, describeRequestFailure };
