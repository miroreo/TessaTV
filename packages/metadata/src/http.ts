import { isHTTPError } from "ky";

export type QueryParams = Record<string, string | number | undefined>;

/** Resolves to null when the request failed with a 404 (an unknown id), rethrowing anything else. */
export async function nullOn404<T>(request: Promise<T>): Promise<T | null> {
  try {
    return await request;
  } catch (error) {
    if (isHTTPError(error) && error.response.status === 404) return null;
    throw error;
  }
}
