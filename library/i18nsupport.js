const path = require("path");
const fs = require("fs");
const { getProperties } = require("properties-file");
const {validateParameter} = require("./utilities");
const {LanguageDefinitions} = require("./languages");

/**
 * Internationalization support for loading Java properties files
 */
class I18nSupport {
  constructor(translationsPath, languageDefinitions) {
    validateParameter(translationsPath, "translationsPath", String);
    validateParameter(languageDefinitions, "languageDefinitions", LanguageDefinitions);
    this.translationsPath = translationsPath;
    this.languageDefinitions = languageDefinitions;
    this.bundles = new Map(); // Cache for loaded message bundles by language code
    this.phrases = new Map(); // Cache for loaded message bundles by language code
  }

  /**
   * Load all available message bundles from the translations directory
   */
  async load() {
    await this._loadResourceBundle(this.bundles, 'Messages');
    await this._loadResourceBundle(this.phrases, 'rendering-phrases');
  }

  async _loadResourceBundle(bundles, name) {
    // Load default Messages.properties first
    await this._loadBundle(bundles, 'en', name+'.properties');

    // Scan for Messages_*.properties files
    try {
      const files = fs.readdirSync(this.translationsPath);
      const messageFiles = files.filter(file =>
        file.startsWith(name+'_') && file.endsWith('.properties')
      );

      for (const file of messageFiles) {
        // Extract language code from filename: Messages_fr_FR.properties -> fr-FR
        const langCode = file
          .substring(name+'_'.length, file.length - '.properties'.length)
          .replace(/_/g, '-');

        await this._loadBundle(bundles, langCode, file);
      }
    } catch (error) {
      throw new Error(`Failed to scan translations directory: ${error.message}`);
    }
  }

  /**
   * Load a specific message bundle file
   */
  async _loadBundle(bundles, langCode, filename) {
    try {
      const filePath = path.join(this.translationsPath, filename);
      const content = fs.readFileSync(filePath, 'utf8');
      const properties = getProperties(content);

      bundles.set(langCode, properties);
    } catch (error) {
      // Don't throw for missing files - just skip them
      console.warn(`Warning: Could not load ${filename}: ${error.message}`);
    }
  }

  /**
   * Format a message with parameter substitution
   * @param {Languages} languages - Languages object with preference order
   * @param {string} messageId - Message key from properties file
   * @param {Array} parameters - Parameters for {0}, {1}, etc. substitution
   * @returns {string} Formatted message
   */
  formatMessage(languages, messageId, parameters = []) {
    return this._formatMessageFromBundle(this.bundles, languages, messageId, parameters);
  }

  translate(messageId, languages, parameters = []) {
    return this.formatMessage(languages, messageId, parameters);
  }

  translatePlural(count, messageId, languages, parameters = []) {
    return this.formatMessagePlural(languages, messageId, count, parameters);
  }

  /**
   * Format a message with pluralization support
   * @param {Languages} languages - Languages object with preference order
   * @param {string} messageId - Base message key from properties file
   * @param {number} count - Count for pluralization (becomes {0} in final message)
   * @param {Array} parameters - Additional parameters for {1}, {2}, etc. substitution
   * @returns {string} Formatted message
   */
  formatMessagePlural(languages, messageId, count, parameters = []) {
    return this._formatMessagePluralFromBundle(this.bundles, languages, messageId, count, parameters);
  }

  /**
   * Format a message with parameter substitution
   * @param {Languages} languages - Languages object with preference order
   * @param {string} messageId - Message key from properties file
   * @param {Array} parameters - Parameters for {0}, {1}, etc. substitution
   * @returns {string} Formatted message
   */
  formatPhrase(messageId, languages, parameters = []) {
    return this._formatMessageFromBundle(this.phrases, languages, messageId, parameters);
  }

  translatePhrase(messageId, languages, parameters = []) {
    return this.formatPhrase(languages, messageId, parameters);
  }

  translatePhrasePlural(count, messageId, languages, parameters = []) {
    return this.formatPhrasePlural(languages, messageId, count, parameters);
  }

  /**
   * Format a message with pluralization support
   * @param {Languages} languages - Languages object with preference order
   * @param {string} messageId - Base message key from properties file
   * @param {number} count - Count for pluralization (becomes {0} in final message)
   * @param {Array} parameters - Additional parameters for {1}, {2}, etc. substitution
   * @returns {string} Formatted message
   */
  formatPhrasePlural(messageId, languages, count, parameters = []) {
    return this._formatMessagePluralFromBundle(this.phrases, languages, messageId, count, parameters);
  }

  _formatMessageFromBundle(bundles, languages, messageId, parameters = []) {
    // Find the best language bundle that has this message
    const message = this._findMessage(bundles, languages, messageId);

    if (!message) {
      return messageId; // Fallback to message ID if not found
    }

    // Substitute parameters {0}, {1}, etc.
    return this._substituteParameters(message.trim(), parameters).replaceAll("''", "'");
  }

  _formatMessagePluralFromBundle(bundles, languages, messageId, count, parameters = []) {
    // Determine plural form suffix
    const pluralSuffix = count === 1 ? '_one' : '_other';
    const pluralMessageId = messageId + pluralSuffix;

    // Try to find the plural-specific message first
    let message = this._findMessage(bundles, languages, pluralMessageId);

    // If not found, fall back to the base message
    if (!message) {
      message = this._findMessage(bundles, languages, messageId);
    }

    if (!message) {
      return messageId; // Fallback to message ID if not found
    }

    // Prepend count as parameter 0, shift other parameters
    const allParameters = [count.toString(), ...parameters];

    // Substitute parameters {0}, {1}, etc.
    return this._substituteParameters(message, allParameters).replaceAll("''", "'");
  }

  /**
   * Find message in language bundles with fallback logic
   */
  _findMessage(bundles, languages, messageId) {
    // Try each language in preference order
    if (languages) {
      for (const language of languages) {
        const message = this._getMessageForLanguage(bundles, language.code, messageId);
        if (message) {
          return message;
        }

        // Try language without region (e.g., 'fr' for 'fr-FR')
        if (language.language && language.language !== language.code) {
          const message = this._getMessageForLanguage(bundles, language.language, messageId);
          if (message) {
            return message;
          }
        }
      }
    }

    // Final fallback to English
    return this._getMessageForLanguage(bundles,'en', messageId);
  }

  /**
   * Get message for specific language code
   */
  _getMessageForLanguage(bundles, langCode, messageId) {
    const bundle = bundles.get(langCode);
    return bundle ? bundle[messageId] : null;
  }

  /**
   * Substitute parameters in message string
   * Replaces {0}, {1}, etc. with provided parameters
   */
  _substituteParameters(message, parameters) {
    if (!parameters || parameters.length === 0) {
      return message;
    }

    return message.replace(/\{(\d+)\}/g, (match, index) => {
      const paramIndex = parseInt(index);
      return paramIndex < parameters.length ? parameters[paramIndex] : match;
    });
  }

  /**
   * Get all available language codes
   */
  getAvailableLanguages() {
    return Array.from(this.bundles.keys());
  }

  /**
   * Check if a message exists for any language
   */
  hasMessage(messageId) {
    for (const bundle of this.bundles.values()) {
      if (bundle[messageId]) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if a message exists for any language
   */
  hasPhrase(messageId) {
    for (const bundle of this.phrases.values()) {
      if (bundle[messageId]) {
        return true;
      }
    }
    return false;
  }

  /**
   * Create a linked copy of this I18nSupport instance
   */
  link() {
    const copy = new I18nSupport(this.translationsPath, this.languageDefinitions);
    copy.bundles = new Map(this.bundles); // Shallow copy of bundles map
    copy.phrases = new Map(this.phrases); // Shallow copy of bundles map
    return copy;
  }
}

let english = null;

/**
 * A message from translations/Messages.properties, in English, with its parameters, as
 * I18nSupport.translate gives it: for code with no request languages to hand (the shared
 * cache store's lazy reads, the launcher). The message id goes with it, so a client (or a
 * caller that has the languages: msgParams) can render it in another language.
 * @param {string} messageId
 * @param {Array} [parameters]
 */
function englishMessage(messageId, parameters = []) {
  if (!english) {
    english = getProperties(fs.readFileSync(path.join(__dirname, '..', 'translations', 'Messages.properties'), 'utf8'));
  }
  const message = english[messageId];
  if (!message) {
    return messageId;
  }
  return I18nSupport.prototype._substituteParameters(message.trim(), parameters).replaceAll("''", "'");
}

module.exports = {
  I18nSupport,
  englishMessage
};