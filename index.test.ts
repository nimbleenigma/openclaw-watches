import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginCommandDefinition, OpenClawPluginServiceContext } from "./api.js";
import registerWatches from "./index.js";

describe("watches plugin registration", () => {
  it("registers watch commands and scheduler service", async () => {
    const commands: OpenClawPluginCommandDefinition[] = [];
    const tools: Array<{ tool: unknown; opts: unknown }> = [];
    let service:
      | {
          id: string;
          start: (ctx: OpenClawPluginServiceContext) => void | Promise<void>;
          stop?: (ctx: OpenClawPluginServiceContext) => void | Promise<void>;
        }
      | undefined;

    const api = createTestPluginApi({
      id: "watches",
      runtime: {
        state: { resolveStateDir: () => "/tmp/openclaw-watches-test" },
        system: {
          notifyCapturedTarget: vi.fn(),
        },
      } as never,
      registerCommand: (command) => commands.push(command),
      registerTool: (tool, opts) => {
        tools.push({ tool, opts });
      },
      registerService: (nextService) => {
        service = nextService;
      },
    });

    registerWatches.register(api);

    expect(commands.map((command) => command.name).toSorted()).toEqual(["watch", "watches"]);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.opts).toMatchObject({ name: "watches_manage" });
    expect(service?.id).toBe("watches-scheduler");
  });
});
