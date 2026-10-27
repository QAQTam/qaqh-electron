import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RingingClient } from "./ringing-client.js";

export interface SessionModelSelection {
  provider_id: string;
  model_id: string;
  reasoning_effort?: string;
}

export interface ProviderProfileView {
  id: string;
  model: string;
  credential: "api_key" | "chatgpt_plan" | "deepseek_account";
  base_url: string;
  wire: string;
  reasoning_effort: string;
  has_api_key: boolean;
}

export interface ProviderModelView {
  id: string;
  display_name: string;
}

export interface ProviderProfilesResult {
  active_profile: string;
  profiles: ProviderProfileView[];
}

export interface ProviderModelsResult {
  provider_id: string;
  models: ProviderModelView[];
}

export interface ModelPickerPayload {
  profiles: ProviderProfileView[];
  modelsByProvider: Record<string, ProviderModelView[]>;
  modelErrors: Record<string, string>;
  selection: SessionModelSelection | null;
  activeProfile: string;
}

const DEFAULT_SELECTION_FILE = "model-selection-default.json";

export async function readDefaultModelSelection(userDataPath: string): Promise<SessionModelSelection | null> {
  try {
    const content = await readFile(join(userDataPath, DEFAULT_SELECTION_FILE), "utf8");
    const parsed: unknown = JSON.parse(content);
    return isSelection(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeDefaultModelSelection(
  userDataPath: string,
  selection: SessionModelSelection,
): Promise<void> {
  await mkdir(userDataPath, { recursive: true });
  const path = join(userDataPath, DEFAULT_SELECTION_FILE);
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(selection, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

export async function clearDefaultModelSelection(userDataPath: string): Promise<void> {
  try {
    await unlink(join(userDataPath, DEFAULT_SELECTION_FILE));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function loadProviderChoices(client: RingingClient): Promise<{
  profiles: ProviderProfileView[];
  modelsByProvider: Record<string, ProviderModelView[]>;
  modelErrors: Record<string, string>;
}> {
  const result = await client.adminService<ProviderProfilesResult>("profile.list", {});
  const modelsByProvider: Record<string, ProviderModelView[]> = {};
  const modelErrors: Record<string, string> = {};

  await Promise.all(result.profiles.map(async (profile) => {
    try {
      const catalog = await client.adminService<ProviderModelsResult>("provider.models", {
        provider_id: profile.id,
      });
      modelsByProvider[profile.id] = catalog.models;
    } catch (error) {
      modelErrors[profile.id] = error instanceof Error ? error.message : String(error);
      modelsByProvider[profile.id] = profile.model ? [{ id: profile.model, display_name: profile.model }] : [];
    }
  }));

  return { profiles: result.profiles, modelsByProvider, modelErrors };
}

export async function applyConfiguredDefault(
  client: RingingClient,
  userDataPath: string,
  selection: SessionModelSelection,
): Promise<void> {
  const normalized = await client.adminService<SessionModelSelection>("profile.model_selection", {
    provider_id: selection.provider_id,
    model_id: selection.model_id,
    ...(selection.reasoning_effort ? { reasoning_effort: selection.reasoning_effort } : {}),
  });
  await writeDefaultModelSelection(userDataPath, normalized);
}

export async function normalizeSessionSelection(
  client: RingingClient,
  selection: SessionModelSelection,
): Promise<SessionModelSelection> {
  return client.adminService<SessionModelSelection>("profile.model_selection", {
    provider_id: selection.provider_id,
    model_id: selection.model_id,
    ...(selection.reasoning_effort ? { reasoning_effort: selection.reasoning_effort } : {}),
  });
}

function isSelection(value: unknown): value is SessionModelSelection {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.provider_id === "string"
    && record.provider_id.trim() !== ""
    && typeof record.model_id === "string"
    && record.model_id.trim() !== ""
    && (record.reasoning_effort == null || typeof record.reasoning_effort === "string");
}
