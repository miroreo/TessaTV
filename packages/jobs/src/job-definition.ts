export interface JobDefinition {
  readonly name: string;
  readonly intervalMs: number;
  readonly handler: () => Promise<void>;
}
