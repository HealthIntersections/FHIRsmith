//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * The feed check: reads a package feed the way the crawler does, and reports what it finds,
 * without storing anything. For /packages/feed-check (feed-check-page.js is its HTML).
 *
 * For each item, as the crawler would: the guid, title, date and link; whether the registry's
 * package-restrictions allow the package from this feed; the package itself (downloaded, unpacked
 * with the crawler's limits, and checked as the crawler checks it before storing); and its
 * signature, against the keys package-feeds.json lists for the feed. Also whether this registry
 * already holds the version, and if so whether it is the same bytes. Pages (RFC 5005 next links)
 * are followed until maxItems items have been checked. Every request goes through the crawler's
 * SSRF guard.
 */

const crypto = require('crypto');
const PackageCrawler = require('./package-crawler');

const MB = 1024 * 1024;
const QUIET = { info() {}, warn() {}, error() {}, debug() {} };

class FeedCheck {
  /**
   * config: the packages module's config (crawler limits, allowPrivateAddresses).
   * options: master() - the registry's feed list (package-feeds.json), or null; held(id, version)
   * - {hash} (sha1) of the version if this registry holds it, or null; signing - the feed's
   * signing information ({required, keys}) to use instead of the registry's, or null; maxItems;
   * maxTotalMB.
   */
  constructor(config, options) {
    this.config = config;
    this.master = options.master;
    this.held = options.held;
    this.givenSigning = options.signing || null;
    this.maxItems = options.maxItems;
    this.maxTotalBytes = options.maxTotalMB * MB;
  }

  // A crawler that only reads: no database, nothing stored
  reader() {
    const c = Object.create(PackageCrawler.prototype);
    c.config = this.config;
    c.log = QUIET;
    c.totalBytes = 0;
    c.signatureMode = 'check';
    c.abortController = null;
    c.skippedFeeds = new Set();
    // The crawler also reads local files (localFeedDirs). A feed being checked is someone
    // else's, so everything it links to - pages, packages, signatures - must be http(s)
    for (const name of ['fetchXml', 'fetchUrl', 'fetchJson']) {
      const real = PackageCrawler.prototype[name];
      c[name] = function (url, ...rest) {
        if (!/^https?:\/\//i.test(String(url))) {
          return Promise.reject(new Error(`Not fetched: ${url} is not an http(s) URL`));
        }
        return real.call(this, url, ...rest);
      };
    }
    return c;
  }

  /** Checks the feed at url. progress(report) is called as items are checked. Returns the report. */
  async run(url, progress = () => {}) {
    const c = this.reader();
    const feedUrl = c.fixUrl(url);
    const report = {
      url, started: new Date().toISOString(), finished: null,
      registered: null, signing: null, signingSource: null, pages: [], items: [], errors: [], notes: [], truncated: false
    };

    let master = null;
    try {
      master = await this.master();
    } catch (e) {
      report.notes.push(`The registry's feed list couldn't be read, so package restrictions and signing keys aren't checked: ${e.message}`);
    }
    const entry = (master?.feeds || []).find(f => f && f.url && c.fixUrl(f.url) === feedUrl);
    const restrictions = master?.['package-restrictions'] || [];
    if (entry) {
      report.registered = { name: entry.name || null };
    } else if (master) {
      report.notes.push(this.givenSigning
        ? 'This feed isn\'t in the registry\'s feed list (package-feeds.json), so the crawler doesn\'t read it. Signatures are checked against the keys given.'
        : 'This feed isn\'t in the registry\'s feed list (package-feeds.json), so the crawler doesn\'t read it, and there are no signing keys to check signatures against.');
    }
    // the signing information given with the check, if any, instead of the registry's
    const signing = this.givenSigning ? c.signingFor(this.givenSigning) : entry ? c.signingFor(entry.signing) : null;
    if (signing) {
      report.signing = { required: signing.required, keys: signing.keys.map(k => k.keyid) };
      report.signingSource = this.givenSigning ? 'given' : 'registry';
    }

    const seenPages = new Set();
    const seenTitles = new Set();
    let pageUrl = feedUrl;
    while (pageUrl) {
      if (seenPages.has(pageUrl)) {
        report.errors.push(`The feed's pages loop: ${pageUrl} is linked as a next page again`);
        break;
      }
      seenPages.add(pageUrl);
      let xml;
      try {
        xml = await c.fetchXml(pageUrl);
      } catch (e) {
        report.errors.push(e.message);
        break;
      }
      const channel = xml && xml.rss && xml.rss.channel;
      if (!channel) {
        report.errors.push(`${pageUrl} is not an RSS feed (there is no rss/channel)`);
        break;
      }
      const items = Array.isArray(channel.item) ? channel.item : [channel.item].filter(Boolean);
      report.pages.push({ url: pageUrl, items: items.length });
      let stopped = false;
      for (const item of items) {
        if (report.items.length >= this.maxItems) {
          report.truncated = true;
          stopped = true;
          break;
        }
        const result = await this.checkItem(c, item, feedUrl, signing, restrictions, seenTitles);
        report.items.push(result);
        progress(report);
        if (result.rateLimited) {
          report.errors.push('The feed\'s server is rate limiting requests (HTTP 429), so the check stopped');
          stopped = true;
          break;
        }
      }
      if (stopped) {
        break;
      }
      const links = channel['atom:link'] ? (Array.isArray(channel['atom:link']) ? channel['atom:link'] : [channel['atom:link']]) : [];
      const next = links.find(l => l && l['@_rel'] === 'next' && l['@_href']);
      pageUrl = next ? c.fixUrl(next['@_href']) : null;
    }
    if (report.pages.length > 0 && report.items.length === 0 && report.errors.length === 0) {
      report.notes.push('The feed has no items');
    }
    report.downloadedMB = Math.round(c.totalBytes / MB * 10) / 10;
    report.finished = new Date().toISOString();
    return report;
  }

  async checkItem(c, item, feedUrl, signing, restrictions, seenTitles) {
    const r = { title: null, guid: null, link: null, date: null, status: 'ok', problems: [], warnings: [], package: null, signature: null, held: null };
    const text = v => (v && typeof v === 'object' ? v['#text'] : v);
    r.title = text(item.title) ? String(text(item.title)).trim() : null;
    r.guid = item.guid && text(item.guid) ? String(text(item.guid)) : null;
    r.link = text(item.link) ? String(text(item.link)).trim() : null;
    const done = () => {
      r.status = r.skipped ? 'skipped' : r.problems.length > 0 ? 'error' : 'ok';
      return r;
    };

    if (!r.guid) {
      r.problems.push('There is no guid, so the crawler can\'t process this item');
    }
    if (!r.title) {
      r.problems.push('There is no title (it should be {id}#{version})');
      return done();
    }
    if (!/^[^#\s]+#[^#\s]+$/.test(r.title)) {
      r.warnings.push(`The title isn't {id}#{version}: ${r.title}`);
    }
    if (text(item.notForPublication) === 'true' || text(item.notForPublication) === true) {
      r.skipped = 'The item is marked notForPublication, so the crawler ignores it';
      return done();
    }
    const allowed = c.isPackageAllowed(r.title, feedUrl, restrictions);
    if (!allowed.allowed) {
      r.problems.push(`The registry doesn't allow ${r.title.split('#')[0]} from this feed (it may come from ${allowed.allowedFeeds})`);
    }
    if (seenTitles.has(r.title)) {
      r.warnings.push('This version is listed more than once in the feed; the crawler only takes the first');
    }
    seenTitles.add(r.title);
    let date = null;
    try {
      date = c.parsePubDate(text(item.pubDate));
      r.date = date.toISOString();
    } catch (e) {
      r.problems.push(`The pubDate isn't a valid date: ${text(item.pubDate) || '(missing)'}`);
    }
    if (!r.link) {
      r.problems.push('There is no link to the package');
      return done();
    }
    if (c.totalBytes >= this.maxTotalBytes) {
      r.skipped = `Not downloaded: the check has already downloaded ${this.maxTotalBytes / MB} MB, its limit`;
      return done();
    }

    let buf;
    try {
      buf = await c.fetchUrl(c.fixUrl(r.link));
    } catch (e) {
      r.problems.push(e.message);
      r.rateLimited = e.message.includes('RATE_LIMITED');
      return done();
    }
    let npm;
    try {
      npm = await c.extractNpmPackage(buf, `${feedUrl}#${r.guid}`);
    } catch (e) {
      r.problems.push(`The package can't be read: ${e.message}`);
      return done();
    }
    r.package = {
      id: npm.id, version: npm.version, fhirVersions: npm.fhirVersionList || null,
      canonical: npm.canonical || null, sizeKB: Math.round(buf.length / 1024)
    };
    if (`${npm.id}#${npm.version}` !== r.title) {
      r.warnings.push(`The feed says ${r.title}, but the package is ${npm.id}#${npm.version}; the crawler goes by the package`);
    }
    try {
      c.checkPackageContent(npm, r.title, feedUrl);
    } catch (e) {
      r.problems.push(e.message);
    }

    // its signature
    const sigUrl = c.signatureUrl(item);
    if (signing) {
      const itemLog = {};
      let signature;
      try {
        signature = await c.fetchSignature(item);
      } catch (e) {
        signature = { url: sigUrl, fetchError: e.message };
      }
      const verdict = c.checkSignature(signing, signature, buf, npm.id, npm.version, date, itemLog);
      const s = itemLog.signature || '';
      r.signature = {
        url: sigUrl,
        state: s.startsWith('valid') ? 'confirmed' : s === 'unsigned' ? 'absent' : s.startsWith('invalid') ? 'rejected' : 'unfetchable',
        detail: s
      };
      if (verdict.refuse) {
        r.problems.push(`The crawler would refuse this package: ${verdict.refuse}`);
      }
    } else if (sigUrl) {
      r.signature = { url: sigUrl, state: 'unchecked', detail: 'Not checked: there are no keys for this feed in the registry\'s feed list' };
      try {
        const signature = await c.fetchSignature(item);
        if (signature.fetchError) {
          r.signature.detail += `; and it couldn't be fetched: ${signature.fetchError}`;
        } else {
          const keyid = JSON.parse(signature.text)?.verificationMaterial?.publicKey?.hint;
          if (keyid) {
            r.signature.detail += `; it says it was signed with ${keyid}`;
          }
        }
      } catch (e) {
        r.signature.detail += `; and it couldn't be read: ${e.message}`;
      }
    } else {
      r.signature = { url: null, state: 'absent', detail: 'The item has no fhir:signature' };
    }

    // whether this registry already has it
    try {
      const h = await this.held(npm.id, npm.version);
      const sha1 = crypto.createHash('sha1').update(buf).digest('hex');
      r.held = !h ? 'no' : h.hash === sha1 ? 'yes, the same bytes' : 'yes, but different bytes';
    } catch (e) {
      r.held = null;
    }
    return done();
  }
}

module.exports = { FeedCheck };
