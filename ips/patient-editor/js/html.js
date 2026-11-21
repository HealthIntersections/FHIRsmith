// Copyright (c) 2025+, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
// Licensed under Creative Commons Public Domain (CC0) 


const xhtml = {
    element: function (type) {
        const el = document.createElement(type);
        return {
            id: function (id) { el.id = id; return this; },
            class: function (className) { el.className = className; return this; },
            attr: function (name, value) { el.setAttribute(name, value); return this; },
            text: function (text) { el.textContent = text; return this; },
            append: function (child) { el.appendChild(child); return this; },
            appendTo: function (parent) { parent.appendChild(el); return this; },

            tx: function (text) { el.appendChild(document.createTextNode(text)); return this; },
            sep: function (text) {
                if (el.hasChildNodes()) {
                    el.appendChild(document.createTextNode(text));
                }
                return this;
            },

            br: function () { el.appendChild(document.createElement('br').appendChild(document.createTextNode(' '))); return this; },

            named: function (name) { return xhtml.element(name).appendTo(el) },
            ah: function (link) { 
                var a = this.named('a');
                a.attr('href', link);
                return a;
            },
            ul: function () { return this.named("ul") },
            li: function () { return this.named("li") },
            p: function () { return this.named("p") },

            done: function () { return el; }
        };
    },
    div: function () {
        var d = this.element('div');
        d.attr('xmlns', "http://www.w3.org/1999/xhtml")
        return d;
    }
};

function buildUrl(...parts) {
    return parts
        .map(part => part.trim().replace(/^\/+|\/+$/g, ''))  // Remove leading/trailing slashes
        .filter(part => part.length > 0)                      // Remove empty segments
        .join('/');
}


function parseAndFormatDate(input) {
    console.log("parseAndFormatDate: "+input);

    // If it's already in YYYY format, return it
    if (/^\d{4}$/.test(input)) {
       console.log('yyyy');
        return input;
    }
    // If it's already in YYYY-MM format, return it
    if (/^\d{4}-\d{2}$/.test(input)) {
        console.log('yyyy-mm');
        return input;
    }
    // If it's already in YYYY-MM-DD format, return it
    if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
        console.log('yyyy-mm-dd');
        return input;
    }

    // Try to parse the input
    const date = new Date(input);
    console.log('date: '+date);

    // Check if date is valid
    if (isNaN(date.getTime())) {
        console.log('nan');
        return null;  // or throw error, depending on your needs
    }

    // Format as YYYY-MM-DD
    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');

    console.log(`${year}-${month}-${day}`);
    return `${year}-${month}-${day}`;
}

function generateUUID() {
    // Public Domain/MIT
    var d = new Date().getTime();//Timestamp
    var d2 = ((typeof performance !== 'undefined') && performance.now && (performance.now()*1000)) || 0;//Time in microseconds since page-load or 0 if unsupported
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random() * 16;//random number between 0 and 16
        if(d > 0){//Use timestamp until depleted
            r = (d + r)%16 | 0;
            d = Math.floor(d/16);
        } else {//Use microseconds since page-load if supported
            r = (d2 + r)%16 | 0;
            d2 = Math.floor(d2/16);
        }
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

function iss(s) {
  return s && s.trim();
}

function escapeText(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/*
 * Resolve a reference within a document bundle. Documents come from all sorts of
 * systems, so the reference can be any of:
 *   Patient/example                     - relative, matching resource.id
 *   urn:uuid:1c9a...                    - matching entry.fullUrl
 *   resource:0                          - what SMART Health Cards use, also fullUrl
 *   https://server/fhir/Patient/example - absolute, match fullUrl or fall back to the tail
 * Accepts either a reference string or a Reference object. Returns null if it can't
 * be resolved - callers decide whether that's fatal.
 *
 * This lives in html.js because both the generator (ips.js) and the parser
 * (ips-parser.js) need it, and only one of them is loaded on some pages.
 */
function findResource(bundle, reference) {
  if (!bundle?.entry || !reference) {
    return null;
  }
  const ref = typeof reference === 'string' ? reference : reference.reference;
  if (!ref || ref.startsWith('#')) {
    return null; // contained resources aren't bundle entries
  }

  // The general case: whatever the reference says, an entry declares itself as that
  const byFullUrl = bundle.entry.find(e => e.fullUrl === ref);
  if (byFullUrl) {
    return byFullUrl.resource;
  }

  const parts = ref.match(/([A-Za-z]+)\/([A-Za-z0-9\-.]{1,64})(?:\/_history\/[^\/]+)?$/);
  if (parts) {
    const type = parts[1];
    const id = parts[2];
    const byTypeAndId = bundle.entry.find(e => e.resource?.resourceType === type && e.resource?.id === id);
    if (byTypeAndId) {
      return byTypeAndId.resource;
    }
    // A relative reference against entries that carry absolute fullUrls
    const byTail = bundle.entry.find(e => typeof e.fullUrl === 'string' && e.fullUrl.endsWith('/' + type + '/' + id));
    if (byTail) {
      return byTail.resource;
    }
    // Last resort: the id alone, wherever it is
    const byId = bundle.entry.find(e => e.resource?.id === id);
    if (byId) {
      return byId.resource;
    }
  }
  return null;
}

// Narrative is sanitised by the document actions (doc-actions.js, loaded before this), which
// have the one copy of the rules: the same is shown here and put into the PDF
function sanitizeNarrative(html) {
  return iss(html) ? window.IpsDocActions.sanitizeNarrative(String(html)) : '';
}

// The narrative of a resource, section or composition - sanitised, or null if absent
function narrativeOf(element) {
  return element?.text?.div ? sanitizeNarrative(element.text.div) : null;
}

// Put the Health Intersections logo under a QR code produced by qrcode-generator's
// createSvgTag(). The SVG is square; we extend it downwards and draw the logo in the
// new strip. The QR modules themselves are untouched, so scanning is unaffected -
// the logo sits outside the quiet zone that createSvgTag already draws.
const QR_LOGO = { src: (window.PATIENT_EDITOR ? window.PATIENT_EDITOR.assets + '/' : 'assets/') + 'images/health-intersections.png', width: 300, height: 76 };

function brandQrSvg(svg) {
  const m = /<svg[^>]*\swidth="(\d+)(?:px)?"[^>]*\sheight="(\d+)(?:px)?"/.exec(svg);
  if (!m) {
    return svg;
  }
  const w = parseInt(m[1], 10);
  const h = parseInt(m[2], 10);
  const logoW = Math.round(w * 0.5);
  const logoH = Math.round(logoW * QR_LOGO.height / QR_LOGO.width);
  const newH = h + logoH;
  const x = Math.round((w - logoW) / 2);
  const image = '<rect x="0" y="' + h + '" width="' + w + '" height="' + logoH + '" fill="white"/>' +
    '<image href="' + QR_LOGO.src + '" x="' + x + '" y="' + h + '" width="' + logoW + '" height="' + logoH + '"/>';
  return svg
    .replace(/(<svg[^>]*\s)height="\d+(px)?"/, '$1height="' + newH + '$2"')
    .replace(/viewBox="0 0 (\d+) \d+"/, 'viewBox="0 0 $1 ' + newH + '"')
    .replace(/<\/svg>\s*$/, image + '</svg>');
}
