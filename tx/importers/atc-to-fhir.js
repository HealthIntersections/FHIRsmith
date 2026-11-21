const fs = require('fs');
const { XMLParser } = require('fast-xml-parser');
const terminal = require('./terminal');

// Configuration
const ATC_FILE = process.argv[2] || '2025_ATC.xml';
const DDD_FILE = process.argv[3] || '2025_ATC_ddd.xml';
const OUTPUT_FILE = process.argv[4] || 'atc-codesystem.json';

const PROPERTY_GROUP_EXT_URL = 'http://hl7.org/fhir/StructureDefinition/Codesystem-property-group';

// Parse XML files
function parseXML(filePath) {
    const xml = fs.readFileSync(filePath, 'utf-8');
    const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '',
        allowBooleanAttributes: true
    });
    return parser.parse(xml);
}

// Extract rows from parsed XML
function extractRows(parsed) {
    const data = parsed.xml['rs:data'];
    let rows = data['z:row'];
    if (!Array.isArray(rows)) {
        rows = [rows];
    }
    return rows;
}

// Get parent code for hierarchy
function getParentCode(code) {
    const len = code.trim().length;
    switch (len) {
        case 1: return null; // No parent
        case 3: return code.substring(0, 1); // A01 -> A
        case 4: return code.substring(0, 3); // A01A -> A01
        case 5: return code.substring(0, 4); // A01AA -> A01A
        case 7: return code.substring(0, 5); // A01AA01 -> A01AA
        default: return null;
    }
}

// Build DDD lookup map (ATCCode -> array of DDD entries)
function buildDDDMap(dddRows) {
    const map = new Map();
    
    for (const row of dddRows) {
        const code = row.ATCCode?.trim();
        if (!code) continue;
        
        const entry = {
            ddd: row.DDD,
            unit: row.UnitType,
            admRoute: row.AdmCode,
            comment: row.DDDComment
        };
        
        if (!map.has(code)) {
            map.set(code, []);
        }
        map.get(code).push(entry);
    }
    
    return map;
}

// Create property with optional group extension
function createProperty(code, value, groupId = null, valueType = 'string') {
    const prop = {
        code: code
    };
    
    if (valueType === 'code') {
        prop.valueCode = value;
    } else {
        prop.valueString = value;
    }
    
    if (groupId !== null) {
        prop.extension = [{
            url: PROPERTY_GROUP_EXT_URL,
            valueCode: String(groupId)
        }];
    }
    
    return prop;
}

// Build concept from ATC row with DDD data
function buildConcept(atcRow, dddMap) {
    const code = atcRow.ATCCode?.trim();
    const name = atcRow.Name?.trim();
    const comment = atcRow.Comment?.trim();
    
    if (!code) return null;
    
    const concept = {
        code: code,
        display: name
    };
    
    const properties = [];
    
    // Add comment property (non-grouped) if present
    if (comment) {
        properties.push(createProperty('comment', comment));
    }
    
    // Add DDD properties with grouping
    const dddEntries = dddMap.get(code) || [];
    let groupId = 1;
    
    for (const entry of dddEntries) {
        // Only create group if there's actual DDD data
        const hasDDD = entry.ddd !== undefined && entry.ddd !== null && entry.ddd;
        const hasUnit = entry.unit !== undefined && entry.unit !== null && entry.unit;
        const hasRoute = entry.admRoute !== undefined && entry.admRoute !== null && entry.admRoute;
        const hasComment = entry.comment !== undefined && entry.comment !== null && entry.comment;
        
        // Skip if no meaningful data
        if (!hasDDD && !hasUnit && !hasRoute && !hasComment) continue;
        
        if (hasDDD) {
            properties.push(createProperty('dddValue', entry.ddd, groupId));
        }
        if (hasUnit) {
            properties.push(createProperty('dddUnit', entry.unit, groupId));
        }
        if (hasRoute) {
            properties.push(createProperty('dddAdmRoute', entry.admRoute, groupId, 'code'));
        }
        if (hasComment) {
            properties.push(createProperty('dddComment', entry.comment, groupId));
        }
        
        groupId++;
    }
    
    if (properties.length > 0) {
        concept.property = properties;
    }
    
    return concept;
}

// Main conversion function
function convertATCtoFHIR(atcFile, dddFile) {
    terminal.log(`Parsing ${atcFile}...`);
    const atcParsed = parseXML(atcFile);
    const atcRows = extractRows(atcParsed);
    terminal.log(`  Found ${atcRows.length} ATC codes`);
    
    terminal.log(`Parsing ${dddFile}...`);
    const dddParsed = parseXML(dddFile);
    const dddRows = extractRows(dddParsed);
    terminal.log(`  Found ${dddRows.length} DDD entries`);
    
    terminal.log('Building DDD lookup map...');
    const dddMap = buildDDDMap(dddRows);
    terminal.log(`  ${dddMap.size} codes have DDD data`);
    
    terminal.log('Building FHIR CodeSystem...');
    
    const codeSystem = {
        resourceType: 'CodeSystem',
        id: 'atc',
        url: 'http://www.whocc.no/atc',
        identifier: [
            {
                use: 'official',
                system: 'urn:ietf:rfc:3986',
                value: 'urn:oid:2.16.840.1.113883.6.73'
            }
        ],
        version: '2025',
        name: 'ATC_classification_system',
        title: 'ATC classification system',
        status: 'active',
        experimental: false,
        date: '2025-01-07',
        publisher: 'WHO Collaborating Centre for Drug Statistics Methodology - Norwegian Institute of Public Health',
        contact: [
            {
                name: 'WHO Collaborating Centre for Drug Statistics Methodology - Norwegian Institute of Public Health',
                telecom: [
                    {
                        system: 'url',
                        value: 'http://www.whocc.no'
                    }
                ]
            }
        ],
        description: 'Anatomical Therapeutic Chemical (ATC) classification system',
        copyright: 'WHO Collaborating Centre for Drug Statistics Methodology, Oslo, Norway.  Use of all or parts of the material requires reference to the WHO Collaborating Centre for Drug Statistics Methodology. Copying and distribution for commercial purposes is not allowed. Changing or manipulating the material is not allowed.',
        caseSensitive: true,
        hierarchyMeaning: 'is-a',
        content: 'complete',
        count: 0, // Will be set after building concepts
        property: [
            {
                code: 'comment',
                description: 'General comment or note about the ATC code',
                type: 'string'
            },
            {
                code: 'dddValue',
                description: 'Defined Daily Dose numeric value',
                type: 'string'
            },
            {
                code: 'dddUnit',
                description: 'Unit of measurement for the DDD (mg, g, mcg, ml, etc.)',
                type: 'string'
            },
            {
                code: 'dddAdmRoute',
                description: 'Administration route code (O=Oral, P=Parenteral, R=Rectal, N=Nasal, TD=Transdermal, V=Vaginal, etc.)',
                type: 'code'
            },
            {
                code: 'dddComment',
                description: 'Qualifier or comment for the DDD entry (e.g., formulation type)',
                type: 'string'
            }
        ],
        concept: []
    };
    
    // Build flat concepts first
    const conceptMap = new Map();
    for (const row of atcRows) {
        const concept = buildConcept(row, dddMap);
        if (concept) {
            conceptMap.set(concept.code, concept);
        }
    }
    
    // Build nested hierarchy
    const rootConcepts = [];
    
    for (const [code, concept] of conceptMap) {
        const parentCode = getParentCode(code);
        
        if (parentCode === null) {
            // Top-level concept
            rootConcepts.push(concept);
        } else {
            // Find parent and add as child
            const parent = conceptMap.get(parentCode);
            if (parent) {
                if (!parent.concept) {
                    parent.concept = [];
                }
                parent.concept.push(concept);
            } else {
                // Parent not found, add to root (shouldn't happen with valid data)
                terminal.warn(`Warning: Parent ${parentCode} not found for ${code}`);
                rootConcepts.push(concept);
            }
        }
    }
    
    codeSystem.concept = rootConcepts;
    codeSystem.count = conceptMap.size;
    
    terminal.log(`  Generated ${conceptMap.size} concepts in nested hierarchy`);
    
    return codeSystem;
}

// Run conversion
try {
    const codeSystem = convertATCtoFHIR(ATC_FILE, DDD_FILE);
    
    terminal.log(`Writing to ${OUTPUT_FILE}...`);
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(codeSystem, null, 2));
    terminal.log('Done!');

    const totalConcepts = countConcepts(codeSystem.concept);
    const withDDD = countWithDDD(codeSystem.concept);
    terminal.log(`\nStatistics:`);
    terminal.log(`  Total concepts: ${totalConcepts}`);
    terminal.log(`  Top-level concepts: ${codeSystem.concept.length}`);
    terminal.log(`  Concepts with DDD data: ${withDDD}`);
    
} catch (error) {
    terminal.error('Error:', error.message);
    process.exit(1);
}

// Print some stats
function countConcepts(concepts) {
    let count = 0;
    for (const c of concepts) {
        count++;
        if (c.concept) {
            count += countConcepts(c.concept);
        }
    }
    return count;
}

function countWithDDD(concepts) {
    let count = 0;
    for (const c of concepts) {
        if (c.property?.some(p => p.code === 'dddValue')) {
            count++;
        }
        if (c.concept) {
            count += countWithDDD(c.concept);
        }
    }
    return count;
}
