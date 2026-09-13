import type { QualityGate } from "./types.ts";

const LEAK_PATTERNS = [
  /\b(?:api[_-]?key|access[_-]?token|token|secret|password)\s*[:=]\s*\S+/iu,
  /\bauthorization\s*[:=]\s*(?:bearer\s+)?\S+/iu,
  /\bcookie\s*[:=]\s*\S+/iu,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
];

export const leakGate: QualityGate = {
  gateId: "leak",
  version: "1",
  selectInput: (input) => ({ markdown: input.markdown ?? "", manifest: input.manifest ?? null }),
  evaluate(input) {
    const serialized = `${input.markdown ?? ""}\n${JSON.stringify(input.manifest ?? null)}`;
    const matches = LEAK_PATTERNS.reduce<number[]>((indices, pattern, index) => pattern.test(serialized) ? [...indices, index] : indices, []);
    return matches.length === 0 ? [{
      status: "pass",
      code: "LEAK_SCAN_OK",
      safeMessage: "no secret markers were detected",
      evidenceRefs: [],
    }] : matches.map((index) => ({
      status: "block" as const,
      code: "SECRET_MARKER_DETECTED",
      safeMessage: "a potential secret marker was detected",
      evidenceRefs: [`pattern:${index + 1}`],
    }));
  },
};
