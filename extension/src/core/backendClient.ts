// Backend client: pure fetch wrapper, no VS Code API dependency.
// Talks to the FastAPI mock backend's contract (see mock_server/main.py).

import { PackageDetection } from './detect';

export type Severity = 'safe' | 'caution' | 'high';

export interface CheckResult {
  package: string;
  exists_on_registry: boolean;
  risk_score: number;
  severity: Severity;
  reasons: string[];
}

function normalizeBaseUrl(backendUrl: string): string {
  return backendUrl.replace(/\/+$/, '');
}

/** POSTs one package to `${backendUrl}/check` and returns its risk report. */
export async function checkPackage(backendUrl: string, detection: PackageDetection): Promise<CheckResult> {
  const response = await fetch(`${normalizeBaseUrl(backendUrl)}/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: detection.name,
      version: detection.version,
      ecosystem: detection.ecosystem,
    }),
  });

  if (!response.ok) {
    throw new Error(`Blueberry backend returned ${response.status} for package "${detection.name}"`);
  }

  return (await response.json()) as CheckResult;
}

/** Checks every detection, tolerating individual failures without failing the batch. */
export async function checkPackages(
  backendUrl: string,
  detections: PackageDetection[]
): Promise<Map<string, CheckResult>> {
  const results = new Map<string, CheckResult>();

  await Promise.all(
    detections.map(async (detection) => {
      try {
        const result = await checkPackage(backendUrl, detection);
        results.set(detection.name.toLowerCase(), result);
      } catch (err) {
        console.error(`Blueberry: failed to check "${detection.name}"`, err);
      }
    })
  );

  return results;
}
