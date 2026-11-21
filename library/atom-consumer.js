//
// Atom syndication consumer (Phase 2).
//
// Given an Atom feed URL, fetches the feed, downloads every <entry>'s
// enclosure into the terminology-cache folder, and returns a list of
// virtual `library.yml` source lines that point at the now-cached
// artifacts. The caller (Library.processSource for `atom:` sources)
// then runs the existing per-type loaders against those sub-sources.
//
// Recognised <category term="..."> values:
//   fhir-package      -> NPM package (.tgz)            -> "npm:<id>#<ver>"
//   snomed-cache      -> SNOMED .cache binary          -> "snomed:<filename>"
//   terminology-db    -> SQLite .db binary             -> "<loinc|rxnorm|...>:<filename>"
//   xml-resource      -> UCUM / similar XML            -> "ucum:<relative-path>"
//
// Ontoserver syndication categories (from CSIRO Ontoserver):
//   SCT_RF2_ALL       -> SNOMED RF2 zip -> extract -> import -> "snomed:<filename>.cache"
//   FHIR_ValueSet     -> FHIR ValueSet JSON (future)
//   FHIR_StructureDefinition -> FHIR StructureDefinition JSON (future)
//   BINARY            -> Ontoserver-proprietary (skipped)
//
// Entries with unknown categories are skipped with a warning.
//

const axios = require('axios');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const stream = require('stream');
const zlib = require('zlib');
const tar = require('tar');
const { XMLParser } = require('fast-xml-parser');
const { Rf2Importer } = require('./rf2-importer');

const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const RF2_DOWNLOAD_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes for large RF2 files

class AtomConsumer {
  /**
   * @param {string} cacheFolder - absolute path to the terminology-cache folder
   * @param {object} log         - logger with .info/.warn/.error
   * @param {object} options     - additional options
   * @param {object} options.auth - authentication config { type: 'bearer', token: '...' }
   * @param {object} options.mldsAuth - MLDS auth config { username, password } for mlds.ihtsdotools.org
   */
  constructor(cacheFolder, log, options = {}) {
    this.cacheFolder = cacheFolder;
    this.log = log;
    this.auth = options.auth || null;
    this.mldsAuth = options.mldsAuth || null;
    this.parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      removeNSPrefix: true, // strip sy:, fs:, atom: prefixes for easier access
    });
  }

  /**
   * Get axios config with auth headers if configured
   * @param {object} extraConfig - additional axios config
   * @param {boolean} forMlds - if true, use MLDS auth instead of bearer token
   */
  #getAxiosConfig(extraConfig = {}, forMlds = false) {
    const config = {
      timeout: DOWNLOAD_TIMEOUT_MS,
      ...extraConfig
    };

    if (forMlds && this.mldsAuth?.username && this.mldsAuth?.password) {
      config.auth = {
        username: this.mldsAuth.username,
        password: this.mldsAuth.password
      };
    } else if (this.auth?.type === 'bearer' && this.auth?.token) {
      config.headers = {
        ...config.headers,
        'Authorization': `Bearer ${this.auth.token}`
      };
    }

    return config;
  }

  /**
   * Check if a URL points to MLDS
   */
  #isMldsUrl(url) {
    return url && url.includes('mlds.ihtsdotools.org');
  }

  /**
   * Fetch an Atom feed and resolve every entry into a cached artifact.
   * @param {string} feedUrl
   * @returns {Promise<string[]>} virtual source lines for downstream processSource
   */
  async expand(feedUrl) {
    this.log.info(`Atom feed: ${feedUrl}`);
    const response = await axios.get(feedUrl, this.#getAxiosConfig({
      responseType: 'text',
    }));
    const parsed = this.parser.parse(response.data);
    const entries = this.#asArray(parsed.feed?.entry);

    const sources = [];
    for (const entry of entries) {
      try {
        const sub = await this.#processEntry(entry, feedUrl);
        if (sub) sources.push(sub);
      } catch (err) {
        const title = entry?.title || '<no title>';
        this.log.warn(`  skipping entry "${title}": ${err.message}`);
      }
    }
    return sources;
  }

  // ---------- per-entry ----------

  async #processEntry(entry, feedBase) {
    const category = this.#firstCategoryTerm(entry.category);
    const enclosure = this.#findEnclosure(entry.link);
    if (!enclosure) throw new Error('no <link rel="alternate">');

    const downloadUrl = this.#resolveUrl(enclosure['@_href'], feedBase);

    switch (category) {
      case 'fhir-package':
        return await this.#handlePackage(entry, downloadUrl);
      case 'snomed-cache':
        return await this.#handleBinary(downloadUrl, 'snomed');
      case 'terminology-db':
        return await this.#handleBinary(downloadUrl, this.#guessDbType(downloadUrl));
      case 'xml-resource':
        return await this.#handleBinary(downloadUrl, 'ucum');
      case 'SCT_RF2_ALL':
        return await this.#handleRf2(entry, downloadUrl);
      case 'BINARY':
        throw new Error('BINARY category is Ontoserver-proprietary and not supported');
      case 'FHIR_ValueSet':
      case 'FHIR_StructureDefinition':
      case 'FHIR_CodeSystem':
      case 'FHIR_ConceptMap':
        throw new Error(`FHIR resource category "${category}" not yet implemented`);
      default:
        throw new Error(`unsupported category "${category}"`);
    }
  }

  async #handlePackage(entry, url) {
    const version = entry.contentItemVersion;
    if (!version) throw new Error('package entry missing <sy:contentItemVersion>');

    // Derive package id. Producer URLs follow .../packages/<id>/<version>/package.tgz.
    let id = null;
    const m = url.match(/\/packages\/([^/]+)\/[^/]+\/package\.tgz(?:\?.*)?$/);
    if (m) id = decodeURIComponent(m[1]);
    // Fallback: sy:contentItemIdentifier may carry the id directly (non-URL form)
    if (!id) {
      const ident = entry.contentItemIdentifier;
      if (ident && !/^https?:/.test(ident)) id = ident;
    }
    if (!id) throw new Error('cannot determine package id from URL or identifier');

    const cacheKey = `${id}#${version}`;
    const cacheDir = path.join(this.cacheFolder, cacheKey);

    if (await this.#exists(cacheDir)) {
      this.log.info(`  cached: ${cacheKey}`);
    } else {
      this.log.info(`  fetching: ${cacheKey} (${url})`);
      await this.#downloadAndExtractTgz(url, cacheDir);
    }
    return `npm:${id}#${version}`;
  }

  async #handleBinary(url, sourceType) {
    const filename = this.#basename(url);
    if (!filename) throw new Error(`cannot derive filename from URL: ${url}`);
    const dest = path.join(this.cacheFolder, filename);

    if (await this.#exists(dest)) {
      this.log.info(`  cached: ${filename}`);
    } else {
      this.log.info(`  fetching: ${filename} (${url})`);
      await this.#downloadToFile(url, dest);
    }
    return `${sourceType}:${filename}`;
  }

  /**
   * Handle SCT_RF2_ALL entries from Ontoserver syndication
   * Downloads the RF2 zip, extracts it, and converts to .cache format
   */
  async #handleRf2(entry, url) {
    // Extract edition and version from entry metadata
    // contentItemIdentifier: http://snomed.info/sct/11000172109
    // contentItemVersion: http://snomed.info/sct/11000172109/version/20260415
    const versionUri = entry.contentItemVersion;
    const canonical = entry.contentItemIdentifier;

    if (!versionUri) {
      throw new Error('RF2 entry missing contentItemVersion');
    }

    // Parse version URI to get edition and version date
    const match = versionUri.match(/sct\/(\d+)\/version\/(\d+)/);
    if (!match) {
      throw new Error(`Cannot parse version URI: ${versionUri}`);
    }

    const edition = match[1];
    const version = match[2];
    const cacheFilename = `sct_${edition}_${version}.cache`;
    const cachePath = path.join(this.cacheFolder, cacheFilename);

    // Check if already imported
    if (await this.#exists(cachePath)) {
      this.log.info(`  cached: ${cacheFilename}`);
      return `snomed:${cacheFilename}`;
    }

    // Download the RF2 zip
    const zipFilename = this.#basename(url) || `sct_${edition}_${version}.zip`;
    const zipPath = path.join(this.cacheFolder, zipFilename);

    if (!await this.#exists(zipPath)) {
      // Check if this is an MLDS download
      const isMlds = this.#isMldsUrl(url);

      if (isMlds && !this.mldsAuth?.username) {
        throw new Error(
          `RF2 download requires MLDS credentials.\n` +
          `  URL: ${url}\n` +
          `  Register at https://mlds.ihtsdotools.org and provide mldsAuth config.\n` +
          `  Or download manually and place at: ${zipPath}`
        );
      }

      this.log.info(`  fetching RF2: ${zipFilename}`);
      this.log.info(`    from: ${url}`);
      if (isMlds) {
        this.log.info(`    using MLDS credentials`);
      }

      await this.#downloadToFile(url, zipPath, {
        timeout: RF2_DOWNLOAD_TIMEOUT_MS,
        forMlds: isMlds
      });
    } else {
      this.log.info(`  RF2 zip cached: ${zipFilename}`);
    }

    // Import RF2 to cache format
    this.log.info(`  importing RF2 -> ${cacheFilename}`);
    const importer = new Rf2Importer({ log: this.log });

    try {
      const result = await importer.importZip(zipPath, cachePath, {
        edition,
        version,
        uri: versionUri
      });
      this.log.info(`  imported: ${result.editionName} ${version}`);
    } catch (err) {
      // Cleanup partial cache file on failure
      if (await this.#exists(cachePath)) {
        await fs.unlink(cachePath);
      }
      throw new Error(`RF2 import failed: ${err.message}`);
    }

    return `snomed:${cacheFilename}`;
  }

  // ---------- IO ----------

  async #downloadToFile(url, dest, options = {}) {
    const timeout = options.timeout || DOWNLOAD_TIMEOUT_MS;
    const forMlds = options.forMlds || false;
    const response = await axios.get(url, this.#getAxiosConfig({
      responseType: 'arraybuffer',
      timeout,
    }, forMlds));
    await fs.writeFile(dest, Buffer.from(response.data));
  }

  async #downloadAndExtractTgz(url, destDir) {
    const response = await axios.get(url, this.#getAxiosConfig({
      responseType: 'arraybuffer',
    }));
    await fs.mkdir(destDir, { recursive: true });
    await new Promise((resolve, reject) => {
      const gunzip = zlib.createGunzip();
      const extract = tar.extract({ cwd: destDir });
      stream.Readable.from(Buffer.from(response.data))
        .pipe(gunzip)
        .pipe(extract)
        .on('finish', resolve)
        .on('error', reject);
      gunzip.on('error', reject);
      extract.on('error', reject);
    });
  }

  // ---------- helpers ----------

  #asArray(v) {
    if (v === undefined || v === null) return [];
    return Array.isArray(v) ? v : [v];
  }

  #firstCategoryTerm(categoryNode) {
    const arr = this.#asArray(categoryNode);
    for (const c of arr) {
      if (c && c['@_term']) return c['@_term'];
    }
    return null;
  }

  #findEnclosure(linkNode) {
    const arr = this.#asArray(linkNode);
    return arr.find(l => (l['@_rel'] || 'alternate') === 'alternate') || arr[0] || null;
  }

  #resolveUrl(href, base) {
    if (!href) return null;
    if (/^https?:/.test(href)) return href;
    return new URL(href, base).toString();
  }

  #basename(url) {
    try {
      const u = new URL(url);
      const last = u.pathname.split('/').filter(Boolean).pop();
      return last ? decodeURIComponent(last) : null;
    } catch {
      return null;
    }
  }

  #guessDbType(url) {
    const lower = this.#basename(url)?.toLowerCase() || '';
    if (lower.includes('loinc')) return 'loinc';
    if (lower.includes('rxnorm')) return 'rxnorm';
    if (lower.includes('ndc')) return 'ndc';
    if (lower.includes('unii')) return 'unii';
    if (lower.includes('cpt')) return 'cpt';
    if (lower.includes('omop')) return 'omop';
    return 'loinc'; // default; operator can rename the file or override
  }

  async #exists(p) {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = AtomConsumer;
