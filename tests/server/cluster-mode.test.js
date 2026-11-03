/**
 * cluster.js for real: two workers on one port, with modules that keep logins (testing,
 * publisher) and the tx resource cache configured with the memory store - none of
 * which it refuses any more. Every request goes on a new connection, so the workers
 * take turns; a login made through one is used through both.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const PORT = 19688;

function request(method, url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', d => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

describe('cluster mode', () => {
  let dir;
  let proc;
  let output = '';

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-mode-'));
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      server: { port: PORT, cluster: { workers: 2 } },
      stats: { enabled: false },
      npmAudit: { enabled: false },
      logging: { console: { level: 'info' }, file: { level: 'warn' } },
      modules: {
        testing: { enabled: true, adminPassword: 'admin-secret', cookieSecure: false },
        publisher: { enabled: true, cookieSecure: false, database: 'publisher.db', workspaceRoot: path.join(dir, 'ws') }
      }
    }));
    proc = spawn(process.execPath, ['--require', path.join(__dirname, '..', 'utils', 'served-by.js'), 'cluster.js'], {
      cwd: ROOT, env: { ...process.env, FHIRSMITH_DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe']
    });
    proc.stdout.on('data', d => { output += d; });
    proc.stderr.on('data', d => { output += d; });
    await new Promise((resolve, reject) => {
      const t = setInterval(() => {
        if ((output.match(/listening after/g) || []).length >= 2) {
          clearInterval(t);
          resolve();
        } else if (proc.exitCode !== null) {
          clearInterval(t);
          reject(new Error('cluster.js exited:\n' + output));
        }
      }, 100);
    });
  }, 60000);

  afterAll(async () => {
    if (proc && proc.exitCode === null) {
      await new Promise(resolve => {
        proc.once('exit', resolve);
        proc.kill('SIGTERM');
      });
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('starts both workers; nothing is refused', () => {
    expect(output).not.toMatch(/can't run in more than one worker/);
    expect(output).toMatch(/worker 2 \(pid \d+\) listening/);
  });

  test('a login made through one worker is used through both', async () => {
    const base = `http://127.0.0.1:${PORT}/testing`;
    let cookie = '';
    const keep = (res) => {
      const set = res.headers['set-cookie'];
      if (set) {
        cookie = set.map(c => c.split(';')[0]).join('; ');
      }
      return res;
    };
    const page = keep(await request('GET', `${base}/login`));
    const csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
    const login = keep(await request('POST', `${base}/login`, {
      headers: { cookie, origin: `http://127.0.0.1:${PORT}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ login: 'admin', password: 'admin-secret', _csrf: csrf }).toString()
    }));
    expect(login.status).toBe(302);
    const servedBy = new Set([page.headers['x-served-by'], login.headers['x-served-by']]);
    for (let i = 0; i < 6; i++) {
      const res = await request('GET', `${base}/admin/users`, { headers: { cookie } });
      expect(res.status).toBe(200);
      servedBy.add(res.headers['x-served-by']);
    }
    expect(servedBy.size).toBe(2);
  });
});
