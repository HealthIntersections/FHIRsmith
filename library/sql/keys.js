//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * The default keys for getResourceKey() and getReferenceKey(): Type/id, and for a contained
 * resource Type/id of its container + '#' + its own id, so that two resources that each contain
 * a #p1 do not get the same key. getReferenceKey() on a reference must give the same key as
 * getResourceKey() on its target, so storages use this for both unless they have keys of their own.
 *
 * @param {Object} resource - the resource to key (JSON)
 * @param {Object} [root] - the resource the runner is processing, which may contain it
 * @returns {string|null}
 */
function defaultResourceKey(resource, root) {
  if (!resource || !resource.resourceType) {
    return null;
  }
  if (root && root !== resource && Array.isArray(root.contained) && root.contained.includes(resource)) {
    return `${root.resourceType}/${root.id}#${resource.id}`;
  }
  return resource.id ? `${resource.resourceType}/${resource.id}` : null;
}

module.exports = { defaultResourceKey };
