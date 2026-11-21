function populateFormPatient3() {
  // Grandmother with diabetes, early renal problems, 4 children, 3 grandchildren, new stage 2 breast cancer diagnosis
  resetForm();
  
  // About Me section
  const nameField = document.querySelector('[name="name"]');
  if (nameField) nameField.value = "Patricia Joan Henderson";
  const dobField = document.querySelector('[name="dob"]');
  if (dobField) dobField.value = "1952-11-08";
  const idField = document.querySelector('[name="id"]');
  if (idField) idField.value = "7529641038";
  const countryField = document.querySelector('[name="country"]');
  if (countryField) countryField.value = "AU";
  const emailField = document.querySelector('[name="email"]');
  if (emailField) emailField.value = "pat.henderson@outlook.com";
  const mobileField = document.querySelector('[name="mobile"]');
  if (mobileField) mobileField.value = "0423567891";
  
  // Next of Kin
  const nokField = document.querySelector('[name="nok"]');
  if (nokField) nokField.value = "David Henderson";
  const nokEmailField = document.querySelector('[name="nokemail"]');
  if (nokEmailField) nokEmailField.value = "david.henderson@telstra.com";
  const nokMobileField = document.querySelector('[name="nokmobile"]');
  if (nokMobileField) nokMobileField.value = "0419234567";
  
  // Cultural Identity
  const cultureField = document.querySelector('[name="culture"]');
  if (cultureField) cultureField.value = "Australian";
  const communityField = document.querySelector('[name="community"]');
  if (communityField) communityField.value = "Geelong, Victoria";
  const languageField = document.querySelector('[name="language"]');
  if (languageField) languageField.value = "English";
  const englishCheck = document.querySelector('[name="english"]');
  if (englishCheck) englishCheck.checked = true;
  const religionSelect = document.querySelector('#religion');
  if (religionSelect) religionSelect.value = "x";
  const religionCodeField = document.querySelector('#religion-code');
  if (religionCodeField) religionCodeField.value = "Anglican";
  
  // Gender
  const genderSelect = document.querySelector('#gender');
  if (genderSelect) genderSelect.value = "f";
  const pronounsSelect = document.querySelector('[name="pronouns"]');
  if (pronounsSelect) pronounsSelect.value = "f";
  const sexcharSelect = document.querySelector('#sexchar');
  if (sexcharSelect) sexcharSelect.value = "n";
  
  // My Story
  const storyField = document.querySelector('[name="story"]');
  if (storyField) storyField.value = "I'm a grandmother of three beautiful grandchildren and mother of four adult children. I was recently diagnosed with stage 2 breast cancer, which has been devastating news for our family. I also have type 2 diabetes and early kidney problems. I had stage 4 colon cancer 8 years ago and survived after major surgery. I'm determined to beat this cancer too, but I'm worried about how the treatment will affect my diabetes and kidneys. My family is my everything - I need to be here for my grandchildren.";
  
  // Goals
  const goal1 = document.querySelector('[name="care-goal-1"]');
  if (goal1) {
    goal1.value = "Successfully treat breast cancer while managing diabetes";
    const goal1State = document.querySelector('[name="care-goal-state-1"]');
    if (goal1State) goal1State.checked = false;
  }
  
  if (typeof addGoal === 'function') {
    addGoal();
    const goal2 = document.querySelector('[name="care-goal-2"]');
    if (goal2) goal2.value = "Maintain kidney function during cancer treatment";
    
    addGoal();
    const goal3 = document.querySelector('[name="care-goal-3"]');
    if (goal3) {
      goal3.value = "Stay involved in grandchildren's lives throughout treatment";
      const goal3State = document.querySelector('[name="care-goal-state-3"]');
      if (goal3State) goal3State.checked = true;
    }
  }
  
  // Care Planning - Daughter as legal power of attorney
  const caname = document.querySelector('[name="caname"]');
  if (caname) caname.value = "Sarah Henderson-Williams";
  const caemail = document.querySelector('[name="caemail"]');
  if (caemail) caemail.value = "sarah.williams@gmail.com";
  const camobile = document.querySelector('[name="camobile"]');
  if (camobile) camobile.value = "0456789234";
  const calegal = document.querySelector('[name="calegal"]');
  if (calegal) calegal.checked = true;
  
  // Medical Directives
  const dnrFalse = document.querySelector('[name="dnr"][value="false"]');
  if (dnrFalse) dnrFalse.checked = true;
  const donorTrue = document.querySelector('[name="donor"][value="true"]');
  if (donorTrue) donorTrue.checked = true;
  const bldTrue = document.querySelector('[name="bld"][value="true"]');
  if (bldTrue) bldTrue.checked = true;
  
  // Allergies
  const ai1 = document.querySelector('#ai1');
  if (ai1) ai1.value = "Morphine";
  const aiRxn1 = document.querySelector('#aiRxn1');
  if (aiRxn1) aiRxn1.value = "g";
  
  // Health Issues
  const issue1 = document.querySelector('#issue1');
  if (issue1) issue1.value = "Breast cancer stage 2";
  const issueLevel1 = document.querySelector('#issueLevel1');
  if (issueLevel1) issueLevel1.value = "m";
  
  if (typeof addIssue === 'function') {
    addIssue();
    const issue2 = document.querySelector('#issue2');
    if (issue2) issue2.value = "Type 2 diabetes mellitus";
    const issueLevel2 = document.querySelector('#issueLevel2');
    if (issueLevel2) issueLevel2.value = "c";
    
    addIssue();
    const issue3 = document.querySelector('#issue3');
    if (issue3) issue3.value = "Chronic kidney disease stage 2";
    const issueLevel3 = document.querySelector('#issueLevel3');
    if (issueLevel3) issueLevel3.value = "c";
    
    addIssue();
    const issue4 = document.querySelector('#issue4');
    if (issue4) issue4.value = "History of colorectal cancer";
    const issueLevel4 = document.querySelector('#issueLevel4');
    if (issueLevel4) issueLevel4.value = "b";
  }
  
  // Medications
  const medication1 = document.querySelector('#medication1');
  if (medication1) medication1.value = "Metformin";
  const dosage1 = document.querySelector('[name="dosage1"]');
  if (dosage1) dosage1.value = "1000mg twice daily";
  
  if (typeof addMedication === 'function') {
    addMedication();
    const medication2 = document.querySelector('#medication2');
    if (medication2) medication2.value = "Lisinopril";
    const dosage2 = document.querySelector('[name="dosage2"]');
    if (dosage2) dosage2.value = "10mg daily for kidney protection";
    
    addMedication();
    const medication3 = document.querySelector('#medication3');
    if (medication3) medication3.value = "Insulin glargine";
    const dosage3 = document.querySelector('[name="dosage3"]');
    if (dosage3) dosage3.value = "24 units at bedtime";
  }
  
  // Past Events
  const event1 = document.querySelector('#event1');
  if (event1) event1.value = "Colorectal cancer diagnosis and treatment";
  const eventWhen1 = document.querySelector('[name="event-when1"]');
  if (eventWhen1) eventWhen1.value = "2016";
  
  if (typeof addEvent === 'function') {
    addEvent();
    const event2 = document.querySelector('#event2');
    if (event2) event2.value = "Colectomy surgery";
    const eventWhen2 = document.querySelector('[name="event-when2"]');
    if (eventWhen2) eventWhen2.value = "2016-08";
    
    addEvent();
    const event3 = document.querySelector('#event3');
    if (event3) event3.value = "Type 2 diabetes diagnosis";
    const eventWhen3 = document.querySelector('[name="event-when3"]');
    if (eventWhen3) eventWhen3.value = "2018";
    
    addEvent();
    const event4 = document.querySelector('#event4');
    if (event4) event4.value = "Breast cancer diagnosis";
    const eventWhen4 = document.querySelector('[name="event-when4"]');
    if (eventWhen4) eventWhen4.value = "2024-12";
  }
  
  // Care Needs
  const concernMemory = document.querySelector('[name="concern-memory"]');
  if (concernMemory) concernMemory.checked = true;
  const meds = document.querySelector('[name="meds"]');
  if (meds) meds.checked = true;
  const orientation = document.querySelector('[name="orientation"]');
  if (orientation) orientation.checked = true;
  
  const careText = document.querySelector('[name="text"]');
  if (careText) careText.value = "I have a complex medical history and need careful coordination between my oncology, diabetes, and nephrology teams. I sometimes get confused with my multiple medications and need help organizing them.";
  
  // Body Parts (with error handling)
  if (typeof allPresent === 'function') {
    try {
      allPresent();
    } catch (error) {
      console.log("Error in allPresent function:", error);
      setOrganDefaults();
    }
    
    const largeColon = document.getElementById('LargeColon');
    if (largeColon) largeColon.selectedIndex = 7; // Surgically removed
  }
  
  // Reproductive health (with delay to ensure DOM is ready)
  setTimeout(() => {
    const pregnancyStatus = document.querySelector('#pregnancy-status');
    if (pregnancyStatus) pregnancyStatus.value = "60001007"; // Not pregnant
    const menstruationStatus = document.querySelector('#menstruation-status');
    if (menstruationStatus) menstruationStatus.value = "past";
  }, 100);
}// Patient Data Population Functions
// Replace the existing populateFormPatient1 and populateFormPatient2 functions with these 5 new patient scenarios

function resetForm() {
  // Reset all form fields to their default state
  const form = document.getElementById('form');
  if (form) form.reset();
  
  // Reset any dynamically added rows back to initial state
  if (typeof allergyCount !== 'undefined') allergyCount = 1;
  if (typeof issueCount !== 'undefined') issueCount = 1;
  if (typeof medicationCount !== 'undefined') medicationCount = 1;
  if (typeof eventCount !== 'undefined') eventCount = 1;
  if (typeof goalCount !== 'undefined') goalCount = 1;
  
  // Remove any dynamically added rows
  const dynamicRows = document.querySelectorAll('[id^="ai-issue-"]:not(#ai-issue-1), [id^="tr-issue-"]:not(#tr-issue-1), [id^="tr-medication-"]:not(#tr-medication-1), [id^="tr-event-"]:not(#tr-event-1), [id^="tr-goal-"]:not(#tr-goal-1)');
  dynamicRows.forEach(row => row.remove());
  
  // Reset all select elements to first option
  const selects = document.querySelectorAll('select');
  selects.forEach(select => select.selectedIndex = 0);
  
  // Clear all text inputs and textareas
  const inputs = document.querySelectorAll('input[type="text"], textarea');
  inputs.forEach(input => input.value = '');
  
  // Clear all checkboxes and radio buttons
  const checkboxes = document.querySelectorAll('input[type="checkbox"], input[type="radio"]');
  checkboxes.forEach(checkbox => checkbox.checked = false);
  
  // Reset gender to default male selection
  const genderSelect = document.querySelector('#gender');
  if (genderSelect) genderSelect.value = "m";
  const pronounsSelect = document.querySelector('[name="pronouns"]');
  if (pronounsSelect) pronounsSelect.value = "m";
}

function populateFormPatient1() {
  // Elderly man who's newly retired after a lifetime of hard labour
  resetForm();
  
  // About Me section
  document.querySelector('[name="name"]').value = "William Robert McKenzie";
  document.querySelector('[name="dob"]').value = "1955-03-15";
  document.querySelector('[name="id"]').value = "8472639581";
  document.querySelector('[name="country"]').value = "AU";
  document.querySelector('[name="email"]').value = "bill.mckenzie@bigpond.com";
  document.querySelector('[name="mobile"]').value = "0429876543";
  
  // Next of Kin
  document.querySelector('[name="nok"]').value = "Margaret McKenzie";
  document.querySelector('[name="nokemail"]').value = "maggie.mckenzie@gmail.com";
  document.querySelector('[name="nokmobile"]').value = "0438291756";
  
  // Cultural Identity
  document.querySelector('[name="culture"]').value = "Australian - Scottish heritage";
  document.querySelector('[name="community"]').value = "Ballarat, Victoria";
  document.querySelector('[name="language"]').value = "English";
  document.querySelector('[name="english"]').checked = true;
  document.querySelector('#religion').value = "x";
  document.querySelector('#religion-code').value = "Presbyterian";
  
  // Gender
  document.querySelector('#gender').value = "m";
  document.querySelector('[name="pronouns"]').value = "m";
  document.querySelector('#sexchar').value = "n";
  
  // My Story
  document.querySelector('[name="story"]').value = "I worked 45 years in construction and heavy industry before retiring last month. My body shows the wear - bad knees, sore back, and my hearing isn't what it used to be from all the machinery noise. I lost two fingers on my left hand and my appendix in a workplace accident back in '78. I'm looking forward to spending time with my grandkids and working in my garden, but I know I need to take better care of my health now. My wife Maggie keeps me on track with my medications.";
  
  // Goals
  const goal1 = document.querySelector('[name="care-goal-1"]');
  if (goal1) {
    goal1.value = "Manage arthritis pain to stay active";
    const goal1State = document.querySelector('[name="care-goal-state-1"]');
    if (goal1State) goal1State.checked = true;
  }
  
  // Add goals safely
  if (typeof addGoal === 'function') {
    addGoal();
    const goal2 = document.querySelector('[name="care-goal-2"]');
    if (goal2) goal2.value = "Improve hearing with proper aids";
    
    addGoal();
    const goal3 = document.querySelector('[name="care-goal-3"]');
    if (goal3) goal3.value = "Maintain independence in daily activities";
  }
  
  // Care Planning - Wife as care advocate
  const caname = document.querySelector('[name="caname"]');
  if (caname) caname.value = "Margaret McKenzie";
  const caemail = document.querySelector('[name="caemail"]');
  if (caemail) caemail.value = "maggie.mckenzie@gmail.com";
  const camobile = document.querySelector('[name="camobile"]');
  if (camobile) camobile.value = "0438291756";
  const calegal = document.querySelector('[name="calegal"]');
  if (calegal) calegal.checked = true;
  
  // Medical Directives
  const dnrFalse = document.querySelector('[name="dnr"][value="false"]');
  if (dnrFalse) dnrFalse.checked = true;
  const donorTrue = document.querySelector('[name="donor"][value="true"]');
  if (donorTrue) donorTrue.checked = true;
  const bldTrue = document.querySelector('[name="bld"][value="true"]');
  if (bldTrue) bldTrue.checked = true;
  
  // Allergies
  const ai1 = document.querySelector('#ai1');
  if (ai1) ai1.value = "Penicillin";
  const aiRxn1 = document.querySelector('#aiRxn1');
  if (aiRxn1) aiRxn1.value = "s";
  
  // Health Issues
  const issue1 = document.querySelector('#issue1');
  if (issue1) issue1.value = "Osteoarthritis of knees";
  const issueLevel1 = document.querySelector('#issueLevel1');
  if (issueLevel1) issueLevel1.value = "c";
  
  // Add more issues safely
  if (typeof addIssue === 'function') {
    addIssue();
    const issue2 = document.querySelector('#issue2');
    if (issue2) issue2.value = "Chronic lower back pain";
    const issueLevel2 = document.querySelector('#issueLevel2');
    if (issueLevel2) issueLevel2.value = "c";
    
    addIssue();
    const issue3 = document.querySelector('#issue3');
    if (issue3) issue3.value = "Hearing loss";
    const issueLevel3 = document.querySelector('#issueLevel3');
    if (issueLevel3) issueLevel3.value = "b";
  }
  
  // Medications
  const medication1 = document.querySelector('#medication1');
  if (medication1) medication1.value = "Paracetamol";
  const dosage1 = document.querySelector('[name="dosage1"]');
  if (dosage1) dosage1.value = "1000mg twice daily for arthritis pain";
  
  // Add more medications safely
  if (typeof addMedication === 'function') {
    addMedication();
    const medication2 = document.querySelector('#medication2');
    if (medication2) medication2.value = "Ibuprofen";
    const dosage2 = document.querySelector('[name="dosage2"]');
    if (dosage2) dosage2.value = "400mg as needed for inflammation";
  }
  
  // Past Events
  const event1 = document.querySelector('#event1');
  if (event1) event1.value = "Industrial accident - finger amputation and appendectomy";
  const eventWhen1 = document.querySelector('[name="event-when1"]');
  if (eventWhen1) eventWhen1.value = "1978";
  
  // Add more events safely
  if (typeof addEvent === 'function') {
    addEvent();
    const event2 = document.querySelector('#event2');
    if (event2) event2.value = "Retirement from construction work";
    const eventWhen2 = document.querySelector('[name="event-when2"]');
    if (eventWhen2) eventWhen2.value = "2024-11";
  }
  
  // Care Needs
  const concernAudio = document.querySelector('[name="concern-audio"]');
  if (concernAudio) concernAudio.checked = true;
  const concernMobility = document.querySelector('[name="concern-mobility"]');
  if (concernMobility) concernMobility.checked = true;
  const orientation = document.querySelector('[name="orientation"]');
  if (orientation) orientation.checked = true;
  const reading = document.querySelector('[name="reading"]');
  if (reading) reading.checked = true;
  
  const careText = document.querySelector('[name="text"]');
  if (careText) careText.value = "I have significant hearing loss from years of industrial noise exposure. Please speak clearly and face me when talking. I may need written instructions for complex medical information.";
  
  // Body Parts - Set defaults for male gender (with error handling)
  if (typeof allPresent === 'function') {
    try {
      allPresent();
    } catch (error) {
      console.log("Error in allPresent function:", error);
      // Manually set key organs to avoid the error
      setOrganDefaults();
    }
    
    const fingersL = document.getElementById('Fingers-l');
    if (fingersL) fingersL.selectedIndex = 6; // Partially surgically removed
  }

// Helper function to set organ defaults manually
function setOrganDefaults() {
  const organs = [
    'Arm-l', 'Arm-r', 'Hand-l', 'Hand-r', 'Fingers-l', 'Fingers-r',
    'Leg-l', 'Leg-r', 'Calf-l', 'Calf-r', 'Foot-l', 'Foot-r', 'Toe-l', 'Toe-r',
    'Hip-l', 'Hip-r', 'Eye-l', 'Eye-r', 'Hypothalamus', 'Pituitary', 'Tongue', 'Jaw',
    'salgland-l', 'salgland-r', 'Oesophagus', 'LargeColon', 'Stomach', 'GallBladder',
    'Kidney-l', 'Kidney-r', 'Liver', 'Bladder', 'Lung-l', 'Lung-r'
  ];
  
  organs.forEach(organId => {
    const element = document.getElementById(organId);
    if (element) element.selectedIndex = 1; // Present
  });
  
  // Set gender-specific organs based on current gender selection
  const genderSelect = document.querySelector('#gender');
  if (genderSelect) {
    if (genderSelect.value === 'm') {
      // Male - set female organs to "Not Relevant"
      const femaleOrgans = ['Breasts-l', 'Breasts-r', 'Uterus', 'Ovary-l', 'Ovary-r', 'Cervix', 'Vagina'];
      femaleOrgans.forEach(organId => {
        const element = document.getElementById(organId);
        if (element) element.selectedIndex = 2; // Not Relevant
      });
      
      // Male organs present
      const maleOrgans = ['Penis', 'Prostate', 'Testis-l', 'Testis-r'];
      maleOrgans.forEach(organId => {
        const element = document.getElementById(organId);
        if (element) element.selectedIndex = 1; // Present
      });
    } else if (genderSelect.value === 'f') {
      // Female - set male organs to "Not Relevant"
      const maleOrgans = ['Penis', 'Prostate', 'Testis-l', 'Testis-r'];
      maleOrgans.forEach(organId => {
        const element = document.getElementById(organId);
        if (element) element.selectedIndex = 2; // Not Relevant
      });
      
      // Female organs present
      const femaleOrgans = ['Breasts-l', 'Breasts-r', 'Uterus', 'Ovary-l', 'Ovary-r', 'Cervix', 'Vagina'];
      femaleOrgans.forEach(organId => {
        const element = document.getElementById(organId);
        if (element) element.selectedIndex = 1; // Present
      });
    }
  }
}
  
  // Men's Health (with delay to ensure DOM is ready)
  setTimeout(() => {
    const urination = document.querySelector('#urination');
    if (urination) urination.value = "medium"; // A little difficult
  }, 100);
}

function populateFormPatient2() {
  // New mother with epilepsy with infant daughter that has learning difficulties
  resetForm();
  
  // About Me section
  document.querySelector('[name="name"]').value = "Fatima Abdul Rahman";
  document.querySelector('[name="dob"]').value = "1995-07-12";
  document.querySelector('[name="id"]').value = "9847362051";
  document.querySelector('[name="country"]').value = "AU";
  document.querySelector('[name="email"]').value = "fatima.rahman@hotmail.com";
  document.querySelector('[name="mobile"]').value = "0456789123";
  
  // Next of Kin
  document.querySelector('[name="nok"]').value = "Ahmad Rahman";
  document.querySelector('[name="nokemail"]').value = "ahmad.rahman@gmail.com";
  document.querySelector('[name="nokmobile"]').value = "0467123890";
  
  // Cultural Identity
  document.querySelector('[name="culture"]').value = "Afghan-Australian";
  document.querySelector('[name="community"]').value = "Western Sydney, NSW";
  document.querySelector('[name="language"]').value = "Dari";
  document.querySelector('[name="english"]').checked = false;
  document.querySelector('#religion').value = "m";
  document.querySelector('#religion-code').value = "Islam";
  
  // Gender
  document.querySelector('#gender').value = "f";
  document.querySelector('[name="pronouns"]').value = "f";
  document.querySelector('#sexchar').value = "n";
  
  // My Story
  document.querySelector('[name="story"]').value = "I came to Australia from Afghanistan 3 years ago. I have epilepsy which started during my pregnancy. My daughter Aisha is now 8 months old and has been diagnosed with developmental delays. I am very worried about both our health needs. I prefer female doctors and need interpreters for medical appointments as my English is still limited. I am breastfeeding and concerned about my seizure medications affecting my baby.";
  
  // Goals
  const goal1 = document.querySelector('[name="care-goal-1"]');
  if (goal1) {
    goal1.value = "Control seizures while safely breastfeeding";
    const goal1State = document.querySelector('[name="care-goal-state-1"]');
    if (goal1State) goal1State.checked = false;
  }
  
  if (typeof addGoal === 'function') {
    addGoal();
    const goal2 = document.querySelector('[name="care-goal-2"]');
    if (goal2) {
      goal2.value = "Get early intervention services for my daughter";
      const goal2State = document.querySelector('[name="care-goal-state-2"]');
      if (goal2State) goal2State.checked = true;
    }
    
    addGoal();
    const goal3 = document.querySelector('[name="care-goal-3"]');
    if (goal3) goal3.value = "Improve English language skills for healthcare";
  }
  
  // Care Planning
  const caname = document.querySelector('[name="caname"]');
  if (caname) caname.value = "Ahmad Rahman";
  const caemail = document.querySelector('[name="caemail"]');
  if (caemail) caemail.value = "ahmad.rahman@gmail.com";
  const camobile = document.querySelector('[name="camobile"]');
  if (camobile) camobile.value = "0467123890";
  const calegal = document.querySelector('[name="calegal"]');
  if (calegal) calegal.checked = true;
  
  const avoidance = document.querySelector('[name="avoidance"]');
  if (avoidance) avoidance.value = "Do not discuss my health with any male family members due to cultural and religious beliefs. Prefer female healthcare providers when possible.";
  
  // Medical Directives
  const dnrFalse = document.querySelector('[name="dnr"][value="false"]');
  if (dnrFalse) dnrFalse.checked = true;
  const donorFalse = document.querySelector('[name="donor"][value="false"]');
  if (donorFalse) donorFalse.checked = true;
  const bldFalse = document.querySelector('[name="bld"][value="false"]');
  if (bldFalse) bldFalse.checked = true;
  
  // Health Issues
  const issue1 = document.querySelector('#issue1');
  if (issue1) issue1.value = "Epilepsy";
  const issueLevel1 = document.querySelector('#issueLevel1');
  if (issueLevel1) issueLevel1.value = "m";
  
  if (typeof addIssue === 'function') {
    addIssue();
    const issue2 = document.querySelector('#issue2');
    if (issue2) issue2.value = "Postpartum anxiety";
    const issueLevel2 = document.querySelector('#issueLevel2');
    if (issueLevel2) issueLevel2.value = "c";
    
    addIssue();
    const issue3 = document.querySelector('#issue3');
    if (issue3) issue3.value = "Cultural adaptation stress";
    const issueLevel3 = document.querySelector('#issueLevel3');
    if (issueLevel3) issueLevel3.value = "c";
  }
  
  // Medications
  const medication1 = document.querySelector('#medication1');
  if (medication1) medication1.value = "Levetiracetam";
  const dosage1 = document.querySelector('[name="dosage1"]');
  if (dosage1) dosage1.value = "500mg twice daily";
  
  if (typeof addMedication === 'function') {
    addMedication();
    const medication2 = document.querySelector('#medication2');
    if (medication2) medication2.value = "Multivitamin";
    const dosage2 = document.querySelector('[name="dosage2"]');
    if (dosage2) dosage2.value = "One tablet daily";
  }
  
  // Past Events
  const event1 = document.querySelector('#event1');
  if (event1) event1.value = "Daughter's birth";
  const eventWhen1 = document.querySelector('[name="event-when1"]');
  if (eventWhen1) eventWhen1.value = "2024-04";
  
  if (typeof addEvent === 'function') {
    addEvent();
    const event2 = document.querySelector('#event2');
    if (event2) event2.value = "Epilepsy diagnosis";
    const eventWhen2 = document.querySelector('[name="event-when2"]');
    if (eventWhen2) eventWhen2.value = "2024-02";
    
    addEvent();
    const event3 = document.querySelector('#event3');
    if (event3) event3.value = "Immigration to Australia";
    const eventWhen3 = document.querySelector('[name="event-when3"]');
    if (eventWhen3) eventWhen3.value = "2021-08";
  }
  
  // Care Needs
  const concernSpeaking = document.querySelector('[name="concern-speaking"]');
  if (concernSpeaking) concernSpeaking.checked = true;
  const concernCognition = document.querySelector('[name="concern-cognition"]');
  if (concernCognition) concernCognition.checked = true;
  const concernTrauma = document.querySelector('[name="concern-trauma"]');
  if (concernTrauma) concernTrauma.checked = true;
  const concernGender = document.querySelector('[name="concern-gender"]');
  if (concernGender) concernGender.checked = true;
  const concernFocus = document.querySelector('[name="concern-focus"]');
  if (concernFocus) concernFocus.checked = true;
  
  const careText = document.querySelector('[name="text"]');
  if (careText) careText.value = "I need female healthcare providers when possible and require Dari interpreters for complex medical discussions. I am very anxious about my baby's development and need support with understanding the Australian healthcare system.";
  
  // Body Parts (with error handling)
  if (typeof allPresent === 'function') {
    try {
      allPresent();
    } catch (error) {
      console.log("Error in allPresent function:", error);
      setOrganDefaults();
    }
  }
  
  // Men's Health (with delay to ensure DOM is ready)
  setTimeout(() => {
    const urination = document.querySelector('#urination');
    if (urination) urination.value = "fine"; // No problem (he's young and healthy)
  }, 100);
  
  // Reproductive health (with delay to ensure DOM is ready)
  setTimeout(() => {
    const pregnancyStatus = document.querySelector('#pregnancy-status');
    if (pregnancyStatus) pregnancyStatus.value = "60001007"; // Not pregnant
    
    const lmp = document.querySelector('[name="lmp"]');
    if (lmp) lmp.value = "2023-07-15"; // LMP from before pregnancy
    
    const menstruationStatus = document.querySelector('#menstruation-status');
    if (menstruationStatus) menstruationStatus.value = "current";
    
    const periodFrequency = document.querySelector('#period-frequency');
    if (periodFrequency) periodFrequency.value = "normal";
    
    const periodDuration = document.querySelector('#period-duration');
    if (periodDuration) periodDuration.value = "normal";
    
    const periodRegularity = document.querySelector('#period-regularity');
    if (periodRegularity) periodRegularity.value = "irregular";
    
    const periodVolume = document.querySelector('#period-volume');
    if (periodVolume) periodVolume.value = "normal";
    
    const periodBleeding = document.querySelector('#period-bleeding');
    if (periodBleeding) periodBleeding.value = "none";
  }, 100);
}

function populateFormPatient4() {
  // Young indigenous boy who's fundamentally healthy but had bike accident with broken ribs, pierced lung, damaged liver
  resetForm();
  
  // About Me section
  const nameField = document.querySelector('[name="name"]');
  if (nameField) nameField.value = "Jaiden William Ngalarra";
  const dobField = document.querySelector('[name="dob"]');
  if (dobField) dobField.value = "2010-09-23";
  const idField = document.querySelector('[name="id"]');
  if (idField) idField.value = "1847392650";
  const countryField = document.querySelector('[name="country"]');
  if (countryField) countryField.value = "AU";
  const emailField = document.querySelector('[name="email"]');
  if (emailField) emailField.value = "ngalarra.family@gmail.com";
  const mobileField = document.querySelector('[name="mobile"]');
  if (mobileField) mobileField.value = "0487654321";
  
  // Next of Kin
  const nokField = document.querySelector('[name="nok"]');
  if (nokField) nokField.value = "Michelle Ngalarra";
  const nokEmailField = document.querySelector('[name="nokemail"]');
  if (nokEmailField) nokEmailField.value = "ngalarra.family@gmail.com";
  const nokMobileField = document.querySelector('[name="nokmobile"]');
  if (nokMobileField) nokMobileField.value = "0487654321";
  
  // Cultural Identity
  const cultureField = document.querySelector('[name="culture"]');
  if (cultureField) cultureField.value = "Yawuru/Karajarri Aboriginal";
  const communityField = document.querySelector('[name="community"]');
  if (communityField) communityField.value = "Ardyaloon (One Arm Point), Western Australia";
  const languageField = document.querySelector('[name="language"]');
  if (languageField) languageField.value = "Yawuru/English";
  const englishCheck = document.querySelector('[name="english"]');
  if (englishCheck) englishCheck.checked = true;
  const religionSelect = document.querySelector('#religion');
  if (religionSelect) religionSelect.value = "o";
  const religionCodeField = document.querySelector('#religion-code');
  if (religionCodeField) religionCodeField.value = "Traditional Aboriginal spirituality";
  
  // Gender
  const genderSelect = document.querySelector('#gender');
  if (genderSelect) genderSelect.value = "m";
  const pronounsSelect = document.querySelector('[name="pronouns"]');
  if (pronounsSelect) pronounsSelect.value = "m";
  const sexcharSelect = document.querySelector('#sexchar');
  if (sexcharSelect) sexcharSelect.value = "n";
  
  // My Story
  const storyField = document.querySelector('[name="story"]');
  if (storyField) storyField.value = "I'm a 14-year-old Yawuru boy from Ardyaloon. I love riding my bike around and fishing with my family. I had a bad accident on my bike last month where I crashed and got really hurt. The doctors say I broke some ribs and hurt my lung and liver. I'm getting better but I'm worried about when I can play footy again and go fishing. My nan says the country will help me heal. I want to get strong again so I can help my family and maybe become a marine biologist to protect our reefs.";
  
  // Goals
  const goal1 = document.querySelector('[name="care-goal-1"]');
  if (goal1) {
    goal1.value = "Heal completely from bike accident injuries";
    const goal1State = document.querySelector('[name="care-goal-state-1"]');
    if (goal1State) goal1State.checked = true;
  }
  
  if (typeof addGoal === 'function') {
    addGoal();
    const goal2 = document.querySelector('[name="care-goal-2"]');
    if (goal2) goal2.value = "Return to playing Australian Rules Football";
    
    addGoal();
    const goal3 = document.querySelector('[name="care-goal-3"]');
    if (goal3) {
      goal3.value = "Continue school and pursue marine biology interests";
      const goal3State = document.querySelector('[name="care-goal-state-3"]');
      if (goal3State) goal3State.checked = true;
    }
  }
  
  // Care Planning
  const caname = document.querySelector('[name="caname"]');
  if (caname) caname.value = "Michelle Ngalarra";
  const caemail = document.querySelector('[name="caemail"]');
  if (caemail) caemail.value = "ngalarra.family@gmail.com";
  const camobile = document.querySelector('[name="camobile"]');
  if (camobile) camobile.value = "0487654321";
  const calegal = document.querySelector('[name="calegal"]');
  if (calegal) calegal.checked = true;
  
  // Medical Directives
  const dnrFalse = document.querySelector('[name="dnr"][value="false"]');
  if (dnrFalse) dnrFalse.checked = true;
  const donorTrue = document.querySelector('[name="donor"][value="true"]');
  if (donorTrue) donorTrue.checked = true;
  const bldTrue = document.querySelector('[name="bld"][value="true"]');
  if (bldTrue) bldTrue.checked = true;
  
  // Health Issues
  const issue1 = document.querySelector('#issue1');
  if (issue1) issue1.value = "Healing rib fractures";
  const issueLevel1 = document.querySelector('#issueLevel1');
  if (issueLevel1) issueLevel1.value = "c";
  
  if (typeof addIssue === 'function') {
    addIssue();
    const issue2 = document.querySelector('#issue2');
    if (issue2) issue2.value = "Recovering pneumothorax";
    const issueLevel2 = document.querySelector('#issueLevel2');
    if (issueLevel2) issueLevel2.value = "b";
    
    addIssue();
    const issue3 = document.querySelector('#issue3');
    if (issue3) issue3.value = "Liver contusion healing";
    const issueLevel3 = document.querySelector('#issueLevel3');
    if (issueLevel3) issueLevel3.value = "b";
  }
  
  // Medications
  const medication1 = document.querySelector('#medication1');
  if (medication1) medication1.value = "Paracetamol";
  const dosage1 = document.querySelector('[name="dosage1"]');
  if (dosage1) dosage1.value = "500mg every 6 hours as needed for pain";
  
  // Past Events
  const event1 = document.querySelector('#event1');
  if (event1) event1.value = "Bicycle accident with multiple injuries";
  const eventWhen1 = document.querySelector('[name="event-when1"]');
  if (eventWhen1) eventWhen1.value = "2024-11";
  
  if (typeof addEvent === 'function') {
    addEvent();
    const event2 = document.querySelector('#event2');
    if (event2) event2.value = "Hospital admission for trauma";
    const eventWhen2 = document.querySelector('[name="event-when2"]');
    if (eventWhen2) eventWhen2.value = "2024-11-15";
  }
  
  // Care Needs
  const concernCity = document.querySelector('[name="concern-city"]');
  if (concernCity) concernCity.checked = true;
  const orientation = document.querySelector('[name="orientation"]');
  if (orientation) orientation.checked = true;
  const reading = document.querySelector('[name="reading"]');
  if (reading) reading.checked = true;
  
  const careText = document.querySelector('[name="text"]');
  if (careText) careText.value = "I'm from a remote community and big hospitals can be overwhelming. I feel more comfortable when family can stay with me and when staff understand our cultural ways. I need help understanding when I can return to normal activities.";
  
  // Body Parts (with error handling)
  if (typeof allPresent === 'function') {
    try {
      allPresent();
    } catch (error) {
      console.log("Error in allPresent function:", error);
      setOrganDefaults();
    }
  }
}

function populateFormPatient5() {
  // 20-year-old woman with addiction problems (alcohol & meth), relationship breakup, parents divorce, bipolar, hepatitis, anxiety
  resetForm();
  
  // About Me section
  document.querySelector('[name="name"]').value = "Chloe Marie Taylor";
  document.querySelector('[name="dob"]').value = "2004-02-14";
  document.querySelector('[name="id"]').value = "3692581470";
  document.querySelector('[name="country"]').value = "AU";
  document.querySelector('[name="email"]').value = "chloe.taylor94@gmail.com";
  document.querySelector('[name="mobile"]').value = "0434567812";
  
  // Next of Kin
  document.querySelector('[name="nok"]').value = "Rebecca Taylor";
  document.querySelector('[name="nokemail"]').value = "bec.taylor@yahoo.com.au";
  document.querySelector('[name="nokmobile"]').value = "0456123789";
  
  // Cultural Identity
  document.querySelector('[name="culture"]').value = "Australian";
  document.querySelector('[name="community"]').value = "Adelaide, South Australia";
  document.querySelector('[name="language"]').value = "English";
  document.querySelector('[name="english"]').checked = true;
  document.querySelector('#religion').value = "n";
  
  // Gender
  document.querySelector('[name="gender"]').value = "f";
  document.querySelector('[name="pronouns"]').value = "f";
  document.querySelector('#sexchar').value = "n";
  
  // My Story
  document.querySelector('[name="story"]').value = "My life has been really hard lately. My boyfriend left me, my parents got divorced, and I've been struggling with alcohol and drug use to cope. I was recently diagnosed with bipolar disorder and hepatitis C. I have severe anxiety and sometimes can't leave my house. I know I need help but I'm scared and don't trust easily. I want to get clean and healthy but I don't know how. I used to love art and want to get back to that someday.";
  
  // Goals
  document.querySelector('[name="care-goal-1"]').value = "Achieve sobriety and maintain recovery";
  document.querySelector('[name="care-goal-state-1"]').checked = false;
  
  addGoal();
  document.querySelector('[name="care-goal-2"]').value = "Stabilize bipolar disorder with medication";
  
  addGoal();
  document.querySelector('[name="care-goal-3"]').value = "Treat hepatitis C infection";
  
  addGoal();
  document.querySelector('[name="care-goal-4"]').value = "Develop healthy coping strategies for anxiety";
  
  // Care Planning - Government agency as care advocate
  document.querySelector('[name="caname"]').value = "SA Health Mental Health Services";
  document.querySelector('[name="caemail"]').value = "mhs.intake@sa.gov.au";
  document.querySelector('[name="camobile"]').value = "1800-888-576";
  document.querySelector('[name="calegal"]').checked = false;
  
  document.querySelector('[name="avoidance"]').value = "Please do not discuss my health with my parents - Michael Taylor and Susan Taylor. Our relationship is strained due to my addiction issues and their recent divorce.";
  
  // Medical Directives
  document.querySelector('[name="dnr"][value="false"]').checked = true;
  document.querySelector('[name="donor"][value="true"]').checked = true;
  document.querySelector('[name="bld"][value="true"]').checked = true;
  
  // Allergies
  document.querySelector('#ai1').value = "Codeine";
  document.querySelector('#aiRxn1').value = "g";
  
  // Health Issues
  document.querySelector('#issue1').value = "Bipolar disorder";
  document.querySelector('#issueLevel1').value = "m";
  
  addIssue();
  document.querySelector('#issue2').value = "Alcohol use disorder";
  document.querySelector('#issueLevel2').value = "m";
  
  addIssue();
  document.querySelector('#issue3').value = "Methamphetamine use disorder";
  document.querySelector('#issueLevel3').value = "m";
  
  addIssue();
  document.querySelector('#issue4').value = "Hepatitis C";
  document.querySelector('#issueLevel4').value = "c";
  
  addIssue();
  document.querySelector('#issue5').value = "Generalized anxiety disorder";
  document.querySelector('#issueLevel5').value = "c";
  
  // Medications
  document.querySelector('#medication1').value = "Lithium carbonate";
  document.querySelector('[name="dosage1"]').value = "400mg twice daily";
  
  addMedication();
  document.querySelector('#medication2').value = "Sertraline";
  document.querySelector('[name="dosage2"]').value = "50mg daily for anxiety";
  
  addMedication();
  document.querySelector('#medication3').value = "Sofosbuvir/velpatasvir";
  document.querySelector('[name="dosage3"]').value = "One tablet daily for hepatitis C";
  
  // Past Events
  document.querySelector('#event1').value = "Parents' divorce";
  document.querySelector('[name="event-when1"]').value = "2024-06";
  
  addEvent();
  document.querySelector('#event2').value = "Relationship breakup";
  document.querySelector('[name="event-when2"]').value = "2024-08";
  
  addEvent();
  document.querySelector('#event3').value = "Bipolar disorder diagnosis";
  document.querySelector('[name="event-when3"]').value = "2024-10";
  
  addEvent();
  document.querySelector('#event4').value = "Hepatitis C diagnosis";
  document.querySelector('[name="event-when4"]').value = "2024-11";
  
  // Care Needs
  document.querySelector('[name="concern-trauma"]').checked = true;
  document.querySelector('[name="concern-focus"]').checked = true;
  document.querySelector('[name="concern-addiction"]').checked = true;
  document.querySelector('[name="concern-cognition"]').checked = true;
  document.querySelector('[name="concern-memory"]').checked = true;
  document.querySelector('[name="meds"]').checked = true;
  document.querySelector('[name="orientation"]').checked = true;
  
  document.querySelector('[name="text"]').value = "I have severe anxiety and trust issues. I need patient, non-judgmental healthcare providers who understand addiction and mental health. I sometimes have trouble concentrating or remembering things. Please speak slowly and give me written instructions.";
  
  // Body Parts
  allPresent();
  
  // Reproductive health
  document.querySelector('#pregnancy-status').value = "60001007"; // Not pregnant
  document.querySelector('[name="lmp"]').value = "2024-11-20";
  document.querySelector('#menstruation-status').value = "current";
  document.querySelector('#period-frequency').value = "infrequent";
  document.querySelector('#period-regularity').value = "irregular";
  // Leave other menstrual questions unanswered as requested
}

// The test patient buttons (all five are in the page, with their labels)
document.addEventListener('DOMContentLoaded', function() {
  const patients = [populateFormPatient1, populateFormPatient2, populateFormPatient3, populateFormPatient4, populateFormPatient5];
  patients.forEach(function (populate, i) {
    const button = document.getElementById('pop' + (i + 1));
    if (button) {
      button.onclick = function () {
        populate();
        scheduleGenerate(0);
      };
    }
  });
});
