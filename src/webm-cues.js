// Builds a seek index (SeekHead + Cues) into a MediaRecorder webm so players can scrub it.
//
// MediaRecorder writes clusters with an unknown size and never writes Cues, so a player has
// no way to turn a scrub-bar position into a byte offset — it gives up and snaps back to the
// start. fixWebmDuration() (webm-duration.js) adds the Duration, which makes the scrub bar
// appear with the right length, but it also collapses every cluster into one section with a
// bogus size spanning to EOF, because Cluster is deliberately left out of its element table.
// This pass runs after it and rebuilds the whole Segment: real cluster extents, explicit
// cluster sizes, and a Cues index pointing at each video keyframe.
//
// Layout produced (Cues up front, so a player streaming over HTTP finds the index in the
// first few KB instead of range-requesting the tail):
//
//   EBML | Segment(size=fixed 8B) | SeekHead | Info | Tracks | Cues | Cluster1..N
//
// SeekPosition/CueClusterPosition are relative to the Segment's *data* start. Both are
// written as fixed-width 8-byte uints, which keeps SeekHead and Cues a constant size no
// matter what offsets land in them — so the layout resolves in one pass with no iteration.
(function () {
  // Level-1 IDs, marker bits included (webm-duration.js strips them; we do not).
  const EBML_HEADER = 0x1a45dfa3;
  const SEGMENT = 0x18538067;
  const SEEK_HEAD = 0x114d9b74;
  const INFO = 0x1549a966;
  const TRACKS = 0x1654ae6b;
  const CUES = 0x1c53bb6b;
  const CLUSTER = 0x1f43b675;
  const ATTACHMENTS = 0x1941a469;
  const CHAPTERS = 0x1043a770;
  const TAGS = 0x1254c367;

  const LEVEL1 = new Set([
    EBML_HEADER, SEGMENT, SEEK_HEAD, INFO, TRACKS, CUES, CLUSTER, ATTACHMENTS, CHAPTERS, TAGS,
  ]);

  // Cluster children. Anything else means we've walked off the end of the cluster.
  const TIMECODE = 0xe7;
  const SIMPLE_BLOCK = 0xa3;
  const BLOCK_GROUP = 0xa0;
  const BLOCK = 0xa1;
  const REFERENCE_BLOCK = 0xfb;
  const CLUSTER_CHILDREN = new Set([TIMECODE, SIMPLE_BLOCK, BLOCK_GROUP, 0xa7, 0xab, 0x5854, 0xaf]);

  const TRACK_ENTRY = 0xae;
  const TRACK_NUMBER = 0xd7;
  const TRACK_TYPE = 0x83;
  const TRACK_TYPE_VIDEO = 1;

  const SEEK = 0x4dbb;
  const SEEK_ID = 0x53ab;
  const SEEK_POSITION = 0x53ac;
  const CUE_POINT = 0xbb;
  const CUE_TIME = 0xb3;
  const CUE_TRACK_POSITIONS = 0xb7;
  const CUE_TRACK = 0xf7;
  const CUE_CLUSTER_POSITION = 0xf1;

  const POS_WIDTH = 8; // fixed width for every layout-dependent position field

  // ---- EBML primitives ----

  // Element IDs keep their marker bits. Width comes from the leading zero count of byte 0.
  function readId(buf, pos) {
    const first = buf[pos];
    if (first === undefined || first === 0) return null;
    let len;
    if (first & 0x80) len = 1;
    else if (first & 0x40) len = 2;
    else if (first & 0x20) len = 3;
    else if (first & 0x10) len = 4;
    else return null;
    if (pos + len > buf.length) return null;
    let id = 0;
    for (let i = 0; i < len; i++) id = id * 256 + buf[pos + i];
    return { id, len };
  }

  // Sizes strip the marker. "Unknown" is every value bit set — track it with a flag rather
  // than comparing numbers: the 8-byte unknown size is 2^56-1, which rounds to 2^56 in a JS
  // double and would never compare equal.
  function readSize(buf, pos) {
    const first = buf[pos];
    if (first === undefined || first === 0) return null;
    let len = 1;
    let mask = 0x80;
    while (len <= 8 && !(first & mask)) {
      mask >>= 1;
      len++;
    }
    if (len > 8 || pos + len > buf.length) return null;
    const top = 0xff >> len;
    let value = first & top;
    let unknown = value === top;
    for (let i = 1; i < len; i++) {
      const b = buf[pos + i];
      if (b !== 0xff) unknown = false;
      value = value * 256 + b;
    }
    return { value, len, unknown };
  }

  function readUintBE(buf, pos, len) {
    let v = 0;
    for (let i = 0; i < len; i++) v = v * 256 + buf[pos + i];
    return v;
  }

  function idToBytes(id) {
    const bytes = [];
    let v = id;
    while (v > 0) {
      bytes.unshift(v % 256);
      v = Math.floor(v / 256);
    }
    return Uint8Array.from(bytes);
  }

  // Minimal width that can hold `value` without hitting the all-ones reserved pattern.
  // (The vendored writeUint in webm-duration.js gets this wrong: 127 encodes to 0xff, which
  // is the unknown-size marker, not the number 127.)
  function sizeWidth(value) {
    for (let len = 1; len <= 8; len++) {
      if (value <= Math.pow(2, 7 * len) - 2) return len;
    }
    throw new Error("webm-cues: element too large to size");
  }

  function encodeSize(value, forceLen) {
    const len = forceLen || sizeWidth(value);
    const out = new Uint8Array(len);
    let v = value;
    for (let i = len - 1; i >= 0; i--) {
      out[i] = v % 256;
      v = Math.floor(v / 256);
    }
    out[0] |= 0x80 >> (len - 1);
    return out;
  }

  function uintToBytes(value) {
    if (value === 0) return new Uint8Array([0]);
    const bytes = [];
    let v = value;
    while (v > 0) {
      bytes.unshift(v % 256);
      v = Math.floor(v / 256);
    }
    return Uint8Array.from(bytes);
  }

  function uintFixed(value, len) {
    const out = new Uint8Array(len);
    let v = value;
    for (let i = len - 1; i >= 0; i--) {
      out[i] = v % 256;
      v = Math.floor(v / 256);
    }
    return out;
  }

  function concat(parts) {
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }

  // Build a complete element: id + size + payload.
  function element(id, payload) {
    const body = payload instanceof Uint8Array ? payload : concat(payload);
    return concat([idToBytes(id), encodeSize(body.length), body]);
  }

  // ---- parsing ----

  // A SimpleBlock is: track vint, int16 BE relative timecode, flags. Keyframe is flags & 0x80.
  // The track filter is essential — Opus audio blocks always set the keyframe bit, so without
  // it every cluster looks like a keyframe.
  function blockIsVideoKeyframe(buf, start, end, videoTrack) {
    const track = readSize(buf, start);
    if (!track || track.value !== videoTrack) return false;
    const flagsAt = start + track.len + 2;
    if (flagsAt >= end) return false;
    return (buf[flagsAt] & 0x80) !== 0;
  }

  // Chrome only emits SimpleBlock, but handle BlockGroup defensively: a keyframe is a Block
  // with no ReferenceBlock alongside it.
  function blockGroupIsVideoKeyframe(buf, start, end, videoTrack) {
    let p = start;
    let isVideo = false;
    let hasReference = false;
    while (p < end) {
      const id = readId(buf, p);
      if (!id) break;
      const size = readSize(buf, p + id.len);
      if (!size || size.unknown) break;
      const dataStart = p + id.len + size.len;
      const dataEnd = dataStart + size.value;
      if (dataEnd > end) break;
      if (id.id === BLOCK) {
        const track = readSize(buf, dataStart);
        if (track && track.value === videoTrack) isVideo = true;
      } else if (id.id === REFERENCE_BLOCK) {
        hasReference = true;
      }
      p = dataEnd;
    }
    return isVideo && !hasReference;
  }

  // Walk a cluster's children to find where it really ends. The declared size is never
  // trusted — fixWebmDuration leaves cluster #1 claiming to span the whole file.
  function scanCluster(buf, dataStart, limit, videoTrack) {
    let p = dataStart;
    let timecode = null;
    let keyframe = false;
    while (p < limit) {
      const id = readId(buf, p);
      if (!id) break;
      if (LEVEL1.has(id.id) || !CLUSTER_CHILDREN.has(id.id)) break;
      const size = readSize(buf, p + id.len);
      if (!size || size.unknown) break;
      const dataEnd = p + id.len + size.len + size.value;
      if (dataEnd > limit) break;
      const childStart = p + id.len + size.len;
      if (id.id === TIMECODE) {
        timecode = readUintBE(buf, childStart, size.value);
      } else if (!keyframe && id.id === SIMPLE_BLOCK) {
        if (blockIsVideoKeyframe(buf, childStart, dataEnd, videoTrack)) keyframe = true;
      } else if (!keyframe && id.id === BLOCK_GROUP) {
        if (blockGroupIsVideoKeyframe(buf, childStart, dataEnd, videoTrack)) keyframe = true;
      }
      p = dataEnd;
    }
    return { dataEnd: p, timecode, keyframe };
  }

  function findVideoTrack(buf, start, end) {
    let p = start;
    while (p < end) {
      const id = readId(buf, p);
      if (!id) return null;
      const size = readSize(buf, p + id.len);
      if (!size || size.unknown) return null;
      const dataStart = p + id.len + size.len;
      const dataEnd = dataStart + size.value;
      if (id.id === TRACK_ENTRY) {
        let q = dataStart;
        let number = null;
        let type = null;
        while (q < dataEnd) {
          const cid = readId(buf, q);
          if (!cid) break;
          const csize = readSize(buf, q + cid.len);
          if (!csize || csize.unknown) break;
          const cStart = q + cid.len + csize.len;
          if (cid.id === TRACK_NUMBER) number = readUintBE(buf, cStart, csize.value);
          else if (cid.id === TRACK_TYPE) type = readUintBE(buf, cStart, csize.value);
          q = cStart + csize.value;
        }
        if (type === TRACK_TYPE_VIDEO && number !== null) return number;
      }
      p = dataEnd;
    }
    return null;
  }

  // Parse the file into: the EBML header, the Segment's non-cluster children, and the real
  // cluster extents. videoTrack is needed up front to classify keyframes during the scan, so
  // this runs in two phases.
  function parse(buf) {
    let pos = 0;
    let ebmlEnd = 0;
    let segment = null;

    while (pos < buf.length) {
      const id = readId(buf, pos);
      if (!id) return null;
      const size = readSize(buf, pos + id.len);
      if (!size) return null;
      const dataStart = pos + id.len + size.len;
      if (id.id === EBML_HEADER) {
        if (size.unknown) return null;
        ebmlEnd = dataStart + size.value;
        pos = ebmlEnd;
      } else if (id.id === SEGMENT) {
        const dataEnd = size.unknown
          ? buf.length
          : Math.min(dataStart + size.value, buf.length);
        segment = { dataStart, dataEnd };
        break;
      } else {
        return null;
      }
    }
    if (!segment || ebmlEnd === 0) return null;

    // Phase 1: locate Info/Tracks so we can resolve the video track number.
    const children = [];
    let p = segment.dataStart;
    let firstCluster = -1;
    while (p < segment.dataEnd) {
      const id = readId(buf, p);
      if (!id) return null;
      const size = readSize(buf, p + id.len);
      if (!size) return null;
      const dataStart = p + id.len + size.len;
      if (id.id === CLUSTER) {
        firstCluster = p;
        break;
      }
      if (size.unknown) return null;
      const dataEnd = Math.min(dataStart + size.value, segment.dataEnd);
      children.push({ id: id.id, start: p, dataStart, dataEnd });
      p = dataEnd;
    }
    if (firstCluster < 0) return null;

    const tracks = children.find((c) => c.id === TRACKS);
    if (!tracks) return null;
    const videoTrack = findVideoTrack(buf, tracks.dataStart, tracks.dataEnd);
    if (videoTrack === null) return null;

    // Phase 2: walk the clusters, ignoring their declared sizes.
    const clusters = [];
    p = firstCluster;
    while (p < segment.dataEnd) {
      const id = readId(buf, p);
      if (!id) break;
      if (id.id !== CLUSTER) break;
      const size = readSize(buf, p + id.len);
      if (!size) break;
      const dataStart = p + id.len + size.len;
      const scan = scanCluster(buf, dataStart, segment.dataEnd, videoTrack);
      if (scan.dataEnd <= dataStart) break;
      clusters.push({ dataStart, dataEnd: scan.dataEnd, timecode: scan.timecode, keyframe: scan.keyframe });
      p = scan.dataEnd;
    }

    return { ebmlEnd, segment, children, clusters, videoTrack, scannedTo: p };
  }

  // ---- building ----

  function buildSeekHead(infoPos, tracksPos, cuesPos) {
    const entry = (targetId, pos) =>
      element(SEEK, [
        element(SEEK_ID, idToBytes(targetId)),
        element(SEEK_POSITION, uintFixed(pos, POS_WIDTH)),
      ]);
    return element(SEEK_HEAD, [
      entry(INFO, infoPos),
      entry(TRACKS, tracksPos),
      entry(CUES, cuesPos),
    ]);
  }

  // positions[] is relative to Segment data start. CueClusterPosition is fixed-width, so the
  // byte length of this element does not depend on the values — which is what lets us measure
  // the layout before we know where anything lands.
  function buildCues(cuePoints, videoTrack, positions) {
    const points = cuePoints.map((c, i) =>
      element(CUE_POINT, [
        element(CUE_TIME, uintToBytes(c.timecode)),
        element(CUE_TRACK_POSITIONS, [
          element(CUE_TRACK, uintToBytes(videoTrack)),
          element(CUE_CLUSTER_POSITION, uintFixed(positions[i], POS_WIDTH)),
        ]),
      ])
    );
    return element(CUES, points);
  }

  function build(buf, tree) {
    const { ebmlEnd, children, clusters, videoTrack } = tree;

    const info = children.find((c) => c.id === INFO);
    const tracks = children.find((c) => c.id === TRACKS);
    if (!info || !tracks) return null;

    const cuePoints = clusters.filter((c) => c.keyframe && c.timecode !== null);
    if (!cuePoints.length) return null;

    const infoLen = info.dataEnd - info.start;
    const tracksLen = tracks.dataEnd - tracks.start;

    // Measure Cues with placeholder positions; fixed-width fields make this exact.
    const cuesLen = buildCues(cuePoints, videoTrack, cuePoints.map(() => 0)).length;

    const seekHeadLen = buildSeekHead(0, 0, 0).length;
    const infoPos = seekHeadLen;
    const tracksPos = infoPos + infoLen;
    const cuesPos = tracksPos + tracksLen;

    const clusterIdBytes = idToBytes(CLUSTER);
    const clusterHeaderLen = clusterIdBytes.length + POS_WIDTH;

    // Cluster positions, relative to Segment data start.
    let at = cuesPos + cuesLen;
    const clusterPos = [];
    for (const c of clusters) {
      clusterPos.push(at);
      at += clusterHeaderLen + (c.dataEnd - c.dataStart);
    }
    const segContentLen = at;

    const positions = cuePoints.map((c) => clusterPos[clusters.indexOf(c)]);
    const cues = buildCues(cuePoints, videoTrack, positions);
    if (cues.length !== cuesLen) throw new Error("webm-cues: cues length drifted");

    const seekHead = buildSeekHead(infoPos, tracksPos, cuesPos);
    if (seekHead.length !== seekHeadLen) throw new Error("webm-cues: seekhead length drifted");

    const parts = [
      buf.subarray(0, ebmlEnd),
      idToBytes(SEGMENT),
      encodeSize(segContentLen, POS_WIDTH),
      seekHead,
      buf.subarray(info.start, info.dataEnd),
      buf.subarray(tracks.start, tracks.dataEnd),
      cues,
    ];
    for (const c of clusters) {
      parts.push(clusterIdBytes);
      parts.push(encodeSize(c.dataEnd - c.dataStart, POS_WIDTH));
      parts.push(buf.subarray(c.dataStart, c.dataEnd));
    }
    return { parts, cuePoints, positions, clusterCount: clusters.length };
  }

  // ---- validation ----

  // Re-parse our own output and prove the index points at real clusters. The scan is only a
  // couple of milliseconds, so there's no reason to ship an index we haven't checked.
  function validate(out, expected) {
    const tree = parse(out);
    if (!tree) throw new Error("webm-cues: output does not re-parse");
    if (tree.clusters.length !== expected.clusterCount) {
      throw new Error("webm-cues: cluster count changed");
    }
    if (tree.scannedTo !== out.length) throw new Error("webm-cues: output has trailing bytes");
    if (!tree.children.some((c) => c.id === CUES)) throw new Error("webm-cues: cues missing");
    if (!tree.children.some((c) => c.id === SEEK_HEAD)) throw new Error("webm-cues: seekhead missing");

    for (const pos of expected.positions) {
      const at = tree.segment.dataStart + pos;
      const id = readId(out, at);
      if (!id || id.id !== CLUSTER) {
        throw new Error("webm-cues: cue position " + pos + " does not land on a cluster");
      }
    }
    let last = -1;
    for (const c of expected.cuePoints) {
      if (c.timecode <= last) throw new Error("webm-cues: cue times not increasing");
      last = c.timecode;
    }
  }

  // ---- public ----

  // Returns a seekable copy of `blob`, or `blob` untouched if there's nothing safe to do.
  async function addWebmCues(blob) {
    const buf = new Uint8Array(await blob.arrayBuffer());
    const tree = parse(buf);
    if (!tree) return blob;
    if (!tree.clusters.length) return blob;
    if (tree.children.some((c) => c.id === CUES)) return blob; // already indexed

    const built = build(buf, tree);
    if (!built) return blob;

    const out = concat(built.parts);
    validate(out, built);
    return new Blob([out], { type: blob.type || "video/webm" });
  }

  globalThis.Wingman = globalThis.Wingman || {};
  globalThis.Wingman.addWebmCues = addWebmCues;

  // Duration first (the scrub bar needs a length), then the index (so dragging it works).
  // Each step falls back to its input, so a failure downgrades rather than losing the file.
  globalThis.Wingman.fixWebmDurationAndCues = async function (blob, durationMs) {
    let out = blob;
    try {
      out = await globalThis.Wingman.fixWebmDuration(out, durationMs);
    } catch (e) {
      /* keep the unpatched blob — it plays, it just has no duration */
    }
    try {
      out = await addWebmCues(out);
    } catch (e) {
      /* keep the duration-patched blob — it plays, it just won't seek */
    }
    return out;
  };
})();
