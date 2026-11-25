import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ValidThinkingLevel = (typeof VALID_THINKING_LEVELS)[number];

export interface SlashCommandOptions {
  askSelect?: (title: string, options: string[]) => Promise<string | undefined>;
  onBackground?: (task: Promise<void>) => void;
  onThinkingSelected?: (level: ValidThinkingLevel) => void;
}

type ModelItem = Parameters<ExtensionAPI["setModel"]>[0];
type ThinkingLevelParam = Parameters<ExtensionAPI["setThinkingLevel"]>[0];

async function applyModelSelection(pi: ExtensionAPI, ctx: ExtensionContext, model: ModelItem): Promise<void> {
  try {
    const ok = await pi.setModel(model);
    if (ok) {
      ctx.ui?.notify?.(`Modelo cambiado a ${model.provider}/${model.id}`, "info");
    } else {
      ctx.ui?.notify?.(
        `No se pudo cambiar al modelo ${model.provider}/${model.id}. Verifique la API key o configuración.`,
        "warning",
      );
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.ui?.notify?.(`Error al cambiar de modelo: ${message}`, "warning");
  }
}

function applyThinkingLevel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  level: ValidThinkingLevel,
  opts?: SlashCommandOptions,
): void {
  try {
    pi.setThinkingLevel(level as ThinkingLevelParam);
    opts?.onThinkingSelected?.(level);
    ctx.ui?.notify?.(`Nivel de thinking establecido en ${level}`, "info");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.ui?.notify?.(`Error al cambiar el nivel de thinking: ${message}`, "warning");
  }
}

export async function handleModelCommand(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  rawArg: string,
  opts?: SlashCommandOptions,
): Promise<void> {
  const query = rawArg.trim();
  const registry = ctx.modelRegistry;
  if (!registry) {
    ctx.ui?.notify?.("El registro de modelos no está disponible.", "warning");
    return;
  }

  if (query) {
    let model: ModelItem | undefined = undefined;
    const slashIdx = query.indexOf("/");
    if (slashIdx !== -1) {
      const provider = query.slice(0, slashIdx).trim();
      const modelId = query.slice(slashIdx + 1).trim();
      model = registry.find?.(provider, modelId);
    }
    if (!model) {
      const all: readonly ModelItem[] = (await registry.getAll?.()) ?? [];
      model =
        all.find((m) => {
          const full = `${m.provider}/${m.id}`;
          return full === query || m.id === query;
        }) ??
        all.find((m) => {
          const full = `${m.provider}/${m.id}`.toLowerCase();
          const q = query.toLowerCase();
          return full === q || m.id?.toLowerCase() === q;
        });
    }

    if (!model) {
      ctx.ui?.notify?.(`El modelo "${query}" no existe en el catálogo o configuración.`, "warning");
      return;
    }

    await applyModelSelection(pi, ctx, model);
    return;
  }

  let available: readonly ModelItem[] = [];
  try {
    available = (await registry.getAvailable?.()) ?? [];
  } catch {
    available = [];
  }
  if (!available || available.length === 0) {
    try {
      available = (await registry.getAll?.()) ?? [];
    } catch {
      available = [];
    }
  }

  if (!available || available.length === 0) {
    ctx.ui?.notify?.("No hay modelos disponibles en el catálogo.", "warning");
    return;
  }

  const options = available.map((m) => `${m.provider}/${m.id}`);
  const selectFn = opts?.askSelect ?? ((title: string, items: string[]) => ctx.ui?.select?.(title, items));
  const interactiveFlow = (async () => {
    let selected: string | undefined;
    try {
      selected = await selectFn("Seleccionar modelo", options);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.ui?.notify?.(`Error al seleccionar modelo: ${message}`, "warning");
      return;
    }
    if (!selected) return;

    const selectedModel = available.find(
      (m) => `${m.provider}/${m.id}` === selected || m.id === selected,
    );
    if (!selectedModel) return;

    await applyModelSelection(pi, ctx, selectedModel);
  })();

  if (opts?.onBackground) {
    opts.onBackground(interactiveFlow);
    return;
  }
  await interactiveFlow;
}

export async function handleThinkingCommand(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  rawArg: string,
  opts?: SlashCommandOptions,
): Promise<void> {
  const query = rawArg.trim();
  if (query) {
    const normalized = query.toLowerCase();
    if (VALID_THINKING_LEVELS.includes(normalized as ValidThinkingLevel)) {
      applyThinkingLevel(pi, ctx, normalized as ValidThinkingLevel, opts);
    } else {
      ctx.ui?.notify?.(
        `Nivel de thinking inválido: "${query}". Niveles válidos: ${VALID_THINKING_LEVELS.join(", ")}`,
        "warning",
      );
    }
    return;
  }

  const selectFn = opts?.askSelect ?? ((title: string, items: string[]) => ctx.ui?.select?.(title, items));
  const interactiveFlow = (async () => {
    let selected: string | undefined;
    try {
      selected = await selectFn("Nivel de thinking", [...VALID_THINKING_LEVELS]);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.ui?.notify?.(`Error al seleccionar nivel de thinking: ${message}`, "warning");
      return;
    }
    if (!selected) return;

    const normalized = selected.trim().toLowerCase();
    if (VALID_THINKING_LEVELS.includes(normalized as ValidThinkingLevel)) {
      applyThinkingLevel(pi, ctx, normalized as ValidThinkingLevel, opts);
    }
  })();

  if (opts?.onBackground) {
    opts.onBackground(interactiveFlow);
    return;
  }
  await interactiveFlow;
}

