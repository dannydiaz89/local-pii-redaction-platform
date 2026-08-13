/** Canonical contract identifiers used at the HTTP trust boundary. */
export const apiContractIds = Object.freeze({
  artifact: 'https://local-pii.dev/schemas/artifacts/artifact/1.0.0',
  capability: 'https://local-pii.dev/schemas/capabilities/capability-manifest/1.0.0',
  cancelJobRequest: 'https://local-pii.dev/schemas/jobs/cancel-job-request/1.0.0',
  createArtifactRequest: 'https://local-pii.dev/schemas/artifacts/create-artifact-request/1.0.0',
  createArtifactRequestV2: 'https://local-pii.dev/schemas/artifacts/create-artifact-request/2.0.0',
  createJobRequest: 'https://local-pii.dev/schemas/jobs/create-job-request/1.0.0',
  createProcessingJobRequest: 'https://local-pii.dev/schemas/jobs/create-job-request/2.0.0',
  createLocalProcessingJobRequest: 'https://local-pii.dev/schemas/jobs/create-job-request/3.0.0',
  createReviewedLocalRedactionJobRequest: 'https://local-pii.dev/schemas/jobs/create-job-request/4.0.0',
  detectionPage: 'https://local-pii.dev/schemas/jobs/detection-page/1.0.0',
  error: 'https://local-pii.dev/schemas/common/errors/1.0.0',
  errorV2: 'https://local-pii.dev/schemas/common/errors/2.0.0',
  errorV3: 'https://local-pii.dev/schemas/common/errors/3.0.0',
  job: 'https://local-pii.dev/schemas/jobs/job/1.0.0',
  jobEventPage: 'https://local-pii.dev/schemas/jobs/job-event-page/1.0.0',
  policyCatalog: 'https://local-pii.dev/schemas/policy/policy-catalog/1.0.0',
  previewReview: 'https://local-pii.dev/schemas/jobs/preview-review-report/2.0.0',
  previewScan: 'https://local-pii.dev/schemas/jobs/preview-scan-report/1.0.0',
  reviewDecisionRequest: 'https://local-pii.dev/schemas/jobs/review-decision-request/1.0.0',
  reviewSet: 'https://local-pii.dev/schemas/jobs/review-set/1.0.0'
});
