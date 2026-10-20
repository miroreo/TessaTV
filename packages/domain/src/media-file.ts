export interface MediaFile {
  readonly id: string;
  readonly unitId: string;
  readonly path: string;
  readonly container: string;
  readonly videoCodec: string | null;
  readonly audioCodec: string | null;
  readonly resolutionWidth: number | null;
  readonly resolutionHeight: number | null;
  readonly sizeBytes: number;
  readonly checksum: string | null;
  readonly importedAt: Date;
}
