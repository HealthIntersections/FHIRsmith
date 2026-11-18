// fast-xml-parser in a worker thread (library/xml-off-thread.js): a big document doesn't hold
// the event loop, and the answer is the same as parsing it here
const { XMLParser } = require('fast-xml-parser');
const { parseXmlOffThread } = require('../../library/xml-off-thread');

const OPTIONS = { ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text', entityExpansionLimit: 100000 };

function feed(items) {
  let xml = '<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>';
  for (let i = 0; i < items; i++) {
    xml += `<item><title>pkg.${i}#1.0.${i}</title><link>https://example.org/${i}/package.tgz</link><guid isPermaLink="true">g${i}</guid>` +
      `<fhir:version xmlns:fhir="http://hl7.org/fhir/feed">4.0.1</fhir:version><description>Package ${i} &amp; more</description></item>`;
  }
  return xml + '</channel></rss>';
}

describe('parseXmlOffThread', () => {
  test('a small document: parsed here, the same as before', async () => {
    const xml = feed(3);
    expect(await parseXmlOffThread(xml, OPTIONS)).toEqual(new XMLParser(OPTIONS).parse(xml));
  });

  test('a big document: parsed in a worker, the same answer, and the event loop keeps running', async () => {
    const xml = feed(20000); // several MB
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    try {
      const result = await parseXmlOffThread(Buffer.from(xml), OPTIONS);
      expect(result).toEqual(new XMLParser(OPTIONS).parse(xml));
      expect(result.rss.channel.item).toHaveLength(20000);
      expect(result.rss['@_version']).toBe('2.0');
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(5);
  }, 60000);

  test('a document the parser refuses (too many entities): the error comes back from the worker', async () => {
    await expect(parseXmlOffThread('<!DOCTYPE x [' + '<!ENTITY a "aaaa">'.repeat(200000) + ']><x>&a;</x>', OPTIONS, { inlineBytes: 0 }))
      .rejects.toThrow();
  }, 60000);
});
