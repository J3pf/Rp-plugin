import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ValidThinkingLevel = (typeof VALID_THINKING_LEVELS)[number];

export interface SlashCommandOptions {
  askSelect?: (title: string, options: string[]) => Promise<string | undefined>;
  onBackground?: (task: Promise<void>) => void;
  onThinkingSelected?: (level: ValidThinkingLevel) => void;
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
    let model: any = undefined;
    const slashIdx = query.indexOf("/");
    if (slashIdx !== -1) {
      const provider = query.slice(0, slashIdx).trim();
      const modelId = query.slice(slashIdx + 1).trim();
      model = registry.find?.(provider, modelId);
    }
    if (!model) {
      const all = (await registry.getAll?.()) ?? [];
      model =
        all.find((m: any) => {
          const full = `${m.provider}/${m.id}`;
          return full === query || m.id === query;
        }) ??
        all.find((m: any) => {
          const full = `${m.provider}/${m.id}`.toLowerCase();
          const q = query.toLowerCase();
          return full === q || m.id?.toLowerCase() === q;
        });
    }

    if (!model) {
      ctx.ui?.notify?.(`El modelo "${query}" no existe en el catálogo o configuración.`, "warning");
      return;
    }

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
    } catch (err: any) {
      ctx.ui?.notify?.(`Error al cambiar de modelo: ${err?.message ?? String(err)}`, "warning");
    }
    return;
  }

  let available: any[] = [];
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

  const options = available.map((m: any) => `${m.provider}/${m.id}`);
  const selectFn = opts?.askSelect ?? ((title: string, items: string[]) => ctx.ui?.select(title, items));
  const interactiveFlow = (async () => {
    const selected = await selectFn("Seleccionar modelo", options);
    if (!selected) return;

    const selectedModel = available.find(
      (m: any) => `${m.provider}/${m.id}` === selected || m.id === selected,
    );
    if (!selectedModel) return;

    try {
      const ok = await pi.setModel(selectedModel);
      if (ok) {
        ctx.ui?.notify?.(`Modelo cambiado a ${selectedModel.provider}/${selectedModel.id}`, "info");
      } else {
        ctx.ui?.notify?.(
          `No se pudo cambiar al modelo ${selectedModel.provider}/${selectedModel.id}. Verifique la API key o configuración.`,
          "warning",
        );
      }
    } catch (err: any) {
      ctx.ui?.notify?.(`Error al cambiar de modelo: ${err?.message ?? String(err)}`, "warning");
    }
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
      try {
        pi.setThinkingLevel(normalized as any);
        opts?.onThinkingSelected?.(normalized as ValidThinkingLevel);
        ctx.ui?.notify?.(`Nivel de thinking establecido en ${normalized}`, "info");
      } catch (err: any) {
        ctx.ui?.notify?.(`Error al cambiar el nivel de thinking: ${err?.message ?? String(err)}`, "warning");
      }
    } else {
      ctx.ui?.notify?.(
        `Nivel de thinking inválido: "${query}". Niveles válidos: ${VALID_THINKING_LEVELS.join(", ")}`,
        "warning",
      );
    }
    return;
  }

  const selectFn = opts?.askSelect ?? ((title: string, items: string[]) => ctx.ui?.select(title, items));
  const interactiveFlow = (async () => {
    const selected = await selectFn("Nivel de thinking", [...VALID_THINKING_LEVELS]);
    if (!selected) return;

    const normalized = selected.trim().toLowerCase();
    if (VALID_THINKING_LEVELS.includes(normalized as ValidThinkingLevel)) {
      try {
        pi.setThinkingLevel(normalized as any);
        opts?.onThinkingSelected?.(normalized as ValidThinkingLevel);
        ctx.ui?.notify?.(`Nivel de thinking establecido en ${normalized}`, "info");
      } catch (err: any) {
        ctx.ui?.notify?.(`Error al cambiar el nivel de thinking: ${err?.message ?? String(err)}`, "warning");
      }
    }
  })();

  if (opts?.onBackground) {
    opts.onBackground(interactiveFlow);
    return;
  }
  await interactiveFlow;
}

