// The npm advisory self-check (library/npm-audit.js)

const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const { NpmAudit, describeAgo, compareVersions } = require('../../library/npm-audit');


const NOW = new Date('2026-10-06T12:00:00Z').getTime();

function appDir(lock, hiddenLock = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-audit-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fhirsmith', version: '0.13.4' }));
  if (hiddenLock) {
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.writeFileSync(path.join(dir, 'node_modules', '.package-lock.json'), JSON.stringify(lock));
  } else {
    fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(lock));
  }
  return dir;
}

const LOCK = {
  packages: {
    '': { name: 'fhirsmith', version: '0.13.4' },
    'node_modules/axios': { version: '1.15.2' },
    'node_modules/tar': { version: '7.5.1' },
    'node_modules/foo/node_modules/tar': { version: '6.2.0' },
    'node_modules/jest': { version: '30.0.0', dev: true },
    'node_modules/local': { resolved: '../local', link: true },
    'node_modules/@scope/pkg': { version: '2.0.0' }
  }
};

function stats() {
  return { addTask: jest.fn(), task: jest.fn(), taskDone: jest.fn(), taskError: jest.fn() };
}

beforeEach(() => {
  jest.spyOn(axios, 'post');
  // the latest-release lookup: unreachable unless a test says otherwise
  jest.spyOn(axios, 'get').mockRejectedValue(new Error('offline'));
});
afterEach(() => jest.restoreAllMocks());

describe('collectPackages', () => {
  test('production packages from the installed lock file, plus fhirsmith itself', () => {
    const audit = new NpmAudit({}, null, appDir(LOCK));
    expect(audit.collectPackages()).toEqual({
      axios: ['1.15.2'],
      tar: ['6.2.0', '7.5.1'],
      '@scope/pkg': ['2.0.0'],
      fhirsmith: ['0.13.4']
    });
  });

  test('falls back to package-lock.json', () => {
    const audit = new NpmAudit({}, null, appDir(LOCK, false));
    expect(Object.keys(audit.collectPackages())).toContain('axios');
  });

  test('with no lock file, reads what is installed in node_modules (a global install)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-audit-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fhirsmith', version: '0.15.0' }));
    const install = (rel, name, version) => {
      fs.mkdirSync(path.join(dir, rel), { recursive: true });
      fs.writeFileSync(path.join(dir, rel, 'package.json'), JSON.stringify({ name, version }));
    };
    install('node_modules/axios', 'axios', '1.15.2');
    install('node_modules/tar', 'tar', '7.5.1');
    install('node_modules/foo', 'foo', '1.0.0');
    install('node_modules/foo/node_modules/tar', 'tar', '6.2.0');
    install('node_modules/@scope/pkg', '@scope/pkg', '2.0.0');
    fs.mkdirSync(path.join(dir, 'node_modules', '.bin'));
    fs.mkdirSync(path.join(dir, 'node_modules', 'not-a-package'));
    expect(new NpmAudit({}, null, dir).collectPackages()).toEqual({
      axios: ['1.15.2'],
      tar: ['6.2.0', '7.5.1'],
      foo: ['1.0.0'],
      '@scope/pkg': ['2.0.0'],
      fhirsmith: ['0.15.0']
    });
  });

  test('no lock file and no node_modules is an error', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-audit-'));
    expect(() => new NpmAudit({}, null, dir).collectPackages()).toThrow('No package-lock.json or node_modules');
  });
});

describe('run', () => {
  test('a clean result', async () => {
    axios.post.mockResolvedValue({ data: {} });
    const s = stats();
    const audit = new NpmAudit({}, null, appDir(LOCK), s);
    await audit.run();
    expect(axios.post.mock.calls[0][0]).toBe('https://registry.npmjs.org/-/npm/v1/security/advisories/bulk');
    expect(axios.post.mock.calls[0][1].jest).toBeUndefined();
    expect(audit.findings).toEqual([]);
    expect(audit.summary()).toBe('no known vulnerabilities');
    expect(s.taskDone).toHaveBeenCalled();
    expect(audit.renderBanner()).toBe('');
    expect(audit.renderDashboard()).toContain('no known vulnerabilities</span> in 4 packages');
    expect(audit.renderDashboard()).toContain('this server runs 0.13.4 (the latest release could not be checked)');
  });

  test('advisories are reported, worst first', async () => {
    axios.post.mockResolvedValue({ data: {
      axios: [{ id: 1, severity: 'moderate', title: 'Prototype <pollution>', url: 'https://github.com/advisories/GHSA-1', vulnerable_versions: '<1.18.0' }],
      tar: [{ id: 2, severity: 'critical', title: 'Parse DoS', url: 'https://github.com/advisories/GHSA-2', vulnerable_versions: '<=7.5.18' }]
    } });
    const s = stats();
    const audit = new NpmAudit({}, null, appDir(LOCK), s);
    await audit.run();
    expect(audit.findings.map(f => f.name)).toEqual(['tar', 'axios']);
    expect(audit.findings[0].installed).toEqual(['6.2.0', '7.5.1']);
    expect(audit.summary()).toBe('2 known vulnerabilities (1 critical, 1 moderate)');
    expect(s.taskError).toHaveBeenCalledWith('npm audit', audit.summary());

    const banner = audit.renderBanner(NOW);
    expect(banner).toContain('alert-danger');
    expect(banner).toContain('2 known vulnerabilities (1 critical, 1 moderate)');
    expect(banner).toContain('/dashboard#npm-audit');

    const dash = audit.renderDashboard(NOW);
    expect(dash).toContain('Prototype &lt;pollution&gt;');
    expect(dash).toContain('<a href="https://github.com/advisories/GHSA-2">Parse DoS</a>');
    expect(dash).toContain('6.2.0, 7.5.1');
  });

  test('only low and moderate findings make a warning, not a danger, banner', async () => {
    axios.post.mockResolvedValue({ data: { axios: [{ severity: 'low', title: 't', url: 'javascript:alert(1)' }] } });
    const audit = new NpmAudit({}, null, appDir(LOCK));
    await audit.run();
    expect(audit.renderBanner()).toContain('alert-warning');
    expect(audit.renderDashboard()).not.toContain('javascript:');
  });

  test('a failed check keeps the previous result and says so', async () => {
    axios.post.mockResolvedValueOnce({ data: {} }).mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND'));
    const s = stats();
    const audit = new NpmAudit({}, null, appDir(LOCK), s);
    await audit.run();
    await audit.run();
    expect(audit.checkedAt).not.toBeNull();
    expect(s.taskError).toHaveBeenCalledWith('npm audit', 'Could not check: getaddrinfo ENOTFOUND');
    expect(audit.renderDashboard()).toContain('the latest check failed: getaddrinfo ENOTFOUND');
  });

  test('a check that has never worked says so on the dashboard and not on the home page', async () => {
    axios.post.mockRejectedValue(new Error('timeout'));
    const audit = new NpmAudit({}, null, appDir(LOCK));
    await audit.run();
    expect(audit.renderBanner()).toBe('');
    expect(audit.renderDashboard()).toContain('could not be run: timeout');
  });
});

describe('advice', () => {
  const FINDING = { data: { tar: [{ severity: 'critical', title: 't', url: 'https://github.com/advisories/GHSA-2' }] } };

  test('an older server is told which release to upgrade to', async () => {
    axios.post.mockResolvedValue(FINDING);
    axios.get.mockResolvedValue({ data: { name: 'fhirsmith', version: '0.15.1' } });
    const audit = new NpmAudit({}, null, appDir(LOCK));
    await audit.run();
    expect(axios.get.mock.calls[0][0]).toBe('https://registry.npmjs.org/fhirsmith/latest');
    const expected = 'The server administrator should upgrade to FHIRsmith 0.15.1 (this server is running 0.13.4).';
    expect(audit.renderBanner()).toContain(expected);
    expect(audit.renderDashboard()).toContain(expected);
  });

  test('a server on the latest release is not told to upgrade', async () => {
    axios.post.mockResolvedValue(FINDING);
    axios.get.mockResolvedValue({ data: { name: 'fhirsmith', version: '0.13.4' } });
    const audit = new NpmAudit({}, null, appDir(LOCK));
    await audit.run();
    const banner = audit.renderBanner();
    expect(banner).toContain('already running the latest FHIRsmith release (0.13.4)');
    expect(banner).not.toContain('should upgrade');
  });

  test('if the latest release cannot be found, the advice is generic and the audit still reports', async () => {
    axios.post.mockResolvedValue(FINDING);
    const audit = new NpmAudit({}, null, appDir(LOCK));
    await audit.run();
    expect(audit.lastError).toBeNull();
    expect(audit.renderBanner()).toContain('should upgrade to the latest FHIRsmith release.');
  });

  test('a later failed lookup keeps the previous answer', async () => {
    axios.post.mockResolvedValue(FINDING);
    axios.get.mockResolvedValueOnce({ data: { version: '0.15.1' } }).mockRejectedValueOnce(new Error('timeout'));
    const audit = new NpmAudit({}, null, appDir(LOCK));
    await audit.run();
    await audit.run();
    expect(audit.latestVersion).toBe('0.15.1');
  });

  test('the dashboard says when a newer release is available, even with nothing to report', async () => {
    axios.post.mockResolvedValue({ data: {} });
    axios.get.mockResolvedValue({ data: { version: '0.16.0' } });
    const audit = new NpmAudit({}, null, appDir(LOCK));
    await audit.run();
    expect(audit.renderBanner()).toBe('');
    const dash = audit.renderDashboard();
    expect(dash).toContain('this server runs 0.13.4');
    expect(dash).toContain('FHIRsmith 0.16.0 is available');
  });

  test('the dashboard says when this server is on the latest release', async () => {
    axios.post.mockResolvedValue({ data: {} });
    axios.get.mockResolvedValue({ data: { version: '0.13.4' } });
    const audit = new NpmAudit({}, null, appDir(LOCK));
    await audit.run();
    expect(audit.renderDashboard()).toContain('this server runs 0.13.4, the latest release');
  });

  test('the release is still checked when the audit itself fails', async () => {
    axios.post.mockRejectedValue(new Error('timeout'));
    axios.get.mockResolvedValue({ data: { version: '0.16.0' } });
    const audit = new NpmAudit({}, null, appDir(LOCK));
    await audit.run();
    expect(audit.renderDashboard()).toContain('FHIRsmith 0.16.0 is available');
    expect(audit.renderDashboard()).toContain('could not be run: timeout');
  });

  test('compareVersions', () => {
    expect(compareVersions('0.13.4', '0.15.1')).toBeLessThan(0);
    expect(compareVersions('0.15.1', '0.15.1')).toBe(0);
    expect(compareVersions('0.15.10', '0.15.9')).toBeGreaterThan(0);
    expect(compareVersions('v1.0.0-beta.1', '1.0.0')).toBe(0);
    expect(compareVersions('0.15.1', null)).toBeNull();
    expect(compareVersions('garbage', '0.15.1')).toBeNull();
  });
});

describe('scheduling and config', () => {
  test('disabled: no task, no timers, and the dashboard says so', () => {
    const s = stats();
    const audit = new NpmAudit({ enabled: false }, null, appDir(LOCK), s);
    audit.start();
    expect(s.addTask).not.toHaveBeenCalled();
    expect(audit.timers).toEqual([]);
    expect(audit.renderDashboard()).toContain('disabled');
  });

  test('start registers a background task and stop clears the timers', () => {
    const s = stats();
    const audit = new NpmAudit({ intervalHours: 6 }, null, appDir(LOCK), s);
    audit.start();
    expect(s.addTask).toHaveBeenCalledWith('npm audit', '6 hr');
    expect(audit.timers.length).toBe(2);
    audit.stop();
    expect(audit.timers).toEqual([]);
  });

  test('describeAgo', () => {
    expect(describeAgo(NOW, NOW)).toBe('just now');
    expect(describeAgo(NOW - 5 * 60000, NOW)).toBe('5 minutes ago');
    expect(describeAgo(NOW - 3 * 3600000, NOW)).toBe('3 hours ago');
    expect(describeAgo(NOW - 72 * 3600000, NOW)).toBe('3 days ago');
  });
});
