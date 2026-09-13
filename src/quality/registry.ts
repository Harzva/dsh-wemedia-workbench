import type { GateIssue, GateReport } from "../domain/capability.ts";
import type { QualityGateRunner, QualityInput } from "../ports/quality.ts";
import { assetGate } from "./assetGate.ts";
import { qualityDigest } from "./digest.ts";
import { duplicateGate } from "./duplicateGate.ts";
import { leakGate } from "./leakGate.ts";
import { createPathSchemaGate } from "./pathSchemaGate.ts";
import { subscriptionImageGate } from "./subscriptionImageGate.ts";
import type { GateFinding, QualityGate, RelativePathValidator } from "./types.ts";

function statusOf(issues: readonly GateIssue[]): GateReport["status"] {
  if (issues.some(({ status }) => status === "block")) return "block";
  if (issues.some(({ status }) => status === "warn")) return "warn";
  return "pass";
}

function stableIssue(gate: QualityGate, inputDigest: string, finding: GateFinding): GateIssue {
  return {
    gateId: gate.gateId,
    version: gate.version,
    status: finding.status,
    code: finding.code,
    safeMessage: finding.safeMessage,
    evidenceRefs: [...finding.evidenceRefs].sort(),
    inputDigest,
  };
}

export class QualityGateRegistry implements QualityGateRunner {
  constructor(readonly gates: readonly QualityGate[]) {}

  async run(input: QualityInput): Promise<GateReport> {
    const settled = await Promise.allSettled(this.gates.map(async (gate) => {
      const inputDigest = qualityDigest(gate.selectInput(input));
      const findings = await gate.evaluate(input);
      return findings.map((finding) => stableIssue(gate, inputDigest, finding));
    }));
    const issues = settled.flatMap((result, index) => {
      if (result.status === "fulfilled") return result.value;
      const gate = this.gates[index]!;
      return [stableIssue(gate, qualityDigest(gate.selectInput(input)), {
        status: "block",
        code: "QUALITY_GATE_EXCEPTION",
        safeMessage: "a quality gate could not complete safely",
        evidenceRefs: [`gate:${gate.gateId}`],
      })];
    }).sort((left, right) => `${left.gateId}:${left.code}:${left.evidenceRefs.join("|")}`.localeCompare(`${right.gateId}:${right.code}:${right.evidenceRefs.join("|")}`));

    const readinessStatus = statusOf(issues);
    const reportDigest = qualityDigest({ contentRef: input.contentRef, channel: input.channel ?? null, issues });
    issues.push({
      gateId: "readiness",
      version: "1",
      status: readinessStatus,
      code: readinessStatus === "block" ? "READINESS_BLOCKED" : readinessStatus === "warn" ? "READINESS_WARN" : "READINESS_OK",
      safeMessage: readinessStatus === "block" ? "content is not ready" : readinessStatus === "warn" ? "content is ready with warnings" : "content is ready",
      evidenceRefs: issues.filter(({ status }) => status === readinessStatus && status !== "pass").map(({ gateId, code }) => `gate:${gateId}:${code}`).sort(),
      inputDigest: reportDigest,
    });
    return { status: readinessStatus, inputDigest: reportDigest, issues };
  }
}

export function createDefaultQualityRegistry(validateRelativePath: RelativePathValidator): QualityGateRegistry {
  return new QualityGateRegistry([
    createPathSchemaGate(validateRelativePath),
    leakGate,
    duplicateGate,
    assetGate,
    subscriptionImageGate,
  ]);
}
