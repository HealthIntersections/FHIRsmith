/**
 * The publisher's administrator (PublisherModule.ensureAdmin): the password is the config's
 * adminPassword, set at every start; without one, a random password (logged), never a fixed one
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcrypt');
const PublisherModule = require('../../publisher/publisher');

function fakeLog() {
  const lines = [];
  const add = level => (msg) => lines.push(`${level}: ${msg}`);
  return { lines, info: add('info'), warn: add('warn'), error: add('error'), debug: add('debug') };
}

describe('publisher administrator password', () => {
  let dir;
  let dbFile;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publisher-admin-'));
    dbFile = path.join(dir, 'publisher.db');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function start(config) {
    const m = new PublisherModule({ addTask() {}, countRequest() {} });
    m.config = { database: dbFile, ...config };
    m.logger = fakeLog();
    await m.initializeDatabase();
    const admin = await new Promise((resolve, reject) =>
      m.db.get("SELECT password_hash, is_admin FROM users WHERE login = 'admin'", (err, row) => err ? reject(err) : resolve(row)));
    await new Promise(resolve => m.db.close(resolve));
    return { admin, log: m.logger.lines };
  }
  const logged = (log) => /password(?: \(admin123\))?(?:;| is now|:) (?:it is now )?([0-9a-f-]{36})/.exec(log.join('\n'))[1];

  test('no adminPassword: a random password, logged, and kept on the next start', async () => {
    const first = await start({});
    const password = logged(first.log);
    expect(await bcrypt.compare(password, first.admin.password_hash)).toBe(true);
    expect(await bcrypt.compare('admin123', first.admin.password_hash)).toBe(false);
    expect(first.admin.is_admin).toBe(1);

    const second = await start({});
    expect(second.admin.password_hash).toBe(first.admin.password_hash);
    expect(second.log.some(l => l.includes('password'))).toBe(false);
  });

  test('adminPassword: set, and changed when the config changes', async () => {
    const first = await start({ adminPassword: 'first secret' });
    expect(await bcrypt.compare('first secret', first.admin.password_hash)).toBe(true);
    expect(first.log.join('\n')).not.toContain('first secret');

    const same = await start({ adminPassword: 'first secret' });
    expect(same.admin.password_hash).toBe(first.admin.password_hash);

    const changed = await start({ adminPassword: 'second secret' });
    expect(await bcrypt.compare('second secret', changed.admin.password_hash)).toBe(true);
    expect(changed.log).toContain("info: Administrator 'admin': password changed to the configured adminPassword");
  });

  test('an administrator still on the old default password (admin123) gets a random one', async () => {
    await start({ adminPassword: 'admin123' });
    const upgraded = await start({});
    const password = logged(upgraded.log);
    expect(await bcrypt.compare(password, upgraded.admin.password_hash)).toBe(true);
    expect(upgraded.log.join('\n')).toContain('had the old default password (admin123)');
  });
});
