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
      throw new Issue("error", "business-rule", null, null, 'Cannot process resource "'+name+'" due to the presence of implicit rules \''+resource.implicitRules+'\' @'+place);
    }
  },

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
      const resId = resource ? resource : "";
      const urlList = [...urls].join('\', \'');
      if (urls.size > 1) {
        throw new Issue("error", "business-rule", null, null, 'Cannot process resource '+resId+' at "' + name + '" due to the presence of modifier extensions '+urlList);
      } else {
        throw new Issue("error", "business-rule", null, null, 'Cannot process resource '+resId+' at "' + name + '" due to the presence of the modifier extension '+urlList);
      }
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
