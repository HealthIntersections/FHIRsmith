// The helpers behind the OpenAPI descriptions: applyOverlay (library/fhir-openapi-schema.js)
// and extractSchema (utilities/extract-schema-json.js).

const { applyOverlay } = require('../../library/fhir-openapi-schema');
const { extractSchema } = require('../../utilities/extract-schema-json');

describe('applyOverlay', () => {
  const base = () => ({
    A: { type: 'object', properties: { x: { type: 'string', description: 'x' } }, required: ['x'] }
  });

  test('merges objects, unions required, replaces the rest, and adds new schemas', () => {
    const s = applyOverlay(base(), {
      A: { required: ['y'], properties: { x: { minLength: 1 }, y: { type: 'integer' } } },
      B: { type: 'string' }
    });
    expect(s.A.required).toEqual(['x', 'y']);
    expect(s.A.properties.x).toEqual({ type: 'string', description: 'x', minLength: 1 });
    expect(s.A.properties.y).toEqual({ type: 'integer' });
    expect(s.B).toEqual({ type: 'string' });
  });

  test('$replace replaces an object instead of merging it', () => {
    const s = applyOverlay(base(), { A: { properties: { x: { $replace: true, type: 'boolean' } } } });
    expect(s.A.properties.x).toEqual({ type: 'boolean' });
  });

  test('refuses keys that would reach a prototype', () => {
    expect(() => applyOverlay(base(), JSON.parse('{"A": {"__proto__": {"polluted": true}}}'))).toThrow(/__proto__/);
    expect(() => applyOverlay(base(), { A: { properties: { constructor: { prototype: { polluted: true } } } } })).toThrow(/constructor/);
    expect(() => applyOverlay(base(), JSON.parse('{"__proto__": {"polluted": true}}'))).toThrow(/__proto__/);
    expect({}.polluted).toBeUndefined();
  });
});

describe('extractSchema', () => {
  test('takes the one <pre>, strips markup, decodes entities', () => {
    const r = extractSchema('<html><pre class="json"><span>{"a": "&lt;b&gt;", "c": <a href="x">"d"</a>}</span></pre></html>');
    expect(r).toEqual({ json: '{"a": "<b>", "c": "d"}\n' });
  });

  test('strips nested and overlapping markup completely', () => {
    const r = extractSchema('<pre>{"a": 1}<scr<script>ipt>x</scr</script>ipt></pre>');
    expect(r.json).toBeUndefined();
    expect(r.problem).toMatch(/not valid JSON/);
    expect(extractSchema('<pre><<b>i>{"a": 1}</pre>').json).toBe('{"a": 1}\n');
  });

  test('reports a page without exactly one <pre>', () => {
    expect(extractSchema('<p>none</p>').problem).toBe('no <pre> element');
    expect(extractSchema('<pre>{}</pre><pre>{}</pre>').problem).toBe('2 <pre> elements');
  });
});
