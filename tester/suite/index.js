//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * The tests of a FHIR RESTful server: run from the web pages (tester/tester.js) against any
 * server, and by jest against this server's own (tests/tester/suite.test.js).
 *
 * A group is { name, tests: [{ name, requires, run }] }. requires says what the test needs the
 * server to say it supports (tester/engine.js: whyNot): interactions [[type, code]], system
 * [code], search [[type, name]], operations [[type, name]], scope [type] (searches of the type
 * can be limited to the run's resources), format ('xml'), and check (cap => why not, or null).
 * run(ctx) does the test (tester/engine.js: TestContext): ctx.must for what the specification
 * requires, ctx.should for what it recommends.
 *
 * Tests only make resources of the run's own (ctx.resource, ctx.create), and only look at the
 * run's own resources: the server has data of its own, and other clients may be using it.
 *
 * @module tester/suite
 */

const GROUPS = ['capabilities', 'crud', 'errors', 'history', 'search', 'search-types', 'search-references', 'search-contained', 'search-results', 'conditional', 'patch',
  'transaction', 'operations', 'observations', 'http', 'xml', 'binary'];

/** The groups, in order */
function suite() {
  return GROUPS.map(g => require(`./${g}`));
}

/** How many tests there are */
function count() {
  return suite().reduce((n, g) => n + g.tests.length, 0);
}

module.exports = { suite, count, GROUPS };
