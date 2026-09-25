const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const githubRelease = require('../../publisher/github-release');

// A real key pair, so the JWT test verifies a signature rather than a shape.
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' }
});

function decodeSegment(segment) {
  return JSON.parse(Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
}

describe('github release configuration', () => {
  const complete = {
    'app-id': '123',
    'private-key': '/tmp/key.pem',
    installations: { HL7: 1, FHIR: 2 }
  };

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', {}],
    ['no app id', { 'private-key': '/tmp/k.pem', installations: {} }],
    ['no private key', { 'app-id': '1', installations: {} }],
    ['no installations', { 'app-id': '1', 'private-key': '/tmp/k.pem' }]
  ])('is not configured when %s', (_label, cfg) => {
    expect(githubRelease.isConfigured(cfg)).toBe(false);
  });

  test('is configured when app id, key and installations are all present', () => {
    expect(githubRelease.isConfigured(complete)).toBe(true);
  });

  // github_org comes off the task form in whatever case the requester typed, and GitHub org
  // names are not case sensitive, so config should not have to match the typing.
  test.each(['HL7', 'hl7', 'Hl7'])('finds the installation for %s', (org) => {
    expect(githubRelease.installationIdFor(complete, org)).toBe(1);
  });

  test('returns null for an organisation with no installation', () => {
    expect(githubRelease.installationIdFor(complete, 'somebody-else')).toBeNull();
  });
});

describe('github app jwt', () => {
  test('is signed by the app key and carries the app id', () => {
    const now = 1_000_000;
    const jwt = githubRelease.appJwt('55555', privateKey, now);
    const [header, payload, signature] = jwt.split('.');

    expect(decodeSegment(header)).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(decodeSegment(payload).iss).toBe('55555');

    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(header + '.' + payload);
    verifier.end();
    const raw = Buffer.from(signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    expect(verifier.verify(publicKey, raw)).toBe(true);
  });

  // GitHub rejects a JWT whose exp is more than 10 minutes out, and backdating iat absorbs
  // clock skew between here and github.com.
  test('backdates iat and expires inside GitHub\'s ten minute ceiling', () => {
    const now = 1_000_000;
    const claims = decodeSegment(githubRelease.appJwt('1', privateKey, now).split('.')[1]);
    expect(claims.iat).toBeLessThan(now);
    expect(claims.exp).toBeGreaterThan(now);
    expect(claims.exp - claims.iat).toBeLessThan(600);
  });
});

describe('publishing a release', () => {
  let tmp;
  let zipPath;
  let keyPath;
  let config;
  let http;
  let calls;
  let logged;

  // no tag, no release: the ordinary first publication of a version
  function freshRepo() {
    return {
      get: jest.fn(async (url) => {
        calls.push(['GET', url]);
        return { status: 404, data: {} };
      }),
      post: jest.fn(async (url, body) => {
        calls.push(['POST', url]);
        if (url.endsWith('/access_tokens')) {
          return { status: 201, data: { token: 'ghs_installationtoken' } };
        }
        if (url.endsWith('/git/refs')) {
          return { status: 201, data: { ref: body.ref } };
        }
        if (url.endsWith('/releases')) {
          return {
            status: 201,
            data: {
              id: 99,
              html_url: 'https://github.com/HL7/some-ig/releases/tag/v1.2.3',
              upload_url: 'https://uploads.github.com/repos/HL7/some-ig/releases/99/assets{?name,label}'
            }
          };
        }
        return { status: 201, data: {} };
      }),
      delete: jest.fn(async (url) => {
        calls.push(['DELETE', url]);
        return { status: 204, data: {} };
      })
    };
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fhirsmith-release-'));
    zipPath = path.join(tmp, 'hl7.fhir.us.example-1.2.3-source.zip');
    fs.writeFileSync(zipPath, Buffer.from('PK not really a zip'));
    keyPath = path.join(tmp, 'key.pem');
    fs.writeFileSync(keyPath, privateKey);

    config = { 'app-id': '123', 'private-key': keyPath, installations: { HL7: 4242 } };
    calls = [];
    logged = [];
    http = freshRepo();
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function run(extra) {
    return githubRelease.publishRelease(Object.assign({
      config: config,
      org: 'HL7',
      repo: 'some-ig',
      tag: 'v1.2.3',
      sha: 'a'.repeat(40),
      releaseName: 'hl7.fhir.us.example#1.2.3',
      body: 'the announcement text',
      zipPath: zipPath,
      assetName: 'hl7.fhir.us.example-1.2.3-source.zip',
      http: http,
      log: (level, message) => logged.push({ level, message })
    }, extra || {}));
  }

  test('mints a token for the right installation, tags, releases and uploads', async () => {
    const result = await run();

    expect(calls).toContainEqual(['POST', 'https://api.github.com/app/installations/4242/access_tokens']);
    expect(calls).toContainEqual(['POST', 'https://api.github.com/repos/HL7/some-ig/git/refs']);
    expect(calls).toContainEqual(['POST', 'https://api.github.com/repos/HL7/some-ig/releases']);
    expect(result.tagCreated).toBe(true);
    expect(result.releaseReplaced).toBe(false);
    expect(result.url).toBe('https://github.com/HL7/some-ig/releases/tag/v1.2.3');
  });

  test('sends the tag and the announcement body to GitHub', async () => {
    await run();
    const ref = http.post.mock.calls.find(([url]) => url.endsWith('/git/refs'));
    expect(ref[1]).toEqual({ ref: 'refs/tags/v1.2.3', sha: 'a'.repeat(40) });

    const release = http.post.mock.calls.find(([url]) => url.endsWith('/releases'));
    expect(release[1].tag_name).toBe('v1.2.3');
    expect(release[1].name).toBe('hl7.fhir.us.example#1.2.3');
    expect(release[1].body).toBe('the announcement text');
    expect(release[1].draft).toBe(false);
  });

  // upload_url arrives as an RFC 6570 template; posting to it verbatim uploads nothing
  test('strips the upload url template and names the asset', async () => {
    await run();
    const upload = http.post.mock.calls.find(([url]) => url.startsWith('https://uploads.github.com'));
    expect(upload[0]).toBe('https://uploads.github.com/repos/HL7/some-ig/releases/99/assets' +
        '?name=hl7.fhir.us.example-1.2.3-source.zip');
    expect(upload[1]).toEqual(fs.readFileSync(zipPath));
    expect(upload[2].headers['Content-Type']).toBe('application/zip');
  });

  test('sends the installation token, not the app jwt, on the repository calls', async () => {
    await run();
    const release = http.post.mock.calls.find(([url]) => url.endsWith('/releases'));
    expect(release[2].headers.Authorization).toBe('Bearer ghs_installationtoken');
  });

  describe('when the version has been published before', () => {
    // the tag is a public ref others may have resolved, so a re-publication leaves it alone
    test('leaves an existing tag in place rather than creating it again', async () => {
      http.get = jest.fn(async (url) => {
        calls.push(['GET', url]);
        if (url.includes('/git/ref/')) {
          return { status: 200, data: { object: { sha: 'a'.repeat(40) } } };
        }
        return { status: 404, data: {} };
      });

      const result = await run();
      expect(result.tagCreated).toBe(false);
      expect(calls).not.toContainEqual(['POST', 'https://api.github.com/repos/HL7/some-ig/git/refs']);
    });

    // silently attaching a release to a commit that is not the one published is the failure
    // nobody notices, so it has to be said out loud
    test('warns when the existing tag points somewhere other than what was published', async () => {
      http.get = jest.fn(async (url) => {
        if (url.includes('/git/ref/')) {
          return { status: 200, data: { object: { sha: 'b'.repeat(40) } } };
        }
        return { status: 404, data: {} };
      });

      await run();
      const warning = logged.find((entry) => entry.level === 'warn');
      expect(warning).toBeDefined();
      expect(warning.message).toContain('bbbbbbbb');
    });

    test('deletes the old release so the current zip is what is attached', async () => {
      http.get = jest.fn(async (url) => {
        calls.push(['GET', url]);
        if (url.includes('/releases/tags/')) {
          return { status: 200, data: { id: 77 } };
        }
        return { status: 404, data: {} };
      });

      const result = await run();
      expect(calls).toContainEqual(['DELETE', 'https://api.github.com/repos/HL7/some-ig/releases/77']);
      expect(result.releaseReplaced).toBe(true);
      expect(calls).toContainEqual(['POST', 'https://api.github.com/repos/HL7/some-ig/releases']);
    });
  });

  test('refuses an organisation with no installation configured', async () => {
    await expect(run({ org: 'not-ours' })).rejects.toThrow(/No GitHub App installation/);
    expect(http.post).not.toHaveBeenCalled();
  });

  test('refuses to publish when the zip was never built', async () => {
    await expect(run({ zipPath: path.join(tmp, 'absent.zip') })).rejects.toThrow(/Source zip not found/);
    expect(http.post).not.toHaveBeenCalled();
  });

  test('refuses to publish with no app configured', async () => {
    await expect(run({ config: {} })).rejects.toThrow(/not configured/);
  });
});
