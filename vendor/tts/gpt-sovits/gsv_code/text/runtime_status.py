# -*- coding: utf-8 -*-
"""A status bit for every silent degradation in the text front end.

WHY THIS EXISTS

  Five places in this pipeline catch an exception, keep going with a worse
  result, and print one line to stdout:

    * g2pW cannot be imported          -> pypinyin, polyphones get worse
    * the g2pW model cannot be loaded   -> same
    * pron_correction cannot be imported -> the proofing overlay does nothing
    * a pypinyin override does not line up with the finals -> dropped
    * the segmenter returns text that is not what it was given -> characters lost

  Every one of them produces audio. None of them produces an error. The print
  goes into a subprocess log nobody opens, and by the time the symptom is
  noticed ("the reading got worse", "a comma disappeared") there is nothing
  left to look at. That is the shape of every one of these bugs: the failure is
  real, the report is not.

  This module is the report. It is deliberately tiny and dependency-free: it
  can be imported at the top of a module that has just failed to import
  something else.

WHAT IT IS NOT

  It is not logging. A log line is prose aimed at a person who is already
  looking. A status bit is a value a program can ask for afterwards -- which
  is what "was this synthesis degraded?" needs.

READING IT BACK

  In-process:            runtime_status.snapshot()
  From another process:  set TTS_STATUS_FILE to a path before starting; every
                         event is appended there as one JSON object per line.
  From a captured log:   every event is also written to stderr prefixed with
                         the MARKER below, so a parent process that only has
                         the child's output can still recover it.
"""
import json
import os
import sys
import threading

MARKER = "[[TTS-STATUS]]"

# Codes are part of the interface: tests and the Node side match on them, so
# they are ASCII, stable, and never reworded for style.
G2PW_IMPORT_FAILED = "g2pw_import_failed"
G2PW_MODEL_LOAD_FAILED = "g2pw_model_load_failed"
PRON_OVERLAY_UNAVAILABLE = "pron_overlay_unavailable"
PRON_OVERRIDE_LENGTH_MISMATCH = "pron_override_length_mismatch"
ORT_CUDA_DLL_DIR_FAILED = "ort_cuda_dll_dir_failed"
SEGMENT_TEXT_LOST = "segment_text_lost"
SEGMENT_UNALIGNABLE = "segment_unalignable"

_LOCK = threading.RLock()
_EVENTS = []
_INDEX = {}


def _emit(record):
    line = MARKER + " " + json.dumps(record, ensure_ascii=False, sort_keys=True)
    try:
        sys.stderr.write(line + "\n")
        sys.stderr.flush()
    except Exception:
        pass
    path = os.environ.get("TTS_STATUS_FILE")
    if path:
        try:
            with open(path, "a", encoding="utf-8") as fh:
                fh.write(line + "\n")
        except Exception:
            # A status recorder that can bring down synthesis would be worse
            # than the problem it reports.
            pass


def note(component, code, detail="", **fields):
    """Record one degradation. Repeats of the same (component, code) bump a
    counter rather than piling up: a per-word failure must not be able to write
    a hundred thousand lines."""
    key = (component, code)
    with _LOCK:
        rec = _INDEX.get(key)
        if rec is None:
            rec = {
                "component": component,
                "code": code,
                "detail": detail,
                "count": 0,
            }
            rec.update(fields)
            _INDEX[key] = rec
            _EVENTS.append(rec)
            rec["count"] = 1
            first = True
        else:
            rec["count"] += 1
            first = False
            for k, v in fields.items():
                rec.setdefault(k, v)
        out = dict(rec)
    # Only the first occurrence is emitted; the count is available from
    # snapshot(). Emitting every repeat is how a status channel becomes noise
    # and stops being read.
    if first:
        _emit(out)
    return out


def snapshot():
    """Every degradation recorded so far, in the order they first happened."""
    with _LOCK:
        return [dict(rec) for rec in _EVENTS]


def active(code=None):
    """True if anything was recorded, or if `code` in particular was."""
    with _LOCK:
        if code is None:
            return bool(_EVENTS)
        return any(rec["code"] == code for rec in _EVENTS)


def get(code):
    with _LOCK:
        for rec in _EVENTS:
            if rec["code"] == code:
                return dict(rec)
    return None


def clear():
    """For tests. Nothing in the engine calls this."""
    with _LOCK:
        del _EVENTS[:]
        _INDEX.clear()


def summary():
    """One line per degradation, for a human reading a console."""
    rows = snapshot()
    if not rows:
        return "no degradation recorded"
    out = []
    for rec in rows:
        times = "" if rec["count"] == 1 else " (x%d)" % rec["count"]
        out.append("%s/%s%s: %s" % (rec["component"], rec["code"], times, rec["detail"]))
    return "\n".join(out)
