const fs = require('fs');
const readline = require('readline');

/**
 * Yields the records of a CSV file one at a time, as text.
 *
 * A quoted field can contain a line break (LOINC 2.83's ComponentHierarchyBySystem.csv has one
 * in a CODE_TEXT), so a record that ends inside quotes is joined to the next line until the
 * quotes balance. An escaped quote ("") counts twice, so it doesn't upset the count.
 */
async function* csvRecords(filePath) {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity
  });

  let pending = null;
  let quotes = 0;
  for await (const line of rl) {
    pending = pending === null ? line : pending + '\n' + line;
    for (let i = 0; i < line.length; i++) {
      if (line.charCodeAt(i) === 34) quotes++;
    }
    if (quotes % 2 === 0) {
      yield pending;
      pending = null;
      quotes = 0;
    }
  }
  if (pending !== null) {
    yield pending;
  }
}

module.exports = { csvRecords };
