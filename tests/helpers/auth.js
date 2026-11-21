// Logging in, in tests: the server's one login system (library/auth), in memory
const request = require('supertest');
const auth = require('../../library/auth');

const ADMIN_PASSWORD = 'admin-secret-password';
const quiet = { info() {}, warn() {}, error() {} };

/** A fresh, empty user database (the singleton is re-initialized) */
function setupAuth(config = {}) {
  auth.initialize({ database: ':memory:', cookieSecure: false, sessionSecret: 'test-session-secret', bcryptCost: 4, ...config }, { log: quiet, ...(config.options || {}) });
  return auth;
}

/** The /auth pages, on a test app; and, as in server.js, who is logged in for every page after it */
function mountAuth(app) {
  app.use(auth.pages);
  app.use('/auth', auth.router());
}

/**
 * A user (any password length: the 15 character rule is the pages')
 * @param {Array<Array<string>>} [options.roles] [module, role, scope]
 * @returns {Promise<number>} the id
 */
async function makeUser(login, password, { admin = false, roles = [], email = null, name } = {}) {
  const id = auth.store.createUser({ login, name: name || login, email });
  if (password) {
    await auth.store.setPassword(id, password);
  }
  if (admin) {
    auth.store.grant(id, auth.SERVER, auth.ADMINISTRATOR);
  }
  for (const [m, r, s] of roles) {
    auth.store.grant(id, m, r, s ?? '');
  }
  return id;
}

/** An API token for a user */
function tokenFor(userId) {
  return auth.store.issueToken(userId, { label: 'test' }).token;
}

/** The CSRF token of the agent's session, from a page that has one */
async function csrfOf(agent, url = '/auth/login') {
  const page = await agent.get(url);
  const m = page.text.match(/name="_csrf" value="([^"]+)"/);
  return m ? m[1] : null;
}

/** Log in on the app's /auth pages: {agent, res} */
async function login(app, loginName, password, agent = request.agent(app)) {
  const _csrf = await csrfOf(agent);
  const res = await agent.post('/auth/login').type('form').send({ login: loginName, password, _csrf });
  return { agent, res };
}

module.exports = { auth, ADMIN_PASSWORD, setupAuth, mountAuth, makeUser, tokenFor, csrfOf, login };
