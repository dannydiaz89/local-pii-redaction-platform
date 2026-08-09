export interface CanaryTarget {
  readonly name: string;
  readonly content: string;
}

export interface CanaryFinding {
  readonly target: string;
  readonly canaryIndex: number;
}

export function scanPrivacyCanaries(
  canaries: readonly string[],
  targets: readonly CanaryTarget[]
): readonly CanaryFinding[] {
  const findings: CanaryFinding[] = [];
  for (const target of targets) {
    for (const [canaryIndex, canary] of canaries.entries()) {
      if (canary.length > 0 && target.content.includes(canary)) findings.push({ target: target.name, canaryIndex });
    }
  }
  return findings;
}
