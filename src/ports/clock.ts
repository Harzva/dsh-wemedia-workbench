export interface Clock {
  nowIso(): string;
  monotonicMs(): number;
}

export interface IdGenerator {
  uuidV4(): string;
  opaqueId(prefix: string): string;
}
