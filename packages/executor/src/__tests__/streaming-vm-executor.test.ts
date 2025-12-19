import { describe, expect, it } from "bun:test";
import { StreamingVmExecutor } from "../streaming-vm-executor";

async function* toAsyncIterable(str: string): AsyncIterable<string> {
  yield str;
}

async function collectEvents(
  executor: StreamingVmExecutor,
  code: string,
) {
  const { events, result } = executor.run(toAsyncIterable(code));
  const collected: { statement: string; logs: string; error?: string }[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  const final = await result;
  return { events: collected, result: final };
}

describe("StreamingVmExecutor", () => {
  describe("basic execution", () => {
    it("executes simple expression", async () => {
      const executor = new StreamingVmExecutor();
      const { events, result } = await collectEvents(executor, "1 + 1;");

      expect(events).toHaveLength(1);
      expect(events[0].statement).toBe("1 + 1;");
      expect(result.error).toBe("");
    });

    it("executes console.log", async () => {
      const executor = new StreamingVmExecutor();
      const { events, result } = await collectEvents(
        executor,
        'console.log("hello");',
      );

      expect(events).toHaveLength(1);
      expect(events[0].logs).toBe("hello\n");
      expect(result.logs).toBe("hello\n");
    });

    it("executes multiple statements", async () => {
      const executor = new StreamingVmExecutor();
      const { events } = await collectEvents(
        executor,
        'console.log("a");\nconsole.log("b");',
      );

      expect(events).toHaveLength(2);
      expect(events[0].logs).toBe("a\n");
      expect(events[1].logs).toBe("b\n");
    });
  });

  describe("variable hoisting", () => {
    it("hoists const declaration", async () => {
      const executor = new StreamingVmExecutor();
      const { events, result } = await collectEvents(
        executor,
        "const x = 42;\nconsole.log(x);",
      );

      expect(events).toHaveLength(2);
      expect(events[1].logs).toBe("42\n");
      expect(result.error).toBe("");
    });

    it("hoists let declaration", async () => {
      const executor = new StreamingVmExecutor();
      const { events } = await collectEvents(
        executor,
        "let y = 10;\nconsole.log(y);",
      );

      expect(events).toHaveLength(2);
      expect(events[1].logs).toBe("10\n");
    });

    it("hoists object destructuring", async () => {
      const executor = new StreamingVmExecutor();
      const { events } = await collectEvents(
        executor,
        'const { a, b } = { a: 1, b: 2 };\nconsole.log(a, b);',
      );

      expect(events).toHaveLength(2);
      expect(events[1].logs).toBe("1 2\n");
    });

    it("hoists object destructuring with rename", async () => {
      const executor = new StreamingVmExecutor();
      const { events } = await collectEvents(
        executor,
        'const { x: renamed } = { x: 99 };\nconsole.log(renamed);',
      );

      expect(events).toHaveLength(2);
      expect(events[1].logs).toBe("99\n");
    });

    it("hoists nested object destructuring", async () => {
      const executor = new StreamingVmExecutor();
      const { events } = await collectEvents(
        executor,
        'const { outer: { inner } } = { outer: { inner: "deep" } };\nconsole.log(inner);',
      );

      expect(events).toHaveLength(2);
      expect(events[1].logs).toBe("deep\n");
    });

    it("hoists array destructuring", async () => {
      const executor = new StreamingVmExecutor();
      const { events } = await collectEvents(
        executor,
        "const [first, second] = [1, 2];\nconsole.log(first, second);",
      );

      expect(events).toHaveLength(2);
      expect(events[1].logs).toBe("1 2\n");
    });

    it("hoists nested array destructuring", async () => {
      const executor = new StreamingVmExecutor();
      const { events } = await collectEvents(
        executor,
        "const [a, [b, c]] = [1, [2, 3]];\nconsole.log(a, b, c);",
      );

      expect(events).toHaveLength(2);
      expect(events[1].logs).toBe("1 2 3\n");
    });

    it("hoists rest pattern in array", async () => {
      const executor = new StreamingVmExecutor();
      const { events } = await collectEvents(
        executor,
        "const [head, ...tail] = [1, 2, 3];\nconsole.log(head, tail);",
      );

      expect(events).toHaveLength(2);
      expect(events[1].logs).toBe("1 [ 2, 3 ]\n");
    });

    it("hoists with default values", async () => {
      const executor = new StreamingVmExecutor();
      const { events } = await collectEvents(
        executor,
        'const { a = 5 } = {};\nconsole.log(a);',
      );

      expect(events).toHaveLength(2);
      expect(events[1].logs).toBe("5\n");
    });
  });

  describe("function hoisting", () => {
    it("hoists function declaration", async () => {
      const executor = new StreamingVmExecutor();
      const { events } = await collectEvents(
        executor,
        "function greet() { return 'hi'; };\nconsole.log(greet());",
      );

      expect(events).toHaveLength(2);
      expect(events[1].logs).toBe("hi\n");
    });

    it("hoists async function declaration", async () => {
      const executor = new StreamingVmExecutor();
      const { events } = await collectEvents(
        executor,
        "async function fetchData() { return 42; };\nconsole.log(await fetchData());",
      );

      expect(events).toHaveLength(2);
      expect(events[1].logs).toBe("42\n");
    });
  });

  describe("async execution", () => {
    it("handles await in statements", async () => {
      const executor = new StreamingVmExecutor();
      const { events } = await collectEvents(
        executor,
        "const result = await Promise.resolve(123);\nconsole.log(result);",
      );

      expect(events).toHaveLength(2);
      expect(events[1].logs).toBe("123\n");
    });
  });

  describe("TypeScript support", () => {
    it("handles typed variable declarations", async () => {
      const executor = new StreamingVmExecutor();
      const { events } = await collectEvents(
        executor,
        "const x: number = 42;\nconsole.log(x);",
      );

      expect(events).toHaveLength(2);
      expect(events[1].logs).toBe("42\n");
    });
  });

  describe("error handling", () => {
    it("captures execution errors", async () => {
      const executor = new StreamingVmExecutor();
      const { events, result } = await collectEvents(
        executor,
        "throw new Error('oops');",
      );

      expect(events).toHaveLength(1);
      expect(events[0].error).toBe("oops");
      expect(result.error).toBe("oops");
    });

    it("stops on error", async () => {
      const executor = new StreamingVmExecutor();
      const { events } = await collectEvents(
        executor,
        'throw new Error("stop");\nconsole.log("never");',
      );

      expect(events).toHaveLength(1);
      expect(events[0].error).toBe("stop");
    });
  });

  describe("statement boundaries", () => {
    it("splits on semicolons", async () => {
      const executor = new StreamingVmExecutor();
      const { events } = await collectEvents(
        executor,
        "const a = 1;const b = 2;console.log(a + b);",
      );

      expect(events).toHaveLength(3);
      expect(events[2].logs).toBe("3\n");
    });

    it("batches statements without semicolons until end of stream", async () => {
      const executor = new StreamingVmExecutor();
      // Without semicolons, all statements batch together
      const { events, result } = await collectEvents(
        executor,
        "const a = 1\nconst b = 2\nconsole.log(a + b)",
      );

      // All executed as one batch at end of stream
      expect(events).toHaveLength(1);
      expect(events[0].logs).toBe("3\n");
      expect(result.error).toBe("");
    });

    it("waits for complete statement", async () => {
      const executor = new StreamingVmExecutor();
      // Multi-line object - should wait until complete
      const { events } = await collectEvents(
        executor,
        "const obj = {\n  a: 1,\n  b: 2\n};\nconsole.log(obj.a);",
      );

      expect(events).toHaveLength(2);
      expect(events[1].logs).toBe("1\n");
    });

    it("handles multi-line ternary with ? on new line", async () => {
      const executor = new StreamingVmExecutor();
      // Ternary where ? starts on a new line - handled naturally by semicolon-only execution
      const { events } = await collectEvents(
        executor,
        'const x = true\n  ? "yes"\n  : "no";\nconsole.log(x);',
      );

      expect(events).toHaveLength(2);
      expect(events[0].statement).toContain("? ");
      expect(events[0].statement).toContain(": ");
      expect(events[1].logs).toBe("yes\n");
    });

    it("handles multi-line ternary with optional chaining in condition", async () => {
      const executor = new StreamingVmExecutor();
      // Optional chaining + ternary - handled naturally by semicolon-only execution
      const { events } = await collectEvents(
        executor,
        'const obj = { method: () => true };\nconst x = obj?.method()\n  ? "yes"\n  : "no";\nconsole.log(x);',
      );

      expect(events).toHaveLength(3);
      expect(events[1].statement).toContain("obj?.method()");
      expect(events[1].statement).toContain("? ");
      expect(events[2].logs).toBe("yes\n");
    });

    it("handles semicolons inside strings", async () => {
      const executor = new StreamingVmExecutor();
      const { events } = await collectEvents(
        executor,
        'const x = "hello; world";\nconsole.log(x);',
      );

      expect(events).toHaveLength(2);
      expect(events[1].logs).toBe("hello; world\n");
    });

    it("handles semicolons inside line comments", async () => {
      const executor = new StreamingVmExecutor();
      const { events } = await collectEvents(
        executor,
        'const x = 1; // comment; with; semicolons\nconsole.log(x);',
      );

      expect(events).toHaveLength(2);
      expect(events[1].logs).toBe("1\n");
    });
  });
});
