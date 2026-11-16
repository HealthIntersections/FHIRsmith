// Copyright (c) 2025+, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
// Licensed under Creative Commons Public Domain (CC0) 

var ips = null;
window.allergyCount = 1;
window.issueCount = 1;
window.medicationCount = 1;
window.eventCount = 1;
window.goalCount = 1;

$( function() {
    $( "#religion-code" ).autocomplete({
      source:function(request, response) {
        $.ajax({
          url: 'https://tx.fhir.org/r4/ValueSet/$expand',
          data: {
            url: 'http://terminology.hl7.org/ValueSet/v2-0006',
            _format: 'json',
            count: 15,
            filter: request.term
          },
          success: function(valueSet) {
            if (valueSet.expansion.contains) {
              const suggestions = valueSet.expansion.contains.map(concept => ({
                label: concept.display,
                value: concept.display,
                code: concept.code,
                system: concept.system
              }));
              response(suggestions);
            } else {
              response(null);
            }
          }
        });
      },
      minLength: 3,
      select: function( event, ui ) {
        $(this).data('selected-concept', {
          code: ui.item.code,
          system: ui.item.system
        });
      }
    });
  } );
  function setupMedicationAutocomplete(inputSelector) {
    $(inputSelector).autocomplete({
      source:function(request, response) {
        $.ajax({
          url: 'https://tx.ontoserver.csiro.au/fhir/ValueSet/$expand',
          data: {
            // url: 'http://terminology.hl7.org.au/ValueSet/amt-mp-codes',
            url: 'https://www.humanservices.gov.au/organisations/health-professionals/enablers/air-vaccine-code-formats/vs',
            _format: 'json',
            count: 15,
            filter: request.term
          },
          success: function(valueSet) {
            if (valueSet.expansion.contains) {
              const suggestions = valueSet.expansion.contains.map(concept => ({
                label: concept.display,
                value: concept.display,
                code: concept.code,
                system: concept.system
              }));
              response(suggestions);
            } else {
              response(null);
            }
          }
        });
      },
      minLength: 3,
      select: function( event, ui ) {
        $(this).data('selected-concept', {
          code: ui.item.code,
          system: ui.item.system
        });
      }
    });
  };
  function setupClinicalAutocomplete(inputSelector) {

    $(inputSelector).autocomplete({
      source:function(request, response) {
        $.ajax({
          url: 'https://tx.ontoserver.csiro.au/fhir/ValueSet/$expand',
          data: {
            // url: 'https://healthterminologies.gov.au/fhir/ValueSet/clinical-finding-1',
            url: 'http://snomed.info/sct?fhir_vs=refset/32570581000036105',
            _format: 'json',
            count: 15,
            filter: request.term
          },
          success: function(valueSet) {
            if (valueSet.expansion.contains) {
              const suggestions = valueSet.expansion.contains.map(concept => ({
                label: concept.display,
                value: concept.display,
                code: concept.code,
                system: concept.system
              }));
              response(suggestions);
            } else {
              response(null);
            }
          }
        });
      },
      minLength: 3,
      select: function( event, ui ) {
        $(this).data('selected-concept', {
          code: ui.item.code,
          system: ui.item.system
        });
      }
    });
  };

  function setupAllergyAutocomplete(inputSelector) {

    $(inputSelector).autocomplete({
      source:function(request, response) {
        $.ajax({
          url: 'https://tx.ontoserver.csiro.au/fhir/ValueSet/$expand',
          type: 'POST',
          contentType: 'application/json', 
          data: JSON.stringify({
            "resourceType" : "Parameters",
            "parameter" : [{
              "name" : "_format",
              "valueCode" : "json"
            },{
              "name" : "count",
              "valueInteger" : 15
            }, {
              "name" : "filter",
              "valueString" : request.term
            }, {
              "name" : "valueSet",
              "resource" : {
                "resourceType" : "ValueSet",
                "compose" : {
                  "include" : [{
                    "system" : "http://snomed.info/sct",
                    "filter" : [{
                      "property" : "concept",
                      "op" : "descendent-of",
                      "value" : "105590001"
                    }]
                  },
                  {
                    "system" : "http://snomed.info/sct",
                    "filter" : [{
                      "property" : "concept",
                      "op" : "descendent-of",
                      "value" : "373873005"
                    }]
                  },
                  {
                    "system" : "http://snomed.info/sct",
                    "filter" : [{
                      "property" : "concept",
                      "op" : "descendent-of",
                      "value" : "420134006"
                    }]
                  },
                  {
                    "system" : "http://snomed.info/sct",
                    "filter" : [{
                      "property" : "concept",
                      "op" : "is-a",
                      "value" : "716186003"
                    }]
                  }]
                }
              }
            }]
          }),
          success: function(valueSet) {
            if (valueSet.expansion.contains) {
              const suggestions = valueSet.expansion.contains.map(concept => ({
                label: concept.display,
                value: concept.display,
                code: concept.code,
                system: concept.system
              }));
              response(suggestions);
            } else {
              response(null);
            }
          }
        });
      },
      minLength: 3,
      select: function( event, ui ) {
        $(this).data('selected-concept', {
          code: ui.item.code,
          system: ui.item.system
        });
      }
    });
  };

  var allergyCount = 1;
  var issueCount = 1;
  var medicationCount = 1;
  var eventCount = 1;
  var goalCount = 1;

  function addAllergy() {
    var v = "<td><input type='text' id='aiNN' name='aiNN' size='50'/><br class='ips'/><span class='ips'>IPS: Composition.section[allergies].entry->AllergyIntolerance.code</span></td><td><select id='aiRxnNN' name='aiRxnNN'><option value=''></option><option value='s'>Skin Problems</option><option value='g'>Gastro (vomiting, diarrhea etc)</option><option value='e'>Eye problems</option><option value='w'>Wheezing/breathing difficulties </option><option value='a'>Anaphylaxis</option><option value='c'>Cardiac Arrest</option></select><span class='ips'>IPS: AllergyIntolerance.reaction.manifestation</span></td>";

    var currentRow = document.getElementById("ai-issue-" + allergyCount);
    allergyCount++;
    v = v.replaceAll("NN", allergyCount);

    var newrow = document.createElement("tr");
    newrow.innerHTML = v;
    newrow.id = "ai-issue-" + allergyCount;
    currentRow.parentNode.insertBefore(newrow, currentRow.nextSibling);

    setupAllergyAutocomplete('#ai'+allergyCount);
  }
  function addIssue() {
    var v = "<td><input type='text' id='issueNN' name='issueNN' size='50'/></td><td><select id='issueLevelNN' name='issueLevelNN'><option value='m'>Major Life Challenge</option><option value='c'>Troublesome</option><option value='b'>Background but managed</option></select></td>";

    var currentRow = document.getElementById("tr-issue-" + issueCount);
    issueCount++;
    v = v.replaceAll("NN", issueCount);

    var newrow = document.createElement("tr");
    newrow.innerHTML = v;
    newrow.id = "tr-issue-" + issueCount;
    currentRow.parentNode.insertBefore(newrow, currentRow.nextSibling);

    setupClinicalAutocomplete('#issue'+issueCount);
  }

  function addMedication() {
    var v = "<td colspan='2'><input type='text' id='medicationNN' name='medicationNN'/> + <input type='text' name='dosageNN' size='50'></td>";

    var currentRow = document.getElementById("tr-medication-" + medicationCount);
    medicationCount++;
    v = v.replaceAll("NN", medicationCount);

    var newrow = document.createElement("tr");
    newrow.innerHTML = v;
    newrow.id = "tr-medication-" + medicationCount;
    currentRow.parentNode.insertBefore(newrow, currentRow.nextSibling);

    setupMedicationAutocomplete('#medication'+medicationCount);
  }

  function addEvent() {
    var v = "<td colspan='1'><input type='text' id='eventNN' name='eventNN' size='50'/></td><td><input type='text' name='event-whenNN'></td>";

    var currentRow = document.getElementById("tr-event-" + eventCount);
    eventCount++;
    v = v.replaceAll("NN", eventCount);

    var newrow = document.createElement("tr");
    newrow.innerHTML = v;
    newrow.id = "tr-event-" + eventCount;
    currentRow.parentNode.insertBefore(newrow, currentRow.nextSibling);
    setupClinicalAutocomplete('#event'+eventCount);
  }

  function addGoal() {
    var v = "<td><input type='text' name='care-goal-NN' size='50'/><input type='checkbox' name='care-goal-state-NN'> Making Progress</td>";

    var currentRow = document.getElementById("tr-goal-" + goalCount);
    goalCount++;
    v = v.replace("NN", goalCount);

    var newrow = document.createElement("tr");
    newrow.innerHTML = v;
    newrow.id = "tr-goal-" + goalCount;
    currentRow.parentNode.insertBefore(newrow, currentRow.nextSibling);
  }

// The document is made from the form as it changes (as the general editor's is), and the
// document actions (doc-actions.js) say what stops it being a minimal IPS until it is one.
var generateTimer = null;
var generation = 0;
function scheduleGenerate(delay) {
  if (generateTimer) {
    clearTimeout(generateTimer);
  }
  generateTimer = setTimeout(generate, delay === undefined ? 700 : delay);
}

async function generate() {
  const errorPanel = document.querySelector('#errorPanel');
  const preview = document.querySelector('#preview');
  const htmlview = document.querySelector('#htmlview');
  const mine = ++generation;
  errorPanel.textContent = '';
  errorPanel.style.display = "none";
  let bundle;
  try {
    bundle = await genIPS(new FormData(document.querySelector('#form')));
  } catch (error) {
    if (mine !== generation) return;
    ips = null;
    document.querySelector('#doc').style.display = "none";
    window.patientDocActions.setBundle(null, ['The document could not be made from the form: ' + (error && error.message ? error.message : error)]);
    return;
  }
  if (mine !== generation) return;
  ips = bundle;
  preview.textContent = JSON.stringify(bundle, null, 2);
  document.querySelector('#doc').style.display = "block";
  htmlview.innerHTML = render(ips)+attachmentInfo();
  window.patientDocActions.setBundle(bundle);
}

function attachmentInfo() {
  var html = "<h2>Attachments</h2>\r\n<ul>\r\n";
  html += ' <li>IPS-Document.json: The information here entered in a computer processible form for the health system</li>\r\n';
  const acFile = document.querySelector('#myfile').files[0];
  if (acFile) {
    // the file's name is whatever the user's file is called: text, not HTML
    html += ' <li>'+escapeText(acFile.name)+': full Advance Care Directive</li>\r\n';
  } 
  html += '</ul>\r\n';
  return html;
}

function allPresent() {
  document.getElementById('Arm-l').selectedIndex = 1;
  document.getElementById('Arm-r').selectedIndex = 1;
  document.getElementById('Hand-l').selectedIndex = 1;
  document.getElementById('Hand-r').selectedIndex = 1;
  document.getElementById('Fingers-l').selectedIndex = 1;
  document.getElementById('Fingers-r').selectedIndex = 1;
  document.getElementById('Leg-l').selectedIndex = 1;
  document.getElementById('Leg-r').selectedIndex = 1;
  document.getElementById('Calf-l').selectedIndex = 1;
  document.getElementById('Calf-r').selectedIndex = 1;
  document.getElementById('Foot-l').selectedIndex = 1;
  document.getElementById('Foot-r').selectedIndex = 1;
  document.getElementById('Toe-l').selectedIndex = 1;
  document.getElementById('Toe-r').selectedIndex = 1;
  document.getElementById('Hip-l').selectedIndex = 1;
  document.getElementById('Hip-r').selectedIndex = 1;
  document.getElementById('Eye-l').selectedIndex = 1;
  document.getElementById('Eye-r').selectedIndex = 1;
  document.getElementById('Hypothalamus').selectedIndex = 1;
  document.getElementById('Pituitary').selectedIndex = 1;
  document.getElementById('Tongue').selectedIndex = 1;
  document.getElementById('Jaw').selectedIndex = 1;
  document.getElementById('Oesophagus').selectedIndex = 1;
  document.getElementById('salgland-l').selectedIndex = 1;
  document.getElementById('salgland-r').selectedIndex = 1;
  document.getElementById('LargeColon').selectedIndex = 1;
  document.getElementById('Stomach').selectedIndex = 1;
  document.getElementById('GallBladder').selectedIndex = 1;
  document.getElementById('Kidney-l').selectedIndex = 1;
  document.getElementById('Liver').selectedIndex = 1;
  document.getElementById('Bladder').selectedIndex = 1;
  document.getElementById('Lung-l').selectedIndex = 1;
  document.getElementById('Lung-r').selectedIndex = 1;

 if (document.getElementById('gender').selectedIndex == 1) {
   document.getElementById('Breasts-l').selectedIndex = 2;
   document.getElementById('Breasts-r').selectedIndex = 2;
   document.getElementById('Uterus').selectedIndex = 2;
   document.getElementById('Ovary-l').selectedIndex = 2;
   document.getElementById('Ovary-r').selectedIndex = 2;
   document.getElementById('Cervix').selectedIndex = 2;
   document.getElementById('Vagina').selectedIndex = 2;
   document.getElementById('Penis').selectedIndex = 1;
   document.getElementById('Prostate').selectedIndex = 1;
   document.getElementById('Testis-l').selectedIndex = 1;
   document.getElementById('Testis-r').selectedIndex = 1;
 } else if (document.getElementById('gender').selectedIndex == 2) {
   document.getElementById('Breasts-l').selectedIndex = 1;
   document.getElementById('Breasts-r').selectedIndex = 1;
   document.getElementById('Uterus').selectedIndex = 1;
   document.getElementById('Ovary-l').selectedIndex = 1;
   document.getElementById('Ovary-r').selectedIndex = 1;
   document.getElementById('Cervix').selectedIndex = 1;
   document.getElementById('Vagina').selectedIndex = 1;
   document.getElementById('Penis').selectedIndex = 2;
   document.getElementById('Prostate').selectedIndex = 2;
   document.getElementById('Testis-l').selectedIndex = 2;
   document.getElementById('Testis-r').selectedIndex = 2;
 } else {
   document.getElementById('Breasts-l').selectedIndex = 0;
   document.getElementById('Breasts-r').selectedIndex = 0;
   document.getElementById('Uterus').selectedIndex = 0;
   document.getElementById('Ovary-l').selectedIndex = 0;
   document.getElementById('Ovary-r').selectedIndex = 0;
   document.getElementById('Penis').selectedIndex = 0;
   document.getElementById('Prostate').selectedIndex = 0;
   document.getElementById('Testis-l').selectedIndex = 0;
   document.getElementById('Testis-r').selectedIndex = 0;
 }
}

function showIPS() {
  const elements = document.getElementsByClassName('ips');
  for (const element of elements) {
    element.style.display = 'inline';
  }
}

// What to do with the document - submit, download, share - is the IPS module's document
// actions (doc-actions.js), which offer it once the server says it is a minimal IPS. The
// PDF is the user view (#htmlview), with the document and the advance care directive attached.
function setupDocActions() {
  window.patientDocActions = window.IpsDocActions.create(document.getElementById('docActions'), window.PATIENT_EDITOR.actions, {
    html: function () { return document.querySelector('#htmlview').innerHTML; },
    attachments: function () {
      const f = document.querySelector('#myfile').files[0];
      return f ? [{ name: f.name, file: f, description: 'Advance Care Directive' }] : [];
    }
  });
}

document.addEventListener('DOMContentLoaded', function() {
  setupDocActions();
  document.getElementById('ipsUpload').addEventListener('change', handleIPSUpload);
  // any change to the form makes the document again (an autocomplete choice sets data the
  // input event doesn't see; adding a row only matters once something is in it)
  const form = document.getElementById('form');
  form.addEventListener('input', function () { scheduleGenerate(); });
  form.addEventListener('change', function () { scheduleGenerate(); });
  if (window.jQuery) {
    window.jQuery(form).on('autocompleteselect', function () { scheduleGenerate(); });
  }
  scheduleGenerate(0);
});

async function handleIPSUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  try {
    setLoadStatus('loading', 'Loading IPS document...');
    const fileContent = await readFileAsText(file);

    let ipsData;
    try {
      ipsData = JSON.parse(fileContent);
    } catch (parseError) {
      throw new Error('Invalid JSON file. Please select a valid IPS document.');
    }

    await loadIPSBundle(ipsData, file.name);
  } catch (error) {
    console.error('Error loading IPS:', error);
    setLoadStatus('error', 'Error loading IPS: ' + error.message);
  }
}

/*
 * Shared load path for an IPS Bundle from any source - file upload (above), or a
 * SMART Health Link (see shl-in.js). Validates the bundle, fills in the form,
 * renders the document, and reports success. Throws on invalid content.
 */
async function loadIPSBundle(ipsData, sourceLabel) {
  // Validate it's an IPS document
  if (!ipsData || ipsData.resourceType !== 'Bundle') {
    throw new Error('This does not appear to be a valid IPS Bundle document.');
  }

  // Check for Composition resource with IPS type
  const hasComposition = ipsData.entry?.some(entry =>
    entry.resource?.resourceType === 'Composition' &&
    entry.resource?.type?.coding?.some(coding => coding.code === '60591-5')
  );

  if (!hasComposition) {
    throw new Error('This does not appear to be a valid IPS document (missing IPS Composition).');
  }

  // Clear the form first
  clearForm();

  // Parse and populate the form
  const form = new FormData(document.querySelector('#form'));
  await parseIPS(ipsData, form);

  // Populate the actual form fields in the DOM
  populateFormFields(form);

  // Say in the console what of the document didn't make it into the form. Never let
  // a problem in the bookkeeping break an import that otherwise worked.
  try {
    ipsCoverage.report(sourceLabel);
  } catch (e) {
    console.warn('Could not produce the IPS coverage report', e);
  }

  // the document is made again from the form, as for any change (what the form can't hold
  // is not in it: the coverage report in the console says what that is)
  scheduleGenerate(0);

  setLoadStatus('ok', '✓ IPS document "' + (sourceLabel || 'document') + '" loaded into the form. Anything in it the form cannot hold is not in the document made from the form.');

  // Switch to the AboutMe tab to show populated data
  if (typeof openTab === 'function') {
    setTimeout(() => openTab(null, 'AboutMe'), 100);
  }

  return ipsData;
}

/*
 * Single place to report progress/errors for loading a document from any source.
 * kind is one of 'loading', 'ok', 'error', or '' to clear.
 */
function setLoadStatus(kind, message) {
  const statusDiv = document.getElementById('uploadStatus');
  if (!statusDiv) return;
  statusDiv.innerHTML = '';
  if (!kind || !message) return;
  const div = document.createElement('div');
  if (kind === 'loading') {
    div.style.color = '#666';
    div.style.fontStyle = 'italic';
  } else if (kind === 'ok') {
    div.style.color = 'green';
    div.style.fontWeight = 'bold';
  } else {
    div.style.color = 'red';
    div.style.fontWeight = 'bold';
  }
  div.textContent = message;
  statusDiv.appendChild(div);
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.onerror = e => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
}

function clearForm() {
  // Clear all text inputs
  document.getElementById('form').querySelectorAll('input[type="text"]').forEach(input => {
    input.value = '';
    // Clear any stored concept data from autocomplete
    if (window.$ && $(input).removeData) {
      $(input).removeData('selected-concept');
    }
  });

  // Clear all textareas
  document.getElementById('form').querySelectorAll('textarea').forEach(textarea => {
    textarea.value = '';
  });

  // Reset all selects to their first option
  document.getElementById('form').querySelectorAll('select').forEach(select => {
    select.selectedIndex = 0;
  });

  // Clear all checkboxes
  document.getElementById('form').querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
    checkbox.checked = false;
  });

  // Clear all radio buttons
  document.getElementById('form').querySelectorAll('input[type="radio"]').forEach(radio => {
    radio.checked = false;
  });

  // Clear file input
  const fileInput = document.getElementById('form').querySelector('#myfile');
  if (fileInput) {
    fileInput.value = '';
  }

  // Reset dynamic counters to 1
  if (typeof window.allergyCount !== 'undefined') window.allergyCount = 1;
  if (typeof window.issueCount !== 'undefined') window.issueCount = 1;
  if (typeof window.medicationCount !== 'undefined') window.medicationCount = 1;
  if (typeof window.eventCount !== 'undefined') window.eventCount = 1;
  if (typeof window.goalCount !== 'undefined') window.goalCount = 1;

  // Remove dynamically added rows (keep only the first row of each type)
  removeExtraRows('ai-issue-', 1);
  removeExtraRows('tr-issue-', 1);
  removeExtraRows('tr-medication-', 1);
  removeExtraRows('tr-event-', 1);
  removeExtraRows('tr-goal-', 1);
}

function removeExtraRows(prefix, keepCount) {
  let counter = keepCount + 1;
  let element = document.getElementById(prefix + counter);
  while (element) {
    element.remove();
    counter++;
    element = document.getElementById(prefix + counter);
  }
}

function populateFormFields(formData) {
  // First, handle dynamic fields that might need extra rows
  handleDynamicFields(formData);

  // Then populate form fields from the FormData object
  for (const [key, value] of formData.entries()) {
    const elements = document.querySelectorAll(`[name="${key}"]`);

    elements.forEach(element => {
      if (element.type === 'checkbox') {
        element.checked = (value === 'true' || value === true || value === 'on');
      } else if (element.type === 'radio') {
        if (element.value === value) {
          element.checked = true;
        }
      } else if (element.tagName === 'SELECT') {
        // For select elements, try to find the matching option
        for (let i = 0; i < element.options.length; i++) {
          if (element.options[i].value === value) {
            element.selectedIndex = i;
            break;
          }
        }
      } else if (element.tagName === 'TEXTAREA' || element.type === 'text') {
        element.value = value;
      }
    });
  }
}

function handleDynamicFields(formData) {
  // Handle multiple allergies
  const allergyFields = [];
  const medicationFields = [];
  const issueFields = [];
  const eventFields = [];
  const goalFields = [];

  // Collect all dynamic fields
  for (const [key, value] of formData.entries()) {
    if (key.match(/^ai\d+$/)) {
      const num = parseInt(key.replace('ai', ''));
      allergyFields.push(num);
    } else if (key.match(/^medication\d+$/)) {
      const num = parseInt(key.replace('medication', ''));
      medicationFields.push(num);
    } else if (key.match(/^issue\d+$/)) {
      const num = parseInt(key.replace('issue', ''));
      issueFields.push(num);
    } else if (key.match(/^event\d+$/)) {
      const num = parseInt(key.replace('event', ''));
      eventFields.push(num);
    } else if (key.match(/^care-goal-\d+$/)) {
      const num = parseInt(key.replace('care-goal-', ''));
      goalFields.push(num);
    }
  }

  // Add rows as needed
  const maxAllergy = Math.max(...allergyFields, 0);
  const maxMedication = Math.max(...medicationFields, 0);
  const maxIssue = Math.max(...issueFields, 0);
  const maxEvent = Math.max(...eventFields, 0);
  const maxGoal = Math.max(...goalFields, 0);

  // Add additional rows (functions should be available from existing code)
  while (window.allergyCount < maxAllergy && typeof addAllergy === 'function') {
    addAllergy();
  }
  while (window.medicationCount < maxMedication && typeof addMedication === 'function') {
    addMedication();
  }
  while (window.issueCount < maxIssue && typeof addIssue === 'function') {
    addIssue();
  }
  while (window.eventCount < maxEvent && typeof addEvent === 'function') {
    addEvent();
  }
  while (window.goalCount < maxGoal && typeof addGoal === 'function') {
    addGoal();
  }
}