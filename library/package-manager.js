/**
 * PackageManager - FHIR Package management with caching
 * Fetches and caches FHIR packages from package servers
 */

const fs = require('fs').promises;
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const zlib = require('zlib');
const tar = require('tar');
const axios = require('axios');
const { VersionUtilities } = require('../library/version-utilities');

const DEFAULT_ROOT_URL = 'https://build.fhir.org';
const DEFAULT_CI_QUERY_INTERVAL = 1000 * 60 * 60; // 1 hour

class CIBuildClient {
    /**
     * @param {string} rootUrl - Base URL for CI build server
     * @param {number} ciQueryInterval - Interval between server queries in ms
     */
    constructor(rootUrl = DEFAULT_ROOT_URL, ciQueryInterval = DEFAULT_CI_QUERY_INTERVAL) {
        this.rootUrl = rootUrl;
        this.ciQueryInterval = ciQueryInterval;
        this.ciLastQueriedTimeStamp = 0;
        this.ciBuildInfo = null;

        // key = packageId, value = url of built package on build.fhir.org/ig/
        this.ciPackageUrls = new Map();
    }

    /**
     * Get package ID from canonical URL
     * @param {string} canonical - Canonical URL
     * @returns {Promise<string|null>} Package ID or null
     */
    async getPackageId(canonical) {
        if (!canonical) {
            return null;
        }

        await this.checkCIServerQueried();

        if (this.ciBuildInfo) {
            // First pass: exact match
            for (const o of this.ciBuildInfo) {
                if (canonical === o.url) {
                    return o['package-id'];
                }
            }

            // Second pass: starts with canonical + /ImplementationGuide/
            for (const o of this.ciBuildInfo) {
                if (o.url && o.url.startsWith(canonical + '/ImplementationGuide/')) {
                    return o['package-id'];
                }
            }
        }

        return null;
    }

    /**
     * Get package URL from package ID
     * @param {string} packageId - Package ID
     * @returns {Promise<string|null>} Package URL or null
     */
    async getPackageUrl(packageId) {
        await this.checkCIServerQueried();

        for (const o of this.ciBuildInfo || []) {
            if (packageId === o['package-id']) {
                return o.url;
            }
        }

        return null;
    }

    /**
     * Check if local package is current with CI build
     * @param {string} id - Package ID
     * @param {Object} npmPackage - Local npm package with date() method
     * @returns {Promise<boolean>} True if current
     */
    async isCurrent(id, npmPackage) {
        await this.checkCIServerQueried();

        const packageManifestUrl = this.ciPackageUrls.get(id);
        if (!packageManifestUrl) {
            return false;
        }

        const manifestUrl = this.pathURL(packageManifestUrl, 'package.manifest.json');
        const packageManifestJson = await this.fetchJson(manifestUrl);
        const currentDate = packageManifestJson.date;
        const packageDate = typeof npmPackage.date === 'function' ? npmPackage.date() : npmPackage.date;

        return currentDate === packageDate;
    }

    /**
     * Load package from CI build
     * @param {string} id - Package ID
     * @param {string} branch - Branch name (optional)
     * @returns {Promise<{stream: Buffer, url: string, version: string}>}
     */
    async loadFromCIBuild(id, branch = null) {
        await this.checkCIServerQueried();

        if (this.ciPackageUrls.has(id)) {
            const packageBaseUrl = this.ciPackageUrls.get(id);

            if (!branch) {
                let stream;
                let url = this.pathURL(packageBaseUrl, 'package.tgz');

                try {
                    stream = await this.fetchFromUrlSpecific(url);
                } catch (e) {
                    url = this.pathURL(packageBaseUrl, 'branches', 'main', 'package.tgz');
                    stream = await this.fetchFromUrlSpecific(url);
                }

                return {
                    stream,
                    url: this.pathURL(packageBaseUrl, 'package.tgz'),
                    version: 'current'
                };
            } else {
                const url = this.pathURL(packageBaseUrl, 'branches', branch, 'package.tgz');
                const stream = await this.fetchFromUrlSpecific(url);

                return {
                    stream,
                    url,
                    version: 'current$' + branch
                };
            }
        } else if (id.startsWith('hl7.fhir.r6')) {
            const url = this.pathURL(this.rootUrl, id + '.tgz');
            const stream = await this.fetchFromUrlSpecific(url);

            return {
                stream,
                url,
                version: 'current'
            };
        } else if (this.endsWithInList(id, '.r3', '.r4', '.r4b', '.r5', '.r6')) {
            const npid = id.substring(0, id.lastIndexOf('.'));
            const baseUrl = this.ciPackageUrls.get(npid);

            if (!baseUrl) {
                throw new Error(`The package '${id}' has no entry on the current build server`);
            }

            const url = this.pathURL(baseUrl, id + '.tgz');
            const stream = await this.fetchFromUrlSpecific(url);

            return {
                stream,
                url,
                version: 'current'
            };
        } else {
            throw new Error(`The package '${id}' has no entry on the current build server`);
        }
    }

    /**
     * Fetch content from URL
     * @param {string} source - URL to fetch
     * @returns {Promise<Buffer>}
     * @private
     */
    async fetchFromUrlSpecific(source) {
        return new Promise((resolve, reject) => {
            const protocol = source.startsWith('https') ? https : http;

            const request = protocol.get(source, (response) => {
                // Handle redirects
                if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                    this.fetchFromUrlSpecific(response.headers.location)
                      .then(resolve)
                      .catch(reject);
                    return;
                }

                if (response.statusCode !== 200) {
                    reject(new Error(`Unable to fetch ${source}: HTTP ${response.statusCode}`));
                    return;
                }

                const chunks = [];
                response.on('data', (chunk) => chunks.push(chunk));
                response.on('end', () => resolve(Buffer.concat(chunks)));
                response.on('error', reject);
            });

            request.on('error', (e) => reject(new Error(`Unable to fetch ${source}: ${e.message}`)));
            request.setTimeout(30000, () => {
                request.destroy();
                reject(new Error(`Timeout fetching ${source}`));
            });
        });
    }

    /**
     * Fetch JSON from URL
     * @param {string} url - URL to fetch
     * @returns {Promise<Object>}
     * @private
     */
    async fetchJson(url) {
        const buffer = await this.fetchFromUrlSpecific(url);
        return JSON.parse(buffer.toString('utf8'));
    }

    /**
     * Check if CI server needs to be queried and update if needed
     * @private
     */
    async checkCIServerQueried() {
        if (Date.now() - this.ciLastQueriedTimeStamp > this.ciQueryInterval) {
            try {
                await this.updateFromCIServer();
            } catch (e) {
                // Pause and retry once - most common reason is file being changed on server
                await this.sleep(1000);
                try {
                    await this.updateFromCIServer();
                } catch (e2) {
                    console.debug(`Error connecting to build server - running without build (${e2.message})`);
                }
            }
        }
    }

    /**
     * Update package information from CI server
     * @private
     */
    async updateFromCIServer() {
        try {
            const url = `${this.rootUrl}/ig/qas.json?nocache=${Date.now()}`;
            const buffer = await this.fetchFromUrlSpecific(url);
            this.ciBuildInfo = JSON.parse(buffer.toString('utf8'));

            const builds = [];

            for (const j of this.ciBuildInfo) {
                if (j.url && j['package-id'] && j['package-id'].includes('.')) {
                    let packageUrl = j.url;
                    if (packageUrl.includes('/ImplementationGuide/')) {
                        packageUrl = packageUrl.substring(0, packageUrl.indexOf('/ImplementationGuide/'));
                    }
                    builds.push({
                        url: packageUrl,
                        packageId: j['package-id'],
                        repo: this.getRepo(j.repo),
                        date: this.readDate(j.date)
                    });
                }
            }

            // Sort by date descending (newest first)
            builds.sort((a, b) => b.date.getTime() - a.date.getTime());

            for (const build of builds) {
                if (!this.ciPackageUrls.has(build.packageId)) {
                    this.ciPackageUrls.set(build.packageId, `${this.rootUrl}/ig/${build.repo}`);
                }
            }
        } finally {
            this.ciLastQueriedTimeStamp = Date.now();
        }
    }

    /**
     * Extract repo path from full path
     * @param {string} path - Full path
     * @returns {string} Repo path (org/repo)
     * @private
     */
    getRepo(path) {
        if (!path) return '';
        const p = path.split('/');
        return p[0] + '/' + p[1];
    }

    /**
     * Parse date string from CI server
     * @param {string} s - Date string in format "EEE, dd MMM, yyyy HH:mm:ss Z"
     * @returns {Date}
     * @private
     */
    readDate(s) {
        if (!s) return new Date();

        try {
            // Parse format like "Mon, 15 Jan, 2024 10:30:00 +0000"
            return new Date(s);
        } catch (e) {
            console.error('Error parsing date:', e);
            return new Date();
        }
    }

    /**
     * Join URL path segments
     * @param {...string} parts - Path parts
     * @returns {string}
     * @private
     */
    pathURL(...parts) {
        return parts
          .map((part, index) => {
              if (index === 0) {
                  return part.replace(/\/+$/, '');
              }
              return part.replace(/^\/+|\/+$/g, '');
          })
          .filter(part => part.length > 0)
          .join('/');
    }

    /**
     * Check if string ends with any of the given suffixes
     * @param {string} str - String to check
     * @param {...string} suffixes - Suffixes to check
     * @returns {boolean}
     * @private
     */
    endsWithInList(str, ...suffixes) {
        return suffixes.some(suffix => str.endsWith(suffix));
    }

    /**
     * Sleep for specified milliseconds
     * @param {number} ms - Milliseconds to sleep
     * @returns {Promise<void>}
     * @private
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}


class PackageManager {
    totalDownloaded = 0;

    /**
     * @param {string[]} packageServers - Ordered list of package server URLs
     * @param {string} cacheFolder - Local folder for cached content
     */
    constructor(packageServers, cacheFolder) {
        if (!packageServers || packageServers.length === 0) {
            throw new Error('At least one package server must be provided');
        }
        this.packageServers = packageServers;
        this.cacheFolder = cacheFolder;
    }

    /**
     * Fetch a package, either from cache or from servers
     * @param {string} packageId - Package identifier (e.g., 'hl7.fhir.us.core')
     * @param {string} version - Version string (may contain wildcards)
     * @returns {Promise<string>} Path to extracted package folder
     */
    async fetch(packageId, version) {
        // First, resolve the version if it contains wildcards
        const resolvedVersion = await this.resolveVersion(packageId, version);

        // Check cache first
        const cachedPath = await this.checkCache(packageId, resolvedVersion);
        if (cachedPath) {
            return cachedPath;
        }

        // Not in cache, fetch from servers
        const packageData = await this.fetchFromServers(packageId, resolvedVersion);

        this.totalDownloaded = this.totalDownloaded + packageData.length;
        // Extract to cache
        const extractedPath = await this.extractToCache(packageId, resolvedVersion, packageData);

        return extractedPath;
    }

    /**
     * Resolve version with wildcards to a specific version
     * @param {string} packageId - Package identifier
     * @param {string} version - Version string (may contain wildcards)
     * @returns {Promise<string>} Resolved specific version
     */
    async resolveVersion(packageId, version) {
        // If no wildcards, return as-is
        if (!VersionUtilities.versionHasWildcards(version) && version != null) {
            return version;
        }

        // Need to get version list and find best match
        for (const server of this.packageServers) {
            try {
                const versions = await this.getPackageVersions(server, packageId);
                const resolvedVersion = this.selectBestVersion(versions, version);
                if (resolvedVersion) {
                    return resolvedVersion;
                }
            } catch (error) {
                // Try next server
                console.info("Error looking for "+packageId+" on "+server+": "+error);
                continue;
            }
        }

        throw new Error(`Could not resolve version ${version} for package ${packageId}`);
    }

    /**
     * Get list of available versions for a package from a server
     * @param {string} server - Server URL
     * @param {string} packageId - Package identifier
     * @returns {Promise<string[]>} Array of version strings
     */
    async getPackageVersions(server, packageId) {
        const url = `${server}/${packageId}`;

        return new Promise((resolve, reject) => {
            const parsedUrl = new URL(url);
            const client = parsedUrl.protocol === 'https:' ? https : http;

            const req = client.get(url, {
                headers: {
                    'Accept': 'application/json'
                }
            }, (res) => {
                if (res.statusCode === 404) {
                    reject(new Error(`Package ${packageId} not found on ${server}`));
                    return;
                }

                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode} from ${server}`));
                    return;
                }

                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        const versions = Object.keys(json.versions || {});
                        resolve(versions);
                    } catch (error) {
                        reject(new Error(`Invalid JSON from ${server}: ${error.message}`));
                    }
                });
            });

            req.on('error', reject);
            req.end();
        });
    }

    /**
     * Select the best matching version from available versions
     * @param {string[]} availableVersions - List of available versions
     * @param {string} criteria - Version criteria (may contain wildcards)
     * @returns {string|null} Best matching version or null if none match
     */
    selectBestVersion(availableVersions, criteria) {
        const sortedVersions = [...availableVersions].sort((a, b) => {
            try {
                return -VersionUtilities.compareVersions(a, b);
            } catch (error) {
                return 0;
            }
        });

        if (criteria == null) {
            return sortedVersions.length == 0 ? null : sortedVersions[0];
        }
        // Filter versions that match the criteria
        const matchingVersions = sortedVersions.filter(v => {
            try {
                return VersionUtilities.versionMatches(criteria, v);
            } catch (error) {
                return false;
            }
        });

        if (matchingVersions.length === 0) {
            return null;
        }

        // Sort by version (newest first) using compareVersions
        matchingVersions.sort((a, b) => {
            try {
                return -VersionUtilities.compareVersions(a, b);
            } catch (error) {
                return 0;
            }
        });

        return matchingVersions[0];
    }

    /**
     * Check if package exists in cache
     * @param {string} packageId - Package identifier
     * @param {string} version - Specific version
     * @returns {Promise<string|null>} Path to cached package or null if not found
     */
    async checkCache(packageId, version) {
        const packageName = `${packageId}#${version}`;
        const packagePath = path.join(this.cacheFolder, packageName);

        try {
            // the folder alone is not enough: a download that failed after the folder was made
            // leaves an empty one, which must not count as the package
            const stats = await fs.stat(path.join(packagePath, 'package', 'package.json'));
            if (stats.isFile()) {
                return packageName;
            }
        } catch (error) {
            // Not found or not accessible
        }

        return null;
    }

    /**
     * Fetch package data from servers
     * @param {string} packageId - Package identifier
     * @param {string} version - Specific version
     * @returns {Promise<Buffer>} Package tar.gz data
     */
    async fetchFromServers(packageId, version) {
        let lastError = null;

        if (version == "current") {
            const result = await new CIBuildClient().loadFromCIBuild(packageId);
            return result.stream;
        }
        for (const server of this.packageServers) {
            try {
                const packageData = await this.fetchFromServer(server, packageId, version);
                return packageData;
            } catch (error) {
                lastError = error;
                // Try next server
                continue;
            }
        }

        throw new Error(`Failed to fetch ${packageId}#${version} from any server. Last error: ${lastError?.message}`);
    }

    /**
     * Fetch package data from a specific server
     * @param {string} server - Server URL
     * @param {string} packageId - Package identifier
     * @param {string} version - Specific version
     * @returns {Promise<Buffer>} Package tar.gz data
     */
    async fetchFromServer(server, packageId, version) {
        const url = `${server}/${packageId}/${version}`;

        try {
            const response = await axios.get(url, {
                headers: {
                    'Accept': 'application/tar+gzip'
                },
                responseType: 'arraybuffer',
                maxRedirects: 5
            });

            return Buffer.from(response.data);
        } catch (error) {
            if (error.response?.status === 404) {
                throw new Error(`Package ${packageId}#${version} not found on ${server}`);
            }
            throw new Error(`HTTP ${error.response?.status || 'error'} from ${server}: ${error.message}`);
        }
    }

    /**
     * Fetch a package directly from a URL (e.g., a CI build .tgz)
     * @param {string} url - URL to a package.tgz file
     * @returns {Promise<string>} Path to extracted package folder
     */
    async fetchUrl(url) {
        try {
            const client = new CIBuildClient();
            const packageData = await client.fetchFromUrlSpecific(url);

            // Extract to a temp location to read package.json for name and version
            const tempKey = `_url_temp_${Date.now()}`;
            const tempPath = await this.extractToCache(tempKey, 'url', packageData);
            const tempFullPath = path.join(this.cacheFolder, tempPath);

            // Read package name and version from the extracted package
            const pkgJsonPath = path.join(tempFullPath, 'package', 'package.json');
            const pkgJson = JSON.parse(await fs.readFile(pkgJsonPath, 'utf8'));
            const packageId = pkgJson.name;
            const version = pkgJson.version;

            if (!packageId || !version) {
                throw new Error(`Package at ${url} has no name or version in package.json`);
            }

            // Use the same cache key format as npm packages
            const finalName = `${packageId}#${version}`;
            const finalPath = path.join(this.cacheFolder, finalName);

            // If it already exists, the same package is already loaded - that's a config error
            try {
                await fs.access(finalPath);
                await fs.rm(tempFullPath, { recursive: true, force: true });
                throw new Error(`Package ${finalName} already exists in cache. Check library config for duplicates (url: ${url})`);
            } catch (e) {
                if (e.message.includes('already exists')) throw e;
                // Doesn't exist yet, rename temp to final
                await fs.rename(tempFullPath, finalPath);
            }

            this.totalDownloaded = this.totalDownloaded + packageData.length;
            return finalName;
        } catch (error) {
            console.error(`Error fetching package from URL ${url}: ${error.message}`);
            throw error;
        }
    }

    /**
     * Extract package to cache folder
     * @param {string} packageId - Package identifier
     * @param {string} version - Specific version
     * @param {Buffer} packageData - Package tar.gz data
     * @returns {Promise<string>} Path to extracted package
     */
    async extractToCache(packageId, version, packageData) {
        const packageName = `${packageId}#${version}`;
        const packagePath = path.join(this.cacheFolder, packageName);

        // Ensure cache folder exists
        await fs.mkdir(this.cacheFolder, { recursive: true });

        // Create package folder
        await fs.mkdir(packagePath, { recursive: true });

        // Extract tar.gz
        return new Promise((resolve, reject) => {
            const gunzip = zlib.createGunzip();
            const extract = tar.extract({
                cwd: packagePath,
                strict: true
            });

            gunzip.on('error', reject);
            extract.on('error', reject);
            extract.on('finish', () => resolve(packageName));

            // Create a readable stream from the buffer and pipe through gunzip to tar
            const stream = require('stream');
            const bufferStream = new stream.PassThrough();
            bufferStream.end(packageData);

            bufferStream
                .pipe(gunzip)
                .pipe(extract);
        });
    }
}

class PackageContentLoader {
    /**
     * @param {string} packageFolder - Path to the extracted NPM package folder
     */
    constructor(packageFolder) {
        this.packageFolder = packageFolder;
        this.packageSubfolder = path.join(packageFolder, 'package');
        this.indexPath = path.join(this.packageSubfolder, '.index.json');
        this.index = null;
        this.indexByTypeAndId = new Map();
        this.indexByCanonical = new Map();
        this.loaded = false;
    }

    /**
     * Initialize the loader by reading and parsing the index
     * @returns {Promise<void>}
     */
    async initialize() {
        if (this.loaded) {
            return;
        }

        const packageSource = path.join(this.packageFolder, 'package', 'package.json');
        const packageContent = await fs.readFile(packageSource, 'utf8');
        this.package = JSON.parse(packageContent);

        try {
            const indexContent = await fs.readFile(this.indexPath, 'utf8');
            this.index = JSON.parse(indexContent);

            if (!this.index.files || !Array.isArray(this.index.files)) {
                throw new Error('Invalid index file: missing or invalid files array');
            }

            // Build lookup structures
            this.buildIndexes();
            this.loaded = true;
        } catch (error) {
            throw new Error(`Failed to load package index from ${this.indexPath}: ${error.message}`);
        }
    }

    /**
     * Build internal indexes for efficient lookups
     */
    buildIndexes() {
        for (const entry of this.index.files) {
            // Index by resourceType and id
            if (entry.resourceType && entry.id) {
                const key = `${entry.resourceType}/${entry.id}`;
                this.indexByTypeAndId.set(key, entry);
            }

            // Index by canonical URL (with and without version)
            if (entry.url) {
                // Index without version
                this.indexByCanonical.set(entry.url, entry);

                // Index with version if present
                if (entry.version) {
                    const versionedUrl = `${entry.url}|${entry.version}`;
                    this.indexByCanonical.set(versionedUrl, entry);
                }
            }
        }
    }

    /**
     * Load a resource by reference
     * @param {Object} reference - Reference object
     * @param {string} [reference.resourceType] - Resource type
     * @param {string} [reference.id] - Resource id
     * @param {string} [reference.url] - Canonical URL
     * @param {string} [reference.version] - Version (optional)
     * @returns {Promise<Object|null>} Loaded resource or null if not found
     */
    async loadByReference(reference) {
        await this.initialize();

        let entry = null;

        // Try to find by resourceType and id
        if (reference.resourceType && reference.id) {
            const key = `${reference.resourceType}/${reference.id}`;
            entry = this.indexByTypeAndId.get(key);
        }

        // Try to find by canonical URL
        if (!entry && reference.url) {
            if (reference.version) {
                // Try with version first
                const versionedUrl = `${reference.url}|${reference.version}`;
                entry = this.indexByCanonical.get(versionedUrl);
            }

            // Try without version if not found
            if (!entry) {
                entry = this.indexByCanonical.get(reference.url);
            }
        }

        if (!entry) {
            return null;
        }

        return await this.loadFile(entry);
    }

    /**
     * Get a list of resources of a given type
     * @param {string} resourceType - The resource type to filter by
     * @returns {Promise<Array>} Array of index entries for the given type
     */
    async getResourcesByType(resourceType) {
        await this.initialize();

        return this.index.files.filter(entry => entry.resourceType === resourceType);
    }

    /**
     * Load all files that pass a given filter
     * @param {Function} filterFn - Filter function that takes an index entry and returns boolean
     * @returns {Promise<Array>} Array of loaded resources that pass the filter
     */
    async loadByFilter(filterFn) {
        await this.initialize();

        const filteredEntries = this.index.files.filter(filterFn);
        const loadPromises = filteredEntries.map(entry => this.loadFile(entry));

        return await Promise.all(loadPromises);
    }

    /**
     * Load a single file based on its index entry
     * @param {Object} entry - Index entry
     * @returns {Promise<Object>} Loaded resource
     */
    async loadFile(entry) {
        if (!entry.filename) {
            throw new Error('Index entry missing filename');
        }

        const filePath = path.join(this.packageSubfolder, entry.filename);

        try {
            const content = await fs.readFile(filePath, 'utf8');
            return normalizeVersionedCanonicals(JSON.parse(content));
        } catch (error) {
            throw new Error(`Failed to load file ${entry.filename}: ${error.message}`);
        }
    }

    /**
     * Get the raw index data
     * @returns {Promise<Object>} The index object
     */
    async getIndex() {
        await this.initialize();
        return this.index;
    }

    /**
     * Get all resources (index entries only, not loaded)
     * @returns {Promise<Array>} All index entries
     */
    async getAllResources() {
        await this.initialize();
        return this.index.files;
    }

    /**
     * Check if a resource exists by reference
     * @param {Object} reference - Reference object (same as loadByReference)
     * @returns {Promise<boolean>} True if resource exists
     */
    async exists(reference) {
        await this.initialize();

        // Check by resourceType and id
        if (reference.resourceType && reference.id) {
            const key = `${reference.resourceType}/${reference.id}`;
            if (this.indexByTypeAndId.has(key)) {
                return true;
            }
        }

        // Check by canonical URL
        if (reference.url) {
            if (reference.version) {
                const versionedUrl = `${reference.url}|${reference.version}`;
                if (this.indexByCanonical.has(versionedUrl)) {
                    return true;
                }
            }

            if (this.indexByCanonical.has(reference.url)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Get statistics about the package content
     * @returns {Promise<Object>} Statistics object
     */
    async getStatistics() {
        await this.initialize();

        const stats = {
            totalResources: this.index.files.length,
            indexVersion: this.index['index-version'],
            resourceTypes: {}
        };

        for (const entry of this.index.files) {
            if (entry.resourceType) {
                stats.resourceTypes[entry.resourceType] =
                    (stats.resourceTypes[entry.resourceType] || 0) + 1;
            }
        }

        return stats;
    }

    fhirVersion() {
        // Handle both modern 'fhirVersions' and older 'fhir-version-list' formats
        const versions = this.package.fhirVersions || this.package['fhir-version-list'];
        return versions ? versions[0] : undefined;
    }

    id() {
        return this.package?.name;
    }

    version() {
        return this.package.version;
    }

    pid() {
        return this.id()+"#"+this.version();
    }
}


/**
 * Some R4-era core package resources bake a version into the canonical url itself:
 * hl7.fhir.r4.core#4.0.1 publishes the multi-version v2 tables (0006, 0360, 0391)
 * as e.g. url "http://terminology.hl7.org/CodeSystem/v2-0360|2.7" with version "0360"
 * (the table number!). The base packages can never be republished, so normalize at
 * load time: split the pipe into url + version, on the CodeSystems themselves and on
 * ValueSet compose include/exclude systems that reference them. Without this,
 * provider.system() never matches the system in a coding, so validation fails -
 * silently, in the CodeSystem $validate-code case.
 */
function normalizeVersionedCanonicals(resource) {
    if (!resource || typeof resource !== 'object') {
        return resource;
    }
    if (resource.resourceType === 'CodeSystem' || resource.resourceType === 'ValueSet') {
        if (typeof resource.url === 'string' && resource.url.includes('|')) {
            const cut = resource.url.indexOf('|');
            // the url-embedded version wins over the version element (which is "0360" etc)
            resource.version = resource.url.substring(cut + 1);
            resource.url = resource.url.substring(0, cut);
        }
        if (resource.resourceType === 'ValueSet' && resource.compose) {
            for (const list of [resource.compose.include, resource.compose.exclude]) {
                for (const inc of list || []) {
                    if (typeof inc.system === 'string' && inc.system.includes('|')) {
                        const cut = inc.system.indexOf('|');
                        if (!inc.version) {
                            inc.version = inc.system.substring(cut + 1);
                        }
                        inc.system = inc.system.substring(0, cut);
                    }
                }
            }
        }
    }
    return resource;
}

module.exports = { PackageManager, PackageContentLoader, normalizeVersionedCanonicals };