//
// Copyright 2025, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

const axios = require('axios');
const {XMLParser} = require('fast-xml-parser');
const crypto = require('crypto');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const dns = require('dns');
const http = require('http');
const https = require('https');
const ipaddr = require('ipaddr.js');
const {debugLog} = require("../tx/operation-context");

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

class PackageCrawler {
  log;
  packages = new Set();

  constructor(config, db, stats) {
    this.config = config;
    this.db = db;
    this.stats = stats;
    this.totalBytes = 0;
    this.crawlerLog = {};
    this.errors = '';
    this.abortController = null;
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA busy_timeout = 5000');
  }

  async isFeedPageVisited(url) {
    return new Promise((resolve, reject) => {
      this.db.get('SELECT Url FROM FeedPages WHERE Url = ?', [url], (err, row) => {
        if (err) reject(err);
        else resolve(!!row);
      });
    });
  }

  async markFeedPageVisited(url) {
    return new Promise((resolve, reject) => {
      this.db.run(
        'INSERT OR REPLACE INTO FeedPages (Url, VisitedAt) VALUES (?, ?)',
        [url, new Date().toISOString()],
        (err) => { if (err) reject(err); else resolve(); }
      );
    });
  }

  async crawl(log) {
    this.log = log;
    this.packages.clear();
    this.abortController = new AbortController();

    const startTime = Date.now();
    this.crawlerLog = {
      startTime: new Date().toISOString(),
      master: this.config.masterUrl,
      feeds: [],
      totalBytes: 0,
      errors: ''
    };

    this.log.info('Running web crawler for packages using master URL: '+ this.config.masterUrl);
    this.stats.task('Package Crawler', 'Running');

    try {
      // Fetch the master JSON file
      const masterResponse = await this.fetchJson(this.config.masterUrl);

      if (!masterResponse.feeds || !Array.isArray(masterResponse.feeds)) {
        throw new Error('Invalid master JSON: missing feeds array');
      }

      // Process package restrictions if available
      const packageRestrictions = masterResponse['package-restrictions'] || [];

      // Process each feed
      for (const feedConfig of masterResponse.feeds) {
        if (this.abortController?.signal.aborted) break;
        if (!feedConfig.url) {
          this.log.info('Skipping feed with no URL: '+ feedConfig);
          continue;
        }
        try {
          let url = this.fixUrl(feedConfig.url)
          if (!url.includes('simplifier')) {
            this.stats.task('Package Crawler', 'Running for '+feedConfig.url);
            await this.updateTheFeed(url, this.config.masterUrl,feedConfig.errors ? feedConfig.errors.replace(/\|/g, '@').replace(/_/g, '.') : '', packageRestrictions);
          }
        } catch (feedError) {
          this.log.error(`Failed to process feed ${feedConfig.url}: `+ feedError.message);
          // Continue with next feed even if this one fails
        }
      }
      // process simplifier last
      for (const feedConfig of masterResponse.feeds) {
        if (this.abortController?.signal.aborted) break;
        if (!feedConfig.url) {
          this.log.info('Skipping feed with no URL: '+ feedConfig);
          continue;
        }

        try {
          let url = this.fixUrl(feedConfig.url)
          if (url.includes('simplifier')) {
            this.stats.task('Package Crawler', 'Running for '+feedConfig.url);
            await this.updateTheFeed(url, this.config.masterUrl,feedConfig.errors ? feedConfig.errors.replace(/\|/g, '@').replace(/_/g, '.') : '', packageRestrictions);
          }
        } catch (feedError) {
          this.log.error(`Failed to process feed ${feedConfig.url}: `+ feedError.message);
          // Continue with next feed even if this one fails
        }
      }

      const runTime = Date.now() - startTime;
      this.crawlerLog.runTime = `${runTime}ms`;
      this.crawlerLog.endTime = new Date().toISOString();
      this.crawlerLog.totalBytes = this.totalBytes;

      this.log.info(`Web crawler completed successfully in ${runTime}ms`);
      this.log.info(`Total bytes processed: ${this.totalBytes}`);

      this.stats.taskDone('Package Crawler', 'Complete');
      return this.crawlerLog;

    } catch (error) {
      const runTime = Date.now() - startTime;
      this.crawlerLog.runTime = `${runTime}ms`;
      this.crawlerLog.fatalException = error.message;
      this.crawlerLog.endTime = new Date().toISOString();
      this.stats.taskError('Package Crawler', 'Error: '+error.message);

      this.log.error('Web crawler failed: '+ error);
      throw error;
    }
  }

  fixUrl(url) {
    return url.replace(/^http:/, 'https:');
  }

  // Roots under which local-file feed reads are permitted. Reading local files supports
  // locally-configured feeds (e.g. for testing); allowed roots come from
  // config.localFeedDirs, plus the directory of a local master feed url. Anything else
  // is rejected so a third-party feed can't point a read at an arbitrary server file.
  allowedLocalRoots() {
    const roots = [];
    const cfg = this.config && this.config.localFeedDirs;
    if (Array.isArray(cfg)) {
      roots.push(...cfg);
    } else if (typeof cfg === 'string' && cfg.length > 0) {
      roots.push(cfg);
    }
    if (this.config && typeof this.config.masterUrl === 'string' && this.config.masterUrl.startsWith('/')) {
      roots.push(path.dirname(this.config.masterUrl));
    }
    return roots.map((r) => path.resolve(r));
  }

  // A DNS lookup wrapper that rejects any host resolving to a non-public address.
  // Enforced at connection time (so it also covers redirect targets and defeats
  // DNS-rebinding), this is the SSRF guard for all outbound http(s) fetches.
  // Set config.allowPrivateAddresses = true to disable (e.g. for local test registries).
  ssrfLookup() {
    const allowPrivate = !!(this.config && this.config.allowPrivateAddresses);
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

  // http/https agents that route every connection through the SSRF lookup. Cached so
  // connections can be pooled across requests.
  guardedAgents() {
    if (!this._guardedAgents) {
      const lookup = this.ssrfLookup();
      class GuardedHttpAgent extends http.Agent {
        createConnection(options, cb) {
          return super.createConnection(Object.assign({}, options, { lookup }), cb);
        }
      }
      class GuardedHttpsAgent extends https.Agent {
        createConnection(options, cb) {
          return super.createConnection(Object.assign({}, options, { lookup }), cb);
        }
      }
      this._guardedAgents = {
        httpAgent: new GuardedHttpAgent({ keepAlive: true }),
        httpsAgent: new GuardedHttpsAgent({ keepAlive: true })
      };
    }
    return this._guardedAgents;
  }

  // Resolve a local feed path and confine it to an allowed root (path-injection guard).
  resolveLocalReadPath(url) {
    const resolved = path.resolve(url);
    const roots = this.allowedLocalRoots();
    const allowed = roots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
    if (!allowed) {
      throw new Error('Refusing to read local file outside the allowed feed directories: ' + url);
    }
    return resolved;
  }

  async fetchJson(url) {
    try {
      if (url.startsWith("/")) {
        const content = await fs.promises.readFile(this.resolveLocalReadPath(url), "utf8");
        return JSON.parse(content);
      } else {
        const response = await axios.get(url, {
          timeout: 30000,
          signal: this.abortController?.signal,
          headers: {
            'User-Agent': 'FHIR Package Crawler/1.0'
          },
          httpAgent: this.guardedAgents().httpAgent,
          httpsAgent: this.guardedAgents().httpsAgent
        });
        return response.data;
      }
    } catch (error) {
      debugLog(error);
      if (error.response && error.response.status === 429) {
        throw new Error(`RATE_LIMITED: Server returned 429 Too Many Requests for ${url}`);
      }
      throw new Error(`Failed to fetch JSON from ${url}: ${error.message}`);
    }
  }

  async fetchXml(url) {
    try {
      if (url.startsWith("/")) {
        const content = await fs.promises.readFile(this.resolveLocalReadPath(url), 'utf8');
        const parser = new XMLParser({
          ignoreAttributes: false,
          attributeNamePrefix: '@_',
          textNodeName: '#text',
          entityExpansionLimit: 100000
        });
        return parser.parse(content);
      } else {
        const response = await axios.get(url, {
          timeout: 30000,
          signal: this.abortController?.signal,
          headers: {
            'User-Agent': 'FHIR Package Crawler/1.0'
          },
          httpAgent: this.guardedAgents().httpAgent,
          httpsAgent: this.guardedAgents().httpsAgent
        });

        const parser = new XMLParser({
          ignoreAttributes: false,
          attributeNamePrefix: '@_',
          textNodeName: '#text',
          entityExpansionLimit: 100000
        });
        return parser.parse(response.data);
      }
    } catch (error) {
      debugLog(`Failed to fetch XML from ${url}: ${error.message}`);
      if (error.response && error.response.status === 429) {
        throw new Error(`RATE_LIMITED: Server returned 429 Too Many Requests for ${url}`);
      }
      throw new Error(`Failed to fetch XML from ${url}: ${error.message}`);
    }
  }

  async fetchUrl(url) {
    try {
      if (url.startsWith("/")) {
        const buffer = await fs.promises.readFile(this.resolveLocalReadPath(url));
        this.totalBytes += buffer.byteLength;
        return buffer;
      } else {
        const response = await axios.get(url, {
          timeout: 60000,
          responseType: 'arraybuffer',
          // We want the package file's own bytes: decodePackageBody undoes the Content-Encoding
          decompress: false,
          signal: this.abortController?.signal,
          headers: {
            'User-Agent': 'FHIR Package Crawler/1.0'
          },
          httpAgent: this.guardedAgents().httpAgent,
          httpsAgent: this.guardedAgents().httpsAgent
        });

        this.totalBytes += response.data.byteLength;
        return this.decodePackageBody(Buffer.from(response.data), response.headers['content-encoding']);
      }
    } catch (error) {
      debugLog(`Failed to fetch ${url}: ${error.message}`);
      if (error.response && error.response.status === 429) {
        throw new Error(`RATE_LIMITED: Server returned 429 Too Many Requests for ${url}`);
      }
      throw new Error(`Failed to fetch ${url}: ${error.message}`);
    }
  }

  // Undoes the HTTP Content-Encoding of a downloaded package. A .tgz is already gzip, and some
  // servers (doc.mednet.swiss, for one) label it Content-Encoding: gzip / x-gzip whatever the
  // request asks for, as if the tar had been compressed for transfer. Unzipping that, as an
  // HTTP client normally would, leaves a bare tar. So for gzip, the body is taken as the
  // package unless unzipping it gives another gzip file - a server that really did compress
  // a .tgz for transfer.
  decodePackageBody(body, contentEncoding) {
    const encodings = String(contentEncoding || '').toLowerCase().split(',').map(e => e.trim()).filter(e => e && e !== 'identity');
    for (const enc of encodings.reverse()) {
      if (enc === 'gzip' || enc === 'x-gzip') {
        try {
          const inner = zlib.gunzipSync(body);
          if (inner[0] === 0x1f && inner[1] === 0x8b) {
            body = inner;
          }
        } catch (e) {
          // not gzip after all: leave it for extractNpmPackage to report
        }
      } else if (enc === 'br') {
        body = zlib.brotliDecompressSync(body);
      } else if (enc === 'deflate') {
        body = zlib.inflateSync(body);
      } else {
        throw new Error(`Unsupported Content-Encoding ${enc}`);
      }
    }
    return body;
  }

  async updateTheFeed(url, source, email, packageRestrictions) {
    const feedLog = {
      url: url,
      items: []
    };
    this.crawlerLog.feeds.push(feedLog);

    this.log.info('Processing feed: ' + url);
    const startTime = Date.now();

    // The first page (the root feed URL) is always processed — it contains the
    // latest packages. Subsequent pages (followed via atom:link rel="next") are
    // historical archives and only need to be visited once.
    let currentUrl = url;
    let isFirstPage = true;

    while (currentUrl) {
      if (this.abortController?.signal.aborted) break;

      if (!isFirstPage) {
        const alreadyVisited = await this.isFeedPageVisited(currentUrl);
        if (alreadyVisited) {
          this.log.info(`Feed page already visited, stopping: ${currentUrl}`);
          break;
        }
      }

      try {
        this.log.info(`Fetching feed page: ${currentUrl}`);
        const xmlData = await this.fetchXml(currentUrl);
        if (isFirstPage) feedLog.fetchTime = `${Date.now() - startTime}ms`;

        let items = [];
        let nextUrl = null;

        if (xmlData.rss && xmlData.rss.channel) {
          const channel = xmlData.rss.channel;
          items = Array.isArray(channel.item) ? channel.item : [channel.item].filter(Boolean);

          // Check for RFC 5005 next-page link: <atom:link rel="next" href="..."/>
          const atomLinks = channel['atom:link'];
          if (atomLinks) {
            const links = Array.isArray(atomLinks) ? atomLinks : [atomLinks];
            const nextLink = links.find(l => l['@_rel'] === 'next');
            if (nextLink && nextLink['@_href']) {
              nextUrl = this.fixUrl(nextLink['@_href']);
            }
          }
        }

        this.log.info(`Found ${items.length} items in feed page ${currentUrl}`);

        let rateLimited = false;
        for (let i = 0; i < items.length; i++) {
          if (this.abortController?.signal.aborted) break;
          try {
            await this.updateItem(currentUrl, items[i], i, packageRestrictions, feedLog);
          } catch (itemError) {
            if (itemError.message.includes('RATE_LIMITED')) {
              this.log.info(`Rate limited while downloading package from ${currentUrl}, stopping feed processing`);
              feedLog.rateLimited = true;
              feedLog.rateLimitedAt = `item ${i}`;
              feedLog.rateLimitMessage = itemError.message;
              rateLimited = true;
              break;
            }
            this.log.error(`Error processing item ${i} from ${currentUrl}:` + itemError.message);
          }
        }

        if (rateLimited) break;

        // Mark this page as visited now that we've successfully processed it.
        // Don't mark the first page — it must always be re-crawled for new entries.
        if (!isFirstPage) {
          await this.markFeedPageVisited(currentUrl);
        }

        currentUrl = nextUrl;
        isFirstPage = false;

      } catch (error) {
        debugLog(error);
        if (error.message.includes('RATE_LIMITED')) {
          this.log.info(`Rate limited while fetching feed ${currentUrl}, stopping`);
          feedLog.rateLimited = true;
          feedLog.rateLimitMessage = error.message;
          feedLog.failTime = `${Date.now() - startTime}ms`;
          break;
        }
        feedLog.exception = error.message;
        feedLog.failTime = `${Date.now() - startTime}ms`;
        this.log.error(`Exception processing feed ${currentUrl}:` + error.message);
        break;
      }
    }

    if (this.errors && email && !feedLog.rateLimited) {
      this.log.info(`Would send error email to ${email} for feed ${url}`);
    }
  }

  async updateItem(source, item, index, packageRestrictions, feedLog) {
    const itemLog = {
      status: '??'
    };
    feedLog.items.push(itemLog);

    try {
      // Extract GUID
      if (!item.guid || !item.guid['#text']) {
        const error = `Error processing item from ${source}#item[${index}]: no guid provided`;
        this.log.info(error);
        itemLog.error = 'no guid provided';
        itemLog.status = 'error';
        return;
      }

      const guid = item.guid['#text'];
      itemLog.guid = guid;

      // Extract title (package ID)
      const id = item.title;
      itemLog.id = id;

      if (!id) {
        itemLog.error = 'no title/id provided';
        itemLog.status = 'error';
        return;
      }

      // Check if not for publication
      if (item.notForPublication && item.notForPublication['#text'] === 'true') {
        itemLog.status = 'not for publication';
        itemLog.error = 'not for publication';
        return;
      }

      // Check package restrictions
      if (!this.isPackageAllowed(id, source, packageRestrictions).allowed) {
        if (!source.includes('simplifier.net')) {
          const error = `The package ${id} is not allowed to come from ${source}`;
          this.log.info(error);
          itemLog.error = error;
          itemLog.status = 'prohibited source';
        } else {
          itemLog.status = 'ignored';
          itemLog.error = `The package ${id} is published through another source`;
        }
        return;
      }

      if (this.packages.has(id)) {
        this.log.info(`Ignoring package ${id} because it's already been seen in another feed`);
        itemLog.status = 'Seen in another feed';
        return;
      }
      this.packages.add(id);

      // Check if already processed
      if (await this.hasStored(guid)) {
        itemLog.status = 'Already Processed';
        return;
      }

      // A new GUID for an id#version we already hold: decide before downloading anything.
      // store() checks again against the id#version inside the tarball.
      const [titleId, titleVersion] = id.split('#');
      if (titleId && titleVersion) {
        const check = await this.checkVersion(titleId, titleVersion, guid);
        if (check.action === 'skip') {
          itemLog.status = 'Already Stored';
          return;
        }
        if (check.action === 'error') {
          this.log.error(check.reason);
          itemLog.status = 'error';
          itemLog.error = check.reason;
          return;
        }
      }

      // Parse publication date
      let pubDate;
      let pd;
      try {
        let pd = item.pubDate;
        pubDate = this.parsePubDate(pd);
      } catch (error) {
        itemLog.error = `Invalid date format '${pd}': ${error.message}`;
        itemLog.status = 'error';
        return;
      }

      // Extract URL and fetch package
      const url = this.fixUrl(item.link);
      if (!url) {
        itemLog.error = 'no link provided';
        itemLog.status = 'error';
        return;
      }

      itemLog.url = url;
      this.log.info('Fetching package: ' + url);

      const packageContent = await this.fetchUrl(url, 'application/tar+gzip');
      const outcome = await this.store(source, url, guid, pubDate, packageContent, id, itemLog);

      itemLog.status = {stored: 'Fetched', replaced: 'Replaced Simplifier copy', skipped: 'Already Stored'}[outcome];

    } catch (error) {
      this.log.error(`Exception processing item ${itemLog.guid || index} from ${source}: `+ error.message);
      itemLog.status = 'Exception';
      itemLog.error = error.message;
      if (error.message.includes('RATE_LIMITED')) {
        throw error;
      }
    }

  }

  isPackageAllowed(packageId, source, restrictions) {
    if (!restrictions || !Array.isArray(restrictions)) {
      return { allowed: true, allowedFeeds: '' };
    }

    // Convert URLs to https for consistent comparison
    const fixUrl = (url) => url.replace(/^http:/, 'https:');

    const fixedPackageId = fixUrl(packageId);
    const fixedSource = fixUrl(source);

    for (const restriction of restrictions) {
      if (!restriction.mask || !restriction.feeds) continue;

      const fixedMask = fixUrl(restriction.mask);

      if (this.matchesPattern(fixedPackageId, fixedMask)) {
        // This package matches a restriction - check if source is allowed
        const allowedFeeds = restriction.feeds.map(feed => fixUrl(feed));
        const feedList = allowedFeeds.join(', ');

        for (const allowedFeed of restriction.feeds) {
          const fixedFeed = fixUrl(allowedFeed);
          if (fixedSource === fixedFeed) {
            return { allowed: true, allowedFeeds: feedList };
          }
        }

        // Package matches restriction but source is not in allowed feeds
        return { allowed: false, allowedFeeds: feedList };
      }
    }

    // No restrictions matched - package is allowed from any source
    return { allowed: true, allowedFeeds: '' };
  }

  matchesPattern(packageId, mask) {
    if (mask.includes('*')) {
      const starIndex = mask.indexOf('*');
      const maskPrefix = mask.substring(0, starIndex);
      const packagePrefix = packageId.substring(0, starIndex);
      return packagePrefix === maskPrefix;
    } else {
      return mask === packageId;
    }
  }

  async hasStored(guid) {
    return new Promise((resolve, reject) => {
      this.db.get('SELECT COUNT(*) as count FROM PackageVersions WHERE GUID = ?', [guid], (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row.count > 0);
        }
      });
    });
  }

  // Simplifier re-publishes packages that other feeds publish directly. Its copy is a
  // secondary echo: kept only until the version arrives directly from a publisher's feed.
  isSimplifierGuid(guid) {
    return /^https?:\/\/packages\.simplifier\.net\//i.test(guid || '');
  }

  async findStoredVersions(id, version) {
    return new Promise((resolve, reject) => {
      this.db.all('SELECT PackageVersionKey, GUID FROM PackageVersions WHERE Id = ? AND Version = ? ORDER BY PackageVersionKey',
        [id, version], (err, rows) => err ? reject(err) : resolve(rows || []));
    });
  }

  // An id#version is stored once. For a copy arriving with a GUID we haven't stored:
  //   store    - we don't hold id#version
  //   replace  - we only hold Simplifier copies, and this copy is direct: it takes their place
  //   skip     - we already hold it, and this copy is a Simplifier echo
  //   error    - we already hold it directly, from a different GUID: the new copy is ignored
  async checkVersion(id, version, guid) {
    const rows = await this.findStoredVersions(id, version);
    if (rows.length === 0) {
      return { action: 'store' };
    }
    if (this.isSimplifierGuid(guid)) {
      return { action: 'skip', reason: `${id}#${version} from ${guid} ignored: already stored from ${rows[0].GUID}` };
    }
    const direct = rows.filter(r => !this.isSimplifierGuid(r.GUID));
    if (direct.length === 0) {
      return { action: 'replace', keys: rows.map(r => r.PackageVersionKey) };
    }
    return { action: 'error', reason: `${id}#${version} from ${guid} ignored: already stored from ${direct[0].GUID}` };
  }

  run(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, (err) => err ? reject(err) : resolve());
    });
  }

  // Point Packages.CurrentVersion at the most recent version of id
  async refreshCurrentVersion(id) {
    const latest = await new Promise((resolve, reject) => {
      this.db.get(`SELECT PackageVersionKey, Canonical FROM PackageVersions
                   WHERE Id = ? AND Version != 'current'
                   ORDER BY PubDate DESC, Version DESC LIMIT 1`, [id], (err, row) => err ? reject(err) : resolve(row));
    });
    if (latest) {
      await this.run('UPDATE Packages SET CurrentVersion = ?, Canonical = ? WHERE Id = ?',
        [latest.PackageVersionKey, latest.Canonical, id]);
    }
  }

  // A direct copy replacing the Simplifier copies we held: it takes over the first row (so its
  // key and download count survive), and any further Simplifier rows go.
  async replaceVersion(keys, packageBuffer, npmPackage, date, guid, id, canonical, urls) {
    const [vkey, ...extra] = keys;
    await this.run(`UPDATE PackageVersions
                    SET GUID = ?, PubDate = ?, Indexed = datetime('now'), Kind = ?, Canonical = ?,
                        FhirVersions = ?, Description = ?, Hash = ?, Author = ?, License = ?,
                        HomePage = ?, Content = ?
                    WHERE PackageVersionKey = ?`,
      [guid, date.toISOString(), npmPackage.kind, canonical, npmPackage.fhirVersionList,
        npmPackage.description, this.genHash(packageBuffer), npmPackage.author, npmPackage.license,
        npmPackage.url, packageBuffer, vkey]);
    for (const key of keys) {
      for (const table of ['PackageFHIRVersions', 'PackageDependencies', 'PackageURLs']) {
        await this.run(`DELETE FROM ${table} WHERE PackageVersionKey = ?`, [key]);
      }
    }
    for (const key of extra) {
      await this.run('DELETE FROM PackageVersions WHERE PackageVersionKey = ?', [key]);
    }
    await this.insertRelatedData(vkey, npmPackage, urls);
    await this.refreshCurrentVersion(id);
  }

  parsePubDate(dateStr) {
    // Handle various RSS date formats
    let cleanDate = dateStr.toLowerCase().replace(/\s+/g, ' ').trim();

    // Remove day of week if present
    if (cleanDate.includes(',')) {
      cleanDate = cleanDate.substring(cleanDate.indexOf(',') + 1).trim();
    } else if (/^(mon|tue|wed|thu|fri|sat|sun)/.test(cleanDate)) {
      cleanDate = cleanDate.substring(cleanDate.indexOf(' ') + 1).trim();
    }

    // Pad single digit day
    if (cleanDate.length > 2 && cleanDate[1] === ' ' && /^\d$/.test(cleanDate[0])) {
      cleanDate = '0' + cleanDate;
    }

    // Try to parse the date
    const date = new Date(cleanDate);
    if (isNaN(date.getTime())) {
      throw new Error(`Cannot parse date: ${dateStr}`);
    }

    return date;
  }

  async store(source, url, guid, date, packageBuffer, idver, itemLog) {
    try {
      // Extract and parse the NPM package
      const npmPackage = await this.extractNpmPackage(packageBuffer, `${source}#${guid}`);

      const {id, version} = npmPackage;

      if (`${id}#${version}` !== idver) {
        const warning = `Warning processing ${idver}: actually found ${id}#${version} in the package`;
        this.log.info(warning);
        itemLog.warning = warning;
      }

      // Validate package data
      if (!this.isValidPackageId(id)) {
        throw new Error(`NPM Id "${id}" is not valid from ${source}`);
      }

      // The id#version in the tarball is what counts, which need not be what the feed said
      const check = await this.checkVersion(id, version, guid);
      if (check.action === 'skip') {
        this.log.info(check.reason);
        return 'skipped';
      }
      if (check.action === 'error') {
        throw new Error(check.reason);
      }

      if (!this.isValidSemVersion(version)) {
        throw new Error(`NPM Version "${version}" is not valid from ${source}`);
      }

      let canonical = npmPackage.canonical || `http://simplifier.net/packages/${id}`;
      if (!this.isAbsoluteUrl(canonical)) {
        throw new Error(`NPM Canonical "${canonical}" is not valid from ${source}`);
      }

      const isTemplate = npmPackage.kind === 2; // fhir.template
      if (npmPackage.hasInstallScripts) {
        throw new Error(`Package ${idver} rejected: contains install scripts (preinstall/install/postinstall)`);
      }
      if (npmPackage.hasJavaScript && !isTemplate && id !== 'hl7.fhir.pubpack') {
        throw new Error(`Package ${idver} rejected: contains JavaScript files but is not a template package`);
      }
      // The feed gate (item.notForPublication) only sees the RSS entry. A package whose
      // feed entry is clean can still carry notForPublication inside the tarball - that is
      // a draft build that must never enter the registry. Reject it here too.
      if (npmPackage.notForPublication) {
        throw new Error(`Package ${idver} rejected: tarball is flagged notForPublication (draft build, not suitable for publication)`);
      }

      // Extract URLs from package
      const urls = this.processPackageUrls(npmPackage);

      // Commit to database
      await this.commit(packageBuffer, npmPackage, date, guid, id, version, canonical, urls, check.keys);

      // Only now write the mirror copy: a package that failed validation or didn't commit
      // must not replace the file that is served for the copy we hold
      if (this.config.mirrorPath) {
        let fid = this.fixPrefix(id);
        const filename = `${fid}-${version}.tgz`;
        const filepath = path.join(this.config.mirrorPath, filename);
        fs.writeFileSync(filepath, packageBuffer);
      }

      return check.action === 'replace' ? 'replaced' : 'stored';

    } catch (error) {
      debugLog(error);
      this.log.error(`Error storing package ${guid}:`+ error.message);
      throw error;
    }
  }

  async extractNpmPackage(packageBuffer, source) {
    try {
      const files = {};
      if (packageBuffer.length < 2 || packageBuffer[0] !== 0x1f || packageBuffer[1] !== 0x8b) {
        const start = packageBuffer.subarray(0, 8).toString('hex');
        throw new Error(`not a gzip file (it starts with ${start || 'nothing'})`);
      }

      // First decompress the gzip
      const decompressed = zlib.gunzipSync(packageBuffer);

      // Parse tar manually without any file system operations
      let offset = 0;

      while (offset < decompressed.length) {
        // Read tar header (512 bytes)
        if (offset + 512 > decompressed.length) break;

        const header = decompressed.slice(offset, offset + 512);

        // Check if this is the end (null header)
        if (header[0] === 0) break;

        // Extract filename (first 100 bytes, null-terminated)
        let filename = '';
        for (let i = 0; i < 100; i++) {
          if (header[i] === 0) break;
          filename += String.fromCharCode(header[i]);
        }

        // Extract file size (12 bytes starting at offset 124, octal)
        let sizeStr = '';
        for (let i = 124; i < 136; i++) {
          if (header[i] === 0 || header[i] === 32) break; // null or space
          sizeStr += String.fromCharCode(header[i]);
        }
        const fileSize = parseInt(sizeStr, 8) || 0;

        // Move past header
        offset += 512;

        // Extract file content if we need this file
        if (fileSize > 0) {
          const cleanFilename = filename.replace(/^package\//, ''); // Remove package/ prefix

          const fileContent = decompressed.slice(offset, offset + fileSize);
          files[cleanFilename] = fileContent.toString('utf8');
        }

        // Move to next file (files are padded to 512-byte boundaries)
        const paddedSize = Math.ceil(fileSize / 512) * 512;
        offset += paddedSize;
      }

      // Parse package.json (required)
      if (!files['package.json']) {
        throw new Error('package.json not found in extracted package');
      }

      const packageJson = JSON.parse(files['package.json']);
      const hasInstallScripts = !!(
        packageJson.scripts && (
          packageJson.scripts.preinstall ||
          packageJson.scripts.install ||
          packageJson.scripts.postinstall
        )
      );
      const hasJavaScript = Object.keys(files).some(f => f.endsWith('.js') || f.endsWith('.mjs') || f.endsWith('.cjs'));

      // Extract basic NPM fields
      const id = packageJson.name || '';
      const version = packageJson.version || '';
      const description = packageJson.description || '';
      const author = this.extractAuthor(packageJson.author);
      const license = packageJson.license || '';
      const homepage = packageJson.homepage || packageJson.url || '';

      // Extract dependencies
      const dependencies = [];
      if (packageJson.dependencies) {
        for (const [dep, ver] of Object.entries(packageJson.dependencies)) {
          dependencies.push(`${dep}@${ver}`);
        }
      }

      // Extract FHIR-specific metadata
      let fhirVersion = '';
      let fhirVersionList = '';
      let canonical = '';
      let kind = 1; // Default to IG
      let notForPublication = false;

      // Check for FHIR metadata in package.json
      if (packageJson.fhirVersions) {
        if (Array.isArray(packageJson.fhirVersions)) {
          fhirVersionList = packageJson.fhirVersions.join(',');
          fhirVersion = packageJson.fhirVersions[0] || '';
        } else {
          fhirVersion = packageJson.fhirVersions;
          fhirVersionList = packageJson.fhirVersions;
        }
      } else if (packageJson['fhir-version']) {
        fhirVersion = packageJson['fhir-version'];
        fhirVersionList = packageJson['fhir-version'];
      }

      if (packageJson.canonical) {
        canonical = packageJson.canonical;
      }

      if (packageJson.type === 'fhir.core') {
        kind = 0; // Core
      } else if (packageJson.type === 'fhir.template') {
        kind = 2; // Template
      } else {
        kind = 1; // IG (Implementation Guide)
      }

      if (packageJson.notForPublication === true) {
        notForPublication = true;
      }

      // Parse .index.json if present
      if (files['.index.json']) {
        try {
          const indexJson = JSON.parse(files['.index.json']);

          // Extract additional metadata from .index.json
          if (indexJson['fhir-version'] && !fhirVersion) {
            fhirVersion = indexJson['fhir-version'];
            fhirVersionList = indexJson['fhir-version'];
          }

          if (indexJson.canonical && !canonical) {
            canonical = indexJson.canonical;
          }
        } catch (indexError) {
          this.log.warn(`Warning: Could not parse .index.json for ${id}: ${indexError.message}`);
        }
      }

      // Parse ig.ini if present
      if (files['ig.ini']) {
        try {
          const iniData = this.parseIniFile(files['ig.ini']);

          if (iniData.IG && iniData.IG.canonical && !canonical) {
            canonical = iniData.IG.canonical;
          }

          if (iniData.IG && iniData.IG['fhir-version'] && !fhirVersion) {
            fhirVersion = iniData.IG['fhir-version'];
            fhirVersionList = iniData.IG['fhir-version'];
          }
        } catch (iniError) {
          this.log.warn(`Warning: Could not parse ig.ini for ${id}: ${iniError.message}`);
        }
      }

      // Default fhirVersion if not found
      if (!fhirVersion) {
        fhirVersion = '4.0.1'; // Default to R4
        fhirVersionList = '4.0.1';
      }

      return {
        id,
        version,
        description,
        canonical,
        fhirVersion,
        fhirVersionList,
        author,
        license,
        url: homepage,
        dependencies,
        kind,
        hasInstallScripts,
        hasJavaScript,
        notForPublication,
        files
      };

    } catch (error) {
      console.log(error);
      throw new Error(`Failed to extract NPM package from ${source}: ${error.message}`);
    }
  }

  extractAuthor(author) {
    if (typeof author === 'string') {
      return author;
    } else if (typeof author === 'object' && author.name) {
      return author.name;
    }
    return '';
  }

  parseIniFile(content) {
    const result = {};
    let currentSection = null;

    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();

      // Skip comments and empty lines
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) {
        continue;
      }

      // Check for section header
      const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
      if (sectionMatch) {
        currentSection = sectionMatch[1];
        result[currentSection] = {};
        continue;
      }

      // Check for key=value pair
      const keyValueMatch = trimmed.match(/^([^=]+)=(.*)$/);
      if (keyValueMatch && currentSection) {
        const key = keyValueMatch[1].trim();
        const value = keyValueMatch[2].trim();
        result[currentSection][key] = value;
      }
    }

    return result;
  }

  isValidPackageId(id) {
    // Simple package ID validation
    return /^(@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(id);
  }

  isValidSemVersion(version) {
    // Simple semantic version validation
    return /^\d+\.\d+\.\d+/.test(version);
  }

  isAbsoluteUrl(url) {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  }

  processPackageUrls(npmPackage) {
    const urls = [];

    try {

      for (const filename of Object.keys(npmPackage.files)) {
        try {
          const bytes = npmPackage.files[filename];
          if (filename.endsWith('.json')) {
            try {
              const jsonContent = JSON.parse(bytes);

              if (jsonContent.url && jsonContent.resourceType) {
                urls.push(jsonContent.url);
              }
            } catch (fileError) {
              // this.log.warn(`Error processing package file ${npmPackage.name}#${npmPackage.version}/package/${filename}: ${fileError.message}`);
            }
          }
        } catch (fileError) {
          this.log.warn(`Error processing package file ${npmPackage.name}#${npmPackage.version}/package/${filename}: ${fileError.message}`);
        }
      }
    } catch (error) {
      this.log.warn(`Error processing package URLs for ${npmPackage.name}#${npmPackage.version}:`, error.message);
    }

    // Include main package URL
    if (npmPackage.url) {
      urls.push(npmPackage.url);
    }

    return urls;
  }

  genHash(data) {
    return crypto.createHash('sha1').update(data).digest('hex');
  }

  async commit(packageBuffer, npmPackage, date, guid, id, version, canonical, urls, replaceKeys = null) {
    if (replaceKeys && replaceKeys.length > 0) {
      return this.replaceVersion(replaceKeys, packageBuffer, npmPackage, date, guid, id, canonical, urls);
    }
    return new Promise((resolve, reject) => {
      // Get next version key
      this.db.get('SELECT MAX(PackageVersionKey) as maxKey FROM PackageVersions', (err, row) => {
        if (err) {
          reject(err);
          return;
        }

        const vkey = (row?.maxKey || 0) + 1;
        const hash = this.genHash(packageBuffer);

        // Insert package version
        const insertVersionSql = `
            INSERT INTO PackageVersions
            (PackageVersionKey, GUID, PubDate, Indexed, Id, Version, Kind, DownloadCount,
             Canonical, FhirVersions, UploadCount, Description, ManualToken, Hash,
             Author, License, HomePage, Content)
            VALUES (?, ?, ?, datetime('now'), ?, ?, ?, 0, ?, ?, 1, ?, '', ?, ?, ?, ?, ?)
        `;

        this.db.run(insertVersionSql, [
          vkey, guid, date.toISOString(), id, version, npmPackage.kind,
          canonical, npmPackage.fhirVersionList, npmPackage.description,
          hash, npmPackage.author, npmPackage.license, npmPackage.url,
          packageBuffer
        ], (err) => {
          if (err) {
            reject(err);
            return;
          }

          // Insert FHIR versions, dependencies, and URLs
          this.insertRelatedData(vkey, npmPackage, urls).then(() => {
            // Handle package table (insert or update)
            this.upsertPackage(id, vkey, canonical).then(resolve).catch(reject);
          }).catch(reject);
        });
      });
    });
  }

  async insertRelatedData(vkey, npmPackage, urls) {
    const promises = [];

    // Insert FHIR versions
    if (npmPackage.fhirVersionList) {
      const fhirVersions = npmPackage.fhirVersionList.split(',');
      for (const fver of fhirVersions) {
        promises.push(new Promise((resolve, reject) => {
          this.db.run('INSERT INTO PackageFHIRVersions (PackageVersionKey, Version) VALUES (?, ?)',
            [vkey, fver.trim()], (err) => err ? reject(err) : resolve());
        }));
      }
    }

    // Insert dependencies
    for (const dep of npmPackage.dependencies) {
      promises.push(new Promise((resolve, reject) => {
        this.db.run('INSERT INTO PackageDependencies (PackageVersionKey, Dependency) VALUES (?, ?)',
          [vkey, dep], (err) => err ? reject(err) : resolve());
      }));
    }

    // Insert URLs
    for (const url of urls) {
      promises.push(new Promise((resolve, reject) => {
        this.db.run('INSERT INTO PackageURLs (PackageVersionKey, URL) VALUES (?, ?)',
          [vkey, url], (err) => err ? reject(err) : resolve());
      }));
    }

    return Promise.all(promises);
  }

  async upsertPackage(id, vkey, canonical) {
    return new Promise((resolve, reject) => {
      // Check if package exists
      this.db.get('SELECT MAX(PackageKey) as pkey FROM Packages WHERE Id = ?', [id], (err, row) => {
        if (err) {
          reject(err);
          return;
        }

        if (!row?.pkey) {
          // Insert new package
          this.db.get('SELECT MAX(PackageKey) as maxKey FROM Packages', (err, maxRow) => {
            if (err) {
              reject(err);
              return;
            }

            const pkey = (maxRow?.maxKey || 0) + 1;
            this.db.run('INSERT INTO Packages (PackageKey, Id, CurrentVersion, DownloadCount, Canonical) VALUES (?, ?, ?, 0, ?)',
              [pkey, id, vkey, canonical], (err) => err ? reject(err) : resolve());
          });
        } else {
          // Update existing package - check if this is the most recent version
          this.db.get(`
              SELECT PackageVersionKey
              FROM PackageVersions
              WHERE Id = ?
                AND Version != 'current'
              ORDER BY PubDate DESC, Version DESC LIMIT 1
          `, [id], (err, latestRow) => {
            if (err) {
              reject(err);
              return;
            }

            if (latestRow?.PackageVersionKey === vkey) {
              // This is the most recent version, update the package
              this.db.run('UPDATE Packages SET Canonical = ?, CurrentVersion = ? WHERE Id = ?',
                [canonical, vkey, id], (err) => err ? reject(err) : resolve());
            } else {
              resolve(); // Not the most recent, no update needed
            }
          });
        }
      });
    });
  }

  fixPrefix(id) {
    if (id && id.startsWith("@") && id.includes("/")) {
      return id.replace("@", "$$").replace("/", "$");
    } else {
      return id;
    }
  }
  shutdown() {
    if (this.abortController) {
      this.abortController.abort();
    }
  }
}

module.exports = PackageCrawler;