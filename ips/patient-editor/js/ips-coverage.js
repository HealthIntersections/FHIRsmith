/*
 * Copyright (c) 2025+, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
 * Licensed under Creative Commons Public Domain (CC0)
 *
 * Coverage reporting for IPS import.
 *
 * This form understands a small slice of what an IPS document can carry. When a
 * document comes from somewhere else, the interesting question isn't "did it load"
 * but "what did we quietly drop on the floor" - a resource type we never look at,
 * a code that fell through a mapping, a section that has no home in the form.
 *
 * ips-parser.js reports what it did through this object, and passport.js prints the
 * result to the console after every import. Nothing here may throw or block a load:
 * if the bookkeeping is wrong, the import still has to work.
 *
 * From the console:
 *   ipsCoverage.report()   re-print the report for the last import
 *   ipsCoverage.text()     the same thing as plain text, for pasting into a bug
 *   ipsCoverage.last       the raw data behind it
 */
var ipsCoverage = (function () {

  const UNUSED = 'not looked at';
  const SEEN = 'looked at, no data taken';
  const UNMAPPED = 'no mapping';
  const USED = 'imported';

  // Later states win, so a resource that produced anything counts as used
  const RANK = { 'not looked at': 0, 'looked at, no data taken': 1, 'no mapping': 2, 'imported': 3 };

  let records = [];
  let byResource = new Map();
  let notes = [];
  let source = '';
  let started = false;

  function conceptText(cc) {
    if (!cc) {
      return '';
    }
    if (cc.text) {
      return cc.text;
    }
    const coding = cc.coding?.[0];
    if (!coding) {
      return '';
    }
    return coding.display || ((coding.system ? coding.system + '#' : '') + (coding.code || ''));
  }

  function nameText(name) {
    if (!name) {
      return '';
    }
    return name.text || [(name.given || []).join(' '), name.family].filter(part => part).join(' ');
  }

  function describe(resource) {
    if (!resource) {
      return '';
    }
    switch (resource.resourceType) {
      case 'Patient':
      case 'RelatedPerson':
      case 'Practitioner':
        return nameText(resource.name?.[0]);
      case 'MedicationStatement':
      case 'MedicationRequest':
        return conceptText(resource.medicationCodeableConcept) || conceptText(resource.medication?.concept);
      case 'Immunization':
        return conceptText(resource.vaccineCode);
      case 'Goal':
        return resource.description?.text || '';
      case 'Composition':
        return resource.title || '';
      case 'Consent':
        return conceptText(resource.provision?.code?.[0]);
      case 'DocumentReference':
        return conceptText(resource.type);
      default:
        return conceptText(resource.code) || resource.title || '';
    }
  }

  // Every coding on a CodeableConcept, as system#code, for reporting what didn't match
  function codesOf(cc) {
    if (!cc?.coding) {
      return [];
    }
    return cc.coding.map(coding => (coding.system || '?') + '#' + (coding.code || '?'));
  }

  function recordFor(resource) {
    return resource ? byResource.get(resource) : null;
  }

  function setState(resource, state, note) {
    const record = recordFor(resource);
    if (!record) {
      return;
    }
    if (RANK[state] >= RANK[record.state]) {
      record.state = state;
    }
    if (note && record.notes.indexOf(note) < 0) {
      record.notes.push(note);
    }
  }

  return {
    last: null,

    // the state a resource reaches when it actually contributed something
    IMPORTED: USED,

    /* Call before parsing. Inventories the bundle so we know what we started with. */
    start: function (bundle, sourceLabel) {
      records = [];
      byResource = new Map();
      notes = [];
      source = sourceLabel || 'document';
      started = true;
      (bundle?.entry || []).forEach((entry, index) => {
        if (!entry?.resource) {
          return;
        }
        const record = {
          index: index,
          type: entry.resource.resourceType || '(none)',
          id: entry.resource.id || entry.fullUrl || ('#' + index),
          description: describe(entry.resource),
          state: UNUSED,
          notes: []
        };
        records.push(record);
        byResource.set(entry.resource, record);
      });
      return this;
    },

    /* The parser looked at this resource (it matched a type scan) */
    seen: function (resource) {
      setState(resource, SEEN);
      return resource;
    },

    /* The parser took something from this resource. 'what' names the form field(s). */
    used: function (resource, what) {
      setState(resource, USED, what);
      return resource;
    },

    /*
     * The parser understood this resource but had nowhere to put it - an unmapped
     * code, a status it doesn't import. 'reason' should say which, specifically.
     */
    unmapped: function (resource, reason) {
      setState(resource, UNMAPPED, reason);
      return resource;
    },

    /* Something not tied to one resource: an unhandled section, an unread element */
    note: function (category, detail) {
      if (!started) {
        return;
      }
      notes.push({ category: category, detail: detail });
    },

    /* What became of this resource */
    stateOf: function (resource) {
      return recordFor(resource)?.state || UNUSED;
    },

    /*
     * Rather than thread field names through every mapping, we watch the form:
     * snapshot it before handing a resource to the parser, and afterwards ask which
     * fields changed. If none did, the resource went in and nothing came out.
     */
    snapshot: function (form) {
      const values = new Map();
      try {
        for (const pair of form.entries()) {
          values.set(pair[0], String(pair[1]));
        }
      } catch (e) {
        // not a FormData - coverage just gets less specific
      }
      return values;
    },

    recordChange: function (form, before, resource, reasonIfNothing) {
      const after = this.snapshot(form);
      const changed = [];
      after.forEach((value, key) => {
        if (before.get(key) !== value) {
          changed.push(key);
        }
      });
      if (changed.length) {
        this.used(resource, changed.join(', '));
      } else {
        this.unmapped(resource, typeof reasonIfNothing === 'function' ? reasonIfNothing() : (reasonIfNothing || 'nothing in it maps to a field in this form'));
      }
      return changed;
    },

    /* Every resource of a type, marked as looked at. The parser's scan helper. */
    resourcesOfType: function (bundle, type) {
      const out = [];
      (bundle?.entry || []).forEach(entry => {
        if (entry?.resource?.resourceType === type) {
          out.push(this.seen(entry.resource));
        }
      });
      return out;
    },

    /* The data behind the report, as plain objects */
    data: function () {
      const used = records.filter(r => r.state === USED);
      const unmapped = records.filter(r => r.state === UNMAPPED);
      const seen = records.filter(r => r.state === SEEN);
      const untouched = records.filter(r => r.state === UNUSED);

      const byType = {};
      untouched.forEach(record => {
        (byType[record.type] ??= []).push(record);
      });

      return {
        source: source,
        total: records.length,
        used: used,
        unmapped: unmapped,
        seen: seen,
        untouchedByType: byType,
        notes: notes
      };
    },

    text: function () {
      const data = this.data();
      const lines = [];
      lines.push('IPS import coverage for ' + data.source);
      lines.push(data.used.length + ' of ' + data.total + ' resources contributed something to the form.');
      lines.push('');

      const types = Object.keys(data.untouchedByType).sort();
      if (types.length) {
        lines.push('Resource types this form never looks at:');
        types.forEach(type => {
          const group = data.untouchedByType[type];
          const examples = group.map(r => r.description).filter(d => d).slice(0, 3).join('; ');
          lines.push('  ' + type + ' x' + group.length + (examples ? '  (' + examples + ')' : ''));
        });
        lines.push('');
      }
      if (data.unmapped.length) {
        lines.push('Looked at, but nothing imported:');
        data.unmapped.forEach(record => {
          lines.push('  ' + record.type + '/' + record.id + (record.description ? ' "' + record.description + '"' : '') +
            ' - ' + record.notes.join('; '));
        });
        lines.push('');
      }
      if (data.seen.length) {
        lines.push('Looked at, no outcome recorded (the parser may simply not report on these):');
        data.seen.forEach(record => {
          lines.push('  ' + record.type + '/' + record.id + (record.description ? ' "' + record.description + '"' : ''));
        });
        lines.push('');
      }
      if (data.notes.length) {
        const categories = [];
        data.notes.forEach(note => {
          if (categories.indexOf(note.category) < 0) {
            categories.push(note.category);
          }
        });
        categories.forEach(category => {
          lines.push(category + ':');
          data.notes.filter(note => note.category === category).forEach(note => {
            lines.push('  ' + note.detail);
          });
          lines.push('');
        });
      }
      return lines.join('\n');
    },

    report: function (sourceLabel) {
      if (sourceLabel) {
        source = sourceLabel;
      }
      if (!started) {
        console.info('No IPS document has been imported yet.');
        return;
      }
      const data = this.data();
      this.last = data;

      const types = Object.keys(data.untouchedByType).sort();
      const headline = 'IPS import coverage: ' + data.used.length + ' of ' + data.total +
        ' resources imported' +
        (types.length ? ', ' + types.length + ' resource type(s) ignored entirely' : '');

      // Collapsed by default: this is diagnostics, not an error
      console.groupCollapsed(headline);

      if (types.length) {
        console.groupCollapsed('Never looked at - no code in this form reads these');
        console.table(types.map(type => ({
          'resource type': type,
          count: data.untouchedByType[type].length,
          examples: data.untouchedByType[type].map(r => r.description).filter(d => d).slice(0, 3).join('; ')
        })));
        console.groupEnd();
      }

      if (data.unmapped.length) {
        console.groupCollapsed('Looked at, but nothing imported (' + data.unmapped.length + ')');
        console.table(data.unmapped.map(record => ({
          resource: record.type + '/' + record.id,
          description: record.description,
          why: record.notes.join('; ')
        })));
        console.groupEnd();
      }

      if (data.seen.length) {
        console.groupCollapsed('Looked at, no outcome recorded (' + data.seen.length + ')');
        console.table(data.seen.map(record => ({
          resource: record.type + '/' + record.id,
          description: record.description
        })));
        console.groupEnd();
      }

      const categories = [];
      data.notes.forEach(note => {
        if (categories.indexOf(note.category) < 0) {
          categories.push(note.category);
        }
      });
      categories.forEach(category => {
        const inCategory = data.notes.filter(note => note.category === category);
        console.groupCollapsed(category + ' (' + inCategory.length + ')');
        inCategory.forEach(note => console.info(note.detail));
        console.groupEnd();
      });

      if (data.used.length) {
        console.groupCollapsed('Imported (' + data.used.length + ')');
        console.table(data.used.map(record => ({
          resource: record.type + '/' + record.id,
          description: record.description,
          'form fields': record.notes.join('; ')
        })));
        console.groupEnd();
      }

      console.info('ipsCoverage.text() for a plain-text version; ipsCoverage.last for the raw data.');
      console.groupEnd();
    },

    // exposed for the parser
    conceptText: conceptText,
    codesOf: codesOf
  };
})();
