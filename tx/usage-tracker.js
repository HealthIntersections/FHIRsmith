
class ConceptUsageTracker {

  // Defaults for usageTrackerMaxCodes and usageTrackerMaxCodeLength: most codes
  // tracked, 2x the about 500,000 codes the value sets of a full library list, and
  // the longest code, 2.5x the longest of those (40 characters). Codes beyond either
  // limit aren't tracked, so validating made-up codes can't grow the map forever.
  static MAX_CODES = 1000000;
  static MAX_CODE_LENGTH = 100;

  /**
   * @param {number} [maxCodes] - most codes tracked; Infinity = no limit
   * @param {number} [maxCodeLength] - longest code tracked; Infinity = no limit
   */
  constructor(maxCodes = ConceptUsageTracker.MAX_CODES, maxCodeLength = ConceptUsageTracker.MAX_CODE_LENGTH) {
    this.map = new Map();
    this.codes = 0;
    this.maxCodes = maxCodes;
    this.maxCodeLength = maxCodeLength;
  }

  async scanValueSets(library) {
    let c = 0;
    for (let vsp of library.valueSetProviders) {
      await vsp.scanAllValueSets(async (vs) => {
        if (vs.jsonObj.compose) {
          if (await this.scanValueSet(vs.jsonObj.compose)) {
            c++;
          }
        }
      });
    }
    return c;
  }

  async scanValueSet(compose, versions, active) {
    let ok = false;
    for (let inc of compose.include || []) {
      if (inc.system) {
        if (active && inc.version) {
          this.seeVersion(versions, inc.system, inc.version);
        }
        for (let c of inc.concept || []) {
          if (c.code) {
            ok = true;
            this.seeConcept(inc.system, c.code);
          }
        }
      }
    }
    return ok;
  }

  seeConcept(system, code) {
    let cs = this.map.get(system);
    let ci = cs ? cs.get(code) : null;
    if (!ci) {
      if (this.codes >= this.maxCodes || code.length > this.maxCodeLength) {
        return;
      }
      if (!cs) {
        cs = new Map();
        this.map.set(system, cs);
      }
      ci = { count : 0 }
      cs.set(code, ci);
      this.codes++;
    }
    ci.count++;
  }

  usages(system) {
    return this.map.get(system) || null;
  }

  seeVersion(versions, system, version) {
    let set = versions[system];
    if (set == null) {
      set = new Set();
      versions[system] = set;
    }
    set.add(version);
  }
}

module.exports = ConceptUsageTracker;