To generate a certificate:

```shell
# Generate EC P-256 private key
openssl ecparam -name prime256v1 -genkey -noout -out private-key.pem

# Extract the public key / self-signed cert
openssl req -new -x509 -key private-key.pem -out public-key.pem -days 3650 \
  -subj "/CN=fhirsmith-shl"
  
node -e "
const crypto = require('crypto');
const fs = require('fs');
const key = crypto.createPrivateKey(fs.readFileSync('private-key.pem'));
const jwk = key.export({format:'jwk'});
const thumbprint = crypto.createHash('sha256')
  .update(JSON.stringify({crv:jwk.crv,kty:jwk.kty,x:jwk.x,y:jwk.y}))
  .digest('base64url');
console.log('kid: '+thumbprint);
"

```

Config: 

All files will be in {data}/shl. the file paths in the config are relative to 
that location
## Who can use it

Reading a link - `/shl/access/{uuid}` and `/shl/file/{id}` - is open: that is what the link's
recipients do, with no account. Everything else - `POST /shl/create`, `/shl/upload`, `/shl/sign`,
`/shl/validate` and `GET /shl/validate/status` - is for users of the server with the shl
"create" role, sending an API token (`Authorization: Bearer {token}` - see
[library/auth](../library/auth/README.md)), and for the ips module of this server (an in-process
call, as the server itself). The old shared `modules.shl.password` is no longer used, and a
`password` in the request body is ignored. Uploading to a link (`/shl/upload`) also needs the
link's own `pword`, which `/create` returns.

With `"users": "any"` in `modules.shl`, any logged in account may do these too, not only the
"create" role: anyone who logs in with GitHub or Google, say, so a public demo page works. A page
on this site calls them with the login's session (its `fetch` sends the cookie); it can ask
`GET /auth/me` whether someone is logged in, and send them to the login page if not (see
[library/auth](../library/auth/README.md)). Each link records who made it in the log.

## Loading IGs into the validator

`POST /shl/validate/loadig` (`{ "packageId", "version" }`) downloads a package and loads it into
the validator, where it stays. It is for users with the shl "load-ig" role, sending an API token,
and the server's administrators.
