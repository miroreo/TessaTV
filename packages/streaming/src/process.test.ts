import { expect, it } from "vitest";
import { runCommand } from "./process.js";
it("returns exit code and output for a non-zero exit, and rejects when the binary is missing", async () => {
  await expect(runCommand("definitely-not-a-binary", [])).rejects.toBeTruthy();
  expect(await runCommand("sh", ["-c", "echo hi; echo err >&2; exit 3"])).toEqual({ exitCode: 3, stdout: "hi\n", stderr: "err\n" });
});

it("hands stdout to a listener as it arrives, without also keeping it", async () => {
  const chunks: string[] = [];
  const result = await runCommand("sh", ["-c", "echo one; sleep 0.1; echo two"], { onStdout: (chunk) => chunks.push(chunk) });
  expect(chunks.join("")).toBe("one\ntwo\n");
  expect(chunks.length).toBeGreaterThan(1);
  expect(result.stdout).toBe("");
});

it("stops a command that floods stderr and returns the start of what it printed", async () => {
  const result = await runCommand("sh", ["-c", "yes error >&2"], { timeoutMs: 20_000 });
  expect(result.exitCode).toBe(1);
  expect(result.stderr.startsWith("error\n")).toBe(true);
});
