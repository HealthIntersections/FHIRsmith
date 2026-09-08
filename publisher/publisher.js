const express = require('express');
const path = require('path');
const fs = require('fs');
const validation = require('./validation');
const Database = require('sqlite3').Database;
const bcrypt = require('bcrypt');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const folders = require('../library/folder-setup');
const escape = require('escape-html');
const {Utilities} = require("../library/utilities");

// GitHub refuses any file larger than this at the pre-receive hook, and the rejection takes down
// the whole push rather than just the offending file.
const GITHUB_MAX_FILE_SIZE = 100 * 1024 * 1024;


class PublisherModule {
  constructor(stats) {
    this.router = express.Router();
    this.db = null;
    this.config = null;
    this.logger = null;
    this.taskProcessor = null;
    this.isProcessing = false;
    this.activeTaskIds = new Set();
    this.shutdownRequested = false;
    this.stats = stats;
  }

  async initialize(config) {
    this.config = config;
    this.logger = require('../library/logger').getInstance().child({ module: 'publisher' });

    // Initialize database first
    await this.initializeDatabase();

    // Set up session middleware - use in-memory sessions or separate session db
    if (!this.config.sessionSecret) {
      // Never fall back to a constant. This project is open source, so a fixed default
      // secret is a published signing key: anyone could mint themselves an admin session
      // on any deployment that forgot the setting, and nothing about the server would
      // look wrong. A random secret fails safe instead - sessions simply do not survive
      // a restart, which is visible and harmless. token.js does the same.
      this.logger.warn('publisher: no sessionSecret configured - using a random one, so ' +
        'logins will not survive a restart. Set modules.publisher.sessionSecret.');
    }
    this.router.use(session({
      secret: this.config.sessionSecret || crypto.randomBytes(64).toString('hex'),
      resave: false,
      saveUninitialized: false,
      cookie: {
        // Secure by default: the cookie is then only ever sent over HTTPS. Express is
        // configured to trust the proxy, so this works behind an NGINX TLS terminator
        // reporting X-Forwarded-Proto. Set cookieSecure false to run the publisher over
        // plain HTTP - without it the browser will not send the cookie back and login
        // appears to succeed and then silently do nothing.
        secure: this.config.cookieSecure ?? true,
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
      }
      // Not using SQLiteStore to avoid the database conflict
    }));

    // Parse form data
    this.router.use(express.urlencoded({ extended: true }));

    // Set up routes
    this.setupRoutes();

    // Start background task processor
    this.startTaskProcessor();

    this.logger.info('Publisher module initialized');
  }

  async initializeDatabase() {
    // Ensure database directory exists
    const dbPath = path.isAbsolute(this.config.database)
        ? this.config.database
        : folders.filePath('publisher', this.config.database);
    const dbDir = path.dirname(dbPath);
    const fs = require('fs');
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
      this.logger.info('Created database directory: ' + dbDir);
    }

    return new Promise((resolve, reject) => {
      this.db = new Database(dbPath, (err) => {
        if (err) {
          this.logger.error('Failed to connect to database:', err);
          reject(err);
          return;
        }

        this.logger.info('Connected to SQLite database: ' + dbPath);
        this.createTables().then(resolve).catch(reject);
      });
    });
  }

  async createTables() {
    const tables = [
      // Users table
      `CREATE TABLE IF NOT EXISTS users (
                                          id INTEGER PRIMARY KEY AUTOINCREMENT,
                                          name TEXT NOT NULL,
                                          login TEXT UNIQUE NOT NULL,
                                          password_hash TEXT NOT NULL,
                                          is_admin BOOLEAN DEFAULT 0,
                                          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
       )`,

      // Websites table
      `CREATE TABLE IF NOT EXISTS websites (
                                             id INTEGER PRIMARY KEY AUTOINCREMENT,
                                             name TEXT NOT NULL,
                                             local_folder TEXT NOT NULL,
                                             history_templates TEXT NOT NULL,
                                             web_templates TEXT NOT NULL,
                                             server_update_script TEXT NOT NULL,
                                             is_active BOOLEAN DEFAULT 1,
                                             created_at DATETIME DEFAULT CURRENT_TIMESTAMP
       )`,

      // User website permissions
      `CREATE TABLE IF NOT EXISTS user_website_permissions (
                                                             user_id INTEGER,
                                                             website_id INTEGER,
                                                             can_queue BOOLEAN DEFAULT 0,
                                                             can_approve BOOLEAN DEFAULT 0,
                                                             PRIMARY KEY (user_id, website_id),
        FOREIGN KEY (user_id) REFERENCES users (id),
        FOREIGN KEY (website_id) REFERENCES websites (id)
        )`,

      // Tasks table
      `CREATE TABLE IF NOT EXISTS tasks (
                                          id INTEGER PRIMARY KEY AUTOINCREMENT,
                                          user_id INTEGER NOT NULL,
                                          website_id INTEGER NOT NULL,
                                          status TEXT DEFAULT 'queued',
                                          github_org TEXT NOT NULL,
                                          github_repo TEXT NOT NULL,
                                          git_branch TEXT NOT NULL,
                                          npm_package_id TEXT NOT NULL,
                                          version TEXT NOT NULL,
                                          local_folder TEXT,
                                          build_output_path TEXT,
                                          failure_reason TEXT,
                                          announcement TEXT,
                                          approved_by INTEGER,
                                          queued_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                                          building_at DATETIME,
                                          waiting_approval_at DATETIME,
                                          publishing_at DATETIME,
                                          completed_at DATETIME,
                                          failed_at DATETIME,
                                          FOREIGN KEY (user_id) REFERENCES users (id),
        FOREIGN KEY (website_id) REFERENCES websites (id),
        FOREIGN KEY (approved_by) REFERENCES users (id)
        )`,

      // Task logs
      `CREATE TABLE IF NOT EXISTS task_logs (
                                              id INTEGER PRIMARY KEY AUTOINCREMENT,
                                              task_id TEXT NOT NULL,
                                              timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                                              level TEXT NOT NULL,
                                              message TEXT NOT NULL,
                                              FOREIGN KEY (task_id) REFERENCES tasks (id)
        )`,

      // User actions audit
      `CREATE TABLE IF NOT EXISTS user_actions (
                                                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                                                 user_id INTEGER,
                                                 action TEXT NOT NULL,
                                                 target_id TEXT,
                                                 timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                                                 ip_address TEXT,
                                                 FOREIGN KEY (user_id) REFERENCES users (id)
        )`
    ];

    for (const sql of tables) {
      await new Promise((resolve, reject) => {
        this.db.run(sql, (err) => {
          if (err) {
            this.logger.error('Failed to create table:', err);
            reject(err);
          } else {
            resolve();
          }
        });
      });
    }

    // Create default admin user if none exists
    await this.createDefaultAdmin();

    // Schema migrations for existing databases
    await this.runMigrations();
  }

  async runMigrations() {
    // Add announcement column if it doesn't exist (added after initial schema)
    const columns = await new Promise((resolve, reject) => {
      this.db.all("PRAGMA table_info(tasks)", (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
    const columnNames = columns.map(c => c.name);
    if (!columnNames.includes('announcement')) {
      await new Promise((resolve, reject) => {
        this.db.run('ALTER TABLE tasks ADD COLUMN announcement TEXT', (err) => {
          if (err) reject(err);
          else {
            this.logger.info('Migration: added announcement column to tasks table');
            resolve();
          }
        });
      });
    }
    if (!columnNames.includes('publisher_version')) {
      await new Promise((resolve, reject) => {
        this.db.run('ALTER TABLE tasks ADD COLUMN publisher_version TEXT', (err) => {
          if (err) reject(err);
          else {
            this.logger.info('Migration: added publisher_version column to tasks table');
            resolve();
          }
        });
      });
    }
    const websiteColumns = await new Promise((resolve, reject) => {
      this.db.all("PRAGMA table_info(websites)", (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
    const websiteColumnNames = websiteColumns.map(c => c.name);
    if (!websiteColumnNames.includes('git_root')) {
      await new Promise((resolve, reject) => {
        this.db.run('ALTER TABLE websites ADD COLUMN git_root TEXT', (err) => {
          if (err) reject(err);
          else {
            this.logger.info('Migration: added git_root column to websites table');
            resolve();
          }
        });
      });
    }
  }

  async createDefaultAdmin() {
    return new Promise((resolve, reject) => {
      this.db.get('SELECT COUNT(*) as count FROM users WHERE is_admin = 1', (err, row) => {
        if (err) {
          reject(err);
          return;
        }

        if (row.count === 0) {
          const defaultPassword = 'admin123'; // Change this!
          bcrypt.hash(defaultPassword, 10, (err, hash) => {
            if (err) {
              reject(err);
              return;
            }

            this.db.run(
                'INSERT INTO users (name, login, password_hash, is_admin) VALUES (?, ?, ?, ?)',
                ['Administrator', 'admin', hash, 1],
                (err) => {
                  if (err) {
                    this.logger.error('Failed to create default admin:', err);
                    reject(err);
                  } else {
                    this.logger.warn('Created default admin user - login: admin, password: admin123 - CHANGE THIS!');
                    resolve();
                  }
                }
            );
          });
        } else {
          resolve();
        }
      });
    });
  }

  setupRoutes() {
    // Main dashboard
    this.router.get('/', this.renderDashboard.bind(this));

    // Authentication. The login post is rate limited: besides slowing down guessing, it
    // is the one unauthenticated route that runs bcrypt, and bcrypt.compare holds a libuv
    // threadpool thread (4 by default) for ~100ms - so without a limit a handful of
    // concurrent attempts stall every file operation the server wants to do.
    const loginLimiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: this.config.loginAttemptsPerWindow ?? 20,
      message: 'Too many login attempts, please try again later.',
      standardHeaders: true,
      legacyHeaders: false
    });

    this.router.get('/login', this.renderLogin.bind(this));
    this.router.post('/login', loginLimiter, this.handleLogin.bind(this));
    this.router.post('/logout', this.handleLogout.bind(this));

    // Tasks
    this.router.get('/tasks', this.renderTasks.bind(this));
    this.router.post('/tasks', this.requireAuth.bind(this), this.createTask.bind(this));
    this.router.post('/tasks/:id/approve', this.requireAuth.bind(this), this.approveTask.bind(this));
    this.router.post('/tasks/:id/delete', this.requireAuth.bind(this), this.deleteTask.bind(this));
    this.router.post('/tasks/:id/retry', this.requireAuth.bind(this), this.retryTask.bind(this));
    this.router.get('/tasks/:id/output', this.getTaskOutput.bind(this));
    this.router.get('/tasks/:id/history', this.getTaskHistory.bind(this));
    this.router.get('/tasks/:id/qa', this.getTaskQA.bind(this));
    this.router.use('/tasks/:id/qa-files', (req, res, next) => {
      const taskId = req.params.id;
      this.getTask(taskId).then(task => {
        if (!task || !task.local_folder) {
          return res.status(404).send('Not found');
        }
        const outputDir = path.join(task.local_folder, 'draft', 'output');
        express.static(outputDir)(req, res, next);
      }).catch(() => res.status(500).send('Error'));
    });

    // Admin routes
    this.router.get('/admin/websites', this.requireAdmin.bind(this), this.renderWebsites.bind(this));
    this.router.post('/admin/websites', this.requireAdmin.bind(this), this.createWebsite.bind(this));
    this.router.get('/admin/websites/:id/edit', this.requireAdmin.bind(this), this.renderEditWebsite.bind(this));
    this.router.post('/admin/websites/:id/edit', this.requireAdmin.bind(this), this.updateWebsite.bind(this));
    this.router.get('/admin/users', this.requireAdmin.bind(this), this.renderUsers.bind(this));
    this.router.post('/admin/users', this.requireAdmin.bind(this), this.createUser.bind(this));
    this.router.post('/admin/permissions', this.requireAdmin.bind(this), this.updatePermissions.bind(this));
  }

  // Background Task Processing
  startTaskProcessor() {
    const pollInterval = this.config.pollInterval || 5000;

    this.logger.info('Starting task processor with ' + pollInterval + 'ms poll interval');
    this.isProcessingStarted = null;

    this.stats.addTask('Publisher', Utilities.formatDuration(pollInterval));  // or however you want to display the frequency

    this.taskProcessor = setInterval(async () => {
      if (this.shutdownRequested) return;

      if (this.isProcessing) {
        // A publication can legitimately run for longer than an hour (go-publish on a
        // large IG), so never reset isProcessing while a task is in flight — doing so
        // lets the poller start a second, concurrent run of the same task, which then
        // fails on 'ig-registry already exists' and stomps the real run's status.
        // Recovery from a genuinely hung IG Publisher is handled by the
        // igPublisherTimeoutMinutes kill in runIgPublisher/runPublisherGoPublish.
        const stuckMs = this.isProcessingStarted ? Date.now() - this.isProcessingStarted : 0;
        const warnAfterMs = ((this.config.igPublisherTimeoutMinutes || 60) + 30) * 60 * 1000;
        if (stuckMs > warnAfterMs) {
          this.logger.warn('Task processor still busy after ' + Math.round(stuckMs / 60000) + ' min (tasks: ' +
            Array.from(this.activeTaskIds).join(', ') + ') — possible hang, not starting new work');
        }
        return;
      }

      await this.processNextTask();
    }, pollInterval);
  }

  async processNextTask() {
    this.isProcessing = true;
    this.isProcessingStarted = Date.now();

    let claimedTaskId = null;
    try {
      // Look for queued tasks first (draft builds)
      let task = await this.getNextQueuedTask();
      if (task) {
        if (this.activeTaskIds.has(task.id)) return; // already being processed
        claimedTaskId = task.id;
        this.activeTaskIds.add(task.id);
        this.stats.task('Publisher', 'Building ' + task.npm_package_id + '#' + task.version);
        await this.processDraftBuild(task);
        this.stats.taskDone('Publisher', 'Built ' + task.npm_package_id + '#' + task.version);
        return;
      }

      // Then look for approved tasks (publishing)
      task = await this.getNextApprovedTask();
      if (task) {
        if (this.activeTaskIds.has(task.id)) return; // already being processed
        claimedTaskId = task.id;
        this.activeTaskIds.add(task.id);
        this.stats.task('Publisher', 'Publishing ' + task.npm_package_id + '#' + task.version);
        await this.processPublication(task);
        this.stats.taskDone('Publisher', 'Published ' + task.npm_package_id + '#' + task.version);
        return;
      }

      // No tasks to process
    } catch (error) {
      this.logger.error('Error in task processor:', error);
      this.stats.taskError('Publisher', 'Error: ' + error.message);
    } finally {
      if (claimedTaskId !== null) {
        this.activeTaskIds.delete(claimedTaskId);
      }
      this.isProcessing = false;
    }
  }

  async getNextQueuedTask() {
    return new Promise((resolve, reject) => {
      this.db.get(
          'SELECT * FROM tasks WHERE status = ? ORDER BY queued_at ASC LIMIT 1',
          ['queued'],
          (err, row) => {
            if (err) reject(err);
            else resolve(row);
          }
      );
    });
  }

  async getNextApprovedTask() {
    return new Promise((resolve, reject) => {
      this.db.get(
          'SELECT * FROM tasks WHERE status = ? ORDER BY publishing_at ASC LIMIT 1',
          ['publishing'],
          (err, row) => {
            if (err) reject(err);
            else resolve(row);
          }
      );
    });
  }

  async updateTaskStatus(taskId, status, additionalFields = {}) {
    const fields = ['status = ?'];
    const values = [status];

    // Add timestamp field based on status
    if (status === 'building') {
      fields.push('building_at = CURRENT_TIMESTAMP');
    } else if (status === 'waiting for approval') {
      fields.push('waiting_approval_at = CURRENT_TIMESTAMP');
    } else if (status === 'complete') {
      fields.push('completed_at = CURRENT_TIMESTAMP');
      // A successful completion invalidates any earlier failure (e.g. from a
      // superseded duplicate run) — don't let a stale message outlive success.
      fields.push('failure_reason = NULL');
    } else if (status === 'failed') {
      fields.push('failed_at = CURRENT_TIMESTAMP');
    }

    // Add any additional fields
    Object.keys(additionalFields).forEach(key => {
      fields.push(key + ' = ?');
      values.push(additionalFields[key]);
    });

    values.push(taskId);

    return new Promise((resolve, reject) => {
      this.db.run(
          'UPDATE tasks SET ' + fields.join(', ') + ' WHERE id = ?',
          values,
          (err) => {
            if (err) reject(err);
            else resolve();
          }
      );
    });
  }

  // Update arbitrary task fields WITHOUT touching status. Use this from long-running
  // work (e.g. saving the announcement mid-publication) — writing back the in-memory
  // task.status can resurrect a stale status and cause the poller to re-run the task.
  async updateTaskFields(taskId, fields) {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    const assignments = keys.map(key => key + ' = ?');
    const values = keys.map(key => fields[key]);
    values.push(taskId);

    return new Promise((resolve, reject) => {
      this.db.run(
          'UPDATE tasks SET ' + assignments.join(', ') + ' WHERE id = ?',
          values,
          (err) => {
            if (err) reject(err);
            else resolve();
          }
      );
    });
  }

  async logTaskMessage(taskId, level, message) {
    return new Promise((resolve) => {
      this.db.run(
          'INSERT INTO task_logs (task_id, level, message) VALUES (?, ?, ?)',
          [taskId.toString(), level, message],
          () => resolve() // Don't fail if logging fails
      );
    });
  }

  async processDraftBuild(task) {
    this.logger.info('Processing draft build for task #' + task.id + ' (' + task.npm_package_id + '#' + task.version + ')');

    try {
      // Update status to building
      await this.updateTaskStatus(task.id, 'building');
      await this.logTaskMessage(task.id, 'info', 'Started draft build');

      // Run actual build process
      await this.runDraftBuild(task);

      // Update status to waiting for approval
      await this.updateTaskStatus(task.id, 'waiting for approval');
      await this.logTaskMessage(task.id, 'info', 'Draft build completed - waiting for approval');

      this.logger.info('Draft build completed for task #' + task.id);

    } catch (error) {
      this.logger.error('Draft build failed for task #' + task.id + ':', error);
      await this.updateTaskStatus(task.id, 'failed', {
        failure_reason: error.message
      });
      await this.logTaskMessage(task.id, 'error', 'Draft build failed: ' + error.message);
    }
  }

  async processPublication(task) {
    this.logger.info('Processing publication for task #' + task.id + ' (' + task.npm_package_id + '#' + task.version + ')');

    try {
      await this.logTaskMessage(task.id, 'info', 'Started publication process');

      await this.runPublication(task);

      // Update status to complete
      await this.updateTaskStatus(task.id, 'complete');
      await this.logTaskMessage(task.id, 'info', 'Publication completed successfully');

      this.logger.info('Publication completed for task #' + task.id);

    } catch (error) {
      this.logger.error('Publication failed for task #' + task.id + ':', error);
      await this.updateTaskStatus(task.id, 'failed', {
        failure_reason: error.message
      });
      await this.logTaskMessage(task.id, 'error', 'Publication failed: ' + error.message);
    }
  }

  async runDraftBuild(task) {
    const workspaceRoot = path.isAbsolute(this.config.workspaceRoot)
        ? this.config.workspaceRoot
        : folders.filePath('publisher', this.config.workspaceRoot);

    const taskDir = path.join(workspaceRoot, 'task-' + task.id);
    const draftDir = path.join(taskDir, 'draft');
    const logFile = path.join(taskDir, 'draft-build.log');

    await this.logTaskMessage(task.id, 'info', 'Creating task directory: ' + taskDir);

    // Step 1: Create/scrub task directory
    await this.createTaskDirectory(taskDir);

    // Record the log file path and local folder immediately so they're accessible
    // even if the build fails later
    await this.updateTaskStatus(task.id, 'building', {
      build_output_path: logFile,
      local_folder: taskDir
    });

    // Step 2: Download latest publisher
    const publisherJar = await this.downloadPublisher(taskDir, task.id);

    // Step 3: Clone GitHub repository
    await this.cloneRepository(task, draftDir);

    // Step 3b: Update SUSHI to the latest release. The IG Publisher runs SUSHI with
    // --require-latest, so a SUSHI that has fallen behind npm's latest makes the build
    // fail. Refreshing it here keeps draft builds working.
    await this.ensureLatestSushi(task.id);

    // Step 4: Run IG publisher
    await this.runIGPublisher(publisherJar, draftDir, logFile, task.id);

    // Step 5: Verify package-id and version match the task
    await this.verifyBuildOutput(task, draftDir);

    this.logger.info('Draft build completed for ' + task.npm_package_id + '#' + task.version);
  }

  async createTaskDirectory(taskDir) {
    // Remove existing directory if it exists
    if (fs.existsSync(taskDir)) {
      await require('fs').promises.rm(taskDir, { recursive: true, force: true });
    }

    // Create fresh directory
    fs.mkdirSync(taskDir, { recursive: true });
  }

  async downloadPublisher(taskDir, taskId) {
    const axios = require('axios');
    const publisherJar = path.join(taskDir, 'publisher.jar');

    await this.logTaskMessage(taskId, 'info', 'Downloading latest FHIR IG Publisher...');

    try {
      // Get latest release info from GitHub API
      const releaseResponse = await axios.get('https://api.github.com/repos/HL7/fhir-ig-publisher/releases/latest');
      const downloadUrl = releaseResponse.data.assets.find(asset =>
          asset.name === 'publisher.jar'
      )?.browser_download_url;

      if (!downloadUrl) {
        throw new Error('Could not find publisher.jar in latest release');
      }

      // Record which IG Publisher version this task is using. The same jar is reused
      // for the publication run, so this is the version that produced the output.
      const publisherVersion = releaseResponse.data.tag_name || releaseResponse.data.name || 'unknown';
      try {
        await this.updateTaskFields(taskId, { publisher_version: publisherVersion });
      } catch (e) {
        this.logger.warn('Failed to record publisher_version for task ' + taskId + ': ' + e.message);
      }
      await this.logTaskMessage(taskId, 'info', 'Using IG Publisher version ' + publisherVersion);

      await this.logTaskMessage(taskId, 'info', 'Downloading from: ' + downloadUrl);

      // Download the file
      const response = await axios({
        method: 'GET',
        url: downloadUrl,
        responseType: 'stream'
      });

      const writer = fs.createWriteStream(publisherJar);
      response.data.pipe(writer);

      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });

      await this.logTaskMessage(taskId, 'info', 'Publisher downloaded successfully');
      return publisherJar;

    } catch (error) {
      throw new Error('Failed to download publisher: ' + error.message);
    }
  }

  // Directory holding FHIRsmith's own copy of SUSHI. Installing here (rather than -g)
  // needs no root: on the server the global npm prefix (/usr) is root-owned.
  sushiDir() {
    return folders.filePath('publisher', 'sushi');
  }

  // Environment for spawning the IG Publisher so it finds our managed SUSHI on PATH.
  // The publisher resolves the `sushi` command from PATH, so prepending our bin dir
  // makes it use the version we just installed.
  publisherEnv() {
    const binDir = path.join(this.sushiDir(), 'bin');
    return Object.assign({}, process.env, {
      PATH: binDir + path.delimiter + (process.env.PATH || '')
    });
  }

  // Update FHIRsmith's managed SUSHI to the latest npm release before a run. The IG
  // Publisher invokes SUSHI with --require-latest, so a SUSHI that has fallen behind
  // npm's latest makes the build abort. We install into a FHIRsmith-owned prefix
  // (sushiDir) to avoid needing root for a global install, and the publisher picks it
  // up via publisherEnv(). Best-effort: a failure is logged but not fatal - the
  // corrected runBuild check in the IG Publisher now turns a stale SUSHI into a loud
  // publication failure rather than a silently-published draft.
  async ensureLatestSushi(taskId) {
    const { spawn } = require('child_process');
    const dir = this.sushiDir();
    fs.mkdirSync(dir, { recursive: true });
    await this.logTaskMessage(taskId, 'info', 'Ensuring SUSHI is up to date in ' + dir + ' ...');
    await new Promise((resolve) => {
      // -g with --prefix makes npm treat `dir` as the global prefix, so the binary
      // lands at dir/bin/sushi (a FHIRsmith-owned, writable location).
      const npm = spawn('npm', ['install', '-g', 'fsh-sushi@latest', '--prefix', dir], { stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      npm.stdout.on('data', () => { /* ignore */ });
      npm.stderr.on('data', (d) => { err += d.toString(); });
      npm.on('error', async (e) => {
        await this.logTaskMessage(taskId, 'warn', 'Could not run npm to update SUSHI: ' + e.message);
        resolve();
      });
      npm.on('close', async (code) => {
        if (code === 0) {
          let version = '';
          try {
            version = require('child_process').execSync('sushi --version', { env: this.publisherEnv(), encoding: 'utf8' }).trim();
          } catch (e) {
            version = '(version check failed)';
          }
          await this.logTaskMessage(taskId, 'info', 'SUSHI is up to date: ' + version);
        } else {
          await this.logTaskMessage(taskId, 'warn', 'SUSHI update exited with code ' + code + (err ? ': ' + err.trim().slice(-400) : ''));
        }
        resolve();
      });
    });
  }

  async cloneRepository(task, draftDir) {
    const { spawn } = require('child_process');
    const gitUrl = 'https://github.com/' + task.github_org + '/' + task.github_repo + '.git';

    await this.logTaskMessage(task.id, 'info', 'Cloning repository: ' + gitUrl + ' (branch: ' + task.git_branch + ')');

    return new Promise((resolve, reject) => {
      const git = spawn('git', [
        'clone',
        '--branch', task.git_branch,
        '--single-branch',
        gitUrl,
        draftDir
      ], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stderr = '';

      git.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      git.on('close', async (code) => {
        if (code === 0) {
          await this.logTaskMessage(task.id, 'info', 'Repository cloned successfully');
          resolve();
        } else {
          const error = 'Git clone failed with code ' + code + ': ' + stderr;
          await this.logTaskMessage(task.id, 'error', error);
          reject(new Error(error));
        }
      });

      git.on('error', async (error) => {
        await this.logTaskMessage(task.id, 'error', 'Git clone error: ' + error.message);
        reject(error);
      });
    });
  }

  async runIGPublisher(publisherJar, draftDir, logFile, taskId) {
    const { spawn } = require('child_process');

    await this.logTaskMessage(taskId, 'info', 'Running FHIR IG Publisher...');

    return new Promise((resolve, reject) => {
      const java = spawn('java', [
        '-jar',
        '-Xmx20000m',
        publisherJar,
        '-ig',
        '.'
      ], {
        cwd: draftDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: this.publisherEnv()
      });

      // Create log file stream
      const logStream = fs.createWriteStream(logFile);

      const buildStart = Date.now();
      let lastDataAt = Date.now();

      java.stdout.on('data', (data) => {
        lastDataAt = Date.now();
        logStream.write(data);
      });

      java.stderr.on('data', (data) => {
        lastDataAt = Date.now();
        logStream.write(data);
      });

      // Heartbeat: emit a status line every 60s regardless of stdout activity,
      // so silent phases of the Publisher (e.g. "Validating Resources") still
      // surface a signal-of-life in the task log.
      const heartbeat = setInterval(async () => {
        const elapsedMs = Date.now() - buildStart;
        const sinceDataMs = Date.now() - lastDataAt;
        let logKb = 0;
        try { logKb = Math.round(fs.statSync(logFile).size / 1024); } catch (_) { /* log file not created yet */ }
        const elapsedMin = Math.floor(elapsedMs / 60000);
        const elapsedSec = Math.floor(elapsedMs / 1000) % 60;
        const idleSec = Math.floor(sinceDataMs / 1000);
        await this.logTaskMessage(
          taskId,
          'info',
          'IG Publisher heartbeat: elapsed ' + elapsedMin + 'm' + elapsedSec + 's, ' +
          'log ' + logKb + ' KB, last output ' + idleSec + 's ago'
        );
      }, 60 * 1000);

      java.on('close', async (code) => {
        logStream.end();

        if (code === 0) {
          await this.logTaskMessage(taskId, 'info', 'IG Publisher completed successfully');
          resolve();
        } else {
          const error = 'IG Publisher failed with exit code: ' + code;
          await this.logTaskMessage(taskId, 'error', error);
          reject(new Error(error));
        }
      });

      java.on('error', async (error) => {
        logStream.end();
        await this.logTaskMessage(taskId, 'error', 'IG Publisher error: ' + error.message);
        reject(error);
      });

      // Timeout configurable via publisher.igPublisherTimeoutMinutes (default: 60 minutes)
      const timeoutMinutes = this.config.igPublisherTimeoutMinutes || 60;
      const timeout = setTimeout(async () => {
        java.kill();
        logStream.end();
        await this.logTaskMessage(taskId, 'error', 'IG Publisher timed out after ' + timeoutMinutes + ' minutes');
        reject(new Error('IG Publisher timed out'));
      }, timeoutMinutes * 60 * 1000);

      java.on('close', () => {
        clearTimeout(timeout);
        clearInterval(heartbeat);
      });
    });
  }

  async verifyBuildOutput(task, draftDir) {
    const qaJsonPath = path.join(draftDir, 'output', 'qa.json');

    await this.logTaskMessage(task.id, 'info', 'Verifying build output against task parameters...');

    if (!fs.existsSync(qaJsonPath)) {
      throw new Error('Build verification failed: qa.json not found in output directory');
    }

    const qaData = JSON.parse(fs.readFileSync(qaJsonPath, 'utf8'));

    const errors = [];
    if (qaData['package-id'] !== task.npm_package_id) {
      errors.push('Package ID mismatch: task specifies "' + task.npm_package_id + '" but build produced "' + qaData['package-id'] + '"');
    }
    if (qaData['ig-ver'] !== task.version) {
      errors.push('Version mismatch: task specifies "' + task.version + '" but build produced "' + qaData['ig-ver'] + '"');
    }

    if (errors.length > 0) {
      for (const err of errors) {
        await this.logTaskMessage(task.id, 'error', err);
      }
      throw new Error('Build verification failed: ' + errors.join('; '));
    }

    await this.logTaskMessage(task.id, 'info', 'Build output verified: package-id=' + qaData['package-id'] + ', version=' + qaData['ig-ver']);
  }

  // Read package/package.json out of a .tgz without unpacking the whole archive.
  inspectPackageTgz(tgzPath) {
    const { spawn } = require('child_process');
    return new Promise((resolve, reject) => {
      const tar = spawn('tar', ['-xzOf', tgzPath, 'package/package.json']);
      let out = '';
      let err = '';
      tar.stdout.on('data', (d) => { out += d.toString(); });
      tar.stderr.on('data', (d) => { err += d.toString(); });
      tar.on('error', reject);
      tar.on('close', (code) => {
        if (code !== 0) {
          reject(new Error('Could not read ' + tgzPath + ': ' + (err.trim() || ('tar exit ' + code))));
        } else {
          try {
            resolve(JSON.parse(out));
          } catch (e) {
            reject(new Error('Invalid package.json in ' + tgzPath + ': ' + e.message));
          }
        }
      });
    });
  }

  // Confirm the package.tgz files that landed in the web tree are publication builds,
  // not the draft. Throws (failing the task) if a draft package was published.
  async verifyPublishedPackage(task, website, draftDir) {
    await this.logTaskMessage(task.id, 'info', 'Verifying published package(s) are publication builds...');

    // The intended publication path comes from the IG's publication-request.json.
    const prPath = path.join(draftDir, 'publication-request.json');
    if (!fs.existsSync(prPath)) {
      await this.logTaskMessage(task.id, 'warn', 'No publication-request.json found at ' + prPath + ' - skipping published-package check');
      return;
    }
    const pr = JSON.parse(fs.readFileSync(prPath, 'utf8'));
    const pubPath = pr.path;

    // The website base url lets us map a canonical url to a folder in the web tree.
    const setupPath = path.join(website.local_folder, 'publish-setup.json');
    if (!pubPath || !fs.existsSync(setupPath)) {
      await this.logTaskMessage(task.id, 'warn', 'Cannot resolve web path (path or publish-setup.json missing) - skipping published-package check');
      return;
    }
    const setup = JSON.parse(fs.readFileSync(setupPath, 'utf8'));
    const baseUrl = setup.website && setup.website.url;
    if (!baseUrl || !pubPath.startsWith(baseUrl)) {
      await this.logTaskMessage(task.id, 'warn', 'Publication path ' + pubPath + ' is not under website url ' + baseUrl + ' - skipping published-package check');
      return;
    }

    const relVer = pubPath.substring(baseUrl.length).replace(/^\/+/, '');
    const relCur = relVer.replace(/\/[^/]+\/?$/, ''); // strip the version segment for the "current" copy
    const candidates = [
      path.join(website.local_folder, relVer, 'package.tgz'),
      path.join(website.local_folder, relCur, 'package.tgz')
    ];

    let checked = 0;
    for (const pkgPath of candidates) {
      if (!fs.existsSync(pkgPath)) {
        continue;
      }
      checked++;
      const json = await this.inspectPackageTgz(pkgPath);
      const problems = [];
      if (json.notForPublication) {
        problems.push('notForPublication is set');
      }
      if (typeof json.url === 'string' && json.url.startsWith('file:')) {
        problems.push('url is a local file path (' + json.url + ')');
      }
      if (problems.length > 0) {
        throw new Error('Published package ' + pkgPath + ' is a draft build, not a publication build (' +
            problems.join('; ') + '). The IG Publisher publication run likely skipped package ' +
            'regeneration (e.g. a Jekyll/template failure). Not committing.');
      }
      await this.logTaskMessage(task.id, 'info', 'Verified publication package: ' + pkgPath);
    }

    if (checked === 0) {
      await this.logTaskMessage(task.id, 'warn', 'No published package.tgz found to verify under ' + relVer + ' or ' + relCur);
    }
  }

  // The IG Publisher can leave a file in the web folder that GitHub will not accept - typically a
  // technical correction archive, which is a zip of an entire published version folder and so
  // carries that folder's own full-ig.zip inside it. GitHub rejects the entire push over one such
  // file, at the very last step of a publication run. The IG Publisher will keep these out of the
  // web folder itself from the next release; until then, move them aside here.
  //
  // Does nothing unless publisher.large-file-archive says where to put them, and the website is
  // one that's hosted on GitHub in the first place.
  async archiveLargeFiles(task, website) {
    const configured = this.config['large-file-archive'];
    if (!configured || !this.isGitHubHosted(website)) {
      return;
    }
    const root = website.git_root || website.local_folder;
    const oversized = this.findLargeFiles(root, GITHUB_MAX_FILE_SIZE);
    if (oversized.length === 0) {
      return;
    }

    const archiveDir = path.isAbsolute(configured)
        ? configured
        : folders.filePath('publisher', configured);
    if (!fs.existsSync(archiveDir)) {
      fs.mkdirSync(archiveDir, { recursive: true });
    }

    for (const file of oversized) {
      const sizeMB = Math.round(fs.statSync(file).size / (1024 * 1024));
      const dest = this.nonClashingPath(archiveDir, path.basename(file));
      this.moveFile(file, dest);
      await this.logTaskMessage(task.id, 'warn', 'Large file ' + path.relative(root, file) + ' (' + sizeMB +
          ' MB) is over the 100 MB GitHub limit - moved to ' + dest + ' instead of being published');
    }
  }

  // Only a website kept in a GitHub repository has a 100MB problem - others can carry files of any
  // size. $.website.github in the web root's publish-setup.json says which is which; if that can't
  // be read, or doesn't say, assume not and leave the files where they are.
  isGitHubHosted(website) {
    if (!website.local_folder) {
      return false;
    }
    const setupPath = path.join(website.local_folder, 'publish-setup.json');
    try {
      const setup = JSON.parse(fs.readFileSync(setupPath, 'utf8'));
      return !!(setup.website && setup.website.github === true);
    } catch (err) {
      this.logger.warn('Could not read ' + setupPath + ' to check whether the website is on GitHub: ' + err.message);
      return false;
    }
  }

  // Files in the web folder that are too big to push. Never descends into .git: a pack file over the
  // limit is perfectly normal there, and moving it would destroy the repository. Files git is already
  // ignoring are left alone, since they were never going to be pushed anyway.
  findLargeFiles(root, limit) {
    const found = [];
    const walk = (dir) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (err) {
        this.logger.warn('Large file scan could not read ' + dir + ': ' + err.message);
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '.git') {
            walk(full);
          }
        } else if (entry.isFile()) {
          try {
            if (fs.statSync(full).size > limit) {
              found.push(full);
            }
          } catch (err) {
            // the file went away between readdir and stat - nothing left to move
          }
        }
      }
    };
    walk(root);
    return found.length === 0 ? found : this.removeGitIgnored(root, found);
  }

  removeGitIgnored(root, files) {
    try {
      const result = require('child_process').spawnSync('git', ['check-ignore', '--stdin'],
          { cwd: root, input: files.join('\n'), encoding: 'utf8' });
      // exit 0: at least one path is ignored. 1: none are. anything else: git could not tell us,
      // in which case treat everything as pushable rather than leaving a file that breaks the push.
      if (result.status !== 0 || !result.stdout) {
        return files;
      }
      const ignored = new Set(result.stdout.split('\n').map((s) => s.trim()).filter((s) => s));
      return files.filter((f) => !ignored.has(f));
    } catch (err) {
      this.logger.warn('Could not check the gitignore status of large files: ' + err.message);
      return files;
    }
  }

  nonClashingPath(dir, name) {
    let candidate = path.join(dir, name);
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
    const ext = path.extname(name);
    const stem = path.basename(name, ext);
    let i = 2;
    do {
      candidate = path.join(dir, stem + '-' + i + ext);
      i++;
    } while (fs.existsSync(candidate));
    return candidate;
  }

  // rename() fails across filesystems, and the archive folder will not always be on the same one
  moveFile(src, dest) {
    try {
      fs.renameSync(src, dest);
    } catch (err) {
      if (err.code !== 'EXDEV') {
        throw err;
      }
      fs.copyFileSync(src, dest);
      fs.unlinkSync(src);
    }
  }

  async runPublication(task) {
    const website = await this.getWebsite(task.website_id);
    if (!website) {
      throw new Error('Website not found for task');
    }

    if (!task.local_folder) {
      throw new Error('Task has no local folder - draft build may not have completed');
    }

    const taskDir = task.local_folder;
    const draftDir = path.join(taskDir, 'draft');
    const publishLogFile = path.join(taskDir, 'publication.log');

    // Ensure the zips directory exists
    const zipsDir = folders.filePath('publisher', 'zips');
    if (!fs.existsSync(zipsDir)) {
      fs.mkdirSync(zipsDir, { recursive: true });
    }

    // Step 1: Clone supporting repositories into the task directory
    const registryDir = path.join(taskDir, 'ig-registry');

    // The URL is configurable so that the credential arrangement can live in server config
    // rather than here. A deployment that pushes ig-registry with a repo-scoped deploy key
    // rather than an account key points this at an ssh_config Host alias carrying that key,
    // e.g. git@github-ig-registry:FHIR/ig-registry.git - the alias is the only way ssh can
    // tell this remote apart from the website remote, both being github.com.
    const igRegistryUrl = this.config['ig-registry-url'] || 'git@github.com:FHIR/ig-registry.git';

    await this.runCommand('git', ['clone', igRegistryUrl, registryDir],
        {}, task.id, 'Cloning ig-registry from ' + igRegistryUrl);

    // Use website-configured history templates path if provided, otherwise clone the default repo
    let historyDir;
    if (website.history_templates) {
      historyDir = website.history_templates;
      await this.logTaskMessage(task.id, 'info', 'Using configured history templates: ' + historyDir);
      if (!fs.existsSync(historyDir)) {
        throw new Error('Configured history_templates path does not exist: ' + historyDir);
      }
    } else {
      historyDir = path.join(taskDir, 'fhir-ig-history-template');
      await this.runCommand('git', ['clone', 'https://github.com/HL7/fhir-ig-history-template.git', historyDir],
          {}, task.id, 'Cloning fhir-ig-history-template');
    }

    // Use website-configured web templates path if provided, otherwise clone the default repo.
    // This allows pointing to a subdirectory of the templates repo for different target websites.
    let templatesDir;
    if (website.web_templates) {
      templatesDir = website.web_templates;
      await this.logTaskMessage(task.id, 'info', 'Using configured web templates: ' + templatesDir);
      if (!fs.existsSync(templatesDir)) {
        throw new Error('Configured web_templates path does not exist: ' + templatesDir);
      }
    } else {
      templatesDir = path.join(taskDir, 'fhir-web-templates');
      await this.runCommand('git', ['clone', 'https://github.com/HL7/fhir-web-templates.git', templatesDir],
          {}, task.id, 'Cloning fhir-web-templates');
    }

    // Step 2: Reuse the publisher.jar from the draft build
    const publisherJar = path.join(taskDir, 'publisher.jar');
    if (!fs.existsSync(publisherJar)) {
      throw new Error('publisher.jar not found in task directory - draft build may be corrupt');
    }

    // Step 3: Pull latest web folder before publishing into it
    await this.runCommand('git', ['pull'], { cwd: website.git_root }, task.id, 'Pulling latest web folder');

    // Step 3b: Update SUSHI to the latest release before the publication run. This is the
    // step that previously failed silently: the publication build runs SUSHI with
    // --require-latest, and a draft approved days earlier may now face a newer SUSHI on
    // npm. Refresh it so the publication build doesn't abort on a version mismatch.
    await this.ensureLatestSushi(task.id);

    // Step 4: Run the IG publisher in go-publish mode
    await this.runPublisherGoPublish(task.id, publisherJar, draftDir, website.local_folder,
        registryDir, historyDir, templatesDir, zipsDir, publishLogFile);

    // Step 5: Verify publication succeeded by checking for the log file
    const pubLogName = task.npm_package_id + '#' + task.version + '.log';
    const pubLogPath = path.join(zipsDir, pubLogName);
    if (!fs.existsSync(pubLogPath)) {
      throw new Error('Publication verification failed: ' + pubLogName + ' not found in zips directory');
    }
    await this.logTaskMessage(task.id, 'info', 'Publication run verified: ' + pubLogName + ' found');

    // Step 5b: Verify the published package is actually a publication build.
    // If the IG Publisher's publication run skipped package regeneration (e.g. a Jekyll
    // or template failure), the draft package - flagged notForPublication with a file://
    // url - can survive into the web tree. Catch that here, before anything is committed.
    await this.verifyPublishedPackage(task, website, draftDir);

    // Step 5c: Move anything too big for GitHub out of the web folder, before it gets staged
    await this.archiveLargeFiles(task, website);

    // Step 6: Commit and push the web folder
    await this.logTaskMessage(task.id, 'info', 'Committing changes to web folder...');
    const gitUrl = 'https://github.com/' + task.github_org + '/' + task.github_repo + '.git';
    const commitMsg = 'publish ' + task.npm_package_id + '#' + task.version + ' from ' + gitUrl + ' ' + task.git_branch;
    await this.runCommand('git', ['add', '.'], { cwd: website.git_root }, task.id, 'Staging web folder changes');
    await this.runCommand('git', ['commit', '-m', commitMsg], { cwd: website.git_root }, task.id, 'Committing web folder changes');
    await this.runCommand('git', ['push'], { cwd: website.git_root }, task.id, 'Pushing web folder changes');

    // Step 7: Commit and push the ig-registry
    await this.logTaskMessage(task.id, 'info', 'Committing changes to ig-registry...');
    const registryCommitMsg = 'publish ' + task.npm_package_id + '#' + task.version;
    await this.runCommand('git', ['commit', '-a', '-m', registryCommitMsg], { cwd: registryDir }, task.id, 'Committing ig-registry changes');
    await this.runCommand('git', ['pull'], { cwd: registryDir }, task.id, 'Pulling latest ig-registry');
    await this.runCommand('git', ['push'], { cwd: registryDir }, task.id, 'Pushing ig-registry changes');

    // Step 8: Read the announcement text and store it in the database
    const announcementPath = path.join(zipsDir, task.npm_package_id + '#' + task.version + '-announcement.txt');
    if (fs.existsSync(announcementPath)) {
      try {
        const announcement = fs.readFileSync(announcementPath, 'utf8');
        await this.updateTaskFields(task.id, { announcement: announcement });
        await this.logTaskMessage(task.id, 'info', 'Announcement text saved (' + announcement.length + ' chars)');
      } catch (err) {
        await this.logTaskMessage(task.id, 'warn', 'Failed to read announcement file: ' + err.message);
      }
    } else {
      await this.logTaskMessage(task.id, 'warn', 'No announcement file found at ' + announcementPath);
    }

    // Step 9: Run the website update script
    if (website.server_update_script) {
      await this.logTaskMessage(task.id, 'info', 'Running website update script: ' + website.server_update_script);
      await this.runCommand('bash', ['-c', website.server_update_script], {}, task.id, 'Running website update script');
    }
  }

  async runPublisherGoPublish(taskId, publisherJar, sourceDir, webDir, registryDir, historyDir, templatesDir, zipsDir, logFile) {
    const { spawn } = require('child_process');

    const registryFile = path.join(registryDir, 'fhir-ig-list.json');

    const args = [
      '-jar', '-Xmx20000m', publisherJar,
      '-go-publish',
      '-source', sourceDir,
      '-web', webDir,
      '-registry', registryFile,
      '-history', historyDir,
      '-templates', templatesDir,
      '-zips', zipsDir
    ];

    await this.logTaskMessage(taskId, 'info', 'java ' + args.join(' '));

    return new Promise((resolve, reject) => {
      const java = spawn('java', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: this.publisherEnv()
      });

      const logStream = fs.createWriteStream(logFile);

      const buildStart = Date.now();
      let lastDataAt = Date.now();

      java.stdout.on('data', (data) => {
        lastDataAt = Date.now();
        logStream.write(data);
      });

      java.stderr.on('data', (data) => {
        lastDataAt = Date.now();
        logStream.write(data);
      });

      // Heartbeat: emit a status line every 60s regardless of stdout activity,
      // so silent phases of the Publisher still surface a signal-of-life.
      const heartbeat = setInterval(async () => {
        const elapsedMs = Date.now() - buildStart;
        const sinceDataMs = Date.now() - lastDataAt;
        let logKb = 0;
        try { logKb = Math.round(fs.statSync(logFile).size / 1024); } catch (_) { /* log file not created yet */ }
        const elapsedMin = Math.floor(elapsedMs / 60000);
        const elapsedSec = Math.floor(elapsedMs / 1000) % 60;
        const idleSec = Math.floor(sinceDataMs / 1000);
        await this.logTaskMessage(
          taskId,
          'info',
          'IG Publisher go-publish heartbeat: elapsed ' + elapsedMin + 'm' + elapsedSec + 's, ' +
          'log ' + logKb + ' KB, last output ' + idleSec + 's ago'
        );
      }, 60 * 1000);

      java.on('close', async (code) => {
        logStream.end();
        if (code === 0) {
          await this.logTaskMessage(taskId, 'info', 'IG Publisher go-publish completed successfully');
          resolve();
        } else {
          const error = 'IG Publisher go-publish failed with exit code: ' + code;
          await this.logTaskMessage(taskId, 'error', error);
          reject(new Error(error));
        }
      });

      java.on('error', async (error) => {
        logStream.end();
        await this.logTaskMessage(taskId, 'error', 'IG Publisher error: ' + error.message);
        reject(error);
      });

      // Timeout configurable via publisher.igPublisherTimeoutMinutes (default: 60 minutes)
      const timeoutMinutes = this.config.igPublisherTimeoutMinutes || 60;
      const timeout = setTimeout(async () => {
        java.kill();
        logStream.end();
        await this.logTaskMessage(taskId, 'error', 'IG Publisher go-publish timed out after ' + timeoutMinutes + ' minutes');
        reject(new Error('IG Publisher go-publish timed out'));
      }, timeoutMinutes * 60 * 1000);

      java.on('close', () => {
        clearTimeout(timeout);
        clearInterval(heartbeat);
      });
    });
  }

  stopTaskProcessor() {
    if (this.taskProcessor) {
      clearInterval(this.taskProcessor);
      this.taskProcessor = null;
      this.logger.info('Task processor stopped');
    }
  }

  // Middleware
  requireAuth(req, res, next) {
    if (!req.session.userId) {
      return res.redirect('/publisher/login');
    }
    next();
  }

  requireAdmin(req, res, next) {
    if (!req.session.userId || !req.session.isAdmin) {
      return res.status(403).send('Admin access required');
    }
    next();
  }

  // Route handlers
  async renderDashboard(req, res) {
    const start = Date.now();
    try {

      try {
        const htmlServer = require('../library/html-server');

        // Get recent tasks
        const tasks = await this.getTasks(10);

        let content = '<div class="row mb-4">';
        content += '<div class="col-12">';

        if (req.session.userId) {
          content += '<p>Welcome, ' + escape(req.session.userName) + '!</p>';
          content += '<div class="mb-3">';
          content += '<a href="/publisher/tasks" class="btn btn-primary me-2">View All Tasks</a>';
          if (req.session.isAdmin) {
            content += '<a href="/publisher/admin/websites" class="btn btn-secondary me-2">Manage Websites</a>';
            content += '<a href="/publisher/admin/users" class="btn btn-secondary">Manage Users</a>';
          }
          content += '<form style="display: inline-block; margin-left: 10px;" method="post" action="/publisher/logout">';
          content += '<button type="submit" class="btn btn-outline-secondary">' + escape(req.session.userName) + ' \u2014 Logout</button>';
          content += '</form>';
          content += '</div>';
        } else {
          content += '<p><a href="/publisher/login" class="btn btn-primary">Login</a> to create and manage publication tasks.</p>';
        }

        // Recent tasks
        content += '<h3>Recent Tasks</h3>';
        if (tasks.length === 0) {
          content += '<p>No tasks found.</p>';
        } else {
          content += '<div class="table-responsive">';
          content += '<table class="table table-striped">';
          content += '<thead><tr><th>ID</th><th>Package</th><th>Version</th><th>Status</th><th>Queued</th><th>User</th></tr></thead>';
          content += '<tbody>';

          tasks.forEach(task => {
            content += '<tr>';
            content += '<td><strong>#' + task.id + '</strong></td>';
            content += '<td>' + escape(task.npm_package_id) + '</td>';
            content += '<td>' + escape(task.version) + '</td>';
            content += '<td><span class="badge bg-' + this.getStatusColor(task.status) + '">' + escape(task.status) + '</span></td>';
            content += '<td>' + new Date(task.queued_at).toLocaleString() + '</td>';
            content += '<td>' + escape(task.user_name) + '</td>';
            content += '</tr>';
          });

          content += '</tbody></table>';
          content += '</div>';
        }

        content += '</div>';
        content += '</div>';

        const html = htmlServer.renderPage('publisher', 'FHIR Publisher', content, {
          taskCount: tasks.length,
          templateVars: {
            loginTitle: req.session.userId ? (req.session.userName + ' \u2014 Logout') : 'Login',
            loginPath: req.session.userId ? "logout" : 'login',
            loginAction: req.session.userId ? "POST" : 'GET'
          }
        });

        res.setHeader('Content-Type', 'text/html');
        res.send(html);
      } catch (error) {
        this.logger.error('Error rendering dashboard:', error);
        res.status(500).send('Internal server error');
      }
    } finally {
      this.stats.countRequest('dashboard', Date.now() - start);
    }
  }

  renderLogin(req, res) {
    const start = Date.now();
    try {

      const htmlServer = require('../library/html-server');

      let content = '<div class="row justify-content-center">';
      content += '<div class="col-md-6">';
      content += '<h3>Login</h3>';
      content += '<form method="post" action="/publisher/login">';
      content += '<div class="mb-3">';
      content += '<label for="login" class="form-label">Username</label>';
      content += '<input type="text" class="form-control" id="login" name="login" required>';
      content += '</div>';
      content += '<div class="mb-3">';
      content += '<label for="password" class="form-label">Password</label>';
      content += '<input type="password" class="form-control" id="password" name="password" required>';
      content += '</div>';
      content += '<button type="submit" class="btn btn-primary">Login</button>';
      content += '</form>';
      content += '</div>';
      content += '</div>';

      const html = htmlServer.renderPage('publisher', 'Login - FHIR Publisher', content, {
        templateVars: {
          loginTitle: req.session.userId ? (req.session.userName + ' \u2014 Logout') : 'Login',
          loginPath: req.session.userId ? "logout" : 'login',
          loginAction: req.session.userId ? "POST" : 'GET'
        }});
      res.setHeader('Content-Type', 'text/html');
      res.send(html);
    } finally {
      this.stats.countRequest('login', Date.now() - start);
    }
  }

  async handleLogin(req, res) {
    const start = Date.now();
    try {

      try {
        const {login, password} = req.body;

        const user = await new Promise((resolve, reject) => {
          this.db.get(
              'SELECT * FROM users WHERE login = ?',
              [login],
              (err, row) => {
                if (err) reject(err);
                else resolve(row);
              }
          );
        });

        if (!user) {
          return res.redirect('/publisher/login?error=invalid');
        }

        const passwordMatch = await bcrypt.compare(password, user.password_hash);
        if (!passwordMatch) {
          return res.redirect('/publisher/login?error=invalid');
        }

        req.session.userId = user.id;
        req.session.userName = user.name;
        req.session.isAdmin = user.is_admin;

        // Log the action
        this.logUserAction(user.id, 'login', null, req.ip);

        res.redirect('/publisher');
      } catch (error) {
        this.logger.error('Login error:', error);
        res.redirect('/publisher/login?error=server');
      }
    } finally {
      this.stats.countRequest('login', Date.now() - start);
    }
  }

  handleLogout(req, res) {
    const start = Date.now();
    try {

      req.session.destroy();
      res.redirect('/publisher');
    } finally {
      this.stats.countRequest('logout', Date.now() - start);
    }
  }

  async renderTasks(req, res) {
    const start = Date.now();
    try {

      try {
        const htmlServer = require('../library/html-server');
        const tasks = await this.getTasks();
        const userWebsites = req.session.userId ? await this.getUserWebsites(req.session.userId) : [];

        let content = '<div class="row mb-4">';

        // Create task form for logged in users
        if (req.session.userId && userWebsites.length > 0) {
          content += '<div class="col-12 mb-4">';
          content += '<button class="btn btn-primary" onclick="document.getElementById(\'create-task-panel\').style.display = document.getElementById(\'create-task-panel\').style.display === \'none\' ? \'block\' : \'none\'">New Publication Task</button>';
          content += '<div id="create-task-panel" style="display: none;" class="mt-3">';
          content += '<h3>Create New Publication Task</h3>';
          content += '<form id="create-task-form" method="post" action="/publisher/tasks" class="row g-3">';
          content += '<div class="col-md-3">';
          content += '<label for="website_id" class="form-label">Target Website</label>';
          content += '<select class="form-select" id="website_id" name="website_id" required>';
          userWebsites.forEach(website => {
            content += '<option value="' + website.id + '">' + website.name + '</option>';
          });
          content += '</select>';
          content += '</div>';
          content += '<div class="col-md-3">';
          content += '<label for="github_org" class="form-label">GitHub Org</label>';
          content += '<input type="text" class="form-control" id="github_org" name="github_org" required maxlength="39" pattern="' + escape(validation.HTML_PATTERNS.github_org) + '" title="Letters, digits and single hyphens" placeholder="hl7">';
          content += '</div>';
          content += '<div class="col-md-3">';
          content += '<label for="github_repo" class="form-label">GitHub Repo</label>';
          content += '<input type="text" class="form-control" id="github_repo" name="github_repo" required maxlength="100" pattern="' + escape(validation.HTML_PATTERNS.github_repo) + '" title="Letters, digits, dots, hyphens and underscores" placeholder="fhir-us-core">';
          content += '</div>';
          content += '<div class="col-md-3">';
          content += '<label for="git_branch" class="form-label">Branch</label>';
          content += '<input type="text" class="form-control" id="git_branch" name="git_branch" required maxlength="255" pattern="' + escape(validation.HTML_PATTERNS.git_branch) + '" title="A git branch name - slashes are fine, but not spaces, backslashes, markup characters, or any of ~ ^ : ? * [" placeholder="main">';
          content += '</div>';
          content += '<div class="col-md-4">';
          content += '<label for="npm_package_id" class="form-label">NPM Package ID</label>';
          content += '<input type="text" class="form-control" id="npm_package_id" name="npm_package_id" required maxlength="128" pattern="' + escape(validation.HTML_PATTERNS.npm_package_id) + '" title="Letters, digits, dots, hyphens and underscores" placeholder="hl7.fhir.us.core">';
          content += '</div>';
          content += '<div class="col-md-4">';
          content += '<label for="version" class="form-label">Version</label>';
          content += '<input type="text" class="form-control" id="version" name="version" required maxlength="64" pattern="' + escape(validation.HTML_PATTERNS.version) + '" title="Letters, digits, dots, hyphens and plus signs" placeholder="6.0.0">';
          content += '</div>';
          content += '<div class="col-md-4 d-flex align-items-end">';
          content += '<button type="submit" class="btn btn-primary">Create Task</button>';
          content += '</div>';
          content += '</form>';
          content += '</div>'; // create-task-panel
          content += '</div>';
        }

        // Tasks list
        content += '<div class="col-12">';
        content += '<h3>Publication Tasks</h3>';

        if (tasks.length === 0) {
          content += '<p>No tasks found.</p>';
        } else {
          content += '<div class="table-responsive">';
          content += '<table class="table table-striped">';
          content += '<thead><tr><th>ID</th><th>Package</th><th>Version</th><th>Website</th><th>Status</th><th>IG Publisher</th><th>Queued</th><th>User</th><th>Actions</th></tr></thead>';
          content += '<tbody>';

          for (const task of tasks) {
            const canApprove = req.session.userId && task.status === 'waiting for approval' &&
                await this.userCanApprove(req.session.userId, task.website_id);

            // Determine if the current user can delete this task (mirrors deleteTask backend logic)
            const isPreApprovalStatus = task.status === 'waiting for approval' || task.status === 'queued' || (task.status === 'failed' && !task.approved_by);
            const isPostApprovalFailed = task.status === 'failed' && task.approved_by;
            const canDelete = req.session.userId && (
                (isPreApprovalStatus && await this.userCanQueue(req.session.userId, task.website_id)) ||
                (isPostApprovalFailed && req.session.isAdmin)
            );

            content += '<tr>';
            content += '<td><strong>#' + task.id + '</strong></td>';
            content += '<td><code>' + escape(task.npm_package_id) + '</code></td>';
            content += '<td>' + escape(task.version) + '</td>';
            content += '<td>' + escape(task.website_name) + '</td>';
            content += '<td><span class="badge bg-' + this.getStatusColor(task.status) + '">' + escape(task.status) + '</span></td>';
            content += '<td>' + (task.publisher_version ? '<code>' + escape(task.publisher_version) + '</code>' : '<span class="text-muted">—</span>') + '</td>';
            content += '<td>' + new Date(task.queued_at).toLocaleString() + '</td>';
            content += '<td>' + escape(task.user_name) + '</td>';
            content += '<td class="task-actions">';
            content += '<a href="/publisher/tasks/' + task.id + '/history" class="btn btn-sm btn-outline-secondary me-1">History</a>';

            if (task.status === 'waiting for approval') {
              content += '<a href="/publisher/tasks/' + task.id + '/output" class="btn btn-sm btn-outline-info me-1">View Log</a>';
              content += '<a href="/publisher/tasks/' + task.id + '/qa-files/index.html" class="btn btn-sm btn-outline-secondary me-1">View IG</a>';
              content += '<a href="/publisher/tasks/' + task.id + '/qa" class="btn btn-sm btn-outline-secondary me-1">View QA</a>';
              if (canApprove) {
                content += '<form method="post" action="/publisher/tasks/' + task.id + '/approve" style="display: inline;">';
                content += '<button type="submit" name="approve" class="btn btn-sm btn-success me-1">Approve</button>';
                content += '</form>';
              }
            } else {
              if (task.build_output_path || task.local_folder) {
                content += '<a href="/publisher/tasks/' + task.id + '/output" class="btn btn-sm btn-outline-info me-1">View Output</a>';
              }
              if (task.announcement) {
                content += '<a href="/publisher/tasks/' + task.id + '/history" class="btn btn-sm btn-outline-success me-1">📢 Announcement</a>';
              }
              if (task.failure_reason) {
                content += '<span class="text-danger small me-1">' + escape(task.failure_reason) + '</span>';
              }
            }

            if (canDelete) {
              content += '<form method="post" action="/publisher/tasks/' + task.id + '/delete" style="display: inline;" onsubmit="return confirm(\'Delete task #' + task.id + ' and all its build output? This cannot be undone.\')">';
              content += '<button type="submit" class="btn btn-sm btn-danger">Delete</button>';
              content += '</form>';
            }

            if (req.session.userId && task.status === 'failed') {
              content += ' <form method="post" action="/publisher/tasks/' + task.id + '/retry" style="display: inline;">';
              content += '<button type="submit" class="btn btn-sm btn-warning">Retry</button>';
              content += '</form>';
            }

            content += '</td>';
            content += '</tr>';
          }

          content += '</tbody></table>';
          content += '</div>';
        }

        content += '</div>';
        content += '</div>';

        const html = htmlServer.renderPage('publisher', 'Tasks - FHIR Publisher', content, {
          templateVars: {
            loginTitle: req.session.userId ? (req.session.userName + ' \u2014 Logout') : 'Login',
            loginPath: req.session.userId ? "logout" : 'login',
            loginAction: req.session.userId ? "POST" : 'GET'
          }});
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
      } catch (error) {
        this.logger.error('Error rendering tasks:', error);
        res.status(500).send('Internal server error');
      }

    } finally {
      this.stats.countRequest('tasks', Date.now() - start);
    }
  }

  async createTask(req, res) {
    const start = Date.now();
    try {


      try {
        const {website_id, github_org, github_repo, git_branch, npm_package_id, version} = req.body;

        // Check the input before it goes anywhere near a git command line or a
        // file name. The browser checks these too (see HTML_PATTERNS), but the
        // form isn't the only way to reach this route.
        const problems = validation.validateTaskInput(req.body);
        if (problems.length > 0) {
          this.logger.warn('Rejected task creation from user ' + req.session.userId + ': ' + problems.join('; '));
          return res.status(400).send('Invalid task details: ' + problems.join('; '));
        }

        // Verify user has permission for this website
        const canQueue = await this.userCanQueue(req.session.userId, website_id);
        if (!canQueue) {
          return res.status(403).send('You do not have permission to create tasks for this website');
        }

        // Check for duplicate active tasks (only block if there's an active task for this package/version)
        const existingTask = await this.findActiveTask(npm_package_id, version);
        if (existingTask) {
          return res.status(400).send('An active task for this package and version is already in progress. Wait for it to complete or fail before resubmitting.');
        }

        // Insert task (ID will be auto-generated)
        const result = await new Promise((resolve, reject) => {
          this.db.run(
              'INSERT INTO tasks (user_id, website_id, github_org, github_repo, git_branch, npm_package_id, version) VALUES (?, ?, ?, ?, ?, ?, ?)',
              [req.session.userId, website_id, github_org, github_repo, git_branch, npm_package_id, version],
              function (err) {
                if (err) reject(err);
                else resolve(this.lastID);
              }
          );
        });

        const taskId = result;

        // Log the action
        this.logUserAction(req.session.userId, 'create_task', taskId.toString(), req.ip);

        this.logger.info('Task created: ID=' + taskId + ' (' + npm_package_id + '#' + version + ') by user ' + req.session.userId);
        res.redirect('/publisher/tasks');
      } catch (error) {
        this.logger.error('Error creating task:', error);
        res.status(500).send('Failed to create task');
      }
    } finally {
      this.stats.countRequest('create-task', Date.now() - start);
    }
  }

  async approveTask(req, res) {
    const start = Date.now();
    try {
      try {
        const taskId = req.params.id;

        // Get task details
        const task = await this.getTask(taskId);
        if (!task) {
          return res.status(404).send('Task not found');
        }

        if (task.status !== 'waiting for approval') {
          return res.status(400).send('Task is not waiting for approval');
        }

        // Check user permissions
        const canApprove = await this.userCanApprove(req.session.userId, task.website_id);
        if (!canApprove) {
          return res.status(403).send('You do not have permission to approve tasks for this website');
        }

        // Update task status
        await new Promise((resolve, reject) => {
          this.db.run(
              'UPDATE tasks SET status = ?, approved_by = ?, publishing_at = CURRENT_TIMESTAMP WHERE id = ?',
              ['publishing', req.session.userId, taskId],
              (err) => {
                if (err) reject(err);
                else resolve();
              }
          );
        });

        // Log the action
        this.logUserAction(req.session.userId, 'approve_task', taskId, req.ip);

        this.logger.info('Task approved: ' + taskId + ' by user ' + req.session.userId);
        res.redirect('/publisher/tasks');
      } catch (error) {
        this.logger.error('Error approving task:', error);
        res.status(500).send('Failed to approve task');
      }
    } finally {
      this.stats.countRequest('approve-task', Date.now() - start);
    }
  }

  async deleteTask(req, res) {
    const start = Date.now();
    try {
      try {
        const taskId = req.params.id;
        const task = await this.getTask(taskId);

        if (!task) {
          return res.status(404).send('Task not found');
        }

        if (task.status !== 'waiting for approval' && task.status !== 'failed' && task.status !== 'queued') {
          return res.status(400).send('Only tasks that are queued, waiting for approval, or failed can be deleted');
        }

        // Pre-approval statuses: any user with queue rights on this website can delete
        // Post-approval (failed after publishing started): admin only
        const isPostApproval = task.status === 'failed' && task.approved_by;
        if (isPostApproval) {
          if (!req.session.isAdmin) {
            return res.status(403).send('Admin access required to delete a task that has been approved');
          }
        } else {
          const canQueue = await this.userCanQueue(req.session.userId, task.website_id);
          if (!canQueue) {
            return res.status(403).send('You do not have permission to delete tasks for this website');
          }
        }

        // Remove build output directory
        if (task.local_folder && fs.existsSync(task.local_folder)) {
          try {
            await require('fs').promises.rm(task.local_folder, { recursive: true, force: true });
          } catch (err) {
            this.logger.warn('Failed to remove task directory ' + task.local_folder + ': ' + err.message);
          }
        }

        // Delete task logs
        await new Promise((resolve, reject) => {
          this.db.run('DELETE FROM task_logs WHERE task_id = ?', [taskId.toString()], (err) => {
            if (err) reject(err);
            else resolve();
          });
        });

        // Delete task record
        await new Promise((resolve, reject) => {
          this.db.run('DELETE FROM tasks WHERE id = ?', [taskId], (err) => {
            if (err) reject(err);
            else resolve();
          });
        });

        this.logUserAction(req.session.userId, 'delete_task', taskId, req.ip);
        this.logger.info('Task deleted: ' + taskId + ' by user ' + req.session.userId);
        res.redirect('/publisher/tasks');
      } catch (error) {
        this.logger.error('Error deleting task:', error);
        res.status(500).send('Failed to delete task: ' + error.message);
      }
    } finally {
      this.stats.countRequest('delete-task', Date.now() - start);
    }
  }

  async retryTask(req, res) {
    const start = Date.now();
    try {
      try {
        const taskId = req.params.id;
        const task = await this.getTask(taskId);
        if (!task) return res.status(404).send('Task not found');
        if (task.status !== 'failed') return res.status(400).send('Only failed tasks can be retried');
        const canQueue = await this.userCanQueue(req.session.userId, task.website_id);
        if (!canQueue) return res.status(403).send('You do not have permission to queue tasks for this website');
        const existingTask = await this.findActiveTask(task.npm_package_id, task.version);
        if (existingTask) return res.status(400).send('An active task for this package and version is already in progress.');
        const newTaskId = await new Promise((resolve, reject) => {
          this.db.run(
              'INSERT INTO tasks (user_id, website_id, github_org, github_repo, git_branch, npm_package_id, version) VALUES (?, ?, ?, ?, ?, ?, ?)',
              [req.session.userId, task.website_id, task.github_org, task.github_repo, task.git_branch, task.npm_package_id, task.version],
              function (err) { if (err) reject(err); else resolve(this.lastID); }
          );
        });
        this.logUserAction(req.session.userId, 'retry_task', newTaskId.toString(), req.ip);
        this.logger.info('Task retried: new ID=' + newTaskId + ' from task #' + taskId);
        res.redirect('/publisher/tasks/' + newTaskId + '/history');
      } catch (error) {
        this.logger.error('Error retrying task:', error);
        res.status(500).send('Failed to retry task: ' + error.message);
      }
    } finally {
      this.stats.countRequest('retry-task', Date.now() - start);
    }
  }

  async getTaskOutput(req, res) {
    const start = Date.now();
    try {

      try {
        const taskId = req.params.id;
        const task = await this.getTask(taskId);

        if (!task) {
          return res.status(404).send('Task not found');
        }

        // Get task logs
        const logs = await this.getTaskLogs(taskId);

        // Get build log if available
        let buildLog = '';
        if (task.build_output_path && fs.existsSync(task.build_output_path)) {
          try {
            buildLog = fs.readFileSync(task.build_output_path, 'utf8');
          } catch (error) {
            buildLog = 'Error reading build log: ' + error.message;
          }
        }

        // Get publication log if available
        let publishLog = '';
        if (task.local_folder) {
          const publishLogPath = path.join(task.local_folder, 'publication.log');
          if (fs.existsSync(publishLogPath)) {
            try {
              publishLog = fs.readFileSync(publishLogPath, 'utf8');
            } catch (error) {
              publishLog = 'Error reading publication log: ' + error.message;
            }
          }
        }

        if (req.headers.accept && req.headers.accept.includes('text/html')) {
          const htmlServer = require('../library/html-server');
          let content = '<h3>Task Output: #' + task.id + ' - ' + escape(task.npm_package_id) + '#' + escape(task.version) + '</h3>';
          content += '<p><strong>Status:</strong> <span class="badge bg-' + this.getStatusColor(task.status) + '">' + escape(task.status) + '</span></p>';
          content += '<p><strong>GitHub:</strong> ' + escape(task.github_org) + '/' + escape(task.github_repo) + ' (' + escape(task.git_branch) + ')</p>';

          if (task.publisher_version) {
            content += '<p><strong>IG Publisher:</strong> <code>' + escape(task.publisher_version) + '</code></p>';
          }

          if (task.local_folder) {
            content += '<p><strong>Local Folder:</strong> <code>' + escape(task.local_folder) + '</code></p>';
          }

          if (task.failure_reason) {
            content += '<div class="alert alert-danger"><strong>Failure Reason:</strong> ' + escape(task.failure_reason) + '</div>';
          }

          // Task logs section
          content += '<h4>Task Logs</h4>';
          if (logs.length === 0) {
            content += '<p>No task logs available yet.</p>';
          } else {
            content += '<div class="output-viewer" style="max-height: 300px;">';
            logs.forEach(log => {
              const timestamp = new Date(log.timestamp).toLocaleString();
              const levelClass = log.level === 'error' ? 'text-danger' : (log.level === 'warn' ? 'text-warning' : '');
              content += '<div class="' + levelClass + '">[' + timestamp + '] [' + escape(log.level.toUpperCase()) + '] ' + escape(log.message) + '</div>';
            });
            content += '</div>';
          }

          // Announcement section
          if (task.announcement) {
            content += '<h4>Announcement</h4>';
            content += '<button onclick="navigator.clipboard.writeText(document.getElementById(\'announcement-text\').innerText)" class="btn btn-sm btn-outline-secondary mb-2">Copy to clipboard</button>';
            content += '<div id="announcement-text" class="output-viewer" style="white-space: pre-wrap;">' + escape(task.announcement) + '</div>';
          }

          // Build log section
          if (buildLog) {
            content += '<h4>Build Log</h4>';
            content += '<div class="output-viewer">' + escape(buildLog) + '</div>';
          } else if (task.status === 'building') {
            content += '<h4>Build Log</h4>';
            content += '<p><em>Build in progress... Log will appear when available.</em></p>';
          }

          // Publication log section
          if (publishLog) {
            content += '<h4>Publication Log</h4>';
            content += '<div class="output-viewer">' + escape(publishLog) + '</div>';
          } else if (task.status === 'publishing') {
            content += '<h4>Publication Log</h4>';
            content += '<p><em>Publication in progress... Log will appear when available.</em></p>';
          }

          content += '<div class="mt-3"><a href="/publisher/tasks" class="btn btn-secondary">Back to Tasks</a></div>';

          const html = htmlServer.renderPage('publisher', 'Task Output - FHIR Publisher', content, {
            templateVars: {
              loginTitle: req.session.userId ? (req.session.userName + ' \u2014 Logout') : 'Login',
              loginPath: req.session.userId ? "logout" : 'login',
              loginAction: req.session.userId ? "POST" : 'GET'
            }});
          res.setHeader('Content-Type', 'text/html');
          res.send(html);
        } else {
          // Return plain text logs
          let output = 'Task #' + task.id + ' - ' + task.npm_package_id + '#' + task.version + '\n';
          output += 'Status: ' + task.status + '\n';
          output += 'GitHub: ' + task.github_org + '/' + task.github_repo + ' (' + task.git_branch + ')\n';

          if (task.local_folder) {
            output += 'Local Folder: ' + task.local_folder + '\n';
          }

          output += '\n';

          if (task.failure_reason) {
            output += 'Failure Reason: ' + task.failure_reason + '\n\n';
          }

          output += 'Task Logs:\n';
          logs.forEach(log => {
            const timestamp = new Date(log.timestamp).toLocaleString();
            output += '[' + timestamp + '] [' + log.level.toUpperCase() + '] ' + log.message + '\n';
          });

          if (buildLog) {
            output += '\n--- Build Log ---\n';
            output += buildLog;
          }

          if (publishLog) {
            output += '\n--- Publication Log ---\n';
            output += publishLog;
          }

          res.setHeader('Content-Type', 'text/plain');
          res.send(output);
        }
      } catch (error) {
        this.logger.error('Error getting task output:', error);
        res.status(500).send('Failed to get task output');
      }
    } finally {
      this.stats.countRequest('task-output', Date.now() - start);
    }
  }

  async getTaskQA(req, res) {
    const start = Date.now();
    try {
      const taskId = req.params.id;
      res.redirect('/publisher/tasks/' + taskId + '/qa-files/qa.html');
    } finally {
      this.stats.countRequest('task-qa', Date.now() - start);
    }
  }

  async getTaskHistory(req, res) {
    const start = Date.now();
    try {
      try {
        const taskId = req.params.id;
        const task = await this.getTask(taskId);

        if (!task) {
          return res.status(404).send('Task not found');
        }

        const logs = await this.getTaskLogs(taskId);
        const actions = await this.getTaskActions(taskId);

        const htmlServer = require('../library/html-server');

        let content = '<h3>Task History: #' + task.id + ' — ' + escape(task.npm_package_id) + '#' + escape(task.version) + '</h3>';

        // Task details summary card
        content += '<div class="card mb-4"><div class="card-body">';
        content += '<div class="row">';
        content += '<div class="col-md-6">';
        content += '<p><strong>Status:</strong> <span class="badge bg-' + this.getStatusColor(task.status) + '">' + escape(task.status) + '</span></p>';
        content += '<p><strong>Package:</strong> <code>' + escape(task.npm_package_id) + '</code></p>';
        content += '<p><strong>Version:</strong> ' + escape(task.version) + '</p>';
        content += '<p><strong>Website:</strong> ' + escape(task.website_name) + '</p>';
        content += '</div>';
        content += '<div class="col-md-6">';
        content += '<p><strong>GitHub:</strong> ' + escape(task.github_org) + '/' + escape(task.github_repo) + ' (' + escape(task.git_branch) + ')</p>';
        content += '<p><strong>Created by:</strong> ' + escape(task.user_name) + ' (' + escape(task.user_login) + ')</p>';
        if (task.approved_by_name) {
          content += '<p><strong>Approved by:</strong> ' + escape(task.approved_by_name) + '</p>';
        }
        if (task.local_folder) {
          content += '<p><strong>Local folder:</strong> <code>' + escape(task.local_folder) + '</code></p>';
        }
        if (task.failure_reason) {
          content += '<p><strong>Failure reason:</strong> <span class="text-danger">' + escape(task.failure_reason) + '</span></p>';
        }
        content += '</div>';
        content += '</div>';
        content += '</div></div>';

        // Announcement section (for completed publications)
        if (task.announcement) {
          content += '<div class="card mb-4"><div class="card-body">';
          content += '<div class="d-flex justify-content-between align-items-center mb-2">';
          content += '<h5 class="mb-0">Announcement</h5>';
          content += '<button onclick="navigator.clipboard.writeText(document.getElementById(\'hist-announcement\').innerText)" class="btn btn-sm btn-outline-secondary">Copy to clipboard</button>';
          content += '</div>';
          content += '<pre id="hist-announcement" class="mb-0" style="white-space: pre-wrap;">' + escape(task.announcement) + '</pre>';
          content += '</div></div>';
        }

        // Build unified timeline from all sources
        const events = [];

        // Status transition timestamps from the task record
        if (task.queued_at) {
          events.push({ timestamp: task.queued_at, type: 'status', icon: '📋', label: 'Task queued', detail: 'Created by ' + escape(task.user_name), css: '' });
        }
        if (task.building_at) {
          events.push({ timestamp: task.building_at, type: 'status', icon: '🔨', label: 'Draft build started', detail: '', css: '' });
        }
        if (task.waiting_approval_at) {
          events.push({ timestamp: task.waiting_approval_at, type: 'status', icon: '⏳', label: 'Waiting for approval', detail: 'Draft build completed', css: '' });
        }
        if (task.publishing_at) {
          const approver = task.approved_by_name ? 'Approved by ' + escape(task.approved_by_name) : '';
          events.push({ timestamp: task.publishing_at, type: 'status', icon: '🚀', label: 'Publishing started', detail: approver, css: '' });
        }
        if (task.completed_at) {
          events.push({ timestamp: task.completed_at, type: 'status', icon: '✅', label: 'Completed', detail: '', css: 'text-success' });
        }
        if (task.failed_at) {
          events.push({ timestamp: task.failed_at, type: 'status', icon: '❌', label: 'Failed', detail: task.failure_reason ? escape(task.failure_reason) : '', css: 'text-danger' });
        }

        // Task log entries
        for (const log of logs) {
          events.push({
            timestamp: log.timestamp,
            type: 'log',
            icon: log.level === 'error' ? '🔴' : log.level === 'warn' ? '🟡' : '🔵',
            label: escape(log.message),
            detail: '',
            css: log.level === 'error' ? 'text-danger' : log.level === 'warn' ? 'text-warning' : 'text-muted'
          });
        }

        // User actions
        for (const action of actions) {
          const who = action.user_name ? escape(action.user_name) + ' (' + escape(action.user_login) + ')' : 'Unknown';
          const ip = action.ip_address ? ' from ' + escape(action.ip_address) : '';
          let actionLabel = action.action;
          if (action.action === 'create_task') actionLabel = 'Created task';
          else if (action.action === 'approve_task') actionLabel = 'Approved task';
          else if (action.action === 'delete_task') actionLabel = 'Deleted task';
          else actionLabel = escape(action.action.replace(/_/g, ' '));

          events.push({
            timestamp: action.timestamp,
            type: 'action',
            icon: '👤',
            label: actionLabel,
            detail: who + ip,
            css: ''
          });
        }

        // Sort all events chronologically
        events.sort((a, b) => {
          const ta = new Date(a.timestamp).getTime();
          const tb = new Date(b.timestamp).getTime();
          if (ta !== tb) return ta - tb;
          // Within the same timestamp, put status transitions first, then actions, then logs
          const order = { status: 0, action: 1, log: 2 };
          return (order[a.type] || 9) - (order[b.type] || 9);
        });

        // Render timeline
        content += '<h4>Timeline</h4>';
        if (events.length === 0) {
          content += '<p>No history recorded yet.</p>';
        } else {
          content += '<table class="table table-sm">';
          content += '<thead><tr><th style="width: 180px;">Time</th><th style="width: 30px;"></th><th style="width: 100px;">Type</th><th>Event</th></tr></thead>';
          content += '<tbody>';
          for (const evt of events) {
            const ts = new Date(evt.timestamp).toLocaleString();
            const typeBadge = evt.type === 'status' ? '<span class="badge bg-primary">status</span>'
                : evt.type === 'action' ? '<span class="badge bg-info">user</span>'
                    : '<span class="badge bg-secondary">log</span>';
            content += '<tr>';
            content += '<td class="text-nowrap"><small>' + ts + '</small></td>';
            content += '<td>' + evt.icon + '</td>';
            content += '<td>' + typeBadge + '</td>';
            content += '<td class="' + evt.css + '">' + evt.label;
            if (evt.detail) {
              content += ' <small class="text-muted">— ' + evt.detail + '</small>';
            }
            content += '</td>';
            content += '</tr>';
          }
          content += '</tbody></table>';
        }

        // Links at the bottom
        content += '<div class="mt-3">';
        if (task.build_output_path || task.local_folder) {
          content += '<a href="/publisher/tasks/' + task.id + '/output" class="btn btn-outline-info me-2">View Output</a>';
        }
        if (task.status === 'waiting for approval') {
          content += '<a href="/publisher/tasks/' + task.id + '/qa" class="btn btn-outline-secondary me-2">View QA Report</a>';
        }
        if (req.session.userId && task.status === 'failed') {
          content += '<form method="post" action="/publisher/tasks/' + task.id + '/retry" style="display: inline;" class="me-2">';
          content += '<button type="submit" class="btn btn-warning">Retry</button>';
          content += '</form>';
        }
        // Show delete button using same logic as backend deleteTask:
        // Pre-approval (queued, waiting for approval, or failed without approval): user with queue rights can delete
        // Post-approval (failed after approval): admin only
        const detailIsPreApproval = task.status === 'waiting for approval' || task.status === 'queued' || (task.status === 'failed' && !task.approved_by);
        const detailIsPostApprovalFailed = task.status === 'failed' && task.approved_by;
        const detailCanDelete = req.session.userId && (
            (detailIsPreApproval && await this.userCanQueue(req.session.userId, task.website_id)) ||
            (detailIsPostApprovalFailed && req.session.isAdmin)
        );
        if (detailCanDelete) {
          content += '<form method="post" action="/publisher/tasks/' + task.id + '/delete" style="display: inline;" class="me-2" onsubmit="return confirm(\'Delete task #' + task.id + ' and all its build output? This cannot be undone.\')">';
          content += '<button type="submit" class="btn btn-danger">Delete</button>';
          content += '</form>';
        }
        content += '<a href="/publisher/tasks" class="btn btn-secondary">Back to Tasks</a>';
        content += '</div>';

        const html = htmlServer.renderPage('publisher', 'Task History - FHIR Publisher', content, {
          templateVars: {
            loginTitle: req.session.userId ? (req.session.userName + ' \u2014 Logout') : 'Login',
            loginPath: req.session.userId ? "logout" : 'login',
            loginAction: req.session.userId ? "POST" : 'GET'
          }});
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
      } catch (error) {
        this.logger.error('Error rendering task history:', error);
        res.status(500).send('Internal server error');
      }
    } finally {
      this.stats.countRequest('task-history', Date.now() - start);
    }
  }

  async renderEditWebsite(req, res) {
    const start = Date.now();
    try {
      const htmlServer = require('../library/html-server');
      const website = await this.getWebsite(req.params.id);
      if (!website) return res.status(404).send('Website not found');

      let content = '<h3>Edit Website</h3>';
      content += '<form method="post" action="/publisher/admin/websites/' + website.id + '/edit" class="row g-3">';
      content += '<div class="col-md-4"><label class="form-label">Website Name</label>';
      content += '<input type="text" class="form-control" name="name" value="' + escape(website.name) + '" required></div>';
      content += '<div class="col-md-4"><label class="form-label">Local Folder</label>';
      content += '<input type="text" class="form-control" name="local_folder" value="' + escape(website.local_folder) + '" required></div>';
      content += '<div class="col-md-4"><label class="form-label">Git Root (repo root for git operations)</label>';
      content += '<input type="text" class="form-control" name="git_root" value="' + escape(website.git_root || '') + '"></div>';
      content += '<div class="col-md-4"><label class="form-label">History Templates</label>';
      content += '<input type="text" class="form-control" name="history_templates" value="' + escape(website.history_templates) + '" required></div>';
      content += '<div class="col-md-4"><label class="form-label">Web Templates</label>';
      content += '<input type="text" class="form-control" name="web_templates" value="' + escape(website.web_templates) + '" required></div>';
      content += '<div class="col-md-4"><label class="form-label">Update Script</label>';
      content += '<input type="text" class="form-control" name="server_update_script" value="' + escape(website.server_update_script) + '" required></div>';
      content += '<div class="col-md-4"><label class="form-label">Active</label>';
      content += '<select class="form-control" name="is_active"><option value="1"' + (website.is_active ? ' selected' : '') + '>Yes</option><option value="0"' + (!website.is_active ? ' selected' : '') + '>No</option></select></div>';
      content += '<div class="col-12"><button type="submit" class="btn btn-primary">Save Changes</button> ';
      content += '<a href="/publisher/admin/websites" class="btn btn-secondary">Cancel</a></div>';
      content += '</form>';

      const html = htmlServer.renderPage('publisher', 'Edit Website - FHIR Publisher', content, {
        templateVars: { loginTitle: (req.session.userName || '') + ' \u2014 Logout', loginPath: 'logout', loginAction: 'POST' }
      });
      res.setHeader('Content-Type', 'text/html');
      res.send(html);
    } catch (error) {
      this.logger.error('Error rendering edit website:', error);
      res.status(500).send('Internal server error');
    } finally {
      this.stats.countRequest('websites-edit', Date.now() - start);
    }
  }

  async updateWebsite(req, res) {
    const start = Date.now();
    try {
      const { name, local_folder,  git_root, history_templates, web_templates, server_update_script, is_active } = req.body;
      const websiteId = req.params.id;

      await new Promise((resolve, reject) => {
        this.db.run(
            'UPDATE websites SET name=?, local_folder=?,  git_root = ?, history_templates=?, web_templates=?, server_update_script=?, is_active=? WHERE id=?',
            [name, local_folder,  git_root, history_templates, web_templates, server_update_script, is_active === '1' ? 1 : 0, websiteId],
            (err) => err ? reject(err) : resolve()
        );
      });

      this.logUserAction(req.session.userId, 'update_website', websiteId, req.ip);
      this.logger.info('Website updated: ' + websiteId + ' by user ' + req.session.userId);
      res.redirect('/publisher/admin/websites');
    } catch (error) {
      this.logger.error('Error updating website:', error);
      res.status(500).send('Failed to update website');
    } finally {
      this.stats.countRequest('websites-update', Date.now() - start);
    }
  }

  async renderWebsites(req, res) {
    const start = Date.now();
    try {
      try {
        const htmlServer = require('../library/html-server');
        const websites = await this.getWebsites();

        let content = '<div class="row mb-4">';

        // Add website form
        content += '<div class="col-12 mb-4">';
        content += '<button class="btn btn-primary" onclick="document.getElementById(\'add-website-panel\').style.display = document.getElementById(\'add-website-panel\').style.display === \'none\' ? \'block\' : \'none\'">Add New Website</button>';
        content += '<div id="add-website-panel" style="display: none;" class="mt-3">';
        content += '<h3>Add New Website</h3>';
        content += '<form method="post" action="/publisher/admin/websites" class="row g-3">';
        content += '<div class="col-md-4">';
        content += '<label for="name" class="form-label">Website Name</label>';
        content += '<input type="text" class="form-control" id="name" name="name" required>';
        content += '</div>';
        content += '<div class="col-md-4">';
        content += '<label for="local_folder" class="form-label">Local Folder</label>';
        content += '<input type="text" class="form-control" id="local_folder" name="local_folder" required>';
        content += '</div>';
        content += '<div class="col-md-4">';
        content += '<label class="form-label">Git Root (repo root for git operations)</label>';
        content += '<input type="text" class="form-control" name="git_root" required>';
        content += '</div>';
        content += '<div class="col-md-4">';
        content += '<label for="history_templates" class="form-label">History Templates</label>';
        content += '<input type="text" class="form-control" id="history_templates" name="history_templates" required>';
        content += '</div>';
        content += '<div class="col-md-4">';
        content += '<label for="web_templates" class="form-label">Web Templates</label>';
        content += '<input type="text" class="form-control" id="web_templates" name="web_templates" required>';
        content += '</div>';
        content += '<div class="col-md-4">';
        content += '<label for="server_update_script" class="form-label">Update Script</label>';
        content += '<input type="text" class="form-control" id="server_update_script" name="server_update_script" required>';
        content += '</div>';
        content += '<div class="col-12">';
        content += '<button type="submit" class="btn btn-primary">Add Website</button>';
        content += '</div>';
        content += '</form>';
        content += '</div>'; // add-website-panel
        content += '</div>';

        // Websites list
        content += '<div class="col-12">';
        content += '<h3>Websites</h3>';

        if (websites.length === 0) {
          content += '<p>No websites configured.</p>';
        } else {
          content += '<div class="table-responsive">';
          content += '<table class="table table-striped">';
          content += '<thead><tr><th>Name</th><th>Local Folder</th><th>Git Root</th><th>History Templates</th><th>Web Templates</th><th>Update Script</th><th>Active</th><th>Created</th><th>Actions</th></tr></thead>';
          content += '<tbody>';

          websites.forEach(website => {
            content += '<tr>';
            content += '<td>' + escape(website.name) + '</td>';
            content += '<td><code>' + escape(website.local_folder) + '</code></td>';
            content += '<td><code>' + escape(website.git_root || '') + '</code></td>';
            content += '<td><code>' + escape(website.history_templates) + '</code></td>';
            content += '<td><code>' + escape(website.web_templates) + '</code></td>';
            content += '<td><code>' + escape(website.server_update_script) + '</code></td>';
            content += '<td>' + (website.is_active ? '✓' : '✗') + '</td>';
            content += '<td>' + new Date(website.created_at).toLocaleString() + '</td>';
            content += '<td><a href="/publisher/admin/websites/' + website.id + '/edit" class="btn btn-sm btn-outline-primary">Edit</a></td>';
            content += '</tr>';
          });

          content += '</tbody></table>';
          content += '</div>';
        }

        content += '</div>';
        content += '</div>';

        const html = htmlServer.renderPage('publisher', 'Websites - FHIR Publisher', content, {
          templateVars: {
            loginTitle: req.session.userId ? (req.session.userName + ' \u2014 Logout') : 'Login',
            loginPath: req.session.userId ? "logout" : 'login',
            loginAction: req.session.userId ? "POST" : 'GET'
          }});
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
      } catch (error) {
        this.logger.error('Error rendering websites:', error);
        res.status(500).send('Internal server error');
      }
    } finally {
      this.stats.countRequest('websites', Date.now() - start);
    }
  }

  async createWebsite(req, res) {
    const start = Date.now();
    try {
      try {
        const {name, local_folder,  git_root, history_templates, web_templates, server_update_script} = req.body;

        await new Promise((resolve, reject) => {
          this.db.run(
              'INSERT INTO websites (name, local_folder,  git_root, history_templates, web_templates, server_update_script) VALUES (?, ?, ?, ?, ?, ?)',
              [name, local_folder, git_root, history_templates, web_templates, server_update_script],
              function (err) {
                if (err) reject(err);
                else resolve();
              }
          );
        });

        this.logUserAction(req.session.userId, 'create_website', name, req.ip);
        this.logger.info('Website created: ' + name + ' by user ' + req.session.userId);

        res.redirect('/publisher/admin/websites');
      } catch (error) {
        this.logger.error('Error creating website:', error);
        res.status(500).send('Failed to create website');
      }
    } finally {
      this.stats.countRequest('website', Date.now() - start);
    }
  }

  async renderUsers(req, res) {
    const start = Date.now();
    try {


      try {
        const htmlServer = require('../library/html-server');
        const users = await this.getUsers();
        const websites = await this.getWebsites();

        let content = '<div class="row mb-4">';

        // Add user form
        content += '<div class="col-12 mb-4">';
        content += '<button class="btn btn-primary" onclick="document.getElementById(\'add-user-panel\').style.display = document.getElementById(\'add-user-panel\').style.display === \'none\' ? \'block\' : \'none\'">Add New User</button>';
        content += '<div id="add-user-panel" style="display: none;" class="mt-3">';
        content += '<h3>Add New User</h3>';
        content += '<form method="post" action="/publisher/admin/users" class="row g-3">';
        content += '<div class="col-md-3">';
        content += '<label for="name" class="form-label">Full Name</label>';
        content += '<input type="text" class="form-control" id="name" name="name" required>';
        content += '</div>';
        content += '<div class="col-md-3">';
        content += '<label for="login" class="form-label">Username</label>';
        content += '<input type="text" class="form-control" id="login" name="login" required>';
        content += '</div>';
        content += '<div class="col-md-3">';
        content += '<label for="password" class="form-label">Password</label>';
        content += '<input type="password" class="form-control" id="password" name="password" required>';
        content += '</div>';
        content += '<div class="col-md-3 d-flex align-items-end">';
        content += '<div class="form-check">';
        content += '<input class="form-check-input" type="checkbox" id="is_admin" name="is_admin">';
        content += '<label class="form-check-label" for="is_admin">Administrator</label>';
        content += '</div>';
        content += '</div>';
        content += '<div class="col-12">';
        content += '<button type="submit" class="btn btn-primary">Add User</button>';
        content += '</div>';
        content += '</form>';
        content += '</div>'; // add-user-panel
        content += '</div>';

        // Users list
        content += '<div class="col-12">';
        content += '<h3>Users & Permissions</h3>';

        if (users.length === 0) {
          content += '<p>No users found.</p>';
        } else {
          for (const user of users) {
            const permissions = await this.getUserPermissions(user.id);

            content += '<div class="card mb-3">';
            content += '<div class="card-header">';
            content += '<h5>' + escape(user.name) + ' (' + escape(user.login) + ') ' + (user.is_admin ? '<span class="badge bg-warning">Admin</span>' : '') + '</h5>';
            content += '</div>';
            content += '<div class="card-body">';

            if (websites.length === 0) {
              content += '<p>No websites available for permission assignment.</p>';
            } else {
              content += '<form method="post" action="/publisher/admin/permissions">';
              content += '<input type="hidden" name="user_id" value="' + user.id + '">';
              content += '<div class="permission-grid">';
              content += '<div><strong>Website</strong></div>';
              content += '<div><strong>Can Queue</strong></div>';
              content += '<div><strong>Can Approve</strong></div>';

              websites.forEach(website => {
                const perm = permissions.find(p => p.website_id === website.id) || {};
                content += '<div>' + escape(website.name) + '</div>';
                content += '<div>';
                content += '<input type="checkbox" name="queue_' + website.id + '"' + (perm.can_queue ? ' checked' : '') + '>';
                content += '</div>';
                content += '<div>';
                content += '<input type="checkbox" name="approve_' + website.id + '"' + (perm.can_approve ? ' checked' : '') + '>';
                content += '</div>';
              });

              content += '</div>';
              content += '<div class="mt-3">';
              content += '<button type="submit" class="btn btn-secondary btn-sm">Update Permissions</button>';
              content += '</div>';
              content += '</form>';
            }

            content += '</div>';
            content += '</div>';
          }
        }

        content += '</div>';
        content += '</div>';

        const html = htmlServer.renderPage('publisher', 'Users - FHIR Publisher', content, {
          templateVars: {
            loginTitle: req.session.userId ? (req.session.userName + ' \u2014 Logout') : 'Login',
            loginPath: req.session.userId ? "logout" : 'login',
            loginAction: req.session.userId ? "POST" : 'GET'
          }});
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
      } catch (error) {
        this.logger.error('Error rendering users:', error);
        res.status(500).send('Internal server error');
      }
    } finally {
      this.stats.countRequest('users', Date.now() - start);
    }
  }

  async createUser(req, res) {
    const start = Date.now();
    try {
      try {
        const {name, login, password, is_admin} = req.body;

        const passwordHash = await bcrypt.hash(password, 10);

        await new Promise((resolve, reject) => {
          this.db.run(
              'INSERT INTO users (name, login, password_hash, is_admin) VALUES (?, ?, ?, ?)',
              [name, login, passwordHash, is_admin ? 1 : 0],
              function (err) {
                if (err) reject(err);
                else resolve();
              }
          );
        });

        this.logUserAction(req.session.userId, 'create_user', login, req.ip);
        this.logger.info('User created: ' + login + ' by user ' + req.session.userId);

        res.redirect('/publisher/admin/users');
      } catch (error) {
        this.logger.error('Error creating user:', error);
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
          res.status(400).send('Username already exists');
        } else {
          res.status(500).send('Failed to create user');
        }
      }
    } finally {
      this.stats.countRequest('createUser', Date.now() - start);
    }
  }

  async updatePermissions(req, res) {
    const start = Date.now();
    try {

      try {
        const {user_id} = req.body;
        const websites = await this.getWebsites();

        // Clear existing permissions
        await new Promise((resolve, reject) => {
          this.db.run('DELETE FROM user_website_permissions WHERE user_id = ?', [user_id], (err) => {
            if (err) reject(err);
            else resolve();
          });
        });

        // Add new permissions
        for (const website of websites) {
          const canQueue = req.body['queue_' + website.id] === 'on';
          const canApprove = req.body['approve_' + website.id] === 'on';

          if (canQueue || canApprove) {
            await new Promise((resolve, reject) => {
              this.db.run(
                  'INSERT INTO user_website_permissions (user_id, website_id, can_queue, can_approve) VALUES (?, ?, ?, ?)',
                  [user_id, website.id, canQueue ? 1 : 0, canApprove ? 1 : 0],
                  (err) => {
                    if (err) reject(err);
                    else resolve();
                  }
              );
            });
          }
        }

        this.logUserAction(req.session.userId, 'update_permissions', user_id, req.ip);
        res.redirect('/publisher/admin/users');
      } catch (error) {
        this.logger.error('Error updating permissions:', error);
        res.status(500).send('Failed to update permissions');
      }
    } finally {
      this.stats.countRequest('update', Date.now() - start);
    }
  }

  // Helper methods
  async getTasks(limit = null) {
    return new Promise((resolve, reject) => {
      let sql = 'SELECT t.*, u.name as user_name, w.name as website_name, approver.name as approved_by_name FROM tasks t JOIN users u ON t.user_id = u.id JOIN websites w ON t.website_id = w.id LEFT JOIN users approver ON t.approved_by = approver.id ORDER BY t.queued_at DESC';

      if (limit) {
        sql += ' LIMIT ' + limit;
      }

      this.db.all(sql, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  }

  async getTask(taskId) {
    return new Promise((resolve, reject) => {
      this.db.get(
          'SELECT t.*, u.name as user_name, u.login as user_login, w.name as website_name, approver.name as approved_by_name FROM tasks t JOIN users u ON t.user_id = u.id JOIN websites w ON t.website_id = w.id LEFT JOIN users approver ON t.approved_by = approver.id WHERE t.id = ?',
          [taskId],
          (err, row) => {
            if (err) reject(err);
            else resolve(row);
          }
      );
    });
  }

  async getTaskLogs(taskId) {
    return new Promise((resolve, reject) => {
      this.db.all(
          'SELECT * FROM task_logs WHERE task_id = ? ORDER BY timestamp ASC',
          [taskId.toString()],
          (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
          }
      );
    });
  }

  async getTaskActions(taskId) {
    return new Promise((resolve, reject) => {
      this.db.all(
          'SELECT ua.*, u.name as user_name, u.login as user_login FROM user_actions ua LEFT JOIN users u ON ua.user_id = u.id WHERE ua.target_id = ? ORDER BY ua.timestamp ASC',
          [taskId.toString()],
          (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
          }
      );
    });
  }

  async getUserWebsites(userId) {
    return new Promise((resolve, reject) => {
      this.db.all(
          'SELECT w.* FROM websites w JOIN user_website_permissions p ON w.id = p.website_id WHERE p.user_id = ? AND p.can_queue = 1 AND w.is_active = 1',
          [userId],
          (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
          }
      );
    });
  }

  async userCanQueue(userId, websiteId) {
    return new Promise((resolve, reject) => {
      this.db.get(
          'SELECT can_queue FROM user_website_permissions WHERE user_id = ? AND website_id = ?',
          [userId, websiteId],
          (err, row) => {
            if (err) reject(err);
            else resolve(row && row.can_queue);
          }
      );
    });
  }

  async userCanApprove(userId, websiteId) {
    return new Promise((resolve, reject) => {
      this.db.get(
          'SELECT can_approve FROM user_website_permissions WHERE user_id = ? AND website_id = ?',
          [userId, websiteId],
          (err, row) => {
            if (err) reject(err);
            else resolve(row && row.can_approve);
          }
      );
    });
  }

  async findActiveTask(packageId, version) {
    return new Promise((resolve, reject) => {
      this.db.get(
          'SELECT * FROM tasks WHERE npm_package_id = ? AND version = ? AND status NOT IN (?, ?) ORDER BY queued_at DESC LIMIT 1',
          [packageId, version, 'complete', 'failed'],
          (err, row) => {
            if (err) reject(err);
            else resolve(row);
          }
      );
    });
  }

  async findExistingTask(packageId, version) {
    return new Promise((resolve, reject) => {
      this.db.get(
          'SELECT * FROM tasks WHERE npm_package_id = ? AND version = ? ORDER BY queued_at DESC LIMIT 1',
          [packageId, version],
          (err, row) => {
            if (err) reject(err);
            else resolve(row);
          }
      );
    });
  }

  async getWebsites() {
    return new Promise((resolve, reject) => {
      this.db.all('SELECT * FROM websites ORDER BY name', (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  }

  async getWebsite(websiteId) {
    return new Promise((resolve, reject) => {
      this.db.get('SELECT * FROM websites WHERE id = ?', [websiteId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  async runCommand(command, args, options, taskId, description) {
    const { spawn } = require('child_process');

    await this.logTaskMessage(taskId, 'info', description);

    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        ...options
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', async (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          const error = description + ' failed with code ' + code + ': ' + (stderr || stdout);
          await this.logTaskMessage(taskId, 'error', error);
          reject(new Error(error));
        }
      });

      proc.on('error', async (error) => {
        await this.logTaskMessage(taskId, 'error', description + ' error: ' + error.message);
        reject(error);
      });
    });
  }

  async getUsers() {
    return new Promise((resolve, reject) => {
      this.db.all('SELECT id, name, login, is_admin, created_at FROM users ORDER BY name', (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  }

  async getUserPermissions(userId) {
    return new Promise((resolve, reject) => {
      this.db.all(
          'SELECT * FROM user_website_permissions WHERE user_id = ?',
          [userId],
          (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
          }
      );
    });
  }

  async shutdown() {
    this.logger.info('Shutting down publisher module...');

    // Stop accepting new tasks
    this.shutdownRequested = true;

    // Stop the task processor
    this.stopTaskProcessor();

    // Wait for current task to finish (with timeout)
    const maxWaitTime = 30000; // 30 seconds
    const startTime = Date.now();

    while (this.isProcessing && (Date.now() - startTime) < maxWaitTime) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    if (this.isProcessing) {
      this.logger.warn('Task processor did not finish within timeout period');
    }

    // Close database
    if (this.db) {
      return new Promise((resolve) => {
        this.db.close((err) => {
          if (err) {
            this.logger.error('Error closing database:', err);
          } else {
            this.logger.info('Database closed');
          }
          resolve();
        });
      });
    }
  }

  getStatusColor(status) {
    const colors = {
      'queued': 'secondary',
      'building': 'warning',
      'waiting for approval': 'info',
      'publishing': 'warning',
      'complete': 'success',
      'failed': 'danger'
    };
    return colors[status] || 'secondary';
  }

  // Fire-and-forget audit logging: callers don't await this, and it must never fail a
  // request, so it returns void and swallows any DB error in the callback.
  logUserAction(userId, action, targetId, ipAddress) {
    this.db.run(
        'INSERT INTO user_actions (user_id, action, target_id, ip_address) VALUES (?, ?, ?, ?)',
        [userId, action, targetId, ipAddress],
        () => {} // don't fail (or block) the request if audit logging fails
    );
  }

  getStatus() {
    return {
      enabled: true,
      status: this.db ? 'Running' : 'Database not connected',
      taskProcessor: {
        running: this.taskProcessor !== null,
        processing: this.isProcessing,
        shutdownRequested: this.shutdownRequested
      }
    };
  }

}

module.exports = PublisherModule;