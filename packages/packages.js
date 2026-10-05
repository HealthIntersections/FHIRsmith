//
// Copyright 2025, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const PackageCrawler = require('./package-crawler.js');
const htmlServer = require('../library/html-server');
const folders = require('../library/folder-setup');
const escape = require('escape-html');
const Logger = require('../library/logger');
const {validateParameter} = require("../library/utilities");
const {describeCron} = require("../library/cron-utilities");
const {tokenMatches, tokenConfigured} = require("../library/request-token");
const pckLog = Logger.getInstance().child({ module: 'packages' });
const packagesOpenApi = require('./openapi');

// Query parameter rules for validateQueryParams. These are also the contract published in
// openapi.yaml, and tests/packages/openapi.test.js checks that the two agree - so change
// both together.
const SEARCH_PARAMS = {
  name: { maxLength: 100, pattern: /^[a-zA-Z0-9._#-]*$/ },
  dependson: { maxLength: 100, pattern: /^[a-zA-Z0-9._#|@-]*$/ },
  pkgcanonical: { maxLength: 200, pattern: /^[a-zA-Z0-9._:/-]*%?$/ },
  canonical: { maxLength: 200, pattern: /^[a-zA-Z0-9._:/-]*$/ },
  fhirversion: { maxLength: 10, pattern: /^(R2|R2B|R3|R4|R4B|R5|R6)?$/ },
  dependency: { maxLength: 100, pattern: /^[a-zA-Z0-9._#|@-]*$/ },
  sort: { maxLength: 20, pattern: /^-?(name|version|date|count|fhirversion|kind|canonical)$/ },
  objWrapper: { maxLength: 10, pattern: /^(true|false)?$/ },
  // Sent by the Java PackageClient (org.hl7.fhir.utilities.npm). Accepted, but has no
  // effect: a search already returns pre-release versions.
  prerelease: { maxLength: 5, pattern: /^(true|false)?$/ }
};

// /-/v1/search also takes the npm registry search parameters. npm always sends all of
// these; quality, popularity and maintenance are ranking weights, accepted and ignored.
const V1_SEARCH_PARAMS = {
  ...SEARCH_PARAMS,
  text: { maxLength: 200, pattern: /^[a-zA-Z0-9._:@/#| -]*$/ },
  size: { maxLength: 3, pattern: /^\d{1,3}$/ },
  from: { maxLength: 6, pattern: /^\d{1,6}$/ },
  quality: { maxLength: 10, pattern: /^(\d+(\.\d+)?)?$/ },
  popularity: { maxLength: 10, pattern: /^(\d+(\.\d+)?)?$/ },
  maintenance: { maxLength: 10, pattern: /^(\d+(\.\d+)?)?$/ }
};
const V1_SEARCH_MAX_SIZE = 250;

// FHIR release codes accepted by fhirversion=, mapped to the version prefix they select.
const FHIR_RELEASE_VERSIONS = {
  'R2': '1.0',
  'R2B': '1.4',
  'R3': '3.0',
  'R4': '4.0',
  'R4B': '4.3',
  'R5': '5.0',
  'R6': '6.0'
};

// No default for dateValue: a default computed here would be frozen at the date the server
// started. The /updates handler supplies today's date when none is given.
const UPDATES_PARAMS = {
  dateType: { maxLength: 10, pattern: /^(relative|absolute)?$/, default: 'relative' },
  daysValue: { maxLength: 3, pattern: /^\d{1,3}$/, default: '10' },
  dateValue: { maxLength: 10, pattern: /^\d{4}-\d{2}-\d{2}$/ }
};

const BROKEN_PARAMS = {
  filter: { maxLength: 100, pattern: /^[a-zA-Z0-9._-]*$/ }
};

// Path parameter rules for GET /:id/:version (also published in openapi.yaml).
const PACKAGE_ID_PATTERN = /^(@[a-z0-9._-]+\/)?[a-zA-Z0-9._-]+$/;
const PACKAGE_ID_MAX_LENGTH = 100;
const PACKAGE_VERSION_PATTERN = /^[a-zA-Z0-9._-]+$/;
const PACKAGE_VERSION_MAX_LENGTH = 50;

class PackagesModule {
  constructor(stats) {
    this.router = express.Router();
    this.config = null;
    this.db = null;
    this.crawlerJob = null;
    this.crawler = null;
    this.lastRunTime = null;
    this.totalRuns = 0;
    this.lastCrawlerLog = {};
    this.crawlerRunning = false;
    this.setupSecurityMiddleware();
    this.setupRoutes();
    this.stats = stats;
  }

  setupSecurityMiddleware() {
    // Security headers middleware
    this.router.use((req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('X-XSS-Protection', '1; mode=block');
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      res.setHeader('Content-Security-Policy', [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https:",
        "font-src 'self'",
        "connect-src 'self'",
        "frame-ancestors 'none'"
      ].join('; '));
      res.removeHeader('X-Powered-By');
      // RFC 8631: where to find the machine-readable description of this API
      res.setHeader('Link', `<${req.baseUrl}/openapi.json>; rel="service-desc", <${req.baseUrl}/openapi>; rel="service-doc"`);
      next();
    });
  }

  // Parameter validation middleware
  validateQueryParams(allowedParams = {}) {
    return (req, res, next) => {
      try {
        // Check for parameter pollution (arrays) and validate
        const normalized = {};

        for (const [key, value] of Object.entries(req.query)) {
          if (Array.isArray(value)) {
            return res.status(400).json({
              error: 'Parameter pollution detected',
              parameter: key
            });
          }

          if (allowedParams[key]) {
            const config = allowedParams[key];

            if (value !== undefined) {
              if (typeof value !== 'string') {
                return res.status(400).json({
                  error: `Parameter ${key} must be a string`
                });
              }

              if (value.length > (config.maxLength || 255)) {
                return res.status(400).json({
                  error: `Parameter ${key} too long (max ${config.maxLength || 255})`
                });
              }

              if (config.pattern && !config.pattern.test(value)) {
                return res.status(400).json({
                  error: `Parameter ${key} has invalid format`
                });
              }

              normalized[key] = value;
            } else if (config.required) {
              return res.status(400).json({
                error: `Parameter ${key} is required`
              });
            } else {
              normalized[key] = config.default || '';
            }
          } else if (value !== undefined) {
            // Unknown parameter
            return res.status(400).json({
              error: `Unknown parameter: ${key}`
            });
          }
        }

        // Set default values for missing optional parameters
        for (const [key, config] of Object.entries(allowedParams)) {
          if (normalized[key] === undefined && !config.required) {
            normalized[key] = config.default || '';
          }
        }

        // Clear and repopulate in-place (Express 5 makes req.query a read-only getter)
        for (const key of Object.keys(req.query)) delete req.query[key];
        Object.assign(req.query, normalized);
        next();
      } catch (error) {
        pckLog.error('Parameter validation error:', error);
        res.status(500).json({ error: 'Parameter validation failed' });
      }
    };
  }

  buildSecureQuery(baseQuery, conditions = []) {
    let query = baseQuery;
    const params = [];

    conditions.forEach(condition => {
      if (condition.operator === 'LIKE') {
        query += ` AND ${condition.column} LIKE ?`;
        params.push(`%${condition.value}%`);
      } else if (condition.operator === '=') {
        query += ` AND ${condition.column} = ?`;
        params.push(condition.value);
      } else if (condition.operator === 'IN') {
        const placeholders = condition.values.map(() => '?').join(',');
        query += ` AND ${condition.column} IN (${placeholders})`;
        params.push(...condition.values);
      } else if (condition.operator === 'IN_SUBQUERY') {
        query += ` AND ${condition.column} IN (${condition.subquery})`;
        params.push(condition.value);
      } else if (condition.operator === 'TEXT') {
        // A free-text search term: in the package id or its description
        query += ' AND (PackageVersions.Id LIKE ? OR CAST(PackageVersions.Description AS TEXT) LIKE ?)';
        params.push(`%${condition.value}%`, `%${condition.value}%`);
      }
    });
    return { query, params };
  }

  async searchPackages(params, req = null, secure = false) {
    const {
      name = '',
      dependson = '',
      canonicalPkg = '',
      canonicalUrl = '',
      fhirVersion = '',
      dependency = '',
      text = '',
      sort = ''
    } = params;

    return new Promise((resolve, reject) => {
      try {
        let baseQuery;
        const conditions = [];
        let versioned = false;

        // Build base query and conditions
        if (name) {
          versioned = name.includes('#');
          if (name.includes('#')) {
            const [packageId, version] = name.split('#');
            conditions.push({ column: 'PackageVersions.Id', operator: 'LIKE', value: packageId });
            conditions.push({ column: 'PackageVersions.Version', operator: 'LIKE', value: version });
          } else {
            conditions.push({ column: 'PackageVersions.Id', operator: 'LIKE', value: name });
          }
        }

        // Add the missing dependency search logic
        if (dependson) {
          validateParameter(dependson, "dependson", String);
          versioned = /[#|@]/.test(dependson);
          // Dependencies are stored as id@version (npm convention), so accept # and | as
          // the separator too.
          conditions.push({
            column: 'PackageVersions.PackageVersionKey',
            operator: 'IN_SUBQUERY',
            subquery: 'SELECT PackageVersionKey FROM PackageDependencies WHERE Dependency LIKE ?',
            value: `%${dependson.replace(/[#|]/g, '@')}%`
          });
        }

        if (canonicalPkg) {
          if (canonicalPkg.endsWith('%')) {
            conditions.push({ column: 'PackageVersions.Canonical', operator: 'LIKE', value: canonicalPkg.slice(0, -1) });
          } else {
            conditions.push({ column: 'PackageVersions.Canonical', operator: '=', value: canonicalPkg });
          }
        }

        // Add canonical URL search (requires PackageURLs table)
        if (canonicalUrl) {
          conditions.push({
            column: 'PackageVersions.PackageVersionKey',
            operator: 'IN_SUBQUERY',
            subquery: 'SELECT PackageVersionKey FROM PackageURLs WHERE URL LIKE ?',
            value: `${canonicalUrl}%`
          });
        }

        // Add FHIR version search (requires PackageFHIRVersions table)
        if (fhirVersion) {
          const mappedVersion = FHIR_RELEASE_VERSIONS[fhirVersion] || fhirVersion;
          conditions.push({
            column: 'PackageVersions.PackageVersionKey',
            operator: 'IN_SUBQUERY',
            subquery: 'SELECT PackageVersionKey FROM PackageFHIRVersions WHERE Version LIKE ?',
            value: `${mappedVersion}%`
          });
        }

        // Add dependency search
        if (dependency) {
          validateParameter(dependency, "dependency", String);
          // Dependencies are stored as id@version (npm convention). Clients send id#version
          // or id|version (the Java PackageClient sends |), or just id for any version.
          let depQuery;
          if (/[#|@]/.test(dependency)) {
            depQuery = `${dependency.replace(/[#|]/g, '@')}%`;
          } else {
            depQuery = `${dependency}@%`;
          }

          conditions.push({
            column: 'PackageVersions.PackageVersionKey',
            operator: 'IN_SUBQUERY',
            subquery: 'SELECT PackageVersionKey FROM PackageDependencies WHERE Dependency LIKE ?',
            value: depQuery
          });
        }

        // Free text (npm search): every term must appear in the id or the description.
        // npm qualifiers (keywords:, author:, scope: etc.) have no equivalent here and are ignored.
        for (const term of text.split(/\s+/).filter(t => t && !/^[a-z-]+:/.test(t))) {
          conditions.push({ operator: 'TEXT', value: term });
        }

        // Build appropriate base query
        if (versioned) {
          baseQuery = `SELECT Id, Version, PubDate, FhirVersions, Kind, Canonical, Description
                       FROM PackageVersions
                       WHERE PackageVersions.PackageVersionKey > 0`;
        } else {
          baseQuery = `SELECT Packages.Id, Version, PubDate, FhirVersions, Kind,
                              PackageVersions.Canonical, Packages.DownloadCount, Description
                       FROM Packages, PackageVersions
                       WHERE Packages.CurrentVersion = PackageVersions.PackageVersionKey`;
        }

        const { query, params: queryParams } = this.buildSecureQuery(baseQuery, conditions);

        this.db.all(query + ' ORDER BY PubDate', queryParams, (err, rows) => {
          if (err) {
            reject(err);
            return;
          }

          const results = rows.map(row => {
            const packageInfo = {
              name: row.Id,
              version: row.Version,
              fhirVersion: this.interpretVersion(row.FhirVersions),
              canonical: row.Canonical,
              kind: this.codeForKind(row.Kind),
              url: this.buildPackageUrl(row.Id, row.Version, secure, req)
            };

            if (row.PubDate) {
              packageInfo.date = new Date(row.PubDate).toISOString();
            }

            if (!versioned && row.DownloadCount) {
              packageInfo.count = row.DownloadCount;
            }

            if (row.Description) {
              packageInfo.description = Buffer.isBuffer(row.Description)
                ? row.Description.toString('utf8')
                : row.Description;
            }

            return packageInfo;
          });

          resolve(this.applySorting(results, sort));
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  // URL validation for external requests
  validateExternalUrl(url) {
    try {
      const parsed = new URL(url);

      // Only allow http and https
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error(`Protocol ${parsed.protocol} not allowed`);
      }

      // Block private IP ranges
      const hostname = parsed.hostname;
      if (hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname.startsWith('10.') ||
        hostname.startsWith('192.168.') ||
        /^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname)) {
        throw new Error('Private IP addresses not allowed');
      }

      return parsed;
    } catch (error) {
      throw new Error(`Invalid URL: ${error.message}`);
    }
  }

  // Safe HTTP request function
  async safeHttpRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
      try {
        const validatedUrl = this.validateExternalUrl(url);
        const { maxSize = 50 * 1024 * 1024, timeout = 30000 } = options;

        const protocol = validatedUrl.protocol === 'https:' ? require('https') : require('http');

        const request = protocol.get(validatedUrl, (response) => {
          // Check content length
          const contentLength = parseInt(response.headers['content-length'] || '0');
          if (contentLength > maxSize) {
            request.destroy();
            reject(new Error('Response too large'));
            return;
          }

          // Handle redirects safely
          if (response.statusCode >= 300 && response.statusCode < 400) {
            const location = response.headers.location;
            if (!location) {
              reject(new Error('Redirect without location'));
              return;
            }

            const redirectCount = options.redirectCount || 0;
            if (redirectCount >= 5) {
              reject(new Error('Too many redirects'));
              return;
            }

            this.safeHttpRequest(location, { ...options, redirectCount: redirectCount + 1 })
              .then(resolve)
              .catch(reject);
            return;
          }

          if (response.statusCode !== 200) {
            reject(new Error(`HTTP ${response.statusCode}`));
            return;
          }

          let data = Buffer.alloc(0);
          response.on('data', (chunk) => {
            data = Buffer.concat([data, chunk]);
            if (data.length > maxSize) {
              request.destroy();
              reject(new Error('Response too large'));
              return;
            }
          });

          response.on('end', () => {
            resolve(data);
          });
        });

        request.on('error', reject);
        request.setTimeout(timeout, () => {
          request.destroy();
          reject(new Error('Request timeout'));
        });

      } catch (error) {
        reject(error);
      }
    });
  }

  async gatherPackageStatistics() {
    try {
      // Get database age info
      const dbAge = this.getDatabaseAgeInfo();
      let downloadDate = 'Unknown';

      if (dbAge.lastModified) {
        downloadDate = dbAge.lastModified.toISOString().split('T')[0];
      } else {
        downloadDate = 'Never';
      }

      // Get counts from database
      const tableCounts = await this.getDatabaseTableCounts();

      return {
        downloadDate: downloadDate,
        totalResources: 0, // Packages don't track individual resources
        totalPackages: tableCounts.packages || 0,
        totalVersions: tableCounts.packageVersions || 0,
        crawlerEnabled: this.config.crawler.enabled,
        lastCrawlerRun: this.lastRunTime,
        totalCrawlerRuns: this.totalRuns
      };

    } catch (error) {
      pckLog.error(`Error gathering package statistics: ${error.message}`);

      return {
        downloadDate: 'Error',
        totalResources: 0,
        totalPackages: 0,
        totalVersions: 0,
        crawlerEnabled: false,
        lastCrawlerRun: null,
        totalCrawlerRuns: 0
      };
    }
  }

  // The database file, resolved the same way initializeDatabase opens it: a relative
  // config.database is relative to the data directory, not the working directory.
  getDatabasePath() {
    return path.isAbsolute(this.config.database) ? this.config.database : folders.filePath('packages', this.config.database);
  }

  getDatabaseAgeInfo() {
    const dbPath = this.getDatabasePath();
    if (!fs.existsSync(dbPath)) {
      return {
        lastModified: null,
        daysOld: null,
        status: 'No database file'
      };
    }

    const stats = fs.statSync(dbPath);
    const lastModified = stats.mtime;
    const now = new Date();
    // Clamped: a file timestamp slightly ahead of this clock (e.g. on a network mount) is 'Today', not '-1 days ago'
    const ageInDays = Math.max(0, Math.floor((now - lastModified) / (1000 * 60 * 60 * 24)));

    return {
      lastModified: lastModified,
      daysOld: ageInDays,
      status: ageInDays === 0 ? 'Today' :
        ageInDays === 1 ? '1 day ago' :
          `${ageInDays} days ago`
    };
  }

  async getDatabaseTableCounts() {
    return new Promise((resolve) => {
      if (!this.db) {
        resolve({packages: 0, packageVersions: 0});
        return;
      }

      const counts = {};
      let completedQueries = 0;
      const totalQueries = 2;

      this.db.get('SELECT COUNT(*) as count FROM Packages', [], (err, row) => {
        if (err) {
          counts.packages = 0;
        } else {
          counts.packages = row ? row.count : 0;
        }

        completedQueries++;
        if (completedQueries === totalQueries) {
          resolve(counts);
        }
      });

      this.db.get('SELECT COUNT(*) as count FROM PackageVersions', [], (err, row) => {
        if (err) {
          counts.packageVersions = 0;
        } else {
          counts.packageVersions = row ? row.count : 0;
        }

        completedQueries++;
        if (completedQueries === totalQueries) {
          resolve(counts);
        }
      });
    });
  }

  buildPackagesMainPageContent() {
    let content = '<div class="row mb-4">';
    content += '<div class="col-12">';
    content += '<h1>FHIR Package Server</h1>';
    content += '<p class="lead">Browse and search FHIR Implementation Guide packages</p>';
    content += '</div>';
    content += '</div>';

    // Status overview
    content += '<div class="row mb-4">';
    content += '<div class="col-md-6">';
    content += '<div class="card">';
    content += '<div class="card-header"><h5>Server Status</h5></div>';
    content += '<div class="card-body">';
    content += `<p><strong>Crawler:</strong> ${this.config.crawler.enabled ? 'Enabled' : 'Disabled'}</p>`;
    if (this.lastRunTime) {
      content += `<p><strong>Last Crawl:</strong> ${new Date(this.lastRunTime).toLocaleString()}</p>`;
    }
    content += `<p><strong>Total Runs:</strong> ${this.totalRuns}</p>`;
    content += `<p><a href="/packages/stats" class="btn btn-info">View Statistics</a></p>`;
    content += '</div>';
    content += '</div>';
    content += '</div>';

    // Quick actions
    content += '<div class="col-md-6">';
    content += '<div class="card">';
    content += '<div class="card-header"><h5>Quick Actions</h5></div>';
    content += '<div class="card-body">';
    content += '<p><a href="/packages/search" class="btn btn-primary mb-2">Search Packages</a></p>';
    content += '<p><a href="/packages/log" class="btn btn-secondary mb-2">View Crawler Log</a></p>';
    if (this.config.crawler.enabled) {
      content += '<p><button onclick="triggerCrawl()" class="btn btn-warning mb-2">Manual Crawl</button></p>';
    }
    content += '</div>';
    content += '</div>';
    content += '</div>';
    content += '</div>';

    return content;
  }

  async initialize(config) {
    this.config = config;

    // Set default masterUrl if not configured
    if (!this.config.masterUrl) {
      this.config.masterUrl = 'https://fhir.github.io/ig-registry/package-feeds.json';
      pckLog.info('No masterUrl configured, using default:', this.config.masterUrl);
    }

    pckLog.info('Initializing Packages module...');

    // Initialize database
    await this.initializeDatabase();

    // Ensure mirror directory exists
    await this.ensureMirrorDirectory();

    // Initialize the crawler
    this.crawler = new PackageCrawler(this.config, this.db, this.stats);

    // Start the hourly web crawler if enabled
    if (config.crawler.enabled) {
      // Start the scheduled job
      this.startCrawlerJob();
    }

    pckLog.info('Packages module initialized successfully');
  }

  async runCrawler() {
    this.totalRuns++;
    pckLog.info(`Running package crawler (run #${this.totalRuns})...`);
    this.crawlerRunning = true;
    try {
      try {
        this.lastCrawlerLog = await this.crawler.crawl(pckLog);
        this.lastCrawlerLog.runNumber = this.totalRuns;
        this.lastRunTime = new Date().toISOString();

        pckLog.info(`Package crawler completed successfully`);
        return this.lastCrawlerLog;
      } catch (error) {
        this.lastRunTime = new Date().toISOString();
        if (this.crawler.crawlerLog) {
          this.lastCrawlerLog = this.crawler.crawlerLog;
          this.lastCrawlerLog.runNumber = this.totalRuns;
        }
        pckLog.error('Package crawler failed:', error.message);
        throw error;
      }
    } finally {
      this.crawlerRunning = false;
    }
  }

  async initializeDatabase() {
    return new Promise((resolve, reject) => {
      // Use config path if absolute, otherwise resolve relative to data dir
      const dbPath = this.getDatabasePath();

      // Ensure directory exists
      const dbDir = path.dirname(dbPath);
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, {recursive: true});
      }

      const dbExists = fs.existsSync(dbPath);

      this.db = new sqlite3.Database(dbPath, (err) => {
        if (err) {
          pckLog.error('Error opening packages database:', err.message);
          reject(err);
        } else {
          pckLog.info('Connected to packages SQLite database:', dbPath);

          if (!dbExists) {
            pckLog.info('Database does not exist, creating tables...');
            this.createTables().then(resolve).catch(reject);
          } else {
            pckLog.info('Packages database already exists');
            // Run migrations for tables added after initial schema
            this.db.run(`CREATE TABLE IF NOT EXISTS FeedPages (
              Url TEXT PRIMARY KEY,
              VisitedAt TEXT NOT NULL
            )`, (err) => {
              if (err) pckLog.error('Failed to create FeedPages table:', err.message);
            });
            resolve();
          }
        }
      });
      this.db.run('PRAGMA journal_mode = WAL');
      this.db.run('PRAGMA busy_timeout = 5000');
    });
  }

  async createTables() {
    return new Promise((resolve, reject) => {
      const tables = [
        // Packages table
        `CREATE TABLE Packages
         (
             PackageKey     INTEGER PRIMARY KEY AUTOINCREMENT,
             Id             TEXT(64) NOT NULL,
             Canonical      TEXT(128) NOT NULL,
             DownloadCount  INTEGER NOT NULL,
             Security       INTEGER,
             ManualToken    TEXT(64),
             CurrentVersion INTEGER NOT NULL
         )`,

        // PackageVersions table
        `CREATE TABLE PackageVersions
         (
             PackageVersionKey INTEGER PRIMARY KEY AUTOINCREMENT,
             GUID              TEXT(128) NOT NULL,
             PubDate           DATETIME NOT NULL,
             Indexed           DATETIME NOT NULL,
             Id                TEXT(64) NOT NULL,
             Version           TEXT(64) NOT NULL,
             Kind              INTEGER  NOT NULL,
             UploadCount       INTEGER,
             DownloadCount     INTEGER  NOT NULL,
             ManualToken       TEXT(64),
             Canonical         TEXT(255) NOT NULL,
             FhirVersions      TEXT(255) NOT NULL,
             Hash              TEXT(128) NOT NULL,
             Author            TEXT(128) NOT NULL,
             License           TEXT(128) NOT NULL,
             HomePage          TEXT(128) NOT NULL,
             Description       BLOB,
             Content           BLOB     NOT NULL
         )`,

        // PackageFHIRVersions table
        `CREATE TABLE PackageFHIRVersions
         (
             PackageVersionKey INTEGER NOT NULL,
             Version           TEXT(128) NOT NULL
         )`,

        // PackageDependencies table
        `CREATE TABLE PackageDependencies
         (
             PackageVersionKey INTEGER NOT NULL,
             Dependency        TEXT(128) NOT NULL
         )`,

        // PackageURLs table
        `CREATE TABLE PackageURLs
         (
             PackageVersionKey INTEGER NOT NULL,
             URL               TEXT(128) NOT NULL
         )`,

        // PackagePermissions table
        `CREATE TABLE PackagePermissions
         (
             PackagePermissionKey INTEGER PRIMARY KEY AUTOINCREMENT,
             ManualToken          TEXT(64) NOT NULL,
             Email                TEXT(128) NOT NULL,
             Mask                 TEXT(64)
         )`,

        // FeedPages table - tracks which paginated feed archive pages have been visited
        `CREATE TABLE FeedPages
         (
             Url       TEXT PRIMARY KEY,
             VisitedAt TEXT NOT NULL
         )`
      ];

      const indexes = [
        'CREATE INDEX SK_Packages_Id ON Packages (Id, PackageKey)',
        'CREATE INDEX SK_Packages_Canonical ON Packages (Canonical, PackageKey)',
        'CREATE INDEX SK_PackageVersions_Id ON PackageVersions (Id, Version, PackageVersionKey)',
        'CREATE INDEX SK_PackageVersions_Canonical ON PackageVersions (Canonical, PackageVersionKey)',
        'CREATE INDEX SK_PackageVersions_PubDate ON PackageVersions (Id, PubDate, PackageVersionKey)',
        'CREATE INDEX SK_PackageVersions_Indexed ON PackageVersions (Indexed, PackageVersionKey)',
        'CREATE INDEX SK_PackageVersions_GUID ON PackageVersions (GUID)',
        'CREATE INDEX SK_PackageFHIRVersions ON PackageFHIRVersions (PackageVersionKey)',
        'CREATE INDEX SK_PackageDependencies ON PackageDependencies (PackageVersionKey)',
        'CREATE INDEX SK_PackageURLs ON PackageURLs (PackageVersionKey)',
        'CREATE INDEX SK_PackagePermissions_Token ON PackagePermissions (ManualToken)'
      ];

      // First create all tables
      let tablesCompleted = 0;
      const totalTables = tables.length;

      const checkTablesComplete = () => {
        tablesCompleted++;
        if (tablesCompleted === totalTables) {
          pckLog.info('All packages database tables created successfully');
          // Now create indexes
          createIndexes();
        }
      };

      const createIndexes = () => {
        let indexesCompleted = 0;
        const totalIndexes = indexes.length;

        const checkIndexesComplete = () => {
          indexesCompleted++;
          if (indexesCompleted === totalIndexes) {
            pckLog.info('All packages database indexes created successfully');
            resolve();
          }
        };

        const handleIndexError = (err) => {
          pckLog.error('Error creating packages database index:', err);
          reject(err);
        };

        // Create indexes
        indexes.forEach(sql => {
          this.db.run(sql, (err) => {
            if (err) {
              handleIndexError(err);
            } else {
              checkIndexesComplete();
            }
          });
        });
      };

      const handleTableError = (err) => {
        pckLog.error('Error creating packages database table:', err);
        reject(err);
      };

      // Create tables first
      tables.forEach(sql => {
        this.db.run(sql, (err) => {
          if (err) {
            handleTableError(err);
          } else {
            checkTablesComplete();
          }
        });
      });
    });
  }

  async ensureMirrorDirectory() {
    try {
      const mirrorPath = this.config.mirrorPath;

      if (!fs.existsSync(mirrorPath)) {
        fs.mkdirSync(mirrorPath, {recursive: true});
        pckLog.info('Created mirror directory:', mirrorPath);
      } else {
        pckLog.info('Mirror directory exists:', mirrorPath);
      }
    } catch (error) {
      pckLog.error('Error creating mirror directory:', error);
      throw error;
    }
  }

  startCrawlerJob() {
    if (this.config.crawler && this.config.crawler.schedule) {
      this.stats.addTask("Package Crawler", describeCron(this.config.crawler.schedule));
      this.crawlerJob = cron.schedule(this.config.crawler.schedule, async () => {
        pckLog.info('Starting scheduled package crawler...');
        try {
          await this.runCrawler();
          pckLog.info('Scheduled package crawler completed successfully');
        } catch (error) {
          pckLog.error('Scheduled package crawler failed:', error.message);
        }
      });
      pckLog.info(`Package crawler scheduled job started: ${this.config.crawler.schedule}`);
    }
  }

  stopCrawlerJob() {
    if (this.crawlerJob) {
      this.crawler.shutdown();
      this.crawlerJob.stop();
      this.crawlerJob = null;
      pckLog.info('Package crawler job stopped');
    }
  }

  async runWebCrawler() {
    const startTime = Date.now();
    this.totalRuns++;
    this.crawlerLog = {
      runNumber: this.totalRuns,
      startTime: new Date().toISOString(),
      master: this.config.masterUrl,
      feeds: [],
      totalBytes: 0,
      errors: ''
    };

    pckLog.info(`Running web crawler for packages (run #${this.totalRuns})...`);
    pckLog.info('Fetching master URL:', this.config.masterUrl);

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
        if (!feedConfig.url) {
          pckLog.info('Skipping feed with no URL:', feedConfig);
          continue;
        }

        try {
          await this.updateTheFeed(
            this.fixUrl(feedConfig.url),
            this.config.masterUrl,
            feedConfig.errors ? feedConfig.errors.replace(/\|/g, '@').replace(/_/g, '.') : '',
            packageRestrictions
          );
        } catch (feedError) {
          pckLog.error(`Failed to process feed ${feedConfig.url}:`, feedError.message);
          // Continue with next feed even if this one fails
        }
      }

      const runTime = Date.now() - startTime;
      this.crawlerLog.runTime = `${runTime}ms`;
      this.crawlerLog.endTime = new Date().toISOString();
      this.crawlerLog.totalBytes = this.totalBytes;
      this.lastRunTime = new Date().toISOString();

      pckLog.info(`Web crawler completed successfully in ${runTime}ms`);
      pckLog.info(`Total bytes processed: ${this.totalBytes}`);

    } catch (error) {
      const runTime = Date.now() - startTime;
      this.crawlerLog.runTime = `${runTime}ms`;
      this.crawlerLog.fatalException = error.message;
      this.crawlerLog.endTime = new Date().toISOString();
      this.lastRunTime = new Date().toISOString();

      pckLog.error('Web crawler failed:', error);
      throw error;
    }
  }

  startInitialCrawler() {
    if (this.config.crawler.enabled) {
      pckLog.info('Starting initial package crawler...');

      // Run crawler in background (non-blocking)
      setImmediate(async () => {
        try {
          await this.runCrawler();
          pckLog.info('Initial package crawler completed successfully');
        } catch (error) {
          pckLog.error('Initial package crawler failed:', error.message);
        }
      });
    }
  }

  setupRoutes() {
    const searchParams = SEARCH_PARAMS;
    const updatesParams = UPDATES_PARAMS;

    // OpenAPI description of this API: /openapi.json, /openapi.yaml, and /openapi (an HTML
    // reference for browsers, the JSON otherwise). Registered before /:id, which would
    // otherwise treat "openapi" as a package id.
    this.router.get('/openapi.json', (req, res) => {
      const start = Date.now();
      try {
        res.type('application/json').send(packagesOpenApi.getJson());
      } catch (error) {
        pckLog.error('Error in /packages/openapi.json:', error);
        res.status(500).json({error: 'Failed to load the OpenAPI description', message: error.message});
      } finally {
        this.stats.countRequest('openapi', Date.now() - start);
      }
    });

    this.router.get('/openapi.yaml', (req, res) => {
      const start = Date.now();
      try {
        res.setHeader('Content-Type', 'application/yaml');
        res.send(packagesOpenApi.getYaml());
      } catch (error) {
        pckLog.error('Error in /packages/openapi.yaml:', error);
        res.status(500).json({error: 'Failed to load the OpenAPI description', message: error.message});
      } finally {
        this.stats.countRequest('openapi', Date.now() - start);
      }
    });

    this.router.get('/openapi', async (req, res) => {
      const start = Date.now();
      const acceptsHtml = req.headers.accept && req.headers.accept.includes('text/html');
      try {
        if (!acceptsHtml) {
          res.type('application/json').send(packagesOpenApi.getJson());
          return;
        }
        if (!htmlServer.hasTemplate('packages')) {
          htmlServer.loadTemplate('packages', path.join(__dirname, 'packages-template.html'));
        }
        const content = packagesOpenApi.renderHtml();
        const stats = await this.gatherPackageStatistics();
        stats.processingTime = Date.now() - start;
        res.setHeader('Content-Type', 'text/html');
        res.send(htmlServer.renderPage('packages', 'Package Server API', content, stats));
      } catch (error) {
        pckLog.error('Error in /packages/openapi:', error);
        if (acceptsHtml) {
          htmlServer.sendErrorResponse(res, 'packages', error);
        } else {
          res.status(500).json({error: 'Failed to load the OpenAPI description', message: error.message});
        }
      } finally {
        this.stats.countRequest('openapi', Date.now() - start);
      }
    });

    // GET /packages/catalog - Search packages or get updates
    this.router.get('/catalog', this.validateQueryParams(searchParams), async (req, res) => {
      const start = Date.now();
      try {
        try {
          await this.serveSearch(req, res);
          pckLog.info("/catalog" + searchParams);
        } catch (error) {
          pckLog.error('Error in /packages/catalog:', error);
          res.status(500).json({error: 'Internal server error'});
        }
      } finally {
        this.stats.countRequest('catalog', Date.now() - start);
      }
    });

    // GET /packages/-/v1/search - Search packages (v1 API)
    this.router.get('/-/v1/search', this.validateQueryParams(V1_SEARCH_PARAMS), async (req, res) => {
      const start = Date.now();
      try {
        try {
          await this.serveV1Search(req, res);
          pckLog.info("/search?" + searchParams);
        } catch (error) {
          pckLog.error('Error in /packages/-/v1/search:', error);
          res.status(500).json({error: 'Internal server error'});
        }
      } finally {
        this.stats.countRequest('search', Date.now() - start);
      }
    });

    // GET /packages/updates
    this.router.get('/updates', this.validateQueryParams(updatesParams), async (req, res) => {
      const start = Date.now();
      try {
        try {
          let {dateType, daysValue, dateValue} = req.query;
          let dt = dateType || 'relative';
          let days = daysValue || '10';
          let date = dateValue || new Date().toISOString().split('T')[0];
          await this.serveUpdates(req.secure, res, req, dt, days, date);
          pckLog.info("/updates?" + searchParams);
        } catch (error) {
          pckLog.error('Error in /packages/updates:', error);
          res.status(500).json({error: 'Internal server error'});
        }
      } finally {
        this.stats.countRequest('updates', Date.now() - start);
      }
    });

    this.router.get('/log', async (req, res) => {
      const start = Date.now();
      try {
        try {
          const acceptsHtml = req.headers.accept && req.headers.accept.includes('text/html');

          let logData;
          let summary;
          let status;

          if (this.crawlerRunning) {
            status = 'Crawler is currently running...';
            logData = this.lastCrawlerLog || null;
          } else if (this.lastCrawlerLog && this.lastCrawlerLog.feeds) {
            status = 'Showing log from most recent crawler run';
            logData = this.lastCrawlerLog;

            // Add summary statistics
            summary = {
              totalFeeds: this.lastCrawlerLog.feeds.length,
              successfulFeeds: this.lastCrawlerLog.feeds.filter(f => !f.exception && !f.rateLimited).length,
              failedFeeds: this.lastCrawlerLog.feeds.filter(f => f.exception && !f.rateLimited).length,
              rateLimitedFeeds: this.lastCrawlerLog.feeds.filter(f => f.rateLimited).length,
              totalItems: this.lastCrawlerLog.feeds.reduce((sum, f) => sum + (f.items ? f.items.length : 0), 0)
            };
          } else {
            status = 'No crawler runs have completed yet';
            logData = null;
          }

          if (acceptsHtml) {
            const startTime = Date.now();

            // Load template if not already loaded
            if (!htmlServer.hasTemplate('packages')) {
              const templatePath = path.join(__dirname, 'packages-template.html');
              htmlServer.loadTemplate('packages', templatePath);
            }

            const content = this.buildLogPageContent(status, logData, summary);
            const stats = await this.gatherPackageStatistics();
            stats.processingTime = Date.now() - startTime;

            const html = htmlServer.renderPage('packages', 'Crawler Log', content, stats);
            res.setHeader('Content-Type', 'text/html');
            res.send(html);
          } else {
            // Return JSON response
            const response = {
              status: status,
              crawlerRunning: this.crawlerRunning,
              log: logData,
              note: status
            };

            if (summary) {
              response.summary = summary;
            }

            res.json(response);
          }
          pckLog.error("/log");
        } catch (error) {
          pckLog.error('Error in /packages/log:', error);
          if (req.headers.accept && req.headers.accept.includes('text/html')) {
            htmlServer.sendErrorResponse(res, 'packages', error);
          } else {
            res.status(500).json({error: 'Failed to get crawler log', message: error.message});
          }
        }
      } finally {
        this.stats.countRequest('log', Date.now() - start);
      }
    });

    // GET /packages/broken
    this.router.get('/broken', this.validateQueryParams(BROKEN_PARAMS), async (req, res) => {
      const start = Date.now();
      try {
        try {
          const {filter} = req.query;
          await this.serveBroken(req, res, filter);
          pckLog.info("/broken");
        } catch (error) {
          pckLog.error('Error in /packages/broken:', error);
          res.status(500).json({error: 'Internal server error'});
        }
      } finally {
        this.stats.countRequest('broken', Date.now() - start);
      }
    });

    // GET /packages/:id/:version
    this.router.get('/:id/:version', (req, res, next) => {
      const start = Date.now();
      try {

        // Validate path parameters
        const {id, version} = req.params;

        if (!id || !version || !PACKAGE_ID_PATTERN.test(id) || !PACKAGE_VERSION_PATTERN.test(version)) {
          return res.status(400).json({error: `Invalid package id or version format: ${id}`});
        }

        if (id.length > PACKAGE_ID_MAX_LENGTH || version.length > PACKAGE_VERSION_MAX_LENGTH) {
          return res.status(400).json({error: `Package id or version too long: ${id}`});
        }

        next();
        pckLog.info(`/download/${id}/${version}`);
      } finally {
        this.stats.countRequest('version', Date.now() - start);
      }
    }, async (req, res) => {
      const start = Date.now();
      try {
        try {
          const {id, version} = req.params;
          await this.serveDownload(req.secure, id, version, res);
          pckLog.info(`/download/${id}/${version}`);
        } catch (error) {
          pckLog.error('Error in /packages/:id/:version:', error);
          res.status(500).json({error: 'Internal server error'});
        }
      } finally {
        this.stats.countRequest('version', Date.now() - start);
      }
    });

    // GET /packages/:page.html
    this.router.get('/:page.html', (req, res, next) => {
      const start = Date.now();
      try {

        const {page} = req.params;

        if (!page || !/^[a-zA-Z0-9_-]+$/.test(page) || page.length > 50) {
          return res.status(400).json({error: 'Invalid page name'});
        }

        next();
        pckLog.info(`/page/${page}`);
      } finally {
        this.stats.countRequest('page', Date.now() - start);
      }
    }, async (req, res) => {
      const start = Date.now();
      try {
        try {
          const {page} = req.params;
          await this.servePage(`${page}.html`, req, res, req.secure);
          pckLog.info(`/page/${page}`);
        } catch (error) {
          pckLog.error('Error in /packages/:page.html:', error);
          res.status(500).json({error: 'Internal server error'});
        }
      } finally {
        this.stats.countRequest('page', Date.now() - start);
      }
    });

    // GET /packages/:id - Get package versions
    this.router.get('/:id', async (req, res, next) => {
      const start = Date.now();
      try {

        try {
          const {id} = req.params;
          const {sort} = req.query;

          // Don't process routes that are handled elsewhere. These must call next():
          // returning without responding leaves the request hanging, which is what
          // /status, /stats and /search (registered after this route) used to do.
          if (['catalog', 'log', 'broken', 'stats', 'status', 'search', 'updates'].includes(id) ||
            id.endsWith('.html') || id === '-') {
            next();
            return;
          }

          await this.serveVersions(id, sort, req.secure, req, res);
          pckLog.info(`/id/${id}`);
        } catch (error) {
          pckLog.error('Error in /packages/:id:', error);
          res.status(500).json({error: 'Internal server error'});
        }
      } finally {
        this.stats.countRequest('id', Date.now() - start);
      }
    });

    // Main packages endpoint
    this.router.get('/', this.validateQueryParams(searchParams), async (req, res) => {
      const start = Date.now();
      try {

        try {
          await this.serveSearch(req, res);
          pckLog.info(`/`);
        } catch (error) {
          pckLog.error('Error in /packages/:', error);
          res.status(500).json({error: 'Internal server error'});
        }

      } finally {
        this.stats.countRequest('home', Date.now() - start);
      }
    });

    // Module status endpoint (existing)
    this.router.get('/status', (req, res) => {
      const start = Date.now();
      try {
        const status = this.getStatus();
        res.json(status);
        pckLog.info('Serve Status');
      } finally {
        this.stats.countRequest('status', Date.now() - start);
      }
    });

    // Manual crawler trigger. A crawl is a long, network-heavy job that anyone could
    // otherwise start at will, so it is gated on a shared secret from the configuration
    // (modules.packages.crawlToken), sent in the x-crawl-token header. With no token
    // configured the endpoint is CLOSED - an administrative trigger that silently
    // defaults to open is how a deployment ends up exposed without anything looking wrong.
    this.router.post('/crawl', async (req, res) => {
      const start = Date.now();
      try {
        if (!tokenConfigured(this.config.crawlToken)) {
          // Say which of the two it is: the operator needs to know the endpoint is off
          // because it was never configured, not that they typed the token wrongly.
          res.status(403).json({ error: 'forbidden: no crawlToken is configured, so this endpoint is disabled' });
          return;
        }
        if (!tokenMatches(this.config.crawlToken, req.headers['x-crawl-token'])) {
          pckLog.warn('Rejected /crawl: missing or invalid x-crawl-token (from ' + req.ip + ')');
          res.status(403).json({ error: 'forbidden: missing or invalid x-crawl-token' });
          return;
        }
        try {
          await this.runCrawler();
          res.json({
            message: 'Crawler completed successfully',
            timestamp: new Date().toISOString()
          });
          pckLog.info('Serve Crawler');
        } catch (error) {
          pckLog.error('Manual crawler failed:', error);
          res.status(500).json({
            error: 'Crawler failed',
            message: error.message
          });
        }
      } finally {
        this.stats.countRequest('crawl', Date.now() - start);
      }
    });

    // Crawler statistics endpoint (existing)
    this.router.get('/stats', async (req, res) => {
      const start = Date.now();
      try {
        try {
          const acceptsHtml = req.headers.accept && req.headers.accept.includes('text/html');

          if (acceptsHtml) {
            const startTime = Date.now();

            // Load template if not already loaded
            if (!htmlServer.hasTemplate('packages')) {
              const templatePath = path.join(__dirname, 'packages-template.html');
              htmlServer.loadTemplate('packages', templatePath);
            }

            const content = await this.buildStatsPageContent();
            const stats = await this.gatherPackageStatistics();
            stats.processingTime = Date.now() - startTime;

            const html = htmlServer.renderPage('packages', 'Package Statistics', content, stats);
            res.setHeader('Content-Type', 'text/html');
            res.send(html);
          } else {
            // JSON version (keep your existing logic)
            const dbCounts = await this.getDatabaseTableCounts();
            res.json({
              database: {
                packages: dbCounts.packages,
                versions: dbCounts.packageVersions
              },
              crawler: {
                enabled: this.config.crawler.enabled,
                schedule: this.config.crawler.schedule,
                lastRun: this.lastRunTime,
                totalRuns: this.totalRuns,
                lastLog: this.lastCrawlerLog || null
              },
              config: {
                masterUrl: this.config.masterUrl
              }
            });
          }
          pckLog.info('Serve Stats');

        } catch (error) {
          pckLog.error('Error generating stats:', error);
          if (req.headers.accept && req.headers.accept.includes('text/html')) {
            htmlServer.sendErrorResponse(res, 'packages', error);
          } else {
            res.status(500).json({error: 'Failed to generate stats', message: error.message});
          }
        }
      } finally {
        this.stats.countRequest('stats', Date.now() - start);
      }
    });

    // Search endpoint (existing)
    this.router.get('/search', async (req, res) => {
      const start = Date.now();
      try {

        const acceptsHtml = req.headers.accept && req.headers.accept.includes('text/html');

        if (acceptsHtml) {
          try {
            const startTime = Date.now();

            // Load template if not already loaded
            if (!htmlServer.hasTemplate('packages')) {
              const templatePath = path.join(__dirname, 'packages-template.html');
              htmlServer.loadTemplate('packages', templatePath);
            }

            const content = '<div class="alert alert-info"><h4>Search Coming Soon</h4><p>Package search functionality will be implemented here.</p></div>';
            const stats = await this.gatherPackageStatistics();
            stats.processingTime = Date.now() - startTime;

            const html = htmlServer.renderPage('packages', 'Package Search', content, stats);
            res.setHeader('Content-Type', 'text/html');
            res.send(html);
          } catch (error) {
            htmlServer.sendErrorResponse(res, 'packages', error);
          }
        } else {
          res.json({message: 'Package search functionality coming soon'});
        }
      } finally {
        this.stats.countRequest('search', Date.now() - start);
      }
    });

    // Catch-all for unsupported operations (place this last)
    this.router.all('{*splat}', (req, res) => {
      const start = Date.now();
      try {
        res.status(404).json({
          error: `The operation ${req.method} ${req.path} is not supported`
        });
      } finally {
        this.stats.countRequest('*', Date.now() - start);
      }
    });
  }

  // serveUpdates implementation with HTML support and form
  async serveUpdates(secure, res, req, dt, days, date) {
    try {
      let queryDate;

      // Handle both number (days ago) and Date object
      if (dt === 'relative') {
        const daysAgo = parseInt(days) || 10;
        let qd = new Date();
        qd.setDate(qd.getDate() - daysAgo);
        queryDate = qd.toISOString().split('T')[0];
      } else {
        queryDate = date;
      }

      const updates = await this.getPackageUpdatesSince(queryDate);

      const jsonArray = updates.map(row => ({
        name: row.Id,
        date: new Date(row.PubDate).toISOString(),
        version: row.Version,
        canonical: row.Canonical,
        fhirVersion: this.interpretVersion(row.FhirVersions),
        description: row.Description ? (
          Buffer.isBuffer(row.Description)
            ? row.Description.toString('utf8')
            : row.Description
        ) : undefined,
        kind: this.codeForKind(row.Kind),
        url: this.buildPackageUrl(row.Id, row.Version, secure, req)
      }));

      // Check if client wants HTML response
      const acceptsHtml = req && req.headers.accept && req.headers.accept.includes('text/html');

      if (acceptsHtml) {
        await this.returnUpdatesHtml(req, res, queryDate, jsonArray, secure, {
          dt,
          days, date
        });
      } else {
        // Return JSON response
        res.status(200);
        res.setHeader('Date', new Date().toUTCString());
        res.setHeader('Content-Type', 'application/json');
        res.json(jsonArray);
      }

    } catch (error) {
      pckLog.error('Error in serveUpdates:', error);
      res.status(500).json({
        error: 'Failed to get package updates',
        message: error.message
      });
    }
  }

  async returnUpdatesHtml(req, res, fromDate, updates, secure, formData) {
    try {
      const startTime = Date.now();

      // Load template if not already loaded
      if (!htmlServer.hasTemplate('packages')) {
        const templatePath = path.join(__dirname, 'packages-template.html');
        htmlServer.loadTemplate('packages', templatePath);
      }

      // Build template variables
      const vars = {
        fromDate: fromDate.split('T')[0], // Just the date part
        fromDateTime: fromDate,
        count: updates.length,
        prefix: this.getAbsoluteUrl(secure),
        ver: '4.0.1',
        matches: this.generateUpdatesTable(updates, secure),
        status: 'Active',
        formData
      };

      // Generate updates page content
      const content = this.buildUpdatesPageContent(vars, fromDate, updates);
      const stats = await this.gatherPackageStatistics();
      stats.processingTime = Date.now() - startTime;

      const title = `Package Updates since ${fromDate}`;
      const html = htmlServer.renderPage('packages', title, content, stats);
      res.setHeader('Content-Type', 'text/html');
      res.send(html);
    } catch (error) {
      pckLog.error('Error rendering updates HTML:', error);
      htmlServer.sendErrorResponse(res, 'packages', error);
    }
  }

  generateUpdatesTable(updates) {
    if (updates.length === 0) {
      return '<div class="alert alert-info">No package updates found for the specified time period.</div>';
    }

    let table = '<div class="table-responsive"><table class="table table-striped">';
    table += '<thead><tr>';
    table += '<th>Package</th>';
    table += '<th>Version</th>';
    table += '<th>FHIR Version</th>';
    table += '<th>Type</th>';
    table += '<th>Published</th>';
    table += '<th>Canonical</th>';
    table += '</tr></thead><tbody>';

    for (const pkg of updates) {
      table += '<tr>';
      table += `<td><a href="${escape(pkg.url)}">${escape(pkg.name)}</a></td>`;
      table += `<td>${escape(pkg.version)}</td>`;
      table += `<td>${escape(pkg.fhirVersion)}</td>`;
      table += `<td>${escape(pkg.kind)}</td>`;
      table += `<td>${new Date(pkg.date).toLocaleDateString()} ${new Date(pkg.date).toLocaleTimeString()}</td>`;
      table += `<td>${escape(pkg.canonical || '')}</td>`;
      table += '</tr>';
    }

    table += '</tbody></table></div>';
    return table;
  }

  buildUpdatesPageContent(vars, fromDate, updates) {
    const formData = vars.formData;

    let content = '<div class="row mb-4">';
    content += '<div class="col-12">';
    content += `<p>Showing packages updated since ${fromDate}</p>`;

    content += '<form method="GET" action="/packages/updates">';

    content += `<input type="radio" name="dateType" id="dateType" value="relative" ${formData.dt == 'relative' ? 'checked' : ''}> `;
    content += '<label for="relativeDays">Last</label> ';
    content += `<input type="number" name="daysValue" value="${formData.days}" min="1" max="365" style="width: 80px; margin: 0 5px;"> `;
    content += '<label>days</label> &nbsp;&nbsp;';

    content += `<input type="radio" name="dateType" id="dateType" value="absolute" ${formData.dt != 'relative' ? 'checked' : ''}> `;
    content += '<label for="specificDate">Since date:</label> ';
    content += `<input type="date" name="dateValue" value="${formData.date}" style="margin-left: 5px;"> `;
    content += '<button type="submit" class="btn btn-primary btn-sm" style="margin-left: 10px;">Update Results</button>';

    content += '</form>';

    // Summary info - now using the actual parameters
    content += '<table class="grid">';
    content += `<tr><td>Updates Found:</td><td>${updates.length}</td></tr>`;
    content += `<tr><td>Since Date:</td><td>${fromDate}</td></tr>`;
    content += `<tr><td>Query Time:</td><td>${new Date().toLocaleString()}</td></tr>`;
    content += '</table>';

    // Updates table - now using the generateUpdatesTable method with actual updates
    content += this.generateUpdatesTable(updates);

    content += '</div>';
    content += '</div>';

    return content;
  }

  async getPackageUpdatesSince(date) {
    return new Promise((resolve, reject) => {
      const sql = `SELECT Id, Version, PubDate, FhirVersions, Kind, Canonical, Description
                   FROM PackageVersions
                   WHERE PubDate >= ?
                   ORDER BY PubDate DESC`;

      this.db.all(sql, [date], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
  }

  async serveDownload(secure, id, version, res) {
    try {
      // First try exact version match
      let packageData = await this.findPackageVersion(id, version, true);

      // If not found, try fuzzy match (version + '-%' for pre-release versions)
      if (!packageData) {
        packageData = await this.findPackageVersion(id, version, false);
      }

      if (!packageData) {
        // Package not found
        res.status(404);
        res.setHeader('Content-Type', 'text/plain');
        res.send(`The package "${id}#${version}" is not known by this server`);
        return;
      }

      // Check if we should redirect to bucket storage
      if (this.config.bucketPath) {
        let bucketUrl = this.getBucketUrl(secure);
        const redirectUrl = `${bucketUrl}${this.fixPrefix(id)}-${version}.tgz`;
        res.redirect(redirectUrl);
        return;
      }

      // Serve content directly from database
      await this.servePackageContent(packageData, id, version, res);

    } catch (error) {
      pckLog.error('Error in serveDownload:', error);
      res.status(500).json({error: 'Download failed', message: error.message});
    }
  }

  getBucketUrl(secure) {
    let bucketUrl = secure
      ? this.config.bucketPath.replace('http:', 'https:')
      : this.config.bucketPath;
    if (!bucketUrl.endsWith('/')) {
      bucketUrl += '/';
    }
    return bucketUrl;
  }

  async findPackageVersion(id, version, exactMatch) {
    return new Promise((resolve, reject) => {
      let sql;
      if (exactMatch) {
        sql = `SELECT PackageVersionKey, Content
               FROM PackageVersions
               WHERE Id = ?
                 AND Version = ?`;
      } else {
        sql = `SELECT PackageVersionKey, Content
               FROM PackageVersions
               WHERE Id = ?
                 AND Version LIKE ?
               ORDER BY PubDate DESC LIMIT 1`;
      }

      const params = exactMatch
        ? [id, version]
        : [id, `${version}-%`];

      this.db.get(sql, params, (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row || null);
        }
      });
    });
  }

  async servePackageContent(packageData, id, version, res) {
    try {
      // Set response headers for file download
      res.status(200);
      res.setHeader('Content-Type', 'application/tar+gzip');
      res.setHeader('Content-Disposition', `attachment; filename="${id}#${version}.tgz"`);

      // Convert BLOB content to Buffer if needed
      let contentBuffer;
      if (Buffer.isBuffer(packageData.Content)) {
        contentBuffer = packageData.Content;
      } else {
        // Handle case where Content might be stored differently
        contentBuffer = Buffer.from(packageData.Content);
      }

      // Send the content
      res.send(contentBuffer);

      // Update download counts after successful response
      // Do this asynchronously to not delay the response
      setImmediate(() => {
        void this.incrementDownloadCounts(packageData.PackageVersionKey, id); // fire-and-forget; errors handled internally
      });

    } catch (error) {
      pckLog.error('Error serving package content:', error);
      throw error;
    }
  }

  async incrementDownloadCounts(packageVersionKey, packageId) {
    try {
      // Update PackageVersions download count
      await new Promise((resolve, reject) => {
        this.db.run(
          'UPDATE PackageVersions SET DownloadCount = DownloadCount + 1 WHERE PackageVersionKey = ?',
          [packageVersionKey],
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });

      // Update Packages download count
      await new Promise((resolve, reject) => {
        this.db.run(
          'UPDATE Packages SET DownloadCount = DownloadCount + 1 WHERE Id = ?',
          [packageId],
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });

    } catch (error) {
      pckLog.error('Error updating download counts:', error);
      // Don't throw here - download counts are not critical
    }
  }

  async servePage(page, req, res) {
    // TODO: Implement page serving functionality
    res.json({
      message: 'Page serving not implemented yet',
      page
    });
  }

  async serveVersions(id, sort, secure, req, res) {
    try {
      const packageVersions = await this.getPackageVersions(id);

      if (packageVersions.length === 0) {
        res.status(404).json({error: `Package "${id}" not found`});
        return;
      }

      // Build npm-style registry response
      const registryResponse = await this.buildRegistryResponse(id, packageVersions, secure, req);

      // Check if client wants HTML response
      const acceptsHtml = req.headers.accept && req.headers.accept.includes('text/html');

      if (acceptsHtml) {
        await this.returnVersionsHtml(req, res, id, packageVersions, registryResponse, secure, sort);
      } else {
        // Return JSON response in npm registry format
        res.setHeader('Content-Type', 'application/json');
        res.json(registryResponse);
      }
    } catch (error) {
      pckLog.error('Error in serveVersions:', error);
      res.status(500).json({error: 'Failed to get package versions', message: error.message});
    }
  }

  async getPackageVersions(id) {
    return new Promise((resolve, reject) => {
      const sql = `SELECT PackageVersionKey,
                          Version,
                          PubDate,
                          FhirVersions,
                          Canonical,
                          DownloadCount,
                          Kind,
                          HomePage,
                          Author,
                          License,
                          Hash,
                          GUID,
                          Description
                   FROM PackageVersions
                   WHERE Id = ?
                   ORDER BY PubDate DESC`;  // Changed from ASC to DESC for most recent first

      this.db.all(sql, [id], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
  }

  async getPackageDependencies(packageVersionKeys) {
    if (packageVersionKeys.length === 0) return {};

    return new Promise((resolve, reject) => {
      const placeholders = packageVersionKeys.map(() => '?').join(',');
      const sql = `SELECT PackageVersionKey, Dependency
                   FROM PackageDependencies
                   WHERE PackageVersionKey IN (${placeholders})`;

      this.db.all(sql, packageVersionKeys, (err, rows) => {
        if (err) {
          reject(err);
        } else {
          // Group dependencies by PackageVersionKey
          const deps = {};
          for (const row of rows) {
            if (!deps[row.PackageVersionKey]) {
              deps[row.PackageVersionKey] = {};
            }

            const dependency = row.Dependency;
            const atIndex = dependency.indexOf('@');
            if (atIndex > 0) {
              const depName = dependency.substring(0, atIndex);
              const depVersion = dependency.substring(atIndex + 1);
              deps[row.PackageVersionKey][depName] = depVersion;
            }
          }
          resolve(deps);
        }
      });
    });
  }

  async buildRegistryResponse(id, packageVersions, secure, req) {
    // Get all package version keys for dependency lookup
    const packageVersionKeys = packageVersions.map(pv => pv.PackageVersionKey);
    const dependencies = await this.getPackageDependencies(packageVersionKeys);

    const registry = {
      _id: id,
      name: id,
      'dist-tags': {},
      versions: {}
    };

    let latestVersion = '';
    let description = '';

    for (const [index, pv] of packageVersions.entries()) {
      // Latest version is the first one (ordered by PubDate DESC)
      if (index === 0) {
        latestVersion = pv.Version;
      }

      // Convert description BLOB to string
      if (pv.Description) {
        description = Buffer.isBuffer(pv.Description)
          ? pv.Description.toString('utf8')
          : pv.Description;
      }

      const versionObj = {
        name: id,
        _id: `${id}@${pv.Version}`,
        version: pv.Version,
        date: new Date(pv.PubDate).toISOString(),
        fhirVersion: this.interpretVersion(pv.FhirVersions),
        kind: this.codeForKind(pv.Kind),
        count: pv.DownloadCount || 0,
        canonical: pv.Canonical,
        url: this.buildPackageUrl(id, pv.Version, secure, req),
        dist: {
          shasum: pv.Hash,
          tarball: this.buildTarballUrl(id, pv.Version, secure, req)
        }
      };

      // Add optional fields
      if (pv.HomePage) {
        versionObj.homepage = pv.HomePage;
      }

      if (pv.License) {
        versionObj.license = pv.License;
      }

      if (pv.Author) {
        versionObj.author = {name: pv.Author};
      }

      if (description) {
        versionObj.description = description;
      }

      // Add dependencies for this version
      if (dependencies[pv.PackageVersionKey]) {
        versionObj.dependencies = dependencies[pv.PackageVersionKey];
      }

      registry.versions[pv.Version] = versionObj;
    }

    // Set latest version and description at package level
    registry['dist-tags'].latest = latestVersion;
    if (description) {
      registry.description = description;
    }

    return registry;
  }

  buildTarballUrl(id, version, secure, req) {
    if (this.config.bucketPath) {
      let bucketUrl = this.getBucketUrl(secure);
      return `${bucketUrl}${this.fixPrefix(id)}-${version}.tgz`;
    } else {
      // Use direct server URL
      const protocol = secure ? 'https' : 'http';
      const host = req.get('host') || 'localhost:3000';
      return `${protocol}://${host}/packages/${id}/${version}`;
    }
  }

  async returnVersionsHtml(req, res, id, packageVersions, registryResponse, secure, sort) {
    try {
      const startTime = Date.now();

      // Load template if not already loaded
      if (!htmlServer.hasTemplate('packages')) {
        const templatePath = path.join(__dirname, 'packages-template.html');
        htmlServer.loadTemplate('packages', templatePath);
      }

      // Get package counts
      const versionCount = packageVersions.length;
      const totalDownloads = packageVersions.reduce((sum, pv) => sum + (pv.DownloadCount || 0), 0);

      // Build template variables
      const vars = {
        name: id,
        desc: this.formatTextToHTML(registryResponse.description || ''),
        prefix: this.getAbsoluteUrl(false),
        ver: '4.0.1',
        matches: this.generateVersionsTable(packageVersions, id, secure, sort),
        status: 'Active',
        count: versionCount,
        downloads: totalDownloads
      };

      // Generate versions page content
      const content = this.buildVersionsPageContent(vars, id);
      const stats = await this.gatherPackageStatistics();
      stats.processingTime = Date.now() - startTime;

      const html = htmlServer.renderPage('packages', `Package Versions - ${id}`, content, stats);
      res.setHeader('Content-Type', 'text/html');
      res.send(html);
    } catch (error) {
      pckLog.error('Error rendering versions HTML:', error);
      htmlServer.sendErrorResponse(res, 'packages', error);
    }
  }

  generateVersionsTable(packageVersions, id, secure, sort) {
    if (packageVersions.length === 0) {
      return '<div class="alert alert-info">No versions found for this package.</div>';
    }

    // Apply sorting if specified
    const sortedVersions = this.applySortingToVersions(packageVersions, sort);

    let table = '<div class="table-responsive"><table class="table table-striped">';
    table += '<thead><tr>';
    table += '<th>Version</th>';
    table += '<th>FHIR Version</th>';
    table += '<th>Type</th>';
    table += '<th>Published</th>';
    table += '<th>Downloads</th>';
    table += '<th>Actions</th>';
    table += '</tr></thead><tbody>';

    for (const pv of sortedVersions) {
      table += '<tr>';
      table += `<td title="${escape(pv.GUID)}"><strong>${escape(pv.Version)}</strong></td>`;
      table += `<td>${escape(this.interpretVersion(pv.FhirVersions))}</td>`;
      table += `<td>${escape(this.codeForKind(pv.Kind))}</td>`;
      table += `<td>${new Date(pv.PubDate).toLocaleDateString()}</td>`;
      table += `<td>${(pv.DownloadCount || 0).toLocaleString()}</td>`;
      table += `<td><a href="/packages/${encodeURIComponent(id)}/${escape(pv.Version)}" class="btn btn-sm btn-primary">Download</a></td>`;
      table += '</tr>';
    }

    table += '</tbody></table></div>';
    return table;
  }

  applySortingToVersions(versions, sort) {
    if (!sort) return versions;

    const descending = sort.startsWith('-');
    const sortField = descending ? sort.substring(1) : sort;

    return [...versions].sort((a, b) => {
      let comparison = 0;

      switch (sortField) {
        case 'version':
          comparison = this.compareVersions(a.Version, b.Version);
          break;
        case 'fhirversion':
          comparison = this.interpretVersion(a.FhirVersions).localeCompare(this.interpretVersion(b.FhirVersions));
          break;
        case 'kind':
          comparison = this.codeForKind(a.Kind).localeCompare(this.codeForKind(b.Kind));
          break;
        case 'date':
          comparison = new Date(a.PubDate) - new Date(b.PubDate);
          break;
        case 'count':
          comparison = (a.DownloadCount || 0) - (b.DownloadCount || 0);
          break;
        default:
          return 0;
      }

      return descending ? -comparison : comparison;
    });
  }

  buildVersionsPageContent(vars, id) {
    let content = '<div class="row mb-4">';
    content += '<div class="col-12">';
    content += '<table class="grid">';
    content += `<tr><td>Package ID:</td><td>${escape(id)}</td></tr>`;
    content += `<tr><td>Description</td><td>${vars.desc}</td></tr>`;
    content += `<tr><td>Total Versions:</td><td>${vars.count}</td></tr>`;
    content += `<tr><td>Total Downloads:</td><td>${vars.downloads}</td></tr>`;
    content += '</table>';

    // Versions table
    content += '<div class="row">';
    content += '<div class="col-12">';
    content += '<h3>Available Versions</h3>';
    content += vars.matches;
    content += '</div>';
    content += '</div>';

    return content;
  }

  formatTextToHTML(text) {
    if (!text) return '';
    // Basic text to HTML formatting - convert newlines to <br>
    return escape(text).replace(/\n/g, '<br>');
  }

  // GET /-/v1/search: the npm registry search API. Takes the FHIR search parameters plus
  // npm's text/size/from, and returns npm's result shape. Without size, every result is
  // returned (npm's own clients always send size).
  async serveV1Search(req, res) {
    const acceptsHtml = req.headers.accept && req.headers.accept.includes('text/html');
    if (acceptsHtml) {
      await this.serveSearch(req, res);
      return;
    }

    const q = req.query;
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    try {
      const results = await this.searchPackages({
        name: q.name,
        dependson: q.dependson,
        canonicalPkg: q.pkgcanonical,
        canonicalUrl: q.canonical,
        fhirVersion: q.fhirversion,
        dependency: q.dependency,
        text: q.text,
        sort: q.sort
      }, req, secure);

      const from = parseInt(q.from, 10) || 0;
      const page = q.size
        ? results.slice(from, from + Math.min(parseInt(q.size, 10), V1_SEARCH_MAX_SIZE))
        : results.slice(from);

      res.setHeader('Content-Type', 'application/json');
      res.json({
        objects: page.map(pkg => ({
          // The npm CLI requires maintainers (it calls maintainers.map) and reads keywords
          package: { ...pkg, keywords: [], maintainers: [] },
          score: { final: 1, detail: { quality: 1, popularity: 1, maintenance: 1 } },
          searchScore: 1
        })),
        total: results.length,
        time: new Date().toUTCString()
      });
    } catch (error) {
      pckLog.error('Error in v1 search:', error);
      res.status(500).json({error: 'Search failed', message: error.message});
    }
  }

  async serveSearch(req, res) {
    const {
      name = '',
      dependson = '',
      pkgcanonical = '', // canonicalPkg in Pascal
      canonical = '',    // canonicalUrl in Pascal
      fhirversion = '',  // FHIRVersion in Pascal
      dependency = '',
      sort = '',
      objWrapper = false
    } = req.query;

    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';

    try {
      const results = await this.searchPackages({
        name,
        dependson,
        canonicalPkg: pkgcanonical,
        canonicalUrl: canonical,
        fhirVersion: fhirversion,
        dependency,
        sort
      }, req, secure);

      // Check if client wants HTML response
      const acceptsHtml = req.headers.accept && req.headers.accept.includes('text/html');

      if (acceptsHtml) {
        // Return HTML response using template
        await this.returnSearchHtml(req, res, {
          name,
          dependson,
          canonicalPkg: pkgcanonical,
          canonicalUrl: canonical,
          fhirVersion: fhirversion,
          sort
        }, results, secure);
      } else {
        // Return JSON response
        let responseData;

        if (objWrapper === true || objWrapper === 'true') {
          // V1 API format with object wrapper
          responseData = {
            objects: results.map(pkg => ({package: pkg}))
          };
        } else {
          responseData = results;
        }

        res.setHeader('Content-Type', 'application/json');
        res.json(responseData);
      }
    } catch (error) {
      pckLog.error('Error in search:', error);
      res.status(500).json({error: 'Search failed', message: error.message});
    }
  }

  async returnSearchHtml(req, res, searchParams, results, secure) {
    try {
      const startTime = Date.now();

      // Load template if not already loaded
      if (!htmlServer.hasTemplate('packages')) {
        const templatePath = path.join(__dirname, 'packages-template.html');
        htmlServer.loadTemplate('packages', templatePath);
      }

      // Get total package count
      const packageCount = await this.getTotalPackageCount();
      const downloadCount = await this.getTotalDownloadCount();

      // Build template variables
      const vars = {
        name: searchParams.name || '',
        dependson: searchParams.dependson || '',
        canonicalPkg: searchParams.canonicalPkg || '',
        canonicalUrl: searchParams.canonicalUrl || '',
        fhirVersion: searchParams.fhirVersion || '',
        sort: searchParams.sort || '',
        count: packageCount,
        prefix: this.getAbsoluteUrl(secure),
        ver: '4.0.1',
        r2selected: this.getSelected('R2', searchParams.fhirVersion),
        r3selected: this.getSelected('R3', searchParams.fhirVersion),
        r4selected: this.getSelected('R4', searchParams.fhirVersion),
        r5selected: this.getSelected('R5', searchParams.fhirVersion),
        matches: this.generateResultsTable(results, searchParams, secure),
        status: 'Active', // TODO: Get actual status
        downloads: downloadCount
      };

      // Generate search page content
      const content = this.buildSearchPageContent(vars, results);
      const stats = await this.gatherPackageStatistics();
      stats.processingTime = Date.now() - startTime;

      const html = htmlServer.renderPage('packages', 'Package Search', content, stats);
      res.setHeader('Content-Type', 'text/html');
      res.send(html);
    } catch (error) {
      pckLog.error('Error rendering search HTML:', error);
      htmlServer.sendErrorResponse(res, 'packages', error);
    }
  }

  async getTotalPackageCount() {
    return new Promise((resolve, reject) => {
      this.db.get('SELECT COUNT(*) as count FROM PackageVersions', [], (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row ? row.count : 0);
        }
      });
    });
  }

  async getTotalDownloadCount() {
    return new Promise((resolve, reject) => {
      this.db.get('SELECT SUM(DownloadCount) as total FROM PackageVersions', [], (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row ? row.total || 0 : 0);
        }
      });
    });
  }

  getAbsoluteUrl(secure) {
    const protocol = secure ? 'https:' : 'http:';
    return this.config.baseUrl || `${protocol}//localhost:${this.config.port || 3000}`;
  }

  getSelected(value, current) {
    return value === current ? 'selected' : '';
  }

  generateResultsTable(results, searchParams) {
    if (results.length === 0) {
      return '<div class="alert alert-info">No packages found matching your search criteria.</div>';
    }

    // Build base URL for sorting with current search parameters
    const baseUrl = '/packages/catalog?' + new URLSearchParams({
      ...(searchParams.name && {name: searchParams.name}),
      ...(searchParams.dependson && {dependson: searchParams.dependson}),
      ...(searchParams.canonicalPkg && {pkgcanonical: searchParams.canonicalPkg}),
      ...(searchParams.canonicalUrl && {canonical: searchParams.canonicalUrl}),
      ...(searchParams.fhirVersion && {fhirversion: searchParams.fhirVersion})
    }).toString();

    const currentSort = searchParams.sort || '';

    let table = '<div class="table-responsive"><table class="table table-striped">';
    table += '<thead><tr>';
    table += `<th>${this.generateSortHeader('Package', 'name', baseUrl, currentSort)}</th>`;
    table += `<th>${this.generateSortHeader('Version', 'version', baseUrl, currentSort)}</th>`;
    table += `<th>${this.generateSortHeader('FHIR Version', 'fhirversion', baseUrl, currentSort)}</th>`;
    table += `<th>${this.generateSortHeader('Type', 'kind', baseUrl, currentSort)}</th>`;
    table += `<th>${this.generateSortHeader('Published', 'date', baseUrl, currentSort)}</th>`;
    table += `<th>${this.generateSortHeader('Downloads', 'count', baseUrl, currentSort)}</th>`;
    table += `<th>${this.generateSortHeader('Canonical', 'canonical', baseUrl, currentSort)}</th>`;
    table += '</tr></thead><tbody>';

    for (const pkg of results) {
      table += '<tr>';
      table += `<td><a href="${escape(this.fixPrefix(pkg.url))}">${escape(pkg.name)}</a></td>`;
      table += `<td>${escape(pkg.version)} (<a href="/packages/${encodeURIComponent(pkg.name)}">all</a>)</td>`;
      table += `<td>${escape(pkg.fhirVersion)}</td>`;
      table += `<td>${escape(pkg.kind)}</td>`;
      table += `<td>${pkg.date ? new Date(pkg.date).toLocaleDateString() : 'N/A'}</td>`;
      table += `<td>${pkg.count ? pkg.count.toLocaleString() : 'N/A'}</td>`;
      table += `<td>${escape(pkg.canonical || '')}</td>`;
      table += '</tr>';
    }

    table += '</tbody></table></div>';
    return table;
  }

  generateSortHeader(title, field, baseUrl, currentSort) {
    const isCurrentField = currentSort === field || currentSort === `-${field}`;
    const isDescending = currentSort === `-${field}`;

    // Determine next sort direction
    let nextSort;
    if (!isCurrentField) {
      nextSort = field; // Default to ascending
    } else if (!isDescending) {
      nextSort = `-${field}`; // Switch to descending
    } else {
      nextSort = field; // Switch back to ascending
    }

    const sortUrl = `${baseUrl}&sort=${nextSort}`;

    let header = `<a href="${sortUrl}" style="text-decoration: none; color: inherit;">${title}`;

    if (isCurrentField) {
      if (isDescending) {
        header += ' <span style="color: #007bff;">▼</span>';
      } else {
        header += ' <span style="color: #007bff;">▲</span>';
      }
    } else {
      header += '&nbsp;<span style="color: #ccc;">⇅</span>';
    }

    header += '</a>';

    return header;
  }

  buildSearchPageContent(vars, results) {
    let content = '<div class="row mb-4">';
    content += '<div class="col-12">';
    content += '</div>';
    content += '</div>';

    // Search form - matching existing format exactly
    content += '<form method="GET" action="/packages/catalog">';
    content += '<table>';
    content += '<tbody>';

    content += '<tr>';
    content += '<td>Id</td>';
    content += `<td><input type="text" name="name" value="${escape(vars.name)}"></td>`;
    content += '</tr>';

    content += '<tr>';
    content += '<td>Depends On</td>';
    content += `<td><input type="text" name="dependson" value="${escape(vars.dependson)}"> <i>includes both direct and indirect dependencies</i></td>`;
    content += '</tr>';

    content += '<tr>';
    content += '<td>Canonical (Package)</td>';
    content += `<td><input type="text" name="pkgcanonical" value="${escape(vars.canonicalPkg)}"></td>`;
    content += '</tr>';

    content += '<tr>';
    content += '<td>Canonical (Resource)</td>';
    content += `<td><input type="text" name="canonical" value="${escape(vars.canonicalUrl)}"></td>`;
    content += '</tr>';

    content += '<tr>';
    content += '<td>FHIR Version</td>';
    content += '<td><select name="fhirversion">';
    content += '<option value=""></option>';
    content += `<option value="R2" ${vars.r2selected}>R2</option>`;
    content += `<option value="R3" ${vars.r3selected}>R3</option>`;
    content += `<option value="R4" ${vars.r4selected}>R4</option>`;
    content += `<option value="R5" ${vars.r5selected}>R5</option>`;
    content += '</select></td>';
    content += '</tr>';

    content += '</tbody>';
    content += '</table>';
    content += '<input type="submit" value="Search">';
    content += '</form>';

    content += '<br><br>';

    // Results
    content += `<h3>Results (${results.length} packages found)</h3>`;
    content += vars.matches;

    return content;
  }

  escapeSql(str) {
    if (!str) return '';
    return str.replace(/'/g, "''");
  }

  interpretVersion(fhirVersions) {
    if (!fhirVersions) return '';

    // Handle comma-separated versions
    const versions = fhirVersions.split(',').map(v => v.trim());

    // Return the primary version or join multiple versions
    return versions.length === 1 ? versions[0] : versions.join(', ');
  }

  codeForKind(kind) {
    const kindMap = {
      0: 'fhir.core',
      1: 'fhir.ig',
      2: 'fhir.template'
    };

    return kindMap[kind] || 'fhir.ig';
  }

  buildPackageUrl(id, version, secure = false, req = null) {
    if (this.config.bucketPath) {
      let bucketUrl = this.getBucketUrl(secure);
      return `${bucketUrl}${this.fixPrefix(id)}-${version}.tgz`;
    } else {
      // Use direct server URL
      const protocol = secure ? 'https' : 'http';
      let host = 'localhost:3000';

      if (req && req.get) {
        host = req.get('host') || 'localhost:3000';
      }

      const baseUrl = this.config.baseUrl || `${protocol}://${host}`;
      return `${baseUrl}/packages/${id}/${version}`;
    }
  }

  applySorting(results, sort) {
    if (!sort) return results;

    const descending = sort.startsWith('-');
    const sortField = descending ? sort.substring(1) : sort;

    return results.sort((a, b) => {
      let comparison = 0;

      switch (sortField) {
        case 'name':
          comparison = a.name.localeCompare(b.name);
          break;
        case 'version':
          comparison = this.compareVersions(a.version, b.version);
          break;
        case 'date':
          comparison = new Date(a.date || 0) - new Date(b.date || 0);
          break;
        case 'count':
          comparison = (a.count || 0) - (b.count || 0);
          break;
        case 'fhirversion':
          comparison = this.compareVersions(a.fhirVersion || '', b.fhirVersion || '');
          break;
        case 'kind':
          comparison = (a.kind || '').localeCompare(b.kind || '');
          break;
        case 'canonical':
          comparison = (a.canonical || '').localeCompare(b.canonical || '');
          break;
        default:
          return 0;
      }

      return descending ? -comparison : comparison;
    });
  }

  // Semver-style comparison: numeric major.minor.patch, then a version with a pre-release
  // label (1.0.0-ballot) sorts before the release (1.0.0). Anything unparseable falls back
  // to string order, so the result is always a number (Array.sort misbehaves on NaN).
  compareVersions(a, b) {
    const parse = v => {
      const [core, ...pre] = String(v).trim().split('-');
      return { nums: core.split('.').map(n => parseInt(n, 10)), pre: pre.join('-') };
    };
    const va = parse(a);
    const vb = parse(b);

    for (let i = 0; i < Math.max(va.nums.length, vb.nums.length); i++) {
      const aPart = va.nums[i] || 0;
      const bPart = vb.nums[i] || 0;
      if (Number.isNaN(aPart) || Number.isNaN(bPart)) {
        return String(a).localeCompare(String(b));
      }
      if (aPart !== bPart) {
        return aPart - bPart;
      }
    }

    if (va.pre === vb.pre) {
      return 0;
    }
    if (!va.pre) {
      return 1;
    }
    if (!vb.pre) {
      return -1;
    }
    return va.pre.localeCompare(vb.pre, undefined, { numeric: true });
  }

  generateSearchHtml(req, results, params) {
    // Simplified HTML generation - you'd want to use a proper template engine
    const {name, dependson, canonicalPkg, canonicalUrl, fhirVersion} = params;
    return `
    <!DOCTYPE html>
    <html>
    <head>
      <title>FHIR Package Search</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .search-form { background: #f5f5f5; padding: 20px; margin-bottom: 20px; }
        .search-form input, .search-form select { margin: 5px; padding: 5px; }
        .results { margin-top: 20px; }
        .package { border: 1px solid #ddd; margin: 10px 0; padding: 15px; }
        .package-name { font-weight: bold; font-size: 1.2em; }
        .package-details { color: #666; margin-top: 5px; }
      </style>
    </head>
    <body>
      <h1>FHIR Package Search</h1>
      
      <form class="search-form" method="GET">
        <input type="text" name="name" placeholder="Package name" value="${escape(name)}">
        <input type="text" name="dependson" placeholder="Depends on" value="${escape(dependson)}">
        <input type="text" name="canonicalPkg" placeholder="Canonical package" value="${escape(canonicalPkg)}">
        <input type="text" name="canonicalUrl" placeholder="Canonical URL" value="${escape(canonicalUrl)}">
        <select name="fhirVersion">
          <option value="">Any FHIR version</option>
          <option value="R2" ${fhirVersion === 'R2' ? 'selected' : ''}>R2</option>
          <option value="R3" ${fhirVersion === 'R3' ? 'selected' : ''}>R3</option>
          <option value="R4" ${fhirVersion === 'R4' ? 'selected' : ''}>R4</option>
          <option value="R5" ${fhirVersion === 'R5' ? 'selected' : ''}>R5</option>
        </select>
        <button type="submit">Search</button>
      </form>
      
      <div class="results">
        <h2>Results (${results.length} packages found)</h2>
        ${results.map(pkg => `
          <div class="package">
            <div class="package-name">
              <a href="${pkg.url}">${escape(pkg.name)}</a> v${escape(pkg.version)}
            </div>
            <div class="package-details">
              <strong>FHIR Version:</strong> ${escape(pkg.fhirVersion)}<br>
              <strong>Type:</strong> ${escape(pkg.kind)}<br>
              <strong>Canonical:</strong> ${escape(pkg.canonical)}<br>
              ${pkg.description ? `<strong>Description:</strong> ${escape(pkg.description)}<br>` : ''}
              ${pkg.date ? `<strong>Published:</strong> ${new Date(pkg.date).toLocaleDateString()}<br>` : ''}
              ${pkg.count ? `<strong>Downloads:</strong> ${pkg.count}<br>` : ''}
            </div>
          </div>
        `).join('')}
      </div>
    </body>
    </html>
  `;
  }

  async shutdown() {
    pckLog.info('Shutting down Packages module...');

    this.stopCrawlerJob();

    // Close database connection
    if (this.db) {
      return new Promise((resolve) => {
        this.db.close((err) => {
          if (err) {
            pckLog.error('Error closing packages database:', err.message);
          } else {
            pckLog.info('Packages database connection closed');
          }
          resolve();
        });
      });
    }

    pckLog.info('Packages module shut down');
  }

  async serveBroken(req, res, filter) {
    try {
      // Build list of valid package references (Id#MajorMinorVersion)
      const validPackages = await this.getValidPackageReferences();

      // Find broken dependencies
      const brokenDependencies = await this.findBrokenDependencies(validPackages, filter);

      // Check if client wants HTML response
      const acceptsHtml = req.headers.accept && req.headers.accept.includes('text/html');

      if (acceptsHtml) {
        await this.returnBrokenHtml(req, res, brokenDependencies, filter);
      } else {
        // Return JSON response
        const jsonResponse = {
          ...brokenDependencies,
          date: new Date().toISOString()
        };

        res.status(200);
        res.setHeader('Content-Type', 'application/json');
        res.json(jsonResponse);
      }

    } catch (error) {
      pckLog.error('Error in serveBroken:', error);
      res.status(500).json({
        error: 'Failed to generate broken dependencies report',
        message: error.message
      });
    }
  }

  async getValidPackageReferences() {
    return new Promise((resolve, reject) => {
      const sql = 'SELECT Id, Version FROM PackageVersions';

      this.db.all(sql, [], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          const validPackages = new Set();

          for (const row of rows) {
            // Create reference in format: Id#MajorMinorVersion
            const majorMinorVersion = this.getMajorMinorVersion(row.Version);
            const packageRef = `${row.Id}#${majorMinorVersion}`;
            validPackages.add(packageRef);
          }

          resolve(validPackages);
        }
      });
    });
  }

  async findBrokenDependencies(validPackages, filter) {
    return new Promise((resolve, reject) => {
      const sql = `SELECT PackageVersions.Id || '#' || PackageVersions.Version as Source,
                          PackageDependencies.Dependency
                   FROM PackageDependencies,
                        PackageVersions
                   WHERE PackageDependencies.PackageVersionKey = PackageVersions.PackageVersionKey`;

      this.db.all(sql, [], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          const brokenDeps = {};

          for (const row of rows) {
            const source = row.Source;
            const dependency = row.Dependency;

            // Apply filter if specified
            if (filter && !source.includes(filter)) {
              continue;
            }

            // Extract dependency name and version
            const atIndex = dependency.indexOf('@');
            if (atIndex > 0) {
              const depName = dependency.substring(0, atIndex);
              const depVersion = dependency.substring(atIndex + 1);
              const depMajorMinor = this.getMajorMinorVersion(depVersion);
              const depRef = `${depName}#${depMajorMinor}`;

              // Check if this dependency exists in valid packages
              if (!validPackages.has(depRef)) {
                // This is a broken dependency
                if (!brokenDeps[source]) {
                  brokenDeps[source] = [];
                }
                brokenDeps[source].push(dependency);
              }
            }
          }

          resolve(brokenDeps);
        }
      });
    });
  }

  getMajorMinorVersion(version) {
    // Extract major.minor from version string (e.g., "1.0.0" -> "1.0", "2.1.3-beta" -> "2.1")
    if (!version) return version;

    const parts = version.split('.');
    if (parts.length >= 2) {
      // Handle pre-release versions by taking only the numeric part
      const minor = parts[1].replace(/[^0-9].*/g, '');
      return `${parts[0]}.${minor}`;
    }

    return version;
  }

  async returnBrokenHtml(req, res, brokenDependencies, filter) {
    try {
      const startTime = Date.now();

      // Load template if not already loaded
      if (!htmlServer.hasTemplate('packages')) {
        const templatePath = path.join(__dirname, 'packages-template.html');
        htmlServer.loadTemplate('packages', templatePath);
      }

      // Build template variables
      const vars = {
        prefix: this.getAbsoluteUrl(false),
        ver: '4.0.1',
        filter: this.formatTextToHTML(filter || ''),
        table: this.generateBrokenTable(brokenDependencies),
        status: 'Active'
      };

      // Generate broken dependencies page content
      const content = this.buildBrokenPageContent(vars, brokenDependencies, filter);
      const stats = await this.gatherPackageStatistics();
      stats.processingTime = Date.now() - startTime;

      const title = `Broken Package Dependencies${filter ? ` (filtered: ${filter})` : ''}`;
      const html = htmlServer.renderPage('packages', title, content, stats);
      res.setHeader('Content-Type', 'text/html');
      res.send(html);
    } catch (error) {
      pckLog.error('Error rendering broken dependencies HTML:', error);
      htmlServer.sendErrorResponse(res, 'packages', error);
    }
  }

  generateBrokenTable(brokenDependencies) {
    const sourcePackages = Object.keys(brokenDependencies).sort();

    if (sourcePackages.length === 0) {
      return '<div class="alert alert-success">No broken dependencies found! All package dependencies are satisfied.</div>';
    }

    let table = '<table class="grid">';
    table += '<tr><td><b>Source Package</b></td><td><b>Broken Dependencies</b></td></tr>';

    for (const source of sourcePackages) {
      const dependencies = brokenDependencies[source];
      table += '<tr>';
      table += `<td>${escape(source)}</td>`;
      table += '<td>';

      for (let i = 0; i < dependencies.length; i++) {
        if (i > 0) {
          table += ', ';
        }
        table += escape(dependencies[i]);
      }

      table += '</td>';
      table += '</tr>';
    }

    table += '</table>';
    return table;
  }

  buildBrokenPageContent(vars, brokenDependencies) {
    const affectedCount = Object.keys(brokenDependencies).length;
    const totalBrokenDeps = Object.values(brokenDependencies).reduce((sum, deps) => sum + deps.length, 0);

    let content = '<div class="row mb-4">';
    content += '<div class="col-12">';
    content += '<p>Packages that reference dependencies which cannot be resolved</p>';

    // Summary info
    content += '<table class="grid">';
    content += `<tr><td>Affected Packages:</td><td>${affectedCount}</td></tr>`;
    content += `<tr><td>Total Broken Dependencies:</td><td>${totalBrokenDeps}</td></tr>`;
    content += `<tr><td>Report Generated:</td><td>${new Date().toLocaleString()}</td></tr>`;
    content += '</table>';

    // Help info
    content += '<h5>About This Report</h5>';
    content += '<p>This report shows packages that have dependencies which cannot be resolved. A dependency is considered broken if:</p>';
    content += '<ul>';
    content += '<li>The referenced package does not exist</li>';
    content += '<li>The referenced version (major.minor) is not available</li>';
    content += '</ul>';
    content += '<p><small><strong>Note:</strong> Version matching uses major.minor comparison (e.g., 1.0.0 matches 1.0.x)</small></p>';

    // Results table
    content += '<div class="row">';
    content += '<div class="col-12">';
    if (affectedCount > 0) {
      content += '<h3>Broken Dependencies</h3>';
      content += vars.table;
    } else {
      content += '<div class="alert alert-success">';
      content += '<h4>✅ No Broken Dependencies Found</h4>';
      content += '<p>All package dependencies are properly resolved!</p>';
      content += '</div>';
    }
    content += '</div>';
    content += '</div>';

    return content;
  }

  buildLogPageContent(status, logData, summary) {
    let content = '<div class="row mb-4">';
    content += '<div class="col-12">';
    content += `<div class="alert ${this.crawlerRunning ? 'alert-info' : 'alert-secondary'}">${escape(status)}</div>`;
    content += '</div>';
    content += '</div>';

    if (this.crawlerRunning) {
      content += '<div class="row mb-4">';
      content += '<div class="col-12">';
      content += '<div class="spinner-border text-primary" role="status">';
      content += '<span class="sr-only">Loading...</span>';
      content += '</div>';
      content += ' <strong>Refresh this page in a few minutes to see updated status.</strong>';
      content += '</div>';
      content += '</div>';
    }

    if (summary || logData) {
      content += '<table class="table table-sm">';

      if (logData) {
        if (logData.startTime) {
          content += `<tr><td>Start Time:</td><td>${new Date(logData.startTime).toLocaleString()}</td></tr>`;
        }
        if (logData.endTime) {
          content += `<tr><td>End Time:</td><td>${new Date(logData.endTime).toLocaleString()}</td></tr>`;
        }
        if (logData.runTime) {
          content += `<tr><td>Duration:</td><td>${logData.runTime}</td></tr>`;
        }
        if (logData.totalBytes) {
          content += `<tr><td>Total Bytes:</td><td>${logData.totalBytes.toLocaleString()}</td></tr>`;
        }
      }

      if (summary) {
        content += `<tr><td>Total Feeds:</td><td>${summary.totalFeeds}</td></tr>`;
        content += `<tr><td>Successful Feeds:</td><td class="text-success">${summary.successfulFeeds}</td></tr>`;
        content += `<tr><td>Failed Feeds:</td><td class="text-danger">${summary.failedFeeds}</td></tr>`;
        content += `<tr><td>Rate Limited Feeds:</td><td class="text-warning">${summary.rateLimitedFeeds}</td></tr>`;
        content += `<tr><td>Total Items Processed:</td><td>${summary.totalItems}</td></tr>`;
      }

      content += '</table>';
    }

    if (logData) {
      content += '<h3>Crawler Log</h3>';
      content += '<pre style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; font-family: monospace; white-space: pre-wrap;">';
      content += this.formatCrawlerLog(logData);
      content += '</pre>';
    } else if (!this.crawlerRunning) {
      content += '<div class="alert alert-info">';
      content += '<h4>No Log Data Available</h4>';
      content += '<p>The crawler hasn\'t run yet or the log data is not available.</p>';
      if (this.config.crawler.enabled) {
        content += '<p><button onclick="triggerCrawl()" class="btn btn-primary">Start Manual Crawl</button></p>';
      }
      content += '</div>';
    }

    return content;
  }

// Add this new method to format the crawler log as readable text
  formatCrawlerLog(logData) {
    let output = '';

    if (logData.fatalException) {
      output += `FATAL ERROR: ${logData.fatalException}\n\n`;
    }

    if (logData.feeds && logData.feeds.length > 0) {
      for (const feed of logData.feeds) {
        if (feed.exception || feed.rateLimited) {
          // Feed itself had an error
          const error = feed.rateLimited ? feed.rateLimitMessage : feed.exception;
          output += `Feed: ${feed.url}: ${error}\n`;
        } else {
          // Feed was successful
          output += `Feed: ${feed.url}: ok\n`;

          // Show any item errors
          if (feed.items && feed.items.length > 0) {
            for (const item of feed.items) {
              if (item.error && item.status !== 'Already Processed') {
                const guid = item.guid || 'unknown';
                output += `  error: ${guid}: ${item.error}\n`;
              }
            }
          }
        }
        output += '\n';
      }
    } else {
      output += 'No feeds processed.\n';
    }

    return escape(output);
  }

  getStatus() {
    return {
      enabled: true,
      // No file system paths here: this is served publicly (/packages/status and the
      // server health check)
      database: {
        connected: this.db ? true : false
      },
      mirror: {
        exists: fs.existsSync(this.config.mirrorPath)
      },
      crawler: {
        enabled: this.config.crawler.enabled,
        running: this.crawlerJob ? true : false,
        schedule: this.config.crawler.schedule,
        lastRun: this.lastRunTime,
        totalRuns: this.totalRuns
      }
    };
  }

  async buildStatsPageContent() {
    const dbCounts = await this.getDatabaseTableCounts();
    const dbAge = this.getDatabaseAgeInfo();

    let content = '<div class="row mb-4">';
    content += '<div class="col-12"><h2>Package Database Statistics</h2></div>';
    content += '</div>';

    content += '<div class="row mb-4">';
    content += '<div class="col-md-4">';
    content += '<div class="card text-center">';
    content += '<div class="card-body">';
    content += '<h5 class="card-title">Total Packages</h5>';
    content += `<h2 class="text-primary">${dbCounts.packages.toLocaleString()}</h2>`;
    content += '</div>';
    content += '</div>';
    content += '</div>';

    content += '<div class="col-md-4">';
    content += '<div class="card text-center">';
    content += '<div class="card-body">';
    content += '<h5 class="card-title">Package Versions</h5>';
    content += `<h2 class="text-success">${dbCounts.packageVersions.toLocaleString()}</h2>`;
    content += '</div>';
    content += '</div>';
    content += '</div>';

    content += '<div class="col-md-4">';
    content += '<div class="card text-center">';
    content += '<div class="card-body">';
    content += '<h5 class="card-title">Database Age</h5>';
    content += `<h2 class="text-info">${dbAge.status}</h2>`;
    content += '</div>';
    content += '</div>';
    content += '</div>';
    content += '</div>';

    // Crawler statistics
    content += '<div class="row">';
    content += '<div class="col-12">';
    content += '<h3>Crawler Statistics</h3>';
    content += '<table class="table table-striped">';
    content += '<tr><th>Metric</th><th>Value</th></tr>';
    content += `<tr><td>Crawler Status</td><td>${this.config.crawler.enabled ? 'Enabled' : 'Disabled'}</td></tr>`;
    content += `<tr><td>Schedule</td><td>${this.config.crawler.schedule || 'Not scheduled'}</td></tr>`;
    content += `<tr><td>Total Runs</td><td>${this.totalRuns}</td></tr>`;
    if (this.lastRunTime) {
      content += `<tr><td>Last Run</td><td>${new Date(this.lastRunTime).toLocaleString()}</td></tr>`;
    }
    content += `<tr><td>Master URL</td><td><a href="${escape(this.config.masterUrl)}" target="_blank">${escape(this.config.masterUrl)}</a></td></tr>`;
    content += '</table>';
    content += '</div>';
    content += '</div>';

    return content;
  }

  fixPrefix(id) {
    if (id && id.startsWith("@") && id.includes("/")) {
      return id.replace("@", "$$").replace("/", "$");
    } else {
      return id;
    }
  }
}

PackagesModule.QUERY_PARAMS = { search: SEARCH_PARAMS, v1Search: V1_SEARCH_PARAMS, updates: UPDATES_PARAMS, broken: BROKEN_PARAMS };
PackagesModule.FHIR_RELEASE_VERSIONS = FHIR_RELEASE_VERSIONS;
PackagesModule.PATH_PARAMS = {
  id: { maxLength: PACKAGE_ID_MAX_LENGTH, pattern: PACKAGE_ID_PATTERN },
  version: { maxLength: PACKAGE_VERSION_MAX_LENGTH, pattern: PACKAGE_VERSION_PATTERN }
};

module.exports = PackagesModule;