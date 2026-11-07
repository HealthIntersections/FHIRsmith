
class ConceptUsageTracker {

  constructor() {
    this.map = new Map();
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
    if (!cs) {
      cs = new Map();
      this.map.set(system, cs);
    }
    let ci = cs.get(code);
    if (!ci) {
      ci = { count : 0 }
      cs.set(code, ci);
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