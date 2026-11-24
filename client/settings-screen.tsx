import {
  type PluginSurfaceProps,
  type SettingsState,
  usePaseo,
  useSettings,
  useTranslation,
} from "@getpaseo/plugin/client";
import {
  ScrollView,
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { SWITCHABLE_PROVIDER_ID, type SwitchSettings, switchSettings } from "../shared/settings";
import { messages } from "./i18n";

type ReadySettings = Extract<SettingsState<typeof switchSettings.schema>, { status: "ready" }>;

function withSavedOption(
  options: ReadonlyArray<{ value: string; label: string }>,
  saved: string,
): Array<{ value: string; label: string }> {
  return options.some((opt) => opt.value === saved)
    ? [...options]
    : [{ value: saved, label: saved }, ...options];
}

export function ProviderSwitchSettingsScreen(props: PluginSurfaceProps) {
  const settings = useSettings(switchSettings);
  const { t } = useTranslation(messages);
  const { host, layout, theme } = props;

  return (
    <ScrollView
      style={{ backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding: layout.compact ? 12 : 24, gap: layout.compact ? 12 : 20 }}
    >
      {settings.status === "ready" ? (
        <SettingsForm key={host.id} {...props} settings={settings} />
      ) : (
        <SettingsSection title={t("settingsScreen")}>
          <SettingsCard>
            <SettingsRow
              label={settings.status === "loading" ? t("settings.loading") : t("settings.unavailable")}
              error={settings.status === "loading" ? null : settings.error}
            />
            {settings.status === "invalid" ? (
              <SettingsAction
                label={t("settings.invalid")}
                actionLabel={t("settings.reset")}
                disabled={settings.saving}
                onPress={() => {
                  void settings.reset();
                }}
              />
            ) : null}
          </SettingsCard>
        </SettingsSection>
      )}
    </ScrollView>
  );
}

function SettingsForm({ host, settings }: PluginSurfaceProps & { settings: ReadySettings }) {
  const paseo = usePaseo();
  const { t } = useTranslation(messages);
  const { values } = settings;
  const save = (patch: Partial<SwitchSettings>) =>
    settings.save({ ...values, ...patch }, settings.revision);

  const providers = useQuery({
    queryKey: ["provider-switch", host.id, "providers"],
    async queryFn() {
      const result = await paseo.providers.listAvailable();
      return result.providers
        .filter((entry) => entry.available && entry.provider !== SWITCHABLE_PROVIDER_ID)
        .map((entry) => ({ value: entry.provider, label: entry.provider }));
    },
  });

  const [modelDraft, setModelDraft] = useState(values.compactorModel);

  return (
    <>
      <SettingsSection title={t("settings.general")}>
        <SettingsCard>
          <SettingsSelect
            label={t("settings.defaultBackend")}
            hint={t("settings.defaultBackendHint")}
            value={values.defaultBackendProvider}
            options={withSavedOption(providers.data ?? [], values.defaultBackendProvider)}
            disabled={settings.saving}
            onValueChange={(defaultBackendProvider) => {
              void save({ defaultBackendProvider });
            }}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t("settings.compaction")}>
        <SettingsCard>
          <SettingsSelect
            label={t("settings.transport")}
            hint={t("settings.transportHint")}
            value={values.compactorTransport}
            options={[
              { value: "auto", label: t("settings.transportAuto") },
              { value: "direct", label: t("settings.transportDirect") },
              { value: "fallback", label: t("settings.transportFallback") },
            ]}
            disabled={settings.saving}
            onValueChange={(compactorTransport) => {
              void save({ compactorTransport });
            }}
          />
          <SettingsInput
            label={t("settings.compactorModel")}
            hint={t("settings.compactorModelHint")}
            initialValue={values.compactorModel}
            onChangeText={setModelDraft}
            disabled={settings.saving}
          />
          <SettingsAction
            label={t("settings.saveField", { field: t("settings.compactorModel") })}
            actionLabel={t("settings.save")}
            disabled={settings.saving || modelDraft.trim() === "" || modelDraft.trim() === values.compactorModel}
            onPress={() => {
              void save({ compactorModel: modelDraft.trim() });
            }}
          />
          <SettingsSelect
            label={t("settings.keepRecentTurns")}
            hint={t("settings.keepRecentTurnsHint")}
            value={String(values.keepRecentTurns)}
            options={[
              { value: "1", label: "1" },
              { value: "2", label: "2" },
              { value: "3", label: "3" },
              { value: "5", label: "5" },
            ]}
            disabled={settings.saving}
            onValueChange={(next) => {
              void save({ keepRecentTurns: Number(next) });
            }}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t("settings.handoff")}>
        <SettingsCard>
          <SettingsSwitch
            label={t("settings.archiveSource")}
            hint={t("settings.archiveSourceHint")}
            value={values.archiveSourceOnHandoff}
            disabled={settings.saving}
            onValueChange={(archiveSourceOnHandoff) => {
              void save({ archiveSourceOnHandoff });
            }}
          />
        </SettingsCard>
      </SettingsSection>

      {settings.saveError ? (
        <SettingsRow label={t("settings.saveError")} error={settings.saveError} />
      ) : null}
    </>
  );
}
