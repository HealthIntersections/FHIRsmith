// The SSRF guard for outbound http(s) requests to addresses that came from somewhere else (a
// registry, a feed, a server's "next" link): http/https agents that refuse to connect to anything
// but a public address. Used by the registry crawler (registry/crawler.js) and by the tx module
// when it asks other servers in the ecosystem (tx/ecosystem-resolver.js)
//
// The check is made when the connection is made, after the DNS lookup, so it also covers redirect
// targets and defeats DNS rebinding. Node doesn't do a lookup when the host is an IP address
// (http://127.0.0.1/, http://169.254.169.254/), so those are checked as well.

const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');
const ipaddr = require('ipaddr.js');

// True if an IP literal is anything other than a normal public (unicast) address:
// loopback, private, link-local (incl. 169.254.169.254 cloud metadata), unique-local,
// CGNAT, multicast, reserved, etc. IPv4-mapped IPv6 addresses are unwrapped first.
function isNonPublicAddress(ip) {
  try {
    let addr = ipaddr.parse(ip);
    if (addr.kind() === 'ipv6' && addr.isIPv4MappedAddress()) {
      addr = addr.toIPv4Address();
    }
    return addr.range() !== 'unicast';
  } catch (e) {
    return true; // unparseable - treat as unsafe
  }
}

/**
 * A dns.lookup replacement that fails if the host resolves to any non-public address
 *
 * @param {boolean} allowPrivate - don't check (e.g. for local test servers)
 */
function guardedLookup(allowPrivate = false) {
  return (hostname, options, callback) => {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    const wantAll = !!(options && options.all);
    dns.lookup(hostname, Object.assign({}, options, { all: true }), (err, addresses) => {
      if (err) {
        callback(err);
        return;
      }
      if (!allowPrivate) {
        for (const a of addresses) {
          if (isNonPublicAddress(a.address)) {
            callback(new Error('Blocked request to non-public address ' + a.address + ' (host ' + hostname + ')'));
            return;
          }
        }
      }
      if (wantAll) {
        callback(null, addresses);
      } else {
        callback(null, addresses[0].address, addresses[0].family);
      }
    });
  };
}

/**
 * http and https agents (keep-alive) that only connect to public addresses. Pass them to axios
 * as httpAgent and httpsAgent
 *
 * @param {Object} [options]
 * @param {boolean} [options.allowPrivate] - don't check (e.g. for local test servers)
 * @returns {{httpAgent: http.Agent, httpsAgent: https.Agent}}
 */
function createGuardedAgents({ allowPrivate = false } = {}) {
  const lookup = guardedLookup(allowPrivate);
  const blockedLiteral = (options) => {
    const host = String(options.host || options.hostname || '').replace(/^\[(.*)\]$/, '$1');
    if (!allowPrivate && net.isIP(host) && isNonPublicAddress(host)) {
      return new Error('Blocked request to non-public address ' + host);
    }
    return null;
  };
  const guard = (Base) => class extends Base {
    createConnection(options, cb) {
      const err = blockedLiteral(options);
      if (err) {
        process.nextTick(() => cb(err));
        return undefined;
      }
      return super.createConnection(Object.assign({}, options, { lookup }), cb);
    }
  };
  const GuardedHttpAgent = guard(http.Agent);
  const GuardedHttpsAgent = guard(https.Agent);
  return {
    httpAgent: new GuardedHttpAgent({ keepAlive: true }),
    httpsAgent: new GuardedHttpsAgent({ keepAlive: true })
  };
}

module.exports = { isNonPublicAddress, guardedLookup, createGuardedAgents };
