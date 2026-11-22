const { removePatientNotes, addPatientComments, markdownHtmlParts, markdownHtml, htmlToMarkdown, patientNotesMarkdown } = require('../../ips/patient-comments');

const notes = (title) => ({ title, code: { coding: [{ system: 'http://loinc.org', code: '51855-5' }] }, text: { status: 'generated', div: '<div xmlns="http://www.w3.org/1999/xhtml">old</div>' } });
const allergies = { title: 'Allergies', code: { coding: [{ system: 'http://loinc.org', code: '48765-2' }] } };

function doc(sections, subject = { reference: 'urn:uuid:pat-1' }) {
  return {
    resourceType: 'Bundle', type: 'document',
    entry: [
      { fullUrl: 'urn:uuid:comp-1', resource: { resourceType: 'Composition', ...(subject ? { subject } : {}), ...(sections ? { section: sections } : {}) } },
      { fullUrl: 'urn:uuid:pat-1', resource: { resourceType: 'Patient' } }
    ]
  };
}

describe('patient comments in a document', () => {
  test('existing patient notes sections are removed, at any depth; the document passed in is not changed', () => {
    const d = doc([notes('a'), { ...allergies, section: [notes('nested'), { title: 'kept' }] }]);
    const before = structuredClone(d);
    const out = removePatientNotes(d);
    expect(d).toEqual(before);
    expect(out.entry[0].resource.section).toEqual([{ ...allergies, section: [{ title: 'kept' }] }]);
    expect(removePatientNotes(doc([notes('only')])).entry[0].resource.section).toBeUndefined();
    expect(removePatientNotes(doc(null))).toEqual(doc(null));
  });

  test('the comments go in as the first section: code, title, the patient as author, the narrative (additional) - nothing else', () => {
    const d = doc([allergies]);
    const out = addPatientComments(d, 'I **never** had asthma.\n\n- see <https://example.org>');
    expect(d.entry[0].resource.section).toEqual([allergies]);
    expect(out.entry[0].resource.section).toEqual([
      {
        title: 'Patient\'s Comments',
        code: { coding: [{ system: 'http://loinc.org', code: '51855-5' }] },
        author: [{ reference: 'urn:uuid:pat-1' }],
        text: {
          status: 'additional',
          div: '<div xmlns="http://www.w3.org/1999/xhtml"><p>I <strong>never</strong> had asthma.</p>\n<ul>\n<li>see <a href="https://example.org">https://example.org</a></li>\n</ul></div>'
        }
      },
      allergies
    ]);
    // no sections before; no subject: the Patient entry's fullUrl
    const plain = addPatientComments(doc(null, null), 'x').entry[0].resource.section;
    expect(plain.length).toBe(1);
    expect(plain[0].author).toEqual([{ reference: 'urn:uuid:pat-1' }]);
    expect(() => addPatientComments({ resourceType: 'Bundle', entry: [] }, 'x')).toThrow(/no Composition/);
  });

  test('markdown: HTML is found (blocks, inline, comments), autolinks and < are not; rendering drops raw HTML', () => {
    expect(markdownHtmlParts('a <b>b</b>')).toEqual(['<b>', '</b>']);
    expect(markdownHtmlParts('<div>\nx\n</div>').length).toBe(1);
    expect(markdownHtmlParts('<!-- c -->').length).toBe(1);
    expect(markdownHtmlParts('see <https://example.org> and 2 < 3')).toEqual([]);
    expect(markdownHtml('a <script>x</script>')).not.toContain('<script>');
  });

  test('a narrative as pure markdown (turndown): text that looks like HTML escaped, tables as rows, no images', () => {
    const md = htmlToMarkdown('<div xmlns="http://www.w3.org/1999/xhtml"><h3>About my record</h3><p>I <strong>never</strong> had asthma &lt;b&gt; really</p>' +
      '<ul><li>one</li><li>two <em>x</em></li></ul><table><tr><th>Problem</th><th>Comment</th></tr><tr><td>Asthma</td><td>Wrong</td></tr></table>' +
      '<img src="data:image/png;base64,AAAA"/><p>See <a href="https://example.org">here</a></p></div>');
    expect(md).toBe('### About my record\n\nI **never** had asthma \\<b> really\n\n-   one\n-   two *x*\n\nProblem | Comment\n\nAsthma | Wrong\n\nSee [here](https://example.org)');
    expect(markdownHtmlParts(md)).toEqual([]);
    expect(markdownHtml(md)).toContain('had asthma &lt;b&gt; really');
    expect(htmlToMarkdown('')).toBe('');
  });

  test('a document\'s patient notes sections (at any depth) as markdown; none, or empty: null', () => {
    const n = (div) => ({ ...notes('n'), text: { status: 'additional', div } });
    expect(patientNotesMarkdown(doc([allergies]))).toBeNull();
    expect(patientNotesMarkdown(doc([n('<div><p></p></div>')]))).toBeNull();
    expect(patientNotesMarkdown(doc([n('<div><p>First</p></div>'), { ...allergies, section: [n('<div><p>Second</p></div>')] }]))).toBe('First\n\nSecond');
  });
});
