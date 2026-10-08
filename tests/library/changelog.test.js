// Release dates from CHANGELOG.md, and what FHIRsmith reports as its release date

const fs = require('fs');
const os = require('os');
const path = require('path');
const { readReleaseDates, releaseDateOf, reportedReleaseDate } = require('../../library/changelog');
const { MetadataHandler } = require('../../tx/workers/metadata');

function changelog(text) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-')), 'CHANGELOG.md');
  fs.writeFileSync(file, text);
  return file;
}

const TEXT = '# Changelog\n\n## [0.14.3] - \n\n## [0.14.2] - 2026-10-06\n\n### Added\n\n## [v0.13.4] - 2026-09-17\n\n## [v0.11.0] - 2026-mm-dd\n';

describe('changelog release dates', () => {
  test('dated headings, with or without a leading v', () => {
    const dates = readReleaseDates(changelog(TEXT));
    expect([...dates.entries()]).toEqual([['0.14.2', '2026-10-06'], ['0.13.4', '2026-09-17']]);
  });

  test('a version without a dated heading has no release date', () => {
    const file = changelog(TEXT);
    expect(releaseDateOf('0.14.2', file)).toBe('2026-10-06');
    expect(releaseDateOf('v0.13.4', file)).toBe('2026-09-17');
    expect(releaseDateOf('0.14.3', file)).toBeNull();
    expect(releaseDateOf('0.14.3-snapshot', file)).toBeNull();
    expect(releaseDateOf('0.11.0', file)).toBeNull();
    expect(releaseDateOf('0.14.2', '/no/such/CHANGELOG.md')).toBeNull();
  });

  test('the reported release date is the release, or for a snapshot when the server started', () => {
    const file = changelog(TEXT);
    const started = new Date('2026-10-08T01:02:03.000Z');
    expect(reportedReleaseDate('0.14.2', started, file)).toBe('2026-10-06');
    expect(reportedReleaseDate('0.14.3-snapshot', started, file)).toBe('2026-10-08T01:02:03.000Z');
  });

  test('the shipped CHANGELOG.md dates the shipped version, unless it is a snapshot', () => {
    const version = require('../../package.json').version;
    const date = releaseDateOf(version);
    if (version.includes('-')) {
      expect(date).toBeNull();
    } else {
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe('CapabilityStatement.software.releaseDate', () => {
  const endpoint = { path: '/r4', fhirVersion: '4.0' };

  test('is the configured release date', () => {
    const handler = new MetadataHandler({ serverVersion: '0.14.2', softwareName: 'FHIRsmith', releaseDate: '2026-10-06' });
    expect(handler.buildCapabilityStatement(endpoint, null, null).software)
      .toEqual({ name: 'FHIRsmith', version: '0.14.2', releaseDate: '2026-10-06' });
  });

  test('is left out when not known, rather than being the time of the request', () => {
    const handler = new MetadataHandler({ serverVersion: '0.14.3-snapshot', softwareName: 'FHIRsmith' });
    expect(handler.buildCapabilityStatement(endpoint, null, null).software)
      .toEqual({ name: 'FHIRsmith', version: '0.14.3-snapshot' });
  });
});
