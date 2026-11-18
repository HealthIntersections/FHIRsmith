//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * A provider for the runner that holds resources in memory, and resolves references the ways
 * FHIR content uses them:
 *
 *   #id               - a contained resource, inside the resource being processed ('#' alone is
 *                       that resource itself)
 *   in a Bundle       - for a resource added from a Bundle (addBundle), or a Bundle processed
 *                       itself: absolute references and urn:uuid:/urn:oid: match entry fullUrls;
 *                       relative references (Type/id) resolve against the base of the entry's
 *                       fullUrl, or match an entry's type and id
 *   Type/id           - any resource added, by type and id
 *
 * A version-specific reference (Type/id/_history/v) resolves as the plain reference. A type
 * specifier (getReferenceKey(Patient)) means a target of another type is no target at all.
 *
 * When a relative reference (Type/id) has no target here, the provider makes a stub
 * {resourceType, id} for it, by default: getReferenceKey() derives a key from the reference, and
 * the target does not have to be among the resources being processed (the shared test suite
 * relies on this). Pass synthesizeMissing: false to resolve only to resources that are here.
 *
 * Write a provider of your own for anything else (a database, a server): it needs fetch() and
 * resolveReference() - see runner.js.
 */

class MemoryProvider {
  /**
   * @param {Object} [options]
   * @param {boolean} [options.synthesizeMissing=true] - make stub targets for unresolved Type/id references
   */
  constructor(options = {}) {
    this.synthesizeMissing = options.synthesizeMissing !== false;
    this.byType = new Map(); // resourceType -> [resource]
    this.byId = new Map(); // Type/id -> resource
    this.byFullUrl = new Map(); // fullUrl -> resource, for every Bundle added
    this.entries = new WeakMap(); // resource -> { bundle, fullUrl }, for resources added from a Bundle
    this.bundleUrls = new WeakMap(); // bundle -> Map(fullUrl -> resource)
  }

  /** Adds a resource (a Bundle is added as itself; see addBundle for its entries). */
  add(resource) {
    if (!resource || !resource.resourceType) {
      throw new Error('Not a resource');
    }
    let list = this.byType.get(resource.resourceType);
    if (!list) {
      list = [];
      this.byType.set(resource.resourceType, list);
    }
    list.push(resource);
    if (resource.id) {
      this.byId.set(`${resource.resourceType}/${resource.id}`, resource);
    }
    if (resource.resourceType === 'Bundle') {
      this.indexBundle(resource);
    }
    return this;
  }

  /**
   * Adds the resources in a Bundle's entries, so a view over (say) Condition sees the Conditions
   * in a document, resolving their references inside the Bundle. The Bundle itself is added too,
   * unless includeBundle is false.
   */
  addBundle(bundle, options = {}) {
    if (options.includeBundle !== false) {
      this.add(bundle);
    } else {
      this.indexBundle(bundle);
    }
    for (const entry of bundle.entry || []) {
      if (entry.resource) {
        this.add(entry.resource);
        this.entries.set(entry.resource, { bundle, fullUrl: entry.fullUrl || null });
      }
    }
    return this;
  }

  indexBundle(bundle) {
    if (this.bundleUrls.has(bundle)) {
      return;
    }
    const urls = new Map();
    for (const entry of bundle.entry || []) {
      if (entry.resource && entry.fullUrl) {
        urls.set(entry.fullUrl, entry.resource);
        this.byFullUrl.set(entry.fullUrl, entry.resource);
      }
    }
    this.bundleUrls.set(bundle, urls);
  }

  /** The fullUrl of the Bundle entry a resource was added from (addBundle), or null. */
  fullUrlOf(resource) {
    const e = resource ? this.entries.get(resource) : null;
    return e ? e.fullUrl : null;
  }

  fetch(resourceType) {
    return this.byType.get(resourceType) || [];
  }

  resolveReference(root, reference, resourceType) {
    const target = this.find(root, reference);
    if (target && resourceType && target.resourceType !== resourceType) {
      return null;
    }
    return target;
  }

  find(root, reference) {
    if (!reference) {
      return null;
    }
    if (reference.startsWith('#')) {
      if (reference === '#') {
        return root || null;
      }
      const id = reference.substring(1);
      return (root && Array.isArray(root.contained) && root.contained.find(c => c && c.id === id)) || null;
    }
    const ref = stripHistory(reference);

    // inside a Bundle
    const entry = root ? this.entries.get(root) : null;
    const bundle = entry ? entry.bundle : (root && root.resourceType === 'Bundle' ? root : null);
    if (bundle) {
      this.indexBundle(bundle);
      const urls = this.bundleUrls.get(bundle);
      if (isAbsolute(ref)) {
        const t = urls.get(ref);
        if (t) {
          return t;
        }
      } else {
        const base = entry && entry.fullUrl ? restBase(entry.fullUrl) : null;
        if (base && urls.has(base + ref)) {
          return urls.get(base + ref);
        }
        const [type, id] = splitTypeId(ref);
        if (type) {
          for (const e of bundle.entry || []) {
            if (e.resource && e.resource.resourceType === type && e.resource.id === id) {
              return e.resource;
            }
          }
        }
      }
    }

    if (isAbsolute(ref)) {
      return this.byFullUrl.get(ref) || null;
    }
    const [type, id] = splitTypeId(ref);
    if (!type) {
      return null;
    }
    const found = this.byId.get(`${type}/${id}`);
    if (found) {
      return found;
    }
    return this.synthesizeMissing ? { resourceType: type, id } : null;
  }
}

function stripHistory(ref) {
  const h = ref.indexOf('/_history/');
  return h > -1 ? ref.substring(0, h) : ref;
}

function isAbsolute(ref) {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(ref);
}

/** For a RESTful fullUrl (base/Type/id), the base with a trailing slash; otherwise null. */
function restBase(fullUrl) {
  const m = /^(.*\/)[A-Z][A-Za-z]+\/[A-Za-z0-9\-.]{1,64}$/.exec(stripHistory(fullUrl));
  return m && !fullUrl.startsWith('urn:') ? m[1] : null;
}

function splitTypeId(ref) {
  const parts = ref.split('/');
  if (parts.length !== 2 || !/^[A-Z][A-Za-z]+$/.test(parts[0]) || !parts[1]) {
    return [null, null];
  }
  return parts;
}

module.exports = { MemoryProvider };
