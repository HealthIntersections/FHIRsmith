//
// JSON of large resources, with the JSON of their large arrays kept for next time
//

/**
 * JSON.stringify(resource), but with the JSON of the resource's arrays - a CodeSystem's
 * concepts, an expansion's contains - taken from the cache the XML uses (XmlFragmentCache,
 * under the key 'json'), and put there when one took long enough to be worth keeping. The
 * same rules as for XML: only an array that was expensive twice is kept, keyed on the array
 * itself, so the R3/R4/R5 conversions that share it share its JSON too.
 *
 * JSON.stringify can't let other work run while it runs, so the first two requests for a large
 * resource still hold the event loop; after that, it's a string join.
 *
 * Arrays are looked for at the top of the resource and one level down (expansion.contains). The
 * output is what JSON.stringify gives, key order included.
 *
 * @param {Object} resource
 * @param {XmlFragmentCache|null} cache
 * @returns {string}
 */
function resourceToJson(resource, cache) {
  if (!cache || resource === null || typeof resource !== 'object' || Array.isArray(resource)) {
    return JSON.stringify(resource);
  }
  return objectJson(resource, cache, 0);
}

const KEY = 'json';
const DEPTH = 1;

function objectJson(obj, cache, depth) {
  if (typeof obj.toJSON === 'function') {
    return JSON.stringify(obj);
  }
  const parts = [];
  for (const [key, value] of Object.entries(obj)) {
    let text;
    if (Array.isArray(value)) {
      text = arrayJson(value, cache);
    } else if (depth < DEPTH && value !== null && typeof value === 'object') {
      text = objectJson(value, cache, depth + 1);
    } else {
      text = JSON.stringify(value);
    }
    if (text !== undefined) { // undefined, functions, symbols: left out, as JSON.stringify does
      parts.push(JSON.stringify(key) + ':' + text);
    }
  }
  return '{' + parts.join(',') + '}';
}

function arrayJson(array, cache) {
  const kept = cache.get(array, KEY);
  if (kept !== null) {
    return kept;
  }
  const start = performance.now();
  const text = JSON.stringify(array);
  if (cache.wants(array, KEY, performance.now() - start)) {
    cache.put(array, KEY, text);
  }
  return text;
}

module.exports = { resourceToJson };
