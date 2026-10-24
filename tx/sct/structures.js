const fs = require('fs');


class SnomedStrings {
  constructor(buffer = null) {
    this.master = buffer ? Buffer.from(buffer) : Buffer.alloc(0);
    this.decoder = new TextDecoder('utf-8');
    this.builder = null;
    this.currentOffset = 0; // ADD: Track offset directly
  }

  getEntry(offset) {
    if (offset > this.master.length) {
      throw new Error('Wrong length index getting snomed name');
    }

    // Read 2-byte length prefix (little-endian)
    const length = this.master.readUInt16LE(offset);

    // Bounds check
    if (offset + 2 + length > this.master.length) {
      throw new Error('Wrong length index getting snomed name (2)');
    }

    // Read UTF-8 bytes and decode to string
    const stringBytes = this.master.subarray(offset + 2, offset + 2 + length);
    return this.decoder.decode(stringBytes);
  }

  startBuild() {
    this.builder = [];
    this.currentOffset = 0; // RESET: offset when starting build
  }

  reopen() {
    this.builder = [this.master];
    this.currentOffset = this.master.length; // SET: offset to current master length
  }

  addString(str) {
    if (!this.builder) {
      throw new Error('Must call startBuild() first');
    }

    const utf8Bytes = Buffer.from(str, 'utf8');

    if (utf8Bytes.length > 65535) {
      throw new Error(`Snomed Description too long: ${str}`);
    }

    // FIXED: Use pre-calculated offset instead of reduce
    const currentOffset = this.currentOffset;

    // Create length prefix (2 bytes, little-endian)
    const lengthPrefix = Buffer.allocUnsafe(2);
    lengthPrefix.writeUInt16LE(utf8Bytes.length, 0);

    // Add length prefix + string bytes to builder
    this.builder.push(lengthPrefix, utf8Bytes);

    // UPDATE: offset for next call
    this.currentOffset += 2 + utf8Bytes.length;

    return currentOffset;
  }

  doneBuild() {
    if (!this.builder) {
      throw new Error('No build in progress');
    }

    this.master = Buffer.concat(this.builder);
    this.builder = null;
    this.currentOffset = 0; // RESET: for potential future builds
  }

  clear() {
    this.master = Buffer.alloc(0);
    this.currentOffset = 0; // RESET: offset when clearing
  }

  get length() {
    return this.master.length;
  }
}

class SnomedWords {
  constructor(buffer = null) {
    this.master = buffer ? Buffer.from(buffer) : Buffer.alloc(0);
    this.builder = null;
  }

  getEntry(index) {
    const offset = index * 5;

    if (offset > this.master.length - 5) {
      throw new Error('invalid index');
    }

    // Read 4-byte cardinal (little-endian) + 1-byte flag
    const stringIndex = this.master.readUInt32LE(offset);
    const flags = this.master.readUInt8(offset + 4);

    return { index: stringIndex, flags };
  }

  getString(index) {
    const entry = this.getEntry(index);
    return entry.index;
  }

  count() {
    return Math.floor(this.master.length / 5);
  }

  startBuild() {
    this.builder = [];
  }

  addWord(index, flags) {
    if (!this.builder) {
      throw new Error('Must call startBuild() first');
    }

    // Create 5-byte record: 4-byte index + 1-byte flag
    const record = Buffer.allocUnsafe(5);
    record.writeUInt32LE(index, 0);  // 4-byte cardinal (little-endian)
    record.writeUInt8(flags, 4);     // 1-byte flag

    this.builder.push(record);
  }

  doneBuild() {
    if (!this.builder) {
      throw new Error('No build in progress');
    }

    this.master = Buffer.concat(this.builder);
    this.builder = null;
  }

  clear() {
    this.master = Buffer.alloc(0);
  }

  get length() {
    return this.master.length;
  }
}

class SnomedStems {
  constructor(buffer = null) {
    this.master = buffer ? Buffer.from(buffer) : Buffer.alloc(0);
    this.builder = null;
  }

  getEntry(index) {
    const offset = index * 8;

    if (offset > this.master.length - 7) {
      throw new Error('invalid index');
    }

    // Read two 4-byte cardinals (little-endian)
    const stringIndex = this.master.readUInt32LE(offset);
    const reference = this.master.readUInt32LE(offset + 4);

    return { index: stringIndex, reference };
  }

  getString(index) {
    const entry = this.getEntry(index);
    return entry.index;
  }

  count() {
    return Math.floor(this.master.length / 8);
  }

  startBuild() {
    this.builder = [];
  }

  addStem(index, reference) {
    if (!this.builder) {
      throw new Error('Must call startBuild() first');
    }

    // Create 8-byte record: two 4-byte cardinals
    const record = Buffer.allocUnsafe(8);
    record.writeUInt32LE(index, 0);      // First 4-byte cardinal
    record.writeUInt32LE(reference, 4);  // Second 4-byte cardinal

    this.builder.push(record);
  }

  doneBuild() {
    if (!this.builder) {
      throw new Error('No build in progress');
    }

    this.master = Buffer.concat(this.builder);
    this.builder = null;
  }

  clear() {
    this.master = Buffer.alloc(0);
  }

  get length() {
    return this.master.length;
  }
}

class SnomedReferences {
  constructor(buffer = null) {
    this.master = buffer ? Buffer.from(buffer) : Buffer.alloc(0);
    this.builder = null;
    this.currentOffset = 0; // ADD: Track offset directly
    this.MAGIC_NO_CHILDREN = 0xFFFFFFFF; // Assuming this constant - adjust as needed
  }

  getReferences(index) {
    if (index === this.MAGIC_NO_CHILDREN || index === 0) {
      return null;
    }

    // Handle incremental building case
    if (this.builder && index >= this.master.length) {
      this.post();
    }

    if (index >= this.master.length) {
      throw new Error(`Wrong length index getting Snomed list. asked for ${index}, limit is ${this.master.length}`);
    }

    // Read count of elements
    const count = this.master.readUInt32LE(index);

    // Bounds check for the full array
    if (index + 4 + count * 4 > this.master.length) {
      throw new Error(`Wrong length index (${index}, ${count}) getting Snomed list (length = ${this.master.length})`);
    }

    // Read the cardinal array
    const result = new Array(count);
    let offset = index + 4;

    for (let i = 0; i < count; i++) {
      result[i] = this.master.readUInt32LE(offset);
      offset += 4;
    }

    return result;
  }

  getLength(index) {
    if (index > this.master.length) {
      throw new Error('Wrong length index getting Snomed list');
    }

    return this.master.readUInt32LE(index);
  }

  startBuild() {
    this.builder = [];
    this.currentOffset = 0; // RESET: offset when starting build
  }

  addReferences(cardinalArray) {
    if (!this.builder) {
      throw new Error('Must call startBuild() first');
    }

    // FIXED: Use pre-calculated offset instead of reduce
    const currentOffset = this.currentOffset;

    // Create buffer for count + array data
    const totalBytes = 4 + (cardinalArray.length * 4);
    const record = Buffer.allocUnsafe(totalBytes);

    // Write count
    record.writeUInt32LE(cardinalArray.length, 0);

    // Write each cardinal
    let offset = 4;
    for (const value of cardinalArray) {
      record.writeUInt32LE(value, offset);
      offset += 4;
    }

    this.builder.push(record);

    // UPDATE: offset for next call
    this.currentOffset += totalBytes;

    return currentOffset;
  }

  post() {
    if (this.builder) {
      this.master = Buffer.concat([this.master, ...this.builder]);
      this.builder = [];
      this.currentOffset = this.master.length; // UPDATE: offset to new master length
    }
  }

  doneBuild() {
    if (!this.builder) {
      throw new Error('No build in progress');
    }

    this.master = Buffer.concat([this.master, ...this.builder]);
    this.builder = null;
    this.currentOffset = 0; // RESET: for potential future builds
  }

  clear() {
    this.master = Buffer.alloc(0);
    this.currentOffset = 0; // RESET: offset when clearing
  }

  get length() {
    return this.master.length;
  }
}

class SnomedDescriptions {
  static DESC_SIZE = 40;

  // Flag constants
  static FLAG_Active = 0;
  static FLAG_RetiredWithoutStatedReason = 1;
  static FLAG_Duplicate = 2;
  static FLAG_Outdated = 3;
  static FLAG_Ambiguous = 4;
  static FLAG_Erroneous = 5;
  static FLAG_Limited = 6;
  static FLAG_Inappropriate = 7;
  static FLAG_ConceptInactive = 8;
  static FLAG_MovedElswhere = 10;
  static FLAG_PendingMove = 11;

  constructor(buffer = null) {
    this.master = buffer ? Buffer.from(buffer) : Buffer.alloc(0);
    this.builder = null;
    this.currentOffset = 0; // ADD: Track offset directly
  }

  count() {
    return Math.floor(this.master.length / SnomedDescriptions.DESC_SIZE);
  }

  getDescription(index) {
    if (index >= this.master.length) {
      throw new Error('Wrong length index getting snomed Desc Details');
    }

    const offset = index;

    return {
      iDesc: this.master.readUInt32LE(offset + 0),
      active: this.master.readUInt8(offset + 4) !== 0,
      id: this.master.readBigUInt64LE(offset + 5),
      concept: this.master.readUInt32LE(offset + 13),
      module: this.master.readUInt32LE(offset + 17),
      kind: this.master.readUInt32LE(offset + 21),
      caps: this.master.readUInt32LE(offset + 25),
      date: this.master.readUInt16LE(offset + 29),
      lang: this.master.readUInt8(offset + 31),
      refsets: this.master.readUInt32LE(offset + 32),
      valueses: this.master.readUInt32LE(offset + 36)
    };
  }

  conceptByIndex(index) {
    if (index >= this.master.length) {
      throw new Error('Wrong length index getting snomed Desc Details');
    }

    return this.master.readUInt32LE(index + 13);
  }

  startBuild() {
    this.builder = [];
    this.currentOffset = 0; // RESET: offset when starting build
  }

  addDescription(iDesc, id, date, concept, module, kind, caps, active, lang) {
    if (!this.builder) {
      throw new Error('Must call startBuild() first');
    }

    // FIXED: Use pre-calculated offset instead of reduce
    const currentOffset = this.currentOffset;

    // Create 40-byte record
    const record = Buffer.allocUnsafe(SnomedDescriptions.DESC_SIZE);

    record.writeUInt32LE(iDesc, 0);         // 4 bytes
    record.writeUInt8(active ? 1 : 0, 4);   // 1 byte
    record.writeBigUInt64LE(BigInt(id), 5); // 8 bytes
    record.writeUInt32LE(concept, 13);      // 4 bytes
    record.writeUInt32LE(module, 17);       // 4 bytes
    record.writeUInt32LE(kind, 21);         // 4 bytes
    record.writeUInt32LE(caps, 25);         // 4 bytes
    record.writeUInt16LE(date, 29);         // 2 bytes
    record.writeUInt8(lang, 31);            // 1 byte
    record.writeUInt32LE(0, 32);            // 4 bytes (refsets)
    record.writeUInt32LE(0, 36);            // 4 bytes (valueses)

    this.builder.push(record);

    // UPDATE: offset for next call
    this.currentOffset += SnomedDescriptions.DESC_SIZE;

    return currentOffset;
  }

  setRefsets(index, refsets, valueses) {
    if (index >= this.master.length) {
      throw new Error('Wrong length index getting snomed Desc Details');
    }

    if (index % SnomedDescriptions.DESC_SIZE !== 0) {
      throw new Error('Index must be aligned to DESC_SIZE');
    }

    this.master.writeUInt32LE(refsets, index + 32);
    this.master.writeUInt32LE(valueses, index + 36);
  }

  doneBuild() {
    if (!this.builder) {
      throw new Error('No build in progress');
    }

    this.master = Buffer.concat(this.builder);
    this.builder = null;
    this.currentOffset = 0; // RESET: for potential future builds
  }

  clear() {
    this.master = Buffer.alloc(0);
    this.currentOffset = 0; // RESET: offset when clearing
  }

  get length() {
    return this.master.length;
  }
}

class SnomedDescriptionIndex {
  constructor(buffer = null) {
    this.master = buffer ? Buffer.from(buffer) : Buffer.alloc(0);
    this.builder = null;
  }

  findDescription(identity) {
    // Convert to BigInt if it's not already
    const targetId = typeof identity === 'string' ? BigInt(identity) : BigInt(identity);

    let result = false;
    let L = 0;
    let H = Math.floor(this.master.length / 12) - 1;

    while (L <= H) {
      const I = Math.floor((L + H) / 2);
      const aConcept = this.master.readBigUInt64LE(I * 12);

      if (aConcept < targetId) {
        L = I + 1;
      } else {
        H = I - 1;
        if (aConcept === targetId) {
          result = true;
          L = I;  // Found it, but continue searching left for first occurrence
        }
      }
    }

    if (result) {
      const index = this.master.readUInt32LE(L * 12 + 8);
      return { found: true, index };
    } else {
      return { found: false, index: 0 };
    }
  }

  startBuild() {
    this.builder = [];
  }

  addDescription(id, reference) {
    if (!this.builder) {
      throw new Error('Must call startBuild() first');
    }

    // Convert to BigInt if needed
    const bigIntId = typeof id === 'string' ? BigInt(id) : BigInt(id);

    // Create 12-byte record: 8-byte ID + 4-byte reference
    const record = Buffer.allocUnsafe(12);
    record.writeBigUInt64LE(bigIntId, 0);
    record.writeUInt32LE(reference, 8);

    this.builder.push(record);
  }

  doneBuild() {
    if (!this.builder) {
      throw new Error('No build in progress');
    }

    this.master = Buffer.concat(this.builder);
    this.builder = null;
  }

  clear() {
    this.master = Buffer.alloc(0);
  }

  get length() {
    return this.master.length;
  }

  // Helper method to get count of entries
  count() {
    return Math.floor(this.master.length / 12);
  }
}

class SnomedConceptList {
  static CONCEPT_SIZE = 56;
  static MASK_CONCEPT_STATUS = 0x0F;
  static MASK_CONCEPT_PRIMITIVE = 0x10;
  static MAGIC_NO_CHILDREN = 0xFFFFFFFF;

  constructor(buffer = null) {
    this.master = buffer ? Buffer.from(buffer) : Buffer.alloc(0);
    this.builder = null;
    this.currentOffset = 0; // ADD: Track offset directly
  }

  // Helper method to check post-build state and bounds
  #checkPostBuildAccess(index) {
    if (this.builder !== null) {
      throw new Error('Cannot call setX methods before doneBuild()');
    }
    if (index >= this.master.length) {
      throw new Error(`Wrong length index ${index} getting snomed Concept Details. Max = ${this.master.length}`);
    }
    if (index % SnomedConceptList.CONCEPT_SIZE !== 0) {
      throw new Error(`Wrong length index ${index} getting snomed Concept Details`);
    }
  }

  findConcept(identity) {
    const targetId = typeof identity === 'string' ? BigInt(identity) : BigInt(identity);

    let result = false;
    let L = 0;
    let H = Math.floor(this.master.length / SnomedConceptList.CONCEPT_SIZE) - 1;

    while (L <= H) {
      const I = Math.floor((L + H) / 2);
      const aConcept = this.master.readBigUInt64LE(I * SnomedConceptList.CONCEPT_SIZE);

      if (aConcept < targetId) {
        L = I + 1;
      } else {
        H = I - 1;
        if (aConcept === targetId) {
          result = true;
          L = I;
        }
      }
    }

    const index = L * SnomedConceptList.CONCEPT_SIZE;
    return { found: result, index };
  }

  getConceptByCount(index) {
    return this.getConcept(index * SnomedConceptList.CONCEPT_SIZE);
  }

  getConcept(index) {
    this.#checkPostBuildAccess(index);

    return {
      index : index,
      identity: this.master.readBigUInt64LE(index + 0),
      flags: this.master.readUInt8(index + 8),
      parents: this.master.readUInt32LE(index + 9),
      descriptions: this.master.readUInt32LE(index + 13),
      inbounds: this.master.readUInt32LE(index + 17),
      outbounds: this.master.readUInt32LE(index + 21),
      effectiveTime: this.master.readUInt16LE(index + 34),
      refsets: this.master.readUInt32LE(index + 44)
    };
  }

  getConceptId(index) {
    if (index >= this.master.length) {
      throw new Error('Wrong length index getting snomed Concept Details');
    }
    return this.master.readBigUInt64LE(index + 0);
  }

  getParent(index) {
    this.#checkPostBuildAccess(index);
    return this.master.readUInt32LE(index + 9);
  }

  getIdentity(index) {
    this.#checkPostBuildAccess(index);
    return this.master.readBigUInt64LE(index + 0);
  }

  getDescriptions(index) {
    this.#checkPostBuildAccess(index);
    return this.master.readUInt32LE(index + 13);
  }

  getInbounds(index) {
    this.#checkPostBuildAccess(index);
    return this.master.readUInt32LE(index + 17);
  }

  getOutbounds(index) {
    this.#checkPostBuildAccess(index);
    return this.master.readUInt32LE(index + 21);
  }

  getAllDesc(index) {
    this.#checkPostBuildAccess(index);
    return this.master.readUInt32LE(index + 25);
  }

  getDepth(index) {
    this.#checkPostBuildAccess(index);
    return this.master.readUInt8(index + 29);
  }

  getStems(index) {
    this.#checkPostBuildAccess(index);
    return this.master.readUInt32LE(index + 30);
  }

  getModuleId(index) {
    this.#checkPostBuildAccess(index);
    return this.master.readUInt32LE(index + 36);
  }

  getStatus(index) {
    this.#checkPostBuildAccess(index);
    return this.master.readUInt32LE(index + 40);
  }

  getRefsets(index) {
    this.#checkPostBuildAccess(index);
    return this.master.readUInt32LE(index + 44);
  }

  getNormalForm(index) {
    this.#checkPostBuildAccess(index);
    return this.master.readUInt32LE(index + 48);
  }

  setNormalFormDuringBuild(index, value) {
    // Special version that can be called during building phase
    // This bypasses the post-build access check for normal forms specifically
    if (index >= this.master.length) {
      throw new Error(`Wrong length index ${index} getting snomed Concept Details. Max = ${this.master.length}`);
    }
    if (index % SnomedConceptList.CONCEPT_SIZE !== 0) {
      throw new Error(`Wrong length index ${index} getting snomed Concept Details`);
    }

    this.master.writeUInt32LE(value, index + 48);
  }
  // Also add a helper to check if a concept exists by index
  conceptExists(index) {
    try {
      if (index >= this.master.length) {
        return false;
      }
      if (index % SnomedConceptList.CONCEPT_SIZE !== 0) {
        return false;
      }
      return true;
    } catch (error) {
      return false;
    }
  }

// Add a helper to get concept identity safely
  getConceptIdentitySafe(index) {
    try {
      if (!this.conceptExists(index)) {
        return null;
      }
      return this.master.readBigUInt64LE(index + 0);
    } catch (error) {
      return null;
    }
  }

  // All the setter methods - these require doneBuild() to have been called
  setParents(index, active, inactive) {
    this.#checkPostBuildAccess(index);
    this.master.writeUInt32LE(active, index + 9);
    this.master.writeUInt32LE(inactive, index + 52);
  }

  setDescriptions(index, value) {
    this.#checkPostBuildAccess(index);
    this.master.writeUInt32LE(value, index + 13);
  }

  setModuleId(index, moduleIndex) {
    this.#checkPostBuildAccess(index);
    this.master.writeUInt32LE(moduleIndex, index + 36);
  }

  setInbounds(index, value) {
    this.#checkPostBuildAccess(index);
    this.master.writeUInt32LE(value, index + 17);
  }

  setOutbounds(index, value) {
    this.#checkPostBuildAccess(index);
    this.master.writeUInt32LE(value, index + 21);
  }

  setAllDesc(index, value) {
    this.#checkPostBuildAccess(index);
    this.master.writeUInt32LE(value, index + 25);
  }

  setDepth(index, value) {
    this.#checkPostBuildAccess(index);
    this.master.writeUInt8(value, index + 29);
  }

  setStems(index, value) {
    this.#checkPostBuildAccess(index);
    this.master.writeUInt32LE(value, index + 30);
  }

  setDate(index, effectiveTime) {
    this.#checkPostBuildAccess(index);
    this.master.writeUInt16LE(effectiveTime, index + 34);
  }

  setStatus(index, value) {
    this.#checkPostBuildAccess(index);
    this.master.writeUInt32LE(value, index + 40);
  }

  setRefsets(index, value) {
    this.#checkPostBuildAccess(index);
    this.master.writeUInt32LE(value, index + 44);
  }

  setNormalForm(index, value) {
    this.#checkPostBuildAccess(index);
    this.master.writeUInt32LE(value, index + 48);
  }

  setFlag(index, flags) {
    this.#checkPostBuildAccess(index);
    this.master.writeUInt8(flags, index + 8);
  }

  count() {
    return Math.floor(this.master.length / SnomedConceptList.CONCEPT_SIZE);
  }

  // Build methods
  startBuild() {
    this.builder = [];
    this.currentOffset = 0; // RESET: offset when starting build
  }

  addConcept(identity, effectiveTime, flags) {
    if (!this.builder) {
      throw new Error('Must call startBuild() first');
    }

    // FIXED: Use pre-calculated offset instead of reduce
    const currentOffset = this.currentOffset;
    const bigIntId = typeof identity === 'string' ? BigInt(identity) : BigInt(identity);

    // Create 56-byte record
    const record = Buffer.allocUnsafe(SnomedConceptList.CONCEPT_SIZE);

    record.writeBigUInt64LE(bigIntId, 0);     // identity
    record.writeUInt8(flags, 8);             // flags
    record.writeUInt32LE(0, 9);              // active parents
    record.writeUInt32LE(0, 13);             // descriptions
    record.writeUInt32LE(0, 17);             // inbounds
    record.writeUInt32LE(0, 21);             // outbounds
    record.writeUInt32LE(0, 25);             // closures
    record.writeUInt8(0, 29);                // depth
    record.writeUInt32LE(0, 30);             // stems
    record.writeUInt16LE(effectiveTime, 34); // date
    record.writeUInt32LE(0, 36);             // moduleId
    record.writeUInt32LE(0, 40);             // status
    record.writeUInt32LE(0, 44);             // refsets
    record.writeUInt32LE(0, 48);             // normal form
    record.writeUInt32LE(0, 52);             // inactive parents

    this.builder.push(record);

    // UPDATE: offset for next call
    this.currentOffset += SnomedConceptList.CONCEPT_SIZE;

    return currentOffset;
  }

  doneBuild() {
    if (!this.builder) {
      throw new Error('No build in progress');
    }

    this.master = Buffer.concat(this.builder);
    this.builder = null; // This enables the setX methods
    this.currentOffset = 0; // RESET: for potential future builds
  }

  clear() {
    this.master = Buffer.alloc(0);
    this.currentOffset = 0; // RESET: offset when clearing
  }

  get length() {
    return this.master.length;
  }
}

class SnomedRelationshipList {
  static RELATIONSHIP_SIZE = 40;
  static REFSET_SIZE_NOLANG = 28;
  static REFSET_SIZE_LANG = 32;

  constructor(buffer = null) {
    this.master = buffer ? Buffer.from(buffer) : Buffer.alloc(0);
    this.builder = null;
    this.currentOffset = 0; // ADD: Track offset directly
  }

  getRelationship(index) {
    if (index >= this.master.length) {
      throw new Error('Wrong length index getting snomed relationship Details');
    }

    return {
      source: this.master.readUInt32LE(index + 0),
      target: this.master.readUInt32LE(index + 4),
      relType: this.master.readUInt32LE(index + 8),
      module: this.master.readUInt32LE(index + 12),
      kind: this.master.readUInt32LE(index + 16),
      modifier: this.master.readUInt32LE(index + 20),
      date: this.master.readUInt16LE(index + 24),
      active: this.master.readUInt8(index + 26) !== 0,
      defining: this.master.readUInt8(index + 27) !== 0,
      group: this.master.readInt32LE(index + 28), // Signed integer
      identity: this.master.readBigUInt64LE(index + 32)
    };
  }

  count() {
    return Math.floor(this.master.length / SnomedRelationshipList.RELATIONSHIP_SIZE);
  }

  // Build methods
  startBuild() {
    this.builder = [];
    this.currentOffset = 0; // RESET: offset when starting build
  }

  addRelationship(identity, source, target, relType, module, kind, modifier, date, active, defining, group) {
    if (!this.builder) {
      throw new Error('Must call startBuild() first');
    }

    // FIXED: Use pre-calculated offset instead of reduce
    const currentOffset = this.currentOffset;
    const bigIntId = typeof identity === 'string' ? BigInt(identity) : BigInt(identity);

    // Create 40-byte record
    const record = Buffer.allocUnsafe(SnomedRelationshipList.RELATIONSHIP_SIZE);

    record.writeUInt32LE(source, 0);
    record.writeUInt32LE(target, 4);
    record.writeUInt32LE(relType, 8);
    record.writeUInt32LE(module, 12);
    record.writeUInt32LE(kind, 16);
    record.writeUInt32LE(modifier, 20);
    record.writeUInt16LE(date, 24);
    record.writeUInt8(active ? 1 : 0, 26);
    record.writeUInt8(defining ? 1 : 0, 27);
    record.writeInt32LE(group, 28);           // Signed integer
    record.writeBigUInt64LE(bigIntId, 32);

    this.builder.push(record);

    // UPDATE: offset for next call
    this.currentOffset += SnomedRelationshipList.RELATIONSHIP_SIZE;

    return currentOffset;
  }

  doneBuild() {
    if (!this.builder) {
      throw new Error('No build in progress');
    }

    this.master = Buffer.concat(this.builder);
    this.builder = null;
    this.currentOffset = 0; // RESET: for potential future builds
  }

  clear() {
    this.master = Buffer.alloc(0);
    this.currentOffset = 0; // RESET: offset when clearing
  }

  get length() {
    return this.master.length;
  }
}

class SnomedReferenceSetMembers {
  static MAGIC_NO_CHILDREN = 0xFFFFFFFF;

  constructor(buffer = null) {
    this.master = buffer ? Buffer.from(buffer) : Buffer.alloc(0);
    this.builder = null;
    this.currentOffset = 0; // ADD: Track offset directly
  }

  getMemberCount(index) {
    if (index === SnomedReferenceSetMembers.MAGIC_NO_CHILDREN) {
      return 0;
    }

    if (index > this.master.length) {
      throw new Error('Wrong length index getting Snomed list');
    }

    return this.master.readUInt32LE(index);
  }

  getMembers(index) {
    if (index === SnomedReferenceSetMembers.MAGIC_NO_CHILDREN) {
      return null;
    }

    if (index > this.master.length) {
      throw new Error(`Wrong length index getting Snomed list. asked for ${index}, limit is ${this.master.length}`);
    }

    // Read count and ids flag
    const count = this.master.readUInt32LE(index);
    const ids = this.master.readUInt8(index + 4) !== 0;

    let offset = index + 5; // Skip count + ids flag
    const result = new Array(count);

    for (let i = 0; i < count; i++) {
      const member = {};

      if (ids) {
        // Read full member with GUID
        member.id = this.master.subarray(offset, offset + 16); // 16-byte GUID as Buffer
        offset += 16;
        member.module = this.master.readUInt32LE(offset);
        offset += 4;
        member.date = this.master.readUInt16LE(offset);
        offset += 2;
        member.kind = this.master.readUInt8(offset);
        offset += 1;
        member.ref = this.master.readUInt32LE(offset);
        offset += 4;
        member.values = this.master.readUInt32LE(offset);
        offset += 4;
      } else {
        // Read basic member without GUID/module/date
        member.id = null;
        member.module = null;
        member.date = null;
        member.kind = this.master.readUInt8(offset);
        offset += 1;
        member.ref = this.master.readUInt32LE(offset);
        offset += 4;
        member.values = this.master.readUInt32LE(offset);
        offset += 4;
      }

      result[i] = member;
    }

    return result;
  }

  startBuild() {
    this.builder = [];
    this.currentOffset = 0; // RESET: offset when starting build
  }

  addMembers(ids, membersArray) {
    if (!this.builder) {
      throw new Error('Must call startBuild() first');
    }

    // FIXED: Use pre-calculated offset instead of reduce
    const currentOffset = this.currentOffset;

    // Calculate total size needed
    const count = membersArray.length;
    const bytesPerMember = ids ? 31 : 9; // 31 bytes with IDs, 9 bytes without
    const totalSize = 5 + (count * bytesPerMember); // 5 = count(4) + ids_flag(1)

    const record = Buffer.allocUnsafe(totalSize);
    let offset = 0;

    // Write count and ids flag
    record.writeUInt32LE(count, offset);
    offset += 4;
    record.writeUInt8(ids ? 1 : 0, offset);
    offset += 1;

    // Write each member
    for (const member of membersArray) {
      if (ids) {
        // Write full member with GUID
        if (member.id && Buffer.isBuffer(member.id)) {
          member.id.copy(record, offset, 0, 16);
        } else if (typeof member.id === 'string') {
          // Convert GUID string to buffer if needed
          const guidBuffer = this.#guidStringToBuffer(member.id);
          guidBuffer.copy(record, offset, 0, 16);
        } else {
          // Zero-fill if no GUID provided
          record.fill(0, offset, offset + 16);
        }
        offset += 16;

        record.writeUInt32LE(member.module || 0, offset);
        offset += 4;
        record.writeUInt16LE(member.date || 0, offset);
        offset += 2;
      }

      record.writeUInt8(member.kind || 0, offset);
      offset += 1;
      record.writeUInt32LE(member.ref || 0, offset);
      offset += 4;
      record.writeUInt32LE(member.values || 0, offset);
      offset += 4;
    }

    this.builder.push(record);

    // UPDATE: offset for next call
    this.currentOffset += totalSize;

    return currentOffset;
  }

  // Helper method to convert GUID string to 16-byte buffer
  #guidStringToBuffer(guidString) {
    // Remove hyphens and braces from GUID string
    const cleanGuid = guidString.replace(/[-{}]/g, '');
    if (cleanGuid.length !== 32) {
      throw new Error('Invalid GUID format');
    }
    return Buffer.from(cleanGuid, 'hex');
  }

  // Helper method to convert 16-byte buffer to GUID string
  guidBufferToString(guidBuffer) {
    if (!Buffer.isBuffer(guidBuffer) || guidBuffer.length !== 16) {
      return null;
    }
    const hex = guidBuffer.toString('hex');
    return `${hex.substr(0, 8)}-${hex.substr(8, 4)}-${hex.substr(12, 4)}-${hex.substr(16, 4)}-${hex.substr(20, 12)}`;
  }

  doneBuild() {
    if (!this.builder) {
      throw new Error('No build in progress');
    }

    this.master = Buffer.concat(this.builder);
    this.builder = null;
    this.currentOffset = 0; // RESET: for potential future builds
  }

  clear() {
    this.master = Buffer.alloc(0);
    this.currentOffset = 0; // RESET: offset when clearing
  }

  get length() {
    return this.master.length;
  }
}

class SnomedReferenceSetIndex {
  static REFSET_SIZE_LANG = 32; // Always using lang version
  static REFSET_SIZE_NOLANG = 28;

  constructor(buffer = null, hasLangs = true) {
    this.master = buffer ? Buffer.from(buffer) : Buffer.alloc(0);
    this.builder = null;
    this.hasLangs = hasLangs;
    this.recordSize = hasLangs ? SnomedReferenceSetIndex.REFSET_SIZE_LANG : SnomedReferenceSetIndex.REFSET_SIZE_NOLANG;
  }

  getReferenceSet(index) {
    const byteIndex = index * this.recordSize;

    if (byteIndex >= this.master.length) {
      throw new Error('Wrong length index getting snomed relationship Details');
    }

    const result = {
      definition: this.master.readUInt32LE(byteIndex + 0),
      filename: this.master.readUInt32LE(byteIndex + 4),
      membersByRef: this.master.readUInt32LE(byteIndex + 8),
      membersByName: this.master.readUInt32LE(byteIndex + 12),
      fieldTypes: this.master.readUInt32LE(byteIndex + 16),
      name: this.master.readUInt32LE(byteIndex + 20),
      fieldNames: this.master.readUInt32LE(byteIndex + 24)
    };

    // Only read langs field if hasLangs is true
    if (this.hasLangs) {
      result.langs = this.master.readUInt32LE(byteIndex + 28);
    } else {
      result.langs = 0;
    }

    return result;
  }

  getMembersByConcept(conceptIndex, byName = false) {
    // Linear search through records looking for matching concept
    for (let i = 0; i < this.count(); i++) {
      const offset = i * this.recordSize;
      const definition = this.master.readUInt32LE(offset + 0);

      if (definition === conceptIndex) {
        if (byName) {
          return this.master.readUInt32LE(offset + 12); // membersByName
        } else {
          return this.master.readUInt32LE(offset + 8);  // membersByRef
        }
      }
    }

    return 0; // Not found
  }

  getRefSetByConcept(conceptIndex) {
    // Linear search through records looking for matching concept, return record index
    for (let i = 0; i < this.count(); i++) {
      const offset = i * this.recordSize;
      const definition = this.master.readUInt32LE(offset + 0);

      if (definition === conceptIndex) {
        return i; // Return record index, not byte offset
      }
    }

    return -1; // Not found
  }

  count() {
    return Math.floor(this.master.length / this.recordSize);
  }

  // Build methods
  startBuild() {
    this.builder = [];
  }

  addReferenceSet(name, filename, definition, membersByRef, membersByName, fieldTypes, fieldNames, langs) {
    if (!this.builder) {
      throw new Error('Must call startBuild() first');
    }

    // Create 32-byte record - store in the order used by Pascal AddReferenceSet
    const record = Buffer.allocUnsafe(this.recordSize);

    record.writeUInt32LE(definition, 0);     // First stored
    record.writeUInt32LE(filename, 4);       // Second stored
    record.writeUInt32LE(membersByRef, 8);   // Third stored
    record.writeUInt32LE(membersByName, 12); // Fourth stored
    record.writeUInt32LE(fieldTypes, 16);    // Fifth stored
    record.writeUInt32LE(name, 20);          // Sixth stored
    record.writeUInt32LE(fieldNames, 24);    // Seventh stored

    if (this.hasLangs) {
      record.writeUInt32LE(langs, 28);       // Eighth stored
    }

    this.builder.push(record);
  }

  doneBuild() {
    if (!this.builder) {
      throw new Error('No build in progress');
    }

    this.master = Buffer.concat(this.builder);
    this.builder = null;
  }

  clear() {
    this.master = Buffer.alloc(0);
  }

  get length() {
    return this.master.length;
  }
}


class SnomedFileReader {
  constructor(filePath) {
    this.filePath = filePath;
    this.buffer = null;
    this.offset = 0;
  }

  async load() {
    // Read entire file into buffer
    this.buffer = await fs.promises.readFile(this.filePath);
    this.offset = 0;
  }

  // Read a string (Free Pascal TReader format: type byte + length + string bytes)
  readString() {
    // Read TValueType enum (1 byte)
    const valueType = this.buffer.readUInt8(this.offset);
    this.offset += 1;

    let length;
    // Based on the actual file format we're seeing:
    // Type 6 appears to use 1-byte length (not 4-byte as we expected)
    if (valueType === 6) {
      length = this.buffer.readUInt8(this.offset); // 1-byte length
      this.offset += 1;
    } else {
      // We'll handle other types when we encounter them
      throw new Error(`Unknown string type: ${valueType}`);
    }

    if (length === 0) {
      return '';
    }

    const str = this.buffer.toString('utf8', this.offset, this.offset + length);
    this.offset += length;
    return str;
  }

  // Read a 4-byte integer (TReader format: type byte + integer)
  readInteger() {
    // Read type byte first
    const valueType = this.buffer.readUInt8(this.offset);
    this.offset += 1;

    let value;
    switch (valueType) {
      case 2: // Int8
        value = this.buffer.readInt8(this.offset);
        this.offset += 1;
        break;
      case 3: // Int16
        value = this.buffer.readInt16LE(this.offset);
        this.offset += 2;
        break;
      case 4: // Int32
        value = this.buffer.readInt32LE(this.offset);
        this.offset += 4;
        break;
      default:
        throw new Error(`Unknown integer type: ${valueType}`);
    }

    return value;
  }

  // Read an 8-byte UInt64 (little-endian)
  readUInt64() {
    const value = this.buffer.readBigUInt64LE(this.offset);
    this.offset += 8;
    return value;
  }

  // Read a byte array (length-prefixed using TReader.ReadInteger format)
  readBytes() {
    const length = this.readInteger(); // Use TReader format, not raw bytes
    const bytes = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return bytes;
  }

  // Main loading method that matches the Pascal logic
  async loadSnomedData() {
    await this.load();

    const result = {
      cacheVersion: this.readString(),  // This is "16" or "17" - the cache format version
      versionUri: this.readString(),
      versionDate: this.readString(),
      isTesting: false,

      // Version-dependent settings
      hasLangs: false,  // Default for older versions
      isUTF16: false,   // Will be determined by version

      // Extract edition and version from URI
      edition: null,
      version: null,

      // Structure data
      strings: this.readBytes(),
      refs: this.readBytes(),
      desc: this.readBytes(),
      words: this.readBytes(),
      stems: this.readBytes(),
      concept: this.readBytes(),
      rel: this.readBytes(),
      refSetIndex: this.readBytes(),
      refSetMembers: this.readBytes(),
      descRef: this.readBytes(),

      // Additional data
      isAIndex: this.readInteger(),
      inactiveRoots: [],
      activeRoots: [],
      defaultLanguage: null // Will be read last
    };

    result.isTesting = result.versionUri.includes("/xsct/");
    // Parse edition and version from URI
    const uriParts = result.versionUri.split('/');
    if (uriParts.length >= 7) {
      result.edition = uriParts[4];
      result.version = uriParts[6];
    }

    // Determine settings based on cache version string (matching Pascal logic)
    if (result.cacheVersion === '17' || result.cacheVersion === '18') { // SNOMED_CACHE_VERSION_CURRENT (18 = 17 + alternate identifiers)
      result.hasLangs = true;
    } else if (result.cacheVersion === '16') { // Assuming this is UTF8 version for now
      result.isUTF16 = false;
      result.hasLangs = false;
    } else {
      throw new Error(`Unsupported SNOMED cache version: ${result.cacheVersion}`);
    }

    const inactiveRootsLength = this.readInteger();

    for (let i = 0; i < inactiveRootsLength; i++) {
      result.inactiveRoots.push(this.readUInt64());
    }

    // Read active roots array
    const activeRootsLength = this.readInteger();
    for (let i = 0; i < activeRootsLength; i++) {
      result.activeRoots.push(this.readUInt64());
    }

    // Read default language
    result.defaultLanguage = this.readInteger();

    // Alternate identifiers (version 18): [[scheme, module, code, conceptId], ...]
    result.identifiers = [];
    if (result.cacheVersion === '18') {
      result.identifiers = JSON.parse(this.readBytes().toString('utf8'));
    }

    return result;
  }
}

module.exports = {
  SnomedStrings,
  SnomedWords,
  SnomedStems,
  SnomedReferences,
  SnomedDescriptions,
  SnomedDescriptionIndex,
  SnomedConceptList,
  SnomedRelationshipList,
  SnomedReferenceSetMembers,
  SnomedReferenceSetIndex,
  SnomedFileReader
};