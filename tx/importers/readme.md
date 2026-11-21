# TX-Import: Medical Terminology Import Tool

A comprehensive CLI tool for importing various medical terminology standards into SQLite databases and other formats
for use by FHIRsmith. The tool supports LOINC, SNOMED CT, UNII, NDC, and provides extensible architecture for
additional terminologies.

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Available Terminologies](#available-terminologies)
- [Common Commands](#common-commands)
- [Configuration Management](#configuration-management)
- [Terminology-Specific Usage](#terminology-specific-usage)
- [Advanced Features](#advanced-features)
- [Troubleshooting](#troubleshooting)

## Installation

1. **Prerequisites:**
   ```bash
   # Node.js 16+ required
   npm install 
   chmod +x tx-import.js
   ln -s $(pwd)/tx-import.js /usr/local/bin/tx-import
   ./tx-import.js list
   ```

2. **Get help for a specific terminology:**
   ```bash
   ./tx-import.js loinc --help
   ```

3. **Import LOINC data (interactive):**
   ```bash
   ./tx-import.js loinc import
   ```

4. **Import with parameters (non-interactive):**
   ```bash
   ./tx-import.js loinc import \
     --source /path/to/loinc/files \
     --dest ./data/loinc.db \
     --version "LOINC-2.78" \
     --yes
   ```

5. **Bring an existing database's text index up to date** (what text filters search, by the rules
   in [Text filters](../README.md#text-filters); needed since FHIRsmith 1.0.3), without importing
   again. Run it while no server has the file open:
   ```bash
   ./tx-import.js loinc upgrade-text-index --dest ./data/loinc.db
   ./tx-import.js rxnorm upgrade-text-index --dest ./data/rxnorm.db
   node tx/importers/import-icd11.js --text-index-only --dest ./data/icd11.db
   ```

## Available Terminologies

| Terminology | Command | Description | Duration |
|------------|---------|-------------|----------|
| **LOINC** | `loinc` | Logical Observation Identifiers Names and Codes | 45-120 min |
| **LOINC Subset** | `loinc-subset` | Create LOINC subsets for testing | 5-15 min |
| **SNOMED CT** | `snomed` | SNOMED Clinical Terms | 2-6 hours |
| **RxNorm** | `rxnorm` | Prescribable drug nomenclature (NLM) | 15-45 min |
| **RxNorm Subset** | `rxnorm-subset` | Create RxNorm subsets for testing | 10-30 min |
| **UNII** | `unii` | Unique Ingredient Identifier (FDA) | 15-45 min |
| **NDC** | `ndc` | National Drug Code Directory | 30-90 min |

## Common Commands

To import:

```bash
tx-import loinc import
tx-import snomed import
tx-import rxnorm import
tx-import unii import
tx-import ndc import
tx-import loinc-subset subset
tx-import rxnorm-subset subset
```

See additional commands below. 

## Basic Functionality

* LOINC: Import from a full Download (all files, including accessories)
* SNOMED: Import from a full snapshot download
* RxNorm: Import from RxNorm Full Monthly Release (RRF files)
* UNII: Import from a set of past downloads (see discussion below about UNII)
* NDC: import from NDC downloads

In addition, there's functionality to create test subsets for LOINC and RxNorm.
For SNOMED CT, use the SCT subset functionality (documented in the tx-ecosystem IG).


## Full Command Documentation

### Global Commands

```bash
# List all available terminology importers
tx-import list

# Show configuration management options
tx-import config

# Display help for any command
tx-import help [command]
```

### Import Commands Pattern
Each terminology follows the same command pattern:

```bash
# Basic import (interactive)
tx-import <terminology> import

# Import with options
tx-import <terminology> import [options]

# Validate source files
tx-import <terminology> validate --source /path/to/files

# Check database status  
tx-import <terminology> status --dest /path/to/database
```

### Common Import Options

| Option | Description | Example |
|--------|-------------|---------|
| `-s, --source <path>` | Source file/directory | `--source ./loinc_files/` |
| `-d, --dest <path>` | Destination database | `--dest ./data/loinc.db` |
| `-v, --version <ver>` | Version identifier | `--version "2.78"` |
| `-y, --yes` | Skip confirmations | `--yes` |
| `--verbose` | Enable detailed logging | `--verbose` |
| `--no-indexes` | Skip index creation | `--no-indexes` |

## Configuration Management

The tool remembers your previous inputs and suggests them as defaults:

### View Configuration History
```bash
# Show all saved configurations
tx-import config:show

# Show config for specific terminology
tx-import config:show --terminology loinc
```

### Clear Configuration
```bash
# Clear config for specific terminology
tx-import config:clear --terminology loinc

# Clear all configurations
tx-import config:clear --all
```

### Import/Export Configuration
```bash
# Export configuration to file
tx-import config:export --output my-config.json

# Import configuration from file
tx-import config:import --input my-config.json
```

## Terminology-Specific Usage

### LOINC Import

**Full LOINC Database Import:**
```bash
# Interactive mode
tx-import loinc import

# Batch mode
tx-import loinc import \
  --source /path/to/loinc_distribution \
  --dest ./data/loinc.db \
  --version "LOINC-2.78" \
  --yes
```

**Options:**
- `--main-only`: Import only main codes (skip language variants)
- `--no-indexes`: Skip index creation for faster import

**Required Source Structure:**
```
loinc_distribution/
├── LoincTable/
│   └── Loinc.csv
├── AccessoryFiles/
│   ├── PartFile/
│   │   ├── Part.csv
│   │   └── LoincPartLink_Primary.csv
│   ├── ConsumerName/
│   │   └── ConsumerName.csv
│   └── LinguisticVariants/
│       └── [language files]
```

### LOINC Subset Creation

**Create Test Subset:**
```bash
# Interactive mode
tx-import loinc-subset subset

# With parameters
tx-import loinc-subset subset \
  --source /path/to/full/loinc \
  --dest ./loinc-subset \
  --codes ./my-codes.txt \
  --yes
```

**Codes File Format** (`my-codes.txt`):
```
# One LOINC code per line
# Comments start with #
33747-0
1975-2
6690-2
```

**Options:**
- `--codes <file>`: Text file with LOINC codes (one per line)
- `--expand-part-links`: Expand codes based on PartLink relationships

### SNOMED CT Import

**Import SNOMED CT:**
```bash
# Interactive mode - auto-detects edition and version from RF2 files
tx-import snomed import

# Fully automatic (auto-detects edition/version, no prompts)
tx-import snomed import \
  --source /path/to/rf2/files \
  --dest ./data/snomed.cache \
  --license /path/to/license.txt \
  --yes

# Manual edition/version specification
tx-import snomed import \
  --source /path/to/rf2/files \
  --dest ./data/snomed.cache \
  --edition "900000000000207008" \
  --version "20250801" \
  --license /path/to/license.txt \
  --yes

# With custom URI (overrides edition/version)
tx-import snomed import \
  --source /path/to/rf2/files \
  --dest ./data/snomed.cache \
  --uri "http://snomed.info/sct/900000000000207008/version/20250301" \
  --license /path/to/license.txt \
  --yes
```

**License:** `--license` is required: a text file with the license the edition is distributed
under (for the tx-ecosystem test subset, its `license.txt`). The importer puts it in the cache
file, so that it goes wherever the cache goes; the server doesn't read it. The interactive mode
asks for it if it isn't given.

**Cache format:** the importer writes cache format 21, which is the only format the server reads:
an edition imported by an earlier version has to be imported again. Format 21 carries the license
and the text indexes that `$expand` filters and ECL term filters search, built at import, so the
server builds nothing when the cache loads or is searched.

**Auto-Detection:**
The importer automatically detects the edition and version from RF2 files by:
1. Parsing filenames like `sct2_Concept_Snapshot_INT_20250201.txt`
2. Reading the `moduleId` and `effectiveTime` from the first concept record

In interactive mode, you'll be asked to confirm the detected values. With `--yes`, the detected values are used automatically.

**Supported Editions:**
- International (900000000000207008)
- US Edition (731000124108)
- UK Edition (83821000000107)
- Australian Edition (32506021000036107)
- [And many more...]

**Required RF2 Structure:**
```
rf2_files/
├── Terminology/
│   ├── sct2_Concept_*.txt
│   ├── sct2_Description_*.txt
│   └── sct2_Relationship_*.txt
└── Refset/
    └── [various refset files]
```

### RxNorm Import

**Import RxNorm Data:**
```bash
# Interactive mode
tx-import rxnorm import

# Batch mode
tx-import rxnorm import \
  --source /path/to/RxNorm_full_MMDDYYYY/rrf \
  --dest ./data/rxnorm.db \
  --version "RXNORM-2025-02-03" \
  --yes

# Skip the text index for faster import (text filters won't work)
tx-import rxnorm import \
  --source /path/to/rrf/files \
  --dest ./data/rxnorm.db \
  --no-stems \
  --yes
```

**Options:**
- `--no-indexes`: Skip index creation for faster import
- `--no-stems`: Skip the text index (`RXNTEXT`, what text filters search; it replaces `RXNSTEMS`)

**Required RRF Structure:**
```
rrf_files/
├── RXNCONSO.RRF    (required - concepts/names)
├── RXNREL.RRF      (required - relationships)
├── RXNSTY.RRF      (required - semantic types)
├── RXNSAB.RRF      (optional - source info)
├── RXNATOMARCHIVE.RRF (optional - archived atoms)
└── RXNCUI.RRF      (optional - concept history)
```

**Source File Format:**
RxNorm uses Rich Release Format (RRF), which is pipe-delimited with fields ending in `|`.
Download the "RxNorm Full Monthly Release" from the [NLM RxNorm page](https://www.nlm.nih.gov/research/umls/rxnorm/docs/rxnormfiles.html).

**Version Auto-Detection:**
The importer can auto-detect the version from directory names like `RxNorm_full_08042025`.

### RxNorm Subset Creation

**Create Test Subset:**
```bash
# Interactive mode
tx-import rxnorm-subset subset

# With parameters
tx-import rxnorm-subset subset \
  --source /path/to/rxnorm/rrf \
  --dest ./rxnorm-subset \
  --codes ./my-codes.txt \
  --yes

# Without relationship expansion (faster, smaller subset)
tx-import rxnorm-subset subset \
  --source /path/to/rxnorm/rrf \
  --dest ./rxnorm-subset \
  --codes ./my-codes.txt \
  --no-expand \
  --yes
```

**Codes File Format** (`my-codes.txt`):
```
# One RxNorm CUI per line
# Comments start with #
161    # acetaminophen
1191   # aspirin
5640   # ibuprofen
```

**Options:**
- `--no-expand`: Skip relationship expansion (just include listed codes)
- `--include-synonyms`: Include synonym (SY) term types
- `--include-archived`: Include archived concepts from RXNATOMARCHIVE
- `--max-iterations <n>`: Maximum relationship expansion iterations (default: 5)

**Relationship Expansion:**
By default, the subset tool expands your target codes to include related concepts:
- Ingredients of drug products
- Drug forms and dose forms
- Components and constituents

This ensures that if you include a branded drug, you also get its ingredients, which are required for terminology operations.

### UNII Import

**Import UNII Data:**
```bash
# Interactive mode
tx-import unii import

# Batch mode
tx-import unii import \
  --source ./unii_data.txt \
  --dest ./data/unii.db \
  --version "2025-01" \
  --yes
```

**Source File Format** (tab-delimited):
```
Display_Name	Type	UNII	PT
Aspirin	CN	R16CO5Y76E	aspirin
Acetaminophen	CN	362O9ITL9D	acetaminophen
```

### NDC Import

The NDC import builds one database from every FDA download it finds, so that codes that have left
the market are still known (inactive, with when they were last seen): a code doesn't stop being
valid because the product is no longer sold.

**Import NDC Data:**
```bash
# Interactive mode
tx-import ndc import

# Full import
tx-import ndc import \
  --source /path/to/ndc \
  --dest ./data/ndc.db \
  --yes

# Products only
tx-import ndc import --products-only
```

**Source Structure:**

The source directory is searched recursively for the FDA files, loose or in zips:

| File | Download | |
|------|----------|---|
| product.txt / package.txt | ndctext.zip, ndc.zip (ndcxls.zip has the same as .xls) | current listings |
| Products_excluded.txt / Packages_excluded.txt | ndc_excluded.zip | listings that have left the directory |
| unfinished_product.txt / unfinished_package.txt | ndc_unfinished.zip | unfinished drugs |
| unfinished_products_excluded.txt / unfinished_packages_excluded.txt | ndc_unfinished_excluded.zip | unfinished drugs that have left |
| compounders_ndc_directory.txt | compounders_ndc_directory.zip | 503B outsourcing facility products |
| drug-ndc-0001-of-0001.json | openFDA bulk download (loose or zipped) | properties only (see below) |

Each copy is a snapshot. A zip named the way the Wayback Machine downloads are
(`20160609215020-ndctext.zip`) is dated by its name; loose files are dated by their folder name
if it's a date (`2025-07-11/product.txt`), otherwise by their modification time. Folders starting
with `.` or `_` are skipped, and other files (the pre-2009 directory files, the openFDA json) are
ignored.

```
ndc/
├── product.txt, package.txt, Products_excluded.txt, ...   (the current downloads)
├── 2025-07-11/
│   ├── product.txt
│   └── package.txt
└── wayback/
    ├── ndctext/20160609215020-ndctext.zip
    ├── ndc_excluded/20191208061645-ndc_excluded.zip
    └── ...
```

Snapshots are read newest first, and the first time a code is seen is the one used - older copies
of a code that's already loaded are ignored. The version is the date of the newest snapshot, as
YYYYMMDD (the form HL7 uses to refer to an NDC distribution); `--version` is ignored. Databases
built before this have the version as YYYY-MM-DD, and the server reads that as YYYYMMDD, so they
don't need to be rebuilt. A code is active if it's listed in the newest snapshot
of its kind (finished, unfinished, compounded). Codes that aren't valid NDCs (placeholders like
`62175-XXX-37`) are left out, and counted.

**Properties** go in the `NDCProperties` table (`NDCKey`, `IsPackage`, `Name`, `Value`), named as
openFDA names them. From the text files, for every code: `spl_id`, `application_number`,
`active_ingredient`, `pharm_class`, `dea_schedule`, `listing_expiration_date` and
`ndc_exclude_flag` for products, and `marketing_start_date`, `marketing_end_date`, `sample` and
`ndc_exclude_flag` for packages. From the openFDA json, for the products in it (taken from the
newest download that has the product): `rxcui`, `spl_set_id`, `unii`, `nui`, `upc`,
`manufacturer_name`, `is_original_packager` and `pharm_class_epc/moa/cs/pe`. openFDA gives these per
label (SPL), so a product carries the rxcuis and upcs of every product on its label. The rest of the
json is the same data as product.txt and unfinished_product.txt, so it adds no codes.

**List the snapshots, in import order:**
```bash
tx-import ndc versions --source /path/to/ndc
```

## Advanced Features

### Progress Tracking
All imports show detailed progress with:
- Current operation name
- Progress bar with percentage
- Items processed / total items  
- Estimated time remaining

### Validation Before Import
```bash
# Validate source files before importing
tx-import loinc validate --source /path/to/files
tx-import snomed validate --source /path/to/rf2
tx-import unii validate --source /path/to/file.txt
```

### Database Status Checking
```bash
# Check imported database statistics
tx-import loinc status --dest ./data/loinc.db
tx-import snomed status --dest ./data/snomed.cache
tx-import unii status --dest ./data/unii.db
```

### Batch Processing
```bash
# Process multiple terminologies in sequence
tx-import loinc import --yes --source /loinc --dest ./loinc.db
tx-import unii import --yes --source /unii.txt --dest ./unii.db
tx-import ndc import --yes --source /ndc --dest ./ndc.db
```

### Smart Defaults
The tool remembers your previous inputs:
- Source directories
- Destination paths  
- Version identifiers
- Import options

Recent choices appear as selectable options in interactive mode.

## Troubleshooting

### Common Issues

**1. "Module not found" errors:**
```bash
# Ensure all dependencies are installed
npm install commander inquirer chalk cli-progress sqlite3
```

**2. "Permission denied" errors:**
```bash
# Make script executable
chmod +x tx-import.js

# Check directory permissions
ls -la /path/to/source/files
```

**3. "Source directory validation failed":**
```bash
# Use validate command to check file structure
tx-import loinc validate --source /path/to/files

# Check for required files
ls -la /path/to/loinc/LoincTable/Loinc.csv
```

**4. "Database locked" errors:**
```bash
# Ensure no other processes are using the database
lsof /path/to/database.db

# Remove existing database if needed
rm /path/to/database.db
```

**5. Memory issues with large datasets:**
```bash
# Increase Node.js memory limit
node --max-old-space-size=8192 tx-import.js loinc import

# Use --no-indexes option for faster initial import
tx-import loinc import --no-indexes
```

### Debugging

**Enable verbose logging:**
```bash
tx-import loinc import --verbose
```

**Check configuration:**
```bash
tx-import config:show --terminology loinc
```

**Validate before importing:**
```bash
tx-import loinc validate --source /path/to/files
```

### Getting Help

**Command-specific help:**
```bash
tx-import loinc --help
tx-import loinc import --help
```

**List all available commands:**
```bash
tx-import list
tx-import help
```

## Performance Tips

1. **Use SSD storage** for faster I/O during imports
2. **Skip indexes initially** with `--no-indexes` for faster imports
3. **Use batch mode** with `--yes` for unattended imports  
4. **Increase Node.js memory** for large datasets
5. **Validate first** to catch issues early
6. **Monitor disk space** - some terminologies create large databases

## Database Output Formats

- **LOINC**: SQLite database with normalized tables
- **SNOMED CT**: Binary cache file optimized for fast loading
- **RxNorm**: SQLite database with RRF tables and word stems
- **UNII**: SQLite database with simple structure
- **NDC**: SQLite database supporting multiple versions
- **LOINC Subset**: File-based subset matching original structure
- **RxNorm Subset**: RRF file-based subset matching original structure