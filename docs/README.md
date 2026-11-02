# docs

| File | What it is | When it changes |
|---|---|---|
| [plan.md](plan.md) | The build plan: summary, evidence, options, design, phases, risks and decisions | When a decision is made or the design changes |
| [progress.md](progress.md) | Task-by-task status, the documentation checklist and a dated log | Every time a task lands |
| [research/](research/) | Research notes with sources, dated 2026-11-02, plus the benchmark scripts | Rarely. These are a snapshot; new findings go in the progress log or a new note |
| `architecture.md` (P5) | How the server is actually built | When the code's structure changes |
| `tools.md` (P5) | Reference for each MCP tool | When a tool's schema changes |
| `benchmarks.md` (T1) | Comparison with Squoosh, and performance results | After each tuning round |

**Research notes:**

| Note | Covers |
|---|---|
| [squoosh-internals.md](research/squoosh-internals.md) | Squoosh's state, its codecs and defaults, jSquash, and the forks |
| [engines-and-metrics.md](research/engines-and-metrics.md) | sharp against Squoosh's codecs (benchmarks), and the quality metrics |
| [mcp-conventions.md](research/mcp-conventions.md) | MCP spec and SDK v2, publishing, client install snippets, tool design and long jobs |
| [competitors.md](research/competitors.md) | Existing image MCP servers and the gaps between them |
| [engine-bench/](research/engine-bench/) | Scripts and raw results behind the benchmark numbers |

The research notes number their own suggestions (D1, D2…) locally. Only the D-numbers in [plan.md](plan.md) are actual project decisions.

`bench-results.json` labels one row "png lossless … compressionLevel 9, effort 10". That row is actually a **palette** PNG, because in sharp `effort` turns palette mode on. [engines-and-metrics.md §2.2](research/engines-and-metrics.md) uses the correct lossless numbers.
