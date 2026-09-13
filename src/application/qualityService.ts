import type { GateReport } from "../domain/capability.ts";
import { fnv1a64 } from "../domain/identity.ts";
import type { Channel } from "../domain/primitives.ts";
import type { QualityGateRunner, QualityInput } from "../ports/quality.ts";

export interface ChannelQualityResult {
  channel?: Channel;
  report: GateReport;
}

function failedReport(input: QualityInput): GateReport {
  const inputDigest = fnv1a64(`${input.contentRef}:${input.channel ?? "common"}`);
  return {
    status: "block",
    inputDigest,
    issues: [{
      gateId: "quality-service",
      version: "1",
      status: "block",
      code: "QUALITY_SERVICE_EXCEPTION",
      safeMessage: "quality evaluation could not complete safely",
      evidenceRefs: [],
      inputDigest,
    }],
  };
}

export class QualityService {
  constructor(private readonly runner: QualityGateRunner) {}

  async evaluate(inputs: readonly QualityInput[]): Promise<ChannelQualityResult[]> {
    return Promise.all(inputs.map(async (input) => {
      try {
        const report = await this.runner.run(input);
        return { ...(input.channel === undefined ? {} : { channel: input.channel }), report };
      } catch {
        return { ...(input.channel === undefined ? {} : { channel: input.channel }), report: failedReport(input) };
      }
    }));
  }
}
