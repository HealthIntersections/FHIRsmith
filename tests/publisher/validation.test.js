const {
  validateGithubOwner,
  validateGithubRepo,
  validateGitBranch,
  validatePackageId,
  validateVersion,
  validateTaskInput,
  HTML_PATTERNS
} = require('../../publisher/validation');

describe('publication task input validation', () => {

  describe('github org', () => {
    test.each(['hl7', 'HL7', 'fhir-org', 'a', 'a1', 'x'.repeat(39)])('accepts %s', (value) => {
      expect(validateGithubOwner(value)).toBeNull();
    });

    test.each([
      ['', 'empty'],
      ['-hl7', 'leading hyphen'],
      ['hl7-', 'trailing hyphen'],
      ['hl7--org', 'double hyphen'],
      ['hl7/other', 'slash'],
      ['hl7.org', 'dot'],
      ['hl7 org', 'space'],
      ['hl7;whoami', 'semicolon'],
      ['x'.repeat(40), 'too long']
    ])('rejects %s (%s)', (value) => {
      expect(validateGithubOwner(value)).not.toBeNull();
    });
  });

  describe('github repo', () => {
    test.each(['fhir-us-core', 'ig.registry', 'my_repo', 'a', 'x'.repeat(100)])('accepts %s', (value) => {
      expect(validateGithubRepo(value)).toBeNull();
    });

    test.each([
      ['', 'empty'],
      ['.', 'dot'],
      ['..', 'parent'],
      ['a/b', 'slash'],
      ['a b', 'space'],
      ['a;b', 'semicolon'],
      ['$(whoami)', 'command substitution'],
      ['a|b', 'pipe'],
      ['repo.git', '.git suffix'],
      ['x'.repeat(101), 'too long']
    ])('rejects %s (%s)', (value) => {
      expect(validateGithubRepo(value)).not.toBeNull();
    });
  });

  describe('git branch', () => {
    // slashes group branches, so they have to keep working
    test.each([
      'main',
      'master',
      'release/6.0.0',
      'feature/JIRA-123_thing',
      '2026-08-gg-tx-fixes',
      'v1.0.0',
      'a/b/c/d'
    ])('accepts %s', (value) => {
      expect(validateGitBranch(value)).toBeNull();
    });

    // every one of these is rejected by git check-ref-format too
    test.each([
      ['', 'empty'],
      ['has space', 'space'],
      ['tilde~1', 'tilde'],
      ['caret^1', 'caret'],
      ['colon:name', 'colon'],
      ['question?', 'question mark'],
      ['star*', 'asterisk'],
      ['bracket[', 'open bracket'],
      ['back\\slash', 'backslash'],
      ['a..b', 'double dot'],
      ['main@{0}', 'reflog syntax'],
      ['@', 'bare at'],
      ['-lead', 'leading hyphen'],
      ['/lead', 'leading slash'],
      ['trail/', 'trailing slash'],
      ['a//b', 'double slash'],
      ['.hidden', 'leading dot'],
      ['a/.hidden', 'component with leading dot'],
      ['ends.', 'trailing dot'],
      ['a/b.lock', 'lock suffix'],
      ['bell\u0007', 'control character'],
      ['x'.repeat(256), 'too long']
    ])('rejects %s (%s)', (value) => {
      expect(validateGitBranch(value)).not.toBeNull();
    });

    // git allows these, we don't: a branch name is shown on the task pages, and none of these
    // has any business being in one. Output escaping is still what makes those pages safe -
    // this is the second line, not the first
    test.each([
      ['<script>alert(1)</script>', 'markup'],
      ['a"onmouseover="alert(1)', 'double quote'],
      ["a'b", 'single quote'],
      ['a>b', 'greater than'],
      ['x&y', 'ampersand']
    ])('rejects %s (%s)', (value) => {
      expect(validateGitBranch(value)).not.toBeNull();
    });
  });

  describe('package id and version', () => {
    test.each(['hl7.fhir.us.core', 'hl7.fhir.r4.core', 'my_package-1'])('accepts package id %s', (value) => {
      expect(validatePackageId(value)).toBeNull();
    });

    // these are the ones that matter: the id and version are concatenated into
    // file names under the zips directory
    test.each(['../../etc/passwd', 'a/b', 'a..b', '.hidden', 'a b', ''])('rejects package id %s', (value) => {
      expect(validatePackageId(value)).not.toBeNull();
    });

    test.each(['6.0.0', '1.0.0-ballot', '2.1.0-snapshot.3', '1.0.0+build7'])('accepts version %s', (value) => {
      expect(validateVersion(value)).toBeNull();
    });

    test.each(['../6.0.0', '6/0/0', '6..0', '6 0', ''])('rejects version %s', (value) => {
      expect(validateVersion(value)).not.toBeNull();
    });
  });

  describe('the form as a whole', () => {
    const good = {
      github_org: 'hl7',
      github_repo: 'fhir-us-core',
      git_branch: 'release/6.0.0',
      npm_package_id: 'hl7.fhir.us.core',
      version: '6.0.0'
    };

    test('accepts a realistic task', () => {
      expect(validateTaskInput(good)).toEqual([]);
    });

    test('reports every bad field, not just the first', () => {
      expect(validateTaskInput({
        github_org: '-bad-',
        github_repo: 'a;b',
        git_branch: 'x..y',
        npm_package_id: '../../etc/passwd',
        version: '1.0;0'
      })).toHaveLength(5);
    });

    test('rejects missing fields', () => {
      expect(validateTaskInput({})).toHaveLength(5);
    });
  });

  describe('html patterns', () => {
    // the browser-side patterns must not reject anything the server accepts,
    // or the form becomes impossible to submit
    test.each([
      ['github_org', 'hl7'],
      ['github_repo', 'fhir-us-core'],
      ['git_branch', 'release/6.0.0'],
      ['npm_package_id', 'hl7.fhir.us.core'],
      ['version', '6.0.0-ballot+1']
    ])('%s pattern accepts %s', (field, value) => {
      expect(new RegExp('^(?:' + HTML_PATTERNS[field] + ')$').test(value)).toBe(true);
    });

    test('the branch pattern still catches the obvious ones', () => {
      const re = new RegExp('^(?:' + HTML_PATTERNS.git_branch + ')$');
      for (const bad of ['has space', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'back\\slash']) {
        expect(re.test(bad)).toBe(false);
      }
    });
  });
});
