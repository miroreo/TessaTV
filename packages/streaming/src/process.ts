import { spawn } from "node:child_process";
import { execa } from "execa";
import type { Readable } from "node:stream";

/**
 * The narrow slice of a child process the streaming package relies on. Exists so tests can
 * substitute a fake without spawning real ffmpeg, and so nothing here is coupled to
 * `ChildProcess`'s much larger surface.
 */
export interface SpawnedProcess {
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
}

export type ProcessSpawner = (command: string, args: readonly string[]) => SpawnedProcess;

/** Plain `spawn` for long-running ffmpeg: the session listens to its events directly. */
export const spawnProcess: ProcessSpawner = (command, args) =>
  spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandRunOptions {
  /** Kills the command when aborted. */
  readonly signal?: AbortSignal;
  /** Kills the command after this long. */
  readonly timeoutMs?: number;
}

/**
 * Runs a command to completion. Never throws on a non-zero exit — callers decide — but does
 * throw when the command couldn't run to an exit at all (missing binary, aborted, timed out).
 */
export type CommandRunner = (command: string, args: readonly string[], options?: CommandRunOptions) => Promise<CommandResult>;

export const runCommand: CommandRunner = async (command, args, options = {}) => {
  const result = await execa(command, args, {
    reject: false,
    stripFinalNewline: false,
    maxBuffer: 64 * 1024 * 1024,
    ...(options.signal ? { cancelSignal: options.signal } : {}),
    ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
  });
  // Spawn-level failure (e.g. binary not found), cancellation or timeout, not a non-zero exit.
  if (result.exitCode === undefined) throw result;
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
};
