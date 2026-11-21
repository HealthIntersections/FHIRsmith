// library/auth/cli.js
// node server.js --password-link {login or email}: print a one-time link that sets the account's
// password, and exit. For when there is no email, or the administrator can't log in: whoever
// can run this on the server is the operator. A configured administrator's account is made if
// it isn't there yet.

const PASSWORD_LINK = '--password-link';

function wantsPasswordLink(args) {
  return args.some(a => a === PASSWORD_LINK || a.startsWith(PASSWORD_LINK + '='));
}

/**
 * @param {string[]} args the command line
 * @param {object} config the whole config.json
 * @param {object} options
 * @param {string} options.databasesDir
 * @returns {number} the exit code
 */
function runPasswordLink(args, config, { databasesDir }) {
  let who = null;
  const i = args.findIndex(a => a === PASSWORD_LINK || a.startsWith(PASSWORD_LINK + '='));
  if (args[i].includes('=')) {
    who = args[i].substring(PASSWORD_LINK.length + 1);
  } else {
    who = args[i + 1];
  }
  if (!who || who.startsWith('-')) {
    console.error(`Usage: node server.js ${PASSWORD_LINK} {login or email}`);
    return 2;
  }
  const { Auth } = require('./auth');
  const auth = new Auth();
  const quiet = { info() {}, warn() {}, error: m => console.error(m) };
  auth.initialize(config.auth || {}, { log: quiet, hostName: config.hostName, databasesDir });
  try {
    const user = auth.store.userByLoginOrEmail(who);
    if (!user) {
      console.error(`There is no account '${who}'. A configured administrator (auth.administrators) has one made as the server starts.`);
      return 1;
    }
    if (!user.enabled) {
      console.error(`The account '${user.login}' is disabled.`);
      return 1;
    }
    const link = auth.passwordLink(user.id, null);
    if (!link) {
      console.error('There is no public URL to make the link from: set auth.publicUrl (or hostName) in config.json.');
      return 1;
    }
    console.log(`Set the password of ${user.login}${user.email ? ` (${user.email})` : ''} here, within ${auth.linkMinutes} minutes:\n\n${link}\n`);
    return 0;
  } finally {
    auth.shutdown();
  }
}

module.exports = { wantsPasswordLink, runPasswordLink, PASSWORD_LINK };
