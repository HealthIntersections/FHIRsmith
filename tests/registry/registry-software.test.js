// The registry software page: FHIRsmith release dating, and what the page shows

const fs = require('fs');
const os = require('os');
const path = require('path');
const { FhirsmithReleases, isFhirsmith, describeAge } = require('../../registry/fhirsmith-releases');
const { ServerRegistries, ServerRegistry, ServerInformation, ServerVersionInformation } = require('../../registry/model');
const RegistryModule = require('../../registry/registry');
const RegistryCrawler = require('../../registry/crawler');

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
    expect(row).toContain('<td>2026-09-05</td><td>4 weeks</td>');
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
