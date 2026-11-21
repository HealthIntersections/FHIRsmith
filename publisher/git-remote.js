/**
 * Talking to a GitHub remote over anonymous HTTPS, for the publisher.
 *
 * The trap this exists for: GitHub answers a request for a repository that
 * doesn't exist exactly as it answers one for a private repository - with an
 * authentication challenge, so as not to leak which private repositories
 * exist. git responds to that by prompting for a username. The publisher runs
 * git with no terminal, so the prompt fails with
 *
 *   fatal: could not read Username for 'https://github.com': No such device or address
 *
 * which says nothing about the actual problem (almost always a mistyped org or
 * repo). And where git does have a terminal, it blocks waiting for input.
 *
 * So git is always run here with GIT_TERMINAL_PROMPT=0, which turns the prompt
 * into an immediate failure, and those failures are translated into something
 * a person can act on.
 */

const { spawn } = require('child_process');

const LS_REMOTE_TIMEOUT_MS = 20000;

/**
 * The environment to run git in: the caller's, but never prompting.
 */
function gitEnv(base = process.env) {
  return { ...base, GIT_TERMINAL_PROMPT: '0' };
}

function githubUrl(org, repo) {
  return 'https://github.com/' + org + '/' + repo + '.git';
}

/**
 * Does git's stderr say the repository wasn't there (or wasn't visible to us)?
 */
function isRepoNotFound(stderr) {
  return /terminal prompts disabled/i.test(stderr) ||
    /could not read Username/i.test(stderr) ||
    /Repository not found/i.test(stderr) ||
    /Authentication failed/i.test(stderr);
}

/**
 * Does git's stderr say the repository was there but the branch wasn't?
 * (`git clone --branch x` on a missing branch)
 */
function isBranchNotFound(stderr) {
  return /Remote branch .* not found/i.test(stderr);
}

/**
 * Turn a failed clone's stderr into a message a person can act on, or null if
 * it isn't one of the failures we recognise (the caller then reports the raw
 * git output).
 */
function explainCloneFailure(stderr, org, repo, branch) {
  if (isBranchNotFound(stderr)) {
    return 'Branch "' + branch + '" does not exist in https://github.com/' + org + '/' + repo;
  }
  if (isRepoNotFound(stderr)) {
    return 'Repository https://github.com/' + org + '/' + repo +
      ' was not found. Check the org and repo names - the publisher can only clone public repositories';
  }
  return null;
}

/**
 * Check that a public GitHub repository exists and has the given branch,
 * with `git ls-remote`.
 *
 * @returns {Promise<{ok: boolean, error?: string, unreachable?: boolean}>}
 *   ok: the repo and branch both exist.
 *   error: why not, when we know.
 *   unreachable: the check itself couldn't be made (network, timeout, git
 *     missing). The caller should not reject the task on that basis - the
 *     clone will fail later with a proper message if there really is a problem.
 */
function checkRemoteBranch(org, repo, branch, { timeoutMs = LS_REMOTE_TIMEOUT_MS, spawnFn = spawn } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(result);
      }
    };

    let proc;
    try {
      // '--' so a branch can never be taken as an option (validation already
      // refuses a leading hyphen, but this doesn't depend on that)
      proc = spawnFn('git', ['ls-remote', '--heads', githubUrl(org, repo), '--', 'refs/heads/' + branch], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: gitEnv()
      });
    } catch (e) {
      resolve({ ok: false, unreachable: true, error: 'Unable to run git: ' + e.message });
      return;
    }

    const timer = setTimeout(() => {
      try { proc.kill(); } catch (e) { /* already gone */ }
      finish({ ok: false, unreachable: true, error: 'Timed out checking https://github.com/' + org + '/' + repo });
    }, timeoutMs);

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('error', (e) => {
      finish({ ok: false, unreachable: true, error: 'Unable to run git: ' + e.message });
    });

    proc.on('close', (code) => {
      if (code === 0) {
        // ls-remote succeeds with no output when the repo exists but the ref doesn't
        const found = stdout.split('\n').some(line => line.trim().endsWith('\trefs/heads/' + branch));
        if (found) {
          finish({ ok: true });
        } else {
          finish({ ok: false, error: 'Branch "' + branch + '" does not exist in https://github.com/' + org + '/' + repo });
        }
      } else if (isRepoNotFound(stderr)) {
        finish({ ok: false, error: explainCloneFailure(stderr, org, repo, branch) });
      } else {
        finish({ ok: false, unreachable: true, error: 'Unable to check https://github.com/' + org + '/' + repo + ': ' + stderr.trim() });
      }
    });
  });
}

module.exports = {
  gitEnv,
  githubUrl,
  explainCloneFailure,
  checkRemoteBranch
};
