# Benchmark Methodology

This benchmark quantifies quality and latency differences across git-memory modes:

- `llm-enhanced` (local Ollama model)
- `prompt-aware` (keyword/synonym matching)
- `recency` (recent commits fallback)

## What It Measures

1. Context relevance of retrieved commits (`Precision@K`, `Recall@K`, `nDCG@K`, must-include hit rate).
2. Query precision for LLM follow-up queries (novel relevant commit rate, marginal recall gain).
3. Response quality from Claude using captured contexts (fact recall/precision, helpfulness, hallucination count).
4. Latency trade-offs (`p50`/`p90` total and LLM sub-call timings).

## Dataset Files

- `bench/prompts.real.jsonl`: ready-to-run dataset for this repository.
- `bench/prompts.template.jsonl`: template for synthetic or project-specific datasets.

JSONL schema per prompt:

```json
{
  "prompt_id": "p01_example",
  "prompt": "Question to benchmark",
  "commit_labels": [{"hash": "<40-char-hash>", "relevance": 3}],
  "must_include_hashes": ["<40-char-hash>"],
  "gold_facts": ["Atomic fact expected in correct answer"]
}
```

## Step 1: Run Context Benchmark

```bash
deno run --allow-run --allow-read --allow-write --allow-env --allow-net scripts/benchmark-context.ts \
  --dataset=bench/prompts.real.jsonl \
  --out-dir=bench/results/run-001 \
  --runs=3 \
  --models=gemma2:3b,llama3.2:3b,qwen2.5:7b
```

Outputs:

- `bench/results/run-001/runs.jsonl`
- `bench/results/run-001/trace.jsonl`
- `bench/results/run-001/summary.json`

## Step 2: Score Retrieval + Latency

```bash
deno run --allow-read --allow-write scripts/benchmark-score-retrieval.ts \
  --dataset=bench/prompts.real.jsonl \
  --runs=bench/results/run-001/runs.jsonl \
  --trace=bench/results/run-001/trace.jsonl \
  --k=10 \
  --out=bench/results/run-001/retrieval-report.json
```

This report includes per-mode/model summaries, paired deltas vs baselines, and follow-up query precision metrics for LLM mode.

## Step 3: Generate Claude Responses

```bash
ANTHROPIC_API_KEY=... deno run --allow-read --allow-write --allow-env --allow-net scripts/benchmark-generate-responses.ts \
  --dataset=bench/prompts.real.jsonl \
  --runs=bench/results/run-001/runs.jsonl \
  --out=bench/results/run-001/responses.jsonl \
  --model=claude-sonnet-4-5-20250929 \
  --selection=first
```

Use `--selection=all` to score every repetition.

## Step 4: Score Response Quality

LLM-judge mode:

```bash
deno run --allow-read --allow-write --allow-net --allow-env scripts/benchmark-score-responses.ts \
  --dataset=bench/prompts.real.jsonl \
  --responses=bench/results/run-001/responses.jsonl \
  --judge-model=gemma2:3b \
  --out=bench/results/run-001/response-report.json
```

Lexical fallback mode (no local judge model):

```bash
deno run --allow-read --allow-write scripts/benchmark-score-responses.ts \
  --dataset=bench/prompts.real.jsonl \
  --responses=bench/results/run-001/responses.jsonl \
  --out=bench/results/run-001/response-report.json
```

## Controlling Variables

- Keep repo at one fixed commit SHA for all runs.
- Run with identical prompt set and repetitions per mode.
- Disable session carry-over (`STRUCTURED_GIT_SESSION=""` is enforced by runner).
- Rebuild index before non-recency modes (runner does this automatically).
- Force recency mode by hiding trailer index during recency phase (runner does this automatically).

## Model Sufficiency Guidance

- Run `gemma2:3b` for your primary local baseline.
- Add at least one stronger model (`qwen2.5:7b`) and one fast small model (`llama3.2:3b`) for robustness.
- Compare quality-vs-latency Pareto front in `retrieval-report.json` and `response-report.json`.

