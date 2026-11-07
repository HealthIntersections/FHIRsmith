// The XIG resource list filters: every value from the request goes in as a parameter, never into
// the SQL itself, and the text and package searches match what was typed, literally.

const sqlite3 = require('sqlite3');
const { buildResourceFilter, buildSecureResourceQuery, buildSecureResourceCountQuery } = require('../../xig/xig');

describe('XIG resource filter', () => {
  test('nothing filtered', () => {
    expect(buildResourceFilter({})).toEqual({ where: 'WHERE 1=1', params: [] });
  });

  test('request values are parameters, not SQL', () => {
    const evil = "x' OR '1'='1";
    const { where, params } = buildResourceFilter({ realm: evil, auth: evil, pkg: evil });
    expect(where).not.toContain(evil);
    expect(where).toContain('realm = ?');
    expect(where).toContain('authority = ?');
    expect(params).toEqual([evil, evil, `%${evil}%`]);
  });

  test('ver and type only choose fixed SQL', () => {
    expect(buildResourceFilter({ ver: 'R4' }).where).toBe('WHERE 1=1 AND R4 = 1');
    expect(buildResourceFilter({ ver: 'R4 = 1 OR 1' })).toEqual({ where: 'WHERE 1=1', params: [] });
    expect(buildResourceFilter({ type: 'cs; DROP TABLE Resources' })).toEqual({ where: 'WHERE 1=1', params: [] });
  });

  test('a repeated parameter (an array) uses the first value; an object is ignored', () => {
    expect(buildResourceFilter({ realm: ['uv', 'us'] })).toEqual({ where: 'WHERE 1=1 AND realm = ?', params: ['uv'] });
    expect(buildResourceFilter({ realm: { x: 'uv' } })).toEqual({ where: 'WHERE 1=1', params: [] });
  });

  test('package text: % and _ are literal', () => {
    const { where, params } = buildResourceFilter({ pkg: 'hl7_fhir%' });
    expect(where).toContain("LIKE ? ESCAPE '\\'");
    expect(params).toEqual(['%hl7\\_fhir\\%%']);
  });

  test('the list and the count use the same filter', () => {
    const q = { realm: 'uv', ver: 'R5', text: 'blood' };
    const list = buildSecureResourceQuery(q, 200, 50);
    const count = buildSecureResourceCountQuery(q);
    const { where, params } = buildResourceFilter(q);
    expect(list.query).toContain(where);
    expect(list.params).toEqual([...params, 50, 200]);
    expect(count).toEqual({ query: `SELECT COUNT(*) as total FROM Resources ${where}`, params });
  });

  test('text and package searches run in SQLite, and match literally', async () => {
    const db = new sqlite3.Database(':memory:');
    const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, e => e ? rej(e) : res()));
    const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, rows) => e ? rej(e) : res(rows)));
    try {
      await run('CREATE TABLE Resources (ResourceKey INTEGER, ResourceType TEXT, Type TEXT, Description TEXT, PackageKey INTEGER, Realm TEXT, Authority TEXT)');
      await run('CREATE TABLE Packages (PackageKey INTEGER, Id TEXT, Version TEXT)');
      await run('CREATE VIRTUAL TABLE ResourceFTS USING fts5(ResourceKey, Description, Narrative)');
      await run("INSERT INTO Packages VALUES (1, 'hl7.fhir.uv.ips', '1.1.0'), (2, 'hl7xfhir', '1.0.0')");
      await run("INSERT INTO Resources VALUES (1, 'ValueSet', null, 'say \"hello\" world', 1, 'uv', 'hl7'), (2, 'ValueSet', null, 'hello there', 2, 'uv', 'hl7')");
      await run("INSERT INTO ResourceFTS VALUES (1, 'say \"hello\" world', ''), (2, 'hello there', '')");
      const keys = async (q) => {
        const { where, params } = buildResourceFilter(q);
        return (await all(`SELECT ResourceKey FROM Resources ${where} ORDER BY ResourceKey`, params)).map(r => r.ResourceKey);
      };
      // a " can't end the phrase and add query syntax: this is one phrase, matching nothing
      expect(await keys({ text: 'hello" OR "there' })).toEqual([]);
      // and a lone " is not an error
      expect(await keys({ text: '"' })).toEqual([]);
      expect(await keys({ text: 'hello' })).toEqual([1, 2]);
      // _ is not a wildcard
      expect(await keys({ pkg: 'hl7_fhir' })).toEqual([]);
      expect(await keys({ pkg: 'fhir.uv' })).toEqual([1]);
      // a quote in a value is just a character
      expect(await keys({ realm: "uv' OR '1'='1" })).toEqual([]);
    } finally {
      await new Promise(r => db.close(r));
    }
  });
});
