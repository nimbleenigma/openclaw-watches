import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import { createWatchesCommands } from "./src/commands.js";
import { resolveWatchesConfig } from "./src/config.js";
import { createWatchManagementService } from "./src/management.js";
import { WatchesScheduler } from "./src/scheduler.js";
import { resolveWatchesSqlitePath, WatchesStore } from "./src/store.sqlite.js";
import { createWatchesManagementTool } from "./src/tool.js";

export default definePluginEntry({
  id: "watches",
  name: "Watches",
  description: "Temporary model, URL, and GitHub PR watches that notify the originating chat.",
  register(api: OpenClawPluginApi) {
    const config = resolveWatchesConfig(api.pluginConfig);
    let store: WatchesStore | null = null;
    let storePath: string | null = null;
    let scheduler: WatchesScheduler | null = null;

    function getStore(stateDir = api.runtime.state.resolveStateDir()): WatchesStore {
      const nextPath = resolveWatchesSqlitePath(stateDir);
      if (store && storePath === nextPath) {
        return store;
      }
      store?.close();
      store = new WatchesStore(nextPath);
      storePath = nextPath;
      return store;
    }

    api.registerService({
      id: "watches-scheduler",
      start: async (ctx) => {
        scheduler?.stop();
        scheduler = new WatchesScheduler({
          store: getStore(ctx.stateDir),
          runtime: api.runtime,
          cfg: ctx.config,
          config,
          logger: ctx.logger,
        });
        scheduler.start();
      },
      stop: async () => {
        scheduler?.stop();
        scheduler = null;
        store?.close();
        store = null;
        storePath = null;
      },
    });

    const managementDeps = {
      getStore: () => getStore(),
      config,
      wakeScheduler: () => scheduler?.wake(),
    };
    const manager = createWatchManagementService(managementDeps);

    for (const command of createWatchesCommands({
      api,
      ...managementDeps,
    })) {
      api.registerCommand(command);
    }

    api.registerTool((ctx) => createWatchesManagementTool({ manager, ctx }), {
      name: "watches_manage",
    });
  },
});
