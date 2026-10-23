// The registry software page: FHIRsmith release dating, and what the page shows

const fs = require('fs');
const os = require('os');
const path = require('path');
const { FhirsmithReleases, isFhirsmith, describeAge } = require('../../registry/fhirsmith-releases');
const { ServerRegistries, ServerRegistry, ServerInformation, ServerVersionInformation } = require('../../registry/model');
const RegistryModule = require('../../registry/registry');
const RegistryCrawler = require('../../registry/crawler');
const { UptimeHistory, formatUptime } = require('../../registry/uptime');
const { commonBaseUrl } = require('../../registry/registry');

const NOW = new Date('2026-10-06T00:00:00Z').getTime();

function releases() {
  const r = new FhirsmithReleases();
  r.setReleases([
    { version: 'v0.14.1', date: '2026-09-29T00:00:00Z' },
    { version: 'v0.14.0', date: '2026-09-27T00:00:00Z' },
    { version: 'v0.13.4', date: '2026-09-17T00:00:00Z' },
    { version: 'v0.9.7', date: '2026-06-12T00:00:00Z' },
    { version: 'v0.15.0-beta', date: '2026-10-01T00:00:00Z' }
  ], 'test');
  return r;
}

describe('FhirsmithReleases', () => {
  test('pre-releases are not tracked, and the newest release is first', () => {
    expect(releases().latest().version).toBe('0.14.1');
  });

  test('the current release', () => {
    const d = releases().describe('0.14.1', NOW);
    expect(d.status).toBe('current');
    expect(d.ageDays).toBe(7);
    expect(d.behind).toBe(0);
  });

  test('an old release, with or without a leading v', () => {
    for (const v of ['0.9.7', 'v0.9.7']) {
      const d = releases().describe(v, NOW);
      expect(d.status).toBe('outdated');
      expect(d.ageDays).toBe(116);
      expect(d.behind).toBe(3);
    }
  });

  test('a snapshot is a development build after the release before it', () => {
    const d = releases().describe('0.14.2-snapshot', NOW);
    expect(d.status).toBe('dev');
    expect(d.release.version).toBe('0.14.1');
    expect(d.behind).toBe(0);
  });

  test('a version that is not n.n.n is unknown', () => {
    expect(releases().describe('', NOW).status).toBe('unknown');
    expect(releases().describe('1.0', NOW).status).toBe('unknown');
  });

  test('release dates can be read from a changelog', () => {
    const file = path.join(os.tmpdir(), `changelog-${process.pid}.md`);
    fs.writeFileSync(file, '# Changelog\n\n## [0.14.2] - \n\n## [0.14.1] - 2026-09-29\n\n## [v0.13.4] - 2026-09-17\n\n## [v0.11.0] - 2026-mm-dd\n');
    try {
      const r = new FhirsmithReleases();
      r.loadFromChangelog(file);
      expect(r.releases.map(x => x.version)).toEqual(['0.14.1', '0.13.4']);
      expect(r.source).toBe('CHANGELOG.md');
    } finally {
      fs.unlinkSync(file);
    }
  });

  test('the shipped CHANGELOG.md has release dates', () => {
    const r = new FhirsmithReleases();
    r.loadFromChangelog();
    expect(r.releases.length).toBeGreaterThan(10);
  });

  test('software names and ages', () => {
    expect(isFhirsmith('FHIRsmith')).toBe(true);
    expect(isFhirsmith('HAPI FHIR Server')).toBe(false);
    expect(isFhirsmith(undefined)).toBe(false);
    expect(describeAge(0)).toBe('today');
    expect(describeAge(1)).toBe('1 day');
    expect(describeAge(20)).toBe('2 weeks');
    expect(describeAge(116)).toBe('3 months');
    expect(describeAge(800)).toBe('2.2 years');
  });
});

describe('model', () => {
  test('the software version and release date survive a save and load', () => {
    const v = new ServerVersionInformation();
    v.software = 'FHIRsmith';
    v.softwareVersion = '0.9.7';
    v.softwareReleaseDate = '2026-06-12';
    const back = ServerVersionInformation.fromJSON(JSON.parse(JSON.stringify(v.toJSON())));
    expect(back.softwareVersion).toBe('0.9.7');
    expect(back.softwareReleaseDate).toBe('2026-06-12');
    expect(ServerVersionInformation.fromJSON({}).softwareVersion).toBe('');
    expect(ServerVersionInformation.fromJSON({}).softwareReleaseDate).toBe('');
  });
});

describe('crawler: reported release date', () => {
  const crawler = new RegistryCrawler({});
  const now = NOW;

  test('a real release date is kept', () => {
    expect(crawler.reportedReleaseDate({ releaseDate: '2026-09-05T00:37:46+10:00' }, now)).toBe('2026-09-05T00:37:46+10:00');
  });

  test("the server's own clock is not a release date", () => {
    expect(crawler.reportedReleaseDate({ releaseDate: new Date(now - 2000).toISOString() }, now)).toBe('');
  });

  test('missing or unparseable', () => {
    expect(crawler.reportedReleaseDate(undefined, now)).toBe('');
    expect(crawler.reportedReleaseDate({}, now)).toBe('');
    expect(crawler.reportedReleaseDate({ releaseDate: 'soon' }, now)).toBe('');
  });
});

describe('software page', () => {
  function addServer(registry, name, url, software, softwareVersion, error, releaseDate) {
    const server = new ServerInformation();
    server.code = name.toLowerCase();
    server.name = name;
    const v = new ServerVersionInformation();
    v.version = '4.0.1';
    v.address = url;
    v.software = software;
    v.softwareVersion = softwareVersion;
    v.error = error || '';
    v.softwareReleaseDate = releaseDate || '';
    server.versions.push(v);
    registry.servers.push(server);
  }

  function page() {
    const data = new ServerRegistries();
    const registry = new ServerRegistry();
    registry.name = 'Test';
    addServer(registry, 'Old', 'https://old.example.org/r4', 'FHIRsmith', '0.9.7');
    addServer(registry, 'Current', 'https://current.example.org/r4', 'FHIRsmith', '0.14.1');
    addServer(registry, 'Dev', 'https://dev.example.org/r4', 'FHIRsmith', '0.14.2-snapshot');
    addServer(registry, 'Other', 'https://other.example.org/r4', 'Other <Server>', '6.1', 'HTTP 503');
    addServer(registry, 'Silent', 'https://silent.example.org/r4', 'unknown', '');
    addServer(registry, 'Onto', 'https://onto.example.org/fhir', 'Ontoserver', '6.29.0', '', '2026-09-05T00:37:46+10:00');
    addServer(registry, 'Nordic', 'https://nordic.example.org/fhir', 'Ontoserver', '6.29.0', '', '2026-09-04T16:37:46+02:00');
    addServer(registry, 'Future', 'https://future.example.org/r4', 'FHIRsmith', '0.15.3', '', '2026-12-01');
    data.registries.push(registry);

    const module = new RegistryModule({});
    module.api = { getData: () => data };
    module.releases = releases();
    return module.buildSoftwareContent(NOW);
  }

  test('lists each server with its software and version', () => {
    const html = page();
    expect(html).toContain('https://old.example.org/r4');
    expect(html).toContain('Other &lt;Server&gt;');
    expect(html).toContain('6.1');
    expect(html).toContain('(unreachable)');
    expect(html).toContain('<i>unknown</i>');
    expect(html).toContain('current FHIRsmith release is <b>v0.14.1</b>');
  });

  test('says how old a FHIRsmith release is', () => {
    const html = page();
    expect(html).toContain('<span class="text-danger">3 months (3 releases behind)</span>');
    expect(html).toContain('<span class="text-success">7 days - current release</span>');
    expect(html).toContain('development build after v0.14.1');
  });

  test('other software is dated by the release date it reports', () => {
    const row = page().split('<tr>').find(r => r.startsWith('<td>Onto</td>'));
    expect(row).toContain('<td>2026-09-04</td><td>4 weeks</td>');
  });

  test('the same release reported in different time zones is dated the same day (the UTC day)', () => {
    const html = page();
    for (const name of ['Onto', 'Nordic']) {
      expect(html.split('<tr>').find(r => r.startsWith(`<td>${name}</td>`))).toContain('<td>2026-09-04</td>');
    }
  });

  test('a FHIRsmith release the release list does not know yet falls back to its reported date', () => {
    const row = page().split('<tr>').find(r => r.startsWith('<td>Future</td>'));
    expect(row).toContain('<td>2026-12-01</td>');
  });

  test('does not date software that reports no release date', () => {
    const html = page();
    // find the row by its server name cell (CodeQL flags a substring match on a host name)
    const otherRow = html.split('<tr>').find(r => r.startsWith('<td>Other</td>'));
    expect(otherRow).toContain('<td></td><td></td>');
  });
});

describe('software page: one row per server', () => {
  const HOUR = 60 * 60 * 1000;

  function endpoint(server, fhirVersion, url, software, softwareVersion, error) {
    const v = new ServerVersionInformation();
    v.version = fhirVersion;
    v.address = url;
    v.software = software;
    v.softwareVersion = softwareVersion;
    v.error = error || '';
    server.versions.push(v);
    return v;
  }

  function build(uptime) {
    const data = new ServerRegistries();
    const registry = new ServerRegistry();
    registry.name = 'Test';
    const tx = new ServerInformation();
    tx.code = 'tx';
    tx.name = 'tx.example.org';
    endpoint(tx, 'R4', 'http://tx.example.org/r4', 'FHIRsmith', '0.14.1');
    endpoint(tx, 'R3', 'http://tx.example.org/r3', 'FHIRsmith', '0.14.1');
    endpoint(tx, 'R5', 'http://tx.example.org/r5', 'FHIRsmith', '0.14.1', 'HTTP 503');
    registry.servers.push(tx);
    const mixed = new ServerInformation();
    mixed.code = 'mixed';
    mixed.name = 'Mixed';
    endpoint(mixed, 'R4', 'https://mixed.example.org/r4', 'Ontoserver', '6.29.0');
    endpoint(mixed, 'R5', 'https://mixed.example.org/r5', 'FHIRsmith', '0.14.1');
    registry.servers.push(mixed);
    data.registries.push(registry);

    const module = new RegistryModule({});
    module.api = { getData: () => data };
    module.releases = releases();
    if (uptime) {
      module.crawler = { uptime };
    }
    return module.buildSoftwareContent(NOW);
  }

  function row(html, name) {
    return html.split('<tr>').find(r => r.startsWith(`<td>${name}</td>`));
  }

  test('endpoints that run the same software collapse into one row with the base URL', () => {
    const html = build();
    const r = row(html, 'tx.example.org');
    expect(r).toContain('href="http://tx.example.org"');
    expect(r).not.toContain('tx.example.org/r4');
    expect(r).toContain('<td>R3, R4, R5</td>');
    expect(html.split('<tr>').filter(r => r.startsWith('<td>tx.example.org</td>')).length).toBe(1);
  });

  test('an endpoint that is down is named in its server row', () => {
    const r = row(build(), 'tx.example.org');
    expect(r).toContain('(R5 unreachable)');
    expect(r).toContain('title="R5: HTTP 503"');
  });

  test('endpoints running different software stay apart', () => {
    const html = build();
    const rows = html.split('<tr>').filter(r => r.startsWith('<td>Mixed</td>'));
    expect(rows.length).toBe(2);
    expect(rows.find(r => r.includes('Ontoserver'))).toContain('<td>R4</td>');
    expect(rows.find(r => r.includes('>FHIRsmith<'))).toContain('<td>R5</td>');
  });

  test('uptime is reported per server over all its endpoints', () => {
    const uptime = new UptimeHistory({ windowDays: 30 });
    for (let i = 1; i <= 10; i++) {
      const t = NOW - i * HOUR;
      uptime.record('http://tx.example.org/r4', true, t);
      uptime.record('http://tx.example.org/r3', true, t);
      uptime.record('http://tx.example.org/r5', i <= 3, t); // up for the 3 most recent scans, down for the 7 before
      uptime.record('https://mixed.example.org/r4', true, t);
    }
    const html = build(uptime);
    // 30 probes, 7 failures
    expect(row(html, 'tx.example.org')).toContain('title="23 of 30 probes answered since 2026-10-05">76%</span>');
    const rows = html.split('<tr>').filter(r => r.startsWith('<td>Mixed</td>'));
    expect(rows.find(r => r.includes('Ontoserver'))).toContain('<span class="text-success" title="10 of 10 probes answered since 2026-10-05">100%</span>');
    // the R5 endpoint has never been probed
    expect(rows.find(r => r.includes('>FHIRsmith<'))).toMatch(/<td><\/td><\/tr>$/);
    expect(html).toContain('over the last 30 days');
  });

  test('no uptime column content without a crawler', () => {
    expect(build()).not.toContain('probes answered');
  });
});

describe('UptimeHistory', () => {
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  test('uptime over the window, and nothing before it', () => {
    const h = new UptimeHistory({ windowDays: 30, retentionDays: 90 });
    h.record('a', false, NOW - 40 * DAY);
    h.record('a', true, NOW - 10 * DAY);
    h.record('a', true, NOW - 5 * DAY);
    h.record('a', false, NOW - 1 * DAY);
    const u = h.uptime('a', NOW);
    expect(u.probes).toBe(3);
    expect(u.failures).toBe(1);
    expect(u.since).toBe(NOW - 10 * DAY);
    expect(formatUptime(u)).toBe('66%');
    expect(h.uptime('b', NOW)).toBeNull();
  });

  test('records past retention are dropped, and unregistered endpoints forgotten', () => {
    const h = new UptimeHistory({ windowDays: 30, retentionDays: 90 });
    h.record('a', true, NOW - 100 * DAY);
    h.record('a', true, NOW - 80 * DAY);
    h.record('gone', true, NOW - DAY);
    h.record('a', true, NOW);
    expect(h.records.get('a').length).toBe(2);
    h.retain(['a'], NOW);
    expect(h.records.has('gone')).toBe(false);
  });

  test('survives a save and load', () => {
    const h = new UptimeHistory();
    h.record('a', true, NOW - HOUR);
    h.record('a', false, NOW);
    const back = UptimeHistory.fromJSON(JSON.parse(JSON.stringify(h.toJSON())), { windowDays: 30 });
    expect(back.uptime('a', NOW)).toEqual({ percent: 50, probes: 2, failures: 1, since: NOW - HOUR });
    expect(UptimeHistory.fromJSON(null).records.size).toBe(0);
    expect(UptimeHistory.fromJSON({ version: '1', endpoints: { a: 'junk', b: [['x', 1], [NOW, 1]] } }).uptime('b', NOW).probes).toBe(1);
  });

  test('formatting', () => {
    expect(formatUptime(null)).toBe('');
    expect(formatUptime({ percent: 100, probes: 1, failures: 0 })).toBe('100%');
    expect(formatUptime({ percent: 99.96, probes: 2500, failures: 1 })).toBe('99.9%');
    expect(formatUptime({ percent: 98.7, probes: 100, failures: 1 })).toBe('98%');
  });

  test('the crawler records each probe at the scan time', () => {
    const crawler = new RegistryCrawler({});
    crawler.scanTime = NOW;
    crawler.uptime.record('x', true, crawler.scanTime);
    crawler.uptime.record('x', false, crawler.scanTime);
    expect(crawler.saveUptime()).toEqual({ version: '1', endpoints: { x: [[NOW, 1], [NOW, 0]] } });
    crawler.loadUptime({ version: '1', endpoints: { y: [[NOW, 1]] } });
    expect(crawler.uptime.uptime('y', NOW).probes).toBe(1);
  });
});

describe('commonBaseUrl', () => {
  test('the shared base of a server\'s endpoints', () => {
    expect(commonBaseUrl(['http://tx.fhir.org/r4', 'http://tx.fhir.org/r3', 'http://tx.fhir.org/r5'])).toBe('http://tx.fhir.org');
    expect(commonBaseUrl(['https://tx.healthall.co.kr/fhir/r4', 'https://tx.healthall.co.kr/fhir/r5'])).toBe('https://tx.healthall.co.kr/fhir');
    expect(commonBaseUrl(['https://a.org/fhir', 'https://a.org/fhir/r5'])).toBe('https://a.org/fhir');
    expect(commonBaseUrl(['https://a.org/fhir'])).toBe('https://a.org/fhir');
    expect(commonBaseUrl(['https://a.org/r4', 'https://b.org/r4'])).toBe('https://a.org/r4');
    expect(commonBaseUrl([])).toBe('');
  });
});
