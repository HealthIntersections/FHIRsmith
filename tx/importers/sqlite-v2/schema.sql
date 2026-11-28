-- Terminology file (meta format 'tx-terminology/1'): one code system version per file, in a
-- terminology-neutral model (tx/sqlite-v2/README.md). Nodes are concepts (ids 1..N, active first)
-- and items below them (terms, descriptions, atoms, definitions; ids above N), in one id space.
-- Statements have four shapes: link (subject -> node), literal (subject -> value), identifier
-- (value -> subject) and record (an n-ary row about a subject). The catalog (`property`) says for
-- every property, relation and scheme where its rows are and what may search it. Fact tables first,
-- then the index tables (ix_*), which are rebuildable from the facts (indexes.js).
--
-- Sections: `-- @facts` (created before the load), `-- @fact-indexes` (secondary indexes on the
-- fact tables, created after the bulk load), `-- @ix` (index tables: indexes.js drops and
-- recreates them from the fact tables).
--
-- Statistics: a file carries sqlite_stat1 and no sqlite_stat4 (the builder runs ANALYZE, then drops
-- sqlite_stat4). With stat4 SQLite re-plans a `col = ?` statement on every bind. Readers never ANALYZE.

-- @facts
CREATE TABLE code_system (
  cs_id INTEGER PRIMARY KEY, uri TEXT NOT NULL, version TEXT NOT NULL,
  name TEXT, title TEXT, description TEXT, release_date TEXT,
  content TEXT NOT NULL, case_sensitive INTEGER, hierarchy_meaning TEXT, default_language TEXT,
  compositional INTEGER,              -- FHIR CodeSystem.compositional: codes may be expressions, so no
                                      -- expansion of the system is closed (SNOMED CT)
  served INTEGER NOT NULL,            -- 1 for the file's system; 0 for sources that only contribute items
  concept_count INTEGER NOT NULL, active_count INTEGER NOT NULL,
  resource TEXT                       -- FHIR CodeSystem JSON without concepts, when there is one
);
-- release facts with no column (displayContexts, moduleDependencies, languages, edition, titles), the format
-- and provenance, facts about indexes (ix.*), and behaviour settings: behaviour.<key> = a JSON value,
-- how the system is presented (grammar, lookupName, description, versionAlgorithm, expansionOrder,
-- designationUses, distinctDesignationTexts, lookupSkipsMixedLinks, aliasProperty, aliasExtension,
-- preferredForLanguage, aliasLiterals, filters;
-- values and defaults in tx/sqlite-v2/README.md). A reader refuses a file with a key or value it
-- does not know.
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;

CREATE TABLE concept (
  id INTEGER PRIMARY KEY, cs_id INTEGER NOT NULL, code TEXT NOT NULL, active INTEGER NOT NULL,
  display TEXT                        -- derived: the default display
);

CREATE TABLE item (
  id INTEGER PRIMARY KEY,             -- > every concept id
  concept_id INTEGER NOT NULL,
  kind INTEGER NOT NULL,              -- 0 term, 1 definition (a designation too only when it has a use_id)
  external_id,                        -- its id in the source (description SCTID, RXAUI); NULL if none; INTEGER
                                      -- when the source id is a canonical decimal integer, else TEXT
  cs_id INTEGER NOT NULL,             -- the asserting system (a served = 0 row for foreign atoms)
  language TEXT, use_id INTEGER, text TEXT NOT NULL,
  active INTEGER NOT NULL,            -- an inactive item is still a designation of its concept (RxNorm: an archived
                                      -- concept's RXNATOMARCHIVE atoms, active = 0)
  preferred INTEGER NOT NULL DEFAULT 0,   -- the source's own preferred flag for its language, if it has one
  rank INTEGER                        -- derived: display order within the concept under meta.displayContexts
);
CREATE TABLE item_use (use_id INTEGER PRIMARY KEY, system TEXT, code TEXT NOT NULL, display TEXT);

CREATE TABLE property (               -- the catalog: properties, refsets, relations
  id INTEGER PRIMARY KEY, cs_id INTEGER NOT NULL, code TEXT NOT NULL, uri TEXT, display TEXT,
  concept_id INTEGER,                 -- the concept that defines it, when it is one (SNOMED attribute, refset)
  shape TEXT NOT NULL,                -- 'link' | 'literal' | 'both' | 'identifier' | 'record' | 'union'
                                      -- ('union': only property_member rows, computed at build)
  role TEXT,                          -- NULL or 'language': a record relation on items that ranks displays
  fhir_type TEXT,                     -- literal type
  subject_kind TEXT,                  -- 'concept' | 'item' | 'both'   (computed at build; NULL when n_rows = 0)
  target_kind TEXT,                   -- 'concept' | 'item' | 'both'   (computed; link / record target)
  n_rows INTEGER NOT NULL,            -- computed; 0 is legal (a name that exists but selects nothing)
  subsumption INTEGER NOT NULL DEFAULT 0,   -- child -> parent edge of the hierarchy
  closure_from INTEGER,               -- property whose explicit pairs are the closure (LOINC, OMOP); NULL = derive
  filterable INTEGER NOT NULL DEFAULT 1,    -- a FHIR filter may name it
  refinable INTEGER NOT NULL DEFAULT 0,     -- an ECL attribute refinement may name it
  wildcard INTEGER NOT NULL DEFAULT 0,      -- included in `* : * = x`
  inverse_of INTEGER,                 -- a virtual property: the reverse of another (which may be a union)
  by_target INTEGER NOT NULL DEFAULT 0,     -- its links are read by target (ix_in); set per property by the importer
  by_subject INTEGER NOT NULL DEFAULT 0,    -- shape 'identifier': its rows are read by subject (ix_by_subject); the
                                            -- builder's default for an identifier row is 1, an importer sets 0 for
                                            -- rows only ever read by value (RxNorm atom relationships AUI:*)
  ordered INTEGER NOT NULL DEFAULT 0,       -- link.seq orders a subject's targets, and the order is part of the answer
  filter_ops TEXT,                    -- JSON list of the FHIR filter operators a filter on it accepts (NULL: the
                                      -- server's rule for the system)
  report TEXT,                        -- when $lookup reports it: 'named' (only when asked for by name), 'always'
                                      -- (also listed on expansions); NULL: the server's rule
  fields TEXT,                        -- record shape: JSON [{name, type[, target: true]}] in source
                                      -- column order; type c component (node id, or the source's code when it is
                                      -- not a node here), n node, i int, s string, t time (YYYYMMDD int); `target`
                                      -- marks the column held in record.target_id (the others are record.fields,
                                      -- in order)
  UNIQUE (cs_id, code)
);
CREATE TABLE property_member (parent_id INTEGER NOT NULL, child_id INTEGER NOT NULL,
  PRIMARY KEY (parent_id, child_id)) WITHOUT ROWID;   -- a property that is the union of others

CREATE TABLE link (
  subject_id INTEGER NOT NULL, property_id INTEGER NOT NULL, group_id INTEGER NOT NULL,
  target_id INTEGER NOT NULL, active INTEGER NOT NULL,
  seq INTEGER,                        -- source order
  PRIMARY KEY (subject_id, property_id, group_id, target_id, active)
) WITHOUT ROWID;

CREATE TABLE literal (
  subject_id INTEGER NOT NULL, property_id INTEGER NOT NULL, group_id INTEGER NOT NULL,
  value NOT NULL, active INTEGER NOT NULL,
  PRIMARY KEY (subject_id, property_id, group_id, value, active)
) WITHOUT ROWID;

CREATE TABLE identifier (
  property_id INTEGER NOT NULL,
  value NOT NULL,                     -- INTEGER when a canonical decimal integer, else TEXT; read as text
  subject_id INTEGER NOT NULL,
  resolves INTEGER NOT NULL DEFAULT 0,      -- 0 not a code; 1 an alias: accepted as a code and answered with
                                            -- the subject's own code (ICD-11 short codes); 2 a code in its own
                                            -- right: accepted and answered as written (NDC 11-digit forms).
                                            -- A concept code always wins over an identifier with the same value.
  PRIMARY KEY (property_id, value, subject_id)
) WITHOUT ROWID;

CREATE TABLE record (
  relation_id INTEGER NOT NULL,       -- property.id, shape 'record'
  subject_id INTEGER NOT NULL,        -- concept or item
  seq INTEGER NOT NULL,               -- 0.. the row's order within the relation (whole-relation source order)
  target_id INTEGER,                  -- the field the schema marks `target: true`, when its value is a node here
  active INTEGER NOT NULL,
  fields TEXT,                        -- JSON array of the other fields, per property.fields. In a field typed
                                      -- c or n, a JSON number is a node id of this file and a JSON string a
                                      -- code that is not in the file
  PRIMARY KEY (relation_id, subject_id, seq)
) WITHOUT ROWID;

-- displays of literal values (LOINC CLASSTYPE 1 = 'Laboratory class')
CREATE TABLE value_label (property_id INTEGER NOT NULL, value NOT NULL, display TEXT NOT NULL,
  PRIMARY KEY (property_id, value)) WITHOUT ROWID;

CREATE TABLE mapping (
  concept_id INTEGER NOT NULL, property_id INTEGER, system TEXT NOT NULL, version TEXT, code TEXT NOT NULL,
  display TEXT,
  relationship TEXT NOT NULL,         -- FHIR R4 ConceptMap equivalence codes (equivalent, wider, narrower,
                                      -- relatedto, ...), as main's providers report them
  PRIMARY KEY (concept_id, system, code)
) WITHOUT ROWID;

-- optional, usually empty
CREATE TABLE resource (type TEXT NOT NULL, id TEXT NOT NULL, url TEXT, version TEXT, json TEXT NOT NULL,
  PRIMARY KEY (type, id)) WITHOUT ROWID;       -- resources the release defines that cannot be derived from its
                                               -- facts (value sets that follow from stored records are not stored)
CREATE TABLE node_extra (id INTEGER PRIMARY KEY, json TEXT NOT NULL);   -- FHIR extensions etc. for round-trip

-- @fact-indexes
CREATE UNIQUE INDEX concept_code ON concept(cs_id, code);
CREATE INDEX item_concept ON item(concept_id);
CREATE INDEX item_external ON item(external_id) WHERE external_id IS NOT NULL;
-- the definition a concept shows: its kind 1 item with preferred = 1 (a partial index, so a concept
-- with none costs one probe of an index that is empty for LOINC and RxNorm)
CREATE INDEX item_definition ON item(concept_id) WHERE kind = 1 AND preferred = 1;
-- identifiers accepted as codes, by value: a probe must say `resolves > 0` (as well as value = ?) for
-- SQLite to use this partial index; without it the probe scans every identifier row
CREATE INDEX identifier_code ON identifier(value) WHERE resolves > 0;
CREATE INDEX resource_url ON resource(type, url, version);

-- @ix
-- Rows that need terminology logic to build are written by the importer and listed in
-- meta 'derived-by-importer' (JSON [{table, name}]: ix_key / ix_order rows of that name, with
-- their meta keys 'ix.<table>.<name>.*'); indexes.js keeps them and rebuilds everything else.
-- Facts about an index are meta keys 'ix.<table>.<name>'; the index builder owns them.
-- Roaring bitmaps (portable serialisation) of concept ids. kind: 1 all, 2 active, 3 leaf,
-- 4 descendants (value = the anchor concept), 5 property = value, 6 has property (for an inverse_of row: the
-- targets of the property it reverses), 7 record members
-- (property_id = the relation). value_kind: 0 none, 1 node (value = node id), 2 literal. Kind 5 sets exist
-- only for properties a filter can name: filterable = 1, and the members of a filterable union; any
-- other property is answered from link / literal.
CREATE TABLE ix_set   (kind INTEGER, property_id INTEGER, value_kind INTEGER, value, card INTEGER, data BLOB,
                       PRIMARY KEY (kind, property_id, value, value_kind)) WITHOUT ROWID;
-- links by target, for the catalog rows with by_target = 1 only.
-- seq: link.seq, or 0 where the link has none. active and group_id are in the key so a reader
-- can take active group-0 rows (SNOMED children in release order) without visiting link.
CREATE TABLE ix_in    (target_id INTEGER NOT NULL, property_id INTEGER NOT NULL, active INTEGER NOT NULL,
                       group_id INTEGER NOT NULL, seq INTEGER NOT NULL, subject_id INTEGER NOT NULL,
                       PRIMARY KEY (target_id, property_id, active, group_id, seq, subject_id)) WITHOUT ROWID;
-- identifier rows by subject, for the catalog rows with by_subject = 1 only (SNOMED CT alternate
-- identifiers, aliases); the value-keyed primary key of identifier serves every other read.
CREATE TABLE ix_by_subject (subject_id INTEGER NOT NULL, property_id INTEGER NOT NULL, value NOT NULL,
                       PRIMARY KEY (subject_id, property_id, value)) WITHOUT ROWID;
-- per-id arrays (little-endian Uint32), 1,024 entries per block. Standard names: rank (concept id -> place
-- in the system order), ids (place -> concept id), walk (the whole system in the built-in walk order),
-- active (walk restricted to the active concepts; stored only where they are not a prefix of walk),
-- hier_start / hier (LOINC: a concept's parent and child entries in the built-in order)
CREATE TABLE ix_order (name TEXT, block INTEGER, data BLOB, PRIMARY KEY (name, block)) WITHOUT ROWID;
CREATE TABLE ix_key   (name TEXT, key TEXT, id INTEGER, PRIMARY KEY (name, key, id)) WITHOUT ROWID;
CREATE INDEX ix_key_id ON ix_key(name, id);   -- the key of a node (SNOMED: a concept's normal form)
-- word index (tx/sqlite-v2/text-index.js rules; format in meta 'ix.ix_word.format'): per language
-- (primary subtag) every word with its stem and the concepts that have it (Roaring); the row with
-- word '' and stem '' holds the per-concept distinct-word counts (Uint16 by concept id), where the
-- rules keep them.
CREATE TABLE ix_word  (lang TEXT NOT NULL, word TEXT NOT NULL, stem TEXT NOT NULL, ids BLOB NOT NULL,
                       PRIMARY KEY (lang, word)) WITHOUT ROWID;
CREATE INDEX ix_word_stem ON ix_word(lang, stem);
CREATE VIRTUAL TABLE ix_text_display USING fts5(text, tokenize = 'trigram', content = '');
CREATE VIRTUAL TABLE ix_text_item    USING fts5(text, tokenize = 'trigram', content = '');
