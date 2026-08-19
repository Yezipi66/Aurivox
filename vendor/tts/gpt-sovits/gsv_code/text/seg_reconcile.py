# -*- coding: utf-8 -*-
"""Make the segmenter's output add back up to the text it was given.

WHY

  LangSegmenter.getTexts() splits a clause into (language, text) pieces. On the
  real detector three of twenty-eight probe samples came back with pieces that
  do not concatenate to the input:

    他今年25岁，身高178厘米。   ->  the comma is gone
    안녕하세요, 오늘 날씨가...   ->  the space after the comma is gone
    Wait... what? No way!       ->  the space after the question mark is gone

  A comma is a pause and a space is an English word boundary, so this changes
  the prosody -- and it does it without an error, without a log line, and
  without anything the user could proofread, because by then the text on screen
  and the text being read aloud are two different strings.

WHAT THIS DOES

  We know the input: the clause is ours, we split it. So the pieces can simply
  be checked against it. Missing runs are handed back to the neighbouring
  piece, and the concatenation is exact again.

WHAT THIS DELIBERATELY DOES NOT DO

  It does not touch language detection. A recovered comma joins the piece
  before it; a recovered leading space joins the piece before it too. Nothing
  is re-detected, no model runs, no heuristic is added. Which language a comma
  is "in" does not change how it is read; whether it is there at all does.
"""

#: Where a recovered run is attached. The run sits between two pieces; giving
#: it to the earlier one keeps punctuation with the clause it terminates.
ATTACH_LEFT = "left"


def reconcile(original, segments, on_status=None):
    """Return segments whose ``text`` fields concatenate to exactly ``original``.

    ``segments`` is a list of dicts with ``lang`` and ``text``.

    If a segment cannot be located in ``original`` at all -- meaning the
    segmenter rewrote text rather than dropped it, which this cannot repair --
    the input is returned unchanged and ``on_status`` is called with
    ``("unalignable", detail)``. That case is reported rather than guessed at.

    ``on_status`` is called as ``on_status(kind, detail)`` where kind is
    ``"recovered"`` (characters were put back) or ``"unalignable"``.
    """
    segments = [s for s in segments if s.get("text")]
    if not original:
        return segments
    if not segments:
        if on_status:
            on_status("recovered", {"dropped": original, "reason": "no segments"})
        return [{"lang": "", "text": original}]

    joined = "".join(s["text"] for s in segments)
    if joined == original:
        return segments

    out = []
    cursor = 0
    recovered = []
    for seg in segments:
        text = seg["text"]
        found = original.find(text, cursor)
        if found < 0:
            if on_status:
                on_status(
                    "unalignable",
                    {"clause": original, "segment": text, "at": cursor},
                )
            return segments
        if found > cursor:
            gap = original[cursor:found]
            recovered.append(gap)
            if out:
                out[-1]["text"] += gap
            else:
                # Nothing to the left yet, so the run leads the first piece.
                text = gap + text
        out.append({"lang": seg["lang"], "text": text})
        cursor = found + len(seg["text"])

    if cursor < len(original):
        tail = original[cursor:]
        recovered.append(tail)
        out[-1]["text"] += tail

    if on_status and recovered:
        on_status(
            "recovered",
            {"clause": original, "restored": recovered},
        )
    return out


def is_lossless(original, segments):
    """True when the segments already add up. Used by the guard tests."""
    return "".join(s.get("text", "") for s in segments) == original
