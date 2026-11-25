import type {
  ClaudeChildProcess,
  SpawnClaude,
} from "../../src/desktop/process-query.ts";

/**
 * Bun.spawn を、artifact の `desktop.childProcess.spawn` と同じ形の子プロセスに包む。
 * デスクトップアプリ版の query() を、実機の claude でテストするのに使う。
 */
export const spawnClaudeWithBun =
  (claudePath: string): SpawnClaude =>
  (args, { cwd }) => {
    const proc = Bun.spawn([claudePath, ...args], {
      cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const listeners = {
      stdout: [] as ((chunk: string) => void)[],
      stderr: [] as ((chunk: string) => void)[],
      exit: [] as ((code: number | null, signal: string | null) => void)[],
      error: [] as ((error: Error) => void)[],
    };
    const pump = async (
      stream: ReadableStream<Uint8Array>,
      targets: ((chunk: string) => void)[],
    ) => {
      const decoder = new TextDecoder();
      for await (const bytes of stream) {
        const text = decoder.decode(bytes, { stream: true });
        for (const fn of targets) fn(text);
      }
    };
    const stdoutDone = pump(proc.stdout, listeners.stdout);
    const stderrDone = pump(proc.stderr, listeners.stderr);
    void Promise.all([proc.exited, stdoutDone, stderrDone]).then(([code]) => {
      for (const fn of listeners.exit) {
        const signal =
          proc.signalCode === null ? null : String(proc.signalCode);
        fn(signal === null ? code : null, signal);
      }
    });
    const child: ClaudeChildProcess = {
      stdout: { on: (_event, fn) => listeners.stdout.push(fn) },
      stderr: { on: (_event, fn) => listeners.stderr.push(fn) },
      stdin: {
        write: async (data) => {
          proc.stdin.write(data);
          await proc.stdin.flush();
        },
        end: async () => {
          await proc.stdin.end();
        },
      },
      on: ((event: "exit" | "error", fn: never) => {
        listeners[event].push(fn);
      }) as ClaudeChildProcess["on"],
      kill: async (signal) => {
        proc.kill(signal);
      },
    };
    return child;
  };
