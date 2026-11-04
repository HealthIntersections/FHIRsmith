const {getValuePrimitive} = require("../../library/utilities");
const {Issue} = require("./operation-outcome");

const Extensions = {

  list(object, url) {
    if (object.extension) {
      let res = [];
      for (let extension of object.extension) {
        if (extension.url === url) {
          res.push(extension);
        }
      }
      return res;
    } else {
      return [];
    }
  },

  checkNoImplicitRules(resource, place, name) {
    if (!resource) {
      return;
    }
    if (resource.jsonObj) {
      resource = resource.jsonObj
    }
    if (resource.implicitRules && 'https://hl7.org/fhir/implicit-rules/omitted-mandatory-interversion-code' != resource.implicitRules) {
      throw new Issue("error", "business-rule", null, null, 'Cannot process resource "'+name+'" due to the presence of implicit rules \''+resource.implicitRules+'\' @'+place, null, 422);
    }
  },

  /**
   * @param {Object} element - what may carry modifier extensions
   * @param {string} place - the code doing the check (unused, for reading)
   * @param {string} name - the element's path (FHIRPath, e.g. ValueSet.compose.include[0].filter[1]),
   *   reported as the issue's expression
   * @param {string} resource - the value set's url|version
   */
  checkNoModifiers(element, place, name, resource) {
    if (!element) {
      return;
    }
    if (element.jsonObj) {
      element = element.jsonObj
    }
    if (element.modifierExtension) {
      let urls = new Set();
      for (const extension of element.modifierExtension) {
        urls.add(extension.url);
      }
      // a modifier extension changes the meaning of what it's on, so an unknown one means the value
      // set can't be processed: a problem with the request's content, not the server (422)
      const resId = resource ? resource : "";
      throw new Issue("error", "business-rule", name, 'VALUESET_MODIFIER_EXTENSION_UNKNOWN',
        "The value set " + resId + " can't be processed: " + name + " has a modifier extension that isn't understood (" + [...urls].join(', ') + ")",
        'vs-invalid', 422).handleAsOO(422);
    }
    return true;
  },

  readString(resource, url) {
    if (!resource) {
      return undefined;
    }
    let extensions = Array.isArray(resource) ? resource : (resource.extension || []);
    for (let ext of extensions || []) {
      if (ext.url === url) {
        return getValuePrimitive(ext);
      }
    }
    extensions = Array.isArray(resource) ? resource : (resource.modifierExtension || []);
    for (let ext of extensions || []) {
      if (ext.url === url) {
        return getValuePrimitive(ext);
      }
    }
    return null;
  },

  readNumber(resource, url, defaultValue) {
    if (!resource) {
      return defaultValue;
    }
    const extensions = Array.isArray(resource) ? resource : (resource.extension || []);
    for (let ext of extensions) {
      if (ext.url === url) {
        const value = getValuePrimitive(ext);
        if (typeof value === 'number') {
          return value;
        }
        if (typeof value === 'string') {
          const num = parseFloat(value);
          return isNaN(num) ? defaultValue : num;
        }
        return defaultValue;
      }
    }
    return defaultValue;
  },

  readValue(resource, url) {
    if (!resource) {
      return undefined;
    }
    const extensions = Array.isArray(resource) ? resource : (resource.extension || []);
    for (let ext of extensions || []) {
      if (ext.url === url) {
        return ext;
      }
    }
    return null;
  },

  has(object, url) {
    if (!object) {
      return undefined;
    }
    const extensions = Array.isArray(object) ? object : (object.extension || []);
    return extensions.find(ex => ex.url === url);
  },

  addBoolean(exp, url, b) {
    if (!exp.extension) {
      exp.extension = [];
    }
    let ext = { url : url, valueBoolean : b };
    exp.extension.push(ext);
    return ext;
  },

  addString(exp, url, s) {
    if (!exp.extension) {
      exp.extension = [];
    }
    let ext = { url : url, valueString : s };
    exp.extension.push(ext);
    return ext;
  }
}

module.exports = { Extensions };
