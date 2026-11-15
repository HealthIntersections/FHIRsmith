//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

const crypto = require('crypto');
const zlib = require('zlib');
const CBOR = require('cbor');
const pako = require('pako');
const base45 = require('base45');
const jose = require('jose');
const { Trace, linkOf, decodePayload, decodeVhl, decryptJwe, examine, loadTrust } = require('../../ips/viewer');

const KEY = crypto.randomBytes(32).toString('base64url');
const payloadText = (p) => Buffer.from(JSON.stringify(p), 'utf8').toString('base64url');
const texts = (trace) => trace.entries.map(e => `${e.level}: ${e.text}`);

/** A VHL, signed as the shl module signs them (COSE_Sign1, ES256), with the claims given. */
function vhl(claims, privateKey, kid) {
  const prot = CBOR.encode(new Map([[1, -7], [4, kid]]));
  const payload = CBOR.encode(claims);
  const signature = crypto.sign('sha256', CBOR.encode(['Signature1', prot, Buffer.alloc(0), payload]), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  const cose = CBOR.encode(new CBOR.Tagged(18, [prot, new Map(), payload, signature]));
  return 'HC1:' + base45.encode(Buffer.from(pako.deflate(cose)));
}

describe('the SHL viewer, piece by piece', () => {
  test('finds the link in what it is given', () => {
    expect(linkOf('https://example.org/ips/view#shlink:/abc')).toEqual({ kind: 'shl', viewer: 'https://example.org/ips/view#', payload: 'abc' });
    expect(linkOf('  shlink:/abc ')).toEqual({ kind: 'shl', viewer: null, payload: 'abc' });
    expect(linkOf('shlink://abc').payload).toBe('abc');
    expect(linkOf('HC1:6BF')).toEqual({ kind: 'vhl', text: 'HC1:6BF' });
    expect(linkOf('hello')).toBeNull();
  });

  test('decodes and checks the payload, and logs it, key and all', () => {
    const trace = new Trace();
    const p = decodePayload(payloadText({ url: 'https://shl.example.org/m/1', key: KEY, flag: 'LP', label: 'Jane', exp: 4102444800 }), trace);
    expect(p.label).toBe('Jane');
    expect(trace.entries[0]).toMatchObject({ level: 'ok', text: 'Decoded the payload' });
    expect(trace.entries[0].detail).toContain(KEY);
    expect(texts(trace)).toContain(`info: The key: ${KEY}`);
    expect(texts(trace)).toContain('info: Flags: L (long term), P (needs a passcode)');
    expect(texts(trace)).toContain('info: The link expires at 2100-01-01T00:00:00.000Z');

    const bad = (payload, message, options) => {
      const t = new Trace();
      expect(() => decodePayload(typeof payload === 'string' ? payload : payloadText(payload), t, options)).toThrow(message);
      expect(t.entries[t.entries.length - 1].level).toBe('error');
    };
    bad('', /nothing after shlink/);
    bad('not base64!', /not base64url/);
    bad(Buffer.from('nope').toString('base64url'), /not JSON/);
    bad({ key: KEY }, /no url/);
    bad({ url: 'http://shl.example.org/m', key: KEY }, /must be https/);
    bad({ url: 'https://shl.example.org/m', key: 'short' }, /must be 32 bytes/);
    // http, for a local test server, when allowed
    const t = new Trace();
    decodePayload(payloadText({ url: 'http://127.0.0.1:3000/m', key: KEY }), t, { allowHttp: true });
    expect(texts(t).some(x => /^warning: The url is http/.test(x))).toBe(true);

    const odd = new Trace();
    decodePayload(payloadText({ url: 'https://shl.example.org/m', key: KEY, flag: 'UPX', exp: 1, label: 'x'.repeat(81), v: 2 }), odd);
    expect(texts(odd)).toEqual(expect.arrayContaining([
      'warning: The link expired at 1970-01-01T00:00:01.000Z (going on anyway: the server decides)',
      'warning: Unknown flag: X (the flags are L, P and U)',
      'warning: U and P cannot be used together (the SHL specification says so): taking it as a P link',
      'warning: label should be at most 80 characters: it is 81',
      'warning: v (the version) is 2: this viewer knows version 1'
    ]));
  });

  test('decrypts a JWE, compressed or not, and says why when it cannot', async () => {
    const content = JSON.stringify({ resourceType: 'Bundle', type: 'document' });
    const jwe = await new jose.CompactEncrypt(new TextEncoder().encode(content))
      .setProtectedHeader({ alg: 'dir', enc: 'A256GCM', cty: 'application/fhir+json' }).encrypt(Buffer.from(KEY, 'base64url'));
    const trace = new Trace();
    expect(decryptJwe(jwe, KEY, trace)).toEqual({ text: content, header: { alg: 'dir', enc: 'A256GCM', cty: 'application/fhir+json' } });
    expect(texts(trace)).toContain(`ok: Decrypted: ${content.length} bytes`);

    // zip DEF: compressed before it was encrypted
    const header = Buffer.from(JSON.stringify({ alg: 'dir', enc: 'A256GCM', zip: 'DEF' })).toString('base64url');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(KEY, 'base64url'), iv);
    cipher.setAAD(Buffer.from(header, 'ascii'));
    const ct = Buffer.concat([cipher.update(zlib.deflateRawSync(Buffer.from(content))), cipher.final()]);
    const zipped = [header, '', iv.toString('base64url'), ct.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
    expect(decryptJwe(zipped, KEY, new Trace()).text).toBe(content);

    expect(() => decryptJwe(jwe, crypto.randomBytes(32).toString('base64url'), new Trace())).toThrow(/Decryption failed: the key is wrong/);
    expect(() => decryptJwe('a.b.c', KEY, new Trace())).toThrow(/not a compact JWE .* it has 3 parts/);
    const rsa = [Buffer.from(JSON.stringify({ alg: 'RSA-OAEP', enc: 'A256GCM' })).toString('base64url'), 'k', 'i', 'c', 't'].join('.');
    expect(() => decryptJwe(rsa, KEY, new Trace())).toThrow(/alg must be dir/);
  });

  test('says what a resource is: an IPS document, another document, or something else', () => {
    const doc = (type) => ({ resourceType: 'Bundle', type: 'document', entry: [{ resource: { resourceType: 'Composition', type: { coding: [{ system: 'http://loinc.org', code: type }] } } }] });
    expect(examine(doc('60591-5'), new Trace())).toMatchObject({ ips: true, document: true });
    const other = new Trace();
    expect(examine(doc('34133-9'), other)).toMatchObject({ ips: false, document: true });
    expect(texts(other)[0]).toMatch(/not an IPS: Composition.type is http:\/\/loinc.org\|34133-9/);
    expect(examine({ resourceType: 'Bundle', type: 'collection' }, new Trace())).toBeNull();
    expect(examine({ resourceType: 'Patient' }, new Trace())).toBeNull();
  });

  test('reads a VHL, and checks its signature against the certificates it trusts', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pem = publicKey.export({ type: 'spki', format: 'pem' });
    const shlink = `shlink://${payloadText({ url: 'https://shl.example.org/m/1', key: KEY })}`;
    const claims = new Map([[1, 'XX'], [6, 1767225600], [-260, new Map([[5, [shlink]]])]]);
    const text = vhl(claims, privateKey, 'kid-1');

    const trust = loadTrust([{ kid: 'kid-1', name: 'the test issuer', certificate: pem }]);
    const good = new Trace();
    expect(decodeVhl(text, trust, good)).toEqual({ shlink, issuer: 'XX', kid: 'kid-1', verified: true, verifiedBy: 'the test issuer' });
    expect(texts(good)).toContain('ok: The signature is good: signed by the test issuer (kid kid-1)');

    // someone else's key under the same kid
    const other = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'pem' });
    const bad = new Trace();
    expect(decodeVhl(text, loadTrust([{ kid: 'kid-1', certificate: other }]), bad).verified).toBe(false);
    expect(texts(bad).some(x => /^error: The signature is NOT good/.test(x))).toBe(true);

    // an issuer the viewer doesn't know
    const unknown = new Trace();
    expect(decodeVhl(text, [], unknown).verified).toBeNull();
    expect(texts(unknown).some(x => /cannot be checked: the viewer has no certificate for kid kid-1/.test(x))).toBe(true);

    // the claims with text keys, as a JSON object gives them
    const textKeys = new Trace();
    expect(decodeVhl(vhl({ 1: 'XX', '-260': { 5: [shlink] } }, privateKey, 'kid-1'), trust, textKeys).shlink).toBe(shlink);
    expect(texts(textKeys)).toContain('warning: The claims have text keys ("1", "-260") where CWT and the GDHCN use integers (1, -260)');

    expect(() => decodeVhl('HC1:abc', trust, new Trace())).toThrow(/not base45/);
    expect(() => decodeVhl(vhl(new Map([[1, 'XX']]), privateKey, 'kid-1'), trust, new Trace())).toThrow(/no link/);
  });

  test('a trusted certificate that cannot be loaded is reported and left out', () => {
    const errors = [];
    expect(loadTrust([{ kid: 'a', certFile: '/no/such/file.pem' }, { certificate: 'x' }], { error: (m) => errors.push(m) })).toEqual([]);
    expect(errors).toHaveLength(2);
  });
});
