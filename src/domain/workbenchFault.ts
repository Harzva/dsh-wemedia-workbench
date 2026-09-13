export class WorkbenchFault extends Error {
  constructor(readonly code: string, readonly safeMessage: string, readonly retryable = false) {
    super(safeMessage);
    this.name = "WorkbenchFault";
  }
}
