/**
 * dsh-voice — browser half.
 *
 *  • 🎤 at `conversation.input.left` — click to record, click again to
 *    transcribe. Audio is recorded with MediaRecorder and sent to the host's
 *    `/dsh-voice/stt` route (Whisper-compatible backend), so it works even in
 *    regions where the browser's cloud SpeechRecognition (which depends on
 *    Google) is unreachable. Falls back to SpeechRecognition when the backend
 *    is not configured.
 *  • 🔊 at `conversation.chat.assistant-actions` — read one assistant reply
 *    aloud via the Web Speech API (speechSynthesis).
 *
 * Plain JavaScript, no JSX — build elements with React.createElement.
 */

window.__ModuleLoader__.load({
  id: "dsh-voice",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require("react");
    const { useState, useRef, useMemo, useEffect } = React;

    // ── tweakable defaults (per-browser; host-settings wiring is a roadmap item) ──
    const TTS_LANG = ""; // "" = browser default
    const TTS_RATE = 1; // 0.5 .. 2
    const TTS_PITCH = 1; // 0 .. 2

    const inject = ["slots"];

    const getRecognition = () =>
      typeof window !== "undefined" && (window.SpeechRecognition || window.webkitSpeechRecognition || null);

    // ──────────────────────────────────────────────────────────────────────────
    // Mic button — MediaRecorder → host /dsh-voice/stt → draft
    // ──────────────────────────────────────────────────────────────────────────
    function MicButton(props) {
      const { useInput, inputActions } = props;
      const [state, setState] = useState("idle"); // idle | recording | transcribing | listening | error
      const [error, setError] = useState("");
      const mediaRef = useRef(null); // { stream, recorder }
      const stateRef = useRef("idle");
      const input = typeof useInput === "function" ? useInput((s) => s) : null;
      const inputRef = useRef(null);
      inputRef.current = input;

      const setStateBoth = (s) => {
        stateRef.current = s;
        setState(s);
      };

      useEffect(() => {
        return () => {
          const m = mediaRef.current;
          if (m) {
            try {
              if (m.recorder && m.recorder.state !== "inactive") m.recorder.stop();
            } catch (_) {
              /* ignore */
            }
            if (m.stream) m.stream.getTracks().forEach((t) => t.stop());
          }
        };
      }, []);

      const setDraftText = (text) => {
        if (!text || !inputActions) return;
        const draft = (inputRef.current && inputRef.current.draft) || "";
        const sep = draft && !/[\s\u3000]$/.test(draft) ? " " : "";
        inputActions.setDraft(draft + sep + text);
      };

      /** Send an audio blob to the host route for Whisper transcription. */
      const transcribeViaHost = async (blob) => {
        const res = await fetch("/dsh-voice/stt", {
          method: "POST",
          headers: { "Content-Type": blob.type || "audio/webm" },
          body: blob,
        });
        let data = {};
        try {
          data = await res.json();
        } catch (_) {
          /* non-JSON error body */
        }
        if (!res.ok) {
          const err = new Error(data.error || `transcription failed (HTTP ${res.status})`);
          err.hostError = true;
          throw err;
        }
        return data;
      };

      /** Fallback: browser SpeechRecognition (only works where Google is reachable). */
      const trySpeechRecognition = () => {
        const SR = getRecognition();
        if (!SR) {
          setStateBoth("error");
          setError("未配置语音识别后端（voice.stt.apiBase），且当前浏览器不支持内置语音识别");
          return;
        }
        let rec;
        try {
          rec = new SR();
        } catch (_) {
          setStateBoth("error");
          setError("语音识别初始化失败");
          return;
        }
        rec.interimResults = false;
        rec.continuous = false;
        rec.maxAlternatives = 1;
        rec.onresult = (event) => {
          let text = "";
          for (let i = event.resultIndex; i < event.results.length; i++) {
            const r = event.results[i] && event.results[i][0];
            if (r) text += r.transcript;
          }
          if (text) setDraftText(text);
          setStateBoth("idle");
          setError("");
        };
        rec.onerror = (event) => {
          setStateBoth("error");
          setError("识别出错：" + (event && event.error ? event.error : "unknown"));
          console.error("[dsh-voice] SpeechRecognition error:", event && event.error);
        };
        rec.onend = () => {
          if (stateRef.current !== "error") setStateBoth("idle");
        };
        setStateBoth("listening");
        try {
          rec.start();
        } catch (err) {
          setStateBoth("error");
          setError("识别启动失败：" + (err && err.message ? err.message : "unknown"));
        }
      };

      const startRecording = async () => {
        setError("");
        let stream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (err) {
          const n = err && err.name ? err.name : "UnknownError";
          if (n === "NotAllowedError" || n === "PermissionDeniedError" || n === "SecurityError") {
            setError("麦克风权限被拒绝，请在浏览器地址栏允许麦克风");
          } else {
            setError("无法访问麦克风：" + n);
          }
          setStateBoth("error");
          console.error("[dsh-voice] getUserMedia failed:", n, err);
          return;
        }

        const chunks = [];
        let recorder;
        try {
          recorder = new MediaRecorder(stream);
        } catch (_) {
          stream.getTracks().forEach((t) => t.stop());
          setStateBoth("error");
          setError("当前浏览器不支持录音（MediaRecorder）");
          return;
        }
        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size) chunks.push(e.data);
        };
        recorder.onstop = async () => {
          stream.getTracks().forEach((t) => t.stop());
          mediaRef.current = null;
          const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
          setStateBoth("transcribing");
          try {
            const data = await transcribeViaHost(blob);
            if (data && data.text) setDraftText(data.text);
            setStateBoth("idle");
            setError("");
          } catch (err) {
            console.error("[dsh-voice] host transcription failed:", err && err.message);
            if (err && err.hostError) {
              trySpeechRecognition();
            } else {
              setStateBoth("error");
              setError(err && err.message ? err.message : String(err));
            }
          }
        };
        mediaRef.current = { stream, recorder };
        recorder.start();
        setStateBoth("recording");
      };

      const onClick = () => {
        if (stateRef.current === "recording") {
          const m = mediaRef.current;
          if (m && m.recorder && m.recorder.state !== "inactive") {
            m.recorder.stop(); // triggers onstop → transcribe
          }
        } else if (stateRef.current === "idle" || stateRef.current === "error") {
          startRecording();
        }
      };

      const title =
        state === "error"
          ? error
          : state === "recording"
            ? "正在录音，点击停止并识别"
            : state === "transcribing"
              ? "正在识别…"
              : state === "listening"
                ? "正在聆听…"
                : "语音输入";
      const icon =
        state === "recording"
          ? "⏺"
          : state === "transcribing"
            ? "⏳"
            : state === "listening"
              ? "●"
              : state === "error"
                ? "⚠️"
                : "🎤";

      return React.createElement(
        "button",
        {
          type: "button",
          className:
            "dsh-voice-btn dsh-voice-mic" +
            (state === "recording" || state === "listening" ? " is-listening" : "") +
            (state === "error" ? " is-error" : ""),
          onClick,
          title,
          "aria-label": title,
          disabled: !inputActions,
        },
        icon,
      );
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Speaker button — read one assistant reply aloud
    // ──────────────────────────────────────────────────────────────────────────
    function SpeakerButton(props) {
      const { messageId, useSession } = props;
      const [speaking, setSpeaking] = useState(false);

      const session =
        typeof useSession === "function" ? useSession((snap) => snap) : null;

      const text = useMemo(() => {
        if (!session || !Array.isArray(session.nodes)) return "";
        const node = session.nodes.find(
          (n) => n && n.kind === "assistant" && n.messageId === messageId,
        );
        if (!node || !Array.isArray(node.blocks)) return "";
        return node.blocks
          .filter((b) => b && b.kind === "text" && b.text)
          .map((b) => b.text)
          .join("\n")
          .trim();
      }, [session, messageId]);

      useEffect(() => {
        if (typeof window !== "undefined" && window.speechSynthesis) {
          window.speechSynthesis.getVoices();
        }
        return () => {
          if (typeof window !== "undefined" && window.speechSynthesis) {
            window.speechSynthesis.cancel();
          }
        };
      }, []);

      const pickVoice = () => {
        const synth = window.speechSynthesis;
        if (!synth) return null;
        const voices = synth.getVoices();
        if (!voices.length) return null;
        if (TTS_LANG) {
          const want = TTS_LANG.toLowerCase();
          const match = voices.find((v) => v.lang && v.lang.toLowerCase().startsWith(want));
          if (match) return match;
        }
        return voices.find((v) => v.default) || voices[0];
      };

      const speak = () => {
        if (!text || !window.speechSynthesis) return;
        const synth = window.speechSynthesis;
        if (speaking) {
          synth.cancel();
          setSpeaking(false);
          return;
        }
        synth.cancel();
        const u = new SpeechSynthesisUtterance(text);
        if (TTS_LANG) u.lang = TTS_LANG;
        u.rate = TTS_RATE;
        u.pitch = TTS_PITCH;
        const voice = pickVoice();
        if (voice) u.voice = voice;
        u.onend = () => setSpeaking(false);
        u.onerror = (event) => {
          if (event && event.error && event.error !== "interrupted") {
            console.error("[dsh-voice] speechSynthesis error:", event.error);
          }
          setSpeaking(false);
        };
        setSpeaking(true);
        synth.speak(u);
      };

      return React.createElement(
        "button",
        {
          type: "button",
          className: "dsh-voice-btn dsh-voice-speaker" + (speaking ? " is-speaking" : ""),
          onClick: speak,
          title: speaking ? "停止朗读" : text ? "朗读这条回答" : "没有可朗读的文本",
          "aria-label": speaking ? "停止朗读" : "朗读这条回答",
          disabled: !text || !window.speechSynthesis,
        },
        "🔊",
      );
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Plugin body
    // ──────────────────────────────────────────────────────────────────────────
    function apply(ctx) {
      let styleEl = document.getElementById("dsh-voice-style");
      if (!styleEl) {
        styleEl = document.createElement("style");
        styleEl.id = "dsh-voice-style";
        styleEl.textContent = [
          ".dsh-voice-btn{",
          "  appearance:none;background:transparent;border:1px solid transparent;",
          "  border-radius:6px;cursor:pointer;font-size:14px;line-height:1;",
          "  padding:4px 6px;opacity:.7;transition:opacity .12s, background .12s, border-color .12s;",
          "}",
          ".dsh-voice-btn:hover{opacity:1;background:rgba(128,128,128,.12)}",
          ".dsh-voice-btn:disabled{opacity:.35;cursor:default}",
          ".dsh-voice-btn.is-listening,.dsh-voice-btn.is-speaking{",
          "  color:#e5484d;border-color:#e5484d;opacity:1;",
          "}",
          ".dsh-voice-btn.is-error{color:#f59e0b;border-color:#f59e0b;opacity:1}",
        ].join("\n");
        document.head.append(styleEl);
      }
      ctx.effect(() => {
        return () => {
          if (styleEl && styleEl.isConnected) styleEl.remove();
        };
      }, "dsh-voice: remove styles");

      ctx.slots.inject("conversation.input.left", () => {
        const dispose = ctx.slots.register(
          { name: "conversation.input.left", id: "dsh-voice-mic", order: 20 },
          MicButton,
        );
        return () => dispose();
      });

      ctx.slots.inject("conversation.chat.assistant-actions", () => {
        const dispose = ctx.slots.register(
          { name: "conversation.chat.assistant-actions", id: "dsh-voice-speaker", order: 30 },
          SpeakerButton,
        );
        return () => dispose();
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
