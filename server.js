#!/usr/bin/env node

//
// Copyright 2025, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// Production unless told otherwise: Express and other libraries check NODE_ENV (in development
// mode Express's error pages include stack traces), and a server where nobody set it should get
// the safe behaviour. `npm run dev` (node --watch) runs in development mode
process.env.NODE_ENV ??= process.execArgv.includes('--watch') ? 'development' : 'production';

// node server.js --check (or -t, as nginx has it): check the configuration - config.json, the
// files it names, the folders the server writes to, and with --role what the role makes of it -
// print what's wrong, and exit 0 if nothing is, 1 if something is. Before anything else, so
// nothing is made, logged or started (library/config-check.js)
if (require('./library/config-check').wantsCheck(process.argv.slice(2))) {
  process.exit(require('./library/config-check').runCheck(process.argv.slice(2)));
}

// Logging starts before anything else, so that a server that fails to start (bad config.json, a
// missing dependency, an unwritable folder) says why in the log as well as on stderr. It starts with
// the logger defaults; config.logging is applied once config.json has been read
const folders = require('./library/folder-setup');
const { boundedWeakETag } = require('./library/etags');
const Logger = require('./library/logger');
let bootLog;
try {
  bootLog = Logger.getInstance().child({ module: 'server' });
} catch (error) {
  console.error('Failed to start logging:', error.message);
  process.exit(1);
}
bootLog.info(`FHIRsmith starting (PID ${process.pid}, Node.js ${process.version}), data directory ${folders.dataDir()}`);

// Until startup is complete, an uncaught exception is fatal: log it and exit (the logger flushes on exit).
// Replaced by the long-running handlers once the server is set up
function startupFailure(error) {
  console.error('FATAL - startup failed:', error);
  bootLog.error('FATAL - startup failed: ' + (error?.message || error), error);
  process.exit(1);
}
process.on('uncaughtException', startupFailure);

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { statSync, readdirSync } = require('fs');
const escape = require('escape-html');
const { resolveWithin } = require('./library/path-safety');
const { readProcessMemory } = require('./library/cgroup-memory');
const memoryGuard = require('./library/memory-guard');
const { applyKeepAliveTimeouts } = require('./library/keep-alive');
const { countStaticResponses } = require('./library/static-response-stats');
const { trimNativeMemory } = require('./library/native-memory');
const { NpmAudit } = require('./library/npm-audit');
const Mailer = require('./library/mailer');
const DailyReport = require('./library/daily-report');
const { maxBodyBytes } = require('./library/body-limit');

// Load configuration (from the data directory)
let config;
const configPath = folders.filePath('config.json');
bootLog.info(`Reading configuration from ${configPath}`);
try {
  // JSON, with // and /* */ comments allowed (library/config-reader.js)
  config = require('./library/config-reader').readConfig(configPath);
  // the server block is optional (every setting in it has a default)
  config.server = config.server || {};
} catch (error) {
  console.error(`Failed to load configuration from ${configPath}:`, error.message);
  bootLog.error(`Failed to load configuration from ${configPath}: ${error.message}`);
  process.exit(1);
}

// what --check would say about it (library/config-check.js): logged once logging is configured,
// below. Checked before the role changes it. Nothing here stops the server - what it can't run
// with, it refuses as it starts, as before
let configReport = null;
try {
  configReport = require('./library/config-check').checkParsedConfig(config, { dataDir: folders.dataDir(), environment: false });
} catch (error) {
  bootLog.warn(`The configuration couldn't be checked: ${error.message}`);
}

// --role=master|tx-worker (cluster.md). With no role this is null and the configuration is
// untouched: every `if (role)` below is skipped
const { parseRole, applyRole, describeRole } = require('./library/role');
let role;
try {
  role = parseRole(process.argv.slice(2), process.env);
  if (role) {
    applyRole(config, role);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

Logger.getInstance().configure(config.logging || {});
const serverLog = Logger.getInstance().child({ module: 'server' });
if (configReport) {
  for (const e of configReport.errors) {
    serverLog.error(`Configuration: ${e.where}: ${e.message}`);
  }
  for (const e of configReport.warnings) {
    serverLog.warn(`Configuration: ${e.where}: ${e.message}`);
  }
  if (!configReport.ok || configReport.warnings.length) {
    serverLog.warn('Configuration: node server.js --check reports on the configuration without starting the server');
  }
}
const packageJson = require('./package.json');

// Startup banner
const totalMemGB = (os.totalmem() / 1024 / 1024 / 1024).toFixed(1);
const freeMemGB = (os.freemem() / 1024 / 1024 / 1024).toFixed(1);
serverLog.info(`========================================`);
serverLog.info(`FHIRsmith v${packageJson.version} starting (PID ${process.pid})`);
serverLog.info(`Node.js ${process.version} on ${os.type()} ${os.release()} (${os.arch()})`);
serverLog.info(`Memory: ${freeMemGB} GB free / ${totalMemGB} GB total`);
memoryGuard.configure(config.server.memory || {});
serverLog.info(memoryGuard.describe());
if (role) {
  serverLog.info(describeRole(role, config));
}
serverLog.info(`Data directory: ${folders.dataDir()}`);
serverLog.info(`========================================`);

const activeModules = config.modules ? Object.keys(config.modules)
    .filter(mod => config.modules[mod]?.enabled)
    .join(', ') : [];
serverLog.info(`Loaded Configuration. Active modules = ${activeModules}`);

// Import modules
const SHLModule = require('./shl/shl.js');
const VCLModule = require('./vcl/vcl.js');
const xigModule = require('./xig/xig.js');
const PackagesModule = require('./packages/packages.js');
const RegistryModule = require('./registry/registry.js');
const PublisherModule = require('./publisher/publisher.js');
const TokenModule = require('./token/token.js');
const NpmProjectorModule = require('./npmprojector/npmprojector.js');
const TXModule = require('./tx/tx.js');
const TestingModule = require('./testing/testing.js');
const IpsModule = require('./ips/ips.js');

const htmlServer = require('./library/html-server');
const ServerStats = require("./stats");
const { connectMetrics, graphData, externalSummary } = require('./library/cluster-metrics');
const { connectCounts } = require('./library/cluster-counts');
const { startStallWatchdog } = require('./library/stall-watchdog');
const { connectClusterEvents } = require('./library/cluster-events');
const { connectStatus, ownFigures, clusterView, processView, storageView, clusterSummary, processSummary, STATUS_INTERVAL_MS } = require('./library/cluster-status');
const {Liquid} = require("liquidjs");
const FolderModule = require("./folder/folder");
const ExtensionTrackerModule = require("./extension-tracker/extension-tracker");

htmlServer.useLog(serverLog);
htmlServer.setSponsorMessage(config.sponsorMessage ? config.sponsorMessage : '');
htmlServer.setAccessibilityPanel(config.accessibility?.checkPanel === true);

const app = express();

// Behind nginx (or any reverse proxy): honor X-Forwarded-* so req.protocol and
// req.hostname reflect what the client actually requested, not the loopback hop.
// Only proxies on the same host or a private network are trusted by default. `true` would
// trust every X-Forwarded-For hop, so anyone who could reach the port directly could name
// their own IP address and walk around every rate limit (express-rate-limit refuses to be
// quiet about it: ERR_ERL_PERMISSIVE_TRUST_PROXY). See nginx.md.
const DEFAULT_TRUST_PROXY = 'loopback, linklocal, uniquelocal';
app.set('trust proxy', config.server.trustProxy ?? DEFAULT_TRUST_PROXY);
// Express's weak ETag, but not for large bodies: hashing them costs more than it's worth (library/etags.js)
app.set('etag', boundedWeakETag());

const PORT = (role && role.port) || process.env.PORT || config.server.port || 3000;
// with a role, loopback unless server.cluster.bindAddress says otherwise (cluster.md); with
// none, every interface, as before
const HOST = role ? require('./library/role').bindAddress(config) : null;

// Middleware
// The requests this process has in flight, for the status panel (library/cluster-status.js)
let inFlight = 0;
app.use((req, res, next) => {
  inFlight++;
  let done = false;
  const finished = () => {
    if (!done) {
      done = true;
      inFlight--;
    }
  };
  res.once('finish', finished);
  res.once('close', finished);
  next();
});
// Refuse new requests (503) while memory is near the limit - first, so a refused request
// doesn't even have its body parsed. /dashboard stays reachable so the state can be seen.
app.use(memoryGuard.middleware({ log: serverLog, exempt: ['/dashboard'],
  onReject: role ? () => stats?.countRefusedRequest() : undefined }));
// The body parsers, for every module but those that read their own bodies with their own
// limits and checks (the ips module: a document is read only once its submitter's token has
// been checked, and no bigger than the module's maxSize)
const OWN_BODIES = ['/ips'];
const ownsBody = (req) => OWN_BODIES.some(p => req.path === p || req.path.startsWith(p + '/'));
const unlessOwnBody = (parser) => (req, res, next) => (ownsBody(req) ? next() : parser(req, res, next));
// Bodies up to server.maxBodyMB (default 50); a bigger one gets a 413
const maxBody = maxBodyBytes(config.server);
app.use(unlessOwnBody(express.raw({ type: 'application/fhir+json', limit: maxBody })));
app.use(unlessOwnBody(express.raw({ type: 'application/fhir+xml', limit: maxBody })));
app.use(unlessOwnBody(express.json({ limit: maxBody })));
app.use((req, res, next) => {
  const requestId = req.headers['x-request-id'];
  if (requestId) {
    res.setHeader('X-Request-Id', requestId);
  }
  next();
});

// Single, app-level CORS policy for all modules, driven by config.server.cors.
// This also handles OPTIONS preflight, so modules must NOT set their own
// Access-Control-* headers (doing so stacks a second CORS layer and produces
// duplicate, conflicting headers that browsers reject).
app.use(cors(config.server.cors));

// Module instances
const modules = {};

let stats = null;
let disconnectMetrics = () => {};
let disconnectCounts = null;
let disconnectClusterEvents = () => {};
let disconnectStatus = () => {};
// The graphs on / and /dashboard, one component for every server (library/cluster-metrics.js):
// on the master under the launcher, every process it reports; otherwise this process's own
// samples as one series, with its memory guard's refusal threshold. `level`: the graphs' titles'
function metricsTemplate(page, level = 4) {
  const label = !role ? 'This process' : `${role.role === 'master' ? 'Master' : 'Worker'} ${config.modules.tx.instanceCode}`;
  const guard = memoryGuard._state;
  // (legend: false - statusContent puts the graphs' key under "More")
  return [`cluster-${page}`, { metricsJson: graphData(stats, label, Date.now(), { rejectAt: guard.rejectAt, group: Boolean(guard.group) }), level, legend: false }];
}
// periodic npm advisory check of the installed packages - see library/npm-audit.js
let npmAudit = null;
// watches the event loop: see library/stall-watchdog.js
let stallWatchdog = null;
// the daily report, emailed at midnight when "email" and "dailyReport.to" are configured - see library/daily-report.js
let dailyReport = null;

// Initialize modules based on configuration
async function initializeModules() {
  stats = new ServerStats(config.stats, serverLog);
  if (role) {
    disconnectMetrics = connectMetrics(stats);
    // a worker's request counts go to the master's statistics (library/cluster-counts.js)
    disconnectCounts = connectCounts(stats, process, { role: role.role });
    // and on the master, what the launcher saw, for the daily report (library/cluster-events.js)
    disconnectClusterEvents = connectClusterEvents(stats, process, { role: role.role });
    // this process's figures for the status panel, and on the master the launcher's snapshot
    // of them all (library/cluster-status.js)
    disconnectStatus = connectStatus(stats, process, { role: role.role,
      intervalMs: Number(config.server.cluster?.statusSeconds ?? STATUS_INTERVAL_MS / 1000) * 1000,
      figures: () => ownFigures(stats, { inFlight: () => inFlight, refusing: () => memoryGuard.shouldReject() }) });
  }
  npmAudit = new NpmAudit(config.npmAudit || {}, Logger.getInstance().child({ module: 'npm-audit' }), __dirname, stats);

  // Initialize SHL module
  if (config.modules?.shl?.enabled) {
    try {
      serverLog.info('Initializing module: shl...');
      modules.shl = new SHLModule(stats.forModule('shl'));
      await modules.shl.initialize(config.modules.shl);
      app.use('/shl', modules.shl.router);
    } catch (error) {
      serverLog.error('Failed to initialize SHL module:', error);
      throw error;
    }
  }

  // Initialize VCL module
  if (config.modules?.vcl?.enabled) {
    try {
      serverLog.info('Initializing module: vcl...');
      modules.vcl = new VCLModule(stats.forModule('vcl'));
      await modules.vcl.initialize(config.modules.vcl);
      app.use('/VCL', modules.vcl.router);
    } catch (error) {
      serverLog.error('Failed to initialize VCL module:', error);
      throw error;
    }
  }

  // Initialize XIG module
  if (config.modules?.xig?.enabled) {
    try {
      serverLog.info('Initializing module: xig...');
      await xigModule.initializeXigModule(stats.forModule('xig'), config.modules.xig);
      app.use('/xig', xigModule.router);
      modules.xig = xigModule;
    } catch (error) {
      serverLog.error('Failed to initialize XIG module:', error);
      throw error;
    }
  }

  // Initialize Packages module
  if (config.modules?.packages?.enabled) {
    try {
      serverLog.info('Initializing module: packages...');
      modules.packages = new PackagesModule(stats.forModule('packages'));
      await modules.packages.initialize(config.modules.packages);
      app.use('/packages', modules.packages.router);
    } catch (error) {
      console.error('Failed to initialize Server:', error);
      serverLog.error('Failed to initialize Packages module:', error);
      throw error;
    }
  }

  // Initialize Registry module
  if (config.modules?.registry?.enabled) {
    try {
      serverLog.info('Initializing module: registry...');
      modules.registry = new RegistryModule(stats.forModule('registry'));
      await modules.registry.initialize(config.modules.registry);
      app.use('/tx-reg', modules.registry.router);
    } catch (error) {
      serverLog.error('Failed to initialize Registry module:', error);
      throw error;
    }
  }

  // Initialize Publisher module
  if (config.modules?.publisher?.enabled) {
    try {
      serverLog.info('Initializing module: publisher...');
      modules.publisher = new PublisherModule(stats.forModule('publisher'));
      await modules.publisher.initialize(config.modules.publisher);
      app.use('/publisher', modules.publisher.router);
    } catch (error) {
      serverLog.error('Failed to initialize Publisher module:', error);
      throw error;
    }
  }

  // Initialize Token module
  if (config.modules?.token?.enabled) {
    try {
      serverLog.info('Initializing module: token...');
      modules.token = new TokenModule(stats.forModule('token'));
      await modules.token.initialize(config.modules.token);
      app.use('/token', modules.token.router);
    } catch (error) {
      serverLog.error('Failed to initialize Token module:', error);
      throw error;
    }
  }

  // Initialize NpmProjector module
  if (config.modules?.npmprojector?.enabled) {
    try {
      serverLog.info('Initializing module: npmprojector...');
      modules.npmprojector = new NpmProjectorModule(stats.forModule('npmprojector'));
      await modules.npmprojector.initialize(config.modules.npmprojector);
      const basePath = NpmProjectorModule.getBasePath(config.modules.npmprojector);
      app.use(basePath, modules.npmprojector.router);
    } catch (error) {
      serverLog.error('Failed to initialize NpmProjector module:', error);
      throw error;
    }
  }


  if (config.modules?.['ext-tracker']?.enabled) {
    try {
      serverLog.info('Initializing module: ext-tracker...');
      modules.extTracker = new ExtensionTrackerModule(stats.forModule('ext-tracker'));
      await modules.extTracker.initialize(config.modules['ext-tracker'], app);
    } catch (error) {
      serverLog.error('Failed to initialize extension tracker module:', error);
      throw error;
    }
  }
  if (config.modules?.testing?.enabled) {
    try {
      serverLog.info('Initializing module: testing...');
      modules.testing = new TestingModule(stats.forModule('testing'));
      await modules.testing.initialize(config.modules.testing);
      app.use('/testing', modules.testing.router);
    } catch (error) {
      serverLog.error('Failed to initialize testing module:', error);
      throw error;
    }
  }
  if (config.modules?.ips?.enabled) {
    try {
      serverLog.info('Initializing module: ips...');
      // sharing through this server's own shl module: its password, unless the ips
      // configuration names an SHL server of its own
      if (config.modules.ips.shl && !config.modules.ips.shl.password && config.modules.shl?.password) {
        config.modules.ips.shl = { server: '/shl', ...config.modules.ips.shl, password: config.modules.shl.password };
      }
      modules.ips = new IpsModule(stats.forModule('ips'));
      await modules.ips.initialize(config.modules.ips, app);
      app.use('/ips', modules.ips.router);
    } catch (error) {
      serverLog.error('Failed to initialize ips module:', error);
      throw error;
    }
  }

  // Initialize TX module
  // Note: TX module registers its own endpoints directly on the app
  // because it supports multiple endpoints at different paths
  if (config.modules?.tx?.enabled) {
    try {
      serverLog.info('Initializing module: tx...');
      modules.tx = new TXModule(stats.forModule('tx'));
      await modules.tx.initialize(config.modules.tx, app, { hostName: config.hostName });
    } catch (error) {
      serverLog.error('Failed to initialize TX module:', error);
      throw error;
    }
  }

  if (config.modules?.folder?.enabled) {
    try {
      serverLog.info('Initializing module: folder...');
      modules.folder = new FolderModule(stats.forModule('folder'));
      await modules.folder.initialize(config.modules.folder, app);
      // mount the router
    } catch (error) {
      serverLog.error('Failed to initialize folder module:', error);
      throw error;
    }
  }
}

async function loadTemplates() {
  htmlServer.useLog(serverLog);

  try {
    // Load Root template
    const rootTemplatePath = path.join(__dirname, 'root-template.html');
    htmlServer.loadTemplate('root', rootTemplatePath);

    // Load XIG template
    const xigTemplatePath = path.join(__dirname, 'xig', 'xig-template.html');
    htmlServer.loadTemplate('xig', xigTemplatePath);

    // Load Packages template
    const packagesTemplatePath = path.join(__dirname, 'packages', 'packages-template.html');
    htmlServer.loadTemplate('packages', packagesTemplatePath);

    const registryTemplatePath = path.join(__dirname, 'registry', 'registry-template.html');
    htmlServer.loadTemplate('registry', registryTemplatePath);

    const publisherTemplatePath = path.join(__dirname, 'publisher', 'publisher-template.html');
    htmlServer.loadTemplate('publisher', publisherTemplatePath);

    // Load Token template
    const tokenTemplatePath = path.join(__dirname, 'token', 'token-template.html');
    htmlServer.loadTemplate('token', tokenTemplatePath);

  } catch (error) {
    serverLog.error('Failed to load templates:', error);
    // Don't fail initialization if templates fail to load
  }
}

// The request count in /dashboard/status.json: on the master under the launcher, what its
// statistics hold, its own and the workers' it has merged (library/cluster-counts.js), which
// arrive up to a minute late; otherwise this process's
function requestCounts() {
  if (role && role.role === 'master' && process.send) {
    return {
      count: stats.requestCount + stats.mergedRequestCount,
      detail: `master: ${stats.requestCount}, workers: ${stats.mergedRequestCount}, static: ${stats.staticRequestCount}`
    };
  }
  return { count: stats.requestCount, detail: `static: ${stats.staticRequestCount}` };
}

// The status panel's view (library/cluster-status.js, tx/html/status-panel.liquid): the
// cluster's on the master under the launcher, once its first snapshot has come; else this
// process's own, labelled as what it is
function statusView() {
  const [uptime, uptimeSub] = uptimeParts(Date.now() - stats.startTime);
  const host = { used: os.totalmem() - os.freemem(), total: os.totalmem() };
  const cluster = clusterStatus();
  if (cluster) {
    return clusterView(cluster, { uptime, uptimeSub, host });
  }
  // a fresh enough measure, as the guard takes it
  memoryGuard.shouldReject();
  const g = memoryGuard._state;
  const own = readProcessMemory('self');
  const minutes = (Date.now() - stats.startTime) / 60000;
  const code = role ? config.modules.tx.instanceCode : null;
  return processView({
    figures: ownFigures(stats, { inFlight: () => inFlight, refusing: () => memoryGuard.shouldReject() }),
    uptime, uptimeSub, host, static: stats.staticRequestCount,
    avgPerMin: minutes >= 1 ? stats.requestCount / minutes : null,
    anon: own ? own.anon : null,
    guard: { measure: g.sampleRss, limit: g.limit, rejectAt: g.rejectAt, abortAt: g.abortAt, rejectFraction: g.rejectFraction,
      abortFraction: g.abortFraction, group: Boolean(g.group), fileBacked: g.excludeFileBacked }
  }, !role ? { heading: 'Server', meta: ['one process'] } : {
    heading: `${role.role === 'master' ? 'Master' : 'Worker'} ${code}`,
    meta: role.role === 'master' && process.send ? ['this process', 'waiting for the launcher\'s first snapshot'] : ['this process only']
  });
}

// Every background task, in the status panel's table style (tx/html/status-panel.liquid), in a
// box of its own that scrolls rather than the page; under "More"
function backgroundTasks(level) {
  const table = stats.taskDetails();
  return table ? `<section class="fs-status fs-status-tasks"><h${level} class="fs-status-head">All background tasks</h${level}>` +
    `<div class="fs-status-scroll">${table}</div></section>` : '';
}

// The status line at the top of / and /dashboard (tx/html/status-line.liquid): requests, uptime
// and heap, the cluster's on the master under the launcher, else this process's; and the problems
function statusLine() {
  const [uptime, uptimeSub] = uptimeParts(Date.now() - stats.startTime);
  // low disk space is a problem, and also on its own line above "More", in red (see statusContent)
  const logs = logFigures();
  const disk = logs ? logs.disk : null;
  const failedTasks = stats.failedTasks();
  const other = npmAudit && npmAudit.enabled && npmAudit.checkedAt && npmAudit.isSerious() ? [`npm audit: ${npmAudit.summary()}`] : [];
  const cluster = clusterStatus();
  if (cluster) {
    return clusterSummary(cluster, { uptime, uptimeSub, disk, failedTasks, other });
  }
  // a fresh enough measure, as the guard takes it
  memoryGuard.shouldReject();
  const g = memoryGuard._state;
  const minutes = (Date.now() - stats.startTime) / 60000;
  return processSummary({
    figures: ownFigures(stats, { inFlight: () => inFlight, refusing: () => memoryGuard.shouldReject() }),
    uptime, uptimeSub, avgPerMin: minutes >= 1 ? stats.requestCount / minutes : null,
    guard: { measure: g.sampleRss, rejectAt: g.rejectAt }, disk, failedTasks, other
  });
}

// under this share of the disk free, a warning in red above "More"
const DISK_LOW = 0.1;

// Low disk space (the disk the logs are on), as a warning in red; '' when there is enough
function diskWarning() {
  const logs = logFigures();
  const disk = logs ? logs.disk : null;
  if (!disk || !(disk.total > 0) || disk.free >= DISK_LOW * disk.total) {
    return '';
  }
  const gb = (bytes) => (bytes / 2 ** 30).toFixed(1);
  return `<span style="color:#b00"><strong><span aria-hidden="true">⚠ </span>Disk space low:</strong> ` +
    `${gb(disk.free)} GB free of ${gb(disk.total)} GB (${Math.round(100 * disk.free / disk.total)}%)</span>`;
}

// The top of / and /dashboard: the status line, the graphs, the background tasks at work, one
// line of what the server needs looking at (`notes`: html, with low disk space added), then under
// "More" the graphs' key, the status panel, storage, every background task and `more` (html).
// Headings start at `level`, the page's sections' own.
async function statusContent(liquid, page, level, { notes = [], details = '', more = '' } = {}) {
  let content = await liquid.renderFile('status-line', { line: statusLine(), level });
  content += await liquid.renderFile(...metricsTemplate(page, level + 1));
  content += await liquid.renderFile('status-tasks', { tasks: stats.taskSummary(), level });
  const line = [...notes, diskWarning()].filter(Boolean);
  if (line.length) {
    content += `<div id="npm-audit" style="font-size:13px;margin:0 0 8px"><p style="margin:0 0 4px">${line.join(' · ')}</p>${details}</div>`;
  }
  content += `<details class="fs-status-more"><summary><h${level}>More</h${level}>: the graphs' key, every process, memory, storage, every background task</summary>`;
  // the graphs' key (tx/html/cluster-metrics-script.liquid puts it here)
  content += '<div id="serverMetricsLegend" class="server-metrics-legend"></div>';
  content += await liquid.renderFile('status-panel', { view: statusView(), level: level + 1 });
  const external = externalStatus();
  if (external) {
    content += await liquid.renderFile('external-metrics', { external, level: level + 1 });
  }
  content += await liquid.renderFile('status-panel', { view: storageStatusView(), level: level + 1 });
  content += backgroundTasks(level + 1);
  content += more;
  content += '</details>';
  return content;
}

// The external requests - those that had to ask another server (tx ecosystem resolution,
// ServerStats.countExternalRequest) - in the graphs' samples (every process's, on the master
// under the launcher): {count, average, span} for tx/html/external-metrics.liquid, or null if
// there have been none in them
function externalStatus(now = Date.now()) {
  const summary = externalSummary(stats, now);
  if (!summary) {
    return null;
  }
  const { count, average, hours } = summary;
  return {
    count: count.toLocaleString(),
    average: average >= 1000 ? `${(average / 1000).toFixed(1)} s` : `${Math.round(average)} ms`,
    span: hours >= 23.5 ? '24 hours' : hours >= 1.5 ? `${Math.round(hours)} hours` : hours >= 1 || Math.round(hours * 60) <= 1 ? (hours >= 1 ? 'hour' : 'minute') : `${Math.round(hours * 60)} minutes`
  };
}

// The storage tiles below the graphs: closure tables, logs, disk
function storageStatusView() {
  const logs = logFigures();
  const closure = stats.closureStats();
  return storageView({
    heading: 'Storage', closure, logs: logs && logs.files !== null ? logs : null, disk: logs && logs.disk
  });
}

// The launcher's snapshot of every process (library/cluster-status.js), on the master under
// the launcher once one has come; else null, and the table is this process's
function clusterStatus() {
  return role && role.role === 'master' && stats.clusterStatus ? stats.clusterStatus : null;
}

async function buildRootPageContent() {
  stats.requestCount++;
  let content = npmAudit ? npmAudit.renderBanner() : '';
  content += '<div class="row mb-4">';
  content += '<div class="col-12">';

  content += '<h3>Available Modules</h3>';
  content += '<ul class="list-group">';

  // Check which modules are enabled and add them to the list
  if (config.modules?.packages?.enabled) {
    content += '<li class="list-group-item">';
    content += '<a href="/packages" class="text-decoration-none">Package Server</a>: Browse and download FHIR Implementation Guide packages (<a href="/packages/openapi">API</a>)';
    content += '</li>';
  }

  if (config.modules?.xig?.enabled) {
    content += '<li class="list-group-item">';
    content += '<a href="/xig" class="text-decoration-none">FHIR IG Statistics</a>: Statistics and analysis of FHIR Implementation Guides';
    content += '</li>';
  }

  if (config.modules?.shl?.enabled) {
    content += '<li class="list-group-item">';
    content += '<a href="/shl" class="text-decoration-none">SHL Server</a>: SMART Health Links management and validation';
    content += '</li>';
  }

  if (config.modules?.vcl?.enabled) {
    content += '<li class="list-group-item">';
    content += '<a href="/VCL" class="text-decoration-none">VCL Server</a>: ValueSet Compose Language expression parsing';
    content += '</li>';
  }

  if (config.modules?.registry?.enabled) {
    content += '<li class="list-group-item">';
    content += '<a href="/tx-reg" class="text-decoration-none">Terminology Server Registry</a>: ';
    content += 'Discover and query FHIR terminology servers for code system and value set support (<a href="/tx-reg/openapi">API</a>)';
    content += '</li>';
  }

  if (config.modules?.publisher?.enabled) {
    content += '<li class="list-group-item">';
    content += '<a href="/publisher" class="text-decoration-none">FHIR Publisher</a>: ';
    content += 'Manage FHIR Implementation Guide publication tasks and approvals';
    content += '</li>';
  }

  if (config.modules?.token?.enabled) {
    content += '<li class="list-group-item">';
    content += '<a href="/token" class="text-decoration-none">Token Server</a>: ';
    content += 'OAuth authentication and API key management for FHIR services';
    content += '</li>';
  }

  if (config.modules?.npmprojector?.enabled) {
    content += '<li class="list-group-item">';
    content += '<a href="/npmprojector" class="text-decoration-none">NpmProjector</a>: ';
    content += 'Hot-reloading FHIR server with FHIRPath-based search indexes';
    content += '</li>';
  }

  if (config.modules?.['ext-tracker']?.enabled) {
    content += '<li class="list-group-item">';
    content += '<a href="/ext-tracker" class="text-decoration-none">Extension Tracker</a>: ';
    content += 'View of Extension Usage';
    content += '</li>';
  }

  if (config.modules?.testing?.enabled) {
    content += '<li class="list-group-item">';
    content += '<a href="/testing" class="text-decoration-none">Test Reports</a>: ';
    content += 'TestReports submitted by TxTester and other test tools (<a href="/testing/openapi">API</a>)';
    content += '</li>';
  }

  if (config.modules?.ips?.enabled) {
    content += '<li class="list-group-item">';
    content += '<a href="/ips" class="text-decoration-none">IPS</a>: ';
    content += 'Collections of International Patient Summary documents, each with its own FHIR endpoint';
    content += '</li>';
  }

  if (config.modules?.folder?.enabled) {
    content += '<li class="list-group-item">';
    content += '<strong>Cache Folder</strong>: ';
    content += 'Cache Folder for Kindling';
    const folders = config.modules.folder.folders || [];
    content += '<ul class="mt-2 mb-0">';
    for (const fc of folders) {
      if (fc.enabled === false) continue;
      content += '<li>';
      content += `<a href="${fc.url}" class="text-decoration-none">${fc.name}</a>: `;
      content += 'File folder with write control';
      content += '</li>';
    }
    content += '</ul>';
    content += '</li>';
  }


  if (config.modules?.tx?.enabled) {
    content += '<li class="list-group-item">';
    content += '<strong>TX Terminology Server</strong>: ';
    content += 'FHIR terminology services (CodeSystem, ValueSet, ConceptMap)';
    if (config.modules.tx.endpoints && config.modules.tx.endpoints.length > 0) {
      content += '<ul class="mt-2 mb-0">';
      for (const endpoint of config.modules.tx.endpoints) {
        // the OpenAPI description is for the R5 endpoints
        const api = String(endpoint.fhirVersion).startsWith('5') ? ` (<a href="${endpoint.path}/openapi">API</a>)` : '';
        content += `<li><a href="${endpoint.path}" class="text-decoration-none">${endpoint.path}</a> (FHIR v${endpoint.fhirVersion}${endpoint.context ? ', context: ' + endpoint.context : ''})${api}</li>`;
      }
      content += '</ul>';
    }
    content += '</li>';
  }

  content += '</ul>';

  content += '<hr/>';

  // the status line, the graphs and the tasks at work; the rest under "More" (library/cluster-status.js)
  const liquid = new Liquid({
    root: path.join(__dirname, 'tx', 'html'),
    extname: '.liquid'
  });
  content += await statusContent(liquid, 'home-metrics', 3);

  content += '</div>';
  return content;
}

// eslint-disable-next-line no-unused-vars
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
  serverLog.error('Unhandled Rejection:', reason);
});

// Once the server is listening, startup is over: an uncaught exception is logged, and the
// server carries on (startupFailure, which exits, covers everything until then - see startServer)
function startupComplete() {
  process.off('uncaughtException', startupFailure);
  process.on('uncaughtException', (error) => {
    console.error('FATAL - Uncaught Exception:', error);
    serverLog.error('FATAL - Uncaught Exception:', error);
    process.exitCode = 1;
  });
}

app.get('/', async (req, res) => {
  // If an override index.html exists, serve it instead of the FHIRsmith home page
  if (config.server?.webBase) {
    const overrideIndex = path.join(path.resolve(config.server.webBase), 'index.html');
    if (fs.existsSync(overrideIndex)) {
      return res.sendFile(overrideIndex);
    }
  }

  // Check if client wants HTML response
  const acceptsHtml = req.headers.accept && req.headers.accept.includes('text/html');

  if (acceptsHtml) {
    try {
      const startTime = Date.now();

      // Load template if not already loaded
      if (!htmlServer.hasTemplate('root')) {
        const templatePath = path.join(__dirname, 'root-template.html');
        htmlServer.loadTemplate('root', templatePath);
      }
      if (!htmlServer.hasTemplate('root-bare')) {
        const templatePath = path.join(__dirname, 'root-bare-template.html');
        htmlServer.loadTemplate('root-bare', templatePath);
      }

      const content = await buildRootPageContent();

      // Load optional about box fragment from data directory
      let about = '';
      const aboutPath = path.join(folders.dataDir(), 'about.html');
      if (fs.existsSync(aboutPath)) {
        about = fs.readFileSync(aboutPath, 'utf8');
      }

      // Build basic stats for root page
      const stats = {
        version: packageJson.version,
        enabledModules: Object.keys(config.modules).filter(m => config.modules[m]?.enabled).length,
        processingTime: Date.now() - startTime,
        about
      };

      const html = htmlServer.renderPage('root', config.hostName ? escape(config.hostName) : 'FHIRsmith Server', content, stats);
      res.setHeader('Content-Type', 'text/html');
      res.send(html);
      return;
    } catch (error) {
      serverLog.error('Error rendering root page:', error);
      htmlServer.sendErrorResponse(res, 'root', error);
      return;
    }
  } else {
    return serveFhirsmithHome(req, res);
  }
});

app.get('/fhirsmith', (req, res) => serveFhirsmithHome(req, res));

// Serve static files
// Count static file hits separately from API/page requests: only responses the static
// handlers below send themselves, not a later route's response to a request that fell through
const staticFiles = express.Router();
if (config.server?.webBase) {
  const overrideDir = path.resolve(config.server.webBase);
  // Anything under overrideDir may be served; nothing outside it may - see
  // library/path-safety.js for why path.join is not enough on its own.
  staticFiles.use((req, res, next) => {
    const filePath = resolveWithin(overrideDir, req.path);
    if (filePath === null) {
      return next();
    }
    // stat rather than access: a directory passes an existence check and then makes
    // sendFile fail with EISDIR, where falling through to express.static serves its
    // index.html instead.
    fs.stat(filePath, (err, stat) => {
      if (!err && stat.isFile()) {
        res.sendFile(filePath);
      } else {
        next();
      }
    });
  });
}
staticFiles.use(express.static(path.join(__dirname, 'static')));
app.use(countStaticResponses(staticFiles, () => { stats.staticRequestCount++; }));

// The status panel's figures, machine-readable (cluster.md, "Status"). Under /dashboard, so the
// memory guard never refuses it. On the master under the launcher: the launcher's snapshot of
// every process (library/cluster-status.js); otherwise this process's own figures
app.get('/dashboard/status.json', (req, res) => {
  stats.requestCount++;
  const requests = requestCounts();
  const counts = { count: requests.count, detail: requests.detail };
  const cluster = clusterStatus();
  let body;
  if (cluster) {
    body = { scope: 'cluster', generatedAt: Date.now(), requests: counts, ...cluster };
  } else {
    const guard = memoryGuard._state;
    const own = readProcessMemory('self');
    body = {
      scope: 'process', generatedAt: Date.now(), requests: counts,
      role: role ? role.role : null, code: role ? config.modules.tx.instanceCode : null,
      process: { ...ownFigures(stats, { inFlight: () => inFlight, refusing: () => memoryGuard.shouldReject() }),
        uptimeMs: Date.now() - stats.startTime, rss: process.memoryUsage().rss,
        anon: own ? own.anon : null, file: own ? own.file : null },
      memory: { limit: guard.limit, limitSource: guard.source, rejectAt: guard.rejectAt, abortAt: guard.abortAt,
        rejectFraction: guard.rejectFraction, abortFraction: guard.abortFraction, group: Boolean(guard.group) }
    };
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json(body);
});

// Dashboard endpoint - server name, stats, graphs, and background tasks (no modules list)
app.get('/dashboard', async (req, res) => {
  stats.requestCount++;
  try {
    if (!htmlServer.hasTemplate('root-bare')) {
      const templatePath = path.join(__dirname, 'root-bare-template.html');
      htmlServer.loadTemplate('root-bare', templatePath);
    }

    const startTime = Date.now();
    // the status line, the graphs and the tasks at work; the rest under "More" (library/cluster-status.js)
    const liquid = new Liquid({
      root: path.join(__dirname, 'tx', 'html'),
      extname: '.liquid'
    });
    // the background tasks' table (the bare template has no fhir.css)
    let content = '<style>table.grid{margin-bottom:10px;border:1px solid black;margin-right:auto}table.grid th,table.grid td{border:1px solid silver;padding:3px 7px 2px;font-size:12px;line-height:1.4em;font-family:verdana;vertical-align:top}table.grid th{font-weight:bold}table.grid td{font-weight:normal}</style>';
    // the page's title is its h1 (root-bare-template.html), so its sections are h2
    // the release and npm audit on one line above "More" (the advice and the findings, when there
    // are any, after it); the data folder under "More"
    content += await statusContent(liquid, 'dash-metrics', 2, {
      notes: npmAudit ? [npmAudit.renderLine()] : [],
      details: npmAudit ? npmAudit.renderFindings() : '',
      more: `<p>Data: ${escape(folders.dataDir())}</p>`
    });

    content = '<div class="row mb-4"><div class="col-12">' + content + '</div></div>';

    const pageStats = {
      version: packageJson.version,
      enabledModules: Object.keys(config.modules).filter(m => config.modules[m]?.enabled).length,
      processingTime: Date.now() - startTime
    };

    const title = (config.hostName ? escape(config.hostName) : 'FHIRsmith Server')+' v'+packageJson.version;
    const html = htmlServer.renderPage('root-bare', title, content, pageStats);
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (error) {
    serverLog.error('Error rendering dashboard:', error);
    htmlServer.sendErrorResponse(res, 'root', error);
  }
});

/**
 * "3d 4h 5m 6s" for this run, followed by the proportion of time the server has
 * been up over all its recorded runs, when the statistics database is keeping that.
 */
// [the uptime, "97.3% overall" or null], for the Uptime tile
function uptimeParts(uptimeMs) {
  const text = uptimeText(uptimeMs);
  const m = / \((.*)\)$/.exec(text);
  return m ? [text.substring(0, m.index), m[1]] : [text, null];
}

function uptimeText(uptimeMs) {
  const uptimeSeconds = Math.floor(uptimeMs / 1000);
  const uptimeDays = Math.floor(uptimeSeconds / 86400);
  const uptimeHours = Math.floor((uptimeSeconds % 86400) / 3600);
  const uptimeMinutes = Math.floor((uptimeSeconds % 3600) / 60);
  const uptimeSecs = uptimeSeconds % 60;
  let uptimeStr = '';
  if (uptimeDays > 0) uptimeStr += `${uptimeDays}d `;
  if (uptimeHours > 0 || uptimeDays > 0) uptimeStr += `${uptimeHours}h `;
  if (uptimeMinutes > 0 || uptimeHours > 0 || uptimeDays > 0) uptimeStr += `${uptimeMinutes}m `;
  uptimeStr += `${uptimeSecs}s`;
  const overall = stats.overallUptime();
  if (overall) {
    // floor rather than round, so 99.96% doesn't claim to be 100%
    const pct = overall.percent >= 100 ? '100' : (Math.floor(overall.percent * 10) / 10).toFixed(1);
    uptimeStr += ` (${pct}% overall)`;
  }
  return uptimeStr;
}

// Health check endpoint
app.get('/health', async (req, res) => {
  const healthStatus = {
    status: 'OK',
    timestamp: new Date().toISOString(),
    modules: {}
  };

  // Get status from each enabled module
  Object.keys(modules).forEach(moduleName => {
    if (modules[moduleName] && typeof modules[moduleName].getStatus === 'function') {
      healthStatus.modules[moduleName] = modules[moduleName].getStatus();
    } else if (moduleName === 'xig') {
      // XIG has different status check
      let xigStatus = 'Enabled';
      if (modules.xig && modules.xig.isCacheLoaded && modules.xig.isCacheLoaded()) {
        xigStatus = 'Running';
      } else {
        xigStatus = 'Enabled but not loaded';
      }
      healthStatus.modules.xig = { enabled: true, status: xigStatus };
    }
  });

  res.json(healthStatus);
});

/**
 * Get log directory statistics: file count, total size, and disk space info
 * @returns {string} HTML table row(s) with log stats
 */
// The logs and the disk they are on, for the storage tiles: files and bytes null if the logs
// can't be read, disk null if the disk can't
function logFigures() {
  const logDir = folders.logsDir();
  let disk = null;
  try {
    // statfs available in Node 18.15+
    const fstats = fs.statfsSync(logDir);
    disk = { free: fstats.bavail * fstats.bsize, total: fstats.blocks * fstats.bsize };
  } catch {
    // unavailable
  }
  try {
    const files = readdirSync(logDir).filter(f => f.endsWith('.log'));
    let bytes = 0;
    for (const file of files) {
      bytes += statSync(path.join(logDir, file)).size;
    }
    // how many files the logger keeps (its rotation)
    const loggerOpts = Logger.getInstance().options;
    return { files: files.length, bytes, kept: loggerOpts.file.maxFiles, disk };
  } catch {
    return { files: null, bytes: null, kept: null, disk };
  }
}

// Initialize everything
async function startServer() {
  try {
    // Load HTML templates
    await loadTemplates();

    // Initialize modules
    await initializeModules().catch(error => {
      serverLog.error('Failed to initialize modules:', error);
      throw error;
    });

    // With a role: loading the library leaves 0.6-0.7 GB free but resident in the C allocator;
    // give it back before taking requests, since N+1 processes share one limit (cluster.md)
    if (role && memoryGuard._state.trimAllocator) {
      const before = process.memoryUsage.rss();
      if (trimNativeMemory() !== null) {
        serverLog.info(`Memory: malloc_trim after loading - RSS ${memoryGuard.gb(before)} GB -> ${memoryGuard.gb(process.memoryUsage.rss())} GB`);
      }
    }

    // Start server
    const listening = () => {
      stats.markStarted(packageJson.version);
      // the event loop held for logging.stallReportSeconds: its stack goes to a file in the logs
      try {
        stallWatchdog = startStallWatchdog({
          thresholdSeconds: config.logging?.stallReportSeconds ?? 30,
          dir: folders.logsDir(),
          label: config.modules?.tx?.instanceCode || ('pid' + process.pid),
          log: serverLog
        });
      } catch (e) {
        serverLog.error(`Unable to start the event loop watchdog: ${e.message}`);
      }
      serverLog.info(HOST ? `=== Server running on http://${HOST.includes(':') ? `[${HOST}]` : HOST}:${PORT} (server.cluster.bindAddress) ===`
        : `=== Server running on http://localhost:${PORT} ===`);
      startupComplete();
      if (role && process.send) {
        // to the launcher (cluster.js): ready, from this process itself
        try {
          process.send({ type: require('./library/role').READY, pid: process.pid });
        } catch {
          // the launcher has gone; the disconnect handler below shuts this process down
        }
      }
    };
    const server = HOST ? app.listen(PORT, HOST, listening) : app.listen(PORT, listening);
    // idle connections stay open longer than nginx keeps them (see library/keep-alive.js)
    applyKeepAliveTimeouts(server);
    npmAudit.start();
    dailyReport = new DailyReport(config.dailyReport, {
      log: Logger.getInstance().child({ module: 'daily-report' }),
      stats: stats,
      modules: modules,
      mailer: new Mailer(config.email, Logger.getInstance().child({ module: 'email' })),
      npmAudit: npmAudit,
      version: packageJson.version,
      serverId: config.hostName,
      // under the launcher: the report has a paragraph on the cluster
      cluster: Boolean(role && role.role === 'master' && process.send)
    });
    dailyReport.start();
    if (modules.packages && config.modules?.packages?.enabled) {
      modules.packages.startInitialCrawler();
    }
    // Run usage tracker in background after startup
    if (modules.tx && modules.tx.library) {
      setImmediate(async () => {
        try {
          serverLog.info('Starting ConceptUsageTracker scan...');
          let count = await modules.tx.usageTracker.scanValueSets(modules.tx.library);
          serverLog.info(`ConceptUsageTracker scan complete: ${count} valuesets list codes`);
        } catch (err) {
          console.log(err);
          serverLog.error('ConceptUsageTracker scan failed:', err);
        }
      });
    }
  } catch (error) {
    console.error('FATAL - Failed to start server:', error);
    serverLog.error('FATAL - Failed to start server:', error);
    // Give the logger a moment to flush before exiting
    setTimeout(() => process.exit(1), 500);
  }
}

// Graceful shutdown: on Ctrl-C (SIGINT), and on SIGTERM - what systemd, docker stop and
// kill send - so the modules can save what they hold (usage counts, crawl data) either way
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  serverLog.info('\nShutting down server...');
  if (disconnectCounts) {
    // a worker's last request counts, while the launcher still listens
    await disconnectCounts.flush();
  }
  if (npmAudit) {
    npmAudit.stop();
  }
  if (dailyReport) {
    dailyReport.stop();
  }
  if (stallWatchdog) {
    await stallWatchdog.stop();
  }

  // Shutdown all modules
  for (const [moduleName, moduleInstance] of Object.entries(modules)) {
    try {
      if (moduleInstance && typeof moduleInstance.shutdown === 'function') {
        serverLog.info(`Shutting down ${moduleName} module...`);
        await moduleInstance.shutdown();
        serverLog.info(`${moduleName} module shut down`);
      }
    } catch (error) {
      serverLog.error(`Error shutting down ${moduleName} module:`, error);
    }
  }
  stats.finishStats();
  disconnectMetrics();
  disconnectStatus();
  if (disconnectCounts) {
    disconnectCounts();
  }
  disconnectClusterEvents();
  serverLog.info('Server shutdown complete');
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
// Started by the launcher (cluster.js, an IPC channel): when the launcher goes, even
// SIGKILLed, so does this process, rather than hold its port against the next launcher's
// workers. With no one left to SIGKILL a shutdown that hangs, exit after 30 s regardless
if (role && process.connected) {
  process.once('disconnect', () => {
    setTimeout(() => process.exit(1), 30000).unref();
    void shutdown();
  });
}

async function serveFhirsmithHome(req, res) {
  // Check if client wants HTML response
  const acceptsHtml = req.headers.accept && req.headers.accept.includes('text/html');

  if (acceptsHtml) {
    try {
      const startTime = Date.now();

      // Load template if not already loaded
      if (!htmlServer.hasTemplate('root')) {
        const templatePath = path.join(__dirname, 'root-template.html');
        htmlServer.loadTemplate('root', templatePath);
      }

      const content = await buildRootPageContent();

      // Build basic stats for root page
      const stats = {
        version: packageJson.version,
        enabledModules: Object.keys(config.modules).filter(m => config.modules[m]?.enabled).length,
        processingTime: Date.now() - startTime
      };

      const html = htmlServer.renderPage('root', config.hostName ? escape(config.hostName) : 'FHIRsmith Server', content, stats);
      res.setHeader('Content-Type', 'text/html');
      res.send(html);
      return;
    } catch (error) {
      serverLog.error('Error rendering root page:', error);
      htmlServer.sendErrorResponse(res, 'root', error);
      return;
    }
  } else {
    // Return JSON response for API clients
    const enabledModules = {};
    Object.keys(config.modules).forEach(moduleName => {
      if (config.modules[moduleName]?.enabled) {
        if (moduleName === 'tx') {
          // TX module has multiple endpoints
          enabledModules[moduleName] = {
            enabled: true,
            endpoints: config.modules.tx.endpoints.map(e => ({
              path: e.path,
              fhirVersion: e.fhirVersion,
              context: e.context || null
            }))
          };
        } else {
          enabledModules[moduleName] = {
            enabled: true,
            endpoint: moduleName === 'vcl' ? '/VCL' : `/${moduleName}`
          };
        }
      }
    });

    res.json({
      message: 'FHIR Development Server',
      version: '1.0.0',
      modules: enabledModules,
      endpoints: {
        health: '/health',
        ...Object.fromEntries(
            Object.keys(enabledModules)
                .filter(m => m !== 'tx')
                .map(m => [
                  m,
                  m === 'vcl' ? '/VCL' : `/${m}`
                ])
        ),
        // Add TX endpoints separately
        ...(enabledModules.tx ? {
          tx: config.modules.tx.endpoints.map(e => e.path)
        } : {})
      }
    });
  }
}

// Start the server
startServer().catch((err) => {
  serverLog.error('Fatal error during startup:', err);
  process.exit(1);
});
