const { OCL_CODESYSTEM_MARKER_EXTENSION } = require('./constants');

const OCL_SEARCH_PATCH_FLAG = Symbol.for('fhirsmith.ocl.search.codesystem.code.patch');
const TXPARAMS_HASH_PATCH_FLAG = Symbol.for('fhirsmith.ocl.txparameters.hash.filter.patch');
const OCL_EXPAND_WHOLE_SYSTEM_PATCH_FLAG = Symbol.for('fhirsmith.ocl.expand.whole-system.patch');
const OCL_EXPAND_WHOLE_SYSTEM_RETRY_FLAG = Symbol.for('fhirsmith.ocl.expand.whole-system.retry');

function hasOCLCodeSystemMarker(resource) {
  const extensions = Array.isArray(resource?.extension) ? resource.extension : [];
  return extensions.some(ext => ext && ext.url === OCL_CODESYSTEM_MARKER_EXTENSION);
}

function filterConceptTreeByCode(concepts, wantedCode) {
  if (!Array.isArray(concepts) || concepts.length === 0) {
    return [];
  }

  const matches = [];
  for (const concept of concepts) {
    if (!concept || typeof concept !== 'object') {
      continue;
    }

    const childMatches = filterConceptTreeByCode(concept.concept, wantedCode);
    const isSelfMatch = concept.code != null && String(concept.code) === wantedCode;
    if (!isSelfMatch && childMatches.length === 0) {
      continue;
    }

    const clone = { ...concept };
    if (childMatches.length > 0) {
      clone.concept = childMatches;
    } else {
      delete clone.concept;
    }
    matches.push(clone);
  }

  return matches;
}

function filterOCLCodeSystemResourceByCode(resource, code) {
  if (!resource || typeof resource !== 'object') {
    return resource;
  }

  const filteredConcepts = filterConceptTreeByCode(resource.concept, code);
  return {
    ...resource,
    concept: filteredConcepts
  };
}

function patchSearchWorkerForOCLCodeFiltering() {
  let SearchWorker;
  try {
    SearchWorker = require('../../workers/search');
  } catch (_error) {
    return;
  }

  if (!SearchWorker || !SearchWorker.prototype) {
    return;
  }

  const proto = SearchWorker.prototype;
  if (proto[OCL_SEARCH_PATCH_FLAG] === true || typeof proto.searchCodeSystems !== 'function') {
    return;
  }

  const originalSearchCodeSystems = proto.searchCodeSystems;
  proto.searchCodeSystems = function patchedSearchCodeSystems(params) {
    const matches = originalSearchCodeSystems.call(this, params);
    const requestedCode = params?.code == null ? '' : String(params.code);

    if (!requestedCode) {
      return matches;
    }

    const filtered = [];
    for (const resource of matches) {
      if (!hasOCLCodeSystemMarker(resource)) {
        filtered.push(resource);
        continue;
      }

      const projected = filterOCLCodeSystemResourceByCode(resource, requestedCode);
      if (Array.isArray(projected?.concept) && projected.concept.length > 0) {
        filtered.push(projected);
      }
    }

    return filtered;
  };

  Object.defineProperty(proto, OCL_SEARCH_PATCH_FLAG, {
    value: true,
    writable: false,
    configurable: false,
    enumerable: false
  });
}

function normalizeFilterForCacheKey(filter) {
  if (typeof filter !== 'string') {
    return '';
  }

  return filter.trim().toLowerCase();
}

function ensureTxParametersHashIncludesFilter(TxParameters) {
  const proto = TxParameters && TxParameters.prototype;
  if (!proto || proto[TXPARAMS_HASH_PATCH_FLAG] === true || typeof proto.hashSource !== 'function') {
    return;
  }

  const originalHashSource = proto.hashSource;
  proto.hashSource = function hashSourceWithFilter() {
    const base = originalHashSource.call(this);
    const normalizedFilter = normalizeFilterForCacheKey(this.filter);
    return `${base}|filter=${normalizedFilter}`;
  };

  Object.defineProperty(proto, TXPARAMS_HASH_PATCH_FLAG, {
    value: true,
    writable: false,
    configurable: false,
    enumerable: false
  });
}

function isOclWholeSystemRetryCandidate(expander, cset, filter) {
  if (!expander || !cset) {
    return false;
  }

  // Only touch the OCL ValueSet path where OCL helpers are attached.
  const sourceValueSet = expander?.valueSet;
  if (!sourceValueSet || typeof sourceValueSet.oclFetchConcepts !== 'function') {
    return false;
  }

  // This fallback is only for whole-system, unfiltered includes.
  if (!cset.system || cset.concept || cset.filter) {
    return false;
  }
  if (!filter || filter.isNull !== true) {
    return false;
  }

  // Only engage when request did not ask for an explicit page and we have a limit.
  if (!(expander.count < 0 && expander.offset < 0 && expander.limitCount > 0)) {
    return false;
  }

  // Prevent recursive retries for the same include call path.
  if (expander[OCL_EXPAND_WHOLE_SYSTEM_RETRY_FLAG] === true) {
    return false;
  }

  return true;
}

function patchValueSetExpandWholeSystemForOcl() {
  let expandModule;
  try {
    expandModule = require('../../workers/expand');
  } catch (_error) {
    return;
  }

  const ValueSetExpander = expandModule?.ValueSetExpander;
  const proto = ValueSetExpander && ValueSetExpander.prototype;
  if (!proto || proto[OCL_EXPAND_WHOLE_SYSTEM_PATCH_FLAG] === true || typeof proto.includeCodes !== 'function') {
    return;
  }

  const originalIncludeCodes = proto.includeCodes;
  proto.includeCodes = async function patchedIncludeCodes(cset, path, vsSrc, compose, filter, expansion, excludeInactive, notClosed) {
    // ...existing code...
    // PATCH: Para OCL ValueSet, só expandir códigos explicitamente listados em compose.include.code
    if (Array.isArray(compose?.include)) {
      const explicitCodes = [];
      for (const include of compose.include) {
        // Normaliza o system para URL canônico
        const canonicalSystem = typeof include.system === 'string' ? include.system.trim() : include.system;
        if (Array.isArray(include.code)) {
          for (const code of include.code) {
            explicitCodes.push({ system: canonicalSystem, code });
          }
        }
        // Também verifica se há conceitos explícitos em include.concept
        if (Array.isArray(include.concept)) {
          for (const concept of include.concept) {
            if (concept && concept.code) {
              explicitCodes.push({ system: canonicalSystem, code: concept.code });
            }
          }
        }
      }
      if (explicitCodes.length > 0) {
        // Filtra expansão para só retornar os códigos explicitamente referenciados
        const filtered = [];
        for (const { system, code } of explicitCodes) {
          // Busca conceito no CodeSystem
          const resources = await originalIncludeCodes.call(this, { system, code }, path, vsSrc, compose, filter, expansion, excludeInactive, notClosed);
          if (Array.isArray(resources)) {
            filtered.push(...resources);
          } else if (resources) {
            filtered.push(resources);
          }
        }
        return filtered;
      }
    }
    // Fallback para comportamento original
    try {
      return await originalIncludeCodes.call(this, cset, path, vsSrc, compose, filter, expansion, excludeInactive, notClosed);
    } catch (error) {
      if (!isOclWholeSystemRetryCandidate(this, cset, filter)) {
        throw error;
      }

      const prevCount = this.count;
      const prevOffset = this.offset;
      this.count = this.limitCount;
      this.offset = 0;

      // Mirror effective pagination into expansion parameters for transparency.
      if (expansion && typeof this.addParamInt === 'function') {
        this.addParamInt(expansion, 'offset', this.offset);
        this.addParamInt(expansion, 'count', this.count);
        expansion.offset = this.offset;
      }

      this[OCL_EXPAND_WHOLE_SYSTEM_RETRY_FLAG] = true;
      try {
        return await originalIncludeCodes.call(this, cset, path, vsSrc, compose, filter, expansion, excludeInactive, notClosed);
      } finally {
        this[OCL_EXPAND_WHOLE_SYSTEM_RETRY_FLAG] = false;
        this.count = prevCount;
        this.offset = prevOffset;
      }
    }
  };

  Object.defineProperty(proto, OCL_EXPAND_WHOLE_SYSTEM_PATCH_FLAG, {
    value: true,
    writable: false,
    configurable: false,
    enumerable: false
  });
}


const OCL_PROVIDER_FACTORY_SYNC_PATCH_FLAG = Symbol.for('fhirsmith.ocl.provider.factory-sync.patch');

function patchProviderForOCLFactorySync(getFactoriesByKey) {
  let ProviderModule;
  try {
    ProviderModule = require('../../provider');
  } catch (_error) {
    return;
  }

  const Provider = ProviderModule?.Provider;
  const proto = Provider?.prototype;
  if (!proto || proto[OCL_PROVIDER_FACTORY_SYNC_PATCH_FLAG] === true) {
    return;
  }
  if (typeof proto.updateCodeSystemList !== 'function') {
    return;
  }

  const originalUpdateCodeSystemList = proto.updateCodeSystemList;
  proto.updateCodeSystemList = async function patchedUpdateCodeSystemList() {
    await originalUpdateCodeSystemList.call(this);
    const factoriesByKey = getFactoriesByKey();
    for (const factory of factoriesByKey.values()) {
      if (!factory) continue;
      const system = typeof factory.system === 'function' ? factory.system() : null;
      if (!system) continue;
      const ver = typeof factory.version === 'function' ? (factory.version() ?? '') : '';
      const vurl = `${system}|${ver}`;
      if (!this.codeSystemFactories.has(vurl)) {
        if (!this.codeSystemFactories.has(system)) {
          this.codeSystemFactories.set(system, factory);
        }
        this.codeSystemFactories.set(vurl, factory);
      }
    }
  };

  Object.defineProperty(proto, OCL_PROVIDER_FACTORY_SYNC_PATCH_FLAG, {
    value: true,
    writable: false,
    configurable: false,
    enumerable: false
  });
}

module.exports = {
  patchSearchWorkerForOCLCodeFiltering,
  ensureTxParametersHashIncludesFilter,
  patchValueSetExpandWholeSystemForOcl,
  normalizeFilterForCacheKey,
  patchProviderForOCLFactorySync
};
