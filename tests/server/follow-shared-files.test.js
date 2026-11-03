/**
 * Background jobs whose results the other cluster-mode workers read from a file: the
 * registry crawl (registry-data.json) and the package crawler's status
 * (packages/crawler-status.json). The process that runs the job writes the file whole
 * and renames it into place; the others look (one stat, at most once a second) when a
 * request reaches them, and read it only when it has changed. Two module instances on
 * one file stand in for two workers.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const backgroundJobs = require('../../library/background-jobs');
const RegistryModule = require('../../registry/registry');
const PackagesModule = require('../../packages/packages');

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'follow-'));
  backgroundJobs.configure({ enabled: true, path: path.join(dir, 'background-jobs.lock') });
});
afterEach(() => {
  backgroundJobs.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('registry crawl data', () => {
  const reader = (file) => {
    const r = Object.create(RegistryModule.prototype);
    r.dataFile = () => file;
    r.logger = quiet;
    r.loads = 0;
    r.loadSavedData = async function () {
      this.loads++;
      this.loadedDataVersion = await RegistryModule.fileVersion(file);
    };
    return r;
  };
  const settle = (r) => r.followLoading || Promise.resolve();

  test('loaded once when another process saves a crawl, not otherwise', async () => {
    const file = path.join(dir, 'registry-data.json');
    await RegistryModule.writeAtomically(file, '{"v":1}');
    const r = reader(file);
    await r.loadSavedData();
    expect(r.loads).toBe(1);

    r.followSavedData();
    await settle(r);
    expect(r.loads).toBe(1); // unchanged: no reload

    await RegistryModule.writeAtomically(file, '{"v":2}');
    r.followSavedData(); // within the second: doesn't look
    await settle(r);
    expect(r.loads).toBe(1);
    await sleep(1050);
    r.followSavedData();
    await settle(r);
    expect(r.loads).toBe(2);
  });

  test('with one process (no lock) nothing is looked at', async () => {
    backgroundJobs.close();
    const file = path.join(dir, 'registry-data.json');
    await RegistryModule.writeAtomically(file, '{}');
    const r = reader(file);
    r.followSavedData();
    await settle(r);
    expect(r.loads).toBe(0);
  });
});

describe('package crawler status', () => {
  const make = () => {
    const m = new PackagesModule({ addTask() {}, task() {}, countRequest() {} });
    m.crawlerStatusFile = () => path.join(dir, 'crawler-status.json');
    return m;
  };

  test('the other process shows the run in progress, then its result', async () => {
    const runner = make();
    const other = make();
    let seenWhileRunning = null;
    runner.crawler = {
      crawl: async () => {
        await other.followCrawlerStatus(true);
        seenWhileRunning = { running: other.crawlerRunning, runs: other.totalRuns };
        return { feeds: [{ url: 'http://example.org/feed', items: [1, 2] }] };
      }
    };
    await runner.runCrawler();
    expect(seenWhileRunning).toEqual({ running: true, runs: 1 });

    await other.followCrawlerStatus(true);
    expect(other.crawlerRunning).toBe(false);
    expect(other.totalRuns).toBe(1);
    expect(other.lastRunTime).toBe(runner.lastRunTime);
    expect(other.lastCrawlerLog.feeds).toHaveLength(1);

    // the next run, from whichever process holds the lock then, counts on from 1
    other.crawler = { crawl: async () => ({ feeds: [] }) };
    await other.runCrawler();
    await runner.followCrawlerStatus(true);
    expect(runner.totalRuns).toBe(2);
  });
});
