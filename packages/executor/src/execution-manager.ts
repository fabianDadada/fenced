import * as vm from "node:vm";
import type { RuntimeChannel } from ".";
import {
  StreamingVmExecutor,
  type StreamingVmRun,
} from "./streaming-vm-executor";
import { MountManager } from "./mount-manager";
import { Data, StreamedData } from "./data-manager";

type ExecutionManagerInit = {
  channel: RuntimeChannel;
  skills?: Record<string, unknown>;
};

export class ExecutionManager {
  private readonly executor: StreamingVmExecutor;
  private readonly mountManager: MountManager;

  constructor({ channel, skills = {} }: ExecutionManagerInit) {
    this.mountManager = new MountManager(channel);
    const context = vm.createContext({
      Data,
      StreamedData,
      mount: this.mountManager.mount,
      ...skills,
    });
    this.executor = new StreamingVmExecutor(context);
  }

  run(lines: AsyncIterable<string>): StreamingVmRun {
    return this.executor.run(lines);
  }

  invokeCallback(mountId: string, name: string, args: unknown[]): void {
    this.mountManager.invokeCallback(mountId, name, args);
  }

  stop(): void {
    // StreamingVmExecutor doesn't have a stop method yet
    // Could be added if needed for cancellation
  }
}
