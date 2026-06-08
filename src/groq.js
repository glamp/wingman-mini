// Groq helpers: transcribe audio (Whisper), translate non-English transcripts to English,
// and extract bug/feedback form fields from the transcript (chat model with JSON output).
// Loaded into the background service worker (via importScripts), which has host_permissions
// for api.groq.com and bypasses CORS.
(function () {
  const BASE = "https://api.groq.com/openai/v1";
  const TRANSCRIBE_MODEL = "whisper-large-v3-turbo";
  const EXTRACT_MODEL = "openai/gpt-oss-120b";

  // Audio blob -> { text, language }. `language` is Whisper's detected language name
  // (e.g. "english", "spanish"); the caller uses it to decide whether to translate.
  async function transcribe(apiKey, blob, filename = "audio.webm") {
    if (!apiKey) throw new Error("Missing Groq API key (set it in Wingman options).");
    const form = new FormData();
    form.append("file", blob, filename);
    form.append("model", TRANSCRIBE_MODEL);
    form.append("response_format", "verbose_json");

    const res = await fetch(`${BASE}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Transcription failed (HTTP ${res.status}). ${text}`.trim());
    }
    const data = await res.json();
    return { text: (data.text || "").trim(), language: data.language || "" };
  }

  const TRANSLATE_PROMPT = [
    "Translate the user's message into natural English.",
    "Output ONLY the translation, with no preamble, notes, or surrounding quotes.",
    "If it is already English, return it unchanged.",
  ].join(" ");

  // Text in any language -> English text. Skips the API call for empty input and falls
  // back to the original text if the model returns nothing.
  async function translate(apiKey, text) {
    if (!apiKey) throw new Error("Missing Groq API key (set it in Wingman options).");
    if (!text || !text.trim()) return text;
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: EXTRACT_MODEL,
        temperature: 0,
        messages: [
          { role: "system", content: TRANSLATE_PROMPT },
          { role: "user", content: text },
        ],
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Translation failed (HTTP ${res.status}). ${errText}`.trim());
    }
    const data = await res.json();
    return (data.choices?.[0]?.message?.content || "").trim() || text;
  }

  const SYSTEM_PROMPT = [
    "You turn a spoken bug/feedback/feature report into structured fields for a ticket.",
    "Return ONLY a JSON object with exactly these keys:",
    '"type" (one of "bug", "feedback", or "feature": bug = something is broken or not working;',
    'feedback = an opinion or UX comment about existing behavior; feature = a request for new',
    "functionality that doesn't exist yet),",
    '"title" (a short one-line summary),',
    '"whatHappened",',
    '"expectedBehavior",',
    '"stepsToReproduce" (an array of short step strings in order, WITHOUT numbering; [] if none),',
    '"severity" (one of "Low","Medium","High","Critical"),',
    '"notes" (anything extra, else "").',
    "Use information only from the transcript. If something isn't mentioned, use an empty",
    'string "" (for severity default to "Medium"). Do not invent details.',
    "Always write all field values in English; if the transcript is in another language,",
    "translate the content to English.",
  ].join(" ");

  // Transcript string -> { type, title, whatHappened, expectedBehavior,
  //   stepsToReproduce, severity, notes }.
  async function extractFields(apiKey, transcript) {
    if (!apiKey) throw new Error("Missing Groq API key (set it in Wingman options).");
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: EXTRACT_MODEL,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: transcript },
        ],
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Form auto-fill failed (HTTP ${res.status}). ${text}`.trim());
    }
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || "{}";
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      throw new Error("Groq returned an unreadable response for the form fields.");
    }
    return {
      type: ["bug", "feedback", "feature"].includes(parsed.type) ? parsed.type : "bug",
      title: parsed.title || "",
      whatHappened: parsed.whatHappened || "",
      expectedBehavior: parsed.expectedBehavior || "",
      stepsToReproduce: formatSteps(parsed.stepsToReproduce),
      severity: parsed.severity || "Medium",
      notes: parsed.notes || "",
    };
  }

  // Render steps as one numbered step per line. Accepts an array (preferred) or a string
  // (splits a run-on like "1. a 2. b" onto separate lines).
  function formatSteps(steps) {
    if (Array.isArray(steps)) {
      return steps
        .map((s) => String(s).trim().replace(/^\d+[.)]\s*/, ""))
        .filter(Boolean)
        .map((s, i) => `${i + 1}. ${s}`)
        .join("\n");
    }
    const str = (steps || "").trim();
    if (!str) return "";
    return str.replace(/\s+(?=\d+[.)]\s)/g, "\n");
  }

  globalThis.Wingman = globalThis.Wingman || {};
  globalThis.Wingman.groq = { transcribe, translate, extractFields };
})();
