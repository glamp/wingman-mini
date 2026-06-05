// Groq helpers: transcribe audio (Whisper) and extract bug/feedback form fields from the
// transcript (chat model with JSON output). Called from the report window; extension pages
// with host_permissions for api.groq.com can fetch directly.
(function () {
  const BASE = "https://api.groq.com/openai/v1";
  const TRANSCRIBE_MODEL = "whisper-large-v3-turbo";
  const EXTRACT_MODEL = "openai/gpt-oss-120b";

  // Audio blob -> transcript string.
  async function transcribe(apiKey, blob, filename = "audio.webm") {
    if (!apiKey) throw new Error("Missing Groq API key (set it in Wingman options).");
    const form = new FormData();
    form.append("file", blob, filename);
    form.append("model", TRANSCRIBE_MODEL);
    form.append("response_format", "json");

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
    return (data.text || "").trim();
  }

  const SYSTEM_PROMPT = [
    "You turn a spoken bug/feedback report into structured fields for a ticket.",
    "Return ONLY a JSON object with exactly these keys:",
    '"type" (either "bug" or "feedback"),',
    '"title" (a short one-line summary),',
    '"whatHappened",',
    '"expectedBehavior",',
    '"stepsToReproduce" (an array of short step strings in order, WITHOUT numbering; [] if none),',
    '"severity" (one of "Low","Medium","High","Critical"),',
    '"notes" (anything extra, else "").',
    "Use information only from the transcript. If something isn't mentioned, use an empty",
    'string "" (for severity default to "Medium"). Do not invent details.',
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
      type: parsed.type === "feedback" ? "feedback" : "bug",
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
  globalThis.Wingman.groq = { transcribe, extractFields };
})();
