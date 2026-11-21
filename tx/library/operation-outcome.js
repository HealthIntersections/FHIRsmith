const {validateParameter} = require("../../library/utilities");

const TX_ISSUE_TYPE_SYSTEM = "http://hl7.org/fhir/tools/CodeSystem/tx-issue-type";

/**
 * Every issue this server emits carries a tx-issue-type coding in details.coding, and the
 * human readable account of the problem in details.text. Nothing a client needs is allowed
 * to live *only* in diagnostics: the test harness strips diagnostics outright, so anything
 * that lives there alone is, by construction, invisible to a test. diagnostics itself is
 * still sent -- it is the right place for server-specific detail, and dropping it would
 * take away something useful to get a property no test could have relied on anyway.
 *
 * Most issues name their tx-issue-type explicitly. This map is the backstop for the ones
 * that do not, so that "always has a coding" holds without every one of the ~170 Issue
 * construction sites having to be revisited at once. It is keyed on the FHIR issue-type,
 * which is the coarser of the two vocabularies, so an explicit code is always better.
 */
const DEFAULT_TX_ISSUE_TYPE = {
  'not-found': 'not-found',
  'code-invalid': 'invalid-code',
  'invalid': 'invalid-data',
  'structure': 'invalid-data',
  'required': 'invalid-data',
  'value': 'invalid-data',
  'processing': 'invalid-data',
  'exception': 'invalid-data',
  'unknown': 'invalid-data',
  'conflict': 'invalid-data',
  'business-rule': 'business-rule',
  'too-costly': 'too-costly',
  'not-supported': 'not-supported',
};

/**
 * The tx-issue-type for an issue that did not name one. Informational issues that are not
 * about a code or a value set -- the server banner, say -- are not tx issues at all and get
 * no coding; everything else does.
 */
function defaultTxIssueType(code, severity) {
  if (severity === 'information' && (code === 'informational' || !code)) {
    return null;
  }
  return DEFAULT_TX_ISSUE_TYPE[code] || 'invalid-data';
}

/**
 * Build a single issue from loose parts. Prefer throwing an Issue -- this is for the
 * handful of places that build an outcome directly, so that they cannot drift away from
 * the shape Issue.asIssue() produces.
 *
 * `diagnostics` still goes out on the wire. The rule is that nothing a client needs may
 * live *only* there, because the test harness strips it before it compares -- not that the
 * server should stop saying anything. Callers with real internal detail to add (a stack
 * location, a request id, what the server was doing when it gave up) pass it; the rest get
 * the message, which is what this server has always sent.
 */
function buildIssue(severity, code, message, txIssueType = null, diagnostics = undefined) {
  const res = { severity, code, details: { text: message } };
  const tx = txIssueType || defaultTxIssueType(code, severity);
  if (tx) {
    res.details.coding = [{ system: TX_ISSUE_TYPE_SYSTEM, code: tx }];
  }
  const diag = diagnostics === undefined ? message : diagnostics;
  if (diag) {
    res.diagnostics = diag;
  }
  return res;
}

/** Build a one issue OperationOutcome from loose parts. */
function buildOperationOutcome(severity, code, message, txIssueType = null, diagnostics = undefined) {
  return {
    resourceType: 'OperationOutcome',
    issue: [buildIssue(severity, code, message, txIssueType, diagnostics)],
  };
}

class Issue extends Error {
  level;
  cause;
  path;
  msgId;
  issueCode;
  statusCode;
  isSetForhandleAsOO;
  diagnostics;
  issues = [];

  constructor (level, cause, path, msgId, message, issueCode = null, statusCode = 500) {
    super(message);
    this.level = level;
    this.cause = cause;
    this.path = path;
    this.message = message;
    this.msgId = msgId;
    this.issueCode = issueCode;
    this.statusCode = statusCode;
  }

  asIssue() {
    let res = {
      severity: this.level,
      code: this.cause,
      details: {
        text: this.message
      }
    }
    if (this.path) {
      res.expression = [this.path]
    }
    const issueCode = this.issueCode || defaultTxIssueType(this.cause, this.level);
    if (issueCode) {
      res.details.coding = [{ system: TX_ISSUE_TYPE_SYSTEM, code : issueCode }];
    }
    if (this.msgId) {
      res.extension = [{ url: "http://hl7.org/fhir/StructureDefinition/operationoutcome-message-id", valueString: this.msgId }];
    }
    if (this.diagnostics) {
      res.diagnostics = this.diagnostics;
    }
    return res;
  }

  handleAsOO(statusCode) {
    this.isSetForhandleAsOO = true;
    this.statusCode = statusCode;
    return this;
  }

  isHandleAsOO() {
    return this.isSetForhandleAsOO;
  }

  setFinished() {
    this.finished = true;
    return this;
  }
  setUnknownSystem(s) {
    this.unknownSystem = s;
    return this;
  }
  addIssue(issue) {
    if (issue) {
      this.issues.push(issue);
    }
    return this;
  }

  withDiagnostics(diagnostics) {
    this.diagnostics = diagnostics;
    return this;
  }
}

class OperationOutcome {
  jsonObj;

  constructor (jsonObj = null) {
    this.jsonObj = jsonObj ? jsonObj : { "resourceType": "OperationOutcome" };
  }

  addIssueIfNew(newIssue) {
    return this.addIssue(newIssue, true);
  }

  addIssue(newIssue, ifNotDuplicate = false) {
    validateParameter(newIssue, "newIssue", Object);
    if (ifNotDuplicate) {
      for (let iss of this.jsonObj.issue || []) {
        if (iss.details.text === newIssue.message) {
          return false;
        }
      }
    }
    if (!this.jsonObj.issue) {
      this.jsonObj.issue = [];
    }
    this.jsonObj.issue.push(newIssue.asIssue());
    for (let extra of newIssue.issues) {
      this.addIssue(extra, false);
    }
    return true;
  }

  hasIssues() {
    return this.jsonObj && this.jsonObj.issue;
  }

  hasErrors() {
    for (let iss of this.jsonObj.issue || []) {
      if (iss.severity === 'error') {
        return true;
      }
    }
    return false;
  }

  listMissedErrors(list) {
    for (let iss of this.jsonObj.issue || []) {
      if (iss.severity === 'error' && iss.details && iss.details.text && !list.find(msg => msg === iss.details.text )) {
        // every error that nothing else reported, not just the first one - an early return here
        // meant the summary message named only one of them
        list.push(iss.details.text);
      }
    }

  }
}

/**
 * Turn a thrown error into an OperationOutcome. Two conventions meet here, and this is the
 * only place that has to know about both: an Issue carries the FHIR issue type in `cause`
 * and the tx-issue-type in `issueCode`, while a plain Error tagged by whatever threw it
 * carries the FHIR issue type in `issueCode` and the tx-issue-type in `txIssueType`. Either
 * way the result has details.text and a tx-issue-type coding.
 */
function outcomeFromError(error) {
  if (error instanceof Issue) {
    const oo = new OperationOutcome();
    oo.addIssue(error);
    return oo.jsonObj;
  }
  return buildOperationOutcome('error', error.issueCode || 'exception',
    error.message || String(error), error.txIssueType || null, error.diagnostics);
}

module.exports = { OperationOutcome, Issue, buildIssue, buildOperationOutcome,
  outcomeFromError, defaultTxIssueType, TX_ISSUE_TYPE_SYSTEM };