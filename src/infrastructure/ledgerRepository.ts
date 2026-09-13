import { open, readFile } from "node:fs/promises";

import { failure, success } from "../domain/errors.ts";
import type { DomainResult } from "../domain/errors.ts";
import type { LedgerEvent } from "../domain/ledger.ts";
import { decodeLedgerEvent } from "../domain/schema.ts";
import type { LedgerRepository } from "../ports/repositories.ts";
import { canonicalJson } from "../domain/json.ts";
import { acquireFileCommitLock } from "./fileCommitLock.ts";

export interface LedgerReadIssue {
  line: number;
  code: "invalid_line" | "damaged_tail";
  safeMessage: string;
}

export interface LedgerSnapshot {
  events: LedgerEvent[];
  issues: LedgerReadIssue[];
}

function ledgerFailure<T>(safeMessage: string): DomainResult<T> {
  return failure("SCHEMA_INVALID_VALUE", safeMessage);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

const eventIdentity = (event: LedgerEvent): string => {
  const { eventId: _id, occurredAt: _time, ...identity } = event;
  return canonicalJson(identity);
};

export class FileLedgerRepository implements LedgerRepository {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async snapshot(): Promise<DomainResult<LedgerSnapshot>> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      return isMissing(error) ? success({ events: [], issues: [] }) : ledgerFailure("ledger could not be read");
    }
    const hasTerminalNewline = raw.endsWith("\n");
    const lines = raw.split("\n");
    if (hasTerminalNewline) lines.pop();
    const events: LedgerEvent[] = [];
    const issues: LedgerReadIssue[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === undefined || line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        issues.push({ line: index + 1, code: !hasTerminalNewline && index === lines.length - 1 ? "damaged_tail" : "invalid_line", safeMessage: "ledger line is not valid JSON" });
        continue;
      }
      const decoded = decodeLedgerEvent(parsed);
      if (decoded.ok) events.push(decoded.value);
      else issues.push({ line: index + 1, code: !hasTerminalNewline && index === lines.length - 1 ? "damaged_tail" : "invalid_line", safeMessage: decoded.error.safeMessage });
    }
    return success({ events, issues });
  }

  async findByEventKey(eventKey: string): Promise<DomainResult<LedgerEvent | null>> {
    const snapshot = await this.snapshot();
    if (!snapshot.ok) return snapshot;
    return success(snapshot.value.events.find((event) => event.eventKey === eventKey) ?? null);
  }

  append(event: LedgerEvent): Promise<DomainResult<LedgerEvent>> {
    let decoded: LedgerEvent;
    try {
      const result = decodeLedgerEvent(event);
      if (!result.ok || !Number.isFinite(Date.parse(result.value.occurredAt))) return Promise.resolve(ledgerFailure("ledger event is invalid; no data was written"));
      decoded = structuredClone(result.value);
    } catch { return Promise.resolve(ledgerFailure("ledger event is invalid; no data was written")); }
    const operation = this.queue.then(() => this.appendLocked(decoded));
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async appendLocked(event: LedgerEvent): Promise<DomainResult<LedgerEvent>> {
    const lock = await acquireFileCommitLock(this.filePath);
    if (!lock.ok) return lock;
    try {
      const snapshot = await this.snapshot();
      if (!snapshot.ok) return snapshot;
      if (snapshot.value.issues.length > 0) return ledgerFailure("ledger contains invalid data and must be reconciled before append");
      const keys = snapshot.value.events.map(value => value.eventKey), ids = snapshot.value.events.map(value => value.eventId);
      if (new Set(keys).size !== keys.length || new Set(ids).size !== ids.length) return ledgerFailure("ledger contains ambiguous identities and must be reconciled before append");
      const existing = snapshot.value.events.find(({ eventKey }) => eventKey === event.eventKey);
      if (existing !== undefined) return eventIdentity(existing) === eventIdentity(event) ? success(existing) : failure("IDENTITY_CONFLICT", "ledger event key belongs to a different result; existing evidence was preserved");
      if (ids.includes(event.eventId)) return failure("IDENTITY_CONFLICT", "ledger event ID is already assigned to another result");
      const handle = await open(this.filePath, "a+", 0o600);
      try {
        const size = (await handle.stat()).size;
        const last = Buffer.alloc(1);
        if (size > 0 && (await handle.read(last, 0, 1, size - 1)).bytesRead !== 1) return ledgerFailure("ledger changed before append");
        const separator = size > 0 && last[0] !== 10 ? "\n" : "";
        await handle.writeFile(`${separator}${JSON.stringify(event)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return success(event);
    } catch {
      return ledgerFailure("ledger event could not be appended");
    } finally {
      await lock.value.release();
    }
  }

  async *readAll(): AsyncIterable<DomainResult<LedgerEvent>> {
    const snapshot = await this.snapshot();
    if (!snapshot.ok) {
      yield snapshot;
      return;
    }
    for (const event of snapshot.value.events) yield success(event);
    for (const issue of snapshot.value.issues) yield ledgerFailure(issue.safeMessage);
  }
}
