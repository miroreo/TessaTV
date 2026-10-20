export type GrabStatus = "pending" | "downloading" | "imported" | "failed";

/**
 * Audit trail / state-machine anchor linking a selected Release through a DownloadClient
 * job to an eventually-imported MediaFile. One shape for both torrent and Usenet grabs.
 */
export interface Grab {
  readonly id: string;
  readonly releaseId: string;
  readonly unitId: string;
  readonly downloadClientId: string;
  readonly downloadClientJobId: string | null;
  readonly status: GrabStatus;
  readonly failureReason: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
