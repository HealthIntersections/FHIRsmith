//
// Copyright 2025, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * VHL Processing Module
 *
 * This module handles the complex VHL (Verifiable Health Link) processing
 * when the vhl flag is set to true in an SHL entry.
 */

/**
 * Process VHL response for SHL entries with vhl=true
 *
 * @param {string} host - The host from the request (e.g., "localhost:3000")
 * @param {string} uuid - The SHL entry UUID
 * @param {object} standardResponse - The standard JSON response that would be returned
 * @returns {object} The modified JSON response for VHL entries
 */
function processVHL(host, uuid, standardResponse) {
  // TODO: Implement your complex VHL processing logic here

  // Example structure - modify as needed:
  const vhlResponse = {
    "resourceType": "Bundle",
    "type": "searchset",
    "link": [{
      "relation": "self",
      "url": "https://" + host + "/shl/access/" + uuid
    }],
    "entry": []
  };

  for (const file of standardResponse.files) {
    var uuid2 = tail(file.location);
    var e = {
      "fullUrl": file.location,
      "resource": {
        "resourceType": "DocumentReference",
        "id": uuid2,
        "masterIdentifier": {
          "system": "urn:ietf:rfc:3986",
          "value": "urn:uuid:" + uuid2
        },
        "status": "current",
        "content": [{
          "attachment": {
            "contentType": file.contentType,
            "url": file.location
          }
        }]
      }
    }
    vhlResponse.entry.push(e);
  }

  return vhlResponse;
}

function tail(url) {
  if (url.includes("/")) {
    return url.substring(url.lastIndexOf("/") + 1);
  } else {
    return url;
  }
}

module.exports = {
  processVHL
};
