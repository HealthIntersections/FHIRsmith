// What utilities/generate-openapi-schemas.js generates for the testing module's OpenAPI
// description (into openapi-schemas.json, which the loader merges into openapi.yaml's
// components). Regenerate after changing this:
//
//   node utilities/generate-openapi-schemas.js testing
//
// tests/testing/openapi.test.js fails if the generated file is out of date, and checks that
// the overlay requires everything validateReport() in testing.js requires.

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });

module.exports = {
  package: 'hl7.fhir.r5.core#5.0.0',
  roots: ['TestReport', 'OperationOutcome', 'Bundle'],

  // reports may not contain resources (validateReport rejects them too)
  prohibit: ['contained'],

  overlay: {
    TestReport: {
      description: 'A TestReport, as this server accepts it: an R5 TestReport (or an R4 one - see testScript), ' +
        'with name, tester, issued and at least one participant, and no contained resources.',
      required: ['name', 'tester', 'issued', 'participant'],
      properties: {
        participant: { minItems: 1 },
        testScript: {
          $replace: true,
          description: 'The TestScript that was run: a canonical (R5), or a Reference (R4)',
          anyOf: [{ type: 'string' }, ref('Reference')]
        }
      }
    },

    // the search response: a Bundle of TestReports, plus an OperationOutcome entry
    // (search.mode = outcome) when unknown parameters were ignored
    TestReportSearchBundle: {
      description: 'A searchset Bundle of TestReports',
      allOf: [
        ref('Bundle'),
        {
          type: 'object',
          properties: {
            type: { const: 'searchset' },
            entry: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  resource: { anyOf: [ref('TestReport'), ref('OperationOutcome')] }
                }
              }
            }
          }
        }
      ]
    }
  }
};
