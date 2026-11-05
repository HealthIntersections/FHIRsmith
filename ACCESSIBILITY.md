# Accessibility

## Project Information

| Field | Value |
|---|---|
| Project | FHIRsmith |
| Owner | Health Intersections |
| Issue tracker | https://github.com/HealthIntersections/FHIRsmith/issues |
| Target standard | WCAG 2.0 Level AA (at least) |
| Conformance status | Target only - not yet evaluated |
| Last reviewed | 2026-11-05 |

## Commitment

FHIRsmith aims to be usable by everyone, including people who use assistive
technologies such as screen readers, screen magnifiers, voice control and
keyboard-only navigation.

We aspire to ensure that the FHIRsmith web UI meets the
[Web Content Accessibility Guidelines (WCAG) 2.0](https://www.w3.org/TR/WCAG20/)
at Level AA, at least.

Our approach is to make the default HTML accessible wherever we can do so
without significantly degrading the usual user experience (e.g. semantic
markup, table headers, form labels, keyboard access, not relying on colour).

Where meeting the guidelines would make the usual experience significantly
worse (e.g. dense tables or interactive tree views), FHIRsmith will provide
an option (a checkbox in the UI) that switches the generated HTML to a form
that does meet them. The setting applies to all pages for the remainder of
the user's session.

## Scope

### In scope

The **web user interface** that FHIRsmith presents in a browser: the home
page, the module pages (tx, packages, registry, xig, publisher, ips, shl,
testing etc.), and the HTML renderings of resources.

### Not in scope

FHIRsmith is primarily a server. Most of what it does is provide FHIR APIs
(terminology, packages, registry, etc.) that are consumed by other software,
not by people directly. Those APIs return machine-readable content (JSON, XML,
npm packages), and their accessibility is the responsibility of the client
applications that present that content to users.

### Third-party content

Some HTML content shown by FHIRsmith (e.g. resource narratives) is authored
by third parties and published in packages. FHIRsmith presents that content
as provided and cannot guarantee its accessibility. Accessibility problems in
that content should be reported to the publisher of the package concerned.

## Conformance Status

**Target only.** Conformance has not yet been formally assessed, and no
claim of conformance is made.

## Known Limitations

Pages have not yet been reviewed. Areas that are likely to present
difficulties include:

* Large tables (e.g. value set expansions, package listings, search results)
* Interactive tree views and editors
* Colour used to convey status

This section will be updated as pages are reviewed.

## Reporting an Accessibility Barrier

If you find part of the FHIRsmith web UI that is difficult or impossible to
use with assistive technology, please
[create an issue on GitHub](https://github.com/HealthIntersections/FHIRsmith/issues)
and include "Accessibility" in the title. Helpful details include:

* The URL of the page
* What you were trying to do
* The browser and assistive technology (and versions) you were using
* What happened, and what you expected

Accessibility issues are treated as bugs, not feature requests.

## Contributor Requirements

Contributions that improve accessibility are welcome. When contributing
changes to the web UI, please:

* Use semantic HTML (headings, lists, `<table>` with `<th>`/`scope`, `<label>` for form controls)
* Make sure everything works with the keyboard alone
* Provide text alternatives for images and icons
* Don't rely on colour alone to convey meaning
* If the page has an accessible-mode variant, check that it still works

## References

* [WCAG 2.0](https://www.w3.org/TR/WCAG20/)
* [ACCESSIBILITY.md template](https://mgifford.github.io/ACCESSIBILITY.md/)
* [Open Source Accessibility Framework](https://open-source-accessibility.github.io/Open-Source-Accessibility-Framework/foundational)
