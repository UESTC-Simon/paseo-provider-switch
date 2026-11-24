import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { performNativeHandoff } from "./server/handoff";
import { createSwitchableProvider } from "./server/switchable-provider";
import { handoffAgentRpc, listSwitchTargetsRpc } from "./shared/protocol";
import { SWITCHABLE_PROVIDER_ID, switchSettings, type SwitchSettings } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(switchSettings);
  let currentSettings: SwitchSettings = switchSettings.schema.parse({});
  let receivedUpdate = false;
  let cachedPaseo: PaseoApi | null = null;

  const stopSettings = settings.subscribe((state) => {
    receivedUpdate = true;
    if (state.status === "ready") {
      currentSettings = state.values;
    }
  });
  void settings.read().then(
    (state) => {
      if (!receivedUpdate && state.status === "ready") {
        currentSettings = state.values;
      }
    },
    (error: unknown) => {
      console.error("[provider-switch] Could not read settings:", error);
    },
  );

  // Capture the daemon's shared PaseoApi handle whenever any lifecycle hook runs
  // (including right before opening a Switchable provider session).
  const removeOpenHook = server.addHook("agent.open.before", async (_event, { paseo }) => {
    cachedPaseo = paseo;
  });

  server.registerProvider(
    createSwitchableProvider({
      getPaseo: () => cachedPaseo,
      getSettings: () => currentSettings,
    }),
  );

  server.handle(listSwitchTargetsRpc, async (_input, { paseo }) => {
    cachedPaseo = paseo;
    const available = await paseo.providers.listAvailable();
    const providers = available.providers
      .filter((entry) => entry.available)
      .map((entry) => ({
        id: entry.provider,
        label:
          entry.provider === SWITCHABLE_PROVIDER_ID
            ? "Switchable (In-Chat)"
            : entry.provider.charAt(0).toUpperCase() + entry.provider.slice(1),
      }));
    return { providers };
  });

  server.handle(handoffAgentRpc, async (input, { paseo }) => {
    cachedPaseo = paseo;
    return performNativeHandoff(paseo, input, currentSettings);
  });

  return () => {
    stopSettings();
    removeOpenHook();
    cachedPaseo = null;
  };
}
