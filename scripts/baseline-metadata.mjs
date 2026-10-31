import { createHash } from "node:crypto";

/** Identity includes payload digests, not just the date or git commit (dirty builds). */
export function identifyBaseline(manifest) {
  const digest = createHash("sha256").update(JSON.stringify({
    version: manifest.appVersion,
    files: [...manifest.files].sort((a, b) => a.target.localeCompare(b.target)),
  })).digest("hex");
  const buildId = `baseline-${manifest.appVersion}-${digest.slice(0, 24)}`;
  return {
    ...manifest, buildId, releaseId: buildId,
    components: Object.fromEntries(Object.entries(manifest.components).map(([name, meta]) =>
      [name, { ...meta, buildId }])),
  };
}
