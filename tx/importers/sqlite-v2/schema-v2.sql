-- sqlite-v2 terminology schema. A file holds one or more code-system blocks (one release of one
-- code system each) and, optionally, value sets (stored as text: codes, never concept ids).
-- SQLite stores facts; the Roaring bitmaps in concept_set answer every membership question.

PRAGMA user_version = 5;

-- One row per code-system block. A terminology file (SNOMED CT, LOINC, ...) has exactly one
-- (id 1, id_base 0); a package file has one per CodeSystem resource. Block k owns the concept ids
-- id_base+1 .. id_base+concept_count.
CREATE TABLE code_system (
  id INTEGER PRIMARY KEY,
  uri TEXT NOT NULL,                 -- http://snomed.info/sct, http://loinc.org, ...
  version TEXT NOT NULL,             -- CodeSystem.version as served
  name TEXT,
  title TEXT,
  description TEXT,
  release_date TEXT,                 -- YYYY-MM-DD
  edition TEXT,                      -- SNOMED module id of the edition, else NULL
  content TEXT NOT NULL DEFAULT 'complete',
  concept_count INTEGER NOT NULL,
  active_count INTEGER NOT NULL,     -- one-block terminology files: ids 1..active_count are the active concepts
  id_base INTEGER NOT NULL DEFAULT 0,
  case_sensitive INTEGER,            -- FHIR CodeSystem.caseSensitive (NULL = not stated)
  hierarchy_meaning TEXT,            -- FHIR CodeSystem.hierarchyMeaning
  resource TEXT                      -- FHIR blocks: the CodeSystem resource JSON without its concepts
);

-- Per-release behaviour the provider reads instead of hard-coding (JSON or plain strings).
CREATE TABLE cs_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

-- concept_id is the dense depth-first id (see numbering rules); it is the bit position in
-- every concept_set bitmap.
CREATE TABLE concept (
  concept_id INTEGER PRIMARY KEY,
  code TEXT NOT NULL,
  active INTEGER NOT NULL,           -- 1 iff concept_id <= code_system.active_count
  display TEXT,
  definition TEXT
);

CREATE TABLE property_def (
  property_id INTEGER PRIMARY KEY,
  code TEXT NOT NULL,
  uri TEXT,
  fhir_type TEXT NOT NULL,           -- code|Coding|string|integer|decimal|boolean|dateTime
  value_kind TEXT NOT NULL CHECK (value_kind IN ('concept', 'literal')),
  is_hierarchy INTEGER NOT NULL DEFAULT 0,   -- 1 = child -> parent edge of the subsumption hierarchy
  display TEXT,
  cs_id INTEGER NOT NULL DEFAULT 1,  -- the block that defines it
  UNIQUE (cs_id, code)
);

-- Concept-valued property facts, including the hierarchy (source = child, target = parent).
-- group_id keeps SNOMED role groups together (0 = ungrouped). Inactive rows are history.
CREATE TABLE concept_link (
  source_id INTEGER NOT NULL,
  property_id INTEGER NOT NULL,
  group_id INTEGER NOT NULL,
  target_id INTEGER NOT NULL,
  active INTEGER NOT NULL,
  PRIMARY KEY (source_id, property_id, group_id, target_id, active)
) WITHOUT ROWID;

-- Literal-valued property facts. `value` has no column affinity: TEXT for code/string/
-- dateTime, INTEGER or REAL for integer/decimal, INTEGER 0/1 for boolean (property_def says
-- which). The same value is the key of the prop=value set.
CREATE TABLE concept_literal (
  concept_id INTEGER NOT NULL,
  property_id INTEGER NOT NULL,
  group_id INTEGER NOT NULL,
  value NOT NULL,
  active INTEGER NOT NULL,
  PRIMARY KEY (concept_id, property_id, group_id, value, active)
) WITHOUT ROWID;

-- Designation use codings, referenced by designation.use_id.
CREATE TABLE designation_use (
  use_id INTEGER PRIMARY KEY,
  system TEXT,
  code TEXT NOT NULL,
  display TEXT,
  UNIQUE (system, code)
);

-- designation_id is assigned in concept_id order, so a concept's designations are adjacent.
CREATE TABLE designation (
  designation_id INTEGER PRIMARY KEY,
  concept_id INTEGER NOT NULL,
  language TEXT,                     -- BCP-47
  use_id INTEGER,                    -- designation_use, NULL = no use coding
  term TEXT NOT NULL,
  active INTEGER NOT NULL,
  preferred INTEGER NOT NULL DEFAULT 0, -- importer's preferred flag for its language (see docs)
  rank INTEGER                       -- SNOMED (v5): the display rank, from the acceptability (see docs); NULL elsewhere
);

-- SNOMED language reference set acceptability of a designation (active members only).
CREATE TABLE designation_acceptability (
  designation_id INTEGER NOT NULL,
  refset_id INTEGER NOT NULL,        -- concept_id of the language refset
  acceptability_id INTEGER NOT NULL, -- concept_id of preferred / acceptable
  PRIMARY KEY (designation_id, refset_id)
) WITHOUT ROWID;

-- Reference set rows that carry fields beyond membership (maps, associations, attribute
-- values, ...). Plain membership is also the 'refset' concept_set; simple refsets have rows here with fields [] (v4).
CREATE TABLE refset_def (
  refset_id INTEGER PRIMARY KEY,     -- concept_id of the refset concept
  field_names TEXT NOT NULL,         -- JSON array of the extra column names
  field_types TEXT NOT NULL          -- JSON array: 'c' concept code, 'i' integer, 's' string
);

CREATE TABLE refset_member (
  refset_id INTEGER NOT NULL,
  concept_id INTEGER NOT NULL,       -- referencedComponentId
  fields TEXT NOT NULL,              -- JSON array of the extra column values (codes stay codes); [] for a simple refset
  effective_time INTEGER,            -- the row's effectiveTime (YYYYMMDD), when the source has it (v4)
  module_id INTEGER,                 -- concept_id of the row's moduleId, when the source has it (v4)
  seq INTEGER,                       -- the row's position in the source (RF2 order) (v4)
  PRIMARY KEY (refset_id, concept_id, fields)
) WITHOUT ROWID;

-- Codes in other code systems that a concept maps to (LOINC part / answer / IEEE mappings).
CREATE TABLE external_map (
  concept_id INTEGER NOT NULL,
  system TEXT NOT NULL,
  version TEXT,
  code TEXT NOT NULL,
  display TEXT,
  equivalence TEXT NOT NULL,         -- ConceptMap (R4) equivalence, from the target side
  PRIMARY KEY (concept_id, system, code)
) WITHOUT ROWID;

-- Alternate identifiers (SNOMED sct2_Identifier: e.g. LOINC codes of LOINC Extension concepts).
CREATE TABLE alternate_identifier (
  concept_id INTEGER NOT NULL,
  scheme_id INTEGER NOT NULL,        -- concept_id of the identifier scheme
  identifier TEXT NOT NULL,
  PRIMARY KEY (concept_id, scheme_id, identifier)
) WITHOUT ROWID;

-- Every stored set, as a run-optimised Roaring bitmap (portable serialisation) of concept_ids.
--   kind 1 all, 2 active, 3 leaf, 4 descendants, 5 prop, 6 hasProp, 7 refset
-- Key (property_id, value): 1-3 (0, 0); 4 (0, the anchor concept_id: its proper descendants);
-- 5 (property_id, the target concept_id or the literal value: concepts with that active fact);
-- 6 (property_id, 0: the union of its prop sets); 7 (0, the refset or answer list concept_id: its
-- active members). A set that is not stored is empty.
CREATE TABLE concept_set (
  kind INTEGER NOT NULL,
  property_id INTEGER NOT NULL,
  value NOT NULL,
  card INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (kind, property_id, value)
) WITHOUT ROWID;

-- Contentless trigram full-text indexes; rowid = concept_id / designation_id.
CREATE VIRTUAL TABLE search_display USING fts5(term, tokenize = 'trigram', content = '');
CREATE VIRTUAL TABLE search_designation USING fts5(term, tokenize = 'trigram', content = '');

-- How this file was built: importer, sources (name, size, sha256), counts, timings.
CREATE TABLE provenance (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

-- FHIR blocks: a concept's own JSON without its child concepts (round trip, and main's
-- per-concept logic). nest_parent = the concept it is nested under in the resource (NULL = top).
CREATE TABLE concept_json (
  concept_id INTEGER PRIMARY KEY,
  nest_parent INTEGER,
  json TEXT NOT NULL
);

-- ---- value sets (empty in the files these importers build) ---------------------------------------
-- Codes are TEXT. Nothing here refers to a concept_id, of this file or any other.

CREATE TABLE value_set (
  vs_id INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,           -- resource id as in the source (unprefixed)
  url TEXT,
  version TEXT,
  date TEXT,
  description TEXT,
  effectivePeriod_start TEXT,
  effectivePeriod_end TEXT,
  expansion_identifier TEXT,
  name TEXT,
  publisher TEXT,
  status TEXT,
  title TEXT,
  content_hash TEXT,
  last_seen INTEGER,
  date_first_seen INTEGER,
  json TEXT NOT NULL                 -- the resource; each stored concept list replaced by
                                     -- {"$rows": n, "$modifierExtension": whether a listed concept has one}
                                     -- (files written before the flag: {"$rows": n})
);

CREATE TABLE vs_identifier (vs_id INTEGER NOT NULL, system TEXT, value TEXT, use_code TEXT, type_system TEXT, type_code TEXT);
CREATE TABLE vs_jurisdiction (vs_id INTEGER NOT NULL, system TEXT, code TEXT, display TEXT);
CREATE TABLE vs_system (vs_id INTEGER NOT NULL, system TEXT, version TEXT);

-- one row per compose.include (exclude = 0) / compose.exclude (exclude = 1) entry
CREATE TABLE vs_include (
  vs_id INTEGER NOT NULL,
  exclude INTEGER NOT NULL,
  idx INTEGER NOT NULL,              -- position in compose.include / compose.exclude
  system TEXT,
  version TEXT,
  concept_count INTEGER NOT NULL,
  first_row INTEGER,                 -- vs_concept rowid of its first code (rows are contiguous)
  PRIMARY KEY (vs_id, exclude, idx)
) WITHOUT ROWID;

-- enumerated codes; rowid order = list order
CREATE TABLE vs_concept (
  row INTEGER PRIMARY KEY,
  vs_id INTEGER NOT NULL,
  part INTEGER NOT NULL,             -- exclude * 1000000 + idx
  code TEXT NOT NULL,
  display TEXT,
  json TEXT                          -- the concept JSON, only when it has more than code and display
);

-- VSAC sync bookkeeping (same tables as tx/vs/vs-database.js)
CREATE TABLE vsac_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, started_at INTEGER NOT NULL, finished_at INTEGER,
  status TEXT NOT NULL DEFAULT 'running', error_message TEXT, total_fetched INTEGER, total_new INTEGER, total_updated INTEGER);
CREATE TABLE vsac_settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE vsac_events (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL, event_type TEXT NOT NULL,
  url TEXT NOT NULL, version TEXT, detail TEXT);

-- @indexes (created after the bulk load)
CREATE INDEX concept_code ON concept(code);
CREATE INDEX value_set_url ON value_set(url, version);
CREATE INDEX value_set_status ON value_set(status);
CREATE INDEX value_set_name ON value_set(name);
CREATE INDEX value_set_title ON value_set(title);
CREATE INDEX value_set_publisher ON value_set(publisher);
CREATE INDEX vs_identifier_vs ON vs_identifier(vs_id);
CREATE INDEX vs_jurisdiction_vs ON vs_jurisdiction(vs_id);
CREATE INDEX vs_system_vs ON vs_system(vs_id);
CREATE INDEX vs_system_system ON vs_system(system, version);
CREATE INDEX vs_concept_code ON vs_concept(vs_id, part, code);
CREATE INDEX designation_concept ON designation(concept_id);

-- SNOMED CT: the normal form of each active, fully defined concept whose normal form is not just its
-- own id, rendered in the minimal compositional grammar (native post-coordination reads it). (v4)
CREATE TABLE concept_normal_form (
  concept_id INTEGER PRIMARY KEY,
  nf TEXT NOT NULL
);
CREATE INDEX concept_normal_form_nf ON concept_normal_form(nf);
