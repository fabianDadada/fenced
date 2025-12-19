/**
 * Streaming VM Executor — this implementation is certainly cursed,
 * and certainly breaks at edge cases.
 *
 * Goal: Execute statements as the LLM generates them, without waiting for the
 * code fence to close. This makes API calls start, UI render, and errors
 * surface while tokens are still streaming.
 *
 * Problem: No JS runtime supports executing top-level async statements
 * one-by-one while sharing scope.
 *
 * Solution: Split on semicolons (transpiler validates boundaries), wrap each
 * statement in an async IIFE, and manually hoist variables to the vm context
 * (`context.x = x`) so they persist across executions.
 */
import { Console as NodeConsole } from "node:console";
import { Writable } from "node:stream";
import * as vm from "node:vm";

export type ExecutionEvent = {
  statement: string;
  logs: string;
  error?: string;
};

export type StreamingVmRunResult = {
  logs: string;
  error: string;
};

export type StreamingVmRun = {
  events: AsyncIterable<ExecutionEvent>;
  result: Promise<StreamingVmRunResult>;
};

export class StreamingVmExecutor {
  private readonly context: vm.Context;
  private readonly console: InstanceType<typeof NodeConsole>;
  private readonly transpiler: Bun.Transpiler;
  private logBuffer: string[] = [];
  private running = false;

  constructor(context?: vm.Context) {
    this.context = context ?? vm.createContext({});
    this.console = this.createConsole();
    this.transpiler = new Bun.Transpiler({
      loader: "tsx",
      target: "bun",
      tsconfig: {
        compilerOptions: {
          jsx: "react",
          jsxFactory: "React.createElement",
          jsxFragmentFactory: "React.Fragment",
        },
      },
    });
    this.ensureBindings();
  }

  run(chunks: AsyncIterable<string>): StreamingVmRun {
    if (this.running) {
      throw new Error("A run is already in progress.");
    }

    this.running = true;
    this.logBuffer = [];
    this.ensureConsoleBinding();

    let allLogs = "";
    let finalError = "";

    let resolveResult: (result: StreamingVmRunResult) => void;
    const resultPromise = new Promise<StreamingVmRunResult>((resolve) => {
      resolveResult = resolve;
    });

    const self = this;
    const eventGenerator = (async function* (): AsyncGenerator<ExecutionEvent> {
      let buffer = "";
      let prevChar = "";
      let inLineComment = false;

      try {
        for await (const chunk of chunks) {
          for (const char of chunk) {
            buffer += char;

            // Track line comments to avoid splitting on ; inside them
            if (char === "/" && prevChar === "/") {
              inLineComment = true;
            }
            if (char === "\n") {
              inLineComment = false;
            }

            // Only execute on semicolon (not in line comment)
            // The transpiler validates whether it's a real statement boundary
            // (handles ; inside strings, template literals, regexes, block comments)
            if (char === ";" && !inLineComment) {
              const trimmed = buffer.trim();
              if (trimmed) {
                const transpileResult = self.tryTranspile(trimmed);
                if (transpileResult.success) {
                  self.logBuffer = [];
                  const execResult = await self.executeStatement(
                    trimmed,
                    transpileResult.code!,
                  );
                  const logs = self.logBuffer.join("");
                  allLogs += logs;

                  yield {
                    statement: trimmed,
                    logs,
                    error: execResult.error,
                  };

                  if (execResult.error) {
                    finalError = execResult.error;
                    return;
                  }

                  buffer = "";
                }
                // If transpile fails, keep buffering (might be ; inside string/regex/etc)
              }
            }

            prevChar = char;
          }
        }

        // Handle remaining buffer after stream ends (for code without trailing ;)
        const trimmed = buffer.trim();
        if (trimmed && !finalError) {
          const transpileResult = self.tryTranspile(trimmed);
          if (transpileResult.success) {
            self.logBuffer = [];
            const execResult = await self.executeStatement(
              trimmed,
              transpileResult.code!,
            );
            const logs = self.logBuffer.join("");
            allLogs += logs;

            yield {
              statement: trimmed,
              logs,
              error: execResult.error,
            };

            if (execResult.error) {
              finalError = execResult.error;
            }
          } else {
            finalError = `Incomplete statement: ${transpileResult.error}`;
            yield {
              statement: trimmed,
              logs: "",
              error: finalError,
            };
          }
        }
      } finally {
        self.running = false;
        self.logBuffer = [];
        resolveResult({ logs: allLogs, error: finalError });
      }
    })();

    return {
      events: eventGenerator,
      result: resultPromise,
    };
  }

  private tryTranspile(source: string): { success: boolean; code?: string; error?: string } {
    try {
      const code = this.transpiler.transformSync(source, "tsx");
      return { success: true, code };
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  private async executeStatement(
    source: string,
    transpiled: string,
  ): Promise<{ error?: string }> {
    try {
      const varNames = this.extractVariableNames(source);
      const funcName = this.extractFunctionName(source);

      if (varNames.length > 0) {
        // Variable declaration - wrap, execute, and hoist
        const returnObj = varNames.join(", ");
        const wrapped = `(async () => { ${transpiled}; return { ${returnObj} }; })()`;
        const script = new vm.Script(wrapped);
        const result = (await script.runInContext(this.context)) as Record<
          string,
          unknown
        >;

        for (const name of varNames) {
          (this.context as Record<string, unknown>)[name] = result[name];
        }
      } else if (funcName) {
        // Function declaration - execute and hoist
        const wrapped = `(async () => { ${transpiled}; return ${funcName}; })()`;
        const script = new vm.Script(wrapped);
        const fn = await script.runInContext(this.context);
        (this.context as Record<string, unknown>)[funcName] = fn;
      } else {
        // Regular statement - just execute
        const wrapped = `(async () => { ${transpiled}; })()`;
        const script = new vm.Script(wrapped);
        await script.runInContext(this.context);
      }

      return {};
    } catch (e) {
      return { error: this.formatError(e) };
    }
  }

  private extractVariableNames(source: string): string[] {
    const trimmed = source.trim();

    // Check for const or let at start
    const match = trimmed.match(/^(const|let)\s+/);
    if (!match) return [];

    const afterKeyword = trimmed.slice(match[0].length);
    const eqIndex = this.findTopLevelIndex(afterKeyword, "=");
    if (eqIndex === -1) return [];

    const pattern = afterKeyword.slice(0, eqIndex).trim();
    const patternWithoutType = this.stripTypeAnnotation(pattern);

    return this.parsePattern(patternWithoutType);
  }

  private parsePattern(pattern: string): string[] {
    const trimmed = pattern.trim();

    // Simple identifier
    if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(trimmed)) {
      return [trimmed];
    }

    // Object destructuring { ... }
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      return this.parseDestructure(trimmed.slice(1, -1), "object");
    }

    // Array destructuring [ ... ]
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      return this.parseDestructure(trimmed.slice(1, -1), "array");
    }

    return [];
  }

  private parseDestructure(
    inner: string,
    type: "object" | "array",
  ): string[] {
    const names: string[] = [];
    const parts = this.splitAtTopLevel(inner, ",");

    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;

      // Rest pattern: ...rest
      if (trimmed.startsWith("...")) {
        const rest = trimmed.slice(3).trim();
        if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(rest)) {
          names.push(rest);
        }
        continue;
      }

      // Object destructure with rename: key: pattern
      if (type === "object") {
        const colonIdx = this.findTopLevelIndex(trimmed, ":");
        if (colonIdx !== -1) {
          const right = this.stripDefault(trimmed.slice(colonIdx + 1).trim());
          names.push(...this.parsePattern(right));
          continue;
        }
      }

      // Strip default value: name = default
      const withoutDefault = this.stripDefault(trimmed);
      names.push(...this.parsePattern(withoutDefault));
    }

    return names;
  }

  private stripDefault(s: string): string {
    const eqIdx = this.findTopLevelIndex(s, "=");
    return eqIdx === -1 ? s : s.slice(0, eqIdx).trim();
  }

  private stripTypeAnnotation(pattern: string): string {
    // For simple identifiers with type: `x: Type` -> `x`
    if (!pattern.startsWith("{") && !pattern.startsWith("[")) {
      const colonIdx = pattern.indexOf(":");
      if (colonIdx !== -1) {
        return pattern.slice(0, colonIdx).trim();
      }
    }
    return pattern;
  }

  private splitAtTopLevel(s: string, delimiter: string): string[] {
    const parts: string[] = [];
    let current = "";
    let depth = 0;

    for (const c of s) {
      if (c === "{" || c === "[" || c === "(") depth++;
      else if (c === "}" || c === "]" || c === ")") depth--;

      if (c === delimiter && depth === 0) {
        parts.push(current);
        current = "";
      } else {
        current += c;
      }
    }

    if (current) parts.push(current);
    return parts;
  }

  private findTopLevelIndex(s: string, char: string): number {
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === "{" || c === "[" || c === "(") depth++;
      else if (c === "}" || c === "]" || c === ")") depth--;
      else if (c === char && depth === 0) {
        // For '=', make sure it's not '=>'
        if (char === "=" && s[i + 1] === ">") continue;
        return i;
      }
    }
    return -1;
  }

  private extractFunctionName(source: string): string | null {
    const trimmed = source.trim();
    const match = trimmed.match(
      /^(async\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/,
    );
    return match ? match[2] : null;
  }

  private ensureBindings(): void {
    const ctx = this.context as Record<string, unknown>;
    if (!ctx.globalThis) {
      ctx.globalThis = ctx;
    }
    if (!ctx.setTimeout) {
      Object.assign(ctx, {
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        queueMicrotask,
      });
    }
    this.ensureConsoleBinding();
  }

  private ensureConsoleBinding(): void {
    const ctx = this.context as Record<string, unknown>;
    ctx.console = this.console as unknown as Console;
    if (ctx.globalThis && typeof ctx.globalThis === "object") {
      (ctx.globalThis as Record<string, unknown>).console = ctx.console;
    }
  }

  private createConsole(): InstanceType<typeof NodeConsole> {
    const sink = new Writable({
      write: (chunk, _encoding, callback) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        this.logBuffer.push(text);
        callback();
      },
    });

    return new NodeConsole({
      stdout: sink,
      stderr: sink,
      colorMode: false,
    });
  }

  private formatError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    if (typeof error === "object" && error !== null) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message.length > 0) {
        return message;
      }
    }
    return String(error);
  }
}
