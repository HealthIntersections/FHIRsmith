// library/auth: the server's one login system - see auth.js, and README.md for how modules use it.
// A singleton: server.js initializes it (auth.initialize(config.auth, ...)) before any module.

const { Auth, Principal, presentedToken, safeReturn, isLocalUrl, SERVER, ADMINISTRATOR, MIN_PASSWORD, INTERNAL_HEADER } = require('./auth');

const auth = new Auth();
auth.Auth = Auth;
auth.Principal = Principal;
auth.presentedToken = presentedToken;
auth.safeReturn = safeReturn;
auth.isLocalUrl = isLocalUrl;
auth.SERVER = SERVER;
auth.ADMINISTRATOR = ADMINISTRATOR;
auth.MIN_PASSWORD = MIN_PASSWORD;
auth.INTERNAL_HEADER = INTERNAL_HEADER;

module.exports = auth;
