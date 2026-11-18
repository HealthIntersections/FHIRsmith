/**
 * Validation for the fields a user types into the publication task form.
 *
 * None of these values can cause command injection - they're passed to spawn()
 * as argv, and nothing goes near a shell - but they do end up in git command
 * lines, in URLs, and in file names, so they're checked at the boundary rather
 * than trusted to be harmless everywhere they're later used.
 *
 * The rules are mostly the ones GitHub and git themselves enforce (see
 * git-check-ref-format(1) for the branch rules): anything rejected here would
 * have failed at clone time anyway, with a much worse error. The exception is
 * the markup characters in a branch name, which git permits and we do not - see
 * validateGitBranch.
 *
 * These checks are NOT the defence against markup in the pages that display
 * these values. Output escaping is, and it has to stay there whatever this file
 * allows; the branch rule below is a second line, not the first.
 */

// GitHub owner names: letters, digits and single hyphens, no hyphen at either
// end, 39 characters at most.
const MAX_OWNER = 39;
// Repository names: letters, digits, dot, hyphen, underscore, 100 at most.
const MAX_REPO = 100;
// git imposes no length limit on a ref, but a branch name past this is a
// filesystem problem waiting to happen.
const MAX_BRANCH = 255;
const MAX_PACKAGE_ID = 128;
const MAX_VERSION = 64;

/**
 * A GitHub organisation or user name.
 */
function validateGithubOwner(value) {
  if (!value) {
    return 'GitHub org is required';
  }
  if (value.length > MAX_OWNER) {
    return `GitHub org must be ${MAX_OWNER} characters or less`;
  }
  if (!/^[A-Za-z0-9](?:-?[A-Za-z0-9])*$/.test(value)) {
    return 'GitHub org may only contain letters, digits and single hyphens, and may not start or end with a hyphen';
  }
  return null;
}

/**
 * A GitHub repository name.
 */
function validateGithubRepo(value) {
  if (!value) {
    return 'GitHub repo is required';
  }
  if (value.length > MAX_REPO) {
    return `GitHub repo must be ${MAX_REPO} characters or less`;
  }
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    return 'GitHub repo may only contain letters, digits, dots, hyphens and underscores';
  }
  if (value === '.' || value === '..') {
    return 'GitHub repo is not a valid name';
  }
  // the code appends '.git' when it builds the clone URL, and GitHub won't
  // create a repository with that suffix anyway
  if (value.toLowerCase().endsWith('.git')) {
    return 'GitHub repo should not include the .git suffix';
  }
  return null;
}

/**
 * A branch name, by the rules in git-check-ref-format(1). Slashes are fine -
 * that's how branches are grouped - but the characters git reserves for
 * revision syntax are not. Note that git itself rejects a backslash in a ref
 * name, so this does too.
 */
function validateGitBranch(value) {
  if (!value) {
    return 'Branch is required';
  }
  if (value.length > MAX_BRANCH) {
    return `Branch must be ${MAX_BRANCH} characters or less`;
  }
  // space, the ASCII control characters, and DEL
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F ]/.test(value)) {
    return 'Branch may not contain spaces or control characters';
  }
  // the characters git reserves for revision syntax
  if (/[~^:?*[\\]/.test(value)) {
    return 'Branch may not contain any of ~ ^ : ? * [ \\';
  }
  // git itself allows these, but a branch name is displayed on the task pages, and a value that
  // has to be escaped everywhere it is shown is one escape away from being a stored XSS. Nobody
  // needs a branch called <script>, so refuse it at the boundary as well as escaping on output
  if (/[<>"'&]/.test(value)) {
    return 'Branch may not contain any of < > " \' &';
  }
  if (value.includes('..')) {
    return 'Branch may not contain ..';
  }
  if (value.includes('@{')) {
    return 'Branch may not contain @{';
  }
  if (value === '@') {
    return 'Branch may not be @';
  }
  if (value.startsWith('-')) {
    return 'Branch may not start with a hyphen';
  }
  if (value.startsWith('/') || value.endsWith('/') || value.includes('//')) {
    return 'Branch may not start or end with /, or contain //';
  }
  if (value.endsWith('.')) {
    return 'Branch may not end with .';
  }
  for (const part of value.split('/')) {
    if (part.startsWith('.')) {
      return 'No part of a branch name may start with .';
    }
    if (part.endsWith('.lock')) {
      return 'No part of a branch name may end with .lock';
    }
  }
  return null;
}

/**
 * An NPM package id. This one is not about git at all: the package id and the
 * version are concatenated into file names under the zips directory
 * (<id>#<version>.log, <id>#<version>-announcement.txt), so a value containing
 * a path separator would look outside that directory.
 */
function validatePackageId(value) {
  if (!value) {
    return 'NPM package id is required';
  }
  if (value.length > MAX_PACKAGE_ID) {
    return `NPM package id must be ${MAX_PACKAGE_ID} characters or less`;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    return 'NPM package id may only contain letters, digits, dots, hyphens and underscores, and must start with a letter or digit';
  }
  if (value.includes('..')) {
    return 'NPM package id may not contain ..';
  }
  return null;
}

/**
 * A package version. Loose enough for semver with pre-release and build
 * metadata, tight enough that it can't become a path.
 */
function validateVersion(value) {
  if (!value) {
    return 'Version is required';
  }
  if (value.length > MAX_VERSION) {
    return `Version must be ${MAX_VERSION} characters or less`;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(value)) {
    return 'Version may only contain letters, digits, dots, hyphens and plus signs, and must start with a letter or digit';
  }
  if (value.includes('..')) {
    return 'Version may not contain ..';
  }
  return null;
}

/**
 * Validate everything the task form collects.
 * @returns {string[]} the problems found, empty if the input is acceptable
 */
function validateTaskInput(input) {
  const errors = [];
  const checks = [
    validateGithubOwner(input.github_org),
    validateGithubRepo(input.github_repo),
    validateGitBranch(input.git_branch),
    validatePackageId(input.npm_package_id),
    validateVersion(input.version)
  ];
  for (const error of checks) {
    if (error) {
      errors.push(error);
    }
  }
  return errors;
}

// Patterns for the HTML form, so the browser objects before the round trip.
// Deliberately a subset of the checks above - the server is what decides -
// but they catch the obvious mistakes as the user types.
const HTML_PATTERNS = {
  github_org: '[A-Za-z0-9](-?[A-Za-z0-9])*',
  github_repo: '[A-Za-z0-9._-]+',
  git_branch: '[^\\\\ ~^:?*\\[<>"\'&]+',
  npm_package_id: '[A-Za-z0-9][A-Za-z0-9._-]*',
  version: '[A-Za-z0-9][A-Za-z0-9.+-]*'
};

module.exports = {
  validateGithubOwner,
  validateGithubRepo,
  validateGitBranch,
  validatePackageId,
  validateVersion,
  validateTaskInput,
  HTML_PATTERNS
};
