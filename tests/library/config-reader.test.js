/**
 * config.json may have comments (library/config-reader.js)
 */
const fs = require('fs');
const path = require('path');
const { parseConfig } = require('../../library/config-reader');

describe('config.json with comments', () => {
  test('// and /* */ comments are allowed where white space is', () => {
    expect(parseConfig(`{
      // the server
      "server": { "port": 3000 }, // trailing
      /* a block
         over lines */
      "modules": { "tx": { "enabled": /* inline */ true } }
    }`)).toEqual({ server: { port: 3000 }, modules: { tx: { enabled: true } } });
  });

  test('comment markers in strings are text', () => {
    expect(parseConfig('{"url": "http://example.org//x", "s": "a\\"//b", "c": "/* no */"}'))
      .toEqual({ url: 'http://example.org//x', s: 'a"//b', c: '/* no */' });
  });

  test('plain JSON, and a byte order mark', () => {
    expect(parseConfig('﻿{"a": [1, 2]}')).toEqual({ a: [1, 2] });
  });

  test('a syntax error says where it is in the file, comments and all', () => {
    expect(() => parseConfig('{\n  // one\n  "a": 1\n  "b": 2\n}')).toThrow(/line 4/);
    expect(() => parseConfig('{ /* never closed }')).toThrow('unterminated /* comment at line 1, column 3');
  });

  test('config-template.json, which is commented, parses', () => {
    const t = parseConfig(fs.readFileSync(path.join(__dirname, '..', '..', 'config-template.json'), 'utf8'));
    expect(t.server).toBeDefined();
    expect(Object.keys(t.modules).length).toBeGreaterThan(5);
  });
});
