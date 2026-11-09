# VCL - ValueSet Compose Language

The `vcl` module turns an expression in VCL, the ValueSet Compose Language (a compact text
syntax for a value set's compose: includes, excludes, filters, ...), into a FHIR ValueSet.
It only parses: it doesn't expand the value set or check its codes. Use the `tx` module for
that.

This module exists for the FHIR tooling; it isn't
designed for anyone else to run, though nothing stops you.

## Configuration

In `config.json`, under `modules`:

```json
"vcl": {
  "enabled": true
}
```

There are no other settings.

## Endpoint

`GET /VCL?vcl={expression}`

- The expression is the `vcl` query parameter (URL-encoded), up to 10000 characters. It may
  also be given as a URI, `http://fhir.org/VCL/{expression}`.
- The response is the ValueSet, as JSON, with `compose` from the expression and `url`
  `cid:{hash}` - a hash of the content, so the same expression always has the same url.
- An expression that isn't valid VCL is a 400, with `error`, `message` and, where it is known,
  the `position` in the expression where parsing failed.

For example, `GET /VCL?vcl=(http://loinc.org)COMPONENT=LP15842-2` gives a ValueSet that includes
the LOINC codes whose COMPONENT is LP15842-2.

The parser (`vcl-parser.js`) is based on the Java VCL parser in the FHIR core library.
