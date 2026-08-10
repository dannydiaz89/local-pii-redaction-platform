/**
 * Canonical English source catalog.
 *
 * Future human translations should live beside this file, one locale per
 * catalog. Pseudolocales remain generated from this source so layout tests
 * cannot drift from the messages the application actually ships.
 */
export const englishCatalog = {
  'app.name': 'Local PII',
  'nav.skip': 'Skip to main content',
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
  'intake.title': 'Choose a document',
  'intake.body': 'Check a local file against the formats and size limit reported by this application launch.',
  'intake.label': 'Document file',
  'intake.hint': 'Supported files: {extensions}. Format-specific limits apply, up to {limit}.',
  'intake.waiting': 'Connect to the local engine before choosing a document.',
  'intake.none': 'No document is selected.',
  'intake.ready': '{format} file, {size}, passes the local preflight checks.',
  'intake.unsupported': 'Choose a file with one of the supported extensions.',
  'intake.tooLarge': 'Choose a file no larger than {limit}.',
  'intake.privacy': 'This screen checks only the file name extension and size. It does not read or upload the file contents, and it stores no selection in browser persistence.',
  'intake.next': 'Upload and processing will be enabled after the durable retention boundary is qualified.',
  'status.available': 'Available',
  'status.waiting': 'Waiting',
  'units.mebibytes': '{count} MiB',
  'units.kibibytes': '{count} KiB',
  'units.bytes': '{count} bytes'
} as const;
