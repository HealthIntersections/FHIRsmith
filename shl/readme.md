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
## Who can create links

`POST /shl/create` is for users of the server with the shl "create" role, sending an API token
(`Authorization: Bearer {token}` - see [library/auth](../library/auth/README.md)), and for the ips
module of this server (an in-process call, as the server itself). The old shared
`modules.shl.password` is no longer used, and a `password` in the request body is ignored.
Uploading to a link (`/shl/upload`) still needs the link's own `pword`, which `/create` returns.
