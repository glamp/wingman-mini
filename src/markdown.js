// Deterministic Markdown generation for the Trello card title + description.
(function () {
  // "[Bug] Cannot move aircraft into Hangar 2"
  function buildTitle(fields) {
    const type = fields.type === "feedback" ? "Feedback" : "Bug";
    return `[${type}] ${fields.title || "Untitled"}`;
  }

  // Fall back to a placeholder so empty optional fields stay readable.
  function val(s) {
    const t = (s || "").trim();
    return t.length ? t : "_None provided._";
  }

  // captureKind is "screenshot" or "recording"; transcript is optional.
  function buildDescription(fields, context, captureKind, transcript) {
    const media =
      captureKind === "recording"
        ? "## Recording\n\nVideo attached (poster frame included)."
        : "## Screenshot\n\nAttached.";

    const transcriptSection = (transcript || "").trim()
      ? ["## Transcript", "", transcript.trim(), ""]
      : [];

    return [
      "## Summary",
      "",
      val(fields.title),
      "",
      "## What Happened",
      "",
      val(fields.whatHappened),
      "",
      "## Expected Behavior",
      "",
      val(fields.expectedBehavior),
      "",
      "## Steps to Reproduce",
      "",
      val(fields.stepsToReproduce),
      "",
      "## Severity",
      "",
      val(fields.severity),
      "",
      "## Notes",
      "",
      val(fields.notes),
      "",
      ...transcriptSection,
      "## Context",
      "",
      `- URL: ${context.url}`,
      `- Page Title: ${context.pageTitle}`,
      `- Browser: ${context.userAgent}`,
      `- Viewport: ${context.viewportWidth}x${context.viewportHeight}`,
      `- Timestamp: ${context.timestamp}`,
      `- Reporter: ${val(context.reporterName)}`,
      "",
      media,
      "",
    ].join("\n");
  }

  globalThis.Wingman = globalThis.Wingman || {};
  globalThis.Wingman.markdown = { buildTitle, buildDescription };
})();
