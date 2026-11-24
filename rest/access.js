//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * Who may do what. Every decision goes through decide(), which returns
 * { allowed, compartments }: compartments is null (no limit) or a list of compartments
 * ("Patient/123") the request is limited to. With roles only it is always null; it is there so
 * SMART on FHIR can be added without touching the interactions.
 *
 * Roles (library/auth, module 'rest', scoped by endpoint path):
 *   read    read, vread, search, history, capabilities, read operations
 *   write   create, update, patch, delete, batch, transaction, writing operations
 *   manage  the endpoint's settings, types, custom search parameters, reindexing
 *
 * An endpoint can allow anonymous read ('read') or read and write ('write').
 *
 * @module rest/access
 */

const { forbidden, unauthorised } = require('./library/errors');

const MODULE = 'rest';
const READ = 'read';
const WRITE = 'write';
const MANAGE = 'manage';

// 'bundle': posting a batch or transaction needs only read; each entry is then checked for
// what it does
const READ_INTERACTIONS = new Set(['read', 'vread', 'search-type', 'search-system', 'history-instance', 'history-type', 'history-system',
  'capabilities', 'operation-read', 'bundle']);

/**
 * Which role an interaction needs.
 * @param {string} interaction
 */
function roleFor(interaction) {
  if (READ_INTERACTIONS.has(interaction)) {
    return READ;
  }
  if (interaction === 'manage') {
    return MANAGE;
  }
  return WRITE;
}

/**
 * The access decision.
 * @param {Object|null} principal - from auth.principal(req), or null for nobody
 * @param {Object} endpoint - { path, settings }
 * @param {string} interaction
 * @returns {{allowed: boolean, compartments: string[]|null, reason?: string}}
 */
function decide(principal, endpoint, interaction) {
  const role = roleFor(interaction);
  const anonymous = endpoint.settings.anonymous || 'none';
  if (role === READ && (anonymous === 'read' || anonymous === 'write')) {
    return { allowed: true, compartments: null };
  }
  if (role === WRITE && anonymous === 'write') {
    return { allowed: true, compartments: null };
  }
  if (!principal) {
    return { allowed: false, compartments: null, reason: 'login' };
  }
  const scope = endpoint.path;
  // write implies read; manage implies both
  const roles = role === READ ? [READ, WRITE, MANAGE] : role === WRITE ? [WRITE, MANAGE] : [MANAGE];
  for (const r of roles) {
    if (principal.has(MODULE, r, scope)) {
      return { allowed: true, compartments: null };
    }
  }
  return { allowed: false, compartments: null, reason: 'forbidden' };
}

/**
 * Check access, throwing 401 or 403.
 * @returns {{allowed: true, compartments: string[]|null}}
 */
function check(principal, endpoint, interaction) {
  const d = decide(principal, endpoint, interaction);
  if (!d.allowed) {
    if (d.reason === 'login') {
      throw unauthorised(`You need to log in (or send an API token) to ${interaction === 'capabilities' ? 'use' : interaction} on this endpoint`);
    }
    throw forbidden(`You don't have permission to ${interaction} on this endpoint`);
  }
  return d;
}

module.exports = { decide, check, roleFor, MODULE, READ, WRITE, MANAGE };
