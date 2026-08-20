# -*- coding: utf-8 -*-
"""Pronunciation for hyphenated English words.

WHY

  qryword() in english.py is a five-step waterfall -- CMU dictionary, name
  dictionary, three letters or fewer read as letters, possessive, compound
  splitting, neural prediction -- and not one of the five steps knows what a
  hyphen is. So `re-run` never matches anything and ends up predicted, which
  answers R IY0 AO1 R N.

  The dictionary already knows the word. `RERUN  R IY1 R AH1 N` is entry
  100769 of cmudict.rep. Only the spelling with the hyphen is missing.

THE RULE, AND WHY THE ORDER MATTERS

  1. JOIN  -- delete the hyphens and look the word up.
  2. SPLIT -- cut at the hyphens and look each piece up.
  3. neither -- the caller falls back to prediction, on the joined spelling.

  Join has to come first, and `re-run` is exactly why: split gives
  `RE = R EY1`, the re of do-re-mi. Joining gives the word the dictionary
  actually has. Whenever both work, join is the one that is right.

WHY THIS CANNOT REGRESS EXISTING WORDS

  This runs after the dictionary lookup, not before it. cmudict.rep contains
  909 entries that are themselves spelled with a hyphen -- E-MAIL, X-RAY,
  T-SHIRT and so on -- and every one of them is answered by step one of the
  waterfall. Nothing here is ever reached for them.

  Measured against those 909 entries with their dictionary answers hidden:
  join answers 309 of them at 93.5% phoneme agreement, split answers a further
  550 at 78.4%, and 50 still fall through to prediction exactly as they do
  today. Nothing gets a worse answer than "predicted", because predicted is
  what all of them get today.

  Any word this still reads wrong can be nailed down with one line in
  engdict-hot.rep, which is consulted ahead of all of this.

  This module is kept separate from english.py on purpose: english.py imports
  nltk and wordsegment, so it cannot be loaded in a test environment, and a
  rule nobody can run a test against is a rule nobody can check.
"""

JOIN = "join"
SPLIT = "split"


def split_parts(word):
    """The pieces of a hyphenated word, empties removed.

    `-` on its own, leading and trailing hyphens and doubled hyphens all
    produce empty pieces; none of them is a word.
    """
    return [part for part in word.split("-") if part]


def joined(word):
    """The word with its hyphens deleted."""
    return word.replace("-", "")


def resolve(word, lookup):
    """Return ``(phones, how)`` for a hyphenated word, or ``(None, None)``.

    ``lookup(piece)`` returns a phone list for a spelling the dictionary knows,
    and a false value otherwise. ``how`` is JOIN or SPLIT and exists so the
    caller, and the tests, can tell which of the two answered.
    """
    if "-" not in word:
        return None, None

    flat = joined(word)
    if len(flat) > 1:
        phones = lookup(flat)
        if phones:
            return list(phones), JOIN

    parts = split_parts(word)
    if not parts:
        return None, None

    out = []
    for part in parts:
        phones = lookup(part)
        if not phones:
            return None, None
        out.extend(phones)
    return out, SPLIT
