import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context, Plugin } from "@opencode/plugin/promise/plugin";
import { log } from "./logger.js";
import { buildInjectionText, InjectionCache } from "./inject.js";
import { runAutoExtraction, type RawSessionMessage } from "./extraction.js";
import { createRuntime } from "./runtime.js";
import { registerMemoryTools } from "./tools.js";

type ModelRef = { providerID: string; id: string; variant?: string };

async function resolveModelRef(
  ctx: Context,
  config: ReturnType<typeof createRuntime>["config"]
): Promise<ModelRef> {
  const raw = config.opencodeModel.trim();
  const variant =
    config.opencodeVariant && config.opencodeVariant !== "default"
      ? config.opencodeVariant
      : undefined;
  const withVariant = (ref: { providerID: string; id: string }): ModelRef =>
    variant ? { ...ref, variant } : ref;

  if (raw === "inherit") {
    const fallback = await ctx.model.default({ location: { directory: ctx.location.directory } });
    if (!fallback.data) throw new Error("opencodeModel=inherit 但宿主没有默认模型");
    return withVariant({ providerID: fallback.data.providerID, id: fallback.data.id });
  }
  if (raw.includes("/")) {
    const index = raw.indexOf("/");
    return withVariant({ providerID: raw.slice(0, index), id: raw.slice(index + 1) });
  }
  return withVariant({ providerID: config.opencodeProvider, id: raw });
}

function readExtractionPrompt(): string {
  const path = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts", "extract.md");
  return readFileSync(path, "utf-8");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const OpenCodeCortexPlugin: Plugin = {
  id: "opencode-cortex",
  async setup(ctx) {
    const runtime = createRuntime(ctx.location.directory);
    const { config, service } = runtime;
    await registerMemoryTools(ctx, service);

    const injectionCache = new InjectionCache(async () =>
      buildInjectionText(
        await service.getOverview(),
        await service.listTitles(config.injectMaxTitles),
        config.injectMaxTitles
      )
    );
    const pendingReinject = new Set<string>();

    await ctx.session.hook("prompt", async (event) => {
      if (config.injectOn === "always") injectionCache.clear(event.sessionID);
    });

    await ctx.session.hook("context", async (event) => {
      try {
        const text = await injectionCache.get(event.sessionID);
        if (text) event.system.push({ type: "text", text });
        if (pendingReinject.delete(event.sessionID)) {
          log("memory context: reinjected after compaction", {
            session_id: event.sessionID,
            injected: Boolean(text),
          });
        }
      } catch (error) {
        log("memory context injection failed", { error: errorMessage(error) });
      }
    });

    const running = new Set<string>();
    const generate = async (prompt: string): Promise<string> => {
      const model = await resolveModelRef(ctx, config);
      const response = await ctx.experimental.generate.text(
        { prompt, model },
        { signal: AbortSignal.timeout(config.autoExtract.timeoutMs) }
      );
      return response.text;
    };
    const getMessages = async (sessionID: string): Promise<RawSessionMessage[]> =>
      (await ctx.session.context({ sessionID })) as unknown as RawSessionMessage[];

    await ctx.session.hook("experimental.idle", (event) => {
      if (!config.autoExtract.enabled) return;
      if (running.has(event.sessionID)) return;
      running.add(event.sessionID);
      void (async () => {
        try {
          const info = await ctx.session.get({ sessionID: event.sessionID });
          if (info.parentID) {
            log("auto extraction: skipped sub-session", {
              session_id: event.sessionID,
              parent_id: info.parentID,
            });
            return;
          }
          await runAutoExtraction(event.sessionID, config, {
            service,
            generate,
            readPrompt: readExtractionPrompt,
            getMessages,
          });
        } catch (error) {
          log("auto extraction: unexpected", { error: errorMessage(error) });
        } finally {
          running.delete(event.sessionID);
        }
      })();
    });

    const controller = new AbortController();
    const watcher = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const location = (event as { location?: { directory?: string } }).location?.directory;
          if (location && location !== ctx.location.directory) continue;
          if (event.type === "session.compaction.ended") {
            log("memory context: compaction event received", {
              session_id: event.data.sessionID,
              reason: event.data.reason,
            });
            injectionCache.clear(event.data.sessionID);
            pendingReinject.add(event.data.sessionID);
            log("memory context: cache cleared", { session_id: event.data.sessionID });
          } else if (event.type === "session.deleted") {
            const sessionID = (event.data as { sessionID?: string }).sessionID;
            if (sessionID) {
              injectionCache.clear(sessionID);
              pendingReinject.delete(sessionID);
            }
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          log("memory event bridge failed", { error: errorMessage(error) });
        }
      }
    })();

    return async () => {
      controller.abort();
      injectionCache.clearAll();
      pendingReinject.clear();
      await watcher;
      await service.close();
    };
  },
};

export default OpenCodeCortexPlugin;
