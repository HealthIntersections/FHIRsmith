/**
 * The syndication store: the content that has flowed through the tx library, as the
 * Terminology Syndication Feed IG (https://build.fhir.org/ig/FHIR/fhir-syndication-ig/)
 * will publish it.
 *
 * The store is a folder (terminology-cache/syndication) holding syndication.json - the
 * metadata for every entry - and files/, copies of the naked resource files the library
 * loaded. Packages and binaries are not copied: packages are permanently available from
 * npm.fhir.org, and the binaries are write-once in the external store they were downloaded
 * from, so their entries link there.
 *
 * Rules (see the syndication design doc in the FHIRsmith project):
 * - content is inducted as the library loads it. Nothing is back-filled: anything the store
 *   has not seen before is new, and gets the time it was inducted
 * - the store only grows. Entries are never changed or removed, and there are no retract
 *   entries. A later update to the same content (a changed file for the same url|version)
 *   is a new entry, so contentItemVersion is deliberately not unique (the IG says it must
 *   be; the spec authors agree that rule is wrong)
 * - one store serves every endpoint. Only the core packages are FHIR version specific; their
 *   entries carry fhirVersion, and every other entry is in every endpoint's feed
 *
 * Induction is queued and done in the background, one item at a time, so that downloading
 * a package to hash it never holds up the server starting. A failed induction is logged and
 * not recorded, so it is tried again the next time the content is loaded.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const NCTS_SCHEME = 'http://ns.electronichealth.net.au/ncts/syndication/asf/scheme/1.0.0';
const FHIRSMITH_SCHEME = 'http://healthintersections.com.au/syndication/fhirsmith/1.0.0';
const PACKAGE_SERVER = 'https://npm.fhir.org/web/';
const STORE_FORMAT = 1;
// no fetch is allowed to hold induction (or server shutdown, which waits for it) for longer
const FETCH_TIMEOUT_MS = 120000;

/** library source type -> category term in the FHIRsmith scheme, for the binary sources */
const BINARY_TERMS = {
  snomed: 'SNOMED_CACHE',
  loinc: 'LOINC_DB',
  rxnorm: 'RXNORM_DB',
  ndc: 'NDC_DB',
  unii: 'UNII_DB',
  omop: 'OMOP_DB',
  icd11: 'ICD11_DB',
  cpt: 'CPT_DB'
};

const RESOURCE_TYPES = ['CodeSystem', 'ValueSet', 'ConceptMap'];

const SNOMED_RIGHTS = 'Use of SNOMED CT is subject to use limitations: a licence from SNOMED International or a national release centre is required';
const OTHER_RIGHTS = 'Use of this content is subject to the applicable licence';

/**
 * Whether a package version is a build rather than a release - #current and its kin are not
 * syndicated, since they change under the same version.
 */
function isBuildVersion(version) {
  if (!version) {
    return false;
  }
  const v = String(version);
  return /^(current|dev)/.test(v) || v.includes('cibuild');
}

/** SHA-256 of a file, streamed (the binaries run to gigabytes) */
function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * The SHA-256 and length of a response body, streamed rather than held in memory (some
 * packages are hundreds of megabytes)
 */
async function hashResponse(response) {
  const hash = crypto.createHash('sha256');
  let length = 0;
  if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of response.body) {
      hash.update(chunk);
      length += chunk.length;
    }
  } else {
    const buffer = Buffer.from(await response.arrayBuffer());
    hash.update(buffer);
    length = buffer.length;
  }
  return { sha256: hash.digest('hex'), length };
}

class SyndicationStore {
  /**
   * @param {string} folder - the store folder (created if need be)
   * @param {Object} log - logger
   * @param {Object} [options]
   * @param {Function} [options.fetch] - fetch implementation (tests)
   * @param {Function} [options.now] - clock (tests): returns a Date
   */
  constructor(folder, log, options = {}) {
    this.folder = folder;
    this.filesFolder = path.join(folder, 'files');
    this.jsonPath = path.join(folder, 'syndication.json');
    this.log = log;
    this.fetch = options.fetch || globalThis.fetch;
    this.now = options.now || (() => new Date());
    this.doc = null;
    this.queue = Promise.resolve();
    this.pending = 0;
  }

  /**
   * Read the store, or start it if there isn't one: the store is defined from now on.
   */
  open() {
    fs.mkdirSync(this.filesFolder, { recursive: true });
    if (fs.existsSync(this.jsonPath)) {
      const doc = JSON.parse(fs.readFileSync(this.jsonPath, 'utf8'));
      if (!doc || !Array.isArray(doc.entries) || !doc.id) {
        throw new Error(`The syndication store ${this.jsonPath} is not valid`);
      }
      this.doc = doc;
    } else {
      this.doc = {
        format: STORE_FORMAT,
        id: crypto.randomUUID(),
        created: this.now().toISOString(),
        entries: []
      };
      this.#save();
      this.log.info(`Syndication store started in ${this.folder}`);
    }
    this.#index();
    return this;
  }

  #index() {
    // key -> the most recent entry with that key
    this.byKey = new Map();
    for (const entry of this.doc.entries) {
      this.byKey.set(entry.key, entry);
    }
  }

  #save() {
    const tmp = this.jsonPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.doc, null, 2));
    fs.renameSync(tmp, this.jsonPath);
  }

  /** {string} the store's own id, from which each endpoint's feed id is made */
  get id() {
    return this.doc.id;
  }

  get created() {
    return this.doc.created;
  }

  /** {Object[]} every entry, in the order they were inducted */
  get entries() {
    return this.doc.entries;
  }

  /**
   * The entries in the feed for an endpoint at the given FHIR version: everything that isn't
   * version specific, plus that version's own.
   * @param {string} fhirVersion - major.minor
   */
  entriesFor(fhirVersion) {
    return this.doc.entries.filter(e => !e.fhirVersion || e.fhirVersion === fhirVersion);
  }

  /** Resolves when everything queued so far has been inducted (or has failed) */
  whenIdle() {
    return this.queue;
  }

  #enqueue(label, task) {
    this.pending++;
    this.queue = this.queue.then(async () => {
      try {
        await task();
      } catch (error) {
        this.log.warn(`Syndication: unable to induct ${label}: ${error.message}`);
      } finally {
        this.pending--;
      }
    });
    return this.queue;
  }

  #add(entry) {
    const now = this.now().toISOString();
    const full = {
      id: 'urn:uuid:' + crypto.randomUUID(),
      inducted: now,
      ...entry
    };
    this.doc.entries.push(full);
    this.byKey.set(full.key, full);
    this.#save();
    this.log.info(`Syndication: inducted ${full.title} (${full.version})`);
    return full;
  }

  /** download a url, keeping only its SHA-256 and length */
  async #downloadHash(url) {
    const response = await this.fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching ${url}`);
    }
    return hashResponse(response);
  }

  /**
   * A package the library loaded (npm: or url: source, or an endpoint's core package).
   *
   * @param {Object} pkg
   * @param {string} pkg.id - package id
   * @param {string} pkg.version - package version
   * @param {string} [pkg.canonical] - canonical from package.json
   * @param {string} [pkg.title] - title from package.json
   * @param {string} [pkg.description] - description from package.json
   * @param {string} [pkg.url] - where it came from, for a url: source; otherwise npm.fhir.org
   * @param {string} [pkg.fhirVersion] - major.minor, for a version specific (core) package only
   * @param {string} [pkg.requestedVersion] - the version the library asked for
   */
  inductPackage(pkg) {
    const label = `package ${pkg.id}#${pkg.version}`;
    if (isBuildVersion(pkg.version) || isBuildVersion(pkg.requestedVersion)) {
      return this.queue;
    }
    const key = `package:${pkg.id}#${pkg.version}`;
    if (this.byKey.has(key)) {
      return this.queue;
    }
    return this.#enqueue(label, async () => {
      if (this.byKey.has(key)) {
        return;
      }
      if (!pkg.canonical) {
        throw new Error('the package has no canonical in package.json');
      }
      const href = pkg.url || `${PACKAGE_SERVER}${encodeURIComponent(pkg.id)}-${encodeURIComponent(pkg.version)}.tgz`;
      // packages never change, so the copy on the server is the one that is hashed
      const { sha256, length } = await this.#downloadHash(href);
      const entry = {
        key,
        kind: 'package',
        category: { scheme: NCTS_SCHEME, term: 'FHIR_Package', label: 'FHIR Package' },
        identifier: pkg.canonical,
        version: `${pkg.canonical}|${pkg.version}`,
        title: pkg.title ? `${pkg.title} (${pkg.id}#${pkg.version})` : `${pkg.id}#${pkg.version}`,
        link: { href, type: 'application/gzip', length, sha256 }
      };
      if (pkg.description) {
        entry.summary = pkg.description;
      }
      if (pkg.fhirVersion) {
        entry.fhirVersion = pkg.fhirVersion;
      }
      this.#add(entry);
    });
  }

  /**
   * A resource the library loaded from a file: or folder: source. Resources without a version
   * are not syndicated. The file is copied into the store, and a later file with different
   * content for the same url|version is a new entry.
   *
   * @param {Object} res
   * @param {string} res.filePath - the file it was loaded from
   * @param {string} res.resourceType
   * @param {string} res.url
   * @param {string} res.version
   * @param {string} [res.title]
   * @param {string} [res.description]
   */
  inductResource(res) {
    if (!res.url || !res.version || !RESOURCE_TYPES.includes(res.resourceType)) {
      return this.queue;
    }
    const label = `${res.resourceType} ${res.url}|${res.version}`;
    const key = `resource:${res.url}|${res.version}`;
    return this.#enqueue(label, async () => {
      const bytes = await fsp.readFile(res.filePath);
      const sha256 = hashBuffer(bytes);
      const last = this.byKey.get(key);
      if (last && last.link.sha256 === sha256) {
        return;
      }
      const fileName = crypto.randomUUID() + '.json';
      await fsp.writeFile(path.join(this.filesFolder, fileName), bytes);
      const entry = {
        key,
        kind: 'resource',
        category: { scheme: NCTS_SCHEME, term: 'FHIR_' + res.resourceType, label: 'FHIR ' + res.resourceType },
        identifier: res.url,
        version: `${res.url}|${res.version}`,
        title: res.title || res.url,
        // relative: the feed makes it absolute under the endpoint the feed is read from
        link: { file: fileName, type: 'application/fhir+json', length: bytes.length, sha256 }
      };
      if (res.description) {
        entry.summary = res.description;
      }
      this.#add(entry);
    });
  }

  /**
   * A binary the library loaded (SNOMED cache, LOINC database etc). Only binaries that were
   * published to the external store (baseUrl) are syndicated - a file that is only local is a
   * development build. The binary is not copied: the entry links to the external store.
   * Binary file names change whenever their content does, so the file name is the key.
   *
   * @param {Object} bin
   * @param {string} bin.sourceType - library source type (snomed, loinc ...)
   * @param {string} bin.filePath - the local copy
   * @param {string} bin.baseUrl - the external store the library downloads binaries from
   * @param {string} bin.system - code system uri
   * @param {string} bin.version - code system version (for SNOMED, the version uri)
   * @param {string} [bin.name] - code system name
   */
  inductBinary(bin) {
    const term = BINARY_TERMS[bin.sourceType];
    const fileName = path.basename(bin.filePath);
    if (!term || !bin.baseUrl) {
      return this.queue;
    }
    // the full CPT database is licensed content, and is never distributed; the public
    // fragment is
    if (bin.sourceType === 'cpt' && !fileName.toLowerCase().includes('fragment')) {
      return this.queue;
    }
    const key = `binary:${fileName}`;
    if (this.byKey.has(key)) {
      return this.queue;
    }
    return this.#enqueue(`${bin.sourceType} file ${fileName}`, async () => {
      if (this.byKey.has(key)) {
        return;
      }
      const href = bin.baseUrl.replace(/\/+$/, '') + '/' + fileName;
      const stat = await fsp.stat(bin.filePath);
      const head = await this.fetch(href, { method: 'HEAD', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      const length = Number(head.headers.get('content-length'));
      if (!head.ok || length !== stat.size) {
        this.log.info(`Syndication: not syndicating ${fileName}: it is not published at ${href} (a local build)`);
        return;
      }
      const sha256 = await hashFile(bin.filePath);
      let identifier = bin.system;
      let version = bin.version ? `${bin.system}|${bin.version}` : bin.system;
      const sct = /^(.*)\/version\/[^/]+$/.exec(bin.version || '');
      if (bin.sourceType === 'snomed' && sct) {
        // SNOMED editions are identified by their module uri, and versioned by the version uri
        identifier = sct[1];
        version = bin.version;
      }
      const name = bin.name || bin.system;
      this.#add({
        key,
        kind: 'binary',
        category: { scheme: FHIRSMITH_SCHEME, term, label: term },
        identifier,
        version,
        title: `${name}${bin.version && !name.includes(bin.version) ? ' ' + bin.version : ''} (${fileName})`,
        summary: `FHIRsmith ${term} file ${fileName}`,
        rights: bin.sourceType === 'snomed' ? SNOMED_RIGHTS : OTHER_RIGHTS,
        link: { href, type: 'application/octet-stream', length: stat.size, sha256 }
      });
    });
  }

  /**
   * The local path of a file copied into the store, or null if there isn't one by that name
   * @param {string} name
   */
  filePath(name) {
    if (typeof name !== 'string' || !/^[0-9a-f-]{36}\.json$/.test(name)) {
      return null;
    }
    const p = path.join(this.filesFolder, name);
    return fs.existsSync(p) ? p : null;
  }
}

module.exports = {
  SyndicationStore, isBuildVersion, hashFile,
  NCTS_SCHEME, FHIRSMITH_SCHEME, BINARY_TERMS
};
