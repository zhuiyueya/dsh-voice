/**
 * dsh-voice — give text-only DeepSeek models ears and a mouth.
 *
 * Two layers:
 *
 *  1. Browser-native voice UI (lib/client.js): a 🎤 mic button in the composer
 *     (Web Speech API SpeechRecognition → transcribed text lands in the input)
 *     and a 🔊 read-aloud button on every assistant message
 *     (Web Speech API speechSynthesis). Zero API key, works out of the box.
 *
 *  2. Agent tools (this file): `voice_transcribe` (audio file → text via a
 *     Whisper-compatible `/audio/transcriptions` endpoint) and `voice_speak`
 *     (text → audio file via an OpenAI-compatible `/audio/speech` endpoint).
 *     These let the model itself process audio files the user attaches, or
 *     produce spoken audio artifacts, even though the model is text-only.
 *
 * The model never sees or produces raw audio — speech is handled at the
 * input/output boundary, exactly like the vision-bridge converts images to
 * text before the model sees them.
 *
 * Configuration: `cordis.patch.yml` plugin config (patch layer) plus the
 * optional `voice` settings namespace (settings.yaml, hot-reloaded).
 */

import z from "@deepseek-ai/schemastery";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const name = "dsh-voice";
const inject = ["tools", "settings"];

const Config = z.object({
  /** Speech-to-text backend for the `voice_transcribe` tool. */
  stt: z
    .object({
      enabled: z.boolean().default(true),
      /**
       * OpenAI-compatible `/audio/transcriptions` base URL. Points at OpenAI,
       * Groq, or a local keyless Whisper server (whisper.cpp: `http://127.0.0.1:8080`).
       */
      apiBase: z.string().default(""),
      apiKey: z.string().role("secret").default(""),
      apiKeyEnv: z.string().role("credential-ref").default("VOICE_STT_API_KEY"),
      model: z.string().default("whisper-1"),
      /** ISO-639-1 hint (zh / en / …); empty = auto-detect. */
      language: z.string().default(""),
      timeoutMs: z.number().min(1).default(120000),
    })
    .default({}),
  /** Text-to-speech backend for the `voice_speak` tool. */
  tts: z
    .object({
      enabled: z.boolean().default(true),
      /**
       * OpenAI-compatible `/audio/speech` base URL (OpenAI, Azure, or a local
       * keyless service such as a Kokoro/piper HTTP wrapper).
       */
      apiBase: z.string().default(""),
      apiKey: z.string().role("secret").default(""),
      apiKeyEnv: z.string().role("credential-ref").default("VOICE_TTS_API_KEY"),
      model: z.string().default("tts-1"),
      /** Voice name (OpenAI voices: alloy/echo/fable/onyx/nova/shimmer; or the local service's voice id). */
      voice: z.string().default("alloy"),
      /** Output audio container: mp3 | opus | aac | flac | wav (service-dependent). */
      format: z.string().default("mp3"),
      timeoutMs: z.number().min(1).default(60000),
    })
    .default({}),
});

const VOICE_NS = settingsNamespace("voice");

/** Resolve an API key from direct config, then from the configured env var. */
function resolveKey(cfg) {
  if (cfg.apiKey) return cfg.apiKey;
  if (cfg.apiKeyEnv && process.env[cfg.apiKeyEnv]) return process.env[cfg.apiKeyEnv];
  return "";
}

function apply(ctx, config) {
  let current = () => config;
  installSettingsSection(ctx, VOICE_NS, Config, config, {
    setSource: (source) => {
      current = source;
    },
    onChange: () => {},
  });

  const logger = ctx.logger;

  // ────────────────────────────────────────────────────────────────────────────
  // voice_transcribe — audio file → text
  // ────────────────────────────────────────────────────────────────────────────
  if (config.stt.enabled) ctx.tools.register(
    defineTool({
      name: "voice_transcribe",
      description:
        "Transcribe an audio file (wav/mp3/m4a/ogg/webm/flac) to text via a Whisper-compatible /audio/transcriptions endpoint. Lets a text-only model 'hear' recordings the user attaches.",
      parameters: {
        path: {
          type: "string",
          required: true,
          description: "Absolute path to the audio file to transcribe.",
        },
        language: {
          type: "string",
          description: "Optional language hint (ISO-639-1, e.g. zh, en). Leave empty to auto-detect.",
        },
      },
      output: {
        schema: {
          type: "object",
          properties: {
            text: { type: "string", required: true, description: "Transcribed text." },
            language: { type: "string", description: "Detected / used language." },
          },
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: "text", text: value.text }],
      },
      async execute(args) {
        const cfg = current().stt;
        const apiBase = (cfg.apiBase || "https://api.openai.com/v1").replace(/\/+$/, "");
        const apiKey = resolveKey(cfg);
        if (!apiKey) {
          throw new Error(
            "voice_transcribe needs an API key: set voice.stt.apiKey (or VOICE_STT_API_KEY), or point voice.stt.apiBase at a keyless local Whisper server (e.g. whisper.cpp).",
          );
        }
        const bytes = await readFile(resolve(args.path));
        const form = new FormData();
        form.append("file", new Blob([bytes]), "audio");
        form.append("model", cfg.model);
        const lang = args.language || cfg.language;
        if (lang) form.append("language", lang);
        const res = await fetch(`${apiBase}/audio/transcriptions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form,
          signal: AbortSignal.timeout(cfg.timeoutMs),
        });
        if (!res.ok) {
          throw new Error(`voice_transcribe failed: ${res.status} ${await res.text()}`);
        }
        const data = await res.json();
        return {
          text: typeof data.text === "string" ? data.text : JSON.stringify(data),
          language: data.language,
        };
      },
    }),
  );

  // ────────────────────────────────────────────────────────────────────────────
  // voice_speak — text → audio file
  // ────────────────────────────────────────────────────────────────────────────
  if (config.tts.enabled) ctx.tools.register(
    defineTool({
      name: "voice_speak",
      description:
        "Generate a spoken audio file from text via an OpenAI-compatible /audio/speech endpoint. Writes the audio to the workspace and returns its path. To read a reply aloud directly in the Web UI, use the 🔊 button on the message instead.",
      parameters: {
        text: {
          type: "string",
          required: true,
          description: "Text to synthesize into speech.",
        },
        outPath: {
          type: "string",
          description: "Optional absolute output path (default: <cwd>/dsh-voice-<timestamp>.<format>).",
        },
        voice: {
          type: "string",
          description: "Optional voice override.",
        },
      },
      output: {
        schema: {
          type: "object",
          properties: {
            path: { type: "string", required: true, description: "Absolute path to the written audio file." },
            bytes: { type: "integer", required: true, description: "Bytes written." },
          },
          additionalProperties: false,
        },
        render: (_args, value) => [
          { type: "text", text: `Generated speech: ${value.path} (${value.bytes} bytes)` },
        ],
      },
      async execute(args) {
        const cfg = current().tts;
        const apiBase = (cfg.apiBase || "https://api.openai.com/v1").replace(/\/+$/, "");
        const apiKey = resolveKey(cfg);
        if (!apiKey) {
          throw new Error(
            "voice_speak needs an API key: set voice.tts.apiKey (or VOICE_TTS_API_KEY), or point voice.tts.apiBase at a keyless local TTS service.",
          );
        }
        const res = await fetch(`${apiBase}/audio/speech`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: cfg.model,
            input: args.text,
            voice: args.voice || cfg.voice,
            response_format: cfg.format,
          }),
          signal: AbortSignal.timeout(cfg.timeoutMs),
        });
        if (!res.ok) {
          throw new Error(`voice_speak failed: ${res.status} ${await res.text()}`);
        }
        const buf = Buffer.from(await res.arrayBuffer());
        const out = args.outPath
          ? resolve(args.outPath)
          : resolve(process.cwd(), `dsh-voice-${Date.now()}.${cfg.format}`);
        await writeFile(out, buf);
        return { path: out, bytes: buf.length };
      },
    }),
  );

  logger?.info?.("[dsh-voice] registered voice_transcribe + voice_speak");
}

export { Config, apply, inject, name };
