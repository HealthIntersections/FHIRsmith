//
// Copyright 2025, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');
const cron = require('node-cron');
const CBOR = require('cbor');
const pako = require('pako');
const base45 = require('base45');
const fs = require('fs');
const folders = require('../library/folder-setup');

const Logger = require('../library/logger');
const shlLog = Logger.getInstance().child({ module: 'shl' });

// Import the FHIR Validator
const FhirValidator = require('fhir-validator-wrapper');

// Try to load vhl.js module, but don't fail if it doesn't exist
let vhlProcessor;
try {
  vhlProcessor = require('./vhl.js');
} catch (err) {
  shlLog.warning('vhl.js not found - VHL processing will be skipped');
  vhlProcessor = null;
}

class SHLModule {
  constructor(stats) {
    this.db = null;
    this.config = null;
    this.router = express.Router();
    this.cleanupJob = null;
    this.fhirValidator = null;
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
      next();
    });
  }

  // Parameter validation middleware
  validateQueryParams(allowedParams = {}) {
    return (req, res, next) => {
      try {
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
            return res.status(400).json({
              error: `Unknown parameter: ${key}`
            });
          }
        }

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
        shlLog.error('Parameter validation error:', error);
        res.status(500).json({ error: 'Parameter validation failed' });
      }
    };
  }

  // Body validation middleware
  validateJsonBody(requiredFields = [], optionalFields = []) {
    return (req, res, next) => {
      try {
        if (!req.body || typeof req.body !== 'object') {
          return res.status(400).json({error: 'Request body must be JSON object'});
        }

        // Check for required fields
        for (const field of requiredFields) {
          if (req.body[field] === undefined || req.body[field] === null) {
            return res.status(400).json({error: `Missing required field: ${field}`});
          }
        }

        // Validate known fields
        const allowedFields = [...requiredFields, ...optionalFields];
        for (const [key, value] of Object.entries(req.body)) {
          if (!allowedFields.includes(key)) {
            return res.status(400).json({error: `Unknown field: ${key}`});
          }

          // Basic type validation
          if (key === 'vhl' && typeof value !== 'boolean') {
            return res.status(400).json({error: 'vhl must be boolean'});
          }

          if ((key === 'password' || key === 'pword') && typeof value !== 'string') {
            return res.status(400).json({error: `${key} must be string`});
          }

          if (key === 'days') {
            const daysNum = typeof value === 'string' ? parseInt(value, 10) : value;
            if (isNaN(daysNum) || daysNum < 1 || daysNum > 365) {
              return res.status(400).json({error: 'days must be between 1 and 365'});
            }
            req.body[key] = daysNum; // Normalize to number
          }

          if (key === 'files' && !Array.isArray(value)) {
            return res.status(400).json({error: 'files must be array'});
          }

          // String length limits
          if (typeof value === 'string') {
            const maxLengths = {
              password: 100,
              pword: 100,
              uuid: 50,
              url: 2000,
              packageId: 100,
              version: 50,
              recipient: 100,
              embeddedLengthMax: 10
            };

            if (maxLengths[key] && value.length > maxLengths[key]) {
              return res.status(400).json({
                error: `${key} too long (max ${maxLengths[key]})`
              });
            }
          }
        }

        next();
      } catch (error) {
        shlLog.error('Body validation error:', error);
        res.status(500).json({error: 'Request validation failed'});
      }
    };
  }

  // Secure comparison function
  secureCompare(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') {
      return false;
    }

    if (a.length !== b.length) {
      // Still do a comparison to prevent timing attacks
      crypto.timingSafeEqual(Buffer.from(a), Buffer.from(a));
      return false;
    }

    try {
      return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
    } catch (error) {
      return false;
    }
  }

  // URL validation
  validateExternalUrl(url) {
    try {
      const parsed = new URL(url);

      if (!['http:', 'https:', 'shlink:'].includes(parsed.protocol)) {
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

  async initialize(config) {
    this.config = config;

    // Initialize database
    await this.initializeDatabase();

    // Initialize FHIR Validator if enabled
    if (config.validator.enabled) {
      await this.initializeFhirValidator();
    }

    // Start cleanup cron job
    this.startCleanupJob();

    shlLog.info('SHL module initialized successfully');
  }

  async initializeDatabase() {
    return new Promise((resolve, reject) => {

      const dbPath = folders.filePath('shl', this.config.database);  // <-- CHANGE
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });

      this.db = new sqlite3.Database(dbPath, (err) => {
        if (err) {
          shlLog.error('Error opening SHL SQLite database at "'+dbPath+'":', err.message);
          reject(err);
        } else {
          shlLog.info('Connected to SHL SQLite database at "'+dbPath+'"');

          // Check if tables already exist before creating them
          this.db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='SHL'", (err, row) => {
            if (err) {
              reject(err);
            } else if (row) {
              // Tables already exist, no need to create them
              resolve();
            } else {
              // Tables don't exist, create them
              this.createTables().then(resolve).catch(reject);
            }
          });
        }
      });
    });
  }

  async createTables() {
    return new Promise((resolve, reject) => {
      const createSHLTable = `
          CREATE TABLE IF NOT EXISTS SHL (
                                             uuid TEXT PRIMARY KEY,
                                             vhl BOOLEAN NOT NULL,
                                             expires_at DATETIME NOT NULL,
                                             password TEXT NOT NULL,
                                             created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
      `;

      const createSHLFilesTable = `
          CREATE TABLE IF NOT EXISTS SHLFiles (
                                                  id TEXT PRIMARY KEY,
                                                  shl_uuid TEXT NOT NULL,
                                                  cnt TEXT NOT NULL,
                                                  type TEXT NOT NULL,
                                                  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                                                  FOREIGN KEY (shl_uuid) REFERENCES SHL (uuid) ON DELETE CASCADE
              )
      `;

      const createSHLViewsTable = `
          CREATE TABLE IF NOT EXISTS SHLViews (
                                                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                                                  shl_uuid TEXT NOT NULL,
                                                  recipient TEXT,
                                                  ip_address TEXT,
                                                  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                                                  FOREIGN KEY (shl_uuid) REFERENCES SHL (uuid) ON DELETE CASCADE
              )
      `;

      let tablesCreated = 0;
      const totalTables = 3;

      const checkComplete = () => {
        tablesCreated++;
        if (tablesCreated === totalTables) {
          shlLog.info('SHL database initialized');
          resolve();
        }
      };

      this.db.run(createSHLTable, (err) => {
        if (err) {
          shlLog.error('Error creating SHL table:', err.message);
          reject(err);
        } else {
          checkComplete();
        }
      });

      this.db.run(createSHLFilesTable, (err) => {
        if (err) {
          shlLog.error('Error creating SHLFiles table:', err.message);
          reject(err);
        } else {
          checkComplete();
        }
      });

      this.db.run(createSHLViewsTable, (err) => {
        if (err) {
          shlLog.error('Error creating SHLViews table:', err.message);
          reject(err);
        } else {
          checkComplete();
        }
      });
    });
  }

  async initializeFhirValidator() {
    try {
      shlLog.info('Initializing FHIR Validator...');

      const validatorConfig = {
        version: this.config.validator.version,
        txServer: this.config.validator.txServer,
        txLog: this.config.validator.txLog,
        port: this.config.validator.port,
        igs: this.config.validator.packages,
        timeout: this.config.validator.timeout
      };

      shlLog.info('Starting FHIR Validator with config:', validatorConfig);

      const validatorJarPath = folders.filePath('bin', 'validator_cli.jar');
      this.fhirValidator = new FhirValidator(validatorJarPath, shlLog);
      await this.fhirValidator.start(validatorConfig);

      shlLog.info('FHIR Validator started successfully');
    } catch (error) {
      shlLog.error('Failed to start FHIR Validator:', error);
      throw error;
    }
  }

  loadCertificates() {
    try {
      const certPath = folders.filePath('shl', this.config.certificates.certFile);
      const keyPath = folders.filePath('shl', this.config.certificates.keyFile);

      const certPem = fs.readFileSync(certPath, 'utf8');
      const keyPem = fs.readFileSync(keyPath, 'utf8');

      return { certPem, keyPem };
    } catch (error) {
      throw new Error(`Failed to load certificates: ${error.message}`);
    }
  }

  startCleanupJob() {
    if (this.config.cleanup && this.config.cleanup.schedule) {
      this.cleanupJob = cron.schedule(this.config.cleanup.schedule, () => {
        shlLog.info('Running scheduled cleanup of expired SHL entries...');
        this.cleanupExpiredEntries();
      });
      shlLog.info(`SHL cleanup job scheduled: ${this.config.cleanup.schedule}`);
    }
  }

  // node-cron 4: stop() may return a promise
  async stopCleanupJob() {
    if (this.cleanupJob) {
      const job = this.cleanupJob;
      this.cleanupJob = null;
      await job.stop();
    }
  }

  cleanupExpiredEntries() {
    const deleteSql = 'DELETE FROM SHL WHERE expires_at < datetime("now")';

    this.db.run(deleteSql, function(err) {
      if (err) {
        shlLog.error('SHL cleanup error:', err.message);
      } else if (this.changes > 0) {
        shlLog.info(`Cleaned up ${this.changes} expired SHL entries`);
      }
    });
  }

  generateUUID() {
    return crypto.randomUUID();
  }

  // Helper function to convert PEM to JWK for COSE signing
  pemToJwk(pemCert, pemKey) {
    try {
      const keyObject = crypto.createPrivateKey(pemKey);
      const keyType = keyObject.asymmetricKeyType;

      if (keyType !== 'ec') {
        throw new Error('Only EC (Elliptic Curve) keys are supported for COSE signing');
      }

      const jwk = keyObject.export({ format: 'jwk' });
      return jwk;
    } catch (error) {
      throw new Error(`Failed to convert PEM to JWK: ${error.message}`);
    }
  }

  // Helper function to convert DER signature to raw r||s format
  derToRaw(derSignature) {
    let offset = 2; // Skip SEQUENCE tag and length

    // First INTEGER (r)
    offset++; // Skip INTEGER tag
    const rLen = derSignature[offset++];
    const r = Buffer.alloc(32);

    const rStart = Math.max(0, rLen - 32);
    const rCopyLen = Math.min(rLen, 32);
    derSignature.copy(r, 32 - rCopyLen, offset + rStart, offset + rLen);
    offset += rLen;

    // Second INTEGER (s)
    offset++; // Skip INTEGER tag
    const sLen = derSignature[offset++];
    const s = Buffer.alloc(32);

    const sStart = Math.max(0, sLen - 32);
    const sCopyLen = Math.min(sLen, 32);
    derSignature.copy(s, 32 - sCopyLen, offset + sStart, offset + sLen);

    return Buffer.concat([r, s]);
  }

  async createCOSESign1(payload, privateKeyJWK, kid) {
    try {
      const protectedHeaders = new Map();
      protectedHeaders.set(1, -7);  // alg: ES256
      protectedHeaders.set(4, kid); // kid

      const protectedEncoded = CBOR.encode(protectedHeaders);

      const sigStructure = [
        "Signature1",
        protectedEncoded,
        Buffer.alloc(0),
        payload
      ];

      const sigStructureEncoded = CBOR.encode(sigStructure);

      const privateKey = crypto.createPrivateKey({
        key: {
          kty: privateKeyJWK.kty,
          crv: privateKeyJWK.crv,
          x: privateKeyJWK.x,
          y: privateKeyJWK.y,
          d: privateKeyJWK.d
        },
        format: 'jwk'
      });

      const signer = crypto.createSign('SHA256');
      signer.update(sigStructureEncoded);
      const signatureDER = signer.sign(privateKey);

      const rawSignature = this.derToRaw(signatureDER);

      const coseSign1Array = [
        protectedEncoded,
        new Map(),
        payload,
        rawSignature
      ];

      const taggedMessage = new CBOR.Tagged(18, coseSign1Array);
      const encoded = CBOR.encode(taggedMessage);

      return encoded;

    } catch (error) {
      shlLog.error('COSE Sign1 creation error:', error);
      throw error;
    }
  }

  setupRoutes() {
    // Validation parameter configs
    const validationParams = {
      profiles: { maxLength: 500, pattern: /^[a-zA-Z0-9.:/_,-]*$/ },
      resourceIdRule: { maxLength: 50, pattern: /^[a-zA-Z0-9_-]*$/ },
      anyExtensionsAllowed: { maxLength: 10, pattern: /^(true|false)?$/ },
      bpWarnings: { maxLength: 50, pattern: /^[a-zA-Z0-9_-]*$/ },
      displayOption: { maxLength: 50, pattern: /^[a-zA-Z0-9_-]*$/ }
    };

    // FHIR Validation endpoint
    this.router.post('/validate', this.validateQueryParams(validationParams), async (req, res) => {
      const start = Date.now();
      try {
        if (!this.fhirValidator || !this.fhirValidator.isRunning()) {
          return res.status(503).json({
            resourceType: 'OperationOutcome',
            issue: [{
              severity: 'error',
              code: 'exception',
              diagnostics: 'FHIR Validator service is not available'
            }]
          });
        }

        try {
          const options = {};

          if (req.query.profiles) {
            options.profiles = req.query.profiles.split(',');
          }
          if (req.query.resourceIdRule) {
            options.resourceIdRule = req.query.resourceIdRule;
          }
          if (req.query.anyExtensionsAllowed !== undefined) {
            options.anyExtensionsAllowed = req.query.anyExtensionsAllowed === 'true';
          }
          if (req.query.bpWarnings) {
            options.bpWarnings = req.query.bpWarnings;
          }
          if (req.query.displayOption) {
            options.displayOption = req.query.displayOption;
          }
          shlLog.info("validate! (4)");

          let resource;
          if (Buffer.isBuffer(req.body)) {
            resource = req.body;
          } else if (typeof req.body === 'string') {
            resource = req.body;
          } else {
            resource = JSON.stringify(req.body);
          }
          shlLog.info("validate! (5)");

          const operationOutcome = await this.fhirValidator.validate(resource, options);
          shlLog.info("validate! (6)");

          res.json(operationOutcome);
          shlLog.info("validate! (7)");

        } catch (error) {
          shlLog.error('Validation error:', error);
          res.status(500).json({
            resourceType: 'OperationOutcome',
            issue: [{
              severity: 'error',
              code: 'exception',
              diagnostics: `Validation failed: ${error.message}`
            }]
          });
        }
      } finally {
        this.stats.countRequest('validate', Date.now() - start);
      }
    });

    // Validator status endpoint
    this.router.get('/validate/status', (req, res) => {
      const start = Date.now();
      try {
        const status = {
          validatorRunning: this.fhirValidator ? this.fhirValidator.isRunning() : false,
          validatorInitialized: this.fhirValidator !== null
        };

        res.json(status);
      } finally {
        this.stats.countRequest('status', Date.now() - start);
      }
    });

    // Load additional IG endpoint
    this.router.post('/validate/loadig', this.validateJsonBody(['packageId', 'version']), async (req, res) => {
      const start = Date.now();
      try {
        if (!this.fhirValidator || !this.fhirValidator.isRunning()) {
          return res.status(503).json({
            resourceType: 'OperationOutcome',
            issue: [{
              severity: 'error',
              code: 'exception',
              diagnostics: 'FHIR Validator service is not available'
            }]
          });
        }

        const {packageId, version} = req.body;

        if (!packageId || !version) {
          return res.status(400).json({
            resourceType: 'OperationOutcome',
            issue: [{
              severity: 'error',
              code: 'required',
              diagnostics: 'packageId and version are required'
            }]
          });
        }

        try {
          const result = await this.fhirValidator.loadIG(packageId, version);
          res.json(result);
        } catch (error) {
          shlLog.error('Load IG error:', error);
          res.status(500).json({
            resourceType: 'OperationOutcome',
            issue: [{
              severity: 'error',
              code: 'exception',
              diagnostics: `Failed to load IG: ${error.message}`
            }]
          });
        }
      } finally {
        this.stats.countRequest('loadIG', Date.now() - start);
      }
    });

    // SHL create endpoint
    this.router.post('/create', this.validateJsonBody(['vhl', 'password', 'days']), (req, res) => {
      const start = Date.now();
      try {
        const {vhl, password, days} = req.body;

        if (typeof vhl !== 'boolean' || !password) {
          return res.status(400).json({
            error: 'Invalid request. Required: vhl (boolean), password (string), days (number or string)'
          });
        }

        let daysNumber;
        if (typeof days === 'string') {
          daysNumber = parseInt(days, 10);
          if (isNaN(daysNumber)) {
            return res.status(400).json({
              error: 'days must be a valid number or numeric string'
            });
          }
        } else if (typeof days === 'number') {
          daysNumber = days;
        } else {
          return res.status(400).json({
            error: 'days is required and must be a number or numeric string'
          });
        }

        if (password !== this.config.password) {
          return res.status(401).json({error: 'Unauthorized'});
        }

        const uuid = this.generateUUID();
        const newPassword = this.generateUUID();

        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + daysNumber);
        const expiryDateString = expiryDate.toISOString();

        const insertSql = 'INSERT INTO SHL (uuid, vhl, expires_at, password) VALUES (?, ?, ?, ?)';

        this.db.run(insertSql, [uuid, vhl, expiryDateString, newPassword], function (err) {
          if (err) {
            return res.status(500).json({error: 'Failed to create SHL entry: ' + err.message});
          }

          const host = req.get('host') || 'localhost:3000';

          res.status(201).json({
            uuid: uuid,
            pword: newPassword,
            link: `https://${host}/shl/access/${uuid}`
          });
        });
      } finally {
        this.stats.countRequest('create', Date.now() - start);
      }
    });

    // SHL upload endpoint
    this.router.post('/upload', this.validateJsonBody(['uuid', 'pword', 'files']), (req, res) => {
      const start = Date.now();
      try {
        const {uuid, pword, files} = req.body;

        if (!uuid || !pword || !Array.isArray(files)) {
          return res.status(400).json({
            error: 'Invalid request. Required: uuid (string), pword (string), files (array)'
          });
        }

        for (const f of files) {
          if (!f.cnt || !f.type) {
            return res.status(400).json({
              error: 'Invalid file format. Each file must have cnt (base64) and type (mime type)'
            });
          }
        }

        const checkSHLSql = 'SELECT vhl, password FROM SHL WHERE uuid = ?';

        this.db.get(checkSHLSql, [uuid], (err, row) => {
          if (err) {
            return res.status(500).json({error: 'Database error'});
          }

          if (!row) {
            return res.status(404).json({error: 'SHL entry not found'});
          }

          if (row.password !== pword) {
            return res.status(401).json({error: 'Unauthorized'});
          }

          const deleteExistingFilesSql = 'DELETE FROM SHLFiles WHERE shl_uuid = ?';

          this.db.run(deleteExistingFilesSql, [uuid], (err) => {
            if (err) {
              return res.status(500).json({error: 'Failed to clear existing files'});
            }

            const insertPromises = files.map((f) => {
              return new Promise((resolve, reject) => {
                const fileId = this.generateUUID();
                const insertFileSql = 'INSERT INTO SHLFiles (id, shl_uuid, cnt, type) VALUES (?, ?, ?, ?)';

                this.db.run(insertFileSql, [fileId, uuid, f.cnt, f.type], function (err) {
                  if (err) {
                    reject(err);
                  } else {
                    resolve();
                  }
                });
              });
            });

            Promise.all(insertPromises)
              .then(() => {
                res.json({msg: 'ok'});
              })
              .catch((error) => {
                shlLog.error('File upload error:', error);
                res.status(500).json({error: 'Failed to upload files'});
              });
          });
        });
      } finally {
        this.stats.countRequest('upload', Date.now() - start);
      }
    });

    // Helper function for the shared access logic
    const handleSHLAccess = (req, res) => {
      const start = Date.now();
      try {
        const {uuid} = req.params;

        let recipient, embeddedLengthMax;

        if (req.method === 'GET') {
          recipient = 'anonymous';
          embeddedLengthMax = undefined;
        } else {
          ({recipient, embeddedLengthMax} = req.body);

          if (!recipient) {
            return res.status(400).json({
              error: 'recipient is required in request body'
            });
          }
        }

        const clientIP = req.ip || req.connection.remoteAddress || req.socket.remoteAddress ||
          (req.connection.socket ? req.connection.socket.remoteAddress : null) ||
          req.headers['x-forwarded-for'] || 'unknown';

        const checkSHLSql = 'SELECT uuid, vhl FROM SHL WHERE uuid = ? AND expires_at > datetime("now")';

        this.db.get(checkSHLSql, [uuid], (err, shlRow) => {
          if (err) {
            return res.status(500).json({error: 'Database error'});
          }

          if (!shlRow) {
            return res.status(404).json({error: 'SHL entry not found or expired'});
          }

          const logAccessSql = 'INSERT INTO SHLViews (shl_uuid, recipient, ip_address) VALUES (?, ?, ?)';

          this.db.run(logAccessSql, [uuid, recipient, clientIP], function (logErr) {
            if (logErr) {
              shlLog.error('Failed to log SHL access:', logErr.message);
            }

            const getFilesSql = 'SELECT id, cnt, type FROM SHLFiles WHERE shl_uuid = ?';

            this.db.all(getFilesSql, [uuid], (err, fileRows) => {
              if (err) {
                return res.status(500).json({error: 'Failed to retrieve files'});
              }

              const host = req.get('host') || 'localhost:3000';
              const protocol = req.secure ? 'https' : 'http';
              const maxLength = embeddedLengthMax ? parseInt(embeddedLengthMax) : undefined;

              const files = fileRows.map(file => {
                const fileResponse = {
                  contentType: file.type,
                  location: `${protocol}://${host}/shl/file/${file.id}`
                };

                if (maxLength === undefined || file.cnt.length <= maxLength) {
                  fileResponse.embedded = file.cnt;
                }

                return fileResponse;
              });

              const standardResponse = {files};

              if (shlRow.vhl && vhlProcessor) {
                try {
                  const vhlResponse = vhlProcessor.processVHL(host, uuid, standardResponse);
                  res.json(vhlResponse);
                } catch (vhlErr) {
                  shlLog.error('VHL processing error:', vhlErr.message);
                  res.json(standardResponse);
                }
              } else {
                res.json(standardResponse);
              }
            });
          });
        });
      } finally {
        this.stats.countRequest('access', Date.now() - start);
      }
    };

    // SHL access endpoint - supports both GET and POST
    this.router.get('/access/:uuid', handleSHLAccess);
    this.router.post('/access/:uuid', this.validateJsonBody(['recipient'], ['embeddedLengthMax']), handleSHLAccess);

    // SHL file endpoint - serves individual files
    this.router.get('/file/:fileId', (req, res) => {
      const start = Date.now();
      try {
        const {fileId} = req.params;

        // Validate fileId format
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fileId)) {
          return res.status(400).json({error: 'Invalid file ID format'});
        }

        const clientIP = req.ip || req.connection.remoteAddress || req.socket.remoteAddress ||
          (req.connection.socket ? req.connection.socket.remoteAddress : null) ||
          req.headers['x-forwarded-for'] || 'unknown';

        const getFileSql = 'SELECT id, shl_uuid, cnt, type FROM SHLFiles WHERE id = ?';

        this.db.get(getFileSql, [fileId], (err, fileRow) => {
          if (err) {
            return res.status(500).json({error: 'Database error'});
          }

          if (!fileRow) {
            return res.status(404).json({error: 'File not found'});
          }

          const logMasterAccessSql = 'INSERT INTO SHLViews (shl_uuid, recipient, ip_address) VALUES (?, ?, ?)';
          const logFileAccessSql = 'INSERT INTO SHLViews (shl_uuid, recipient, ip_address) VALUES (?, ?, ?)';

          this.db.run(logMasterAccessSql, [fileRow.shl_uuid, null, clientIP], function (logErr) {
            if (logErr) {
              shlLog.error('Failed to log master SHL file access:', logErr.message);
            }
          });

          this.db.run(logFileAccessSql, [fileRow.id, null, clientIP], function (logErr) {
            if (logErr) {
              shlLog.error('Failed to log file-specific access:', logErr.message);
            }
          });

          try {
            const fileBuffer = Buffer.from(fileRow.cnt, 'base64');
            res.set('Content-Type', 'application/jose');
            res.send(fileBuffer);
          } catch (decodeErr) {
            res.status(500).json({error: 'Failed to decode file content'});
          }
        });
      } finally {
        this.stats.countRequest('file', Date.now() - start);
      }
    });

    // SHL sign endpoint
    this.router.post('/sign', this.validateJsonBody(['url']), async (req, res) => {
      const start = Date.now();
      try {
        const {url} = req.body;

        if (!url || typeof url !== 'string') {
          return res.status(400).json({
            error: 'url is required and must be a string'
          });
        }

        try {
          // Validate URL
          this.validateExternalUrl(url);

          const {certPem, keyPem} = this.loadCertificates();
          const {kid} = this.config.certificates;
          const {issuer} = this.config.vhl;

          if (!certPem || !keyPem) {
            return res.status(500).json({error: 'Certificate or private key files not found'});
          }

          if (!kid) {
            return res.status(500).json({error: 'KID not configured'});
          }

          try {
            const jwk = this.pemToJwk(certPem, keyPem);

            const payload = {
              "1": issuer,
              "-260": {
                "5": [url]
              }
            };

            const cborEncoded = CBOR.encode(payload);
            const coseSigned = await this.createCOSESign1(cborEncoded, jwk, kid);
            const deflated = pako.deflate(coseSigned);
            const base45Encoded = base45.encode(deflated);

            const publicJwk = {
              kty: jwk.kty,
              crv: jwk.crv,
              x: jwk.x,
              y: jwk.y
            };

            res.json({
              signature: base45Encoded,
              steps: {
                input: {
                  url: url,
                  issuer: issuer,
                  kid: kid
                },
                step1_payload: payload,
                step1_payload_json: JSON.stringify(payload),
                step2_cbor_encoded: Array.from(cborEncoded),
                step2_cbor_encoded_hex: cborEncoded.toString('hex'),
                step2_cbor_encoded_base64: cborEncoded.toString('base64'),
                step3_cose_signed: Array.from(coseSigned),
                step3_cose_signed_hex: coseSigned.toString('hex'),
                step3_cose_signed_base64: coseSigned.toString('base64'),
                step4_deflated: Array.from(deflated),
                step4_deflated_hex: Buffer.from(deflated).toString('hex'),
                step4_deflated_base64: Buffer.from(deflated).toString('base64'),
                step5_base45_encoded: base45Encoded,
                crypto_info: {
                  public_key_jwk: publicJwk,
                  certificate_pem: certPem,
                  algorithm: "ES256",
                  curve: "P-256"
                },
                sizes: {
                  original_url_bytes: Buffer.byteLength(url, 'utf8'),
                  payload_json_bytes: Buffer.byteLength(JSON.stringify(payload), 'utf8'),
                  cbor_encoded_bytes: cborEncoded.length,
                  cose_signed_bytes: coseSigned.length,
                  deflated_bytes: deflated.length,
                  base45_encoded_bytes: Buffer.byteLength(base45Encoded, 'utf8')
                }
              }
            });

          } catch (error) {
            shlLog.error('SHL sign processing error:', error);
            res.status(500).json({
              error: 'Failed to sign URL: ' + error.message
            });
          }
        } catch (error) {
          shlLog.error('SHL sign error:', error);
          res.status(500).json({
            error: 'Failed to sign URL: ' + error.message
          });
        }
      } finally {
        this.stats.countRequest('sign', Date.now() - start);
      }
    });
  }

  /**
   * The paragraph for the server's daily report: links (QR codes) created in
   * the period, in either form, how often links were accessed, and the
   * documents stored behind them.
   */
  async dailyReport({since, now}) {
    const {plural} = require('../library/daily-report');
    if (!this.db) {
      return 'The database is not open.';
    }
    const get = (sql, params) => new Promise((resolve, reject) =>
      this.db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
    // created_at is CURRENT_TIMESTAMP: UTC, 'YYYY-MM-DD HH:MM:SS'
    const utc = ms => new Date(ms).toISOString().replace('T', ' ').substring(0, 19);
    try {
      const created = await get(
        'SELECT SUM(CASE WHEN vhl THEN 0 ELSE 1 END) AS shl, SUM(CASE WHEN vhl THEN 1 ELSE 0 END) AS vhl FROM SHL WHERE created_at > ? AND created_at <= ?',
        [utc(since), utc(now)]);
      const views = await get('SELECT COUNT(*) AS n FROM SHLViews WHERE created_at > ? AND created_at <= ?', [utc(since), utc(now)]);
      const files = await get('SELECT COUNT(*) AS n, COUNT(DISTINCT shl_uuid) AS links FROM SHLFiles', []);
      const shl = created.shl || 0;
      const vhl = created.vhl || 0;
      const total = shl + vhl;
      const sentences = [];
      sentences.push(`${plural(total, 'QR code')} ${total === 1 ? 'was' : 'were'} served (${shl} SMART Health ${shl === 1 ? 'Link' : 'Links'}, ${plural(vhl, 'Verifiable Health Link')}), and links were accessed ${plural(views.n, 'time')}.`);
      sentences.push(`${plural(files.n, 'document')} ${files.n === 1 ? 'is' : 'are'} stored to serve ${plural(files.links, 'QR code')}.`);
      return sentences.join(' ');
    } catch (e) {
      return `The database could not be read: ${e.message}.`;
    }
  }

  async shutdown() {
    shlLog.info('Shutting down SHL module...');

    await this.stopCleanupJob();

    // Stop FHIR validator
    if (this.fhirValidator) {
      try {
        shlLog.info('Stopping FHIR validator...');
        await this.fhirValidator.stop();
        shlLog.info('FHIR validator stopped');
      } catch (error) {
        shlLog.error('Error stopping FHIR validator:', error);
      }
    }

    if (this.db) {
      return new Promise((resolve) => {
        this.db.close((err) => {
          if (err) {
            shlLog.error('Error closing SHL database:', err.message);
          } else {
            shlLog.info('SHL database connection closed');
          }
          resolve();
        });
      });
    }
  }

  getStatus() {
    return {
      enabled: true,
      database: this.db ? 'Connected' : 'Disconnected',
      cleanupJob: this.cleanupJob ? 'Running' : 'Stopped',
      validator: this.fhirValidator ? (this.fhirValidator.isRunning() ? 'Running' : 'Stopped') : 'Not initialized'
    };
  }

}

module.exports = SHLModule;