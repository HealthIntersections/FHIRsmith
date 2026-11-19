# Security Notes for FHIRsmith

## Introduction 

FHIRsmith is a public ready web server. All the modules are considered safe 
to deploy on the public web, but with some caveats that administrators need
to pay attention to.

## Supported Versions 

At this time, only the latest version is supported for security updates. 

## Reporting Security Issues 

Use the standard GitHub security reporting framework.

## Rate Limiting 

Some modules make extensive use of the file system and/or SQLite databases. 
The server does not itself have any rate limiting arrangements; instead, it 
is expected that the server will be deployed behind NGINX (or similar), and 
that NGINX will be configured to provide rate limiting as appropriate.

A typical NGINX configuration would be:

```
  limit_req zone=general burst=6000 delay=20;
  limit_req_status 429;
  limit_conn perip 50;
  limit_conn perserver 500;
```
## SSL

This server doesn't provide SSL support - use an NGINX reverse proxy for that.


## Logins

There is one login system for the server ([library/auth](library/auth/README.md)): users log in
with a password (at least 15 characters, set only from an emailed one-time link, stored as a
bcrypt hash) or with GitHub, and software uses API tokens (stored as SHA-256 hashes, shown
once). No module has a login or a password of its own, and the configuration holds no
passwords for logging in - only the server's own credentials for other services (email, VSAC,
AI providers). Administrators are named in `auth.administrators` (email addresses, or
`github:{name}`), or given the role on the users page.

Set `auth.sessionSecret`, keep `auth.cookieSecure` on, and make sure the proxy passes `Host` and
`X-Forwarded-Proto` ([nginx.md](nginx.md#headers-to-pass-to-the-server)). Anyone can make an
account by logging in with GitHub; it can do nothing until an administrator gives it a role.
