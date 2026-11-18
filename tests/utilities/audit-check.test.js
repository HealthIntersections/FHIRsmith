const { ghsaId, advisories, check } = require('../../utilities/audit-check');

const report = {
  auditReportVersion: 2,
  vulnerabilities: {
    picomatch: {
      name: 'picomatch', severity: 'high',
      via: [{ source: 1, name: 'picomatch', title: 'ReDoS', url: 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf', severity: 'high', range: '<=4.0.7' }]
    },
    fdir: { name: 'fdir', severity: 'high', via: ['picomatch'] },
    glob: {
      name: 'glob', severity: 'moderate',
      via: ['minimatch', { source: 2, name: 'glob', title: 'traversal', url: 'https://github.com/advisories/GHSA-3g3m-2fjr-6pw4', severity: 'moderate', range: '9.0.0 - 14.0.1' }]
    }
  }
};

describe('audit-check', () => {
  test('ghsaId reads the id from an advisory url', () => {
    expect(ghsaId('https://github.com/advisories/GHSA-FC5Q-39xc-vjpf')).toBe('GHSA-fc5q-39xc-vjpf');
    expect(ghsaId('https://example.org/nothing')).toBeNull();
  });

  test('only advisory objects count, not the dependency names they come through', () => {
    expect(advisories(report).map(a => a.id).sort()).toEqual(['GHSA-3g3m-2fjr-6pw4', 'GHSA-fc5q-39xc-vjpf']);
  });

  test('an allowlisted advisory is accepted, others at the level fail', () => {
    const allow = { advisories: [{ id: 'GHSA-fc5q-39xc-vjpf', until: '2099-01-01' }] };
    const r = check(advisories(report), allow, 'moderate', '2026-11-18');
    expect(r.accepted.map(a => a.id)).toEqual(['GHSA-fc5q-39xc-vjpf']);
    expect(r.failures.map(a => a.id)).toEqual(['GHSA-3g3m-2fjr-6pw4']);
    expect(check(advisories(report), allow, 'high', '2026-11-18').failures).toEqual([]);
  });

  test('an expired entry no longer applies', () => {
    const allow = { advisories: [{ id: 'GHSA-fc5q-39xc-vjpf', until: '2026-01-01' }] };
    const r = check(advisories(report), allow, 'high', '2026-11-18');
    expect(r.failures.map(a => a.id)).toEqual(['GHSA-fc5q-39xc-vjpf']);
    expect(r.expired).toHaveLength(1);
  });

  test('an entry that matches nothing is reported as unused', () => {
    const allow = { advisories: [{ id: 'GHSA-aaaa-bbbb-cccc' }] };
    expect(check(advisories(report), allow, 'high', '2026-11-18').unused).toHaveLength(1);
  });
});
