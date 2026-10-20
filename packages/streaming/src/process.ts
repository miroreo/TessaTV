import { execFile, spawn } from "node:child_process";
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

export const spawnProcess: ProcessSpawner = (command, args) =>
  spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a short-lived command to completion. Never throws on a non-zero exit — callers decide. */
export type CommandRunner = (command: string, args: readonly string[]) => Promise<CommandResult>;

export const runCommand: CommandRunner = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, [...args], { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") {
        // Spawn-level failure (e.g. binary not found), not a non-zero exit.
        reject(error);
        return;
      }
      resolve({ exitCode: error ? (error.code as number) : 0, stdout, stderr });
    });
  });
