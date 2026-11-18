// What utilities/generate-openapi-schemas.js generates for the terminology server's OpenAPI
// description (into openapi-schemas.json, which the loader merges into the components of the
// description - see openapi.js). Regenerate after changing this:
//
//   node utilities/generate-openapi-schemas.js tx
//
// tests/tx/openapi.test.js fails if the generated file is out of date, and validates real
// responses against these schemas.
//
// The schemas are R5, and they are documentation: they describe what this server handles,
// and what it returns. The server doesn't reject content outside them (an extension with a
// Quantity value, say) - but it isn't designed to do anything with it either.

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });

// The resources the server works with: they're what a Bundle, or a Parameters, can hold
const TX_RESOURCES = ['CodeSystem', 'ValueSet', 'ConceptMap', 'OperationOutcome'];

// The types of an extension's value, and of a parameter's value: the primitive types
// (except base64Binary, and xhtml, which isn't a choice anyway), Coding and CodeableConcept
const VALUE_TYPES = [
  'boolean', 'canonical', 'code', 'date', 'dateTime', 'decimal', 'id', 'instant', 'integer',
  'integer64', 'markdown', 'oid', 'positiveInt', 'string', 'time', 'unsignedInt', 'uri', 'url',
  'uuid', 'Coding', 'CodeableConcept'
];

const TX_ISSUE_TYPE = 'http://hl7.org/fhir/tools/CodeSystem/tx-issue-type';

function searchBundle(type) {
  return {
    description: `A searchset Bundle of ${type}s`,
    allOf: [
      ref('Bundle'),
      {
        type: 'object',
        properties: {
          type: { const: 'searchset' },
          entry: { type: 'array', items: { type: 'object', properties: { resource: ref(type) } } }
        }
      }
    ]
  };
}

module.exports = {
  package: 'hl7.fhir.r5.core#5.0.0',
  roots: [...TX_RESOURCES, 'Parameters', 'Bundle', 'CapabilityStatement', 'TerminologyCapabilities'],

  // Contained resources: only value sets, in a value set (and they can't contain anything
  // themselves - see the ValueSet overlay)
  prohibit: [
    'CodeSystem.contained', 'ConceptMap.contained', 'OperationOutcome.contained',
    'CapabilityStatement.contained', 'TerminologyCapabilities.contained'
  ],
  resources: {
    'ValueSet.contained': ['ValueSet'],
    // Bundles never hold Bundles. A Parameters holds a Parameters only as a `validation`
    // in $batch-validate-code, and as a `profile`
    'Bundle.entry.resource': TX_RESOURCES,
    'Bundle.entry.response.outcome': ['OperationOutcome'],
    'Bundle.issues': ['OperationOutcome'],
    'Parameters.parameter.resource': [...TX_RESOURCES, 'Parameters']
  },
  generateExtension: true,
  choiceTypes: {
    'Extension.value[x]': VALUE_TYPES,
    'Parameters.parameter.value[x]': VALUE_TYPES
  },

  overlay: {
    ValueSet: {
      properties: {
        contained: {
          description: 'Contained value sets, which the value set includes or excludes by reference (#id). ' +
            'Only value sets can be contained, and they can\'t contain resources themselves'
        }
      }
    },

    Parameters: {
      description: 'Operation parameters, in or out. Each operation lists the parameters it uses. ' +
        'A parameter\'s value is a primitive, a Coding or a CodeableConcept; its resource is a CodeSystem, ' +
        'ValueSet, ConceptMap or OperationOutcome, or a Parameters - which only a `validation` in ' +
        '$batch-validate-code (and its result), and a `profile` (an expansion profile), hold.'
    },

    // Every issue says what it's about in details.text, and - unless it's just information,
    // like a server banner - classifies it with a tx-issue-type code in details.coding.
    // diagnostics is server-specific detail that clients shouldn't depend on.
    OperationOutcome_Issue: {
      required: ['details'],
      properties: {
        details: {
          $replace: true,
          description: 'What the issue is: details.text, and (except for information) a tx-issue-type coding (' + TX_ISSUE_TYPE + ')',
          allOf: [ref('CodeableConcept'), { required: ['text'] }]
        }
      },
      if: { properties: { severity: { const: 'information' } } },
      else: {
        properties: {
          details: {
            required: ['coding'],
            properties: {
              coding: {
                contains: { type: 'object', properties: { system: { const: TX_ISSUE_TYPE } }, required: ['system', 'code'] }
              }
            }
          }
        }
      }
    },

    CodeSystemSearchBundle: searchBundle('CodeSystem'),
    ValueSetSearchBundle: searchBundle('ValueSet'),
    ConceptMapSearchBundle: searchBundle('ConceptMap')
  }
};
