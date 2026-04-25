---
name: pod-3-icp-scorer
description: Rate Iterative founders/applications on AI Fluency and Customer Insight against the rubric below. Invoke when the user asks to score, rate, or evaluate applications or founders against these two axes.
argumentHint: "<cohort-or-filter, e.g. 'W25' or 'last 10 apps'>"
---

# Score applications

Rate founders in the Iterative database on two independent axes: AI Fluency and Customer Insight. Score each application against the rubric below, then emit the three-part Slack-formatted output.

## How to gather input

If the user pasted application text inline, use that directly — don't query.

Otherwise: pick a filter, count with it, decide chunking, execute. One filter, one skeleton, no exploration.

### Rules (non-negotiable)

- The query in Step 4 is the *only* shape used to fetch application data. Filters and OFFSET change between runs. Nothing else.
- Do not fetch answers per application.
- Do not remove the `q.key IN (...)` whitelist to "see what else is there."
- Do not issue diagnostic queries on sparse apps. Sparse rows score Level 0 on the affected axis per the rubric — do not investigate.
- Each chunk returns one row per app with the 9 answer columns pivoted. That row is the complete input for scoring; missing columns are evidence, not a reason to requery.

### Step 1 — Pick the filter

Map the user's request to a `<filter>` from this cookbook. Combine with `AND` as needed.

- **In cohort:** `cohort_id = (SELECT id FROM cohort WHERE shortname = 'W26')`
- **Accepted in cohort:** the above + `AND evaluation_decision = 'accepted'`
- **Rejected in cohort:** the above + `AND evaluation_decision = 'rejected'`
- **Reached stage X (any outcome):** `id IN (SELECT application_id FROM evaluation_stage_change esc JOIN evaluation_stage es ON es.id = esc.to_stage_id WHERE es.slug = '<stage-slug>')`
- **Rejected at stage X:** the above + `AND evaluation_decision = 'rejected'`
- **Starred founders:** `applicant_person_id IN (SELECT id FROM person WHERE is_starred)`
- **Specific founder:** `applicant_person_id = '<uuid>'`
- **Specific company:** `company_id = '<uuid>'`

Stage slugs: `inbox_review`, `first_interview`, `final_interview`, `decision_pending`, `offer_extended`. For "accepted" / "rejected" terminals, use `evaluation_decision` directly — don't filter via `evaluation_stage_change`.

Use `evaluation_stage_change` to identify apps that *reached* a stage, not `furthest_stage_id` — the latter only captures the latest stage, not the journey.

**Escape hatch.** If no cookbook entry matches, write one WHERE in the skeleton above. Do not issue probing queries. If you need a column you don't know, tell the user and stop — do not explore the schema.

### Step 2 — Count

Run exactly one count with the chosen `<filter>`:

```
SELECT COUNT(*) FROM application
WHERE <filter> AND deleted_at IS NULL;
```

Skip the count if:
- The user named a specific founder/company (N = 1).
- The user didn't specify a scope — default N = 5 (most recent).

### Step 3 — Decide chunking

Run exactly `ceil(N / 5)` chunks, capped at 4. Stop after the chunk that covers the remainder — do not run empty chunks.

| N      | Chunks | OFFSETs        |
|--------|--------|----------------|
| 1–5    | 1      | 0              |
| 6–10   | 2      | 0, 5           |
| 11–15  | 3      | 0, 5, 10       |
| 16–20  | 4      | 0, 5, 10, 15   |
| > 20   | 4      | 0, 5, 10, 15 (then tell the user the total was N and they should re-run for the remainder) |

Assemble rows across chunks, then score the full set as one batch. Never fan out per-application. Each chunk is one query following the skeleton below.

### Step 4 — Chunk query skeleton

Use this exact shape. Only `<filter>` and the OFFSET change between chunks.

```sql
WITH target AS (
  SELECT id FROM application
  WHERE <filter>
    AND deleted_at IS NULL
  ORDER BY created_at DESC
  LIMIT 5 OFFSET 0          -- 0, then 5, 10, 15 for later chunks
)
SELECT a.id,
       p.first_name, p.last_name, p.email, p.bio, p.location AS person_location,
       co.shortname AS cohort,
       c.name AS company_name, c.location AS company_location,
       MAX(CASE WHEN q.key='company_description' THEN LEFT(ans.value_text,1500) END) AS company_description,
       MAX(CASE WHEN q.key='problem'             THEN LEFT(ans.value_text,1500) END) AS problem,
       MAX(CASE WHEN q.key='validation'          THEN LEFT(ans.value_text,1500) END) AS validation,
       MAX(CASE WHEN q.key='market_size'         THEN LEFT(ans.value_text,1500) END) AS market_size,
       MAX(CASE WHEN q.key='unique_insight'      THEN LEFT(ans.value_text,1500) END) AS unique_insight,
       MAX(CASE WHEN q.key='current_solution'    THEN LEFT(ans.value_text,1500) END) AS current_solution,
       MAX(CASE WHEN q.key='progress'            THEN LEFT(ans.value_text,1500) END) AS progress,
       MAX(CASE WHEN q.key='journey'             THEN LEFT(ans.value_text,1500) END) AS journey,
       MAX(CASE WHEN q.key='anything_else'       THEN LEFT(ans.value_text,1500) END) AS anything_else
FROM application a
JOIN target t        ON t.id = a.id
JOIN person p        ON p.id = a.applicant_person_id
JOIN company c       ON c.id = a.company_id
JOIN cohort co       ON co.id = a.cohort_id
LEFT JOIN answer ans ON ans.application_id = a.id
LEFT JOIN question q ON q.id = ans.question_id
GROUP BY a.id, p.id, c.id, co.id
ORDER BY a.created_at DESC;
```

Why this shape:
- The `target` CTE applies `LIMIT 5` to applications (one row per app), not to the post-join exploded rows.
- `MAX(CASE WHEN q.key=...)` pivots the whitelisted answers into columns — one row per app.
- `LEFT(...,1500)` keeps a 5-app chunk under the SDK's ~100k-char persistence threshold.
- The whitelist is locked to: `company_description, problem, validation, market_size, unique_insight, current_solution, progress, journey, anything_else`. Boolean/number/select answers don't drive the rubric.
- The row returned per app is the **complete** scoring input. If a column is null, that is evidence — score Level 0 on the affected axis. Do not requery.

If a chunk still persists (rare, only on unusually long answers), unwrap it with the `jq` recipe in the system prompt's "Persisted tool results" section. Do not re-query with smaller truncation.

If an application row is too sparse to rate (key fields empty, under ~500 words of substance), score it Level 0 on the relevant axis with `confidence: high` and note `insufficient data`.

Always cite founder name, company, and cohort in the output.

## AI Fluency scale

Five levels (L1–L5) scored across four evidence columns. **Score is max across columns** — the highest level the founder reaches in any column is their AI Fluency.

### Levels

- **L1** — uses AI as-is
- **L2** — composes AI tools and workflows
- **L3** — shapes AI behavior
- **L4** — designs novel systems
- **L5** — L4 plus a named public artifact others reference

### Columns

- **Engineering** — how they personally build. **Caps at L2.** Building AI for the business is Product/Ops, not Engineering.
- **Daily use** — how they personally use AI. **Caps at L3.** Sophisticated use that ships or operates the business is Product/Ops.
- **Product/Ops** — AI doing work in the business. **The only column with L4–L5 evidence.**
- **Language** — how they describe AI. **Caps at L3.** Design-level prose is fakable without an artifact.

Empty cells in the grid mean look elsewhere — the column doesn't carry signal at that level.

### Tools date fast

Cells name 2026 SOTA exemplars to ground the scorer. Treat as exemplars, not checklists. The durable signal is what the founder *did* with the tool — iteration, design rationale, measured behavior. Naming a tool without those is L1.

### Main grid (April 2026)

| Level | Engineering | Daily use | Product/Ops | Language |
|---|---|---|---|---|
| **L1** | Copilot autocomplete only; no agent use | ChatGPT for personal tasks; no described workflow | "AI-powered" with no behavior detail; wrapper in marketing terms | **Marketing speak.** Undifferentiated AI. Names only models. Generic hype. |
| **L2** | Cursor, Claude Code, or Codex as primary dev environment; agent mode usage; CLAUDE.md basics | Power user of Claude Desktop / ChatGPT with installed third-party MCPs and skills; n8n / Make / Zapier AI for personal and team work | Composed workflow (n8n, Make, Zapier AI) running parts of business; product wraps APIs without behavior shaping; prompt-only customization with no iteration story | **Vocabulary.** Concept-correct AI talk. Names tools and concepts (RAG, context windows, MCP, agents). Well-read people land here; real builders pass through here. |
| **L3** | — | Authored own skills, MCPs, or plugins with design rationale; iterated personal AI workflows from specific observed failures; can describe what was iterated and why | Production AI in product or ops with engineering evidence: custom orchestration on LangGraph / CrewAI / OpenAI Agents SDK / Claude Agent SDK / Strands / Pydantic AI; tool/retry/context logic; programmatic tool calling; fine-tuning specifics; diagnosed failure modes; measured behavior on own data | **Opinions with weird specifics.** Stance on a concept plus the particular failure they hit ("RAG broke for us because compound queries hit two products and the retriever picked the dominant one"). Use-case-specific and hard to fake. |
| **L4** | — | — | **Designed a system where design choices are visible in the writing.** Common shapes: eval harness with articulated catch/miss reasoning (Braintrust, Langfuse, Phoenix, custom); agent framework with explicit rejected alternatives; domain plugin systems (Cowork-style — multiple skills + MCPs orchestrated) with reasoning about scope and boundaries; behavior monitoring infrastructure with design rationale | — |
| **L5** | — | — | L4 + named public artifact others reference: OSS infrastructure with users; novel pattern adopted by other builders; contribution to framework standards (MCP, Skills). Claim alone doesn't count — artifact must be named and verifiable. | — |

### 2026 tooling notes

What "table stakes" means. Adjust scoring accordingly.

- **Copilot is baseline.** Cursor, Claude Code, or Codex is L2 dev-loop. Copilot alone is closer to L1.
- **Multi-agent shipped table stakes Feb 2026.** Parallel agents (Conductor, Superset) for dev work is L2 baseline, not L3.
- **Skills (open standard Dec 2025) is a real L3 path for non-coders.** Authoring with design rationale qualifies; installing third-party doesn't.
- **Plugins (skills + MCPs + hooks bundled) sit L3–L4.** Anthropic's Cowork data plugin is the public reference for L4-tier design.
- **Eval/observability is a real layer.** Naming a platform (Braintrust, Langfuse, Phoenix, LangSmith) with what it catches/misses qualifies L4. "We have evals" doesn't.
- **L3 production AI usually names** LangGraph, CrewAI, OpenAI Agents SDK, Claude Agent SDK, Strands, Pydantic AI. Bare LangChain in 2026 is a yellow flag.

### Methodology

1. Walk the four columns. For each, pick the highest level the founder's evidence supports.
2. AI Fluency = max across columns.
3. **Sufficiency floor.** If the application is sparse (key fields empty, < 500 words of substance) or contains no AI mention at all, score L0 and note `insufficient data`.
4. **Cite evidence.** For the column that drives the score, quote the founder's own words in Part 2. If the score is L4+, the evidence MUST come from the Product/Ops column — no exceptions.
5. **L4–L5 require an artifact, not a claim.** L4 needs visible design rationale. L5 needs a named, verifiable public artifact.

## Customer Insight scale

Customer Insight is assigned by running the decision procedure below in order. Each step is a binary gate with explicit criteria. Stop at the first terminal level. Do not reinterpret earlier gates once you pass them.

### Signal definitions

**Abstraction-level language.** The founder talks about "the market," "users," "customers" as aggregates. Descriptions are segment-level without individuals, workflows, or substructure named. Examples:
- "We see strong demand from mid-market SaaS"
- "Customers struggle with reporting"
- "SMBs care about speed and price"

Interview counts without substance ("we talked to 100 founders") are abstraction-level unless paired with specific content from those interviews.

**Concrete contact.** Specific, countable customer interactions visible in the text:
- Named individuals they've spoken to (first name + role at minimum)
- Named customer companies (pilots, design partners, prospects)
- Direct quotes from customer conversations
- Counted interactions tied to specific outcomes ("5 of the 8 ops leads we interviewed said X")

**Specific-archetype detail.** One level below naming individuals: the founder describes the buyer/user at a level of detail that could only come from real conversations — a concrete workflow, a specific pain with specific context, the exact tool they use today. Not an aggregate, not yet a named individual.

**Non-obvious behavior.** A claim about what customers actually do that wouldn't appear in a Gartner report, a landing page, or an obvious market analysis. Examples:
- "The buyer signs off but the intern actually decides because the buyer routes all RFPs to them"
- "They track this in a WhatsApp group because email threads get buried"
- "The real bottleneck is the data-entry person re-keying leads because the sync breaks nightly"

Non-obvious behaviors are the fingerprint of real customer time.

**Substitute awareness.** The founder names what the customer uses today — a competitor, a spreadsheet, a meeting, a manual workaround, a non-decision — AND explains WHY that substitute fails for them. Not "our product is better"; a substantive account of the substitute's failure mode.

**Operator background.** The founder has personally worked in the target market, ideally in the target role or an adjacent insider position. Not "I used this product once"; enough time inside the space to see how it actually works.

**Weird substructure.** Insider-only knowledge about how the market actually works — who pays whom, where decisions actually happen versus where they appear to happen, why obvious solutions don't work at a structural level, financial flows or power dynamics invisible from outside. The strongest customer-insight signal.

### Decision procedure

Run the gates in order. Stop at the first terminal.

**Gate 0 — Sufficiency.**
Are the key fields (`problem`, `validation`, `progress`, at least one of `unique_insight` / `journey`) substantively populated, with the full application ≥ 500 words of content?
- NO → **Level 0** (insufficient data). Terminal.
- YES → continue.

**Gate 1 — Customer contact presence.**
Does the application show any evidence of actual customer contact — conversations, interviews, pilots, deployments, named customers, quoted customer words?
- NO → **Level 1** (thesis-only). Terminal.
- YES → continue.

**Gate 2 — Specificity check.**
Can you quote at least one span where the founder describes customers at specific-archetype level or better — a concrete workflow detail, a specific pain with context, a named individual, or a direct customer quote?
- NO (all customer language is abstraction-level) → **Level 2** (surface). Terminal.
- YES → continue.

**Gate 3 — Weirdness / insider check.**
Does the founder describe at least one of the following?
- (a) A named individual customer with attributed behavior, quote, or specific interaction
- (b) A non-obvious customer behavior (as defined above)
- (c) A named substitute plus substantive reason it fails

- NONE present → **Level 3**. Terminal.
- At least one → continue.

**Gate 4 — Operator-level check.**
Does the founder show operator-level insider knowledge via either path?
- *Path A:* Founder has personally worked in the target market or role, AND demonstrates operator-level detail from that experience (not just the credential — the knowledge).
- *Path B:* Founder describes weird substructure — insider-only knowledge that wouldn't be in any public source (who pays whom, power dynamics, financial flows, structural reasons obvious solutions fail).

- Either path clearly satisfied → **Level 5**. Terminal.
- Neither → **Level 4**. Terminal.

## Scoring rules

1. **ICP-fit is `AI Fluency >= 3` AND `Customer Insight >= 3`.** Anything else is not ICP-fit. If either score is 0, `icp_fit` is false and the reason should mention needing enrichment.

2. **Confidence** is anchored to evidence coverage:
   - **high**: signals appear in multiple answers; no contradictions.
   - **medium**: evidence is thin or single-sourced; some contradiction; or passing gate/column was narrow.
   - **low**: evidence is barely present; contradictory signals; or borderline gate/column decision. Use the `⚠️ Review` verdict and name the borderline gate or column in Part 2.

Quote the founder's own words where possible. Do not infer facts not present in the application.

## Output format

Two parts, Slack mrkdwn.

### Part 1: scoring cards

One card per application. Two lines.

- **Line 1:** `*{#}. {Founder name}* · {Company} · {Cohort} · {Loc}`
- **Line 2:** `{verdict} · AI Fluency {score} · Customer Insight {score}`

**Verdict** is one of:

| Verdict | When to use |
|---|---|
| `✅ *Fit*` | Both scores ≥ 3, confidence is medium or high, no borderline gates. |
| `⚠️ *Review — low conf*` | Both scores ≥ 3 but confidence is low. |
| `⚠️ *Review — borderline*` | Both scores ≥ 3 but at least one gate decision was borderline. |
| `❌ *Miss — AI fluency*` | AI Fluency < 3, Customer Insight ≥ 3. |
| `❌ *Miss — customer*` | Customer Insight < 3, AI Fluency ≥ 3. |
| `❌ *Miss — both*` | Both < 3. |
| `❌ *Miss — no AI*` | AI Fluency is 0 due to no AI presence (Gate 1 fail), regardless of Customer Insight. |

**Score formatting:**

- Bold any score ≥ 4 with `*…*` — e.g. `AI Fluency *4*`.
- Scores ≤ 3 are plain — e.g. `AI Fluency 3`.

**Sparse / Level 0 rows:** collapse to a single Line 2. If founder name is known, still show Line 1 normally. If nothing is known, use `*{#}. —* · {Cohort or —}` for Line 1.

```
*{#}. {Founder name or —}* · {Company or —} · {Cohort} · {Loc or —}
❌ *Sparse application*
```

**Example (4 founders):**

```
*1. Jane Doe* · Acme · W25 · SF
✅ *Fit* · AI Fluency *4* · Customer Insight 3

*2. Bob Smith* · Widget Co · W25 · NYC
❌ *Miss — AI fluency* · AI Fluency 2 · Customer Insight *4*

*3. Clara Ng* · Bolt · W25 · SF
⚠️ *Review — low conf* · AI Fluency 3 · Customer Insight 3

*4. John Kim* · Helix · W25 · Austin
❌ *Sparse application*
```

### Part 2: highlighted finds

One structured block per ICP-fit (`✅`) or borderline (`⚠️`) founder. Skip clear misses and Level 0s entirely.

**Format per block:**

```
*{#}. {Founder name} — {Company}* · AI Fluency {score} · Customer Insight {score} · {verdict}

*AI Fluency:* `"<exact quote from founder>"`
  → {Column} L{level}: <one-line reason>
*Customer Insight:* `"<exact quote from founder>"`
  → {signal name} ({Gate N})
*Traction:* <one line — only if shown in the application>
*Flags:* <one line — only if any apply>
```

**Rules:**

- Blank line between blocks.
- Quotes are verbatim from the founder's answers, in backticks.
- For AI Fluency, the `→` line names the column the quote came from and the level it satisfied. Examples: `→ Product/Ops L4: design rationale visible`, `→ Daily use L3: iterated own skill from observed failure`, `→ Engineering L2: Claude Code as primary dev loop`.
- For Customer Insight, the `→` line names which signal the quote satisfies and the gate it triggered. Examples: `→ non-obvious behavior (Gate 3b)`, `→ operator background, Path A (Gate 4)`.
- For borderline AI Fluency, replace the `→` line with: `→ borderline at {Column} L{level}: <one-line reason>`. Example: `→ borderline at Product/Ops L4: only one design-rationale statement, phrased loosely`.
- For borderline Customer Insight gates, replace the `→` line with: `→ borderline at Gate {N}: <one-line reason>`. Example: `→ borderline at Gate 4b: only one tradeoff statement, phrased loosely`.
- Drop `Traction` if the application doesn't show it.
- Drop `Flags` if empty. Flags are pod-level callouts only.

**Example:**

```
*1. Jane Doe — Acme* · AI Fluency 4 · Customer Insight 3 · ✅ *Fit*

*AI Fluency:* `"we had to cap context at 40k because reasoning degrades past that — tried chunking but retrieval lost compound filings"`
  → Product/Ops L4: explicit context-window tradeoff with named failure mode
*Customer Insight:* `"the banking ops leads we work with all maintain a shadow sheet because Netsuite doesn't track approvals — that's where the real workflow lives"`
  → non-obvious behavior + substitute awareness (Gate 3b + 3c)
*Traction:* 3 banking design partners, $30k MRR

*2. Clara Ng — Bolt* · AI Fluency 3 · Customer Insight 3 · ⚠️ *Review — borderline*

*AI Fluency:* `"our classifier sometimes gets tripped up on edge cases so we have retries"`
  → borderline at Product/Ops L3: retry mention is generic, no specific failure mode named
*Customer Insight:* `"ops managers at 3 of our pilots told us they'd quit if we went away"`
  → specific-archetype detail (Gate 2)
```

## Tone and style

Direct and analytical. No hedging, no padding. Quote founders' words as evidence, not decoration. When scoring is close, use `⚠️ Review` — don't fake confidence.

Slack mrkdwn only: `*bold*`, `_italic_`, `` `inline` ``, triple-backtick blocks. Never `**bold**`, `###`, or markdown tables in Slack output.