//
// Copyright 2025, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const FacebookStrategy = require('passport-facebook').Strategy;
const GitHubStrategy = require('passport-github2').Strategy;
const rateLimit = require('express-rate-limit');
const lusca = require('lusca');
const folders = require('../library/folder-setup');
const { SqliteSessionStore } = require('../library/sqlite-session-store');
const escape = require('escape-html');


const Logger = require('../library/logger');
const htmlServer = require('../library/html-server');

class TokenModule {
  constructor(stats) {
    this.router = express.Router();
    this.db = null;
    this.config = null;
    this.log = Logger.getInstance().child({ module: 'token' });
    this.stats = stats;
  }

  async initialize(config) {
    this.config = config;
    this.log.info('Initializing Token module...');

    // Initialize database
    await this.initializeDatabase();

    // Initialize session middleware FIRST
    this.initializeSession();

    // Initialize security middleware
    this.initializeSecurity();

    // Initialize Passport
    this.initializePassport();

    // Initialize routes
    this.initializeRoutes();

    // Load HTML template
    this.loadTemplate();

    this.log.info('Token module initialized successfully');
  }

  async initializeDatabase() {
    const configDb = this.config.database || 'token.db';
    const dbPath = path.isAbsolute(configDb)
      ? configDb
      : folders.ensureFilePath('token', configDb);

    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(dbPath, (err) => {
        if (err) {
          this.log.error('Failed to open database:', err);
          reject(err);
          return;
        }

        // Create tables
        this.db.serialize(() => {
          // Users table - enhanced with OAuth data
          this.db.run(`
            CREATE TABLE IF NOT EXISTS users (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              email TEXT UNIQUE NOT NULL,
              name TEXT NOT NULL,
              provider TEXT NOT NULL,
              provider_id TEXT NOT NULL,
              profile_data TEXT,
              last_login DATETIME,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              is_active BOOLEAN DEFAULT 1
            )
          `);

          // API Keys table - enhanced with more metadata
          this.db.run(`
            CREATE TABLE IF NOT EXISTS api_keys (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              user_id INTEGER NOT NULL,
              key_hash TEXT UNIQUE NOT NULL,
              key_prefix TEXT NOT NULL,
              name TEXT NOT NULL,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              last_used DATETIME,
              expires_at DATETIME,
              is_active BOOLEAN DEFAULT 1,
              created_ip TEXT,
              scopes TEXT DEFAULT 'read',
              FOREIGN KEY (user_id) REFERENCES users (id)
            )
          `);

          // Usage tracking table
          this.db.run(`
            CREATE TABLE IF NOT EXISTS usage_stats (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              api_key_id INTEGER NOT NULL,
              date DATE NOT NULL,
              request_count INTEGER DEFAULT 0,
              last_request_ip TEXT,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              FOREIGN KEY (api_key_id) REFERENCES api_keys (id),
              UNIQUE(api_key_id, date)
            )
          `);

          // Security audit log
          this.db.run(`
            CREATE TABLE IF NOT EXISTS security_log (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              user_id INTEGER,
              event_type TEXT NOT NULL,
              ip_address TEXT,
              user_agent TEXT,
              details TEXT,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              FOREIGN KEY (user_id) REFERENCES users (id)
            )
          `);

          // Create indexes
          this.db.run(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`);
          this.db.run(`CREATE INDEX IF NOT EXISTS idx_users_provider ON users(provider, provider_id)`);
          this.db.run(`CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(is_active)`);
          this.db.run(`CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix)`);
          this.db.run(`CREATE INDEX IF NOT EXISTS idx_usage_date ON usage_stats(date)`);
          this.db.run(`CREATE INDEX IF NOT EXISTS idx_security_log_user ON security_log(user_id)`);
          this.db.run(`CREATE INDEX IF NOT EXISTS idx_security_log_event ON security_log(event_type)`);
        });

        this.log.info(`Token database initialized: ${dbPath}`);
        resolve();
      });
    });
  }

  initializeSession() {
    // sessions live in the module's own database (initializeDatabase has opened it)
    this.sessionStore = new SqliteSessionStore({ db: this.db, table: 'sessions' });

    const sessionConfig = {
      store: this.sessionStore,
      secret: this.config.sessionSecret || crypto.randomBytes(64).toString('hex'),
      name: 'fhir.token.sid', // Don't use default session name
      resave: false,
      saveUninitialized: false,
      rolling: true, // Reset expiration on each request
      cookie: {
        secure: process.env.NODE_ENV === 'production', // HTTPS only in production
        httpOnly: true, // Prevent XSS
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
        sameSite: 'lax' // CSRF protection
      }
    };

    this.router.use(session(sessionConfig));
  }

  initializeSecurity() {
    // CSRF protection
    this.router.use(lusca({
      csrf: {
        angular: false,
        key: 'csrf',
        secret: this.config.csrfSecret || this.config.sessionSecret
      },
      csp: {
        policy: {
          'default-src': "'self'",
          'script-src': "'self' 'unsafe-inline'",
          'style-src': "'self' 'unsafe-inline'",
          'img-src': "'self' data: https:",
          'connect-src': "'self'",
          'form-action': "'self'"
        }
      },
      xframe: 'SAMEORIGIN',
      hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
      xssProtection: true,
      nosniff: true
    }));

    // Rate limiting
    const authLimiter = rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 5, // 5 attempts per window
      message: 'Too many authentication attempts, please try again later.',
      standardHeaders: true,
      legacyHeaders: false,
      skip: (req) => {
        // Skip rate limiting for successful authentications
        return req.user && req.isAuthenticated();
      }
    });

    const apiLimiter = rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 100, // 100 requests per window for API calls
      message: 'Too many API requests, please try again later.',
      standardHeaders: true,
      legacyHeaders: false
    });

    // Apply rate limiting to specific routes
    this.router.use('/auth', authLimiter);
    this.router.use('/api', apiLimiter);
  }

  initializePassport() {
    // Initialize Passport
    this.router.use(passport.initialize());
    this.router.use(passport.session());

    // User serialization
    passport.serializeUser((user, done) => {
      done(null, user.id);
    });

    passport.deserializeUser(async (id, done) => {
      try {
        const user = await this.getUserById(id);
        done(null, user);
      } catch (error) {
        done(error, null);
      }
    });

    // Configure OAuth strategies
    this.configureOAuthStrategies();
  }

  configureOAuthStrategies() {
    const oauth = this.config.oauth || {};

    // Google OAuth Strategy
    if (oauth.google) {
      passport.use(new GoogleStrategy({
        clientID: oauth.google.clientId,
        clientSecret: oauth.google.clientSecret,
        callbackURL: oauth.google.redirectUri,
        scope: oauth.google.scope || ['openid', 'profile', 'email'],
        passReqToCallback: true
      }, async (req, accessToken, refreshToken, profile, done) => {
        try {
          const user = await this.handleOAuthCallback(req, 'google', profile, {
            accessToken, // Don't store this in production
            refreshToken
          });
          return done(null, user);
        } catch (error) {
          return done(error, null);
        }
      }));
    }

    // Facebook OAuth Strategy
    if (oauth.facebook) {
      passport.use(new FacebookStrategy({
        clientID: oauth.facebook.clientId,
        clientSecret: oauth.facebook.clientSecret,
        callbackURL: oauth.facebook.redirectUri,
        profileFields: ['id', 'emails', 'name'],
        passReqToCallback: true
      }, async (req, accessToken, refreshToken, profile, done) => {
        try {
          const user = await this.handleOAuthCallback(req, 'facebook', profile, {
            accessToken,
            refreshToken
          });
          return done(null, user);
        } catch (error) {
          return done(error, null);
        }
      }));
    }

    // GitHub OAuth Strategy
    if (oauth.github) {
      passport.use(new GitHubStrategy({
        clientID: oauth.github.clientId,
        clientSecret: oauth.github.clientSecret,
        callbackURL: oauth.github.redirectUri,
        scope: oauth.github.scope || ['user:email'],
        passReqToCallback: true
      }, async (req, accessToken, refreshToken, profile, done) => {
        try {
          const user = await this.handleOAuthCallback(req, 'github', profile, {
            accessToken,
            refreshToken
          });
          return done(null, user);
        } catch (error) {
          return done(error, null);
        }
      }));
    }

    // Log configured strategies
    const configuredStrategies = Object.keys(oauth).filter(provider => oauth[provider]);
    this.log.info('OAuth strategies configured:', configuredStrategies);
  }

  // eslint-disable-next-line no-unused-vars
  async handleOAuthCallback(req, provider, profile, tokens) {
    const email = this.extractEmail(profile);
    const name = this.extractName(profile);

    if (!email) {
      throw new Error(`No email provided by ${provider}`);
    }

    // Find or create user
    const userData = {
      email,
      name,
      provider,
      provider_id: profile.id,
      profile_data: JSON.stringify({
        raw: profile._raw,
        photos: profile.photos
      })
    };

    const userId = await this.findOrCreateUser(userData);
    
    // Update last login
    await this.updateUserLastLogin(userId);

    // Log successful authentication
    await this.logSecurityEvent(userId, 'oauth_login', req.ip, req.get('User-Agent'), {
      provider,
      provider_id: profile.id
    });

    return await this.getUserById(userId);
  }

  extractEmail(profile) {
    if (profile.emails && profile.emails.length > 0) {
      return profile.emails[0].value;
    }
    if (profile._json && profile._json.email) {
      return profile._json.email;
    }
    return null;
  }

  extractName(profile) {
    if (profile.displayName) {
      return profile.displayName;
    }
    if (profile.name) {
      if (typeof profile.name === 'string') {
        return profile.name;
      }
      return `${profile.name.givenName || ''} ${profile.name.familyName || ''}`.trim();
    }
    return profile.username || 'Unknown User';
  }

  loadTemplate() {
    const templatePath = path.join(__dirname, 'token-template.html');
    if (fs.existsSync(templatePath)) {
      htmlServer.loadTemplate('token', templatePath);
      this.log.info('Token template loaded');
    } else {
      this.log.warn('Token template not found, using default');
    }
  }

  initializeRoutes() {
    // Web interface routes
    this.router.get('/', this.renderDashboard.bind(this));
    this.router.get('/login', this.renderLogin.bind(this));
    this.router.post('/logout', this.requireAuth.bind(this), this.handleLogout.bind(this));
    
    // OAuth routes - using Passport
    this.router.get('/auth/google',
      passport.authenticate('google', { 
        scope: ['openid', 'profile', 'email'],
        prompt: 'select_account' // Force account selection
      })
    );

    this.router.get('/auth/google/callback',
      passport.authenticate('google', { 
        failureRedirect: '/token/login?error=oauth_failed',
        successRedirect: '/token'
      })
    );

    this.router.get('/auth/facebook',
      passport.authenticate('facebook', { scope: ['email'] })
    );

    this.router.get('/auth/facebook/callback',
      passport.authenticate('facebook', {
        failureRedirect: '/token/login?error=oauth_failed',
        successRedirect: '/token'
      })
    );

    this.router.get('/auth/github',
      passport.authenticate('github', { scope: ['user:email'] })
    );

    this.router.get('/auth/github/callback',
      passport.authenticate('github', {
        failureRedirect: '/token/login?error=oauth_failed',
        successRedirect: '/token'
      })
    );
    
    // API Key management
    this.router.post('/keys', this.requireAuth.bind(this), this.createApiKey.bind(this));
    this.router.delete('/keys/:id', this.requireAuth.bind(this), this.deleteApiKey.bind(this));
    
    // JSON API routes for other servers. The key goes in a header (Authorization: Bearer, or
    // X-API-Key), not the path, so that it doesn't end up in access logs
    this.router.get('/api/validate', this.validateApiKey.bind(this));
    this.router.post('/api/usage', this.recordUsage.bind(this));
    
    // Statistics
    this.router.get('/api/stats', this.getUsageStats.bind(this));
  }

  // The API key a request carries: Authorization: Bearer <key>, or X-API-Key: <key>
  apiKeyFrom(req) {
    const auth = /^Bearer\s+(\S+)$/i.exec(req.get('Authorization') || '');
    return auth ? auth[1] : (req.get('X-API-Key') || null);
  }

  // Middleware
  requireAuth(req, res, next) {
    if (!req.isAuthenticated()) {
      return res.redirect('/token/login');
    }
    next();
  }

  // Web interface handlers
  async renderDashboard(req, res) {
    const start = Date.now();
    try {

      try {
        if (!req.isAuthenticated()) {
          return res.redirect('/token/login');
        }

        const user = req.user;
        const apiKeys = await this.getUserApiKeys(user.id);
        const usageStats = await this.getUserUsageStats(user.id);

        const content = this.buildDashboardContent(user, apiKeys, usageStats);

        if (htmlServer.hasTemplate('token')) {
          htmlServer.sendHtmlResponse(res, 'token', 'API Key Dashboard', content);
        } else {
          res.send(this.buildSimpleHtml('API Key Dashboard', content));
        }
      } catch (error) {
        this.log.error('Error rendering dashboard:', error);
        res.status(500).json({error: 'Internal server error'});
      }
    } finally {
      this.stats.countRequest('dashboard', Date.now() - start);
    }
  }

  renderLogin(req, res) {
    const start = Date.now();
    try {

      if (req.isAuthenticated()) {
        return res.redirect('/token');
      }

      const oauth = this.config.oauth || {};
      const providers = Object.keys(oauth).filter(provider => oauth[provider]);
      const error = req.query.error;

      const content = this.buildLoginContent(providers, error);

      if (htmlServer.hasTemplate('token')) {
        htmlServer.sendHtmlResponse(res, 'token', 'Login', content);
      } else {
        res.send(this.buildSimpleHtml('Login', content));
      }
    } finally {
      this.stats.countRequest('login', Date.now() - start);
    }
  }

  async handleLogout(req, res) {
    const start = Date.now();
    try {

      const userId = req.user ? req.user.id : null;

      req.logout((err) => {
        if (err) {
          this.log.error('Logout error:', err);
        }

        req.session.destroy((err) => {
          if (err) {
            this.log.error('Session destruction error:', err);
          }

          if (userId) {
            void this.logSecurityEvent(userId, 'logout', req.ip, req.get('User-Agent'), {}); // fire-and-forget audit; errors handled internally
          }

          res.redirect('/token/login');
        });
      });
    } finally {
      this.stats.countRequest('logout', Date.now() - start);
    }
  }

  // API Key management
  async createApiKey(req, res) {
    const start = Date.now();
    try {

      try {
        const {name, scopes = 'read'} = req.body;
        const userId = req.user.id;

        if (!name || name.length < 3) {
          return res.status(400).json({error: 'Key name must be at least 3 characters'});
        }

        // Check key limit per user
        const existingKeys = await this.getUserApiKeys(userId);
        const maxKeys = this.config.apiKeys?.maxKeysPerUser || 10;

        if (existingKeys.length >= maxKeys) {
          return res.status(400).json({
            error: `Maximum ${maxKeys} API keys allowed per user`
          });
        }

        // Generate API key
        const keyData = crypto.randomBytes(32);
        const keyPrefix = 'tk_' + crypto.randomBytes(4).toString('hex');
        const keySuffix = keyData.toString('hex');
        const fullKey = keyPrefix + keySuffix;

        const keyHash = await bcrypt.hash(fullKey, 12);

        // Store in database
        const keyId = await this.storeApiKey(userId, keyHash, keyPrefix, name, scopes, req.ip);

        // Log key creation
        await this.logSecurityEvent(userId, 'api_key_created', req.ip, req.get('User-Agent'), {
          key_id: keyId,
          key_name: name,
          scopes
        });

        res.json({
          apiKey: fullKey,
          message: 'API key created successfully',
          warning: 'Please save this key now. You will not be able to see it again.'
        });
      } catch (error) {
        this.log.error('Error creating API key:', error);
        res.status(500).json({error: 'Failed to create API key'});
      }
    } finally {
      this.stats.countRequest('createKey', Date.now() - start);
    }
  }

  async deleteApiKey(req, res) {
    const start = Date.now();
    try {

      try {
        const keyId = parseInt(req.params.id);
        const userId = req.user.id;

        if (isNaN(keyId)) {
          return res.status(400).json({error: 'Invalid key ID'});
        }

        const deleted = await this.removeApiKey(keyId, userId);

        if (!deleted) {
          return res.status(404).json({error: 'API key not found'});
        }

        // Log key deletion
        await this.logSecurityEvent(userId, 'api_key_deleted', req.ip, req.get('User-Agent'), {
          key_id: keyId
        });

        res.json({message: 'API key deleted successfully'});
      } catch (error) {
        this.log.error('Error deleting API key:', error);
        res.status(500).json({error: 'Failed to delete API key'});
      }
    } finally {
      this.stats.countRequest('deletekey', Date.now() - start);
    }
  }

  // JSON API for other servers
  async validateApiKey(req, res) {
    const start = Date.now();
    try {

      try {
        const apiKey = this.apiKeyFrom(req);

        if (!apiKey || !apiKey.startsWith('tk_')) {
          return res.status(400).json({
            valid: false,
            error: 'Invalid key format'
          });
        }

        const keyInfo = await this.findApiKeyByValue(apiKey);

        if (!keyInfo) {
          return res.status(404).json({
            valid: false,
            error: 'Key not found'
          });
        }

        if (!keyInfo.is_active) {
          return res.status(403).json({
            valid: false,
            error: 'Key inactive'
          });
        }

        // Check expiration
        if (keyInfo.expires_at && new Date(keyInfo.expires_at) < new Date()) {
          return res.status(403).json({
            valid: false,
            error: 'Key expired'
          });
        }

        // Update last used timestamp
        await this.updateKeyLastUsed(keyInfo.id, req.ip);

        const allowedRequests = this.config.apiKeys?.defaultAllowedRequests || 50;

        res.json({
          valid: true,
          user: {
            id: keyInfo.user_id,
            email: keyInfo.email,
            name: keyInfo.name
          },
          key: {
            id: keyInfo.id,
            name: keyInfo.key_name,
            scopes: keyInfo.scopes ? keyInfo.scopes.split(',') : ['read'],
            created_at: keyInfo.created_at
          },
          allowedRequests,
          usage: {
            today: await this.getTodayUsage(keyInfo.id)
          }
        });
      } catch (error) {
        this.log.error('Error validating API key:', error);
        res.status(500).json({
          valid: false,
          error: 'Validation failed'
        });
      }
    } finally {
      this.stats.countRequest('validate', Date.now() - start);
    }
  }

  async recordUsage(req, res) {
    const start = Date.now();
    try {

      try {
        const apiKey = this.apiKeyFrom(req);
        const {count = 1} = req.body;

        if (!apiKey || !apiKey.startsWith('tk_')) {
          return res.status(400).json({error: 'Invalid key format'});
        }

        if (!Number.isInteger(count) || count < 1 || count > 1000) {
          return res.status(400).json({error: 'Count must be between 1 and 1000'});
        }

        const keyInfo = await this.findApiKeyByValue(apiKey);
        if (!keyInfo || !keyInfo.is_active) {
          return res.status(404).json({error: 'Key not found or inactive'});
        }

        await this.incrementUsage(keyInfo.id, count, req.ip);

        res.json({
          message: 'Usage recorded',
          recorded_count: count,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        this.log.error('Error recording usage:', error);
        res.status(500).json({error: 'Failed to record usage'});
      }
    } finally {
      this.stats.countRequest('usage', Date.now() - start);
    }
  }

  async getUsageStats(req, res) {
    const start = Date.now();
    try {

      try {
        const apiKey = this.apiKeyFrom(req);
        const days = Math.max(1, Math.min(parseInt(req.query.days) || 30, 365)); // Max 1 year

        if (!apiKey || !apiKey.startsWith('tk_')) {
          return res.status(400).json({error: 'Invalid key format'});
        }

        const keyInfo = await this.findApiKeyByValue(apiKey);
        if (!keyInfo) {
          return res.status(404).json({error: 'Key not found'});
        }

        const stats = await this.getApiKeyUsageStats(keyInfo.id, days);

        res.json({
          key_id: keyInfo.id,
          key_name: keyInfo.key_name,
          stats,
          period_days: days
        });
      } catch (error) {
        this.log.error('Error getting usage stats:', error);
        res.status(500).json({error: 'Failed to get usage stats'});
      }
    } finally {
      this.stats.countRequest('stats', Date.now() - start);
    }
  }

  // Database helper methods
  async findOrCreateUser(userData) {
    return new Promise((resolve, reject) => {
      // First try to find user by email OR by provider combination
      this.db.get(
        'SELECT id FROM users WHERE (email = ?) OR (provider = ? AND provider_id = ?)',
        [userData.email, userData.provider, userData.provider_id],
        (err, row) => {
          if (err) {
            reject(err);
            return;
          }

          if (row) {
            // Update existing user
            this.db.run(
              'UPDATE users SET email = ?, name = ?, profile_data = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
              [userData.email, userData.name, userData.profile_data, row.id],
              (err) => {
                if (err) {
                  reject(err);
                } else {
                  resolve(row.id);
                }
              }
            );
          } else {
            // Create new user
            this.db.run(
              'INSERT INTO users (email, name, provider, provider_id, profile_data) VALUES (?, ?, ?, ?, ?)',
              [userData.email, userData.name, userData.provider, userData.provider_id, userData.profile_data],
              function(err) {
                if (err) {
                  reject(err);
                } else {
                  resolve(this.lastID);
                }
              }
            );
          }
        }
      );
    });
  }

  async getUserById(userId) {
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT * FROM users WHERE id = ? AND is_active = 1',
        [userId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
  }

  async updateUserLastLogin(userId) {
    return new Promise((resolve, reject) => {
      this.db.run(
        'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?',
        [userId],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  async getUserApiKeys(userId) {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT id, name, key_prefix, created_at, last_used, expires_at, is_active, scopes 
         FROM api_keys 
         WHERE user_id = ? 
         ORDER BY created_at DESC`,
        [userId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });
  }

  async storeApiKey(userId, keyHash, keyPrefix, name, scopes, ip) {
    return new Promise((resolve, reject) => {
      const expiresAt = this.config.apiKeys?.keyExpiration ? 
        new Date(Date.now() + this.config.apiKeys.keyExpiration).toISOString() : 
        null;

      this.db.run(
        `INSERT INTO api_keys (user_id, key_hash, key_prefix, name, scopes, expires_at, created_ip) 
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [userId, keyHash, keyPrefix, name, scopes, expiresAt, ip],
        function(err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });
  }

  async findApiKeyByValue(apiKey) {
    return new Promise((resolve, reject) => {
      const keyPrefix = apiKey.substring(0, 11); // 'tk_' + 8 hex chars
      
      this.db.all(`
        SELECT ak.*, u.email, u.name, ak.name as key_name
        FROM api_keys ak 
        JOIN users u ON ak.user_id = u.id 
        WHERE ak.key_prefix = ? AND ak.is_active = 1 AND u.is_active = 1
      `, [keyPrefix], async (err, rows) => {
        if (err) {
          reject(err);
          return;
        }

        if (!rows || rows.length === 0) {
          resolve(null);
          return;
        }

        // Check each key hash (there should typically be only one with matching prefix)
        try {
          for (const row of rows) {
            const match = await bcrypt.compare(apiKey, row.key_hash);
            if (match) {
              resolve(row);
              return;
            }
          }
          resolve(null);
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  async removeApiKey(keyId, userId) {
    return new Promise((resolve, reject) => {
      this.db.run(
        'UPDATE api_keys SET is_active = 0 WHERE id = ? AND user_id = ?',
        [keyId, userId],
        function(err) {
          if (err) {
            reject(err);
          } else {
            resolve(this.changes > 0);
          }
        }
      );
    });
  }

  // eslint-disable-next-line no-unused-vars
  async updateKeyLastUsed(keyId, ip = null) {
    return new Promise((resolve, reject) => {
      this.db.run(
        'UPDATE api_keys SET last_used = CURRENT_TIMESTAMP WHERE id = ?',
        [keyId],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  async incrementUsage(keyId, count = 1, ip = null) {
    const today = new Date().toISOString().split('T')[0];
    
    return new Promise((resolve, reject) => {
      this.db.run(`
        INSERT INTO usage_stats (api_key_id, date, request_count, last_request_ip)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(api_key_id, date) DO UPDATE SET
          request_count = request_count + ?,
          last_request_ip = ?,
          updated_at = CURRENT_TIMESTAMP
      `, [keyId, today, count, ip, count, ip], function(err) {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async getTodayUsage(keyId) {
    const today = new Date().toISOString().split('T')[0];
    
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT request_count FROM usage_stats WHERE api_key_id = ? AND date = ?',
        [keyId, today],
        (err, row) => {
          if (err) reject(err);
          else resolve(row ? row.request_count : 0);
        }
      );
    });
  }

  async getUserUsageStats(userId) {
    return new Promise((resolve, reject) => {
      this.db.all(`
        SELECT ak.name, us.date, us.request_count
        FROM usage_stats us
        JOIN api_keys ak ON us.api_key_id = ak.id
        WHERE ak.user_id = ? AND us.date >= date('now', '-30 days')
        ORDER BY us.date DESC
      `, [userId], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  }

  async getApiKeyUsageStats(keyId, days = 30) {
    return new Promise((resolve, reject) => {
      this.db.all(`
        SELECT date, request_count
        FROM usage_stats 
        WHERE api_key_id = ? AND date >= date('now', '-${days} days')
        ORDER BY date DESC
      `, [keyId], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  }

  async logSecurityEvent(userId, eventType, ip, userAgent, details) {
    // eslint-disable-next-line no-unused-vars
    return new Promise((resolve, reject) => {
      this.db.run(
        'INSERT INTO security_log (user_id, event_type, ip_address, user_agent, details) VALUES (?, ?, ?, ?, ?)',
        [userId, eventType, ip, userAgent, JSON.stringify(details)],
        function(err) {
          if (err) {
            // Don't fail the main operation if logging fails
            console.error('Failed to log security event:', err);
          }
          resolve();
        }
      );
    });
  }

  // Content builders
  // eslint-disable-next-line no-unused-vars
  buildDashboardContent(user, apiKeys, usageStats) {
    let content = `
      <div class="row mb-4">
        <div class="col-12">
          <div class="d-flex justify-content-between align-items-center">
            <div>
              <h3>Welcome, ${escape(user.name)}</h3>
              <p class="text-muted">Email: ${escape(user.email)} | Provider: ${escape(user.provider)}</p>
            </div>
            <form method="POST" action="/token/logout" class="d-inline">
              <button type="submit" class="btn btn-outline-secondary">Logout</button>
            </form>
          </div>
        </div>
      </div>

      <div class="row mb-4">
        <div class="col-md-8">
          <div class="card">
            <div class="card-header">
              <h4 class="card-title mb-0">Create New API Key</h4>
            </div>
            <div class="card-body">
              <form id="create-key-form">
                <div class="mb-3">
                  <label for="keyName" class="form-label">Key Name</label>
                  <input type="text" class="form-control" id="keyName" name="name" 
                         minlength="3" maxlength="50" required
                         placeholder="e.g., My FHIR App, Development Server">
                  <div class="form-text">Choose a descriptive name to identify this API key</div>
                </div>
                <div class="mb-3">
                  <label for="keyScopes" class="form-label">Scopes</label>
                  <select class="form-control" id="keyScopes" name="scopes">
                    <option value="read">Read Only</option>
                    <option value="read,write">Read & Write</option>
                  </select>
                  <div class="form-text">Permissions this API key will have</div>
                </div>
                <button type="submit" class="btn btn-primary">Create API Key</button>
              </form>
            </div>
          </div>
        </div>
        <div class="col-md-4">
          <div class="card">
            <div class="card-header">
              <h5 class="card-title mb-0">Quick Stats</h5>
            </div>
            <div class="card-body">
              <div class="mb-2">
                <strong>Active Keys:</strong> ${apiKeys.filter(k => k.is_active).length}
              </div>
              <div class="mb-2">
                <strong>Total Keys:</strong> ${apiKeys.length}
              </div>
              <div class="mb-2">
                <strong>Last Login:</strong> ${user.last_login ? new Date(user.last_login).toLocaleDateString() : 'First time'}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="row mb-4">
        <div class="col-12">
          <div class="card">
            <div class="card-header">
              <h4 class="card-title mb-0">Your API Keys</h4>
            </div>
            <div class="card-body">
              <div class="table-responsive">
                <table class="table table-striped">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Key Prefix</th>
                      <th>Scopes</th>
                      <th>Created</th>
                      <th>Last Used</th>
                      <th>Expires</th>
                      <th>Status</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
    `;

    if (apiKeys.length === 0) {
      content += `
        <tr>
          <td colspan="8" class="text-center text-muted py-4">
            No API keys created yet. Create your first API key above.
          </td>
        </tr>
      `;
    } else {
      apiKeys.forEach(key => {
        const status = key.is_active ? 'Active' : 'Inactive';
        const statusClass = key.is_active ? 'text-success' : 'text-muted';
        const lastUsed = key.last_used ? new Date(key.last_used).toLocaleDateString() : 'Never';
        const expires = key.expires_at ? new Date(key.expires_at).toLocaleDateString() : 'Never';
        const scopes = key.scopes || 'read';
        
        content += `
          <tr>
            <td><strong>${escape(key.name)}</strong></td>
            <td><code>${escape(key.key_prefix)}...</code></td>
            <td><span class="badge bg-secondary">${escape(scopes)}</span></td>
            <td>${new Date(key.created_at).toLocaleDateString()}</td>
            <td>${lastUsed}</td>
            <td>${expires}</td>
            <td><span class="${statusClass}">${status}</span></td>
            <td>
              ${key.is_active ? 
                `<button class="btn btn-sm btn-danger" onclick="deleteKey(${Number(key.id)})">Delete</button>` :
                '<span class="text-muted">-</span>'
              }
            </td>
          </tr>
        `;
      });
    }

    content += `
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
    `;

    return content;
  }

  buildLoginContent(providers, error) {
    let content = `
      <div class="row justify-content-center">
        <div class="col-md-6">
          <div class="card">
            <div class="card-body">
              <h3 class="card-title text-center mb-4">Sign In to FHIR Token Server</h3>
              <p class="text-center text-muted mb-4">
                Choose a provider to sign in and manage your API keys
              </p>
    `;

    if (error) {
      let errorMessage = 'Authentication failed. Please try again.';
      if (error === 'oauth_failed') {
        errorMessage = 'OAuth authentication failed. Please ensure you approve the requested permissions.';
      }
      
      content += `
        <div class="alert alert-danger" role="alert">
          <strong>Error:</strong> ${escape(errorMessage)}
        </div>
      `;
    }

    if (providers.length === 0) {
      content += `
        <div class="alert alert-warning">
          <strong>No OAuth providers configured.</strong><br>
          Please configure OAuth providers in your server configuration.
        </div>
      `;
    } else {
      providers.forEach(provider => {
        const providerName = provider.charAt(0).toUpperCase() + provider.slice(1);
        let iconClass = 'fab fa-' + provider;
        let buttonClass = 'btn-outline-primary';
        
        // Provider-specific styling
        switch(provider) {
          case 'google':
            buttonClass = 'btn-outline-danger';
            break;
          case 'facebook':
            buttonClass = 'btn-outline-primary';
            break;
          case 'github':
            buttonClass = 'btn-outline-dark';
            break;
        }
        
        content += `
          <div class="d-grid gap-2 mb-3">
            <a href="/token/auth/${provider}" class="btn ${buttonClass} btn-lg oauth-provider">
              <i class="${iconClass} me-2"></i>
              Sign in with ${providerName}
            </a>
          </div>
        `;
      });
    }

    content += `
              <hr class="my-4">
              <div class="text-center">
                <small class="text-muted">
                  By signing in, you agree to our terms of service and privacy policy.<br>
                  We only request the minimum permissions needed to identify you.
                </small>
              </div>
            </div>
          </div>
          
          <div class="card mt-4">
            <div class="card-body">
              <h5 class="card-title">Security Notice</h5>
              <ul class="list-unstyled mb-0">
                <li><i class="fas fa-shield-alt text-success me-2"></i>All API keys are securely hashed</li>
                <li><i class="fas fa-lock text-success me-2"></i>HTTPS required for all OAuth flows</li>
                <li><i class="fas fa-clock text-success me-2"></i>Sessions expire after 24 hours</li>
                <li><i class="fas fa-chart-line text-success me-2"></i>All access is logged and monitored</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    `;

    return content;
  }

  buildSimpleHtml(title, content) {
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <title>${escape(title)} - FHIR Token Server</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/css/bootstrap.min.css" rel="stylesheet">
        <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
      </head>
      <body>
        <div class="container mt-4">
          <nav class="mb-4">
            <a href="/" class="text-decoration-none">← Back to Server Home</a>
          </nav>
          <h1 class="mb-4">${escape(title)}</h1>
          ${content}
        </div>
        <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/js/bootstrap.bundle.min.js"></script>
      </body>
      </html>
    `;
  }

  // Status and cleanup
  getStatus() {
    return {
      enabled: true,
      database: this.db ? 'Connected' : 'Disconnected',
      strategies: Object.keys(this.config.oauth || {}).filter(p => this.config.oauth[p])
    };
  }

  async shutdown() {
    if (this.sessionStore) {
      this.sessionStore.close();
    }
    if (this.db) {
      await new Promise((resolve) => {
        this.db.close((err) => {
          if (err) {
            this.log.error('Error closing database:', err);
          } else {
            this.log.info('Database connection closed');
          }
          resolve();
        });
      });
    }
  }
}

module.exports = TokenModule;