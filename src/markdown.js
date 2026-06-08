// Deterministic Markdown generation for the Trello card title + description.
(function () {
  // Type marker shown as a leading emoji in the card title. Trello renders real Unicode
  // emoji in titles (but not :shortcode: syntax). "🐞 Cannot move aircraft into Hangar 2"
  const TYPE_EMOJI = { bug: "🐞", feedback: "♻️", feature: "💡" };
  function buildTitle(fields) {
    const emoji = TYPE_EMOJI[fields.type] || TYPE_EMOJI.bug;
    return `${emoji} ${fields.title || "Untitled"}`;
  }

  // Fall back to a placeholder so empty optional fields stay readable.
  function val(s) {
    const t = (s || "").trim();
    return t.length ? t : "_None provided._";
  }

  // captureKind is "screenshot" or "recording"; transcript is optional. videoCount is the
  // number of video files attached (the recording is split when it would exceed Trello's
  // size limit); defaults to 1.
  function buildDescription(fields, context, captureKind, transcript, videoCount) {
    const parts = videoCount || 1;
    const recordingNote =
      parts > 1
        ? `## Recording\n\nVideo attached in ${parts} parts (poster frame included).`
        : "## Recording\n\nVideo attached (poster frame included).";
    const media = captureKind === "recording" ? recordingNote : "## Screenshot\n\nAttached.";

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
