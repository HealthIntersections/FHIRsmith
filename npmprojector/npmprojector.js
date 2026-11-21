//
// NpmProjector Module
// Watches an npm package directory and serves FHIR resources with search indexes
//

const express = require('express');
const Logger = require('../library/logger');
const FHIRIndexer = require('./indexer');
const PackageWatcher = require('./watcher');

// Load FHIRPath models for different FHIR versions
const fhirModels = {
  'r4': () => require('fhirpath/fhir-context/r4'),
  'r5': () => require('fhirpath/fhir-context/r5'),
  'stu3': () => require('fhirpath/fhir-context/stu3'),
  'dstu2': () => require('fhirpath/fhir-context/dstu2')
};
class NpmProjectorModule {
  constructor(stats) {
    this.router = express.Router();
    this.log = Logger.getInstance().child({ module: 'npmprojector' });
    this.config = null;
    this.watcher = null;
    this.currentIndexer = null;
    this.lastReloadTime = null;
    this.lastReloadStats = null;
    this.reloadCount = 0;
    this.stats = stats;
  }

  /**
   * Get the configured base path for this module (for server.js to use)
   */
  static getBasePath(config) {
    return config.basePath || '/npmprojector';
  }
  async initialize(config) {
    this.config = config;
    this.log.info('Initializing NpmProjector module');

    // Validate config
    if (!config.npmPath) {
      throw new Error('NpmProjector module requires npmPath configuration');
    }

    // Load the appropriate FHIRPath model
    const fhirVersion = config.fhirVersion || 'r4';
    if (!fhirModels[fhirVersion]) {
      throw new Error(`Unsupported FHIR version: ${fhirVersion}. Supported: ${Object.keys(fhirModels).join(', ')}`);
    }
    
    try {
      this.fhirModel = fhirModels[fhirVersion]();
      this.log.info(`Loaded FHIRPath model for ${fhirVersion.toUpperCase()}`);
    } catch (err) {
      throw new Error(`Failed to load FHIRPath model for ${fhirVersion}: ${err.message}`);
    }

    // Initialize indexer with the model
    this.currentIndexer = new FHIRIndexer(this.fhirModel);
    // Set up routes
    this.setupRoutes();

    // Set up file watcher
    this.watcher = new PackageWatcher(config.npmPath, {
      debounceMs: config.debounceMs || 500,
      onReload: (data) => this.handleReload(data),
      log: this.log
    });

    // Start watching (includes initial load)
    this.watcher.start();

    this.log.info(`NpmProjector module initialized, watching: ${config.npmPath}`);
  }

  /**
   * Handle package reload - builds new index then swaps atomically
   */
  handleReload({ resources, searchParameters }) {
    const startTime = Date.now();

    try {
      // Filter resources by configured types if specified
      let filteredResources = resources;
      if (this.config.resourceTypes && this.config.resourceTypes.length > 0) {
        filteredResources = resources.filter(r => 
          this.config.resourceTypes.includes(r.resourceType)
        );
        this.log.info(`Filtered to ${filteredResources.length} resources of types: ${this.config.resourceTypes.join(', ')}`);
      }

      // Load additional search parameters from configured path if specified
      let allSearchParameters = [...searchParameters];
      if (this.config.searchParametersPath) {
        const additionalParams = this.watcher.loadSearchParametersFrom(this.config.searchParametersPath);
        allSearchParameters = [...allSearchParameters, ...additionalParams];
        this.log.info(`Loaded ${additionalParams.length} additional search parameters from ${this.config.searchParametersPath}`);
      }

      // Build new indexer with the FHIR model
      const newIndexer = new FHIRIndexer(this.fhirModel);
      const stats = newIndexer.build(filteredResources, allSearchParameters);

      // Atomic swap
      this.currentIndexer = newIndexer;

      const elapsed = Date.now() - startTime;
      this.lastReloadTime = new Date().toISOString();
      this.lastReloadStats = stats;
      this.reloadCount++;

      this.log.info(`Index rebuilt in ${elapsed}ms: ${JSON.stringify(stats)}`);
    } catch (error) {
      this.log.error('Error during reload:', error);
    }
  }

  /**
   * Get the current indexer for request handling
   */
  getIndexer() {
    return this.currentIndexer;
  }

  /**
   * Set up Express routes
   */
  setupRoutes() {
    // CORS is handled once at the app level (server.js, from config.server.cors).
    // Do not set Access-Control-* headers here.

    // Root - module info
    this.router.get('/', (req, res) => {
      const start = Date.now();
      try {

        const indexer = this.getIndexer();
        const types = indexer.getResourceTypes();
        const stats = indexer.getStats();

        res.json({
          message: 'NpmProjector FHIR Server',
          npmPath: this.config.npmPath,
          fhirVersion: this.config.fhirVersion || 'r4',
          resourceTypes: types,
          configuredTypes: this.config.resourceTypes || 'all',
          stats: stats,
          lastReload: this.lastReloadTime,
          reloadCount: this.reloadCount,
          endpoints: {
            metadata: 'metadata',
            stats: '_stats',
            search: '[ResourceType]',
            read: '[ResourceType]/[id]'
          }
        });
      } finally {
        this.stats.countRequest('home', Date.now() - start);
      }
    });

    // Capability Statement (metadata)
    this.router.get('/metadata', (req, res) => {
      const start = Date.now();
      try {
        const indexer = this.getIndexer();
        res.json(this.buildCapabilityStatement(indexer));
      } finally {
        this.stats.countRequest('metadata', Date.now() - start);
      }
    });

    // Stats endpoint
    this.router.get('/_stats', (req, res) => {
      const start = Date.now();
      try {
        const indexer = this.getIndexer();
        res.json({
          ...indexer.getStats(),
          lastReload: this.lastReloadTime,
          reloadCount: this.reloadCount
        });
      } finally {
        this.stats.countRequest('stats', Date.now() - start);
      }
    });

    // Trigger manual reload
    this.router.post('/_reload', (req, res) => {
      const start = Date.now();
      try {

        this.log.info('Manual reload triggered');
        this.watcher.triggerReload();
        res.json({message: 'Reload triggered', reloadCount: this.reloadCount});
      } finally {
        this.stats.countRequest('reload', Date.now() - start);
      }
    });

    // Read: GET /[type]/[id]
    this.router.get('/:resourceType/:id', (req, res) => {
      const start = Date.now();
      try {

        const {resourceType, id} = req.params;
        const indexer = this.getIndexer();

        const resource = indexer.read(resourceType, id);

        if (!resource) {
          return res.status(404).json(this.operationOutcome(
            'error',
            'not-found',
            `${resourceType}/${id} not found`
          ));
        }

        res.json(resource);
      } finally {
        this.stats.countRequest('*', Date.now() - start);
      }
    });

    // Search: GET /[type]?params...
    this.router.get('/:resourceType', (req, res) => {
      const start = Date.now();
      try {

        const {resourceType} = req.params;
        const indexer = this.getIndexer();

        // Check if resource type exists
        if (!indexer.getResourceTypes().includes(resourceType)) {
          return res.status(404).json(this.operationOutcome(
            'error',
            'not-found',
            `Resource type ${resourceType} not found`
          ));
        }

        // Extract search parameters
        const searchParams = {};
        for (const [key, value] of Object.entries(req.query || {})) {
          if (!key.startsWith('_') || key === '_id') {
            searchParams[key] = value;
          }
        }

        // Handle _id specially
        if (searchParams._id) {
          searchParams.id = searchParams._id;
          delete searchParams._id;
        }

        const results = indexer.search(resourceType, searchParams);

        // Handle _count
        let count = parseInt(req.query._count) || 100;
        count = Math.min(count, 1000);

        const paginatedResults = results.slice(0, count);

        res.json(this.buildSearchBundle(paginatedResults, req, results.length));
      } finally {
        this.stats.countRequest(':resourceType', Date.now() - start);
      }
    });
  }

  /**
   * Build a FHIR Bundle for search results
   */
  buildSearchBundle(resources, req, totalCount) {
    const protocol = req.protocol;
    const host = req.get('host');
    const baseUrl = `${protocol}://${host}${req.baseUrl}`;
    const fullUrl = `${protocol}://${host}${req.originalUrl}`;

    return {
      resourceType: 'Bundle',
      type: 'searchset',
      total: totalCount,
      link: [
        {
          relation: 'self',
          url: fullUrl
        }
      ],
      entry: resources.map(resource => ({
        fullUrl: `${baseUrl}/${resource.resourceType}/${resource.id}`,
        resource: resource,
        search: {
          mode: 'match'
        }
      }))
    };
  }

  /**
   * Build a CapabilityStatement
   */
  buildCapabilityStatement(indexer) {
    const resourceTypes = indexer.getResourceTypes();

    const restResources = resourceTypes.map(type => {
      const searchParams = indexer.getSearchParams(type);

      return {
        type: type,
        interaction: [
          { code: 'read' },
          { code: 'search-type' }
        ],
        searchParam: searchParams.map(sp => ({
          name: sp.code,
          type: sp.type,
          documentation: sp.description || sp.name
        }))
      };
    });

    return {
      resourceType: 'CapabilityStatement',
      status: 'active',
      date: new Date().toISOString(),
      kind: 'instance',
      software: {
        name: 'NpmProjector FHIR Server',
        version: '1.0.0'
      },
      fhirVersion: '4.0.1',
      format: ['json'],
      rest: [
        {
          mode: 'server',
          resource: restResources
        }
      ]
    };
  }

  /**
   * Build an OperationOutcome for errors
   */
  operationOutcome(severity, code, message) {
    return {
      resourceType: 'OperationOutcome',
      issue: [
        {
          severity: severity,
          code: code,
          diagnostics: message
        }
      ]
    };
  }

  /**
   * Get module status for health check
   */
  getStatus() {
    const stats = this.currentIndexer.getStats();
    return {
      enabled: true,
      status: stats.totalResources > 0 ? 'Running' : 'Empty',
      npmPath: this.config?.npmPath,
      basePath: this.config?.basePath || '/npmprojector',
      fhirVersion: this.config?.fhirVersion || 'r4',
      totalResources: stats.totalResources,
      resourceTypes: Object.keys(stats.resourceTypes),
      lastReload: this.lastReloadTime,
      reloadCount: this.reloadCount
    };
  }

  /**
   * Shutdown the module
   */
  async shutdown() {
    this.log.info('Shutting down NpmProjector module');
    if (this.watcher) {
      this.watcher.stop();
    }
    this.log.info('NpmProjector module shut down');
  }

}

module.exports = NpmProjectorModule;
