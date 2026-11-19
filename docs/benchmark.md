# The benchmark behind rag-first

Round 2 of the owner's RAG benchmark, run 2026-11-19/20. rag-first is the productised version of its arm F,
"B-forced". The harness itself (Python runners, answer keys, grader) is not part of this repository; this page
records its method and results so the README's numbers can be checked against something.

## Setup

- **Repository:** antares, Go + web, about 1,050 files indexed in both RAG stores. Read-only for the whole run
  (HEAD and the diff hash of its 7 uncommitted paths were identical at start and end).
- **Model:** Sonnet 5.5, medium effort, for every arm. No edits, no subagents (write tools denied).
- **Questions:** 12, written to be vague and cross-file, with few identifiers: 4 "where", 4 "flow",
  2 "identifier/usage", 2 "change plan". Each answer key was verified with file:line before any run. Topics
  covered by enowx-rag's saved notes, the dirty files and the 289k-character generated JSON chunk were avoided.
- **Grading:** blind, 0/1/2 per answer; the grader (Sonnet, low effort) saw the question, the key and the answer,
  never the arm. All 7 non-2 grades were checked by hand against their keys.

## Arms

| arm | what |
|---|---|
| A | plain Claude Code: no CLAUDE.md, no MCP |
| B | enowx-rag MCP as installed (tools deferred behind ToolSearch) + the user CLAUDE.md rule "use RAG first" |
| F | B + a gate: a `PreToolUse` hook denies Grep, Glob, Read and Bash until one enowx-rag search has run for the current prompt (`UserPromptSubmit` resets, `PostToolUse` on the two search tools marks it); MCP schemas loaded up front with `--tools Read,Grep,Glob,Bash` |
| C | an enowX session: its `UserPromptSubmit` hook injects RAG parts, and `rag search` is available |

Two modes: (i) a fresh session per question; (ii) one long session per arm answering all 12 in order.

## Results, fresh sessions (mode i)

| arm | score | cost (12 Q) | total tokens / Q mean (median) | wall s / Q | tool calls / Q | RAG calls / Q | greps / Q | files read / Q |
|---|---|---|---|---|---|---|---|---|
| A | 23/24 | $1.75 | 217,578 (219,052) | 30.5 | 10.0 | 0.00 | 5.9 | 3.2 |
| B | 23/24 | $1.88 | 205,750 (164,680) | 27.6 | 9.4 | 0.00 | 5.3 | 3.3 |
| F | 24/24 | $1.32 | 89,440 (93,436) | 23.8 | 6.8 | 1.83 | 2.8 | 2.0 |
| C | 22/24 | $1.90 (+$1.47 rule turns) | 259,792 (249,532) | 31.2 | 4.2 | 0.00 | 2.6 | 3.2 |

F against A: −59% tokens, −25% dollars, −22% wall time, same or better score. A typical F sequence:
`rag_project_exists → Grep (denied) → rag_retrieve_context → Grep → Read → Read` (6 calls, 94k tokens, $0.10),
against A's `Grep, Bash×2, Read×2, Bash×4` (9 calls, 308k tokens, $0.18) on the same question. The gate logged
8 denials over the 12 questions: most runs went to RAG on their own after the first deny reason.

## Results, one long session (mode ii)

| arm | score | cost (12 Q) | tool calls / Q |
|---|---|---|---|
| A | 23/24 | $2.00 | 10.5 |
| B | 24/24 | $1.89 | 10.2 |
| F | 23/24 | $1.96 | 5.4 |
| C | 23/24 | $2.05 | 7.2 |

Each question re-reads the growing conversation (0.1–0.2M cached tokens at the first question, 0.76–1.56M at
the last), so the gate's saving in turns no longer shows in dollars.

## Retrieval only (k = 5, bare question as the query)

| retriever | mean recall@5 of key files | questions with ≥ 1 key file | ≈ tokens returned |
|---|---|---|---|
| enowX `rag search` | 0.36 | 11/12 | 1,045 |
| enowx-rag `rag_semantic_search` | 0.37 | 10/12 | 2,074 |
| enowx-rag `rag_retrieve_context` | 0.37 | 10/12 | 3,618 |

Retrieval is modest; the saving doesn't come from perfect hits but from replacing a grep hunt with one
retrieval call and then reading narrowly. F read fewer files (2.0 per question, 41% of the key files, against
A's 3.2 and 51%) and still scored highest: excerpts often carry enough code to answer.

## What remained unfair or uncertain

- **F's tool list was narrower** (`--tools Read,Grep,Glob,Bash`, no ToolSearch, WebFetch, …), which shrank each
  turn a little (first-request cache write ~20k vs ~25k). Part of F's saving is that; fewer turns explain most
  of it. rag-first does not narrow the tool list: it pins only the two search tools (see the README).
- **B's rule was ignored entirely**: 0 RAG calls in 24 runs. A soft instruction did not change behaviour; only
  the hard gate did. rag-first's nudge mode reproduced this in a real run (three reminders, no search).
- **Single run per cell.** With scores near the ceiling, a one-point difference is within grader noise; the
  token and cost differences are large and consistent across questions.
- **Answer keys** were written by the benchmark's author after reading the code, before any run.
- **Long-mode question order** was fixed and the same for every arm.
- **C's harness differs by construction** (rule as a first chat message; cost estimated from transcript usage
  with a price fit that matched `claude -p` exactly on fresh runs).

Spend: $16.53 for the runs + $1.18 grading.
