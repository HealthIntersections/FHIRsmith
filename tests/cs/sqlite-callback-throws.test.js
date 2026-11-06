/**
 * An exception thrown inside a sqlite3 callback
 *
 * node-sqlite3 runs callbacks from native code. Something thrown inside one
 * leaves the caller's promise unsettled, and N-API keeps the exception pending:
 * the process aborts (napi_throw FATAL, exit 134) when the statement is
 * finalized, at the latest on exit. The callbacks are wrapped (guarded() in
 * tx/library/sqlite-utilities.js) so a throw rejects the caller's promise
 * instead. Each case runs in a child process, as before the fix the abort
 * would take the jest worker down with it.
 */

const { spawnSync } = require('child_process');
const path = require('path');

const repo = path.resolve(__dirname, '../..');

// Runs `body` (an async function body) in a child node process, which also has
// an uncaughtException handler, as the server does. Prints what the awaited
// operation settled with.
function runChild(body) {
  const script = `
    const repo = ${JSON.stringify(repo)};
    const sqlite3 = require(repo + '/node_modules/sqlite3');
    const { OperationContext } = require(repo + '/tx/operation-context');
    const { Languages } = require(repo + '/library/languages');
    process.on('uncaughtException', (e) => { console.log('uncaught: ' + e.message); });
    const exec = (db, sql) => new Promise((resolve, reject) => db.exec(sql, (err) => err ? reject(err) : resolve()));
    (async () => { ${body} })().then(
      (r) => console.log('resolved: ' + JSON.stringify(r)),
      (e) => console.log('rejected: ' + e.message));
  `;
  return spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 60000 });
}

describe('a throw inside a sqlite3 callback', () => {
  test('a LOINC regex filter that runs over its time limit fails the request, not the process', () => {
    const r = runChild(`
      const { LoincServices } = require(repo + '/tx/cs/cs-loinc');
      const db = new sqlite3.Database(':memory:');
      await exec(db, \`CREATE TABLE PropertyValues (PropertyValueKey INTEGER PRIMARY KEY, Value TEXT);
        CREATE TABLE Properties (PropertyTypeKey INTEGER, CodeKey INTEGER, PropertyValueKey INTEGER);
        INSERT INTO PropertyValues VALUES (1, 'Glucose');
        INSERT INTO Properties VALUES (1, 1, 1);\`);
      const opContext = new OperationContext(new Languages(null));
      const provider = new LoincServices(opContext, [], db, {
        langs: new Map(), codes: new Map(), codeList: [], relationships: new Map(),
        propertyList: new Map([['COMPONENT', 1]])
      });
      // the next deadCheck() samples the clock, and finds the time is up
      opContext.timeLimit = -1;
      OperationContext._checkCounter = 1e9;
      await provider.filter({ filters: [] }, true, 'COMPONENT', 'regex', 'Gluc.*');
    `);
    expect(r.stderr).not.toMatch(/FATAL/);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/rejected: Operation exceeded time limit/);
  });

  test('an OMOP lookup whose callback throws rejects', () => {
    const r = runChild(`
      const { OMOPServices, OMOPConcept } = require(repo + '/tx/cs/cs-omop');
      const db = new sqlite3.Database(':memory:');
      await exec(db, \`CREATE TABLE Concepts (concept_id TEXT, concept_class_id TEXT, domain_id TEXT, vocabulary_id INTEGER,
          valid_start_date TEXT, valid_end_date TEXT, concept_code TEXT, invalid_reason TEXT, concept_name TEXT);
        CREATE TABLE ConceptSynonyms (concept_id TEXT, concept_synonym_name TEXT, language_concept_id TEXT);
        INSERT INTO Concepts VALUES ('1', 'Clinical Finding', 'Condition', 44819097, NULL, NULL, '123', NULL, 'x');\`);
      const provider = new OMOPServices(new OperationContext(new Languages(null)), [], db, { _version: '1' });
      // adding a property to a frozen array throws, inside the callback
      await provider.extendLookup(new OMOPConcept('1', 'x', 'Condition', 'Clinical Finding', 'S', 44819097),
        ['vocabulary-concept-id'], Object.freeze([]));
    `);
    expect(r.stderr).not.toMatch(/FATAL/);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/rejected: .*object is not extensible/);
  });

  test('a UNII lookup under way when the provider is closed does not abort', () => {
    const r = runChild(`
      const { UniiServices } = require(repo + '/tx/cs/cs-unii');
      const db = new sqlite3.Database(':memory:');
      await exec(db, \`CREATE TABLE Unii (UniiKey INTEGER PRIMARY KEY, Code TEXT, Display TEXT);
        CREATE TABLE UniiDesc (UniiKey INTEGER, Display TEXT);
        INSERT INTO Unii VALUES (1, 'G9ZF61LE7G', 'TEST SUBSTANCE');\`);
      const provider = new UniiServices(new OperationContext(new Languages(null)), [], db, '1');
      const located = provider.locate('G9ZF61LE7G');
      provider.close(); // a client disconnect, while the lookup is in flight
      return (await located).context.display;
    `);
    expect(r.stderr).not.toMatch(/FATAL/);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/resolved|rejected/);
    expect(r.stdout).not.toMatch(/uncaught/);
  });

  test('an RxNorm lookup under way when the provider is closed does not abort', () => {
    const r = runChild(`
      const { RxNormServices } = require(repo + '/tx/cs/cs-rxnorm');
      const db = new sqlite3.Database(':memory:');
      await exec(db, \`CREATE TABLE rxnconso (RXCUI TEXT, SAB TEXT, STR TEXT, TTY TEXT, SUPPRESS TEXT);
        CREATE TABLE RXNATOMARCHIVE (RXCUI TEXT, SAB TEXT, STR TEXT, TTY TEXT);
        INSERT INTO RXNATOMARCHIVE VALUES ('99', 'RXNORM', 'archived', 'SCD');\`);
      const provider = new RxNormServices(new OperationContext(new Languages(null)), [], db, {});
      const located = provider.locate('99'); // not current: the archive is queried from the callback
      provider.close();
      return (await located).context;
    `);
    expect(r.stderr).not.toMatch(/FATAL/);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/resolved|rejected/);
    expect(r.stdout).not.toMatch(/uncaught/);
  });
});
