async function parseIPS(ips, form) {
  // Track what of this document we manage to use, so we can say afterwards what we
  // dropped. See ips-coverage.js; passport.js prints the result.
  ipsCoverage.start(ips);

  // First find the composition
  const composition = ipsCoverage.resourcesOfType(ips, "Composition")[0];
  if (!composition) {
    throw new Error("No Composition resource found in IPS document");
  }
  ipsCoverage.used(composition, 'document title and sections');

  // Find the patient
  let patient = findResource(ips, composition.subject);
  if (!patient) {
    // Documents built elsewhere reference the patient in ways we may not be able to
    // resolve (an unregistered urn:uuid, a server we can't see, no subject at all).
    // An IPS has exactly one subject, so if there's exactly one Patient in the
    // bundle, that's who this is about.
    const patients = ipsCoverage.resourcesOfType(ips, "Patient");
    if (patients.length === 1) {
      patient = patients[0];
    }
  }
  if (!patient) {
    throw new Error("Patient resource not found");
  }
  ipsCoverage.seen(patient);
  const patientBefore = ipsCoverage.snapshot(form);

  // Parse patient demographics. Not every system sends name.text, so fall back to
  // assembling the name from its parts rather than importing the patient unnamed.
  const patientName = patient.name?.[0];
  const patientNameText = patientName?.text ||
    [(patientName?.given || []).join(' '), patientName?.family].filter(part => part).join(' ');
  if (patientNameText) {
    form.set('name', patientNameText);
  }
  if (composition.author?.[0]?.display) {
    form.set('author', composition.author[0].display);
  }

  if (patient.birthDate) {
    form.set('dob', patient.birthDate);
  }

  if (patient.identifier?.[0]?.value) {
    form.set('id', patient.identifier[0].value);
  }

  if (patient.address?.[0]?.country) {
    form.set('country', patient.address[0].country);
  }

  // Handle gender identity and pronouns from extensions
  
    // Handle gender identity
    const genderIdentityExt = patient.extension?.find(e => 
      e.url === "http://hl7.org/fhir/StructureDefinition/individual-genderIdentity"
    );

    if (genderIdentityExt) {
      const coding = genderIdentityExt.extension?.[0]?.valueCodeableConcept?.coding?.[0];
      if (coding) {
        // Handle coded values
        switch(coding.code) {
          case '446141000124107': form.set('gender', 'f'); break;  // Female
          case '446151000124109': form.set('gender', 'm'); break;  // Male
          case '33791000087105': form.set('gender', 'n'); break;   // Non-binary
          case 'asked-declined': form.set('gender', 'u'); break;   // Decline to answer
        }
      } else if (genderIdentityExt.extension?.[0]?.valueCodeableConcept?.text) {
        // Handle free text value
        form.set('gender', '');  // Clear the select
        form.set('gender-other', genderIdentityExt.extension[0].valueCodeableConcept.text);
      }
    }

  const pronounsExt = patient.extension?.find(e => 
    e.url === "http://hl7.org/fhir/StructureDefinition/individual-pronouns"
  );

  if (pronounsExt) {
    const pronounsCoding = pronounsExt.extension?.[0]?.valueCodeableConcept?.coding?.[0];
    if (pronounsCoding) {
      switch(pronounsCoding.code) {
        case 'LA29519-8': form.set('pronouns', 'f'); break;
        case 'LA29518-0': form.set('pronouns', 'm'); break;
        case 'LA29520-6': form.set('pronouns', 'o'); break;
      }
    } else if (pronounsExt.extension?.[0]?.valueCodeableConcept?.text) {
      form.set('pronouns-other', pronounsExt.extension[0].valueCodeableConcept.text);
    }
  }

  // Handle sex characteristics
  const sexCharExt = patient.extension?.find(e =>
    e.url === "http://healthintersections.com.au/fhir/StructureDefinition/sex-characteristic-variation"
  );
  
  if (sexCharExt?.valueCodeableConcept?.coding?.[0]) {
    switch(sexCharExt.valueCodeableConcept.coding[0].code) {
      case '1': form.set('sexchar', 'y'); break;
      case '2': form.set('sexchar', 'n'); break;
      case '3': form.set('sexchar', 'u'); break;
    }
  }

  // Handle sex characteristics
  const sexCharDetailsExt = patient.extension?.find(e =>
    e.url === "http://healthintersections.com.au/fhir/StructureDefinition/sex-characteristic-variation-details"
  );
  
  if (sexCharDetailsExt?.valueString) {
    form.set('sex-variance', sexCharDetailsExt.valueString); 
  }

  // Handle cultural background
  const cultureExt = patient.extension?.find(e =>
    e.url === 'http://healthintersections.com.au/fhir/StructureDefinition/patient-cultural-background'
  );
  if (cultureExt?.valueString) {
    form.set('culture', cultureExt.valueString);
  }

  // Handle Community
  const communityExt = patient.extension?.find(e =>
    e.url === 'http://healthintersections.com.au/fhir/playground/StructureDefinition/community'
  );
  if (communityExt?.valueString) {
    form.set('community', communityExt.valueString);
  }

  // Handle Religion
  const religionExt = patient.extension?.find(e =>
    e.url === 'http://hl7.org/fhir/StructureDefinition/patient-religion'
  );
  if (religionExt?.valueCodeableConcept) {
    switch(religionExt.valueCodeableConcept.text) {
      case 'Not important': form.set('religion', 'n'); break;
      case 'Christian': form.set('religion', 'x'); break;
      case 'Muslim': form.set('religion', 'm'); break;
      case 'Hindu': form.set('religion', 'h'); break;
      case 'Buddhist': form.set('religion', 'b'); break;
      case 'Other': form.set('religion', 'n'); break;
    }
    if (religionExt.valueCodeableConcept.coding) {
      var coding = religionExt.valueCodeableConcept.coding[0];
      const religionInput = document.getElementById('religion-code');
      $(religionInput).data('selected-concept', {
        code: coding.code,
        system: coding.system
      });
      form.set('religion-code', coding);
    }
  }

  // Handle languages - goes after patient demographics section
  if (patient.communication) {
    // Find preferred language
    const preferredLang = patient.communication.find(c => c.preferred)?.language?.text;
    if (preferredLang) {
      form.set('language', preferredLang);
    }
    
    // Check if any language is English
    const hasEnglish = patient.communication.some(c => {
      const lang = c.language?.text?.toLowerCase();
      return lang === 'english' || lang === 'en';
    });
    if (hasEnglish) {
      form.set('english', 'true');
    }
  }

  // Handle contact information
  patient.telecom?.forEach(telecom => {
    if (telecom.system === 'email') {
      form.set('email', telecom.value);
    } else if (telecom.system === 'phone') {
      if (telecom.use === 'mobile') {
        form.set('mobile', telecom.value);
      } else {
        form.set('phone', telecom.value);
      }
    }
  });

  // Handle next of kin
  if (patient.contact?.[0]) {
    const nok = patient.contact[0];
    if (nok.name?.text) {
      form.set('nok', nok.name.text);
    }
    
    nok.telecom?.forEach(telecom => {
      if (telecom.system === 'email') {
        form.set('nokemail', telecom.value);
      } else if (telecom.system === 'phone') {
        if (telecom.use === 'mobile') {
          form.set('nokmobile', telecom.value);
        } else {
          form.set('nokphone', telecom.value);
        }
      }
    });
  }

  var myStorySect = findCompositionSection(composition, 'http://loinc.org', '81338-6');
  if (myStorySect) {
    const storyExt = myStorySect.extension?.find(e =>
      e.url === 'http://healthintersections.com.au/fhir/StructureDefinition/patient-story'
    );
    if (storyExt?.valueString) {
      form.set('story', storyExt.valueString);
    }
    let goalCount = 1;
    ipsCoverage.resourcesOfType(ips, "Goal").forEach(goal => {
      const goalBefore = ipsCoverage.snapshot(form);
      if (goal.description?.text) {
        if (goalCount > 1) {
          addGoal();
        }
        form.set('care-goal-' + goalCount, goal.description.text);
        if (hasCodeCC(goal.achievementStatus, "http://terminology.hl7.org/CodeSystem/goal-achievement", "in-progress")) {
          form.set('care-goal-state-' + goalCount, 'true');
        }
        goalCount++;
      }
      ipsCoverage.recordChange(form, goalBefore, goal, 'Goal has no description.text');
    })
  }

  // Parse health conditions
  let issueCount = 1;
  ipsCoverage.resourcesOfType(ips, "Condition").forEach(condition => {
    const clinicalStatus = condition.clinicalStatus?.coding?.[0]?.code;
    const isOrganInventory = condition.category?.some(cat => cat.coding?.[0]?.code === 'organ-inventory');
    if (isOrganInventory) {
      return; // handled by parseBodyParts
    }
    if (clinicalStatus !== 'active') {
      ipsCoverage.unmapped(condition, "clinicalStatus is '" + (clinicalStatus || 'absent') +
        "' - only active conditions become health issues");
      return;
    }
    // Documents from elsewhere often code the condition without a text element
    const conditionText = condition.code?.text || ipsCoverage.conceptText(condition.code);
    if (!conditionText) {
      ipsCoverage.unmapped(condition, 'Condition.code has no text, display or code to show');
      return;
    }
    form.set('issue' + issueCount, conditionText);
    if (condition.severity) {
      switch(condition.severity.coding?.[0]?.code) {
        case '24484000': form.set('issueLevel' + issueCount, 'm'); break;
        case '6736007': form.set('issueLevel' + issueCount, 'c'); break;
        case '255604002': form.set('issueLevel' + issueCount, 'b'); break;
        default:
          ipsCoverage.note('Codes with no mapping', 'Condition severity ' +
            ipsCoverage.codesOf(condition.severity).join(', ') + ' on "' + conditionText + '"');
      }
    }
    ipsCoverage.used(condition, 'issue' + issueCount);
    issueCount++;
  });

  // Parse medications
  let medCount = 1;
  ipsCoverage.resourcesOfType(ips, "MedicationStatement").forEach(med => {
    if (med.status !== 'active') {
      ipsCoverage.unmapped(med, "status is '" + (med.status || 'absent') + "' - only active medications are imported");
      return;
    }
    // R4 puts the concept in medicationCodeableConcept, R5 in medication.concept, and
    // either can reference a separate Medication resource instead of coding it inline
    const concept = med.medicationCodeableConcept || med.medication?.concept ||
      findResource(ips, med.medicationReference || med.medication?.reference)?.code;
    const medText = concept?.text || ipsCoverage.conceptText(concept);
    if (!medText) {
      ipsCoverage.unmapped(med, 'no medication name could be found on this resource');
      return;
    }
    form.set('medication' + medCount, medText);
    if (med.dosage?.[0]?.text) {
      form.set('dosage' + medCount, med.dosage[0].text);
    } else if (med.dosage?.length) {
      ipsCoverage.note('Partly imported', 'Dosage for "' + medText + '" has no text element, so no dosage was imported');
    }
    ipsCoverage.used(med, 'medication' + medCount);
    medCount++;
  });

  // Parse care directives and consents
  ipsCoverage.resourcesOfType(ips, "Consent").forEach(consent => {
    const consentBefore = ipsCoverage.snapshot(form);
    if (consent.provision?.code?.[0]?.coding?.[0]) {
      const coding = consent.provision.code[0].coding[0];
      switch(coding.code) {
        case '439569004': // DNR
          form.set('dnr', consent.provision.type === 'deny');
          break;
        case '1148553005': // Organ donor
          form.set('donor', consent.provision.type === 'permit');
          break;
        case '116859006': // Blood transfusion
          form.set('bld', consent.provision.type === 'permit');
          break;
      }
    }
    ipsCoverage.recordChange(form, consentBefore, consent, function () {
      return 'consent code ' + (ipsCoverage.codesOf(consent.provision?.code?.[0]).join(', ') || '(none)') +
        ' is not one of the three this form asks about (DNR, organ donation, transfusion)';
    });
  });

  // Parse care advocate
  const relatedPeople = ipsCoverage.resourcesOfType(ips, "RelatedPerson");
  const relatedPerson = relatedPeople[0];
  relatedPeople.slice(1).forEach(extra => {
    ipsCoverage.unmapped(extra, 'the form has room for one care advocate, and an earlier RelatedPerson filled it');
  });
  if (relatedPerson) {
    const advocateBefore = ipsCoverage.snapshot(form);
    if (relatedPerson.name?.[0]?.text) {
      form.set('caname', relatedPerson.name[0].text);
    }
    
    relatedPerson.telecom?.forEach(telecom => {
      if (telecom.system === 'email') {
        form.set('caemail', telecom.value);
      } else if (telecom.system === 'phone') {
        if (telecom.use === 'mobile') {
          form.set('camobile', telecom.value);
        } else {
          form.set('caphone', telecom.value);
        }
      }
    });

    if (relatedPerson.relationship?.[0]?.coding?.[0]?.code === 'HPOWATT') {
      form.set('calegal', 'true');
    }
    ipsCoverage.recordChange(form, advocateBefore, relatedPerson, 'no name or contact details on this RelatedPerson');
  }

// Parse functional status conditions
  const functionalStatusMapping = {
    '397540003': 'concern-visual',      // Visual impairment
    '15188001': 'concern-audio',        // Hearing impaired
    '386806002': 'concern-cognition',   // Impaired cognition
    '29164008': 'concern-speaking',     // Speech impairment
    '82971005': 'concern-mobility',     // Impaired mobility
    '93461009': 'concern-gender',       // Gender dysphoria
    '386807006': 'concern-memory',      // Memory impairment
    '161472001': 'concern-trauma',      // History of psychological trauma
    '1144748009': 'concern-focus',      // Impaired concentration
    '32709003': 'concern-addiction',    // Addiction
    '5794003': 'concern-city',          // Country dweller

    '110292000': 'eating',              // Difficulty eating
    '284911003': 'toileting',           // Difficulty using toilet
    '301666002': 'bed-exit',            // Difficulty getting on and off a bed
    '301685004': 'bed-in',              // Difficulty moving in bed
    '72440003': 'orientation',          // Disorientated in place
    '284977008': 'dressing',            // Difficulty dressing
    '284807005': 'bathing',             // Difficulty bathing self
    '715037005': 'meds',                // Difficulty taking medication
    '309253009': 'reading',             // Difficulty reading

    '105506000': 'dog',                 // Dependence on seeing eye dog
    '105503008': 'wheelchair',          // Dependence on wheelchair
    '719369003': 'comm-device'          // Uses communication device
  };

// Look for Condition resources with functional-status-issue category
  ipsCoverage.resourcesOfType(ips, "Condition").filter(condition =>
    condition.category?.some(cat =>
      cat.coding?.some(coding =>
        coding.system === 'http://healthintersections.com.au/fhir/CodeSystem/random-codes' &&
        coding.code === 'functional-status-issue'
      )
    )
  ).forEach(condition => {
    const snomedCode = condition.code?.coding?.find(coding =>
      coding.system === 'http://snomed.info/sct'
    )?.code;

    if (snomedCode && functionalStatusMapping[snomedCode]) {
      form.set(functionalStatusMapping[snomedCode], 'true');
      ipsCoverage.used(condition, functionalStatusMapping[snomedCode]);
    } else if (snomedCode) {
      ipsCoverage.unmapped(condition, 'SNOMED ' + snomedCode + ' ("' +
        (ipsCoverage.conceptText(condition.code) || 'no display') +
        '") is not one of the care needs this form asks about');
    }
  });

// Handle free text functional status condition
  ipsCoverage.resourcesOfType(ips, "Condition").filter(condition =>
    condition.category?.some(cat =>
      cat.coding?.some(coding =>
        coding.system === 'http://healthintersections.com.au/fhir/CodeSystem/random-codes' &&
        coding.code === 'functional-status-issue'
      )
    ) &&
    condition.code?.text &&
    !condition.code?.coding?.some(coding => coding.system === 'http://snomed.info/sct')
  ).forEach(condition => {
    if (condition.code?.text) {
      form.set('text', condition.code.text);
      ipsCoverage.used(condition, 'text');
    }
  });
  parseBodyParts(ips, form);
  parseReproductiveStuff(ips, form);

  reportPatientCoverage(patient, patientBefore, form);
  reportSectionCoverage(ips, composition);
}

/*
 * What this form reads off a Patient. Everything else in the resource is dropped,
 * which is worth saying out loud when the document came from somewhere else.
 */
const PATIENT_ELEMENTS_READ = ['name', 'birthDate', 'identifier', 'address', 'extension',
  'communication', 'telecom', 'contact'];
const PATIENT_ELEMENTS_STRUCTURAL = ['resourceType', 'id', 'meta', 'implicitRules', 'language',
  'text', 'contained', 'modifierExtension'];
const PATIENT_EXTENSIONS_READ = [
  'http://hl7.org/fhir/StructureDefinition/individual-genderIdentity',
  'http://hl7.org/fhir/StructureDefinition/individual-pronouns',
  'http://healthintersections.com.au/fhir/StructureDefinition/sex-characteristic-variation',
  'http://healthintersections.com.au/fhir/StructureDefinition/sex-characteristic-variation-details',
  'http://healthintersections.com.au/fhir/StructureDefinition/patient-cultural-background',
  'http://healthintersections.com.au/fhir/playground/StructureDefinition/community',
  'http://hl7.org/fhir/StructureDefinition/patient-religion'
];

function reportPatientCoverage(patient, before, form) {
  ipsCoverage.recordChange(form, before, patient, 'no demographics could be read from this Patient');

  const unread = Object.keys(patient).filter(key =>
    PATIENT_ELEMENTS_READ.indexOf(key) < 0 && PATIENT_ELEMENTS_STRUCTURAL.indexOf(key) < 0);
  if (unread.length) {
    ipsCoverage.note('Patient elements not imported', unread.join(', '));
  }

  (patient.extension || []).forEach(extension => {
    if (PATIENT_EXTENSIONS_READ.indexOf(extension.url) < 0) {
      ipsCoverage.note('Patient extensions not imported', extension.url);
    }
  });

  if (patient.name?.length > 1) {
    ipsCoverage.note('Partly imported', 'Patient has ' + patient.name.length + ' names; only the first was imported');
  }
  if (patient.identifier?.length > 1) {
    ipsCoverage.note('Partly imported', 'Patient has ' + patient.identifier.length + ' identifiers; only the first was imported');
  }
  if (patient.contact?.length > 1) {
    ipsCoverage.note('Partly imported', 'Patient has ' + patient.contact.length + ' contacts; only the first became next of kin');
  }
  const address = patient.address?.[0];
  if (address) {
    const ignored = Object.keys(address).filter(key => key !== 'country');
    if (ignored.length) {
      ipsCoverage.note('Partly imported', 'Patient address: only country was imported (also present: ' + ignored.join(', ') + ')');
    }
  }
}

/*
 * Section by section, how much of what the document says is in that section actually
 * reached the form. This is the view that matters: a document can have an Allergies
 * section with six entries and the form will show none of them.
 */
function reportSectionCoverage(ips, composition, sections, prefix) {
  (sections || composition.section || []).forEach(section => {
    const title = section.title || ipsCoverage.conceptText(section.code) || '(untitled section)';
    const codes = ipsCoverage.codesOf(section.code).join(', ');
    const label = (prefix || '') + title + (codes ? ' [' + codes + ']' : '');
    const refs = section.entry || [];

    if (!refs.length) {
      ipsCoverage.note('Document sections', label + ': no entries');
    } else {
      let imported = 0;
      let unresolved = 0;
      refs.forEach(ref => {
        const resource = findResource(ips, ref);
        if (!resource) {
          unresolved++;
        } else if (ipsCoverage.stateOf(resource) === ipsCoverage.IMPORTED) {
          imported++;
        }
      });
      let detail = label + ': ' + imported + ' of ' + refs.length + ' entries imported';
      if (unresolved) {
        detail += ' (' + unresolved + ' reference(s) not resolvable in this bundle)';
      }
      ipsCoverage.note('Document sections', detail);
    }

    if (section.section?.length) {
      reportSectionCoverage(ips, composition, section.section, label + ' > ');
    }
  });
}

function findCompositionSection(composition, system, code) {
  return composition.section?.find(section => 
    section.code?.coding?.some(coding =>
      coding.system === system && coding.code === code
    )
  );
}

function hasCodeCC(cc, system, code) {
  return cc?.coding?.some(coding => 
      coding.system === system && coding.code === code
  ) || false;
}

function parseBodyParts(ips, form) {
  const bodyPartMapping = {
    // Arms and hands
    '368208006': 'Arm-l',     // Left upper arm structure
    '368209003': 'Arm-r',     // Right upper arm structure
    '85151006': 'Hand-l',     // Structure of left hand
    '78791008': 'Hand-r',     // Structure of right hand
    '786841006': 'Fingers-l', // Structure of all fingers of left hand
    '786842004': 'Fingers-r', // Structure of all fingers of right hand

    // Legs and feet
    '48979004': 'Leg-l',      // Structure of left lower leg (also used for Calf-l)
    '32696007': 'Leg-r',      // Structure of right lower leg (also used for Calf-r)
    '22335008': 'Foot-l',     // Structure of left foot
    '7769000': 'Foot-r',      // Structure of right foot
    '785708006': 'Toe-l',     // Structure of all toes of left foot
    '785709003': 'Toe-r',     // Structure of all toes of right foot

    // Hip and other limb structures
    '287679003': 'Hip-l',     // Left hip region structure
    '287579007': 'Hip-r',     // Right hip region structure

    // Head and neck
    '1290041000': 'Eye-l',    // Entire left eye proper
    '1290043002': 'Eye-r',    // Entire right eye proper
    '67923007': 'Hypothalamus', // Hypothalamic structure
    '56329008': 'Pituitary',  // Pituitary structure
    '21974007': 'Tongue',     // Tongue structure
    '661005': 'Jaw',          // Jaw region structure
    '725037009': 'salgland-l', // Left salivary gland
    '725038004': 'salgland-r', // Right salivary gland

    // Digestive system
    '32849002': 'Oesophagus', // Esophageal structure
    '71854001': 'LargeColon', // Colon structure
    '69695003': 'Stomach',    // Stomach structure
    '28231008': 'GallBladder', // Gallbladder structure

    // Urinary system
    '18639004': 'Kidney-l',   // Left kidney structure
    '9846003': 'Kidney-r',    // Right kidney structure
    '10200004': 'Liver',      // Liver structure
    '89837001': 'Bladder',    // Urinary bladder structure

    // Respiratory system
    '44029006': 'Lung-l',     // Left lung structure
    '3341006': 'Lung-r',      // Right lung structure

    // Reproductive system - female
    '80248007': 'Breasts-l',  // Left breast structure
    '73056007': 'Breasts-r',  // Right breast structure
    '43981004': 'Ovary-l',    // Structure of left ovary
    '20837000': 'Ovary-r',    // Structure of right ovary
    '35039007': 'Uterus',     // Uterine structure
    '71252005': 'Cervix',     // Cervix uteri structure
    '76784001': 'Vagina',     // Vaginal structure

    // Reproductive system - male
    '18911002': 'Penis',      // Penile structure
    '41216001': 'Prostate',   // Prostatic structure
    '63239009': 'Testis-l',   // Structure of left testis
    '15598003': 'Testis-r'    // Structure of right testis
  };

  const statusMapping = {
    'present': 'p',
    'transplanted-in': 'a',
    'implant': 'i',
    'absent': 'g',
    'congenitally-absent': 'np',
    'partially-excised': 'pr',
    'excised': 'r',
    'lost': 'w'
  };

// Look for Observation resources with organ-inventory category
  ipsCoverage.resourcesOfType(ips, "Observation").filter(observation =>
    observation.category?.some(cat =>
      cat.coding?.some(coding =>
        coding.system === 'http://healthintersections.com.au/fhir/CodeSystem/random-codes' &&
        coding.code === 'organ-inventory'
      )
    )
  ).forEach(observation => {

    // Get the body site SNOMED code
    const bodySiteCode = observation.bodySite?.coding?.find(coding =>
      coding.system === 'http://snomed.info/sct'
    )?.code;

    // Get the status code
    const statusCode = observation.valueCodeableConcept?.coding?.find(coding =>
      coding.system === 'http://healthintersections.com.au/fhir/CodeSystem/random-codes'
    )?.code;

    // Map to form field and set the value
    if (bodySiteCode && statusCode && bodyPartMapping[bodySiteCode] && statusMapping[statusCode]) {
      const formFieldName = bodyPartMapping[bodySiteCode];
      const formValue = statusMapping[statusCode];
      form.set(formFieldName, formValue);
      ipsCoverage.used(observation, formFieldName);
    } else {
      ipsCoverage.unmapped(observation, 'organ inventory: body site ' +
        (bodySiteCode ? 'SNOMED ' + bodySiteCode : '(none found)') + ', status ' +
        (statusCode || '(none found)') + ' - no matching body part on the form');
    }
  });
}


function parseReproductiveStuff(ips, form) {
  ipsCoverage.resourcesOfType(ips, "Observation").forEach(observation => {
    const observationBefore = ipsCoverage.snapshot(form);
    const loincCode = observation.code?.coding?.find(coding =>
      coding.system === 'http://loinc.org'
    )?.code;

    const customCode = observation.code?.coding?.find(coding =>
      coding.system === 'http://healthintersections.com.au/fhir/CodeSystem/clinical'
    )?.code;

    const snomedCode = observation.code?.coding?.find(coding =>
      coding.system === 'http://snomed.info/sct'
    )?.code;

    // Handle LOINC-coded observations
    if (loincCode) {
      switch (loincCode) {
        case '82810-3': // Pregnancy status
          const pregnancyCode = observation.valueCodeableConcept?.coding?.find(coding =>
            coding.system === 'http://snomed.info/sct'
          )?.code;
          if (pregnancyCode) {
            form.set('pregnancy-status', pregnancyCode);
          }
          break;

        case '8665-2': // Last menstrual period start date
          if (observation.valueDateTime) {
            form.set('lmp', observation.valueDateTime);
          }
          break;

        case '11778-8': // Delivery date Estimated
          if (observation.valueDateTime) {
            form.set('edd', observation.valueDateTime);
          }
          break;

        case '8678-5': // Menstrual status - Reported
          const menstrualCode = observation.valueCodeableConcept?.coding?.find(coding =>
            coding.system === 'http://snomed.info/sct'
          )?.code;
          if (menstrualCode) {
            switch (menstrualCode) {
              case '22636003':
                form.set('menstruation-status', 'future');
                break;   // Premenopausal state
              case '289904000':
                form.set('menstruation-status', 'current');
                break; // Menopause absent
              case '289903006':
                form.set('menstruation-status', 'past');
                break;    // Menopause present
            }
          }
          break;
      }
    }

    // Handle SNOMED-coded observations for reproductive health
    if (snomedCode) {
      switch (snomedCode) {
        case '289887006': // Finding of frequency of menstruation
          const freqCode = observation.valueCodeableConcept?.coding?.find(coding =>
            coding.system === 'http://snomed.info/sct'
          )?.code;
          if (freqCode) {
            switch (freqCode) {
              case '14302001':
                form.set('period-frequency', 'absent');
                break;     // Amenorrhea
              case '289892008':
                form.set('period-frequency', 'frequent');
                break;  // Short menstrual cycle
              case '282027006':
                form.set('period-frequency', 'normal');
                break;    // Normal period
              case '52073004':
                form.set('period-frequency', 'infrequent');
                break; // Oligomenorrhea
            }
          }
          break;

        case '161720007': // Duration of menstrual flow
          const durationCode = observation.valueCodeableConcept?.coding?.find(coding =>
            coding.system === 'http://snomed.info/sct'
          )?.code;
          if (durationCode) {
            switch (durationCode) {
              case '17621005':
                form.set('period-duration', 'normal');
                break;    // Normal
              case '255224006':
                form.set('period-duration', 'prolonged');
                break; // Prolonged
            }
          }
          break;

        case '364307006': // Regularity of menstrual cycle
          const regularityCode = observation.valueCodeableConcept?.coding?.find(coding =>
            coding.system === 'http://snomed.info/sct'
          )?.code;
          if (regularityCode) {
            switch (regularityCode) {
              case '80182007':
                form.set('period-regularity', 'irregular');
                break; // Irregular periods
              case '302757007':
                form.set('period-regularity', 'regular');
                break;  // Regular periods
            }
          }
          break;

        case '248965005': // Regularity of menstrual periods (intermenstrual bleeding)
          const bleedingCode = observation.valueCodeableConcept?.coding?.find(coding =>
            coding.system === 'http://snomed.info/sct'
          )?.code;
          if (bleedingCode) {
            switch (bleedingCode) {
              case '78456001':
                form.set('period-bleeding', 'none');
                break;        // Normal menstrual cycle
              case '64996003':
                form.set('period-bleeding', 'random');
                break;      // Irregular intermenstrual bleeding
              case '237132003':
                form.set('period-bleeding', 'predictable');
                break; // Intermenstrual bleeding - regular
            }
          }
          break;
      }
    }

    // Handle custom coded observations
    if (customCode) {
      switch (customCode) {
        case 'period-volume': // Volume of Menstrual flow
          const volumeCode = observation.valueCodeableConcept?.coding?.find(coding =>
            coding.system === 'http://snomed.info/sct'
          )?.code;
          if (volumeCode) {
            switch (volumeCode) {
              case '386692008':
                form.set('period-volume', 'heavy');
                break;  // Menorrhagia
              case '282027006':
                form.set('period-volume', 'normal');
                break; // Normal period
              case '64206003':
                form.set('period-volume', 'light');
                break;   // Hypomenorrhea
            }
          }
          break;

        case 'iron-status': // Iron Status
          const ironCode = observation.valueCodeableConcept?.coding?.find(coding =>
            coding.system === 'http://healthintersections.com.au/fhir/CodeSystem/clinical'
          )?.code;
          if (ironCode) {
            switch (ironCode) {
              case 'iron-checked':
                form.set('period-iron', 'checked');
                break;
              case 'iron-unsure':
                form.set('period-iron', 'unsure');
                break;
              case 'iron-low':
                form.set('period-iron', 'low');
                break;
            }
          }
          break;

        case 'erectile-status': // Erectile Status
          const edCode = observation.valueCodeableConcept?.coding?.find(coding =>
            coding.system === 'http://snomed.info/sct'
          )?.code;
          if (edCode) {
            switch (edCode) {
              case '890316000':
                form.set('ed', 'fine');
                break;    // No erectile dysfunction
              case '860916000':
                form.set('ed', 'mild');
                break;    // Relative erectile dysfunction
              case '860914002':
                form.set('ed', 'problem');
                break; // Erectile dysfunction
            }
          }
          break;

        case 'urination-status': // Urination Status
          const urinationCode = observation.valueCodeableConcept?.coding?.find(coding =>
            coding.system === 'http://snomed.info/sct'
          )?.code;
          if (urinationCode) {
            switch (urinationCode) {
              case '102834005':
                form.set('urination', 'fine');
                break;    // Normal micturition
              case '249279003':
                form.set('urination', 'medium');
                break;  // Must strain to pass urine
              case '102835006':
                form.set('urination', 'serious');
                break; // Difficulty passing urine
            }
          }
          break;

        case 'prostate-screen': // Prostate Screen Recency
          const prostateCode = observation.valueCodeableConcept?.coding?.find(coding =>
            coding.system === 'http://healthintersections.com.au/fhir/CodeSystem/clinical'
          )?.code;
          if (prostateCode) {
            switch (prostateCode) {
              case 'prostate-never':
                form.set('prostate-screen', 'never');
                break;
              case 'prostate-recent':
                form.set('prostate-screen', 'recent');
                break;
              case 'prostate-older':
                form.set('prostate-screen', 'older');
                break;
              case 'prostate-unsure':
                form.set('prostate-screen', 'unsure');
                break;
            }
          }
          break;
      }
    }

    ipsCoverage.recordChange(form, observationBefore, observation, function () {
      const codes = ipsCoverage.codesOf(observation.code).join(', ');
      return 'Observation ' + (codes || '(uncoded)') +
        (ipsCoverage.conceptText(observation.code) ? ' "' + ipsCoverage.conceptText(observation.code) + '"' : '') +
        ' - this form has no field for it';
    });
  });
}