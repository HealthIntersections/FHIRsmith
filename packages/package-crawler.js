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
const net = require('net');
const http = require('http');
const https = require('https');
const ipaddr = require('ipaddr.js');
const {debugLog} = require("../tx/operation-context");
const {Parser: TarParser} = require('tar');

const MB = 1024 * 1024;

// Limits on what a package can make the crawler download, unpack and hold in memory, so
// that a hostile or broken package (a decompression bomb, say) costs a bounded amount.
// All can be set in the packages "crawler" config section:
//   maxDownloadMB  the package file as downloaded (or read from a local feed)
//   maxUnpackedMB  the total of the package's files once unzipped. The files are streamed,
//                  not held, so this limits the work, not the memory
//   maxFileMB      a file the crawler reads: package.json, .index.json, ig.ini, and each
//                  .json file (for its url). Memory is bounded by this, not by the package
//   maxFiles       the number of files in the package
const LIMIT_DEFAULTS = { maxDownloadMB: 250, maxUnpackedMB: 4096, maxFileMB: 50, maxFiles: 250000 };

function crawlerLimits(config) {
  const c = { ...LIMIT_DEFAULTS, ...(config?.crawler || {}) };
  return {
    maxDownloadBytes: c.maxDownloadMB * MB,
    maxUnpackedBytes: c.maxUnpackedMB * MB,
    maxFileBytes: c.maxFileMB * MB,
    maxFiles: c.maxFiles
  };
}

// The files in a package that the crawler reads for its metadata
const META_FILES = new Set(['package.json', '.index.json', 'ig.ini']);

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

// True for a loopback address: 127.0.0.0/8, ::1, and IPv4-mapped forms of them
function isLoopbackAddress(ip) {
  try {
    let addr = ipaddr.parse(ip);
    if (addr.kind() === 'ipv6' && addr.isIPv4MappedAddress()) {
      addr = addr.toIPv4Address();
    }
    return addr.range() === 'loopback';
  } catch (e) {
    return false;
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
  // allowLoopback lets loopback addresses through, and nothing else that isn't public.
  ssrfLookup(allowLoopback = false) {
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
            if (isNonPublicAddress(a.address) && !(allowLoopback && isLoopbackAddress(a.address))) {
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
  // connections can be pooled across requests. Node doesn't do a lookup when the host is
  // an IP address (http://127.0.0.1/, http://169.254.169.254/), so those are checked here.
  // allowLoopback: loopback addresses are allowed too (/npm-check, so it can check this
  // server itself); other non-public addresses are still refused. The crawler doesn't use it.
  guardedAgents({allowLoopback = false} = {}) {
    this._guardedAgentSets = this._guardedAgentSets || {};
    const key = allowLoopback ? 'loopback' : 'public';
    if (!this._guardedAgentSets[key]) {
      const lookup = this.ssrfLookup(allowLoopback);
      const allowPrivate = !!(this.config && this.config.allowPrivateAddresses);
      const blockedLiteral = (options) => {
        const host = String(options.host || options.hostname || '').replace(/^\[(.*)\]$/, '$1');
        if (!allowPrivate && net.isIP(host) && isNonPublicAddress(host) && !(allowLoopback && isLoopbackAddress(host))) {
          return new Error('Blocked request to non-public address ' + host);
        }
        return null;
      };
      class GuardedHttpAgent extends http.Agent {
        createConnection(options, cb) {
          const err = blockedLiteral(options);
          if (err) {
            process.nextTick(() => cb(err));
            return undefined;
          }
          return super.createConnection(Object.assign({}, options, { lookup }), cb);
        }
      }
      class GuardedHttpsAgent extends https.Agent {
        createConnection(options, cb) {
          const err = blockedLiteral(options);
          if (err) {
            process.nextTick(() => cb(err));
            return undefined;
          }
          return super.createConnection(Object.assign({}, options, { lookup }), cb);
        }
      }
      this._guardedAgentSets[key] = {
        httpAgent: new GuardedHttpAgent({ keepAlive: true }),
        httpsAgent: new GuardedHttpsAgent({ keepAlive: true })
      };
    }
    return this._guardedAgentSets[key];
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
      const limits = crawlerLimits(this.config);
      if (url.startsWith("/")) {
        const localPath = this.resolveLocalReadPath(url);
        const size = (await fs.promises.stat(localPath)).size;
        if (size > limits.maxDownloadBytes) {
          throw new Error(`the package is ${Math.round(size / MB)} MB, more than the limit of ${limits.maxDownloadBytes / MB} MB (maxDownloadMB)`);
        }
        const buffer = await fs.promises.readFile(localPath);
        this.totalBytes += buffer.byteLength;
        return buffer;
      } else {
        const response = await axios.get(url, {
          timeout: 60000,
          responseType: 'arraybuffer',
          // We want the package file's own bytes: decodePackageBody undoes the Content-Encoding
          decompress: false,
          maxContentLength: limits.maxDownloadBytes,
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
      if (/maxContentLength/.test(error.message)) {
        throw new Error(`Failed to fetch ${url}: the package is more than the limit of ${crawlerLimits(this.config).maxDownloadBytes / MB} MB (maxDownloadMB)`);
      }
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
    // undoing the transfer encoding gives the package file, so the download limit applies
    const max = { maxOutputLength: crawlerLimits(this.config).maxDownloadBytes };
    const tooBig = (e) => e.code === 'ERR_BUFFER_TOO_LARGE'
      ? new Error(`the package is more than the limit of ${max.maxOutputLength / MB} MB (maxDownloadMB) once its Content-Encoding is undone`) : e;
    const encodings = String(contentEncoding || '').toLowerCase().split(',').map(e => e.trim()).filter(e => e && e !== 'identity');
    for (const enc of encodings.reverse()) {
      if (enc === 'gzip' || enc === 'x-gzip') {
        let start;
        try {
          // only the start is needed to see whether it is gzip inside: a tar unzipped
          // from a .tgz can be far larger than the download limit
          start = zlib.gunzipSync(body.subarray(0, 4096), { finishFlush: zlib.constants.Z_SYNC_FLUSH });
        } catch (e) {
          // not gzip after all: leave it for extractNpmPackage to report
          continue;
        }
        if (start[0] === 0x1f && start[1] === 0x8b) {
          try {
            body = zlib.gunzipSync(body, max);
          } catch (e) {
            throw tooBig(e);
          }
        }
      } else if (enc === 'br') {
        try {
          body = zlib.brotliDecompressSync(body, max);
        } catch (e) {
          throw tooBig(e);
        }
      } else if (enc === 'deflate') {
        try {
          body = zlib.inflateSync(body, max);
        } catch (e) {
          throw tooBig(e);
        }
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
        // id and version are validated, but the file must land in the mirror whatever they say
        if (path.dirname(path.resolve(filepath)) !== path.resolve(this.config.mirrorPath)) {
          throw new Error(`Package ${id}#${version} rejected: its mirror file name is not a plain file name`);
        }
        fs.writeFileSync(filepath, packageBuffer);
      }

      return check.action === 'replace' ? 'replaced' : 'stored';

    } catch (error) {
      debugLog(error);
      this.log.error(`Error storing package ${guid}:`+ error.message);
      throw error;
    }
  }

  // Reads what the crawler needs from a package as the package is unzipped and untarred:
  // package.json, .index.json and ig.ini, the file names, and the url of each resource. Only
  // those files are held, one at a time, so memory is bounded by maxFileMB however large
  // the package unpacks to (see crawlerLimits)
  async unpackPackage(packageBuffer) {
    const limits = crawlerLimits(this.config);
    const meta = {};
    const fileNames = [];
    const resourceUrls = [];
    const skipped = [];

    await new Promise((resolve, reject) => {
      let unpacked = 0;
      let failed = false;
      const gunzip = zlib.createGunzip();
      const fail = (e) => {
        if (!failed) {
          failed = true;
          gunzip.destroy();
          reject(e);
        }
      };

      const parser = new TarParser({
        onReadEntry: (entry) => {
          if (failed || !['File', 'OldFile', 'ContiguousFile'].includes(entry.type)) {
            entry.resume();
            return;
          }
          const name = entry.path.replace(/^package\//, '');
          fileNames.push(name);
          if (fileNames.length > limits.maxFiles) {
            fail(new Error(`the package has more than ${limits.maxFiles} files (maxFiles)`));
            entry.resume();
            return;
          }
          const isMeta = META_FILES.has(name);
          if (!isMeta && !name.endsWith('.json')) {
            entry.resume();
            return;
          }
          if (entry.size > limits.maxFileBytes) {
            if (name === 'package.json') {
              fail(new Error(`package.json is ${Math.round(entry.size / MB)} MB, more than the limit of ${limits.maxFileBytes / MB} MB (maxFileMB)`));
            } else {
              skipped.push(name);
            }
            entry.resume();
            return;
          }
          const chunks = [];
          entry.on('data', (chunk) => chunks.push(chunk));
          entry.on('end', () => {
            if (failed) {
              return;
            }
            const text = Buffer.concat(chunks).toString('utf8');
            if (isMeta) {
              meta[name] = text;
            }
            if (name.endsWith('.json') && name !== 'package.json' && name !== '.index.json') {
              try {
                const json = JSON.parse(text);
                if (json.url && json.resourceType) {
                  resourceUrls.push(json.url);
                }
              } catch (e) {
                // not a resource
              }
            }
          });
        }
      });
      parser.on('warn', (code, message) => {
        if (code === 'TAR_BAD_ARCHIVE') {
          fail(new Error(`not a tar file once unzipped (${message})`));
        }
      });
      parser.on('error', fail);
      parser.on('end', () => {
        if (!failed) {
          resolve();
        }
      });

      gunzip.on('data', (chunk) => {
        if (failed) {
          return;
        }
        unpacked += chunk.length;
        if (unpacked > limits.maxUnpackedBytes) {
          fail(new Error(`the package unzips to more than the limit of ${limits.maxUnpackedBytes / MB} MB (maxUnpackedMB)`));
          return;
        }
        parser.write(chunk);
      });
      gunzip.on('end', () => {
        if (!failed) {
          parser.end();
        }
      });
      gunzip.on('error', (e) => fail(new Error(`could not unzip the package: ${e.message}`)));
      gunzip.end(packageBuffer);
    });

    return { meta, fileNames, resourceUrls, skipped };
  }

  async extractNpmPackage(packageBuffer, source) {
    try {
      if (packageBuffer.length < 2 || packageBuffer[0] !== 0x1f || packageBuffer[1] !== 0x8b) {
        const start = packageBuffer.subarray(0, 8).toString('hex');
        throw new Error(`not a gzip file (it starts with ${start || 'nothing'})`);
      }

      const { meta: files, fileNames, resourceUrls, skipped } = await this.unpackPackage(packageBuffer);

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
      const hasJavaScript = fileNames.some(f => f.endsWith('.js') || f.endsWith('.mjs') || f.endsWith('.cjs'));

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

      if (skipped.length > 0) {
        this.log.warn(`Package ${id}#${version}: ${skipped.length} file(s) are more than the limit of ${crawlerLimits(this.config).maxFileBytes / MB} MB (maxFileMB), so were not read for their url: ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? ', ...' : ''}`);
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
        fileNames,
        resourceUrls
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
    // The whole version must be semver: it goes into the database, URLs and the mirror
    // file name, so a version like 1.0.0/../../x must not get through
    return /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(version);
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
    // the resources' urls are read as the package is unpacked (unpackPackage)
    const urls = [...(npmPackage.resourceUrls || [])];

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