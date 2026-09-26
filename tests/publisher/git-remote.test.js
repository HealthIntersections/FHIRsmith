const { EventEmitter } = require('events');
const { gitEnv, explainCloneFailure, checkRemoteBranch } = require('../../publisher/git-remote');

// A stand-in for child_process.spawn that plays back a canned git run
function fakeSpawn({ code = 0, stdout = '', stderr = '', error = null, hang = false }) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    if (!hang) {
      setImmediate(() => {
        if (error) {
          proc.emit('error', error);
          return;
        }
        if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
        if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
        proc.emit('close', code);
      });
    }
    return proc;
  };
  fn.calls = calls;
  return fn;
}

const NO_USERNAME = "fatal: could not read Username for 'https://github.com': No such device or address\n";
const PROMPTS_DISABLED = "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n";

describe('publisher git remote handling', () => {

  test('gitEnv disables the terminal prompt and keeps the rest', () => {
    const env = gitEnv({ PATH: '/bin', GIT_SSH_COMMAND: 'ssh -i key' });
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.PATH).toBe('/bin');
    expect(env.GIT_SSH_COMMAND).toBe('ssh -i key');
  });

  describe('explainCloneFailure', () => {
    test.each([NO_USERNAME, PROMPTS_DISABLED, 'remote: Repository not found.\n'])('reports a missing repo for %j', (stderr) => {
      const msg = explainCloneFailure(stderr, 'HL7', 'fhir-tx-ecosystem', 'main');
      expect(msg).toContain('https://github.com/HL7/fhir-tx-ecosystem was not found');
    });

    test('reports a missing branch', () => {
      const msg = explainCloneFailure('warning: Could not find remote branch mai to clone.\nfatal: Remote branch mai not found in upstream origin\n',
        'HL7', 'fhir-tx-ecosystem-ig', 'mai');
      expect(msg).toBe('Branch "mai" does not exist in https://github.com/HL7/fhir-tx-ecosystem-ig');
    });

    test('leaves anything else alone', () => {
      expect(explainCloneFailure('fatal: unable to access: Could not resolve host: github.com\n', 'a', 'b', 'c')).toBeNull();
    });
  });

  describe('checkRemoteBranch', () => {
    test('ok when the branch is listed', async () => {
      const spawnFn = fakeSpawn({ stdout: 'abc123\trefs/heads/main\n' });
      expect(await checkRemoteBranch('HL7', 'fhir-tx-ecosystem-ig', 'main', { spawnFn })).toEqual({ ok: true });
      const { cmd, args, opts } = spawnFn.calls[0];
      expect(cmd).toBe('git');
      expect(args).toEqual(['ls-remote', '--heads', 'https://github.com/HL7/fhir-tx-ecosystem-ig.git', '--', 'refs/heads/main']);
      expect(opts.env.GIT_TERMINAL_PROMPT).toBe('0');
    });

    test('branch missing when ls-remote succeeds with nothing', async () => {
      const r = await checkRemoteBranch('HL7', 'fhir-tx-ecosystem-ig', 'mai', { spawnFn: fakeSpawn({ stdout: '' }) });
      expect(r.ok).toBe(false);
      expect(r.unreachable).toBeUndefined();
      expect(r.error).toContain('Branch "mai" does not exist');
    });

    test('a longer ref that merely ends in the branch name does not count', async () => {
      const r = await checkRemoteBranch('o', 'r', 'main', { spawnFn: fakeSpawn({ stdout: 'abc\trefs/heads/feature/main\n' }) });
      expect(r.ok).toBe(false);
    });

    test('repo missing', async () => {
      const r = await checkRemoteBranch('HL7', 'fhir-tx-ecosystem', 'mai', { spawnFn: fakeSpawn({ code: 128, stderr: PROMPTS_DISABLED }) });
      expect(r.ok).toBe(false);
      expect(r.unreachable).toBeUndefined();
      expect(r.error).toContain('https://github.com/HL7/fhir-tx-ecosystem was not found');
    });

    test('network failure is unreachable, not a rejection', async () => {
      const r = await checkRemoteBranch('o', 'r', 'main', { spawnFn: fakeSpawn({ code: 128, stderr: 'fatal: unable to access: Could not resolve host: github.com\n' }) });
      expect(r.ok).toBe(false);
      expect(r.unreachable).toBe(true);
    });

    test('git missing is unreachable', async () => {
      const r = await checkRemoteBranch('o', 'r', 'main', { spawnFn: fakeSpawn({ error: new Error('spawn git ENOENT') }) });
      expect(r.unreachable).toBe(true);
    });

    test('timeout is unreachable', async () => {
      const r = await checkRemoteBranch('o', 'r', 'main', { spawnFn: fakeSpawn({ hang: true }), timeoutMs: 20 });
      expect(r.unreachable).toBe(true);
      expect(r.error).toContain('Timed out');
    });
  });
});
