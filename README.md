# rag-first

A Claude Code plugin that makes the model **search the project's RAG before it greps or reads around**.
In a project indexed in [enowx-rag](#requirements), `Grep`, `Glob`, `Read` and search-like `Bash` commands
(`rg`, `grep`, `find`, `git grep`, `cat`, `sed -n`, `head`, `tail`, …) are denied, with a reason that names the
exact enowx-rag tool and `project_id` to call, until one RAG search has run for the current prompt. After that
search, everything is allowed for the rest of the prompt.

Why: in a 12-question benchmark on a ~1,050-file Go + web repo, forcing one RAG search per question cut tokens
by **59%** and cost by **25%** per fresh question, with no loss of accuracy (24/24 against 23/24). Left to
choose, with the rule only written in `CLAUDE.md`, the model made **0** RAG calls in 24 runs. Details in
[Benchmark](#benchmark).

It needs nothing besides Claude Code and Node. No Python, no network calls of its own.

## What it does

Everything ships in `hooks/hooks.json`:

| hook | when | what |
|---|---|---|
| `UserPromptSubmit` | each prompt | resets the session's state: a new question needs a new search. Notes paths the prompt names. |
| `PreToolUse` on `Grep\|Glob\|Read\|Bash` | before each call | until searched: **deny** with a reason (strict) or add a reminder (nudge). `Bash` only when the command searches or reads files. |
| `PostToolUse` on `mcp__enowx-rag__rag_semantic_search\|rag_retrieve_context` | after a search | marks the prompt as searched: the gate opens. |
| `PostToolUse` on `Write\|Edit\|MultiEdit\|NotebookEdit` | after a write | remembers the file, so reading it back is never held. |
| `PreToolUse` on the two search tools | before a search | notes the attempt (see [loop guard and fail-open](#the-loop-guard-and-fail-open)); with `allowSearchTools`, approves it. |
| `PermissionDenied`, `PostToolUseFailure` on the two search tools | a search refused or failed | opens the gate for the rest of the prompt. |
| hooks module `hooks/register.ts`, `tool.describe` | session start | **loads the two search tools up front** instead of behind ToolSearch (see [Tool loading](#tool-loading-pinning-the-two-search-tools)). |

The deny reason the model sees:

> rag-first: search this project's RAG before using Bash to look around. Call
> mcp__enowx-rag__rag_retrieve_context (or mcp__enowx-rag__rag_semantic_search) with project_id "antares" and a
> query describing what you are looking for. If that tool isn't loaded yet, load it with ToolSearch (query
> "select:mcp__enowx-rag__rag_retrieve_context,mcp__enowx-rag__rag_semantic_search"). After one RAG search, Grep,
> Glob, Read and Bash are allowed for the rest of this prompt: use them for exact identifiers and to read the files
> and lines RAG pointed to.

**The gate never says "allow"** for a gated tool. It denies, or stays silent; your permission rules and prompts
apply as always. (The one exception is opt-in: `allowSearchTools` approves the two read-only search tools.)

### Which Bash commands are held

Only a command that starts a pipeline and searches or reads files: `rg`, `grep`, `egrep`, `fgrep`, `ag`, `ack`,
`fd`, `find`, `git grep`, `cat`, `head`, `tail`, `bat`, `less`, `more`, and `sed` with `-n` (not `-i`). Each
part of `a; b && c || d` counts. Not held:

- a filter after a pipe: `npm test 2>&1 | tail -30`, `git log | grep fix`, `cat <<'EOF' | node`;
- anything else: `ls`, `git status`, `go test`, `npm run build`, …;
- a reader that writes its output to a file: `cat a > b`; heredoc bodies are data, not commands;
- a command whose paths all lie outside the project: `tail -f /tmp/server.log`, `cat ~/.zshrc`.

`cd dir && rg x` and `git -C dir grep x` are resolved against `dir`. In the real runs here (Claude Code 2.1.328) the
session had **no** `Grep` or `Glob` tool: the model searches with `grep`/`rg` through `Bash`, so this is the part that
does most of the work.

### When the gate is off

The gate allows everything (silently, or with one short note per session) when:

| condition | how it is detected | note shown |
|---|---|---|
| `mode` is `"off"` | config | none |
| inside an enowX session | `ENOWX_SESSION` is set (enowX has its own RAG and injects it) | none |
| not a code project | cwd is `~`, `~/Desktop`, `~/Downloads` or `~/Documents`, or has no git root | none |
| the project isn't indexed and `indexNew` is `false` (or enowx-rag isn't in the session) | no folder in `~/.enowx-rag/project_dirs.json` (or in config `projects`) holds the cwd | `🔎 rag-first off here: project not indexed in enowx-rag (would be project_id "x")` |
| enowx-rag isn't in this session | the session's own transcript records its tools (see below); without a transcript, `~/.claude.json` and `.mcp.json` | logged, not shown |
| any error in the hook | `try`/`catch` around everything; the process always exits 0 and prints nothing | logged as `error` |

### A project that isn't indexed yet (`indexNew`, on by default)

A git project that no folder in `~/.enowx-rag/project_dirs.json` holds is not left alone: a brand-new project is
the one most likely to be forgotten, since there is no code to search at first and nothing asks again later.
While enowx-rag is in the session:

- **Every prompt** adds a line to the model's context: call `rag_index_project` with project_id `"x"` and the
  git root as directory, now, even if the folder holds little code yet (and the `<parent>-<folder>` id if `x`
  belongs to another folder). The user sees `🔎 rag-first: project not indexed in enowx-rag yet · asked Claude to
  index it as "x"` once per session.
- **Grep, Glob, Read and search-like Bash are held** (same exemptions, loop guard and nudge mode as the search
  gate) until `rag_index_project` succeeds. A RAG search does not count here: the project is empty.
- **After indexing**, `project_dirs.json` lists the folder and the normal search gate takes over.
- **Fail-open:** a refused, failed or unfinished `rag_index_project` lets the tools through for the rest of the
  prompt, and the hooks module pins `rag_index_project` alongside the search tools so it is one call away.

Set `"indexNew": false` to go back to the old behaviour: off, with one note per session.

**Project id.** The id is the one of the enowx-rag project whose recorded folder holds the cwd (the longest match,
so a monorepo sub-project wins), read from `~/.enowx-rag/project_dirs.json`, which `rag_index_project` writes. That
is the id the deny reason names, so it is always one that exists. For the "not indexed" note the plugin shows the
id the `~/.claude/CLAUDE.md` rule would give: the lowercased git-root folder name (spaces as `-`), or
`<parent>-<folder>` when that name is taken.

**Is enowx-rag in the session?** Claude Code writes `deferred_tools_delta` (tools behind ToolSearch) and
`mcp_instructions_delta` (MCP servers with instructions) records into the session transcript before the first
model request. The hook reads them from `transcript_path` (incrementally; a positive answer is cached for the
session). The hooks module also records it when it sees the server's tools. With `--no-session-persistence` there
is no transcript, and the hook falls back to the config files: user and local scope in `~/.claude.json`, project
scope in `<project>/.mcp.json`.

### Exemptions: calls that are never held

| exemption | config key |
|---|---|
| `Read` / `Grep` / `Glob` / `Bash` targets outside the indexed project folder (`/tmp`, `~/.claude`, other repos) | `exemptOutsideProject` |
| a file the user named in the prompt: a path that exists (`internal/agent/compact.go`, `@src/x.ts`, `~/notes.md`), or a bare file name with an extension (`compact.go` matches any `compact.go`) | `exemptPromptFiles` |
| a file the model wrote or edited in this session (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`) | `exemptWrittenFiles` |
| `Read` of images, PDFs, archives, fonts, media | `exemptNonText` |

Files you attach with `@` are read by Claude Code itself, not through `Read`, so they never reach the gate.

### The loop guard and fail-open

- **Loop guard.** After `maxDenials` denials (default 3) in one prompt, the next gated calls go through,
  logged as `let-through`, with one line: `🔎 rag-first: let Grep through after 3 denials without a RAG search (loop guard)`.
- **A search that can't run.** If the model calls a RAG search and it never completes (refused by permissions,
  the server down, an error), the next gated call goes through for the rest of the prompt
  (`search-failed`, then `let-through`). This matters in headless runs in `default` mode, where an MCP tool that
  isn't allowed is refused without a prompt (see the real runs below). `PermissionDenied` and
  `PostToolUseFailure` hooks do the same if Claude Code raises them for the search (unit-tested; in the real
  headless runs the refusal raised neither, which is why the attempt itself is tracked).
- Every path exits 0. Bad JSON, a missing file, a broken config: the call is allowed and the error logged.

## Tool loading: pinning the two search tools

By default Claude Code puts MCP tools behind ToolSearch: the model sees only their names and must call
ToolSearch to load a schema before it can use one. The benchmark loaded the schemas up front with
`--tools Read,Grep,Glob,Bash`, which works but **removes every other built-in tool** (ToolSearch, WebFetch,
Agent, …). `ENABLE_TOOL_SEARCH=false` also works but loads every deferred tool (47k tokens on the first request
in the benchmark's probe, against 12k).

The plugin does neither. Its hooks module answers Claude Code's `tool.describe` event for
`mcp__enowx-rag__rag_retrieve_context` and `mcp__enowx-rag__rag_semantic_search` with `isDeferred: false`, which
puts just those two schemas in the prompt and leaves every other tool where it was. It does this only when the
gate is on for the folder and `pinTools` is true; elsewhere the tools stay deferred.

Measured in two otherwise identical real runs (bypassPermissions, the same prompt): pinned, the model called
`rag_retrieve_context` directly, with schema-only parameters (`recall`, `hybrid`, `rerank`), and made **0**
ToolSearch calls; with `pinTools: false` it made **1** ToolSearch call first (one extra turn). The two
schemas add their size to every request (not measured separately). It needs Claude Code with hook modules (2.1.328 has them); on a
version without them the module doesn't load, the gate still works, and the deny reason tells the model how to
load the tool.

## Permission modes and auto mode

model-judge had a real problem in auto mode: a `PreToolUse` hook that rewrote the call (`updatedInput`) voided
auto mode's review, and the call was refused. rag-first never rewrites a call: it denies or stays silent. A
denied call ends at the hook (no auto-mode refusal appeared in any run), and the RAG search and the later
calls are reviewed as the model wrote them.

Verified with real headless runs (`test/real-run.sh`, Sonnet, effort low) on antares (the benchmark repo)
(read-only: write tools denied; HEAD and diff hash unchanged afterwards), with the prompt *"How does the agent
decide when to compact its conversation history? Start by running grep for "compact" yourself before anything
else…"*. Lines from the gate's log:

| mode | gate log | outcome |
|---|---|---|
| default | `reset` · `pin` · `deny Bash grep -rniI "compact"…` · `search-failed` · `let-through` ×2 | the RAG call was refused ("you haven't granted it yet": headless can't prompt), so the gate let grep through; answered |
| acceptEdits | same as default | same |
| auto | `reset` · `pin` · `deny Bash` · `searched (antares)` · `allow Bash` | no refusals; the classifier allowed the RAG call; answered from `compact.go` |
| bypassPermissions | `reset` · `pin` · `deny Bash` · `searched (antares)` · `allow Bash` ×2 | answered |
| default + `allowSearchTools` | `reset` · `pin` · `deny Bash` · `approve rag_retrieve_context` · `searched` · `allow Bash` | answered, gate satisfied |
| non-indexed git folder, default and auto | `reset` (not indexed, would be project_id "noindex") · `off` | grep ran at once; answered |
| `ENOWX_SESSION` set | `reset` (enowX session) only | gate off, grep ran |
| no MCP server in the session | `reset` · `off` ("enowx-rag MCP server not loaded in this session") | gate off |

The stream (`--include-hook-events`) for the auto run, abridged:

```
TOOL_USE Bash {"command": "grep -rniI \"compact\" <repo> --include=* …"}
HOOK PreToolUse:Bash systemMessage='🔎 rag-first: held Bash until a RAG search (antares) · 1/3' deny
RESULT ERROR "PreToolUse:Bash hook error: rag-first: search this project's RAG before using Bash to look around. Call mc…"
TOOL_USE mcp__enowx-rag__rag_retrieve_context {"project_id": "antares", "query": "compact conversation history context compaction", "limit": 5, "recall": 40, "hybrid": tr…
HOOK PostToolUse:mcp__enowx-rag__rag_retrieve_context systemMessage='🔎 rag-first: RAG searched (antares) · Grep/Glob/Read/Bash open for this prompt'
TOOL_USE Bash {"command": "grep -rniI \"compact\" . --exclude-dir=node_modules …"}
FINAL turns 4 cost 0.0572 denials 1
```

In interactive `default` mode the RAG call asks for permission the first time, like any MCP tool not yet allowed. To
skip it, allow the two read-only tools once ("always allow" at the prompt, or in `~/.claude/settings.json`:
`"permissions": {"allow": ["mcp__enowx-rag__rag_retrieve_context", "mcp__enowx-rag__rag_semantic_search"]}`),
or set `"allowSearchTools": true` in rag-first's config. If you refuse it, the gate opens for that prompt (the same attempted-search rule as in the headless default run; not tried interactively).

**Nudge mode is weak**, as the benchmark predicted: in a real bypassPermissions run with `mode: "nudge"` the
model got the reminder three times (`additionalContext`, shown as `🔎 rag-first: reminded to search RAG (antares)
before Bash · 1/3`) and never searched. Use strict if you want the savings.

## Seeing what it does

### A line under the call (on by default)

The hooks add a `systemMessage`, which Claude Code shows under the tool call. Lines captured from an
interactive session in a pseudo-terminal (`default` mode, antares, the two search tools allowed on the command
line), flattened from escape codes; the terminal wrapped the longer ones at its width:

```
  ⎿  Not run · permission denied
     Reason: PreToolUse:Bash hook error: rag-first: search this project's RAG …
  ⎿  PreToolUse:Bash says: 🔎 rag-first: held Bash until a RAG search (antares)
Called enowx-rag
  ⎿  PostToolUse:mcp__enowx-rag__rag_retrieve_context says: 🔎 rag-first: RAG
```

The full texts, as the hooks print them (from the headless runs' hook events):

```
🔎 rag-first: held Bash until a RAG search (antares) · 1/3
🔎 rag-first: RAG searched (antares) · Grep/Glob/Read/Bash open for this prompt
🔎 rag-first: let Grep through after 3 denials without a RAG search (loop guard)
🔎 rag-first: the RAG search didn't complete (refused or failed); Bash let through for this prompt
🔎 rag-first: reminded to search RAG (antares) before Bash · 1/3          (nudge mode)
🔎 rag-first off here: project not indexed in enowx-rag (would be project_id "x")   (once per session)
```

`"display"` in the config: `"all"` (default) shows every line above; `"changes"` only the ones where the gate
acted (held, let through, reminded); `"off"` none. The log records everything either way.

### `/rag-first:log`, and the same in a terminal

`/rag-first:log [N] [--summary]` runs `scripts/log.mjs` and shows the table. Its output for the real auto-mode
run above (`RAG_FIRST_DIR` pointed at that run's log):

```
time      session   event             tool                        decision       project         detail
────────  ────────  ────────────────  ──────────────────────────  ─────────────  ──────────────  ──────────────────────────────
04:27:09  61f03808  UserPromptSubmit                              reset          antares
04:27:10  61f03808  tool.describe                                 pin            antares
04:27:13  61f03808  PreToolUse        Bash                        deny           antares         #1 · grep -rniI "compact" /Use…
04:27:20  61f03808  PostToolUse       mcp__enowx-rag__rag_retri…  searched       antares         compact conversation history …
04:27:20  61f03808  PreToolUse        Bash                        allow          antares         grep -rniI "compact" . --exclu…
```

(The detail column is shortened here; times are local.) And the default-mode run, where the search was refused:

```
04:27:12  8ca8adf7  PreToolUse        Bash                        deny           antares         #1 · grep -rniI "compact" --ex…
04:27:17  8ca8adf7  PreToolUse        Bash                        search-failed  antares         a RAG search was called but di…
04:27:17  8ca8adf7  PreToolUse        Bash                        let-through    antares         the RAG search was refused or …
```

The command's output reaches the model, which repeats it (one short turn). Without a model:

```sh
node scripts/log.mjs              # last 20 (or: log.mjs 50, -n 50)
node scripts/log.mjs --watch      # then follow new decisions live
node scripts/log.mjs --summary    # counts per decision; prompts searched / denied
node scripts/log.mjs --session 9650 --json
```

## Reading the log

Every decision is one JSON line in `~/.claude/rag-first/gate.jsonl` (rotated to `gate.jsonl.1` past 5 MB):

```json
{"ts":"2026-11-19T21:27:12.337Z","session_id":"96500317-…","event":"PreToolUse","tool":"Bash","decision":"deny","project_id":"antares","detail":"grep -rniI \"compact\" …","n":1,"mcp":"module"}
```

| decision | meaning |
|---|---|
| `reset` | a prompt started; `project_id` when the gate is on there, else `reason` |
| `pin` | the hooks module loaded the two search tools up front for this session |
| `deny` | a gated call was held; `n` = denials so far this prompt; `mcp` = how the server was detected |
| `nudge` | nudge mode: allowed with a reminder |
| `searched` | a RAG search completed; `detail` = its query |
| `allow` | a gated call after the search |
| `exempt` | a gated tool whose target needs no search; `reason` says why |
| `let-through` | allowed without a search: loop guard, or the search was refused or failed |
| `search-failed` | a search was called but didn't complete, or was refused |
| `approve` | `allowSearchTools` approved a search call |
| `off` | the gate is off for this call (once per prompt); `reason` says why |
| `error` | the hook failed; the call was allowed |

Per-session state lives in `~/.claude/rag-first/state/<session>.json` and is pruned after 7 days. `jq` works too:

```sh
jq -r 'select(.decision=="deny" or .decision=="let-through") | [.ts, .session_id[0:8], .tool, .decision, .detail] | @tsv' ~/.claude/rag-first/gate.jsonl | tail
```

## Install

rag-first is meant to be listed in the owner's existing marketplace, `semutjahat` (the model-judge repo).
**That entry isn't there yet**: the text to add is in [docs/marketplace-entry.md](docs/marketplace-entry.md).
Once it is:

```sh
claude plugin marketplace add SemutJahat/model-judge     # the "semutjahat" marketplace
claude plugin install rag-first@semutjahat --scope user
claude plugin list                                        # rag-first@semutjahat … ✔ enabled
```

New sessions load it. To try it for one session without installing anything, from a clone:
`claude --plugin-dir /path/to/rag-first`.

Update, disable, remove:

```sh
claude plugin marketplace update semutjahat && claude plugin update rag-first@semutjahat
claude plugin disable rag-first@semutjahat --scope user     # enable to turn it back on
claude plugin uninstall rag-first@semutjahat --scope user
```

### Requirements

- Claude Code with hooks (the module that pins the tools needs hook modules: 2.1.328 has them), Node ≥ 18.
- The **enowx-rag** MCP server, configured under the name `enowx-rag` (tools `mcp__enowx-rag__…`), and the
  project indexed with `rag_index_project` (which records its folder in `~/.enowx-rag/project_dirs.json`).
  A project indexed some other way can be named in the config's `projects`.

## Config

`config.json` in the plugin:

```jsonc
{
  "mode": "strict",            // "strict": deny until searched · "nudge": allow, add a reminder · "off"
  "gatedTools": ["Grep", "Glob", "Read", "Bash"],   // a subset of these four (the hook matcher covers only them)
  "display": "all",            // the line under calls: "all" | "changes" | "off"
  "maxDenials": 3,             // loop guard: after this many denials in one prompt, let calls through
  "pinTools": true,            // load the two search tools up front (hooks module)
  "indexNew": true,            // an unindexed git project: ask for rag_index_project and hold tools until it runs
  "allowSearchTools": false,   // approve the two read-only search tools without a permission prompt
  "exemptPromptFiles": true,   // never hold a file the user named in the prompt
  "exemptWrittenFiles": true,  // never hold reading back a file the model wrote this session
  "exemptOutsideProject": true,// never hold targets outside the indexed folder
  "exemptNonText": true,       // never hold Read of images, PDFs, archives, media
  "projects": {}               // { "/abs/folder": "project_id" } for projects missing from project_dirs.json
}
```

An installed plugin is a copy that each update replaces, so put your own settings in
`~/.claude/rag-first/config.json`, with only the keys you change (`{"mode": "nudge"}`). Read in order: the
plugin's `config.json`, `~/.claude/rag-first/config.json`, the file in `$RAG_FIRST_CONFIG`; later wins, key by
key. `RAG_FIRST_MODE=off|nudge|strict` overrides the mode for one session; `RAG_FIRST_DIR` moves the log and state.

## Limits

- **Only enowx-rag.** The tool names, `project_dirs.json` and the project-id rule are enowx-rag's. Another RAG
  server would need its own names.
- **Bash detection is heuristic.** It reads the command with a small shell splitter: no variable expansion, no
  subshells (`$(…)`), no aliases, no `xargs grep` at the start of a line, no scripts that grep inside. A missed
  search is simply allowed; a false hold costs one turn and counts toward the loop guard.
- **The prompt-file exemption matches by name.** "compact.go" in the prompt lets any `compact.go` be read
  without a search; a path that doesn't exist yet isn't recognised.
- **One search opens everything for the prompt**, whatever its `project_id` or query. The gate makes the model
  start with retrieval; it doesn't judge the search.
- **Subagents share the session's state.** A subagent's calls are gated too; a search by the main agent opens
  them, and a subagent can satisfy the gate itself.
- **Parallel calls.** If the model sends the search and a grep in the same turn, the grep may be held (it was
  checked before the search finished) or let through as `search-failed`; either way it is one call.
- **`default` mode, headless.** An MCP tool not allowed by your rules is refused without a prompt, so the gate
  can't be satisfied and falls back to letting calls through (logged). Allow the two tools, or use
  `allowSearchTools`.
- **Long sessions gain little.** In the benchmark the saving was in fresh sessions; in one long session
  answering 12 questions every setup cost about the same (see below).
- **Projects without a transcript** (`--no-session-persistence`) are detected through the config files only:
  a server listed there but not started for the session (`--strict-mcp-config`) leaves the gate on; the
  `search-failed` path then lets calls through.
- Not tested on Windows.

## Benchmark

Round 2 of the owner's RAG benchmark (2026-11-19/20): the antares repo (Go + web, ~1,050 indexed files),
12 questions (where / flow / identifier / change-plan, vague and cross-file, answer keys verified with file:line
before any run), Sonnet 5.5 at medium effort, every answer graded blind (0/1/2) against the key.

| setup, fresh session per question | score | cost (12 Q) | total tokens / Q (mean) | tool calls / Q | greps / Q | RAG calls / Q |
|---|---|---|---|---|---|---|
| A: plain Claude Code | 23/24 | $1.75 | 217,578 | 10.0 | 5.9 | 0 |
| B: enowx-rag + "use RAG first" in CLAUDE.md | 23/24 | $1.88 | 205,750 | 9.4 | 5.3 | **0** |
| **F: B + this gate** (the prototype of rag-first) | **24/24** | **$1.32** | **89,440** | 6.8 | 2.8 | 1.83 |
| C: an enowX session (its own RAG hook) | 22/24 | $1.90 (+$1.47) | 259,792 | 4.2 | 2.6 | 0 |

- F against A: **−59% tokens, −25% cost**, the same or better score. The saving comes from fewer turns.
- In **one long session** answering all 12 in order, every arm cost $1.89–2.05 (F $1.96): the growing
  conversation dominates and the gate's advantage disappears.
- Caveat: F also ran with `--tools Read,Grep,Glob,Bash` to load the MCP schemas up front, which shrank each
  turn a little; part of the saving is that. rag-first pins only the two search tools instead.
- Single run per cell; score differences of 1–2 points are within grader noise, the token and cost
  differences are large and consistent.

Method, arms, per-question matrix and caveats: [docs/benchmark.md](docs/benchmark.md).

## Developing

```sh
npm test                          # node --test test/  (stubbed filesystem and env; no network)
claude plugin validate .
PERMISSION_MODE=auto MCP_CONFIG=/path/to/enowx-rag-mcp.json test/real-run.sh /path/to/indexed/repo /tmp/run "question…"
```

`test/real-run.sh` runs one headless session with the plugin loaded from the folder (nothing installed), writes
the stream to `RUN/stream.jsonl` and the gate's log to `RUN/log/gate.jsonl`. It costs a few cents per run.

Layout: `scripts/lib.mjs` (all logic, no process I/O), `scripts/gate.mjs` (the command hook),
`scripts/pin.mjs` (the hooks module's helper), `scripts/log.mjs` (the viewer), `hooks/register.ts`
(tool pinning), `commands/log.md`.

## License

MIT
