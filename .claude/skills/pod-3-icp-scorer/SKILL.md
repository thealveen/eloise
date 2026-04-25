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
- **Final feedback score ≥ X (avg across reviewers):** `id IN (SELECT application_id FROM feedback WHERE stage = 'final_interview' GROUP BY application_id HAVING AVG(recommendation_score) >= <X>)`
- **First feedback score ≥ X (avg across reviewers):** same with `stage = 'first_interview'`
- **Any reviewer at stage X scored ≥ Y:** `id IN (SELECT application_id FROM feedback WHERE stage = '<stage-slug>' AND recommendation_score >= <Y>)`
- **Star-worthy in feedback:** `id IN (SELECT application_id FROM feedback WHERE (detailed_scores->>'starred_for_future')::bool = true OR (detailed_scores->>'potential_star')::bool = true)`
- **Recommended to advance (any reviewer):** `id IN (SELECT application_id FROM feedback WHERE LOWER(move_to_next_round) IN ('yes','true'))`

Stage slugs: `inbox_review`, `first_interview`, `final_interview`, `decision_pending`, `offer_extended`. For "accepted" / "rejected" terminals, use `evaluation_decision` directly — don't filter via `evaluation_stage_change`.

Use `evaluation_stage_change` to identify apps that *reached* a stage, not `furthest_stage_id` — the latter only captures the latest stage, not the journey.

**Feedback score semantics.** Feedback rows only exist at `first_interview` and `final_interview` stages, one row per reviewer per stage. "Feedback score" defaults to `recommendation_score` (1–5). For "score was X+" phrasing (the score is treated as one number per app), use the AVG entry. For "any reviewer rated X+", use the per-row entry. Don't invent other aggregations — pick one of the cookbook shapes.

**Worked example.** "Score 10 rejected companies in W26 where the founder was starred and final feedback score was 4+":

```
cohort_id = (SELECT id FROM cohort WHERE shortname = 'W26')
AND evaluation_decision = 'rejected'
AND applicant_person_id IN (SELECT id FROM person WHERE is_starred)
AND id IN (SELECT application_id FROM feedback WHERE stage = 'final_interview' GROUP BY application_id HAVING AVG(recommendation_score) >= 4)
```

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
| **L3** | — | Authored own skills, MCPs, or plugins with design rationale; iterated personal AI workflows from specific observed failures; can describe what was iterated and why | Production AI in product or ops with engineering evidence: custom orchestration on LangGraph / CrewAI / OpenAI Agents SDK / Claude Agent SDK / Strands / Pydantic AI; tool/retry/context logic; programmatic tool calling; fine-tuning specifics; diagnosed failure modes; measured behavior on own data | **Opinions with weird specifics — about AI behavior.** Stance on an AI concept plus the particular failure they hit, where the failure is about the AI system itself ("RAG broke for us because compound queries hit two products and the retriever picked the dominant one"). Domain expertise expressed with conviction is *not* AI Fluency — it's Customer Insight or domain craft. |
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

### Anchor cases

| Case | Score | Reason |
|---|---|---|
| Founder describes autonomous AI systems running production work, but only at capability level (what they do, how much they do) without engineering detail (how they work, where they break) | **L2** | Capability claims without engineering evidence are wrappers, not Production-AI L3+ |
| Founder has strong domain opinions stated with conviction, but the opinions are about their industry, not about AI system behavior | **Domain conviction does not raise AI Fluency** | Score AI Fluency on AI signal only; domain insight feeds Customer Insight |
| Founder names Cursor / Claude Code / Codex as primary dev environment with described iteration on CLAUDE.md or skills | **L2 Engineering / L3 Daily use** | Engineering caps at L2; Daily use carries L3 if the iteration story is real |
| Founder names LangGraph / Claude Agent SDK / Strands with diagnosed failure modes and measured behavior on own data | **L3 Product/Ops** | Production AI with engineering evidence — the diagnostic detail is the signal |
| Founder claims production AI but the description is "AI-powered automation" with no failure modes, no orchestration named, no measured behavior | **L1 Product/Ops** | Marketing-speak about production AI is L1, not L3 |

### Methodology

1. Walk the four columns. For each, pick the highest level the founder's evidence supports.
2. AI Fluency = max across columns.
3. **Sufficiency floor.** If the application is sparse (key fields empty, < 500 words of substance) or contains no AI mention at all, score L0 and note `insufficient data`.
4. **Cite evidence.** For the column that drives the score, quote the founder's own words in Part 2. If the score is L4+, the evidence MUST come from the Product/Ops column — no exceptions.
5. **L4–L5 require an artifact, not a claim.** L4 needs visible design rationale. L5 needs a named, verifiable public artifact.

## Customer Insight scale

Five levels (L1–L5) scored across three evidence columns. **Score is max across columns** — the highest level the founder reaches in any column is their Customer Insight.

### Levels

- **L1** — thesis only
- **L2** — surface; generic market understanding
- **L3** — archetypal; specifics beyond market-report depth
- **L4** — non-obvious; specifics hard to fabricate without having done the work
- **L5** — operator-level; insider position with substantive detail

### Columns

- **Contact** — what they've learned from talking to customers. **Caps at L4.**
- **Market** — structural understanding of how the market works. **Caps at L4.**
- **Position** — founder's relationship to the space. **The only column with L5 evidence.**

Empty cells in the grid mean look elsewhere — the column doesn't carry signal at that level.

### Main grid

| Level | Contact | Market | Position |
|---|---|---|---|
| **L1** | No customer contact described; thesis stated in abstractions ("customers struggle with reporting", "SMBs care about speed and price") | No structural understanding beyond TAM-style claims | No relationship to the space stated; outsider perspective |
| **L2** | Has talked to people; describes the segment in aggregate; interview counts without substance ("we talked to 100 founders") | Names competitors and adjacent products; describes the category in standard terms | Generic professional background; passing exposure ("I used this product once") |
| **L3** | **Archetypal specificity.** Concrete workflow, specific pain with context, the exact tool used today, attributed segment behavior ("high-value Prosumers reject fully autonomous tools because they need precise control over voice modulation") | **Substitutes named with failure modes.** What customers use today and why it doesn't quite work — a substantive account of the substitute's failure, not "we're better" | Adjacent industry experience; team includes practitioners from the space; sustained domain time |
| **L4** | **Non-obvious specifics.** Named customer companies with attributed behavior (pilots, design partners, prospects with what they did or said); direct quotes from customer conversations; counted interactions tied to specific outcomes ("5 of 8 ops leads said X"); fingerprints of real customer time ("the buyer signs off but the intern actually decides because the buyer routes all RFPs to them") | **Weird market mechanics.** Pricing structures, deal flow, procurement quirks, financial flows, who pays whom — detail that wouldn't appear in a market research report | Founder personally worked in the target role/market with substantive detail surfacing in the writing; team includes operators from the space with attributed knowledge |
| **L5** | — | — | **Insider operator-level.** Founder has personally worked in the market AND demonstrates operator-level depth from that experience — not just the credential, the knowledge. Or: systematic weird-substructure knowledge (power dynamics, structural reasons obvious solutions fail, financial flows invisible from outside). Knows things nobody outside the space would. |

### The three cuts

| Cut | Test | Failure mode to avoid |
|---|---|---|
| **L1 → L2** | Have they talked to anyone, or is it pure thesis? | Scoring "we surveyed the market" as L2 contact |
| **L2 → L3** | Specifics beyond what a market report would say? | Scoring aggregate-level claims with conviction as L3 |
| **L3 → L4** | Non-obvious specifics that would be hard to fabricate? | Scoring archetypal depth as L4 because it's well-articulated |

L2 → L3 is the ICP cut. Watermark: *specifics beyond market-report depth.* "Customers are frustrated with current tools" stays L2. "High-value Prosumers reject fully autonomous tools because they need precise control over voice modulation for professional storytelling" qualifies L3.

L3 → L4 watermark: *would this appear in a market research report?* Named substitutes with failure modes can appear in reports → L3. Named customer companies with attributed behavior, or weird market mechanics like per-minute pricing structures and IP-library procurement → L4 because reports don't have that texture.

### Anchor cases

| Case | Score | Reason |
|---|---|---|
| Pure thesis, no contact described | **L1** | Nothing qualifies anywhere |
| "We talked to 100 founders, they all said X" | **L2** | Interview count without substance |
| "High-value Prosumers reject fully autonomous tools — they need precise control" | **L3** | Contact: archetypal specificity beyond market-report depth |
| "Movieflow and Medeo lack precision for professional storytelling" | **L3** | Market: substitutes with failure mode |
| "Douyin pays SGD 1,300/min for AI comic dramas; ByteDance Shortdrama Center procures via 60k IP novel library" | **L4** | Market: weird mechanics and structural deal flow |
| Archetypal contact (L3) + weird market mechanics (L4) + film team (L3) | **L4** | Max-across is L4 — Market column carries it even though Contact stays L3 |
| Founder ran ops at target customer for 4 years, describes specific dysfunction with mechanism | **L5** | Position: operator-level with substantive detail |
| Founder claims industry experience, no operator detail in the writing | **Score on text** | Credential alone doesn't qualify L5; need the knowledge surfaced |

### Methodology

1. Walk the three columns. For each, pick the highest level the founder's evidence supports.
2. Customer Insight = max across columns.
3. **Sufficiency floor.** If the application is sparse (key fields empty, < 500 words of substance) or contains no customer-facing signal at all, score L0 and note `insufficient data`.
4. **Cite evidence.** For the column that drives the score, quote the founder's own words in Part 2. If the score is L5, the evidence MUST come from the Position column — no exceptions.
5. **L5 requires knowledge in the writing, not a credential.** "I worked at X for 4 years" without operator-level detail surfacing is L4 at most.

## Scoring rules

1. **ICP-fit is `AI Fluency >= 3` AND `Customer Insight >= 3`.** Anything else is not ICP-fit. If either score is 0, `icp_fit` is false and the reason should mention needing enrichment.

2. **Confidence** is anchored to evidence coverage:
   - **high**: signals appear in multiple answers; no contradictions.
   - **medium**: evidence is thin or single-sourced; or the column that drives the score is narrow.
   - **low**: evidence is barely present; contradictory signals; or borderline column decision. Use the `⚠️ Review` verdict and name the borderline column in Part 2.

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
| `⚠️ *Review — borderline*` | Both scores ≥ 3 but at least one column decision was borderline. |
| `❌ *Miss — AI fluency*` | AI Fluency < 3, Customer Insight ≥ 3. |
| `❌ *Miss — customer*` | Customer Insight < 3, AI Fluency ≥ 3. |
| `❌ *Miss — both*` | Both < 3. |
| `❌ *Miss — no AI*` | AI Fluency is 0 due to no AI presence (L0 sufficiency floor), regardless of Customer Insight. |

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
  → {Column} L{level}: <one-line reason>
*Traction:* <one line — only if shown in the application>
*Flags:* <one line — only if any apply>
```

**Rules:**

- Blank line between blocks.
- Quotes are verbatim from the founder's answers, in backticks.
- For both axes, the `→` line names the column the quote came from and the level it satisfied. AI Fluency examples: `→ Product/Ops L4: design rationale visible`, `→ Daily use L3: iterated own skill from observed failure`, `→ Engineering L2: Claude Code as primary dev loop`. Customer Insight examples: `→ Contact L4: named customer with attributed quote`, `→ Market L3: named substitutes with failure mode`, `→ Position L5: operator detail surfaced from prior role`.
- For borderline calls, replace the `→` line with: `→ borderline at {Column} L{level}: <one-line reason>`. Example: `→ borderline at Market L4: one weird-mechanics claim, no second confirming detail`.
- Drop `Traction` if the application doesn't show it.
- Drop `Flags` if empty. Flags are pod-level callouts only.

**Example:**

```
*1. Jane Doe — Acme* · AI Fluency 4 · Customer Insight 3 · ✅ *Fit*

*AI Fluency:* `"we had to cap context at 40k because reasoning degrades past that — tried chunking but retrieval lost compound filings"`
  → Product/Ops L4: explicit context-window tradeoff with named failure mode
*Customer Insight:* `"the banking ops leads we work with all maintain a shadow sheet because Netsuite doesn't track approvals — that's where the real workflow lives"`
  → Contact L4: named ops leads with attributed shadow-sheet behavior
*Traction:* 3 banking design partners, $30k MRR

*2. Clara Ng — Bolt* · AI Fluency 3 · Customer Insight 3 · ⚠️ *Review — borderline*

*AI Fluency:* `"our classifier sometimes gets tripped up on edge cases so we have retries"`
  → borderline at Product/Ops L3: retry mention is generic, no specific failure mode named
*Customer Insight:* `"ops managers at 3 of our pilots told us they'd quit if we went away"`
  → Contact L3: specific-archetype detail from named pilots
```

## Tone and style

Direct and analytical. No hedging, no padding. Quote founders' words as evidence, not decoration. When scoring is close, use `⚠️ Review` — don't fake confidence.

Slack mrkdwn only: `*bold*`, `_italic_`, `` `inline` ``, triple-backtick blocks. Never `**bold**`, `###`, or markdown tables in Slack output.