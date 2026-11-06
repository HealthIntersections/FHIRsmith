
class ConceptUsageTracker {

  // Most codes tracked, and the longest code: the scan of a full library finds
  // about 500,000 codes, none longer than 40 characters. Codes beyond either
  // limit aren't tracked, so validating made-up codes can't grow the map forever.
  static MAX_CODES = 1000000;
  static MAX_CODE_LENGTH = 100;

  constructor() {
    this.map = new Map();
    this.codes = 0;
  }

  async scanValueSets(library) {
    let c = 0;
    for (let vsp of library.valueSetProviders) {
      let list = await vsp.listAllValueSets();
      for (let url of list) {
        let vs = await vsp.fetchValueSet(url);
        if (vs && vs.jsonObj.compose) {
          if (await this.scanValueSet(vs.jsonObj.compose)) {
            c++;
          }
        }
      }
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
      if (this.codes >= ConceptUsageTracker.MAX_CODES || code.length > ConceptUsageTracker.MAX_CODE_LENGTH) {
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