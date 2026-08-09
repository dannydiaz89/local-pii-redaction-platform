/**
 * Canonical English source catalog.
 *
 * Future human translations should live beside this file, one locale per
 * catalog. Pseudolocales remain generated from this source so layout tests
 * cannot drift from the messages the application actually ships.
 */
export const englishCatalog = {
  'app.name': 'Local PII',
  'app.tagline': 'Private document review, on this device.',
  'nav.skip': 'Skip to main content',
  'locale.label': 'Interface language',
  'locale.en': 'English',
  'locale.expanded': 'Expanded test locale',
  'locale.rtl': 'Right-to-left test locale',
  'privacy.eyebrow': 'Local processing boundary',
  'privacy.title': 'Your document stays under your control.',
  'privacy.body': 'The default rules engine works locally. Upload and job processing are not enabled in this preview.',
  'privacy.network': 'No remote provider is selected',
  'privacy.storage': 'No document has been retained',
  'preflight.title': 'System preflight',
  'preflight.body': 'Check the local API before document workflows become available.',
  'preflight.checking': 'Checking local capabilities…',
  'preflight.ready': 'Local engine is ready',
  'preflight.disconnected': 'Local API session is not connected',
  'preflight.unavailable': 'Local capabilities could not be checked',
  'preflight.retry': 'Check again',
  'preflight.connectedHint': 'This browser tab is connected only for the current application launch.',
  'preflight.disconnectedHint': 'Start the application launcher to create a private, in-memory browser session.',
  'capability.mode': 'Engine mode',
  'capability.formats': 'Supported formats',
  'capability.detectors': 'Available detectors',
  'capability.inputLimit': 'Maximum input',
  'capability.rulesOnly': 'Rules only',
  'capability.localHybrid': 'Local hybrid',
  'workflow.title': 'Document workflow',
  'workflow.stepOne': 'Choose a document',
  'workflow.stepTwo': 'Review findings',
  'workflow.stepThree': 'Export a verified copy',
  'workflow.comingSoon': 'Coming in the next application slice',
  'status.available': 'Available',
  'status.planned': 'Planned',
  'units.mebibytes': '{count} MiB'
} as const;
