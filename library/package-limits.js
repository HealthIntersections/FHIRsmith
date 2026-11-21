'use strict';

/**
 * The most a package may unzip to, wherever FHIRsmith unpacks one: the packages crawler (where
 * crawler.maxUnpackedMB can change it), the package manager the tx module loads packages with,
 * and the npm registry check. The largest real package is us.nlm.vsac#0.18.0, 1.25 GB unzipped
 * (Nov 2026), so the limit is 1.5 GB; a package that unzips to more - a decompression bomb, say - is refused as soon as it passes this,
 * however small it is to download. org.hl7.fhir.core's NpmPackage has the same default.
 */

const MB = 1024 * 1024;
const MAX_UNPACKED_MB = 1536;
const MAX_UNPACKED_BYTES = MAX_UNPACKED_MB * MB;

module.exports = { MAX_UNPACKED_MB, MAX_UNPACKED_BYTES };
