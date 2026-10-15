// npm registry protocol checks (npm-registry-checks.js), run over HTTP against live registries.
//
// The npm public registry (registry.npmjs.org) is always a target. It is the control:
// if a check fails there, the check is wrong, not the registry. Other registries are
// added with an environment variable:
//
//   NPM_REGISTRY_TARGETS=packages2 npx jest tests/packages/npm-registry.test.js
//   NPM_REGISTRY_TARGETS="https://localhost:3000/packages|hl7.fhir.us.core|6.1.0" npx jest ...
//
// Each entry is either a preset name (see PRESETS) or "baseUrl|package|version". The
// version should be an old one that won't change. The control target can be skipped with
// NPM_REGISTRY_CONTROL=off.
//
// These tests use the network, so they are skipped in CI unless NPM_REGISTRY_TARGETS is set.
// npm-registry-local.test.js runs the same checks against the packages module, offline.

const { defineNpmRegistryChecks } = require('./npm-registry-checks');

const PRESETS = {
  npmjs: { name: 'npmjs', base: 'https://registry.npmjs.org', pkg: 'fhirpath', version: '3.15.0' },
  packages2: { name: 'packages2', base: 'https://packages2.fhir.org/packages', pkg: 'hl7.fhir.us.core', version: '6.1.0' }
};

function targets() {
  const list = [];
  if (process.env.NPM_REGISTRY_CONTROL !== 'off') {
    list.push(PRESETS.npmjs);
  }
  for (const entry of (process.env.NPM_REGISTRY_TARGETS || '').split(',').map(s => s.trim()).filter(Boolean)) {
    if (PRESETS[entry]) {
      if (!list.includes(PRESETS[entry])) {
        list.push(PRESETS[entry]);
      }
    } else {
      const [base, pkg, version] = entry.split('|');
      if (!base || !pkg || !version) {
        throw new Error(`NPM_REGISTRY_TARGETS entry "${entry}" is neither a preset (${Object.keys(PRESETS).join(', ')}) nor "baseUrl|package|version"`);
      }
      list.push({ name: base, base, pkg, version }); // runNpmCheck drops trailing slashes
    }
  }
  return list;
}

const SKIP = (process.env.CI || process.env.GITHUB_ACTIONS) && !process.env.NPM_REGISTRY_TARGETS;

(SKIP ? describe.skip : describe)('live npm registries', () => {
  for (const target of targets()) {
    defineNpmRegistryChecks(target);
  }
});
