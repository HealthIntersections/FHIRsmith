// The shared OpenAPI page renderer (library/openapi-doc.js): the "try it" forms, and markdown.

const { buildTryItRequest, curlCommand, markdown } = require('../../library/openapi-doc');
const packagesOpenApi = require('../../packages/openapi');
const testingOpenApi = require('../../testing/openapi');

describe('buildTryItRequest', () => {
  test('fills in path parameters, encoded', () => {
    const r = buildTryItRequest('/packages/{id}/{version}', [
      { in: 'path', name: 'id', value: '@scope/name' },
      { in: 'path', name: 'version', value: '1.0.0' }
    ]);
    expect(r).toEqual({ url: '/packages/%40scope%2Fname/1.0.0', headers: {}, missing: [] });
  });

  test('reports missing path parameters', () => {
    expect(buildTryItRequest('/x/{id}', [{ in: 'path', name: 'id', value: ' ' }]).missing).toEqual(['id']);
  });

  test('adds non-empty query parameters, encoded, and headers', () => {
    const r = buildTryItRequest('/tx-reg/resolve', [
      { in: 'query', name: 'fhirVersion', value: 'R4' },
      { in: 'query', name: 'url', value: 'http://snomed.info/sct|http://snomed.info/sct/32506021000036107' },
      { in: 'query', name: 'usage', value: '' },
      { in: 'header', name: 'Prefer', value: 'handling=strict' }
    ]);
    expect(r.url).toBe('/tx-reg/resolve?fhirVersion=R4&url=http%3A%2F%2Fsnomed.info%2Fsct%7Chttp%3A%2F%2Fsnomed.info%2Fsct%2F32506021000036107');
    expect(r.headers).toEqual({ Prefer: 'handling=strict' });
  });

  test('keeps modifiers in parameter names', () => {
    expect(buildTryItRequest('/testing/TestReport', [{ in: 'query', name: 'name:exact', value: 'x' }]).url)
      .toBe('/testing/TestReport?name%3Aexact=x');
  });
});

describe('curlCommand', () => {
  test('quotes for a POSIX shell', () => {
    expect(curlCommand('GET', "http://h/x?q=it's", { Accept: 'application/json' }))
      .toBe("curl -H 'Accept: application/json' 'http://h/x?q=it'\\''s'");
  });

  test('POST with a body file', () => {
    expect(curlCommand('POST', 'http://h/TestReport', { 'Content-Type': 'application/fhir+json' }, 'body.json'))
      .toBe("curl -X POST -H 'Content-Type: application/fhir+json' --data-binary @body.json 'http://h/TestReport'");
  });
});

describe('the rendered reference page', () => {
  test('every GET operation has a try-it form asking for JSON; POST has an example only', () => {
    const html = testingOpenApi.renderHtml();
    expect(html.match(/<form class="try-it/g)).toHaveLength(3); // search, read, metadata
    expect(html).toContain('data-path="/testing/TestReport/{id}" data-accept="application/fhir+json"');
    expect(html).toContain('class="try-example" data-method="POST" data-path="/testing/TestReport"');
    expect(html).toContain('Authorization');
  });

  test('the forms are hidden until the Try it button is pressed', () => {
    const html = testingOpenApi.renderHtml();
    const panels = html.match(/<details class="try-it-panel[^"]*"><summary[^>]*>Try it<\/summary><form class="try-it/g);
    expect(panels).toHaveLength(3);
    expect(html).not.toMatch(/<details[^>]* open/);
  });

  test('a required path parameter starts with its example', () => {
    const html = packagesOpenApi.renderHtml();
    expect(html).toMatch(/data-in="path" data-name="id" class="form-control input-sm" value="hl7.fhir.uv.ips"/);
  });

  test('enums become drop-downs', () => {
    expect(testingOpenApi.renderHtml()).toMatch(/<select [^>]*data-name="_summary"[^>]*><option value=""><\/option><option>count<\/option><\/select>/);
  });

  test('long patterns are collapsed, short ones shown, and FHIR types named', () => {
    const html = testingOpenApi.renderHtml();
    // FHIR's dateTime regex is long: on demand only
    expect(html).toMatch(/\(FHIR <code>dateTime<\/code>\) <details class="pattern"><summary>pattern<\/summary><code>/);
    expect(html).not.toMatch(/matching <code>[^<]{41,}<\/code>/);
  });

  test('endpoints are separated by rules, and use the site\'s Bootstrap 3 classes', () => {
    const html = testingOpenApi.renderHtml();
    expect(html.match(/<hr\/><div class="panel panel-default"/g)).toHaveLength(3); // 4 operations
    expect(html).not.toMatch(/card-header|table-sm|form-control-sm|btn-outline|badge bg-/);
  });

  test('the page script is valid JavaScript', () => {
    const html = packagesOpenApi.renderHtml();
    const script = html.substring(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
    expect(() => new Function(script)).not.toThrow();
  });
});

describe('markdown', () => {
  test('renders pipe tables, which CommonMark lacks, with escaped pipes and inline markdown', () => {
    const html = markdown('Before *this*\n\n| Name | Type |\n|---|---|\n| `a\\|b` | **c** |\n| d | |\n\nAfter');
    expect(html).toBe('<p>Before <em>this</em></p>\n' +
      '<table class="table table-condensed"><thead><tr><th>Name</th><th>Type</th></tr></thead><tbody>' +
      '<tr><td><code>a|b</code></td><td><strong>c</strong></td></tr><tr><td>d</td><td></td></tr></tbody></table>' +
      '<p>After</p>\n');
  });

  test('is still safe: raw HTML is dropped, in a table too', () => {
    expect(markdown('<script>x</script>')).not.toMatch(/<script>/);
    expect(markdown('| a |\n|---|\n| <img src=x onerror=y> |')).not.toMatch(/<img/);
  });

  test('a lone pipe line is not a table', () => {
    expect(markdown('| not a table |')).toBe('<p>| not a table |</p>\n');
  });
});
