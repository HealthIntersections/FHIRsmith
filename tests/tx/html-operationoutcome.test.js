/**
 * How an OperationOutcome reads in a browser.
 *
 * Every issue this server emits carries the human account of the problem in details.text
 * and server-specific detail in diagnostics - and for the operations that can give up
 * part way, diagnostics is the operation's timing trace. The HTML rendering used to show
 * diagnostics in preference to details.text, so a perfectly good error
 *
 *   "The value set '...' expansion has too many codes to produce (>1000)"
 *
 * reached the user as
 *
 *   "error: [too-costly] 0ms tx-op 1ms start working 1ms compose #1 2ms compose #2"
 *
 * which says nothing about what went wrong. The text leads; the trace is kept, because it
 * is genuinely useful when a server is slow, but it is folded away.
 *
 * These are unit tests on the renderer - no module, no endpoint - because this is string
 * building, and the outcomes that matter here are ones that are awkward to provoke.
 */

const { TxHtmlRenderer } = require('../../tx/tx-html');

const TOO_COSTLY = {
  resourceType: 'OperationOutcome',
  issue: [{
    extension: [{
      url: 'http://hl7.org/fhir/StructureDefinition/operationoutcome-message-id',
      valueString: 'VALUESET_TOO_COSTLY'
    }],
    severity: 'error',
    code: 'too-costly',
    details: {
      coding: [{ system: 'http://hl7.org/fhir/tools/CodeSystem/tx-issue-type', code: 'too-costly' }],
      text: "The value set 'urn:uuid:6d1f' expansion has too many codes to produce (>1000)"
    },
    diagnostics: '0ms tx-op 1ms start working 2ms prepare filters 3ms iterate filters'
  }]
};

function render(outcome) {
  return new TxHtmlRenderer(null, null, null, null, '/tx/r5').renderOperationOutcome(outcome);
}

describe('OperationOutcome rendering', () => {
  test('leads with details.text, not the timing trace', async () => {
    const html = await render(TOO_COSTLY);
    const message = html.indexOf('expansion has too many codes');
    const trace = html.indexOf('prepare filters');
    expect(message).toBeGreaterThan(-1);
    expect(trace).toBeGreaterThan(message);
  });

  test('keeps the diagnostics, folded away', async () => {
    const html = await render(TOO_COSTLY);
    expect(html).toContain('<summary>Server diagnostics</summary>');
    expect(html).toContain('0ms tx-op 1ms start working');
  });

  test('names the issue code and the message id', async () => {
    const html = await render(TOO_COSTLY);
    expect(html).toContain('<code>too-costly</code>');
    expect(html).toContain('<code>VALUESET_TOO_COSTLY</code>');
    // the issue-type and the tx-issue-type are the same word here - say it once
    expect(html.match(/<code>too-costly<\/code>/g)).toHaveLength(1);
  });

  test('says so when an issue carries no message at all', async () => {
    const html = await render({
      resourceType: 'OperationOutcome',
      issue: [{ severity: 'error', code: 'exception' }]
    });
    expect(html).toContain('this issue carries no message');
  });

  test('falls back to diagnostics when that is all there is', async () => {
    const html = await render({
      resourceType: 'OperationOutcome',
      issue: [{ severity: 'error', code: 'exception', diagnostics: 'something went wrong' }]
    });
    expect(html).toContain('something went wrong');
    // and does not then repeat it as the server detail
    expect(html).not.toContain('<summary>Server diagnostics</summary>');
  });

  test('shows where an issue points, and escapes what it shows', async () => {
    const html = await render({
      resourceType: 'OperationOutcome',
      issue: [{
        severity: 'warning',
        code: 'invalid',
        details: { text: 'bad <value>' },
        expression: ['ValueSet.compose.include[0]']
      }]
    });
    expect(html).toContain('alert-warning');
    expect(html).toContain('<strong>Warning</strong>');
    expect(html).toContain('bad &lt;value&gt;');
    expect(html).toContain('<code>ValueSet.compose.include[0]</code>');
  });

  test('offers the raw outcome', async () => {
    const html = await render(TOO_COSTLY);
    expect(html).toContain('Show JSON Source');
  });
});
