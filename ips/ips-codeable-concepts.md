# CodeableConcept elements in the IPS profiles (hl7.fhir.uv.ips#1.1.0)

Every element of type CodeableConcept in each IPS profile (and the core profiles the Composition's sections point to), from the snapshot, with its binding and any pattern. Elements in the terminology view's ignore list are marked *(ignored)*. The value sets are described in the second part.

## CompositionUvIps (Composition)

`http://hl7.org/fhir/uv/ips/StructureDefinition/Composition-uv-ips` - not referenced from a section

| Element | Card. | MS | Binding | Value set | Pattern / fixed |
|---|---|---|---|---|---|
| `Composition.type` *(ignored)* | 1..1 | Y | preferred | [doc-typecodes](#doc-typecodes) | loinc.org#60591-5 |
| `Composition.category` *(ignored)* | 0..* |  | example | [document-classcodes](#document-classcodes) |  |
| `Composition.event.code` *(ignored)* | 0..* |  | example | [v3-ActCode](#v3-actcode) |  |
| `Composition.event:careProvisioningEvent.code` *(ignored)* | 1..1 | Y | example | [v3-ActCode](#v3-actcode) | terminology.hl7.org/CodeSystem/v3-ActClass#PCPR |
| `Composition.section.code` | 1..1 | Y | example | [doc-section-codes](#doc-section-codes) |  |
| `Composition.section.orderedBy` | 0..1 |  | preferred | [list-order](#list-order) |  |
| `Composition.section:sectionMedications.code` | 0..1 |  | example | [doc-section-codes](#doc-section-codes) | loinc.org#10160-0 |
| `Composition.section:sectionMedications.emptyReason` | 0..1 |  | preferred | [list-empty-reason](#list-empty-reason) |  |
| `Composition.section:sectionAllergies.code` | 0..1 |  | example | [doc-section-codes](#doc-section-codes) | loinc.org#48765-2 |
| `Composition.section:sectionAllergies.emptyReason` | 0..1 |  | preferred | [list-empty-reason](#list-empty-reason) |  |
| `Composition.section:sectionProblems.code` | 0..1 |  | example | [doc-section-codes](#doc-section-codes) | loinc.org#11450-4 |
| `Composition.section:sectionProblems.emptyReason` | 0..1 |  | preferred | [list-empty-reason](#list-empty-reason) |  |
| `Composition.section:sectionProceduresHx.code` | 0..1 |  | example | [doc-section-codes](#doc-section-codes) | loinc.org#47519-4 |
| `Composition.section:sectionProceduresHx.emptyReason` | 0..1 |  | preferred | [list-empty-reason](#list-empty-reason) |  |
| `Composition.section:sectionImmunizations.code` | 0..1 |  | example | [doc-section-codes](#doc-section-codes) | loinc.org#11369-6 |
| `Composition.section:sectionImmunizations.emptyReason` | 0..1 |  | preferred | [list-empty-reason](#list-empty-reason) |  |
| `Composition.section:sectionMedicalDevices.code` | 0..1 |  | example | [doc-section-codes](#doc-section-codes) | loinc.org#46264-8 |
| `Composition.section:sectionMedicalDevices.emptyReason` | 0..1 |  | preferred | [list-empty-reason](#list-empty-reason) |  |
| `Composition.section:sectionResults.code` | 0..1 |  | example | [doc-section-codes](#doc-section-codes) | loinc.org#30954-2 |
| `Composition.section:sectionResults.emptyReason` | 0..1 |  | preferred | [list-empty-reason](#list-empty-reason) |  |
| `Composition.section:sectionVitalSigns.code` | 0..1 |  | example | [doc-section-codes](#doc-section-codes) | loinc.org#8716-3 |
| `Composition.section:sectionVitalSigns.emptyReason` | 0..1 |  | preferred | [list-empty-reason](#list-empty-reason) |  |
| `Composition.section:sectionPastIllnessHx.code` | 0..1 |  | example | [doc-section-codes](#doc-section-codes) | loinc.org#11348-0 |
| `Composition.section:sectionPastIllnessHx.emptyReason` | 0..1 |  | preferred | [list-empty-reason](#list-empty-reason) |  |
| `Composition.section:sectionFunctionalStatus.code` | 0..1 |  | example | [doc-section-codes](#doc-section-codes) | loinc.org#47420-5 |
| `Composition.section:sectionFunctionalStatus.emptyReason` | 0..1 |  | preferred | [list-empty-reason](#list-empty-reason) |  |
| `Composition.section:sectionPlanOfCare.code` | 0..1 |  | example | [doc-section-codes](#doc-section-codes) | loinc.org#18776-5 |
| `Composition.section:sectionPlanOfCare.emptyReason` | 0..1 |  | preferred | [list-empty-reason](#list-empty-reason) |  |
| `Composition.section:sectionSocialHistory.code` | 0..1 |  | example | [doc-section-codes](#doc-section-codes) | loinc.org#29762-2 |
| `Composition.section:sectionSocialHistory.emptyReason` | 0..1 |  | preferred | [list-empty-reason](#list-empty-reason) |  |
| `Composition.section:sectionPregnancyHx.code` | 0..1 |  | example | [doc-section-codes](#doc-section-codes) | loinc.org#10162-6 |
| `Composition.section:sectionPregnancyHx.emptyReason` | 0..1 |  | preferred | [list-empty-reason](#list-empty-reason) |  |
| `Composition.section:sectionAdvanceDirectives.code` | 0..1 |  | example | [doc-section-codes](#doc-section-codes) | loinc.org#42348-3 |
| `Composition.section:sectionAdvanceDirectives.emptyReason` | 0..1 |  | preferred | [list-empty-reason](#list-empty-reason) |  |

## MedicationStatementIPS (MedicationStatement)

`http://hl7.org/fhir/uv/ips/StructureDefinition/MedicationStatement-uv-ips` - section 10160-0

| Element | Card. | MS | Binding | Value set | Pattern / fixed |
|---|---|---|---|---|---|
| `MedicationStatement.statusReason` | 0..* |  | example | [reason-medication-status-codes](#reason-medication-status-codes) |  |
| `MedicationStatement.category` *(ignored)* | 0..1 |  | preferred | [medication-statement-category](#medication-statement-category) |  |
| `MedicationStatement.medication[x]` (Reference/CodeableConcept) | 1..1 | Y | preferred | [medication-snomed-absent-unknown-uv-ips](#medication-snomed-absent-unknown-uv-ips) |  |
| `MedicationStatement.reasonCode` | 0..* |  | example | [condition-code](#condition-code) |  |
| `MedicationStatement.dosage.additionalInstruction` | 0..* |  | example | [additional-instruction-codes](#additional-instruction-codes) |  |
| `MedicationStatement.dosage.asNeeded[x]` (boolean/CodeableConcept) | 0..1 |  | example | [medication-as-needed-reason](#medication-as-needed-reason) |  |
| `MedicationStatement.dosage.site` | 0..1 |  | example | [approach-site-codes](#approach-site-codes) |  |
| `MedicationStatement.dosage.route` | 0..1 |  | preferred | [medicine-route-of-administration](#medicine-route-of-administration) |  |
| `MedicationStatement.dosage.method` | 0..1 |  | example | [administration-method-codes](#administration-method-codes) |  |
| `MedicationStatement.dosage.doseAndRate.type` | 0..1 |  | example | [dose-rate-type](#dose-rate-type) |  |

## MedicationRequestIPS (MedicationRequest)

`http://hl7.org/fhir/uv/ips/StructureDefinition/MedicationRequest-uv-ips` - section 10160-0

| Element | Card. | MS | Binding | Value set | Pattern / fixed |
|---|---|---|---|---|---|
| `MedicationRequest.statusReason` | 0..1 |  | example | [medicationrequest-status-reason](#medicationrequest-status-reason) |  |
| `MedicationRequest.category` *(ignored)* | 0..* |  | example | [medicationrequest-category](#medicationrequest-category) |  |
| `MedicationRequest.medication[x]` (CodeableConcept/Reference) | 1..1 | Y | preferred | [medication-snomed-absent-unknown-uv-ips](#medication-snomed-absent-unknown-uv-ips) |  |
| `MedicationRequest.performerType` | 0..1 |  | example | [performer-role](#performer-role) |  |
| `MedicationRequest.reasonCode` | 0..* |  | example | [condition-code](#condition-code) |  |
| `MedicationRequest.courseOfTherapyType` | 0..1 |  | example | [medicationrequest-course-of-therapy](#medicationrequest-course-of-therapy) |  |
| `MedicationRequest.dosageInstruction.additionalInstruction` | 0..* |  | example | [additional-instruction-codes](#additional-instruction-codes) |  |
| `MedicationRequest.dosageInstruction.asNeeded[x]` (boolean/CodeableConcept) | 0..1 |  | example | [medication-as-needed-reason](#medication-as-needed-reason) |  |
| `MedicationRequest.dosageInstruction.site` | 0..1 |  | example | [approach-site-codes](#approach-site-codes) |  |
| `MedicationRequest.dosageInstruction.route` | 0..1 |  | preferred | [medicine-route-of-administration](#medicine-route-of-administration) |  |
| `MedicationRequest.dosageInstruction.method` | 0..1 |  | example | [administration-method-codes](#administration-method-codes) |  |
| `MedicationRequest.dosageInstruction.doseAndRate.type` | 0..1 |  | example | [dose-rate-type](#dose-rate-type) |  |
| `MedicationRequest.substitution.allowed[x]` (boolean/CodeableConcept) | 1..1 |  | example | [v3-ActSubstanceAdminSubstitutionCode](#v3-actsubstanceadminsubstitutioncode) |  |
| `MedicationRequest.substitution.reason` | 0..1 |  | example | [v3-SubstanceAdminSubstitutionReason](#v3-substanceadminsubstitutionreason) |  |

## AllergyIntoleranceUvIps (AllergyIntolerance)

`http://hl7.org/fhir/uv/ips/StructureDefinition/AllergyIntolerance-uv-ips` - section 48765-2

| Element | Card. | MS | Binding | Value set | Pattern / fixed |
|---|---|---|---|---|---|
| `AllergyIntolerance.clinicalStatus` *(ignored)* | 0..1 |  | required | [allergyintolerance-clinical](#allergyintolerance-clinical) |  |
| `AllergyIntolerance.verificationStatus` *(ignored)* | 0..1 |  | required | [allergyintolerance-verification](#allergyintolerance-verification) |  |
| `AllergyIntolerance.code` | 0..1 | Y | preferred | [allergy-intolerance-uv-ips](#allergy-intolerance-uv-ips) |  |
| `AllergyIntolerance.reaction.substance` | 0..1 |  | example | [substance-code](#substance-code) |  |
| `AllergyIntolerance.reaction.manifestation` | 1..* | Y | preferred | [allergy-reaction-snomed-ct-ips-free-set](#allergy-reaction-snomed-ct-ips-free-set) |  |
| `AllergyIntolerance.reaction.exposureRoute` | 0..1 |  | example | [route-codes](#route-codes) |  |

## ConditionUvIps (Condition)

`http://hl7.org/fhir/uv/ips/StructureDefinition/Condition-uv-ips` - sections 11450-4, 11348-0, 47420-5

| Element | Card. | MS | Binding | Value set | Pattern / fixed |
|---|---|---|---|---|---|
| `Condition.clinicalStatus` *(ignored)* | 1..1 | Y | required | [condition-clinical](#condition-clinical) |  |
| `Condition.verificationStatus` *(ignored)* | 0..1 |  | required | [condition-ver-status](#condition-ver-status) |  |
| `Condition.category` *(ignored)* | 0..* | Y | preferred | [problem-type-uv-ips](#problem-type-uv-ips) |  |
| `Condition.severity` | 0..1 | Y | preferred | [condition-severity](#condition-severity) |  |
| `Condition.code` | 1..1 | Y | preferred | [problems-snomed-absent-unknown-uv-ips](#problems-snomed-absent-unknown-uv-ips) |  |
| `Condition.bodySite` | 0..* |  | example | [body-site](#body-site) |  |
| `Condition.stage.summary` | 0..1 |  | example | [condition-stage](#condition-stage) |  |
| `Condition.stage.type` | 0..1 |  | example | [condition-stage-type](#condition-stage-type) |  |
| `Condition.evidence.code` | 0..* |  | example | [manifestation-or-symptom](#manifestation-or-symptom) |  |

## ProcedureUvIps (Procedure)

`http://hl7.org/fhir/uv/ips/StructureDefinition/Procedure-uv-ips` - section 47519-4

| Element | Card. | MS | Binding | Value set | Pattern / fixed |
|---|---|---|---|---|---|
| `Procedure.statusReason` | 0..1 |  | example | [procedure-not-performed-reason](#procedure-not-performed-reason) |  |
| `Procedure.category` *(ignored)* | 0..1 |  | example | [procedure-category](#procedure-category) |  |
| `Procedure.code` | 1..1 | Y | preferred | [procedures-snomed-absent-unknown-uv-ips](#procedures-snomed-absent-unknown-uv-ips) |  |
| `Procedure.performer.function` | 0..1 |  | example | [performer-role](#performer-role) |  |
| `Procedure.reasonCode` | 0..* |  | example | [procedure-reason](#procedure-reason) |  |
| `Procedure.bodySite` | 0..* |  | example | [body-site](#body-site) |  |
| `Procedure.outcome` | 0..1 |  | example | [procedure-outcome](#procedure-outcome) |  |
| `Procedure.complication` | 0..* |  | example | [condition-code](#condition-code) |  |
| `Procedure.followUp` | 0..* |  | example | [procedure-followup](#procedure-followup) |  |
| `Procedure.focalDevice.action` | 0..1 |  | preferred | [device-action](#device-action) |  |
| `Procedure.usedCode` | 0..* |  | example | [device-kind](#device-kind) |  |

## ImmunizationUvIps (Immunization)

`http://hl7.org/fhir/uv/ips/StructureDefinition/Immunization-uv-ips` - section 11369-6

| Element | Card. | MS | Binding | Value set | Pattern / fixed |
|---|---|---|---|---|---|
| `Immunization.statusReason` | 0..1 |  | example | [immunization-status-reason](#immunization-status-reason) |  |
| `Immunization.vaccineCode` | 1..1 | Y | preferred | [vaccines-uv-ips](#vaccines-uv-ips) |  |
| `Immunization.reportOrigin` | 0..1 |  | example | [immunization-origin](#immunization-origin) |  |
| `Immunization.site` | 0..1 |  | preferred | [body-site](#body-site) |  |
| `Immunization.route` | 0..1 |  | preferred | [medicine-route-of-administration](#medicine-route-of-administration) |  |
| `Immunization.performer.function` | 0..1 |  | extensible | [immunization-function](#immunization-function) |  |
| `Immunization.reasonCode` | 0..* |  | example | [immunization-reason](#immunization-reason) |  |
| `Immunization.subpotentReason` | 0..* |  | example | [immunization-subpotent-reason](#immunization-subpotent-reason) |  |
| `Immunization.programEligibility` | 0..* |  | example | [immunization-program-eligibility](#immunization-program-eligibility) |  |
| `Immunization.fundingSource` | 0..1 |  | example | [immunization-funding-source](#immunization-funding-source) |  |
| `Immunization.protocolApplied.targetDisease` | 0..* |  | preferred | [target-diseases-uv-ips](#target-diseases-uv-ips) |  |

## DeviceUseStatementUvIps (DeviceUseStatement)

`http://hl7.org/fhir/uv/ips/StructureDefinition/DeviceUseStatement-uv-ips` - section 46264-8

| Element | Card. | MS | Binding | Value set | Pattern / fixed |
|---|---|---|---|---|---|
| `DeviceUseStatement.reasonCode` | 0..* |  |  |  |  |
| `DeviceUseStatement.bodySite` | 0..1 |  | example | [body-site](#body-site) |  |

## ObservationResultsUvIps (Observation)

`http://hl7.org/fhir/uv/ips/StructureDefinition/Observation-results-uv-ips` - section 30954-2

| Element | Card. | MS | Binding | Value set | Pattern / fixed |
|---|---|---|---|---|---|
| `Observation.category` *(ignored)* | 0..* |  | preferred | [observation-category](#observation-category) |  |
| `Observation.code` | 1..1 | Y | example | [observation-codes](#observation-codes) |  |
| `Observation.value[x]` (Quantity/CodeableConcept/string/boolean/integer/Range/Ratio/SampledData/time/dateTime/Period) | 0..1 | Y |  |  |  |
| `Observation.dataAbsentReason` | 0..1 |  | extensible | [data-absent-reason](#data-absent-reason) |  |
| `Observation.interpretation` | 0..* |  | extensible | [observation-interpretation](#observation-interpretation) |  |
| `Observation.bodySite` | 0..1 |  | example | [body-site](#body-site) |  |
| `Observation.method` | 0..1 |  | example | [observation-methods](#observation-methods) |  |
| `Observation.referenceRange.type` | 0..1 |  | preferred | [referencerange-meaning](#referencerange-meaning) |  |
| `Observation.referenceRange.appliesTo` | 0..* |  | example | [referencerange-appliesto](#referencerange-appliesto) |  |
| `Observation.component.code` | 1..1 |  | example | [observation-codes](#observation-codes) |  |
| `Observation.component.value[x]` (Quantity/CodeableConcept/string/boolean/integer/Range/Ratio/SampledData/time/dateTime/Period) | 0..1 |  |  |  |  |
| `Observation.component.dataAbsentReason` | 0..1 |  | extensible | [data-absent-reason](#data-absent-reason) |  |
| `Observation.component.interpretation` | 0..* |  | extensible | [observation-interpretation](#observation-interpretation) |  |

## ObservationResultsLaboratoryUvIps (Observation)

`http://hl7.org/fhir/uv/ips/StructureDefinition/Observation-results-laboratory-uv-ips` - section 30954-2, derived from Observation-results-uv-ips

| Element | Card. | MS | Binding | Value set | Pattern / fixed |
|---|---|---|---|---|---|
| `Observation.category` *(ignored)* | 1..* |  | preferred | [observation-category](#observation-category) |  |
| `Observation.category:laboratory` *(ignored)* | 1..1 | Y | preferred | [observation-category](#observation-category) | terminology.hl7.org/CodeSystem/observation-category#laboratory |
| `Observation.code` | 1..1 | Y | preferred | [results-laboratory-observations-uv-ips](#results-laboratory-observations-uv-ips) |  |
| `Observation.value[x]` (Quantity/CodeableConcept/string/boolean/integer/Range/Ratio/SampledData/time/dateTime/Period) | 0..1 | Y |  |  |  |
| `Observation.value[x]:valueCodeableConcept` | 0..1 | Y | preferred | [results-coded-values-laboratory-uv-ips](#results-coded-values-laboratory-uv-ips) |  |
| `Observation.dataAbsentReason` | 0..1 |  | extensible | [data-absent-reason](#data-absent-reason) |  |
| `Observation.interpretation` | 0..* |  | extensible | [observation-interpretation](#observation-interpretation) |  |
| `Observation.bodySite` | 0..1 |  | example | [body-site](#body-site) |  |
| `Observation.method` | 0..1 |  | example | [observation-methods](#observation-methods) |  |
| `Observation.referenceRange.type` | 0..1 |  | preferred | [referencerange-meaning](#referencerange-meaning) |  |
| `Observation.referenceRange.appliesTo` | 0..* |  | example | [referencerange-appliesto](#referencerange-appliesto) |  |
| `Observation.component.code` | 1..1 |  | example | [observation-codes](#observation-codes) |  |
| `Observation.component.value[x]` (Quantity/CodeableConcept/string/boolean/integer/Range/Ratio/SampledData/time/dateTime/Period) | 0..1 |  |  |  |  |
| `Observation.component.dataAbsentReason` | 0..1 |  | extensible | [data-absent-reason](#data-absent-reason) |  |
| `Observation.component.interpretation` | 0..* |  | extensible | [observation-interpretation](#observation-interpretation) |  |

## ObservationResultsPathologyUvIps (Observation)

`http://hl7.org/fhir/uv/ips/StructureDefinition/Observation-results-pathology-uv-ips` - section 30954-2, derived from Observation-results-uv-ips

| Element | Card. | MS | Binding | Value set | Pattern / fixed |
|---|---|---|---|---|---|
| `Observation.category` *(ignored)* | 1..* |  | preferred | [observation-category](#observation-category) |  |
| `Observation.category:laboratory` *(ignored)* | 1..1 | Y | preferred | [observation-category](#observation-category) | terminology.hl7.org/CodeSystem/observation-category#laboratory |
| `Observation.code` | 1..1 | Y | extensible | [results-pathology-observations-uv-ips](#results-pathology-observations-uv-ips) |  |
| `Observation.value[x]` (Quantity/CodeableConcept/string/boolean/integer/Range/Ratio/SampledData/time/dateTime/Period) | 0..1 | Y |  |  |  |
| `Observation.value[x]:valueCodeableConcept` | 0..1 | Y | preferred | [result-coded-value-pathology-uv-ips](#result-coded-value-pathology-uv-ips) |  |
| `Observation.dataAbsentReason` | 0..1 |  | extensible | [data-absent-reason](#data-absent-reason) |  |
| `Observation.interpretation` | 0..* |  | extensible | [observation-interpretation](#observation-interpretation) |  |
| `Observation.bodySite` | 0..1 |  | example | [body-site](#body-site) |  |
| `Observation.method` | 0..1 |  | example | [observation-methods](#observation-methods) |  |
| `Observation.referenceRange.type` | 0..1 |  | preferred | [referencerange-meaning](#referencerange-meaning) |  |
| `Observation.referenceRange.appliesTo` | 0..* |  | example | [referencerange-appliesto](#referencerange-appliesto) |  |
| `Observation.component.code` | 1..1 |  | example | [observation-codes](#observation-codes) |  |
| `Observation.component.value[x]` (Quantity/CodeableConcept/string/boolean/integer/Range/Ratio/SampledData/time/dateTime/Period) | 0..1 |  |  |  |  |
| `Observation.component.dataAbsentReason` | 0..1 |  | extensible | [data-absent-reason](#data-absent-reason) |  |
| `Observation.component.interpretation` | 0..* |  | extensible | [observation-interpretation](#observation-interpretation) |  |

## ObservationResultsRadiologyUvIps (Observation)

`http://hl7.org/fhir/uv/ips/StructureDefinition/Observation-results-radiology-uv-ips` - section 30954-2, derived from Observation-results-uv-ips

| Element | Card. | MS | Binding | Value set | Pattern / fixed |
|---|---|---|---|---|---|
| `Observation.category` *(ignored)* | 1..* |  | preferred | [observation-category](#observation-category) |  |
| `Observation.category:radiology` *(ignored)* | 1..1 | Y | preferred | [observation-category](#observation-category) | terminology.hl7.org/CodeSystem/observation-category#imaging |
| `Observation.code` | 1..1 | Y | extensible | [results-radiology-observations-uv-ips](#results-radiology-observations-uv-ips) |  |
| `Observation.value[x]` (Quantity/CodeableConcept/string/boolean/integer/Range/Ratio/SampledData/time/dateTime/Period) | 0..1 | Y |  |  |  |
| `Observation.dataAbsentReason` | 0..1 |  | extensible | [data-absent-reason](#data-absent-reason) |  |
| `Observation.interpretation` | 0..* |  | extensible | [observation-interpretation](#observation-interpretation) |  |
| `Observation.bodySite` | 0..1 |  | example | [body-site](#body-site) |  |
| `Observation.method` | 0..1 |  | example | [observation-methods](#observation-methods) |  |
| `Observation.referenceRange.type` | 0..1 |  | preferred | [referencerange-meaning](#referencerange-meaning) |  |
| `Observation.referenceRange.appliesTo` | 0..* |  | example | [referencerange-appliesto](#referencerange-appliesto) |  |
| `Observation.component.code` | 1..1 |  | example | [observation-codes](#observation-codes) |  |
| `Observation.component.value[x]` (Quantity/CodeableConcept/string/boolean/integer/Range/Ratio/SampledData/time/dateTime/Period) | 0..1 |  |  |  |  |
| `Observation.component.dataAbsentReason` | 0..1 |  | extensible | [data-absent-reason](#data-absent-reason) |  |
| `Observation.component.interpretation` | 0..* |  | extensible | [observation-interpretation](#observation-interpretation) |  |
| `Observation.component:observationText.code` | 1..1 |  | extensible | [results-radiology-txtobs-snomed-dicom-loinc-uv-ips](#results-radiology-txtobs-snomed-dicom-loinc-uv-ips) |  |
| `Observation.component:observationCode.code` | 1..1 |  | extensible | [results-radiology-observations-uv-ips](#results-radiology-observations-uv-ips) |  |
| `Observation.component:numericQuantityMeasurement.code` | 1..1 |  | extensible | [results-radiology-numobs-snomed-dicom-uv-ips](#results-radiology-numobs-snomed-dicom-uv-ips) |  |
| `Observation.component:numericRangeMeasurement.code` | 1..1 |  | extensible | [results-radiology-numobs-snomed-dicom-uv-ips](#results-radiology-numobs-snomed-dicom-uv-ips) |  |
| `Observation.component:numericRatioMeasurement.code` | 1..1 |  | extensible | [results-radiology-numobs-snomed-dicom-uv-ips](#results-radiology-numobs-snomed-dicom-uv-ips) |  |
| `Observation.component:numericSampledDataMeasurement.code` | 1..1 |  | extensible | [results-radiology-numobs-snomed-dicom-uv-ips](#results-radiology-numobs-snomed-dicom-uv-ips) |  |

## DiagnosticReportUvIps (DiagnosticReport)

`http://hl7.org/fhir/uv/ips/StructureDefinition/DiagnosticReport-uv-ips` - section 30954-2

| Element | Card. | MS | Binding | Value set | Pattern / fixed |
|---|---|---|---|---|---|
| `DiagnosticReport.category` *(ignored)* | 1..1 | Y | example | [diagnostic-service-sections](#diagnostic-service-sections) |  |
| `DiagnosticReport.code` | 1..1 | Y | preferred | [report-codes](#report-codes) |  |
| `DiagnosticReport.conclusionCode` | 0..* |  | example | [clinical-findings](#clinical-findings) |  |

## observation-vitalsigns (Observation)

`http://hl7.org/fhir/StructureDefinition/vitalsigns` - section 8716-3

| Element | Card. | MS | Binding | Value set | Pattern / fixed |
|---|---|---|---|---|---|
| `Observation.category` *(ignored)* | 1..* | Y | preferred | [observation-category](#observation-category) |  |
| `Observation.code` | 1..1 | Y | extensible | [observation-vitalsignresult](#observation-vitalsignresult) |  |
| `Observation.value[x]` (Quantity/CodeableConcept/string/boolean/integer/Range/Ratio/SampledData/time/dateTime/Period) | 0..1 | Y |  |  |  |
| `Observation.dataAbsentReason` | 0..1 | Y | extensible | [data-absent-reason](#data-absent-reason) |  |
| `Observation.interpretation` | 0..* |  | extensible | [observation-interpretation](#observation-interpretation) |  |
| `Observation.bodySite` | 0..1 |  | example | [body-site](#body-site) |  |
| `Observation.method` | 0..1 |  | example | [observation-methods](#observation-methods) |  |
| `Observation.referenceRange.type` | 0..1 |  | preferred | [referencerange-meaning](#referencerange-meaning) |  |
| `Observation.referenceRange.appliesTo` | 0..* |  | example | [referencerange-appliesto](#referencerange-appliesto) |  |
| `Observation.component.code` | 1..1 | Y | extensible | [observation-vitalsignresult](#observation-vitalsignresult) |  |
| `Observation.component.value[x]` (Quantity/CodeableConcept/string/boolean/integer/Range/Ratio/SampledData/time/dateTime/Period) | 0..1 | Y | required | [ucum-vitals-common](#ucum-vitals-common) |  |
| `Observation.component.dataAbsentReason` | 0..1 | Y | extensible | [data-absent-reason](#data-absent-reason) |  |
| `Observation.component.interpretation` | 0..* |  | extensible | [observation-interpretation](#observation-interpretation) |  |

## ObservationTobaccoUseUvIps (Observation)

`http://hl7.org/fhir/uv/ips/StructureDefinition/Observation-tobaccouse-uv-ips` - section 29762-2

| Element | Card. | MS | Binding | Value set | Pattern / fixed |
|---|---|---|---|---|---|
| `Observation.category` *(ignored)* | 0..* |  | preferred | [observation-category](#observation-category) |  |
| `Observation.code` | 1..1 | Y | example | [observation-codes](#observation-codes) | loinc.org#72166-2 |
| `Observation.value[x]` (Quantity/CodeableConcept/string/boolean/integer/Range/Ratio/SampledData/time/dateTime/Period) | 0..1 |  |  |  |  |
| `Observation.value[x]:valueCodeableConcept` | 0..1 |  | required | [current-smoking-status-uv-ips](#current-smoking-status-uv-ips) |  |
| `Observation.dataAbsentReason` | 0..1 |  | extensible | [data-absent-reason](#data-absent-reason) |  |
| `Observation.interpretation` | 0..* |  | extensible | [observation-interpretation](#observation-interpretation) |  |
| `Observation.bodySite` | 0..1 |  | example | [body-site](#body-site) |  |
| `Observation.method` | 0..1 |  | example | [observation-methods](#observation-methods) |  |
| `Observation.referenceRange.type` | 0..1 |  | preferred | [referencerange-meaning](#referencerange-meaning) |  |
| `Observation.referenceRange.appliesTo` | 0..* |  | example | [referencerange-appliesto](#referencerange-appliesto) |  |
| `Observation.component.code` | 1..1 |  | example | [observation-codes](#observation-codes) |  |
| `Observation.component.value[x]` (Quantity/CodeableConcept/string/boolean/integer/Range/Ratio/SampledData/time/dateTime/Period) | 0..1 |  |  |  |  |
| `Observation.component.dataAbsentReason` | 0..1 |  | extensible | [data-absent-reason](#data-absent-reason) |  |
| `Observation.component.interpretation` | 0..* |  | extensible | [observation-interpretation](#observation-interpretation) |  |

## ObservationAlcoholUseUvIps (Observation)

`http://hl7.org/fhir/uv/ips/StructureDefinition/Observation-alcoholuse-uv-ips` - section 29762-2

| Element | Card. | MS | Binding | Value set | Pattern / fixed |
|---|---|---|---|---|---|
| `Observation.category` *(ignored)* | 0..* |  | preferred | [observation-category](#observation-category) |  |
| `Observation.code` | 1..1 | Y | example | [observation-codes](#observation-codes) | loinc.org#74013-4 |
| `Observation.value[x]` (Quantity/CodeableConcept/string/boolean/integer/Range/Ratio/SampledData/time/dateTime/Period) | 0..1 |  |  |  |  |
| `Observation.dataAbsentReason` | 0..1 |  | extensible | [data-absent-reason](#data-absent-reason) |  |
| `Observation.interpretation` | 0..* |  | extensible | [observation-interpretation](#observation-interpretation) |  |
| `Observation.bodySite` | 0..1 |  | example | [body-site](#body-site) |  |
| `Observation.method` | 0..1 |  | example | [observation-methods](#observation-methods) |  |
| `Observation.referenceRange.type` | 0..1 |  | preferred | [referencerange-meaning](#referencerange-meaning) |  |
| `Observation.referenceRange.appliesTo` | 0..* |  | example | [referencerange-appliesto](#referencerange-appliesto) |  |
| `Observation.component.code` | 1..1 |  | example | [observation-codes](#observation-codes) |  |
| `Observation.component.value[x]` (Quantity/CodeableConcept/string/boolean/integer/Range/Ratio/SampledData/time/dateTime/Period) | 0..1 |  |  |  |  |
| `Observation.component.dataAbsentReason` | 0..1 |  | extensible | [data-absent-reason](#data-absent-reason) |  |
| `Observation.component.interpretation` | 0..* |  | extensible | [observation-interpretation](#observation-interpretation) |  |

## ObservationPregnancyStatusUvIps (Observation)

`http://hl7.org/fhir/uv/ips/StructureDefinition/Observation-pregnancy-status-uv-ips` - section 10162-6

| Element | Card. | MS | Binding | Value set | Pattern / fixed |
|---|---|---|---|---|---|
| `Observation.category` *(ignored)* | 0..* |  | preferred | [observation-category](#observation-category) |  |
| `Observation.code` | 1..1 | Y | example | [observation-codes](#observation-codes) | loinc.org#82810-3 |
| `Observation.value[x]` (Quantity/CodeableConcept/string/boolean/integer/Range/Ratio/SampledData/time/dateTime/Period) | 0..1 |  |  |  |  |
| `Observation.value[x]:valueCodeableConcept` | 0..1 | Y | required | [pregnancy-status-uv-ips](#pregnancy-status-uv-ips) |  |
| `Observation.dataAbsentReason` | 0..1 |  | extensible | [data-absent-reason](#data-absent-reason) |  |
| `Observation.interpretation` | 0..* |  | extensible | [observation-interpretation](#observation-interpretation) |  |
| `Observation.method` | 0..1 |  | example | [observation-methods](#observation-methods) |  |
| `Observation.referenceRange.type` | 0..1 |  | preferred | [referencerange-meaning](#referencerange-meaning) |  |
| `Observation.referenceRange.appliesTo` | 0..* |  | example | [referencerange-appliesto](#referencerange-appliesto) |  |
| `Observation.component.code` | 1..1 |  | example | [observation-codes](#observation-codes) |  |
| `Observation.component.value[x]` (Quantity/CodeableConcept/string/boolean/integer/Range/Ratio/SampledData/time/dateTime/Period) | 0..1 |  |  |  |  |
| `Observation.component.dataAbsentReason` | 0..1 |  | extensible | [data-absent-reason](#data-absent-reason) |  |
| `Observation.component.interpretation` | 0..* |  | extensible | [observation-interpretation](#observation-interpretation) |  |

## ObservationPregnancyOutcomeUvIps (Observation)

`http://hl7.org/fhir/uv/ips/StructureDefinition/Observation-pregnancy-outcome-uv-ips` - section 10162-6

| Element | Card. | MS | Binding | Value set | Pattern / fixed |
|---|---|---|---|---|---|
| `Observation.category` *(ignored)* | 0..* |  | preferred | [observation-category](#observation-category) |  |
| `Observation.code` | 1..1 | Y | required | [pregnancies-summary-uv-ips](#pregnancies-summary-uv-ips) |  |
| `Observation.value[x]` (Quantity/CodeableConcept/string/boolean/integer/Range/Ratio/SampledData/time/dateTime/Period) | 0..1 |  |  |  |  |
| `Observation.dataAbsentReason` | 0..1 |  | extensible | [data-absent-reason](#data-absent-reason) |  |
| `Observation.interpretation` | 0..* |  | extensible | [observation-interpretation](#observation-interpretation) |  |
| `Observation.method` | 0..1 |  | example | [observation-methods](#observation-methods) |  |
| `Observation.referenceRange.type` | 0..1 |  | preferred | [referencerange-meaning](#referencerange-meaning) |  |
| `Observation.referenceRange.appliesTo` | 0..* |  | example | [referencerange-appliesto](#referencerange-appliesto) |  |
| `Observation.component.code` | 1..1 |  | example | [observation-codes](#observation-codes) |  |
| `Observation.component.value[x]` (Quantity/CodeableConcept/string/boolean/integer/Range/Ratio/SampledData/time/dateTime/Period) | 0..1 |  |  |  |  |
| `Observation.component.dataAbsentReason` | 0..1 |  | extensible | [data-absent-reason](#data-absent-reason) |  |
| `Observation.component.interpretation` | 0..* |  | extensible | [observation-interpretation](#observation-interpretation) |  |

## BundleUvIps (Bundle)

`http://hl7.org/fhir/uv/ips/StructureDefinition/Bundle-uv-ips` - not referenced from a section

| Element | Card. | MS | Binding | Value set | Pattern / fixed |
|---|---|---|---|---|---|
| (none) | | | | | |

## DeviceObserverUvIps (Device)

`http://hl7.org/fhir/uv/ips/StructureDefinition/Device-observer-uv-ips` - not referenced from a section

| Element | Card. | MS | Binding | Value set | Pattern / fixed |
|---|---|---|---|---|---|
| `Device.statusReason` | 0..* |  | extensible | [device-status-reason](#device-status-reason) |  |
| `Device.type` | 0..1 |  | example | [device-type](#device-type) |  |
| `Device.specialization.systemType` | 1..1 |  |  |  |  |
| `Device.version.type` | 0..1 |  |  |  |  |
| `Device.property.type` | 1..1 |  |  |  |  |
| `Device.property.valueCode` | 0..* |  |  |  |  |
| `Device.safety` | 0..* |  |  |  |  |

## DeviceUvIps (Device)

`http://hl7.org/fhir/uv/ips/StructureDefinition/Device-uv-ips` - not referenced from a section

| Element | Card. | MS | Binding | Value set | Pattern / fixed |
|---|---|---|---|---|---|
| `Device.statusReason` | 0..* |  | extensible | [device-status-reason](#device-status-reason) |  |
| `Device.type` | 0..1 | Y | preferred | [medical-devices-snomed-absent-unknown-uv-ips](#medical-devices-snomed-absent-unknown-uv-ips) |  |
| `Device.specialization.systemType` | 1..1 |  |  |  |  |
| `Device.version.type` | 0..1 |  |  |  |  |
| `Device.property.type` | 1..1 |  |  |  |  |
| `Device.property.valueCode` | 0..* |  |  |  |  |
| `Device.safety` | 0..* |  |  |  |  |

## ImagingStudyUvIps (ImagingStudy)

`http://hl7.org/fhir/uv/ips/StructureDefinition/ImagingStudy-uv-ips` - not referenced from a section

| Element | Card. | MS | Binding | Value set | Pattern / fixed |
|---|---|---|---|---|---|
| `ImagingStudy.procedureCode` | 0..* | Y | extensible | [results-radiology-observations-uv-ips](#results-radiology-observations-uv-ips) |  |
| `ImagingStudy.reasonCode` | 0..* | Y | example | [procedure-reason](#procedure-reason) |  |
| `ImagingStudy.series.performer.function` | 0..1 |  | extensible | [series-performer-function](#series-performer-function) |  |

## MediaObservationUvIps (Media)

`http://hl7.org/fhir/uv/ips/StructureDefinition/Media-observation-uv-ips` - not referenced from a section

| Element | Card. | MS | Binding | Value set | Pattern / fixed |
|---|---|---|---|---|---|
| `Media.type` | 0..1 |  | extensible | [media-type](#media-type) |  |
| `Media.modality` | 0..1 |  | example | [media-modality](#media-modality) |  |
| `Media.view` | 0..1 |  | example | [media-view](#media-view) |  |
| `Media.reasonCode` | 0..* |  | example | [procedure-reason](#procedure-reason) |  |
| `Media.bodySite` | 0..1 |  | example | [body-site](#body-site) |  |

## MedicationIPS (Medication)

`http://hl7.org/fhir/uv/ips/StructureDefinition/Medication-uv-ips` - not referenced from a section

| Element | Card. | MS | Binding | Value set | Pattern / fixed |
|---|---|---|---|---|---|
| `Medication.code` | 1..1 | Y | preferred | [medication-snomed-absent-unknown-uv-ips](#medication-snomed-absent-unknown-uv-ips) |  |
| `Medication.form` | 0..1 | Y | preferred | [medicine-doseform](#medicine-doseform) |  |
| `Medication.ingredient.item[x]` (CodeableConcept/Reference) | 1..1 | Y | preferred | [medicine-active-substances-uv-ips](#medicine-active-substances-uv-ips) |  |

## ObservationPregnancyEddUvIps (Observation)

`http://hl7.org/fhir/uv/ips/StructureDefinition/Observation-pregnancy-edd-uv-ips` - not referenced from a section

| Element | Card. | MS | Binding | Value set | Pattern / fixed |
|---|---|---|---|---|---|
| `Observation.category` *(ignored)* | 0..* |  | preferred | [observation-category](#observation-category) |  |
| `Observation.code` | 1..1 | Y | required | [edd-method-uv-ips](#edd-method-uv-ips) |  |
| `Observation.value[x]` (Quantity/CodeableConcept/string/boolean/integer/Range/Ratio/SampledData/time/dateTime/Period) | 0..1 |  |  |  |  |
| `Observation.dataAbsentReason` | 0..1 |  | extensible | [data-absent-reason](#data-absent-reason) |  |
| `Observation.interpretation` | 0..* |  | extensible | [observation-interpretation](#observation-interpretation) |  |
| `Observation.referenceRange.type` | 0..1 |  | preferred | [referencerange-meaning](#referencerange-meaning) |  |
| `Observation.referenceRange.appliesTo` | 0..* |  | example | [referencerange-appliesto](#referencerange-appliesto) |  |
| `Observation.component.code` | 1..1 |  | example | [observation-codes](#observation-codes) |  |
| `Observation.component.value[x]` (Quantity/CodeableConcept/string/boolean/integer/Range/Ratio/SampledData/time/dateTime/Period) | 0..1 |  |  |  |  |
| `Observation.component.dataAbsentReason` | 0..1 |  | extensible | [data-absent-reason](#data-absent-reason) |  |
| `Observation.component.interpretation` | 0..* |  | extensible | [observation-interpretation](#observation-interpretation) |  |

## OrganizationUvIps (Organization)

`http://hl7.org/fhir/uv/ips/StructureDefinition/Organization-uv-ips` - not referenced from a section

| Element | Card. | MS | Binding | Value set | Pattern / fixed |
|---|---|---|---|---|---|
| `Organization.type` | 0..* |  | example | [organization-type](#organization-type) |  |
| `Organization.contact.purpose` | 0..1 |  | extensible | [contactentity-type](#contactentity-type) |  |

## PatientUvIps (Patient)

`http://hl7.org/fhir/uv/ips/StructureDefinition/Patient-uv-ips` - not referenced from a section

| Element | Card. | MS | Binding | Value set | Pattern / fixed |
|---|---|---|---|---|---|
| `Patient.maritalStatus` | 0..1 |  | extensible | [marital-status](#marital-status) |  |
| `Patient.contact.relationship` | 0..* |  | extensible | [patient-contactrelationship](#patient-contactrelationship) |  |
| `Patient.communication.language` | 1..1 |  | preferred | [languages](#languages) |  |

## PractitionerUvIps (Practitioner)

`http://hl7.org/fhir/uv/ips/StructureDefinition/Practitioner-uv-ips` - not referenced from a section

| Element | Card. | MS | Binding | Value set | Pattern / fixed |
|---|---|---|---|---|---|
| `Practitioner.qualification.code` | 1..1 |  | example | [v2-2.7-0360](#v2-2-7-0360) |  |
| `Practitioner.communication` | 0..* |  | preferred | [languages](#languages) |  |

## PractitionerRoleUvIps (PractitionerRole)

`http://hl7.org/fhir/uv/ips/StructureDefinition/PractitionerRole-uv-ips` - not referenced from a section

| Element | Card. | MS | Binding | Value set | Pattern / fixed |
|---|---|---|---|---|---|
| `PractitionerRole.code` | 0..* |  | preferred | [healthcare-professional-roles-uv-ips](#healthcare-professional-roles-uv-ips) |  |
| `PractitionerRole.specialty` | 0..* |  | preferred | [c80-practice-codes](#c80-practice-codes) |  |

## SpecimenUvIps (Specimen)

`http://hl7.org/fhir/uv/ips/StructureDefinition/Specimen-uv-ips` - not referenced from a section

| Element | Card. | MS | Binding | Value set | Pattern / fixed |
|---|---|---|---|---|---|
| `Specimen.type` | 1..1 |  | preferred | [results-specimen-type-uv-ips](#results-specimen-type-uv-ips) |  |
| `Specimen.collection.method` | 0..1 |  | preferred | [specimen-collection-method](#specimen-collection-method) |  |
| `Specimen.collection.bodySite` | 0..1 |  | preferred | [body-site-uv-ips](#body-site-uv-ips) |  |
| `Specimen.collection.fastingStatus[x]` (CodeableConcept/Duration) | 0..1 |  | extensible | [v2-0916](#v2-0916) |  |
| `Specimen.processing.procedure` | 0..1 |  | example | [specimen-processing-procedure](#specimen-processing-procedure) |  |
| `Specimen.container.type` | 0..1 |  | example | [specimen-container-type](#specimen-container-type) |  |
| `Specimen.container.additive[x]` (CodeableConcept/Reference) | 0..1 |  | example | [v2-0371](#v2-0371) |  |
| `Specimen.condition` | 0..* |  | extensible | [v2-0493](#v2-0493) |  |

# Value sets

The value sets the elements above are bound to, and the value sets those include.

## additional-instruction-codes

`http://hl7.org/fhir/ValueSet/additional-instruction-codes` version 4.0.1

Used by: `MedicationStatementIPS: MedicationStatement.dosage.additionalInstruction`, `MedicationRequestIPS: MedicationRequest.dosageInstruction.additionalInstruction`

This value set includes all SNOMED CT Additional Dosage Instructions.

- include system `http://snomed.info/sct`: `concept is-a 419492006`

## administration-method-codes

`http://hl7.org/fhir/ValueSet/administration-method-codes` version 4.0.1

Used by: `MedicationStatementIPS: MedicationStatement.dosage.method`, `MedicationRequestIPS: MedicationRequest.dosageInstruction.method`

This value set includes some method codes from SNOMED CT - provided as an exemplar

- include system `http://snomed.info/sct`: `concept is-a 422096002`

## allergyintolerance-clinical

`http://hl7.org/fhir/ValueSet/allergyintolerance-clinical` version 4.0.1

Used by: `AllergyIntoleranceUvIps: AllergyIntolerance.clinicalStatus`

Preferred value set for AllergyIntolerance Clinical Status.

- include system `http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical`

## allergyintolerance-verification

`http://hl7.org/fhir/ValueSet/allergyintolerance-verification` version 4.0.1

Used by: `AllergyIntoleranceUvIps: AllergyIntolerance.verificationStatus`

Preferred value set for AllergyIntolerance Verification Status.

- include system `http://terminology.hl7.org/CodeSystem/allergyintolerance-verification`

## approach-site-codes

`http://hl7.org/fhir/ValueSet/approach-site-codes` version 4.0.1

Used by: `MedicationStatementIPS: MedicationStatement.dosage.site`, `MedicationRequestIPS: MedicationRequest.dosageInstruction.site`

This value set includes Anatomical Structure codes from SNOMED CT - provided as an exemplar.

- include system `http://snomed.info/sct`: `concept is-a 91723000`

## body-site

`http://hl7.org/fhir/ValueSet/body-site` version 4.0.1

Used by: `ConditionUvIps: Condition.bodySite`, `ProcedureUvIps: Procedure.bodySite`, `ImmunizationUvIps: Immunization.site`, `DeviceUseStatementUvIps: DeviceUseStatement.bodySite`, `ObservationResultsUvIps: Observation.bodySite`, `ObservationResultsLaboratoryUvIps: Observation.bodySite`, `ObservationResultsPathologyUvIps: Observation.bodySite`, `ObservationResultsRadiologyUvIps: Observation.bodySite`, `observation-vitalsigns: Observation.bodySite`, `ObservationTobaccoUseUvIps: Observation.bodySite`, `ObservationAlcoholUseUvIps: Observation.bodySite`, `MediaObservationUvIps: Media.bodySite`

This value set includes all codes from [SNOMED CT](http://snomed.info/sct) where concept is-a 442083009 (Anatomical or acquired body site (body structure)).

- include system `http://snomed.info/sct`: `concept is-a 442083009`

## c80-practice-codes

`http://hl7.org/fhir/ValueSet/c80-practice-codes` version 4.0.1

Used by: `PractitionerRoleUvIps: PractitionerRole.specialty`

This is the code representing the clinical specialty of the clinician or provider who interacted with, treated, or provided a service to/for the patient. The value set used for clinical specialty has been limited by HITSP to the value set reproduced from HITSP C80 Table 2-149 Clinical Specialty Value Set Definition.

- include system `http://snomed.info/sct`: 117 concepts - 408467006 (Adult mental illness), 394577000 (Anesthetics), 394578005 (Audiological medicine), 421661004 (Blood banking and transfusion medicine), 408462000 (Burns care), 394579002 (Cardiology), 394804000 (Clinical cytogenetics and molecular genetics), 394580004 (Clinical genetics), ...

## clinical-findings

`http://hl7.org/fhir/ValueSet/clinical-findings` version 4.0.1

Used by: `DiagnosticReportUvIps: DiagnosticReport.conclusionCode`

This value set includes all the "Clinical finding" [SNOMED CT](http://snomed.info/sct) codes - concepts where concept is-a 404684003 (Clinical finding (finding)).

- include system `http://snomed.info/sct`: `concept is-a 404684003`

## condition-clinical

`http://hl7.org/fhir/ValueSet/condition-clinical` version 4.0.1

Used by: `ConditionUvIps: Condition.clinicalStatus`

Preferred value set for Condition Clinical Status.

- include system `http://terminology.hl7.org/CodeSystem/condition-clinical`

## condition-code

`http://hl7.org/fhir/ValueSet/condition-code` version 4.0.1

Used by: `MedicationStatementIPS: MedicationStatement.reasonCode`, `MedicationRequestIPS: MedicationRequest.reasonCode`, `ProcedureUvIps: Procedure.complication`

Example value set for Condition/Problem/Diagnosis codes.

- include system `http://snomed.info/sct`: `concept is-a 404684003`
- include system `http://snomed.info/sct`: 1 concept - 160245001 (No current problems or disability)

## condition-severity

`http://hl7.org/fhir/ValueSet/condition-severity` version 4.0.1

Used by: `ConditionUvIps: Condition.severity`

Preferred value set for Condition/Diagnosis severity grading.

- include system `http://snomed.info/sct`: 3 concepts - 24484000, 6736007, 255604002

## condition-stage

`http://hl7.org/fhir/ValueSet/condition-stage` version 4.0.1

Used by: `ConditionUvIps: Condition.stage.summary`

Example value set for stages of cancer and other conditions.

- include system `http://snomed.info/sct`: `concept is-a 385356007`

## condition-stage-type

`http://hl7.org/fhir/ValueSet/condition-stage-type` version 4.0.1

Used by: `ConditionUvIps: Condition.stage.type`

Example value set for the type of stages of cancer and other conditions

- include system `http://snomed.info/sct`: 1 concept - 261023001 (Pathological staging (qualifier value))
- include system `http://snomed.info/sct`: 1 concept - 260998006 (Clinical staging (qualifier value))
- include system `http://snomed.info/sct`: `concept is-a 254291000`

## condition-ver-status

`http://hl7.org/fhir/ValueSet/condition-ver-status` version 4.0.1

Used by: `ConditionUvIps: Condition.verificationStatus`

The verification status to support or decline the clinical status of the condition or diagnosis.

- include system `http://terminology.hl7.org/CodeSystem/condition-ver-status`

## contactentity-type

`http://hl7.org/fhir/ValueSet/contactentity-type` version 4.0.1

Used by: `OrganizationUvIps: Organization.contact.purpose`

This example value set defines a set of codes that can be used to indicate the purpose for which you would contact a contact party.

- include system `http://terminology.hl7.org/CodeSystem/contactentity-type`

## data-absent-reason

`http://hl7.org/fhir/ValueSet/data-absent-reason` version 4.0.1

Used by: `ObservationResultsUvIps: Observation.dataAbsentReason`, `ObservationResultsUvIps: Observation.component.dataAbsentReason`, `ObservationResultsLaboratoryUvIps: Observation.dataAbsentReason`, `ObservationResultsLaboratoryUvIps: Observation.component.dataAbsentReason`, `ObservationResultsPathologyUvIps: Observation.dataAbsentReason`, `ObservationResultsPathologyUvIps: Observation.component.dataAbsentReason`, `ObservationResultsRadiologyUvIps: Observation.dataAbsentReason`, `ObservationResultsRadiologyUvIps: Observation.component.dataAbsentReason`, `ObservationResultsRadiologyUvIps: Observation.component:observationText.dataAbsentReason`, `ObservationResultsRadiologyUvIps: Observation.component:observationCode.dataAbsentReason`, `ObservationResultsRadiologyUvIps: Observation.component:numericQuantityMeasurement.dataAbsentReason`, `ObservationResultsRadiologyUvIps: Observation.component:numericRangeMeasurement.dataAbsentReason`, `ObservationResultsRadiologyUvIps: Observation.component:numericRatioMeasurement.dataAbsentReason`, `ObservationResultsRadiologyUvIps: Observation.component:numericSampledDataMeasurement.dataAbsentReason`, `observation-vitalsigns: Observation.dataAbsentReason`, `observation-vitalsigns: Observation.component.dataAbsentReason`, `ObservationTobaccoUseUvIps: Observation.dataAbsentReason`, `ObservationTobaccoUseUvIps: Observation.component.dataAbsentReason`, `ObservationAlcoholUseUvIps: Observation.dataAbsentReason`, `ObservationAlcoholUseUvIps: Observation.component.dataAbsentReason`, `ObservationPregnancyStatusUvIps: Observation.dataAbsentReason`, `ObservationPregnancyStatusUvIps: Observation.component.dataAbsentReason`, `ObservationPregnancyOutcomeUvIps: Observation.dataAbsentReason`, `ObservationPregnancyOutcomeUvIps: Observation.component.dataAbsentReason`, `ObservationPregnancyEddUvIps: Observation.dataAbsentReason`, `ObservationPregnancyEddUvIps: Observation.component.dataAbsentReason`

Used to specify why the normally expected content of the data element is missing.

- include system `http://terminology.hl7.org/CodeSystem/data-absent-reason`

## device-action

`http://hl7.org/fhir/ValueSet/device-action` version 4.0.1

Used by: `ProcedureUvIps: Procedure.focalDevice.action`

Example codes indicating the change that happened to the device during the procedure. Note that these are in no way complete and might not even be appropriate for some uses.

- include system `http://snomed.info/sct`: `concept is-a 129264002`

## device-kind

`http://hl7.org/fhir/ValueSet/device-kind` version 4.0.1

Used by: `ProcedureUvIps: Procedure.usedCode`

Codes used to identify medical devices. Includes concepts from SNOMED CT (http://www.snomed.org/) where concept is-a 49062001 (Device) and is provided as a suggestive example.

- include system `http://snomed.info/sct`: `concept is-a 49062001`

## device-status-reason

`http://hl7.org/fhir/ValueSet/device-status-reason` version 4.0.1

Used by: `DeviceObserverUvIps: Device.statusReason`, `DeviceUvIps: Device.statusReason`

The availability status reason of the device.

- include system `http://terminology.hl7.org/CodeSystem/device-status-reason`

## device-type

`http://hl7.org/fhir/ValueSet/device-type` version 4.0.1

Used by: `DeviceObserverUvIps: Device.type`

Codes used to identify medical devices. Includes concepts from SNOMED CT (http://www.snomed.org/) where concept is-a 49062001 (Device) and is provided as a suggestive example.

- include system `http://snomed.info/sct`: `concept is-a 49062001`

## diagnostic-service-sections

`http://hl7.org/fhir/ValueSet/diagnostic-service-sections` version 4.0.1

Used by: `DiagnosticReportUvIps: DiagnosticReport.category`

This value set includes all the codes in HL7 V2 table 0074.

- include system `http://terminology.hl7.org/CodeSystem/v2-0074`

## dicom-cid29

`http://hl7.org/fhir/ValueSet/dicom-cid29` - **not in the IPS or core package**

Used by: `(included by media-modality)`


## doc-section-codes

`http://hl7.org/fhir/ValueSet/doc-section-codes` version 4.0.1

Used by: `CompositionUvIps: Composition.section.code`, `CompositionUvIps: Composition.section:sectionMedications.code`, `CompositionUvIps: Composition.section:sectionAllergies.code`, `CompositionUvIps: Composition.section:sectionProblems.code`, `CompositionUvIps: Composition.section:sectionProceduresHx.code`, `CompositionUvIps: Composition.section:sectionImmunizations.code`, `CompositionUvIps: Composition.section:sectionMedicalDevices.code`, `CompositionUvIps: Composition.section:sectionResults.code`, `CompositionUvIps: Composition.section:sectionVitalSigns.code`, `CompositionUvIps: Composition.section:sectionPastIllnessHx.code`, `CompositionUvIps: Composition.section:sectionFunctionalStatus.code`, `CompositionUvIps: Composition.section:sectionPlanOfCare.code`, `CompositionUvIps: Composition.section:sectionSocialHistory.code`, `CompositionUvIps: Composition.section:sectionPregnancyHx.code`, `CompositionUvIps: Composition.section:sectionAdvanceDirectives.code`

Document section codes (LOINC codes used in CCDA sections).

- include system `http://loinc.org`: 57 concepts - 10154-3, 10157-6, 10160-0, 10164-2, 10183-2, 10184-0, 10187-3, 10210-3, ...

## doc-typecodes

`http://hl7.org/fhir/ValueSet/doc-typecodes` version 4.0.1

Used by: `CompositionUvIps: Composition.type`

FHIR Document Codes - all LOINC codes where scale type = 'DOC'.

- include system `http://loinc.org`: `SCALE_TYP = Doc`

## document-classcodes

`http://hl7.org/fhir/ValueSet/document-classcodes` version 4.0.1

Used by: `CompositionUvIps: Composition.category`

This is the code specifying the high-level kind of document (e.g. Prescription, Discharge Summary, Report, etc.). Note: Class code for documents comes from LOINC, and is based upon one of the following:The type of service described by the document. It is described at a very high level in Section 7.3 of the LOINC Manual. The type study performed. It was determined by identifying modalities for study reports. The section of the chart where the document is placed. It was determined from the SETs created for Claims Attachment requests.

- include system `http://loinc.org`: 45 concepts - 11369-6 (History of Immunization), 11485-0 (Anesthesia records), 11486-8 (Chemotherapy records), 11488-4 (Consult Note), 11506-3 (Provider-unspecified progress note), 11543-6 (Nursery records), 15508-5 (Labor and delivery records), 18726-0 (Radiology studies (set)), ...

## dose-rate-type

`http://hl7.org/fhir/ValueSet/dose-rate-type` version 4.0.1

Used by: `MedicationStatementIPS: MedicationStatement.dosage.doseAndRate.type`, `MedicationRequestIPS: MedicationRequest.dosageInstruction.doseAndRate.type`

The kind of dose or rate specified.

- include system `http://terminology.hl7.org/CodeSystem/dose-rate-type`

## immunization-function

`http://hl7.org/fhir/ValueSet/immunization-function` version 4.0.1

Used by: `ImmunizationUvIps: Immunization.performer.function`

The value set to instantiate this attribute should be drawn from a terminologically robust code system that consists of or contains concepts to support describing the function a practitioner or organization may play in the immunization event. This value set is provided as a suggestive example.

- include system `http://terminology.hl7.org/CodeSystem/v2-0443`: 2 concepts - OP, AP

## immunization-funding-source

`http://hl7.org/fhir/ValueSet/immunization-funding-source` version 4.0.1

Used by: `ImmunizationUvIps: Immunization.fundingSource`

The value set to instantiate this attribute should be drawn from a terminologically robust code system that consists of or contains concepts to support describing the source of the vaccine administered. This value set is provided as a suggestive example.

- include system `http://terminology.hl7.org/CodeSystem/immunization-funding-source`

## immunization-origin

`http://hl7.org/fhir/ValueSet/immunization-origin` version 4.0.1

Used by: `ImmunizationUvIps: Immunization.reportOrigin`

The value set to instantiate this attribute should be drawn from a terminologically robust code system that consists of or contains concepts to support describing the source of the data when the report of the immunization event is not based on information from the person, entity or organization who administered the vaccine. This value set is provided as a suggestive example.

- include system `http://terminology.hl7.org/CodeSystem/immunization-origin`: 4 concepts - provider (Other Provider), record (Written Record), recall (Parent/Guardian/Patient Recall), school (School Record)

## immunization-program-eligibility

`http://hl7.org/fhir/ValueSet/immunization-program-eligibility` version 4.0.1

Used by: `ImmunizationUvIps: Immunization.programEligibility`

The value set to instantiate this attribute should be drawn from a terminologically robust code system that consists of or contains concepts to support describing the patient's eligibility for a vaccination program. This value set is provided as a suggestive example.

- include system `http://terminology.hl7.org/CodeSystem/immunization-program-eligibility`

## immunization-reason

`http://hl7.org/fhir/ValueSet/immunization-reason` version 4.0.1

Used by: `ImmunizationUvIps: Immunization.reasonCode`

The value set to instantiate this attribute should be drawn from a terminologically robust code system that consists of or contains concepts to support describing the reason why a dose of vaccine was administered. This value set is provided as a suggestive example.

- include system `http://snomed.info/sct`: 2 concepts - 429060002, 281657000

## immunization-status-reason

`http://hl7.org/fhir/ValueSet/immunization-status-reason` version 4.0.1

Used by: `ImmunizationUvIps: Immunization.statusReason`

The value set to instantiate this attribute should be drawn from a terminologically robust code system that consists of or contains concepts to support describing the reason why a dose of vaccine was not administered. This value set is provided as a suggestive example.

- include system `http://terminology.hl7.org/CodeSystem/v3-ActReason`: 4 concepts - IMMUNE, MEDPREC, OSTOCK, PATOBJ
- include system `http://snomed.info/sct`: `concept is-a 310376006`

## immunization-subpotent-reason

`http://hl7.org/fhir/ValueSet/immunization-subpotent-reason` version 4.0.1

Used by: `ImmunizationUvIps: Immunization.subpotentReason`

The value set to instantiate this attribute should be drawn from a terminologically robust code system that consists of or contains concepts to support describing the reason why a dose is considered to be subpotent. This value set is provided as a suggestive example.

- include system `http://terminology.hl7.org/CodeSystem/immunization-subpotent-reason`

## languages

`http://hl7.org/fhir/ValueSet/languages` version 4.0.1

Used by: `PatientUvIps: Patient.communication.language`, `PractitionerUvIps: Practitioner.communication`

This value set includes common codes from BCP-47 (http://tools.ietf.org/html/bcp47)

- include system `urn:ietf:bcp:47`: 56 concepts - ar (Arabic), bn (Bengali), cs (Czech), da (Danish), de (German), de-AT (German (Austria)), de-CH (German (Switzerland)), de-DE (German (Germany)), ...

## list-empty-reason

`http://hl7.org/fhir/ValueSet/list-empty-reason` version 4.0.1

Used by: `CompositionUvIps: Composition.section:sectionMedications.emptyReason`, `CompositionUvIps: Composition.section:sectionAllergies.emptyReason`, `CompositionUvIps: Composition.section:sectionProblems.emptyReason`, `CompositionUvIps: Composition.section:sectionProceduresHx.emptyReason`, `CompositionUvIps: Composition.section:sectionImmunizations.emptyReason`, `CompositionUvIps: Composition.section:sectionMedicalDevices.emptyReason`, `CompositionUvIps: Composition.section:sectionResults.emptyReason`, `CompositionUvIps: Composition.section:sectionVitalSigns.emptyReason`, `CompositionUvIps: Composition.section:sectionPastIllnessHx.emptyReason`, `CompositionUvIps: Composition.section:sectionFunctionalStatus.emptyReason`, `CompositionUvIps: Composition.section:sectionPlanOfCare.emptyReason`, `CompositionUvIps: Composition.section:sectionSocialHistory.emptyReason`, `CompositionUvIps: Composition.section:sectionPregnancyHx.emptyReason`, `CompositionUvIps: Composition.section:sectionAdvanceDirectives.emptyReason`

General reasons for a list to be empty. Reasons are either related to a summary list (i.e. problem or medication list) or to a workflow related list (i.e. consultation list).

- include system `http://terminology.hl7.org/CodeSystem/list-empty-reason`

## list-order

`http://hl7.org/fhir/ValueSet/list-order` version 4.0.1

Used by: `CompositionUvIps: Composition.section.orderedBy`, `CompositionUvIps: Composition.section:sectionMedications.orderedBy`, `CompositionUvIps: Composition.section:sectionAllergies.orderedBy`, `CompositionUvIps: Composition.section:sectionProblems.orderedBy`, `CompositionUvIps: Composition.section:sectionProceduresHx.orderedBy`, `CompositionUvIps: Composition.section:sectionImmunizations.orderedBy`, `CompositionUvIps: Composition.section:sectionMedicalDevices.orderedBy`, `CompositionUvIps: Composition.section:sectionResults.orderedBy`, `CompositionUvIps: Composition.section:sectionVitalSigns.orderedBy`, `CompositionUvIps: Composition.section:sectionPastIllnessHx.orderedBy`, `CompositionUvIps: Composition.section:sectionFunctionalStatus.orderedBy`, `CompositionUvIps: Composition.section:sectionPlanOfCare.orderedBy`, `CompositionUvIps: Composition.section:sectionSocialHistory.orderedBy`, `CompositionUvIps: Composition.section:sectionPregnancyHx.orderedBy`, `CompositionUvIps: Composition.section:sectionAdvanceDirectives.orderedBy`

Base values for the order of the items in a list resource.

- include system `http://terminology.hl7.org/CodeSystem/list-order`

## manifestation-or-symptom

`http://hl7.org/fhir/ValueSet/manifestation-or-symptom` version 4.0.1

Used by: `ConditionUvIps: Condition.evidence.code`

Example value set for Manifestation and Symptom codes.

- include system `http://snomed.info/sct`: `concept is-a 404684003`

## marital-status

`http://hl7.org/fhir/ValueSet/marital-status` version 4.0.1

Used by: `PatientUvIps: Patient.maritalStatus`

This value set defines the set of codes that can be used to indicate the marital status of a person.

- include system `http://terminology.hl7.org/CodeSystem/v3-MaritalStatus`
- include system `http://terminology.hl7.org/CodeSystem/v3-NullFlavor`: 1 concept - UNK

## media-modality

`http://hl7.org/fhir/ValueSet/media-modality` version 4.0.1

Used by: `MediaObservationUvIps: Media.modality`

Detailed information about the type of the image - its kind, purpose, or the kind of equipment used to generate it.

- include value set `http://hl7.org/fhir/ValueSet/dicom-cid29`
- include system `http://terminology.hl7.org/CodeSystem/media-modality`

## media-type

`http://hl7.org/fhir/ValueSet/media-type` version 4.0.1

Used by: `MediaObservationUvIps: Media.type`

Codes for high level media categories.

- include system `http://terminology.hl7.org/CodeSystem/media-type`

## media-view

`http://hl7.org/fhir/ValueSet/media-view` version 4.0.1

Used by: `MediaObservationUvIps: Media.view`

Codes defined in SNOMED CT that can be used to record Media Recording views.

- include system `http://snomed.info/sct`: `concept is-a 260419006`

## medication-as-needed-reason

`http://hl7.org/fhir/ValueSet/medication-as-needed-reason` version 4.0.1

Used by: `MedicationStatementIPS: MedicationStatement.dosage.asNeeded[x]`, `MedicationRequestIPS: MedicationRequest.dosageInstruction.asNeeded[x]`

This value set includes all clinical findings from SNOMED CT - provided as an exemplar value set.

- include system `http://snomed.info/sct`: `concept is-a 404684003`

## medication-statement-category

`http://hl7.org/fhir/ValueSet/medication-statement-category` version 4.0.1

Used by: `MedicationStatementIPS: MedicationStatement.category`

Medication Status Codes

- include system `http://terminology.hl7.org/CodeSystem/medication-statement-category`

## medicationrequest-category

`http://hl7.org/fhir/ValueSet/medicationrequest-category` version 4.0.1

Used by: `MedicationRequestIPS: MedicationRequest.category`

MedicationRequest Category Codes

- include system `http://terminology.hl7.org/CodeSystem/medicationrequest-category`

## medicationrequest-course-of-therapy

`http://hl7.org/fhir/ValueSet/medicationrequest-course-of-therapy` version 4.0.1

Used by: `MedicationRequestIPS: MedicationRequest.courseOfTherapyType`

MedicationRequest Course of Therapy Codes

- include system `http://terminology.hl7.org/CodeSystem/medicationrequest-course-of-therapy`

## medicationrequest-status-reason

`http://hl7.org/fhir/ValueSet/medicationrequest-status-reason` version 4.0.1

Used by: `MedicationRequestIPS: MedicationRequest.statusReason`

MedicationRequest Status Reason Codes

- include system `http://terminology.hl7.org/CodeSystem/medicationrequest-status-reason`

## observation-category

`http://hl7.org/fhir/ValueSet/observation-category` version 4.0.1

Used by: `ObservationResultsUvIps: Observation.category`, `ObservationResultsLaboratoryUvIps: Observation.category`, `ObservationResultsLaboratoryUvIps: Observation.category:laboratory`, `ObservationResultsPathologyUvIps: Observation.category`, `ObservationResultsPathologyUvIps: Observation.category:laboratory`, `ObservationResultsRadiologyUvIps: Observation.category`, `ObservationResultsRadiologyUvIps: Observation.category:radiology`, `observation-vitalsigns: Observation.category`, `observation-vitalsigns: Observation.category:VSCat`, `ObservationTobaccoUseUvIps: Observation.category`, `ObservationAlcoholUseUvIps: Observation.category`, `ObservationPregnancyStatusUvIps: Observation.category`, `ObservationPregnancyOutcomeUvIps: Observation.category`, `ObservationPregnancyEddUvIps: Observation.category`

Observation Category codes.

- include system `http://terminology.hl7.org/CodeSystem/observation-category`

## observation-codes

`http://hl7.org/fhir/ValueSet/observation-codes` version 4.0.1

Used by: `ObservationResultsUvIps: Observation.code`, `ObservationResultsUvIps: Observation.component.code`, `ObservationResultsLaboratoryUvIps: Observation.component.code`, `ObservationResultsPathologyUvIps: Observation.component.code`, `ObservationResultsRadiologyUvIps: Observation.component.code`, `ObservationTobaccoUseUvIps: Observation.code`, `ObservationTobaccoUseUvIps: Observation.component.code`, `ObservationAlcoholUseUvIps: Observation.code`, `ObservationAlcoholUseUvIps: Observation.component.code`, `ObservationPregnancyStatusUvIps: Observation.code`, `ObservationPregnancyStatusUvIps: Observation.component.code`, `ObservationPregnancyOutcomeUvIps: Observation.component.code`, `ObservationPregnancyEddUvIps: Observation.component.code`

This value set includes all LOINC codes

- include system `http://loinc.org`

## observation-interpretation

`http://hl7.org/fhir/ValueSet/observation-interpretation` version 4.0.1

Used by: `ObservationResultsUvIps: Observation.interpretation`, `ObservationResultsUvIps: Observation.component.interpretation`, `ObservationResultsLaboratoryUvIps: Observation.interpretation`, `ObservationResultsLaboratoryUvIps: Observation.component.interpretation`, `ObservationResultsPathologyUvIps: Observation.interpretation`, `ObservationResultsPathologyUvIps: Observation.component.interpretation`, `ObservationResultsRadiologyUvIps: Observation.interpretation`, `ObservationResultsRadiologyUvIps: Observation.component.interpretation`, `ObservationResultsRadiologyUvIps: Observation.component:observationText.interpretation`, `ObservationResultsRadiologyUvIps: Observation.component:observationCode.interpretation`, `ObservationResultsRadiologyUvIps: Observation.component:numericQuantityMeasurement.interpretation`, `ObservationResultsRadiologyUvIps: Observation.component:numericRangeMeasurement.interpretation`, `ObservationResultsRadiologyUvIps: Observation.component:numericRatioMeasurement.interpretation`, `ObservationResultsRadiologyUvIps: Observation.component:numericSampledDataMeasurement.interpretation`, `observation-vitalsigns: Observation.interpretation`, `observation-vitalsigns: Observation.component.interpretation`, `ObservationTobaccoUseUvIps: Observation.interpretation`, `ObservationTobaccoUseUvIps: Observation.component.interpretation`, `ObservationAlcoholUseUvIps: Observation.interpretation`, `ObservationAlcoholUseUvIps: Observation.component.interpretation`, `ObservationPregnancyStatusUvIps: Observation.interpretation`, `ObservationPregnancyStatusUvIps: Observation.component.interpretation`, `ObservationPregnancyOutcomeUvIps: Observation.interpretation`, `ObservationPregnancyOutcomeUvIps: Observation.component.interpretation`, `ObservationPregnancyEddUvIps: Observation.interpretation`, `ObservationPregnancyEddUvIps: Observation.component.interpretation`

A categorical assessment, providing a rough qualitative interpretation of the observation value, such as “normal”/ “abnormal”,”low” / “high”, “better” / “worse”, “susceptible” / “resistant”, “expected”/ “not expected”. The value set is intended to be for ANY use where coded representation of an interpretation is needed. Notes: This is being communicated in v2.x in OBX-8 (Observation Interpretation), in v3 in ObservationInterpretation (CWE) in R1 (Representative Realm) and in FHIR in Observation.interpretation. Historically these values come from the laboratory domain, and these codes are extensively used. The value set binding is extensible, so codes outside the value set that are needed for interpretation concepts (i.e. particular meanings) that are not included in the value set can be used, and these new codes may also be added to the value set and published in a future version.

- include system `http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation`

## observation-methods

`http://hl7.org/fhir/ValueSet/observation-methods` version 4.0.1

Used by: `ObservationResultsUvIps: Observation.method`, `ObservationResultsLaboratoryUvIps: Observation.method`, `ObservationResultsPathologyUvIps: Observation.method`, `ObservationResultsRadiologyUvIps: Observation.method`, `observation-vitalsigns: Observation.method`, `ObservationTobaccoUseUvIps: Observation.method`, `ObservationAlcoholUseUvIps: Observation.method`, `ObservationPregnancyStatusUvIps: Observation.method`, `ObservationPregnancyOutcomeUvIps: Observation.method`

Observation Method codes from [SNOMED CT](http://snomed.info/sct) where concept is-a 272394005 (Technique (qualifier value)) or is-a 129264002 (Action (qualifier value)) or is-a 386053000 (Evaluation procedure(procedure))

- include system `http://snomed.info/sct`: `concept is-a 272394005`
- include system `http://snomed.info/sct`: `concept is-a 129264002`
- include system `http://snomed.info/sct`: `concept is-a 386053000`

## observation-vitalsignresult

`http://hl7.org/fhir/ValueSet/observation-vitalsignresult` version 4.0.1

Used by: `observation-vitalsigns: Observation.code`, `observation-vitalsigns: Observation.component.code`

This value set indicates the allowed vital sign result types. The LOINC code for Vitals Signs panel (85353-1) is a grouping structure for a set of vital signs and includes related links (with type=has-member) to the Observations in this set (e.g. respiratory rate, heart rate, BP). The Blood pressure panel (85354-9) is used to group the component observations Systolic blood pressure (8480-6) and Diastolic blood pressure (8462-4).

- include system `http://loinc.org`: 13 concepts - 85353-1, 9279-1, 8867-4, 2708-6, 8310-5, 8302-2, 9843-4, 29463-7, 39156-5, 85354-9, 8480-6, 8462-4, 8478-0

## organization-type

`http://hl7.org/fhir/ValueSet/organization-type` version 4.0.1

Used by: `OrganizationUvIps: Organization.type`

This example value set defines a set of codes that can be used to indicate a type of organization.

- include system `http://terminology.hl7.org/CodeSystem/organization-type`

## patient-contactrelationship

`http://hl7.org/fhir/ValueSet/patient-contactrelationship` version 4.0.1

Used by: `PatientUvIps: Patient.contact.relationship`

The nature of the relationship between the patient and the contact person.

- include system `http://terminology.hl7.org/CodeSystem/v2-0131`: `concept is-not-a O`

## performer-role

`http://hl7.org/fhir/ValueSet/performer-role` version 4.0.1

Used by: `MedicationRequestIPS: MedicationRequest.performerType`, `ProcedureUvIps: Procedure.performer.function`

This example value set defines the set of codes that can be used to indicate a role of a procedure performer.

- include system `http://snomed.info/sct`: `concept is-a 223366009`

## procedure-category

`http://hl7.org/fhir/ValueSet/procedure-category` version 4.0.1

Used by: `ProcedureUvIps: Procedure.category`

Procedure Category code: A selection of relevant SNOMED CT codes.

- include system `http://snomed.info/sct`: 7 concepts - 24642003, 409063005, 409073007, 387713003, 103693007, 46947000, 410606002

## procedure-followup

`http://hl7.org/fhir/ValueSet/procedure-followup` version 4.0.1

Used by: `ProcedureUvIps: Procedure.followUp`

Procedure follow up codes: A selection of SNOMED CT codes relevant to procedure follow up.

- include system `http://snomed.info/sct`: 10 concepts - 18949003, 30549001, 241031001, 35963001, 225164002, 447346005, 229506003, 274441001, 394725008, 359825008

## procedure-not-performed-reason

`http://hl7.org/fhir/ValueSet/procedure-not-performed-reason` version 4.0.1

Used by: `ProcedureUvIps: Procedure.statusReason`

Situation codes describing the reason that a procedure, which might otherwise be expected, was not performed, or a procedure that was started and was not completed. Consists of SNOMED CT codes, children of procedure contraindicated (183932001), procedure discontinued (416406003), procedure not done (416237000), procedure not indicated (428119001), procedure not offered (416064006), procedure not wanted (416432009), procedure refused (183944003), and procedure stopped (394908001).

- include system `http://snomed.info/sct`: `concept is-a 183932001`
- include system `http://snomed.info/sct`: `concept is-a 416406003`
- include system `http://snomed.info/sct`: `concept is-a 416237000`
- include system `http://snomed.info/sct`: `concept is-a 428119001`
- include system `http://snomed.info/sct`: `concept is-a 416064006`
- include system `http://snomed.info/sct`: `concept is-a 416432009`
- include system `http://snomed.info/sct`: `concept is-a 183944003`
- include system `http://snomed.info/sct`: `concept is-a 394908001`

## procedure-outcome

`http://hl7.org/fhir/ValueSet/procedure-outcome` version 4.0.1

Used by: `ProcedureUvIps: Procedure.outcome`

Procedure Outcome code: A selection of relevant SNOMED CT codes.

- include system `http://snomed.info/sct`: 3 concepts - 385669000, 385671000, 385670004

## procedure-reason

`http://hl7.org/fhir/ValueSet/procedure-reason` version 4.0.1

Used by: `ProcedureUvIps: Procedure.reasonCode`, `ImagingStudyUvIps: ImagingStudy.reasonCode`, `MediaObservationUvIps: Media.reasonCode`

This example value set defines the set of codes that can be used to indicate a reason for a procedure.

- include system `http://snomed.info/sct`: `concept is-a 404684003`
- include system `http://snomed.info/sct`: `concept is-a 71388002`

## reason-medication-status-codes

`http://hl7.org/fhir/ValueSet/reason-medication-status-codes` version 4.0.1

Used by: `MedicationStatementIPS: MedicationStatement.statusReason`

This value set includes some taken and not taken reason codes from SNOMED CT - provided as an exemplar

- include system `http://snomed.info/sct`: `concept is-a 266710000`
- include system `http://snomed.info/sct`: `concept is-a 410684002`

## referencerange-appliesto

`http://hl7.org/fhir/ValueSet/referencerange-appliesto` version 4.0.1

Used by: `ObservationResultsUvIps: Observation.referenceRange.appliesTo`, `ObservationResultsLaboratoryUvIps: Observation.referenceRange.appliesTo`, `ObservationResultsPathologyUvIps: Observation.referenceRange.appliesTo`, `ObservationResultsRadiologyUvIps: Observation.referenceRange.appliesTo`, `observation-vitalsigns: Observation.referenceRange.appliesTo`, `ObservationTobaccoUseUvIps: Observation.referenceRange.appliesTo`, `ObservationAlcoholUseUvIps: Observation.referenceRange.appliesTo`, `ObservationPregnancyStatusUvIps: Observation.referenceRange.appliesTo`, `ObservationPregnancyOutcomeUvIps: Observation.referenceRange.appliesTo`, `ObservationPregnancyEddUvIps: Observation.referenceRange.appliesTo`

This value set defines a set of codes that can be used to indicate the particular target population the reference range applies to.

- include value set `http://terminology.hl7.org/ValueSet/v3-Race`
- include system `http://snomed.info/sct`: 3 concepts - 248153007, 248152002, 77386006

## referencerange-meaning

`http://hl7.org/fhir/ValueSet/referencerange-meaning` version 4.0.1

Used by: `ObservationResultsUvIps: Observation.referenceRange.type`, `ObservationResultsLaboratoryUvIps: Observation.referenceRange.type`, `ObservationResultsPathologyUvIps: Observation.referenceRange.type`, `ObservationResultsRadiologyUvIps: Observation.referenceRange.type`, `observation-vitalsigns: Observation.referenceRange.type`, `ObservationTobaccoUseUvIps: Observation.referenceRange.type`, `ObservationAlcoholUseUvIps: Observation.referenceRange.type`, `ObservationPregnancyStatusUvIps: Observation.referenceRange.type`, `ObservationPregnancyOutcomeUvIps: Observation.referenceRange.type`, `ObservationPregnancyEddUvIps: Observation.referenceRange.type`

This value set defines a set of codes that can be used to indicate the meaning/use of a reference range for a particular target population.

- include system `http://terminology.hl7.org/CodeSystem/referencerange-meaning`

## report-codes

`http://hl7.org/fhir/ValueSet/report-codes` version 4.0.1

Used by: `DiagnosticReportUvIps: DiagnosticReport.code`

This value set includes LOINC codes that relate to Diagnostic Observations.

- include system `http://loinc.org`

## route-codes

`http://hl7.org/fhir/ValueSet/route-codes` version 4.0.1

Used by: `AllergyIntoleranceUvIps: AllergyIntolerance.reaction.exposureRoute`

This value set includes all Route codes from SNOMED CT - provided as an exemplar.

- include system `http://snomed.info/sct`: `concept is-a 284009009`

## series-performer-function

`http://hl7.org/fhir/ValueSet/series-performer-function` version 4.0.1

Used by: `ImagingStudyUvIps: ImagingStudy.series.performer.function`

Performer function of an agent in an imaging study series

- include system `http://terminology.hl7.org/CodeSystem/v3-ParticipationType`: 5 concepts - CON (consultant), VRF (verifier), PRF (performer), SPRF (secondary performer), REF (referrer)

## specimen-collection-method

`http://hl7.org/fhir/ValueSet/specimen-collection-method` version 4.0.1

Used by: `SpecimenUvIps: Specimen.collection.method`

This example value set defines a set of codes that can be used to indicate the method by which a specimen was collected.

- include system `http://snomed.info/sct`: 10 concepts - 129316008 (Aspiration - action), 129314006 (Biopsy - action), 129300006 (Puncture - action), 129304002 (Excision - action), 129323009 (Scraping - action), 73416001 (Urine specimen collection, clean catch), 225113003 (Timed urine collection), 70777001 (Urine specimen collection, catheterized), 386089008 (Collection of coughed sputum), 278450005 (Finger-prick sampling)

## specimen-container-type

`http://hl7.org/fhir/ValueSet/specimen-container-type` version 4.0.1

Used by: `SpecimenUvIps: Specimen.container.type`

Checks on the patient prior specimen collection. All SNOMED CT concepts descendants of 706041008 |Device for body fluid and tissue collection/transfer/processing (physical object)|

- include system `http://snomed.info/sct`: `concept is-a 706041008`

## specimen-processing-procedure

`http://hl7.org/fhir/ValueSet/specimen-processing-procedure` version 4.0.1

Used by: `SpecimenUvIps: Specimen.processing.procedure`

The technique that is used to perform the process or preserve the specimen.

- include system `http://terminology.hl7.org/CodeSystem/v2-0373`

## substance-code

`http://hl7.org/fhir/ValueSet/substance-code` version 4.0.1

Used by: `AllergyIntoleranceUvIps: AllergyIntolerance.reaction.substance`

This value set contains concept codes for specific substances. It includes codes from [SNOMED](http://snomed.info/sct) where concept is-a 105590001 (Substance (substance)) and where concept is-a 373873005 (Pharmaceutical / biologic product (product))

- include system `http://snomed.info/sct`: `concept is-a 105590001`
- include system `http://snomed.info/sct`: `concept is-a 373873005`

## ucum-vitals-common

`http://hl7.org/fhir/ValueSet/ucum-vitals-common` version 4.0.1

Used by: `observation-vitalsigns: Observation.component.value[x]`

Common UCUM units for recording Vital Signs

- include system `http://unitsofmeasure.org`: 12 concepts - % (percent), cm (centimeter), [in_i] (inch (international)), kg (kilogram), g (gram), [lb_av] (pound (US and British)), Cel (degree Celsius), [degF] (degree Fahrenheit), mm[Hg] (millimeter of mercury), /min (per minute), kg/m2 (kilogram / (meter ^ 2)), m2 (square meter)

## absent-or-unknown-allergies-uv-ips

`http://hl7.org/fhir/uv/ips/ValueSet/absent-or-unknown-allergies-uv-ips` version 1.1.0

Used by: `(included by allergy-intolerance-uv-ips)`

Absent or Unknown Allergies

- include system `http://hl7.org/fhir/uv/ips/CodeSystem/absent-unknown-uv-ips`: 5 concepts - no-allergy-info (No information about allergies), no-known-allergies (No known allergies), no-known-medication-allergies (No known medication allergies), no-known-environmental-allergies (No known environmental allergies), no-known-food-allergies (No known food allergies)

## absent-or-unknown-devices-uv-ips

`http://hl7.org/fhir/uv/ips/ValueSet/absent-or-unknown-devices-uv-ips` version 1.1.0

Used by: `(included by medical-devices-snomed-absent-unknown-uv-ips)`

Absent or Unknown Devices

- include system `http://hl7.org/fhir/uv/ips/CodeSystem/absent-unknown-uv-ips`: 2 concepts - no-device-info (No information about device), no-known-devices (No known devices in use)

## absent-or-unknown-immunizations-uv-ips

`http://hl7.org/fhir/uv/ips/ValueSet/absent-or-unknown-immunizations-uv-ips` version 1.1.0

Used by: `(included by vaccines-uv-ips)`

Absent or Unknown Immunization

- include system `http://hl7.org/fhir/uv/ips/CodeSystem/absent-unknown-uv-ips`: 2 concepts - no-immunization-info (No information about immunizations), no-known-immunizations (No known immunizations)

## absent-or-unknown-medications-uv-ips

`http://hl7.org/fhir/uv/ips/ValueSet/absent-or-unknown-medications-uv-ips` version 1.1.0

Used by: `(included by medication-snomed-absent-unknown-uv-ips)`

Absent or Unknown Medication

- include system `http://hl7.org/fhir/uv/ips/CodeSystem/absent-unknown-uv-ips`: 2 concepts - no-medication-info (No information about medications), no-known-medications (No known medications)

## absent-or-unknown-problems-uv-ips

`http://hl7.org/fhir/uv/ips/ValueSet/absent-or-unknown-problems-uv-ips` version 1.1.0

Used by: `(included by problems-snomed-absent-unknown-uv-ips)`

Absent or Unknown Problems

- include system `http://hl7.org/fhir/uv/ips/CodeSystem/absent-unknown-uv-ips`: 2 concepts - no-problem-info (No information about current problems), no-known-problems (No known problems)

## absent-or-unknown-procedures-uv-ips

`http://hl7.org/fhir/uv/ips/ValueSet/absent-or-unknown-procedures-uv-ips` version 1.1.0

Used by: `(included by procedures-snomed-absent-unknown-uv-ips)`

Absent or Unknown Procedures

- include system `http://hl7.org/fhir/uv/ips/CodeSystem/absent-unknown-uv-ips`: 2 concepts - no-procedure-info (No information about past history of procedures), no-known-procedures (No known procedures)

## allergy-intolerance-substance-condition-uv-ips

`http://hl7.org/fhir/uv/ips/ValueSet/allergy-intolerance-substance-condition-uv-ips` version 1.1.0

Used by: `(included by allergy-intolerance-uv-ips)`

IPS Allergy intolerance substance condition value set. This value set includes codes from SNOMED Clinical Terms®: all descendants of 373873005 \|Pharmaceutical / biologic product (product)\|; all descendants of 105590001 \|Substance (substance)\|; all descendants of 418038007 \|Propensity to adverse reactions to substance (finding)\|

- include system `http://snomed.info/sct` version http://snomed.info/sct/900000000000207008: `concept descendent-of 105590001`
- include system `http://snomed.info/sct` version http://snomed.info/sct/900000000000207008: `concept descendent-of 373873005`
- include system `http://snomed.info/sct` version http://snomed.info/sct/900000000000207008: `concept descendent-of 418038007`

## allergy-intolerance-uv-ips

`http://hl7.org/fhir/uv/ips/ValueSet/allergy-intolerance-uv-ips` version 1.1.0

Used by: `AllergyIntoleranceUvIps: AllergyIntolerance.code`

IPS Allergy intolerance codes value set. This value set includes codes from SNOMED Clinical Terms®: all descendants of 373873005 \|Pharmaceutical / biologic product (product)\|; all descendants of 105590001 \|Substance (substance)\|; all descendants of 418038007 \|Propensity to adverse reactions to substance (finding)\| plus codes for absent and unknown allergies.

- include value set `http://hl7.org/fhir/uv/ips/ValueSet/allergy-intolerance-substance-condition-uv-ips`
- include value set `http://hl7.org/fhir/uv/ips/ValueSet/absent-or-unknown-allergies-uv-ips`

## allergy-reaction-snomed-ct-ips-free-set

`http://hl7.org/fhir/uv/ips/ValueSet/allergy-reaction-snomed-ct-ips-free-set` version 1.1.0

Used by: `AllergyIntoleranceUvIps: AllergyIntolerance.reaction.manifestation`

IPS allergy reaction value set. This value set includes the codes from the SNOMED International Patient Set (IPS) subset of SNOMED CT (IPS Free Set) that may be used to represent allergy or intolerance reactions.

- include system `http://snomed.info/sct` version http://snomed.info/sct/900000000000207008: 31 concepts - 4386001 (Bronchospasm (finding)), 9826008 (Conjunctivitis (disorder)), 23924001 (Tight chest (finding)), 24079001 (Atopic dermatitis (disorder)), 31996006 (Vasculitis (disorder)), 39579001 (Anaphylaxis (disorder)), 41291007 (Angioedema (disorder)), 43116000 (Eczema (disorder)), ...

## body-site-uv-ips

`http://hl7.org/fhir/uv/ips/ValueSet/body-site-uv-ips` version 1.1.0

Used by: `SpecimenUvIps: Specimen.collection.bodySite`

IPS body site value set. This value set includes a set of codes from SNOMED CT that may be used to represent body sites (e.g., for laboratory specimen collection).

- include system `http://snomed.info/sct` version http://snomed.info/sct/900000000000207008: `concept descendent-of 442083009`

## current-smoking-status-uv-ips

`http://hl7.org/fhir/uv/ips/ValueSet/current-smoking-status-uv-ips` version 1.1.0

Used by: `ObservationTobaccoUseUvIps: Observation.value[x]:valueCodeableConcept`

HL7 LOINC value set for smoking status. Based on the HL7 Vocab and Structured Doc WG (formerly TC) consensus - per US CDC submission 7/12/2012 for smoking status terms.

- include system `http://loinc.org`: 8 concepts - LA18976-3 (Current every day smoker), LA18977-1 (Current some day smoker), LA15920-4 (Former smoker), LA18978-9 (Never smoker), LA18979-7 (Smoker, current status unknown), LA18980-5 (Unknown if ever smoked), LA18981-3 (Heavy tobacco smoker), LA18982-1 (Light tobacco smoker)

## edd-method-uv-ips

`http://hl7.org/fhir/uv/ips/ValueSet/edd-method-uv-ips` version 1.1.0

Used by: `ObservationPregnancyEddUvIps: Observation.code`

IPS Expected Delivery Date Method

- include system `http://loinc.org`: 3 concepts - 11778-8 (Delivery date Estimated), 11779-6 (Delivery date Estimated from last menstrual period), 11780-4 (Delivery date Estimated from ovulation date)

## healthcare-professional-roles-uv-ips

`http://hl7.org/fhir/uv/ips/ValueSet/healthcare-professional-roles-uv-ips` version 1.1.0

Used by: `PractitionerRoleUvIps: PractitionerRole.code`

IPS Healthcare Professional Roles

- include system `urn:oid:2.16.840.1.113883.2.9.6.2.7`

## medical-devices-snomed-absent-unknown-uv-ips

`http://hl7.org/fhir/uv/ips/ValueSet/medical-devices-snomed-absent-unknown-uv-ips` version 1.1.0

Used by: `DeviceUvIps: Device.type`

This value set includes codes from SNOMED Clinical Terms (SNOMED CT®) that are included in: all descendants of 49062001 \|Device (physical object)\|, plus IPS codes for absent/unknown devices.

- include value set `http://hl7.org/fhir/uv/ips/ValueSet/medical-devices-uv-ips`
- include value set `http://hl7.org/fhir/uv/ips/ValueSet/absent-or-unknown-devices-uv-ips`

## medical-devices-uv-ips

`http://hl7.org/fhir/uv/ips/ValueSet/medical-devices-uv-ips` version 1.1.0

Used by: `(included by medical-devices-snomed-absent-unknown-uv-ips)`

This value set includes codes from SNOMED Clinical Terms®: all descendants of 49062001 \|Device (physical object)\|.

- include system `http://snomed.info/sct` version http://snomed.info/sct/900000000000207008: `concept descendent-of 49062001`

## medication-snomed-absent-unknown-uv-ips

`http://hl7.org/fhir/uv/ips/ValueSet/medication-snomed-absent-unknown-uv-ips` version 1.1.0

Used by: `MedicationStatementIPS: MedicationStatement.medication[x]`, `MedicationRequestIPS: MedicationRequest.medication[x]`, `MedicationIPS: Medication.code`

This value set includes the codes from SNOMED CT that are included in: descendants of 373873005 \|Pharmaceutical / biologic product (product)\|, excluding the descendants of 787859002 \|Vaccine product (medicinal product)\|, plus IPS codes for absent/unknown medications.

- include value set `http://hl7.org/fhir/uv/ips/ValueSet/medication-snomed-uv-ips`
- include value set `http://hl7.org/fhir/uv/ips/ValueSet/absent-or-unknown-medications-uv-ips`

## medication-snomed-uv-ips

`http://hl7.org/fhir/uv/ips/ValueSet/medication-snomed-uv-ips` version 1.1.0

Used by: `(included by medication-snomed-absent-unknown-uv-ips)`

This value set includes codes from SNOMED Clinical Terms®: descendants of 373873005 \|Pharmaceutical / biologic product (product)\| excluding the descendants of 787859002 \|Vaccine product (medicinal product)\|.

- include system `http://snomed.info/sct` version http://snomed.info/sct/900000000000207008: `concept descendent-of 373873005`
- exclude system `http://snomed.info/sct` version http://snomed.info/sct/900000000000207008: `concept descendent-of 787859002`

## medicine-active-substances-uv-ips

`http://hl7.org/fhir/uv/ips/ValueSet/medicine-active-substances-uv-ips` version 1.1.0

Used by: `MedicationIPS: Medication.ingredient.item[x]`

This value set includes codes from SNOMED Clinical Terms®: all descendants of 410942007 | Drug or medicament (substance)|. Future implementations should consider ISO 11238 Health informatics -- Identification of medicinal products -- Data elements and structures for the unique identification and exchange of regulated information on substances.

- include system `http://snomed.info/sct` version http://snomed.info/sct/900000000000207008: `concept descendent-of 410942007`

## medicine-doseform

`http://hl7.org/fhir/uv/ips/ValueSet/medicine-doseform` version 1.1.0

Used by: `MedicationIPS: Medication.form`

EDQM (European Directorate for the Quality of Medicines and Healthcare) Dose Form codes. This Value Set includes all the EDQM Standard Terms having: [Concept Status] = ‘Current’ AND [Concept Class] IN (‘PDF’, ‘CMT’, ‘CDF’, ‘PFT') AND [Domain] = 'Human and Veterinary' PDF = 'Pharmaceutical dose form'; CMT = 'Combined terms'; CDF = 'Combined pharmaceutical dose form'; PFT = 'Patient Friendly'

- include system `http://standardterms.edqm.eu`: `status = Current` and `class = PDF` and `domain = Human and Veterinary`
- include system `http://standardterms.edqm.eu`: `status = Current` and `class = CMT` and `domain = Human and Veterinary`
- include system `http://standardterms.edqm.eu`: `status = Current` and `class = CDF` and `domain = Human and Veterinary`
- include system `http://standardterms.edqm.eu`: `status = Current` and `class = PFT` and `domain = Human and Veterinary`

## medicine-route-of-administration

`http://hl7.org/fhir/uv/ips/ValueSet/medicine-route-of-administration` version 1.1.0

Used by: `MedicationStatementIPS: MedicationStatement.dosage.route`, `MedicationRequestIPS: MedicationRequest.dosageInstruction.route`, `ImmunizationUvIps: Immunization.route`

EDQM (European Directorate for the Quality of Medicines and Healthcare) Route of Administration codes. This Value Set includes all the EDQM Standard Terms having: [Concept Status] = ‘Current’ AND [Concept Class] = 'ROA' AND [Domain] = 'Human and Veterinary' ROA = 'Route of administration'

- include system `http://standardterms.edqm.eu`: `status = Current` and `class = ROA` and `domain = Human and Veterinary`

## pregnancies-summary-uv-ips

`http://hl7.org/fhir/uv/ips/ValueSet/pregnancies-summary-uv-ips` version 1.1.0

Used by: `ObservationPregnancyOutcomeUvIps: Observation.code`

IPS Pregnancies Summary

- include system `http://loinc.org`: 9 concepts - 11636-8 ([#] Births.live), 11637-6 ([#] Births.preterm), 11638-4 ([#] Births.still living), 11639-2 ([#] Births.term), 11640-0 ([#] Births total), 11612-9 ([#] Abortions), 11613-7 ([#] Abortions.induced), 11614-5 ([#] Abortions.spontaneous), 33065-4 ([#] Ectopic pregnancy)

## pregnancy-status-uv-ips

`http://hl7.org/fhir/uv/ips/ValueSet/pregnancy-status-uv-ips` version 1.1.0

Used by: `ObservationPregnancyStatusUvIps: Observation.value[x]:valueCodeableConcept`

IPS Pregnancy Status

- include system `http://loinc.org`: 3 concepts - LA15173-0 (Pregnant), LA26683-5 (Not pregnant), LA4489-6 (Unknown)

## problem-type-uv-ips

`http://hl7.org/fhir/uv/ips/ValueSet/problem-type-uv-ips` version 1.1.0

Used by: `ConditionUvIps: Condition.category`

This value set provides a category for the condition as a clinical problem for inclusion in the patient summary.

- include system `http://terminology.hl7.org/CodeSystem/condition-category`: 1 concept - problem-list-item (Problem List Item)

## problems-snomed-absent-unknown-uv-ips

`http://hl7.org/fhir/uv/ips/ValueSet/problems-snomed-absent-unknown-uv-ips` version 1.1.0

Used by: `ConditionUvIps: Condition.code`

This value set includes codes from SNOMED Clinical Terms®: descendants of 404684003 \|Clinical finding (finding) \|, descendants of 243796009 \|Situation with explicit context (situation)\| and descendants of 272379006 \|Event (event)\| but excludes descendants of 71388002 \|Procedure (procedure)\|, as they are expected to be represented separately in the History of Procedures Section.

- include value set `http://hl7.org/fhir/uv/ips/ValueSet/problems-snomed-uv-ips`
- include value set `http://hl7.org/fhir/uv/ips/ValueSet/absent-or-unknown-problems-uv-ips`

## problems-snomed-uv-ips

`http://hl7.org/fhir/uv/ips/ValueSet/problems-snomed-uv-ips` version 1.1.0

Used by: `(included by problems-snomed-absent-unknown-uv-ips)`

This value set includes codes from SNOMED Clinical Terms®: descendants of 404684003 \|Clinical finding (finding) \|, descendants of 243796009 \|Situation with explicit context (situation)\| and descendants of 272379006 \|Event (event)\|. The descendants of 71388002 \|Procedure (procedure)\| (which were included in the CORE problem list) are not included, as they are expected to be represented separately in the History of Procedures Section.

- include system `http://snomed.info/sct` version http://snomed.info/sct/900000000000207008: `concept descendent-of 404684003`
- include system `http://snomed.info/sct` version http://snomed.info/sct/900000000000207008: `concept descendent-of 243796009`
- include system `http://snomed.info/sct` version http://snomed.info/sct/900000000000207008: `concept descendent-of 272379006`

## procedures-snomed-absent-unknown-uv-ips

`http://hl7.org/fhir/uv/ips/ValueSet/procedures-snomed-absent-unknown-uv-ips` version 1.1.0

Used by: `ProcedureUvIps: Procedure.code`

This value set includes codes from SNOMED Clinical Terms®: descendants of 71388002 \|Procedure (procedure)\|, excluding [all subtypes of 14734007 \|Administrative procedure (procedure)\|, all subtypes of 59524001 \|Blood bank procedure (procedure)\|, all subtypes of 389067005 \|Community health procedure (procedure)\|, all subtypes of 442006003 \|Determination of information related to transfusion (procedure)\|, all subtypes of 225288009 \|Environmental care procedure (procedure)\|, all subtypes of 308335008 \|Patient encounter procedure (procedure)\|, all subtypes of 710135002 \|Promotion (procedure)\|, all subtypes of 389084004 \|Staff related procedure (procedure)\|], plus IPS codes for absent/unknown procedures.

- include value set `http://hl7.org/fhir/uv/ips/ValueSet/procedures-uv-ips`
- include value set `http://hl7.org/fhir/uv/ips/ValueSet/absent-or-unknown-procedures-uv-ips`

## procedures-uv-ips

`http://hl7.org/fhir/uv/ips/ValueSet/procedures-uv-ips` version 1.1.0

Used by: `(included by procedures-snomed-absent-unknown-uv-ips)`

This value set includes codes from SNOMED Clinical Terms®: descendants of 71388002 \|Procedure (procedure)\|, excluding [all subtypes of 14734007 \|Administrative procedure (procedure)\|, all subtypes of 59524001 \|Blood bank procedure (procedure)\|, all subtypes of 389067005 \|Community health procedure (procedure)\|, all subtypes of 442006003 \|Determination of information related to transfusion (procedure)\|, all subtypes of 225288009 \|Environmental care procedure (procedure)\|, all subtypes of 308335008 \|Patient encounter procedure (procedure)\|, all subtypes of 710135002 \|Promotion (procedure)\|, all subtypes of 389084004 \|Staff related procedure (procedure)\|].

- include system `http://snomed.info/sct` version http://snomed.info/sct/900000000000207008: `concept descendent-of 71388002`
- exclude system `http://snomed.info/sct` version http://snomed.info/sct/900000000000207008: `concept is-a 14734007`
- exclude system `http://snomed.info/sct` version http://snomed.info/sct/900000000000207008: `concept is-a 59524001`
- exclude system `http://snomed.info/sct` version http://snomed.info/sct/900000000000207008: `concept is-a 389067005`
- exclude system `http://snomed.info/sct` version http://snomed.info/sct/900000000000207008: `concept is-a 442006003`
- exclude system `http://snomed.info/sct` version http://snomed.info/sct/900000000000207008: `concept is-a 225288009`
- exclude system `http://snomed.info/sct` version http://snomed.info/sct/900000000000207008: `concept is-a 308335008`
- exclude system `http://snomed.info/sct` version http://snomed.info/sct/900000000000207008: `concept is-a 710135002`
- exclude system `http://snomed.info/sct` version http://snomed.info/sct/900000000000207008: `concept is-a 389084004`

## result-coded-value-pathology-uv-ips

`http://hl7.org/fhir/uv/ips/ValueSet/result-coded-value-pathology-uv-ips` version 1.1.0

Used by: `ObservationResultsPathologyUvIps: Observation.value[x]:valueCodeableConcept`

This value set includes codes from SNOMED Clinical Terms (SNOMED CT®) that are included in: all descendants of 106253005 \|Histologic grading differentiation AND/OR behavior (qualifier value)\|, all descendants of 373369003 \|Finding of histologic grading differentiation AND/OR behavior (finding)\|, all descendants of 399981008 \|Neoplasm and/or hamartoma (disorder)\|.

- include system `http://snomed.info/sct` version http://snomed.info/sct/900000000000207008: `concept descendent-of 106253005`
- include system `http://snomed.info/sct` version http://snomed.info/sct/900000000000207008: `concept descendent-of 373369003`
- include system `http://snomed.info/sct` version http://snomed.info/sct/900000000000207008: `concept descendent-of 399981008`

## results-blood-group-uv-ips

`http://hl7.org/fhir/uv/ips/ValueSet/results-blood-group-uv-ips` version 1.1.0

Used by: `(included by results-coded-values-laboratory-uv-ips)`

Blood group [Type]

- include system `http://snomed.info/sct` version http://snomed.info/sct/900000000000207008: `concept descendent-of 365636006`

## results-coded-values-laboratory-uv-ips

`http://hl7.org/fhir/uv/ips/ValueSet/results-coded-values-laboratory-uv-ips` version 1.1.0

Used by: `ObservationResultsLaboratoryUvIps: Observation.value[x]:valueCodeableConcept`

This value set is defined as the union of: (a) Blood group [Type]; (b) Presence/Absence Indicators (2.16.840.1.113883.11.22.52) (c) Microorganisms (2.16.840.1.113883.11.22.49)

- include value set `http://hl7.org/fhir/uv/ips/ValueSet/results-blood-group-uv-ips`
- include value set `http://hl7.org/fhir/uv/ips/ValueSet/results-presence-absence-uv-ips`
- include value set `http://hl7.org/fhir/uv/ips/ValueSet/results-microorganism-uv-ips`

## results-laboratory-observations-uv-ips

`http://hl7.org/fhir/uv/ips/ValueSet/results-laboratory-observations-uv-ips` version 1.1.0

Used by: `ObservationResultsLaboratoryUvIps: Observation.code`

Value Set Definition: LOINC {STATUS in {ACTIVE}, CLASSTYPE in {1}, CLASS exclude {CHALSKIN, H&P.HX.LAB, LABORDERS, NR STATS, PATH, PATH.\*, MOLPATH, MOLPATH.\*, CYTO, HL7.CYTOGEN, HL7.GENETICS}}

- include system `http://loinc.org`: `STATUS = ACTIVE` and `CLASSTYPE = 1`
- exclude system `http://loinc.org`: `CLASS regex CYTO|HL7\.CYTOGEN|HL7\.GENETICS|^PATH(\..*)?|^MOLPATH(\..*)?|NR STATS|H&P\.HX\.LAB|CHALSKIN|LABORDERS`

## results-microorganism-uv-ips

`http://hl7.org/fhir/uv/ips/ValueSet/results-microorganism-uv-ips` version 1.1.0

Used by: `(included by results-coded-values-laboratory-uv-ips)`

This is a value set of the SNOMED CT microorganism concepts for use in the Results section observation values.

- include system `http://snomed.info/sct` version http://snomed.info/sct/900000000000207008: `concept descendent-of 409822003`
- include system `http://snomed.info/sct` version http://snomed.info/sct/900000000000207008: `concept descendent-of 441649000`
- include system `http://snomed.info/sct` version http://snomed.info/sct/900000000000207008: `concept descendent-of 414561005`
- include system `http://snomed.info/sct` version http://snomed.info/sct/900000000000207008: `concept descendent-of 84676004`
- include system `http://snomed.info/sct` version http://snomed.info/sct/900000000000207008: `concept descendent-of 49872002`
- include system `http://snomed.info/sct` version http://snomed.info/sct/900000000000207008: `concept descendent-of 417396000`
- include system `http://snomed.info/sct` version http://snomed.info/sct/900000000000207008: `concept descendent-of 419036000`
- include system `http://snomed.info/sct` version http://snomed.info/sct/900000000000207008: `concept descendent-of 426785004`
- include system `http://snomed.info/sct` version http://snomed.info/sct/900000000000207008: `concept descendent-of 370570004`
- include system `http://snomed.info/sct` version http://snomed.info/sct/900000000000207008: `concept descendent-of 417377004`
- include system `http://snomed.info/sct` version http://snomed.info/sct/900000000000207008: `concept descendent-of 243565002`

## results-pathology-observations-uv-ips

`http://hl7.org/fhir/uv/ips/ValueSet/results-pathology-observations-uv-ips` version 1.1.0

Used by: `ObservationResultsPathologyUvIps: Observation.code`

Value Set Definition: LOINC {STATUS in {ACTIVE}, CLASSTYPE in {1}, CLASS in {CYTO, HL7.CYTOGEN, HL7.GENETICS, MOLPATH, MOLPATH.\*, PATH, PATH.\*}}

- include system `http://loinc.org`: `STATUS = ACTIVE` and `CLASSTYPE = 1` and `CLASS regex CYTO|HL7\.CYTOGEN|HL7\.GENETICS|^PATH(\..*)?|^MOLPATH(\..*)?`

## results-presence-absence-uv-ips

`http://hl7.org/fhir/uv/ips/ValueSet/results-presence-absence-uv-ips` version 1.1.0

Used by: `(included by results-coded-values-laboratory-uv-ips)`

Presence/Absence value set

- include system `http://snomed.info/sct` version http://snomed.info/sct/900000000000207008: `concept descendent-of 260411009`
- include system `http://snomed.info/sct` version http://snomed.info/sct/900000000000207008: `concept descendent-of 272519000`

## results-radiology-numobs-snomed-dicom-uv-ips

`http://hl7.org/fhir/uv/ips/ValueSet/results-radiology-numobs-snomed-dicom-uv-ips` version 1.1.0

Used by: `ObservationResultsRadiologyUvIps: Observation.component:numericQuantityMeasurement.code`, `ObservationResultsRadiologyUvIps: Observation.component:numericRangeMeasurement.code`, `ObservationResultsRadiologyUvIps: Observation.component:numericRatioMeasurement.code`, `ObservationResultsRadiologyUvIps: Observation.component:numericSampledDataMeasurement.code`

Extensible value set including SNOMED CT and DICOM concepts for Linear, Area and Volume Measurements

- include system `http://dicom.nema.org/resources/ontology/DCM`: 3 concepts - 121207 (Height), 121211 (Path length), 121206 (Distance)
- include system `http://snomed.info/sct` version http://snomed.info/sct/900000000000207008: 13 concepts - 410668003 (Length), 103355008 (Width), 131197000 (Depth), 81827009 (Diameter), 103339001 (Long Axis), 103340004 (Short Axis), 131187009 (Major Axis), 131188004 (Minor Axis), 131189007 (Perpendicular Axis), 131190003 (Radius), 131191004 (Perimeter), 74551000 (Circumference), 131192006 (Diameter of circumscribed circle)
- include system `http://snomed.info/sct` version http://snomed.info/sct/900000000000207008: 2 concepts - 42798000 (Area), 131184002 (Area of defined region)
- include system `http://dicom.nema.org/resources/ontology/DCM`: 7 concepts - 121216 (Volume estimated from single 2D region), 121218 (Volume estimated from two non-coplanar 2D regions), 121217 (Volume estimated from three or more non-coplanar 2D regions), 121222 (Volume of sphere), 121221 (Volume of ellipsoid), 121220 (Volume of circumscribed sphere), 121219 (Volume of bounding three dimensional region)
- include system `http://snomed.info/sct` version http://snomed.info/sct/900000000000207008: 1 concept - 118565006 (Volume)

## results-radiology-observations-uv-ips

`http://hl7.org/fhir/uv/ips/ValueSet/results-radiology-observations-uv-ips` version 1.1.0

Used by: `ObservationResultsRadiologyUvIps: Observation.code`, `ObservationResultsRadiologyUvIps: Observation.component:observationCode.code`, `ImagingStudyUvIps: ImagingStudy.procedureCode`

Value Set Definition: LOINC {CLASS in {RAD}}

- include system `http://loinc.org`: `CLASS = RAD`

## results-radiology-txtobs-snomed-dicom-loinc-uv-ips

`http://hl7.org/fhir/uv/ips/ValueSet/results-radiology-txtobs-snomed-dicom-loinc-uv-ips` version 1.1.0

Used by: `ObservationResultsRadiologyUvIps: Observation.component:observationText.code`

IPS Results Radiology Textual Observations

- include system `http://dicom.nema.org/resources/ontology/DCM`: 8 concepts - 121065 (Procedure Description), 121069 (Previous Finding), 121071 (Finding), 121073 (Impression), 121075 (Recommendation), 121077 (Conclusion), 121110 (Patient Presentation), 121111 (Summary)
- include system `http://loinc.org`: 2 concepts - 11329-0 (History), 55115-0 (Request)
- include system `http://snomed.info/sct` version http://snomed.info/sct/900000000000207008: 1 concept - 116224001 (Complication of Procedure)

## results-specimen-type-uv-ips

`http://hl7.org/fhir/uv/ips/ValueSet/results-specimen-type-uv-ips` version 1.1.0

Used by: `SpecimenUvIps: Specimen.type`

IPS Specimen Type value set. This value set includes a set of codes from SNOMED CT that may be used to represent specimen types.

- include system `http://snomed.info/sct` version http://snomed.info/sct/900000000000207008: `concept descendent-of 123038009`

## target-diseases-uv-ips

`http://hl7.org/fhir/uv/ips/ValueSet/target-diseases-uv-ips` version 1.1.0

Used by: `ImmunizationUvIps: Immunization.protocolApplied.targetDisease`

This value set includes the codes from SNOMED CT describing Vaccine Target Diseases.

- include system `http://snomed.info/sct` version http://snomed.info/sct/900000000000207008: 50 concepts - 4834000 (Typhoid fever (disorder)), 6142004 (Influenza (disorder)), 6541001 (Yellow fever (disorder)), 14189004 (Measles (disorder)), 14168008 (Rabies (disorder)), 18624000 (Disease caused by Rotavirus (disorder)), 23502006 (Lyme disease (disorder)), 23511006 (Meningococcal infectious disease (disorder)), ...

## vaccines-uv-ips

`http://hl7.org/fhir/uv/ips/ValueSet/vaccines-uv-ips` version 1.1.0

Used by: `ImmunizationUvIps: Immunization.vaccineCode`

This value set provides a list of types of vaccine, plus IPS codes for absent/unknown immunizations. It includes codes from SNOMED Clinical Terms®: all descendants of 787859002 \|Vaccine product (product)\|.

- include system `http://snomed.info/sct` version http://snomed.info/sct/900000000000207008: `concept descendent-of 787859002`
- include value set `http://hl7.org/fhir/uv/ips/ValueSet/absent-or-unknown-immunizations-uv-ips`

## v2-0371

`http://terminology.hl7.org/ValueSet/v2-0371` version 2.9

Used by: `SpecimenUvIps: Specimen.container.additive[x]`

FHIR Value set/code system definition for HL7 v2 table 0371 ( Additive)

- include system `http://terminology.hl7.org/CodeSystem/v2-0371`

## v2-0493

`http://terminology.hl7.org/ValueSet/v2-0493` version 2.9

Used by: `SpecimenUvIps: Specimen.condition`

FHIR Value set/code system definition for HL7 v2 table 0493 ( Specimen Condition)

- include system `http://terminology.hl7.org/CodeSystem/v2-0493`

## v2-0916

`http://terminology.hl7.org/ValueSet/v2-0916` version 2.9

Used by: `SpecimenUvIps: Specimen.collection.fastingStatus[x]`

FHIR Value set/code system definition for HL7 v2 table 0916 ( Relevant Clincial Information)

- include system `http://terminology.hl7.org/CodeSystem/v2-0916`

## v2-2.7-0360

`http://terminology.hl7.org/ValueSet/v2-2.7-0360` version 0360

Used by: `PractitionerUvIps: Practitioner.qualification.code`

FHIR Value set/code system definition for HL7 v2 table 0360 ver 2.9 ( Degree/License/Certificate)

- include system `http://terminology.hl7.org/CodeSystem/v2-0360` version 2.7

## v3-ActCode

`http://terminology.hl7.org/ValueSet/v3-ActCode` version 2018-08-12

Used by: `CompositionUvIps: Composition.event.code`, `CompositionUvIps: Composition.event:careProvisioningEvent.code`

A code specifying the particular kind of Act that the Act-instance represents within its class. Constraints: The kind of Act (e.g. physical examination, serum potassium, inpatient encounter, charge financial transaction, etc.) is specified with a code from one of several, typically external, coding systems. The coding system will depend on the class of Act, such as LOINC for observations, etc. Conceptually, the Act.code must be a specialization of the Act.classCode. This is why the structure of ActClass domain should be reflected in the superstructure of the ActCode domain and then individual codes or externally referenced vocabularies subordinated under these domains that reflect the ActClass structure. Act.classCode and Act.code are not modifiers of each other but the Act.code concept should really imply the Act.classCode concept. For a negative example, it is not appropriate to use an Act.code "potassium" together with and Act.classCode for "laboratory observation" to somehow mean "potassium laboratory observation" and then use the same Act.code for "potassium" together with Act.classCode for "medication" to mean "substitution of potassium". This mutually modifying use of Act.code and Act.classCode is not permitted.

- include system `http://terminology.hl7.org/CodeSystem/v3-ActCode`

## v3-ActSubstanceAdminSubstitutionCode

`http://terminology.hl7.org/ValueSet/v3-ActSubstanceAdminSubstitutionCode` version 2014-03-26

Used by: `MedicationRequestIPS: MedicationRequest.substitution.allowed[x]`

No Description Provided

- include system `http://terminology.hl7.org/CodeSystem/v3-substanceAdminSubstitution`: `concept is-a _ActSubstanceAdminSubstitutionCode`
- exclude system `http://terminology.hl7.org/CodeSystem/v3-substanceAdminSubstitution`: 1 concept - _ActSubstanceAdminSubstitutionCode

## v3-Race

`http://terminology.hl7.org/ValueSet/v3-Race` version 2018-08-12

Used by: `(included by referencerange-appliesto)`

In the United States, federal standards for classifying data on race determine the categories used by federal agencies and exert a strong influence on categorization by state and local agencies and private sector organizations. The federal standards do not conceptually define race, and they recognize the absence of an anthropological or scientific basis for racial classification. Instead, the federal standards acknowledge that race is a social-political construct in which an individual's own identification with one more race categories is preferred to observer identification. The standards use a variety of features to define five minimum race categories. Among these features are descent from "the original peoples" of a specified region or nation. The minimum race categories are American Indian or Alaska Native, Asian, Black or African American, Native Hawaiian or Other Pacific Islander, and White. The federal standards stipulate that race data need not be limited to the five minimum categories, but any expansion must be collapsible to those categories.

- include system `http://terminology.hl7.org/CodeSystem/v3-Race`

## v3-SubstanceAdminSubstitutionReason

`http://terminology.hl7.org/ValueSet/v3-SubstanceAdminSubstitutionReason` version 2014-03-26

Used by: `MedicationRequestIPS: MedicationRequest.substitution.reason`

No Description Provided

- include system `http://terminology.hl7.org/CodeSystem/v3-ActReason`: `concept is-a _SubstanceAdminSubstitutionReason`
- exclude system `http://terminology.hl7.org/CodeSystem/v3-ActReason`: 1 concept - _SubstanceAdminSubstitutionReason

