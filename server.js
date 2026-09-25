#!/usr/bin/env node

//
// Copyright 2025, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const v8 = require('v8');
const folders = require('./library/folder-setup');  // <-- ADD: load early
const { statSync, readdirSync } = require('fs');
const escape = require('escape-html');
const { resolveWithin } = require('./library/path-safety');
const { readCgroupMemoryLimit } = require('./library/cgroup-memory');

// Load configuration BEFORE logger
let config;
try {
  const configPath = folders.filePath('config.json');  // <-- CHANGE: config now in data dir
  const configData = fs.readFileSync(configPath, 'utf8');
  config = JSON.parse(configData);
} catch (error) {
  console.error('Failed to load configuration:', error.message);
  process.exit(1);
}

const Logger = require('./library/logger');
const serverLog = Logger.getInstance(config.logging || {}).child({ module: 'server' });
const packageJson = require('./package.json');

// Startup banner
const totalMemGB = (os.totalmem() / 1024 / 1024 / 1024).toFixed(1);
const freeMemGB = (os.freemem() / 1024 / 1024 / 1024).toFixed(1);
serverLog.info(`========================================`);
serverLog.info(`FHIRsmith v${packageJson.version} starting (PID ${process.pid})`);
serverLog.info(`Node.js ${process.version} on ${os.type()} ${os.release()} (${os.arch()})`);
serverLog.info(`Memory: ${freeMemGB} GB free / ${totalMemGB} GB total`);
{
  const cg = readCgroupMemoryLimit();
  serverLog.info(cg.limit > 0
    ? `Memory limit: ${(cg.limit / 1024 / 1024 / 1024).toFixed(1)} GB (from ${cg.source})`
    : 'Memory limit: none found in cgroup - RSS guard disabled');
}
serverLog.info(`Data directory: ${folders.dataDir()}`);
serverLog.info(`========================================`);

const activeModules = config.modules ? Object.keys(config.modules)
    .filter(mod => config.modules[mod].enabled)
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

const htmlServer = require('./library/html-server');
const ServerStats = require("./stats");
const {Liquid} = require("liquidjs");
const FolderModule = require("./folder/folder");
const ExtensionTrackerModule = require("./extension-tracker/extension-tracker");

htmlServer.useLog(serverLog);
htmlServer.setSponsorMessage(config.sponsorMessage ? config.sponsorMessage : '');

const app = express();

// Behind nginx (or any reverse proxy): honor X-Forwarded-* so req.protocol and
// req.hostname reflect what the client actually requested, not the loopback hop.
app.set('trust proxy', config.server.trustProxy ?? true);

const PORT = process.env.PORT || config.server.port || 3000;

// Middleware
app.use(express.raw({ type: 'application/fhir+json', limit: '50mb' }));
app.use(express.raw({ type: 'application/fhir+xml', limit: '50mb' }));
app.use(express.json({ limit: '50mb' }));
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

// Initialize modules based on configuration
async function initializeModules() {
  stats = new ServerStats(config.stats, serverLog);

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

  // Initialize TX module
  // Note: TX module registers its own endpoints directly on the app
  // because it supports multiple endpoints at different paths
  if (config.modules?.tx?.enabled) {
    try {
      serverLog.info('Initializing module: tx...');
      modules.tx = new TXModule(stats.forModule('tx'));
      await modules.tx.initialize(config.modules.tx, app);
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

async function buildRootPageContent() {
  stats.requestCount++;
  let content = '<div class="row mb-4">';
  content += '<div class="col-12">';

  content += '<h3>Available Modules</h3>';
  content += '<ul class="list-group">';

  // Check which modules are enabled and add them to the list
  if (config.modules.packages.enabled) {
    content += '<li class="list-group-item">';
    content += '<a href="/packages" class="text-decoration-none">Package Server</a>: Browse and download FHIR Implementation Guide packages';
    content += '</li>';
  }

  if (config.modules.xig.enabled) {
    content += '<li class="list-group-item">';
    content += '<a href="/xig" class="text-decoration-none">FHIR IG Statistics</a>: Statistics and analysis of FHIR Implementation Guides';
    content += '</li>';
  }

  if (config.modules.shl.enabled) {
    content += '<li class="list-group-item">';
    content += '<a href="/shl" class="text-decoration-none">SHL Server</a>: SMART Health Links management and validation';
    content += '</li>';
  }

  if (config.modules.vcl.enabled) {
    content += '<li class="list-group-item">';
    content += '<a href="/VCL" class="text-decoration-none">VCL Server</a>: ValueSet Compose Language expression parsing';
    content += '</li>';
  }

  if (config.modules.registry && config.modules.registry.enabled) {
    content += '<li class="list-group-item">';
    content += '<a href="/tx-reg" class="text-decoration-none">Terminology Server Registry</a>: ';
    content += 'Discover and query FHIR terminology servers for code system and value set support';
    content += '</li>';
  }

  if (config.modules.publisher && config.modules.publisher.enabled) {
    content += '<li class="list-group-item">';
    content += '<a href="/publisher" class="text-decoration-none">FHIR Publisher</a>: ';
    content += 'Manage FHIR Implementation Guide publication tasks and approvals';
    content += '</li>';
  }

  if (config.modules.token && config.modules.token.enabled) {
    content += '<li class="list-group-item">';
    content += '<a href="/token" class="text-decoration-none">Token Server</a>: ';
    content += 'OAuth authentication and API key management for FHIR services';
    content += '</li>';
  }

  if (config.modules.npmprojector && config.modules.npmprojector.enabled) {
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
    content += 'TestReports submitted by TxTester and other test tools';
    content += '</li>';
  }

  if (config.modules.folder && config.modules.folder.enabled) {
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
  }


  if (config.modules.tx && config.modules.tx.enabled) {
    content += '<li class="list-group-item">';
    content += '<strong>TX Terminology Server</strong>: ';
    content += 'FHIR terminology services (CodeSystem, ValueSet, ConceptMap)';
    if (config.modules.tx.endpoints && config.modules.tx.endpoints.length > 0) {
      content += '<ul class="mt-2 mb-0">';
      for (const endpoint of config.modules.tx.endpoints) {
        content += `<li><a href="${endpoint.path}" class="text-decoration-none">${endpoint.path}</a> (FHIR v${endpoint.fhirVersion}${endpoint.context ? ', context: ' + endpoint.context : ''})</li>`;
      }
      content += '</ul>';
    }
    content += '</li>';
  }

  content += '</ul>';

  content += '<hr/>';

  // Calculate uptime
  const uptimeMs = Date.now() - stats.startTime;
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

  // Memory usage
  const memUsage = process.memoryUsage();
  const heapStats = v8.getHeapStatistics();

  // V8 heap: used vs limit
  const v8UsedMB = (memUsage.heapUsed / 1024 / 1024).toFixed(0);
  const v8LimitMB = (heapStats.heap_size_limit / 1024 / 1024).toFixed(0);
  const v8PCT = (memUsage.heapUsed * 100) / heapStats.heap_size_limit;

  // Process RSS vs cgroup limit (or system total)
  const rssMB = (memUsage.rss / 1024 / 1024).toFixed(0);
  const memLimit = readCgroupMemoryLimit().limit || os.totalmem();
  const memLimitMB = (memLimit / 1024 / 1024).toFixed(0);
  const processPCT = (memUsage.rss * 100) / memLimit;

  // System memory
  const totalMemMB = (os.totalmem() / 1024 / 1024).toFixed(0);
  const usedMemMB = ((os.totalmem() - os.freemem()) / 1024 / 1024).toFixed(0);
  const sysMemPCT = ((os.totalmem() - os.freemem()) * 100) / os.totalmem();

  // Average requests per minute
  const uptimeMinutesTotal = uptimeMs / 60000;
  const avgReqPerMin = uptimeMinutesTotal > 0 ? (stats.requestCount / uptimeMinutesTotal).toFixed(1) : '0.0';

  content += '<table class="grid">';
  content += '<tr>';
  content += `<td><strong>Uptime:</strong> ${escape(uptimeStr)}</td>`;
  content += `<td><strong>Request Count:</strong> ${stats.requestCount} (static: ${stats.staticRequestCount})</td>`;
  content += `<td><strong>Avg Requests/min:</strong> ${avgReqPerMin}</td>`;
  content += '</tr>';
  content += '<tr>';
  content += `<td style="background-color:${pctColor(v8PCT)}"><strong>V8 Memory:</strong> ${v8UsedMB} MB of ${v8LimitMB} MB (${v8PCT.toFixed(0)}%)</td>`;
  content += `<td style="background-color:${pctColor(processPCT)}"><strong>Process Memory:</strong> ${rssMB} MB of ${memLimitMB} MB (${processPCT.toFixed(0)}%)</td>`;
  content += `<td style="background-color:${pctColor(sysMemPCT)}"><strong>System Memory:</strong> ${usedMemMB} MB of ${totalMemMB} MB (${sysMemPCT.toFixed(0)}%)</td>`;
  content += '</tr>';
  content += '<tr>';
  content += `<td><strong>Expansion Cache:</strong> ${stats.expansionItems()} items</td>`;
  content += `<td><strong>Client Cache:</strong> ${stats.clientCaches()} caches / ${stats.clientConcepts()} concepts</td>`;
  content += `<td><strong>Max Client Cache:</strong> ${stats.maxClientCaches()} caches / ${stats.maxClientConcepts()} concepts</td>`;
  content += '</tr>';
  const closure = stats.closureStats();
  if (closure) {
    content += '<tr>';
    content += `<td><strong>Closure Tables:</strong> ${closure.tables} tables` +
      (closure.retentionDays ? ` (unused for ${closure.retentionDays} days = deleted)` : '') + `</td>`;
    content += `<td><strong>Closure Entries:</strong> ${closure.entries} entries / ${closure.concepts} concepts</td>`;
    content += `<td><strong>Closure Database:</strong> ${closure.bytes === null ? 'in memory' : formatBytes(closure.bytes)}</td>`;
    content += '</tr>';
  }
  content += getLogStats();
  content += '</table>';

  // ===== Metrics Graphs =====
  const liquid = new Liquid({
    root: path.join(__dirname, 'tx', 'html'),
    extname: '.liquid'
  });
  content += await liquid.renderFile('home-metrics', {
    historyJson: JSON.stringify(stats.history),
    startTime: stats.startTime
  });
  content += stats.taskDetails();

  content += '</div>';
  return content;
}

// eslint-disable-next-line no-unused-vars
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
  serverLog.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('FATAL - Uncaught Exception:', error);
  serverLog.error('FATAL - Uncaught Exception:', error);
  process.exitCode = 1;
});

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
        enabledModules: Object.keys(config.modules).filter(m => config.modules[m].enabled).length,
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
// Count static file hits separately from API/page requests
app.use((req, res, next) => {
  res.on('finish', () => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      stats.staticRequestCount++;
    }
  });
  next();
});
if (config.server?.webBase) {
  const overrideDir = path.resolve(config.server.webBase);
  // Anything under overrideDir may be served; nothing outside it may - see
  // library/path-safety.js for why path.join is not enough on its own.
  app.use((req, res, next) => {
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
app.use(express.static(path.join(__dirname, 'static')));

// Dashboard endpoint - server name, stats, graphs, and background tasks (no modules list)
app.get('/dashboard', async (req, res) => {
  stats.requestCount++;
  try {
    if (!htmlServer.hasTemplate('root-bare')) {
      const templatePath = path.join(__dirname, 'root-bare-template.html');
      htmlServer.loadTemplate('root-bare', templatePath);
    }

    const startTime = Date.now();
    // Calculate uptime
    const uptimeMs = Date.now() - stats.startTime;
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

    // Memory usage
    const memUsage = process.memoryUsage();
    const heapStats = v8.getHeapStatistics();
    const v8PCT = (memUsage.heapUsed * 100) / heapStats.heap_size_limit;  // % of V8 heap limit used

    // Process RSS as % of cgroup memory limit (or system total as fallback)
    const memLimit = readCgroupMemoryLimit().limit || os.totalmem();
    const processPCT = (memUsage.rss * 100) / memLimit;

    const totalMemBytes = os.totalmem();
    const freeMemBytes = os.freemem();
    const sysMemPCT = ((totalMemBytes - freeMemBytes) * 100) / totalMemBytes;  // % of system memory used

    const memMaxPCT = Math.max(v8PCT, processPCT, sysMemPCT);

    const fstats = fs.statfsSync(folders.logsDir());
    const diskPCT = 100 - ((fstats.bavail * 100) / fstats.blocks);  // % of disk used

    let content = '<style>table.grid{margin-bottom:10px;border:1px solid black;margin-right:auto}table.grid th,table.grid td{border:1px solid silver;padding:3px 7px 2px;font-size:12px;line-height:1.4em;font-family:verdana;vertical-align:top}table.grid th{font-weight:bold}table.grid td{font-weight:normal}</style>';
    content += '<table class="grid">';
    content += '<tr>';
    content += `<td><strong>Uptime:</strong> ${escape(uptimeStr)}</td>`;
    content += `<td><strong>Request Count:</strong> ${stats.requestCount} (static: ${stats.staticRequestCount})</td>`;
    content += `<td style="background-color:${pctColor(memMaxPCT)}"><strong>Memory:</strong> ${v8PCT.toFixed(0)}% V8, ${processPCT.toFixed(0)}% Process, ${sysMemPCT.toFixed(0)}% System</td>`;
    content += `<td style="background-color:${pctColor(diskPCT)}"><strong>Disk:</strong> ${diskPCT.toFixed(0)}%</td>`;
    content += '</tr>';
    content += '</table>';

    // ===== Metrics Graphs =====
    const liquid = new Liquid({
      root: path.join(__dirname, 'tx', 'html'),
      extname: '.liquid'
    });
    content += await liquid.renderFile('dash-metrics', {
      historyJson: JSON.stringify(stats.history),
      startTime: stats.startTime
    });
    content += stats.taskDetails();
    content += `<p>Data: ${folders.dataDir()}</p>`;

    content = '<div class="row mb-4"><div class="col-12">' + content + '</div></div>';

    const pageStats = {
      version: packageJson.version,
      enabledModules: Object.keys(config.modules).filter(m => config.modules[m].enabled).length,
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

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} bytes`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function pctColor(pct) {
  // Gradient from green (#deffe0) at 0% to red (#ffd3d1) at 100%
  const t = Math.max(0, Math.min(100, pct)) / 100;
  const r = Math.round(222 + 33 * t);   // 222 -> 255
  const g = Math.round(255 - 44 * t);   // 255 -> 211
  const b = Math.round(224 - 15 * t);   // 224 -> 209
  return `rgb(${r}, ${g}, ${b})`;
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
function getLogStats() {
  const logDir = folders.logsDir();

  try {
    const files = readdirSync(logDir).filter(f => f.endsWith('.log'));
    let totalSize = 0;
    for (const file of files) {
      totalSize += statSync(path.join(logDir, file)).size;
    }

    const sizeMB = (totalSize / 1024 / 1024).toFixed(2);

    let diskInfo = '';
    try {
      // statfs available in Node 18.15+
      const fstats = fs.statfsSync(logDir);
      const blockSize = fstats.bsize;
      const freeSpace = fstats.bavail * blockSize;
      const totalSpace = fstats.blocks * blockSize;
      const freeGB = (freeSpace / 1024 / 1024 / 1024).toFixed(2);
      const totalGB = (totalSpace / 1024 / 1024 / 1024).toFixed(2);
      diskInfo = `<td><strong>Disk Space:</strong> ${freeGB} GB of ${totalGB} GB</td>`;
    } catch {
      diskInfo = '<td><strong>Disk Space:</strong> unavailable</td>';
    }

    // Log rotation limit from logger config
    const loggerOpts = Logger.getInstance().options;
    const maxFiles = loggerOpts.file.maxFiles;
    const maxSize = loggerOpts.file.maxSize;
    const limitInfo = `${maxFiles} files × ${maxSize} each`;

    return '<tr>'
        + `<td><strong>Existing Logs:</strong> ${files.length} (${sizeMB} MB)</td>`
        + `<td><strong>Retention Policy:</strong> ${limitInfo}</td>`
        + diskInfo
        + '</tr>';
  } catch (e) {
    return `<tr><td colspan="3"><strong>Logs:</strong> unable to read (${e.message})</td></tr>`;
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

    // Start server
    app.listen(PORT, () => {
      stats.markStarted();
      serverLog.info(`=== Server running on http://localhost:${PORT} ===`);
    });
    if (modules.packages && config.modules.packages.enabled) {
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

// Graceful shutdown
process.on('SIGINT', async () => {
  serverLog.info('\nShutting down server...');

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
  serverLog.info('Server shutdown complete');
  process.exit(0);
});

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
        enabledModules: Object.keys(config.modules).filter(m => config.modules[m].enabled).length,
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
      if (config.modules[moduleName].enabled) {
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