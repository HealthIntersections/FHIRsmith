const fs = require('fs');
const path = require('path');
const folders = require('./folder-setup');

// ---------------------------------------------------------------------------
// Buffered, daily-rotating logger
//   - Writes are batched and flushed every FLUSH_INTERVAL ms or FLUSH_SIZE lines
//   - this is intended to be highly efficient
// ---------------------------------------------------------------------------

const DEFAULTS = {
  level:          'info',       // error, warn, info, debug, verbose
  console:        true,         // write to stdout/stderr
  consoleErrors:  false,        // include error/warn on console (when running as service, these go to journal)
  maxFiles:       14,           // number of daily log files to keep
  maxSize:        0,            // max bytes per file (0 = unlimited)
  flushInterval:  2000,         // ms between flushes
  flushSize:      200,          // flush when buffer reaches this many lines
};

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3, verbose: 4 };

class Logger {
  static _instance = null;

  static getInstance(options = {}) {
    if (!Logger._instance) {
      Logger._instance = new Logger(options);
    }
    return Logger._instance;
  }

  // options = config.logging section from config.json (all fields optional)
  //
  // Example config.json:
  //   {
  //     "logging": {
  //       "level": "info",
  //       "console": false,
  //       "consoleErrors": false,
  //       "maxFiles": 14,
  //       "maxSize": "50m",
  //       "flushInterval": 2000,
  //       "flushSize": 200
  //     }
  //   }
  //
  constructor(options = {}) {
    this.level = options.level || DEFAULTS.level;
    this.logDir = options.logDir || folders.logsDir();
    this.maxFiles = options.maxFiles ?? DEFAULTS.maxFiles;
    this.maxSize = Logger._parseSize(options.maxSize) || DEFAULTS.maxSize;
    this.showConsole = options.console ?? DEFAULTS.console;
    this.consoleErrors = options.consoleErrors ?? DEFAULTS.consoleErrors;

    const flushInterval = options.flushInterval ?? DEFAULTS.flushInterval;
    this._flushSize = options.flushSize ?? DEFAULTS.flushSize;

    // Ensure log directory exists
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }

    // Buffer
    this._buffer = [];
    this._currentDate = null;
    this._fd = null;
    this._currentFileSize = 0;

    // Periodic flush
    this._flushTimer = setInterval(() => this._flush(), flushInterval);
    if (this._flushTimer.unref) this._flushTimer.unref(); // don't keep process alive

    // Flush on exit
    process.on('exit', () => this._flushSync());

    this.info('Logger initialized @ ' + this.logDir, {});
  }

  // Parse human-readable size strings: "20m" -> bytes, "1g" -> bytes
  static _parseSize(value) {
    if (!value) return 0;
    if (typeof value === 'number') return value;
    const m = String(value).match(/^(\d+(?:\.\d+)?)\s*([kmg])?b?$/i);
    if (!m) return 0;
    const num = parseFloat(m[1]);
    switch ((m[2] || '').toLowerCase()) {
      case 'k': return num * 1024;
      case 'm': return num * 1024 * 1024;
      case 'g': return num * 1024 * 1024 * 1024;
      default:  return num;
    }
  }

  // Compatibility: server.js home page reads Logger.getInstance().options.file.maxFiles etc.
  get options() {
    return {
      level: this.level,
      file: {
        maxFiles: this.maxFiles,
        maxSize: this.maxSize > 0 ? `${Math.round(this.maxSize / 1024 / 1024)}m` : 'unlimited',
      }
    };
  }

  // --- formatting (inline, no libraries) ---

  _timestamp() {
    const d = new Date();
    const Y = d.getFullYear();
    const M = String(d.getMonth() + 1).padStart(2, '0');
    const D = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    const s = String(d.getSeconds()).padStart(2, '0');
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    return `${Y}-${M}-${D} ${h}:${m}:${s}.${ms}`;
  }

  _dateTag() {
    const d = new Date();
    const Y = d.getFullYear();
    const M = String(d.getMonth() + 1).padStart(2, '0');
    const D = String(d.getDate()).padStart(2, '0');
    return `${Y}-${M}-${D}`;
  }

  _formatLine(level, message, stack) {
    const ts = this._timestamp();
    const lv = level.padEnd(7);
    let line = `${ts} ${lv} ${message}\n`;
    if (stack) line += stack + '\n';
    return line;
  }

  // --- file management ---

  _openFile(dateTag) {
    // Check if we need to rotate due to size
    if (this._fd !== null && this._currentDate === dateTag) {
      if (this.maxSize <= 0 || this._currentFileSize < this.maxSize) return;
      // Size limit exceeded — close and fall through to open a new file
      try { fs.closeSync(this._fd); } catch (_) { /* intentional */ }
      this._fd = null;
    }
    // Close previous (date changed)
    if (this._fd !== null) {
      try { fs.closeSync(this._fd); } catch (_) { /* intentional */ }
    }
    const filename = `server-${dateTag}.log`;
    const filePath = path.join(this.logDir, filename);
    this._fd = fs.openSync(filePath, 'a');
    try { this._currentFileSize = fs.fstatSync(this._fd).size; } catch (_) { this._currentFileSize = 0; }
    this._currentDate = dateTag;

    // Maintain a stable symlink so `tail -f server.log` always tracks the current file
    const linkPath = path.join(this.logDir, 'server.log');
    try { fs.unlinkSync(linkPath); } catch (_) { /* intentional */ }
    try { fs.symlinkSync(filename, linkPath); } catch (_) { /* intentional */ }

    this._purgeOldFiles();
  }

  _purgeOldFiles() {
    try {
      const files = fs.readdirSync(this.logDir)
          .filter(f => f.startsWith('server-') && f.endsWith('.log'))
          .sort();
      while (files.length > this.maxFiles) {
        const old = files.shift();
        fs.unlinkSync(path.join(this.logDir, old));
      }
    } catch (_) { /* intentional */ }
  }

  // --- buffer + flush ---

  _enqueue(line) {
    this._buffer.push(line);
    if (this._buffer.length >= this._flushSize) {
      this._flush();
    }
  }

  _flush() {
    if (this._buffer.length === 0) return;
    const dateTag = this._dateTag();
    this._openFile(dateTag);
    const chunk = this._buffer.join('');
    this._buffer.length = 0;
    // Async write — fire and forget; OS will buffer anyway
    const buf = Buffer.from(chunk);
    this._currentFileSize += buf.length;
    fs.write(this._fd, buf, 0, buf.length, null, (err) => {
      if (err) {
        // If the fd went bad (e.g. date rolled), reopen and retry once
        try {
          this._currentDate = null;
          this._openFile(this._dateTag());
          fs.writeSync(this._fd, buf, 0, buf.length);
        } catch (_) { /* intentional */ }
      }
    });
  }

  _flushSync() {
    if (this._buffer.length === 0) return;
    const dateTag = this._dateTag();
    this._openFile(dateTag);
    const chunk = this._buffer.join('');
    this._buffer.length = 0;
    try { fs.writeSync(this._fd, chunk); } catch (_) { /* intentional */ }
  }

  // --- core log ---

  _shouldLog(level) {
    return (LEVELS[level] ?? 99) <= (LEVELS[this.level] ?? 2);
  }

  _log(level, messageOrError, meta, options) {
    if (!this._shouldLog(level)) return;

    let message;
    let stack;

    if (messageOrError instanceof Error) {
      message = messageOrError.message;
      // Expected, client-facing errors - an OperationOutcome/Issue carrying a 4xx
      // statusCode (e.g. "code not found", "cache-id unknown", "code system not
      // found") - are the answer to the request, which the request's own log line
      // already records (its status). Logged as errors or warnings, they are noise:
      // they appear only when debug logging is enabled. Genuinely unexpected errors
      // (5xx, or no statusCode at all) are logged, with their stack.
      const sc = messageOrError.statusCode;
      const expected = typeof sc === 'number' && sc >= 400 && sc < 500;
      if (expected && (level === 'error' || level === 'warn') && !this._shouldLog('debug')) {
        return;
      }
      stack = messageOrError.stack;
    } else {
      message = String(messageOrError);
      stack = meta?.stack;
    }

    const line = this._formatLine(level, message, stack);

    // Buffer for file
    this._enqueue(line);

    // Console
    if (this.showConsole) {
      const isErrWarn = level === 'error' || level === 'warn';
      const consoleErrors = options?.consoleErrors ?? this.consoleErrors;
      if (!isErrWarn || consoleErrors) {
        if (isErrWarn) {
          process.stderr.write(line);
        } else {
          process.stdout.write(line);
        }
      }
    }
  }

  // --- public API (same as before) ---

  error(message, meta = {}) { this._log('error', message, meta, this); }
  warn(message, meta = {})  { this._log('warn', message, meta, this); }
  info(message, meta = {})  { this._log('info', message, meta, this); }
  debug(message, meta = {}) { this._log('debug', message, meta, this); }
  verbose(message, meta = {}) { this._log('verbose', message, meta, this); }

  log(level, message, meta = {}) { this._log(level, message, meta, this); }

  child(defaultMeta = {}) {
    const self = this;

    const childOptions = {
      consoleErrors: defaultMeta.consoleErrors ?? self.consoleErrors,
    };

    const modulePrefix = defaultMeta.module ? `{${defaultMeta.module}}` : null;

    const wrap = (level) => (messageOrError, meta = {}) => {
      if (messageOrError instanceof Error) {
        // (the statusCode goes with it: it decides whether the error is logged - see _log)
        const prefixed = modulePrefix
            ? Object.assign(new Error(`${modulePrefix}: ${messageOrError.message}`), { stack: messageOrError.stack, statusCode: messageOrError.statusCode })
            : messageOrError;
        self._log(level, prefixed, meta, childOptions);
      } else {
        const msg = modulePrefix ? `${modulePrefix}: ${messageOrError}` : String(messageOrError);
        self._log(level, msg, meta, childOptions);
      }
    };

    return {
      error: wrap('error'),
      warn:  wrap('warn'),
      info:  wrap('info'),
      debug: wrap('debug'),
      verbose: wrap('verbose'),
      log: (level, message, meta = {}) => wrap(level)(message, meta)
    };
  }

  // Apply config.logging to a logger that is already running (the server starts logging with the
  // defaults before config.json is read). Same options as the constructor; anything not given keeps
  // its default
  configure(options = {}) {
    this._flushSync();
    this.level = options.level || DEFAULTS.level;
    this.maxFiles = options.maxFiles ?? DEFAULTS.maxFiles;
    this.maxSize = Logger._parseSize(options.maxSize) || DEFAULTS.maxSize;
    this.showConsole = options.console ?? DEFAULTS.console;
    this.consoleErrors = options.consoleErrors ?? DEFAULTS.consoleErrors;
    this._flushSize = options.flushSize ?? DEFAULTS.flushSize;

    clearInterval(this._flushTimer);
    this._flushTimer = setInterval(() => this._flush(), options.flushInterval ?? DEFAULTS.flushInterval);
    if (this._flushTimer.unref) this._flushTimer.unref();

    if (options.logDir && path.resolve(options.logDir) !== path.resolve(this.logDir)) {
      if (this._fd !== null) {
        try { fs.closeSync(this._fd); } catch (_) { /* intentional */ }
      }
      this._fd = null;
      this._currentDate = null;
      this._currentFileSize = 0;
      this.logDir = options.logDir;
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true });
      }
    }
    this.info('Logger configured @ ' + this.logDir + ', level ' + this.level, {});
  }

  setLevel(level) {
    this.level = level;
    this.info(`Log level changed to ${level}`);
  }

  setConsoleErrors(enabled) {
    this.consoleErrors = enabled;
    this.info(`Console errors ${enabled ? 'enabled' : 'disabled'}`);
  }

  stream() {
    return {
      write: (message) => {
        this.info(message.trim());
      }
    };
  }

  // Force an immediate flush (e.g. before graceful shutdown)
  flush() {
    this._flushSync();
  }
}

module.exports = Logger;