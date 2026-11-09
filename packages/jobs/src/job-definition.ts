export interface JobDefinition {
  /** Also the pg-boss queue name. */
  readonly name: string;
  /** Standard 5-field cron expression, evaluated in UTC. */
  readonly cron: string;
  readonly handler: () => Promise<void>;
}
