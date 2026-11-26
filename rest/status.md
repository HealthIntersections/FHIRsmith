# The rest module: what isn't supported yet

A scan of what the module doesn't do, with notes on where each could start. What it does is
in [README.md](README.md), and search, parameter by parameter, in [search.md](search.md).
Much of this the old Pascal server had (`$validate`, `$graph`, GraphQL, subscriptions,
asynchronous requests, `$document`, `$process`), so a good part of it is a port.

## Operations

Supported: `$meta`, `$meta-add`, `$meta-delete`, `Patient/[id]/$everything`,
`Observation/$lastn`, `Observation/$stats`.

### Operations for large resources

[Operations for large resources](https://hl7.org/fhir/operations-for-large-resources.html):
instance operations, POSTed, on Group (`Group.member`) and List (`List.entry`), so that very
large ones can be kept up to date and read without sending the whole resource:

- `$add`: merges the entries of the resource given into the target's, leaving out those
  already there
- `$remove`: takes out of the target the entries that match those given
- `$filter`: returns the target with only the entries that match those given, tagged
  `SUBSETTED`

The input is a resource of the target's type, with its required elements; only the list
matters. `If-Match` is honoured: no change if the version doesn't match. An input entry
matches a target entry when the target has the same values for every element the input has
(more in the target doesn't matter), and asymmetrically: `Patient/123` matches
`Patient/123/_history/2`, but not the other way round.

These fit the module well: an update that changes only part of a long list, done in the store
with the version checks it already has. FHIRPath Patch can do some of it already, but not the
matching.

### Others

From the Pascal server: `$validate` (below), `$document`, `$process` (messages), `$graph`
(below), `$snapshot`, `$generate-narrative`, `$transform`, `$convert`, `$diff`,
`$questionnaire`. Not in Pascal either: `$export` (bulk data: below,
asynchronous).

## Validation

Nothing is validated on write (beyond being JSON or XML of a known type with an id that
fits), and there's no `$validate`. FHIRsmith has no full validator. What it has: the
structure (the XML model, from the StructureDefinitions), invariants (fhirpath.js), bindings
(the tx module), and profiles (loaded packages). The choice is between building a validator
in JavaScript from those - a big job - and calling the Java validator (validator-wrapper, or
the validator run as a service).

## Subscriptions

Every write goes into `SubscriptionQueue`; nothing delivers it. Two models: R4's
criteria-based Subscription, and R5's topic-based (SubscriptionTopic, `$status`, `$events`,
notification bundles). Channels: rest-hook, websocket, email. The Pascal server's
subscriptions are about 2,000 lines.

## Asynchronous requests

`Prefer: respond-async` is supported for searches, history, batches, transactions and
operations (README.md, Async requests), run by the queue runner in the jobs process. Bulk data
(`$export`, `_outputFormat`) isn't yet: it will build on the same queue and job files, with
NDJSON output files.

## GraphQL and GraphDefinition

Neither `$graphql` nor `$graph`. The Pascal server had both (`fhir_graphql.pas`, about 1,300
lines, and `graph_definition.pas`). Both follow references and run searches, which the
search engine and the reference index already do.

## ViewDefinition

The SQL on FHIR runner is in library/sql (and passes the shared tests), so
`ViewDefinition/$run` over the endpoint's resources is close. Views kept as database tables,
up to date as resources are written, is the bigger version.

## Custom resources

Indexing and XML are derived from StructureDefinitions, so new types are plausible, but the
search parameters, the XML model, the CapabilityStatement and routing all expect the core
types. Custom search parameters work already (`customSearchParameters`).

## Also not supported

- **Binary streaming**: a Binary's content is read and written whole (README.md, Binary), up
  to the server's body limit, and kept in the database with the resource; nothing is streamed,
  and Binary.securityContext isn't used to decide who may read it.
- **Security**: SMART on FHIR scopes; security labels and consent in what is returned;
  a Provenance made by the server itself on write (the `X-Provenance` header is supported).
- **Search**: `_query`; `:text-advanced`, and `:text` on references; `:not` other than on
  tokens; relevance ranking for `_text` and `_content` (search.md).
- **Terminology**: the terminology operations are passed on to the endpoint's terminology
  server, and the tx module can publish the endpoint's CodeSystems, ValueSets and ConceptMaps (a
  `rest:` source: README.md, Terminology). A terminology server that doesn't have that source
  doesn't know them: `:in` with a ValueSet stored only in the endpoint fails there, and instance
  level operations ask about resources it hasn't got.
- **Documents and messages**: a document Bundle is stored like any other; no `$document`,
  no `$process-message`.
- **Administration**: pages for managing endpoints (only value sets for searching, and
  loading packages, have pages); backing up, exporting and importing an endpoint; asking for
  a reindex; storage statistics, and vacuuming SQLite.
- **Conformance**: not yet checked against a test suite (Touchstone, or the like), which
  would find what this list doesn't.

## An order

1. Bulk `$export` (asynchronous requests are done)
2. The operations for large resources (`$add`, `$remove`, `$filter`)
3. `$validate`, once the validator is decided
4. Subscription delivery
5. `ViewDefinition/$run`
6. GraphQL and `$graph`
7. Custom resources
