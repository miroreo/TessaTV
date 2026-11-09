import { expect, it } from "vitest";
import { runCommand } from "./process.js";
it("returns exit code and output for a non-zero exit, and rejects when the binary is missing", async () => {
  await expect(runCommand("definitely-not-a-binary", [])).rejects.toBeTruthy();
  expect(await runCommand("sh", ["-c", "echo hi; echo err >&2; exit 3"])).toEqual({ exitCode: 3, stdout: "hi\n", stderr: "err\n" });
});
