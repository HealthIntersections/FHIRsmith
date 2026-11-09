/**
 * What the importers print: progress and results for the person running them (stdout), and
 * problems (stderr). The importers are command line tools, so this is the console - but
 * everything goes through here, so console calls stay out of the importer code (and out of a
 * search for console.log).
 *
 * Each function looks console up when it is called, so whatever has replaced console.log (a
 * test, say) still gets the output. Code that wants to see what an importer prints can replace
 * terminal.log itself, and put it back after (see import-unii.module.js).
 */
/* eslint-disable no-console */
const terminal = {
  log: (...args) => console.log(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args)
};

module.exports = terminal;
