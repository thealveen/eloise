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

- **N ≤ 5**: one chunk, done.
- **5 < N ≤ 20**: sequential chunks of 5 via `OFFSET 0, 5, 10, 15`. Assemble all rows across chunks, then score the full set as one batch.
- **N > 20**: pull the first 20 in four chunks of 5. Tell the user the total was N and they should re-run for the remainder.

Never fan out per-application. Each chunk is one query following the skeleton below.

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

AI Fluency is assigned by running the decision procedure below in order. Each step is a binary gate with explicit criteria. Stop at the first terminal level. Do not reinterpret earlier gates once you pass them.

### Signal definitions

These definitions are the inputs to the gates. Apply them consistently — do not make up additional categories.

**Craft-level language.** Specific, technical descriptions of AI system behavior. Must reference at least one of:
- A named failure mode (hallucination at a specific boundary, context loss, tool misuse, drift, specific error pattern)
- An evaluation concern (how they measure, what "good" looks like, regression detection, golden sets)
- Context management (what goes in the prompt/context window, retrieval strategy, chunking, windowing)
- Retry / error handling (what happens when the model fails, fallbacks)
- Tool design (how tools are exposed to agents, when the agent is allowed to call them)
- Model selection with an explicit tradeoff ("we use X for Y because Z vs W")
- Architecture choice with an explicit tradeoff (what they gave up, what broke)

Generic claims ("we fine-tuned," "we use RAG," "it's accurate") are NOT craft-level on their own. The specificity is the signal.

**Magic-level language.** Abstract, marketing-register descriptions of AI:
- "AI-powered", "AI-native", "AI-driven", "leveraging AI / LLMs / generative AI"
- "Cutting-edge", "state-of-the-art", "intelligent" (unqualified)
- Treating "AI" as a single undifferentiated capability

**Canonical tool references (non-exhaustive).** Dev-loop: Cursor, Claude Code, Copilot, Aider, v0, Windsurf, Replit Agent. Orchestration/runtime: n8n, Zapier, Make, MCP, LangChain, LangGraph, CrewAI, AutoGen, Inngest, Temporal. Eval/infra: LangSmith, Braintrust, Helicone, DSPy, guardrails libraries. A mention must be explicit (named), not implied.

**Production AI.** AI doing work that would otherwise require a human, a team, or a conventional non-AI system. Two equivalent categories — treat them the same:
- *In-product AI:* AI is a feature customers use — chat agent, classification, generation, recommendations, retrieval, decisioning.
- *In-ops AI:* AI automates the company's own work — support triage, sales research, data processing, hiring pipeline, internal agent stacks running parts of the business. Agents running ops in production score the same as agents shipped in the product.

Both count as production only if live and doing real work. Demos, prototypes, "planned features," and build-process usage (Cursor, Copilot, etc.) do NOT count. If ambiguous whether something is live, treat as NO.

### Decision procedure

Run the gates in order. Stop at the first terminal.

**Gate 0 — Sufficiency.**
Are the key fields (`problem`, `company_description`, `progress`, and at least one of `unique_insight` / `journey`) substantively populated, with the full application ≥ 500 words of content?
- NO → **Level 0** (insufficient data). Terminal.
- YES → continue.

**Gate 1 — AI presence.**
Does the application mention AI, ML, LLMs, agents, or any specific AI tool/model anywhere?
- NO → **Level 0** (no signal). Terminal.
- YES → continue.

**Gate 2 — Magic-only cap.**
Is ALL AI language in the application magic-level (zero craft-level language, zero specific tool names, zero architectural specifics)?
- YES → **Level 1**. Terminal.
- NO → continue.

**Gate 3 — Production deployment.**
Is there production AI (as defined above, in-product OR in-ops) in the running business?
- NO → go to Gate 3a.
- YES → go to Gate 4.

**Gate 3a — Dev-loop check (L1 vs L2).**
Does the founder name at least one dev-loop tool from the canonical list as part of how they build?
- YES → **Level 2**. Terminal.
- NO → **Level 1**. Terminal.

**Gate 4 — Architect check.**
BOTH of the following must be present in the founder's own description of their work:
- (a) At least one craft-level concern about AI behavior (failure modes, evals, context, retries, tool design) — specific, not generic.
- (b) At least one named architecture decision with explicit tradeoff language (why X over Y, what they gave up, what broke, what they had to work around).

- Both YES → go to Gate 5.
- One or neither → **Level 3**. Terminal.

**Gate 5 — Exceptional.**
Has the founder shipped a named public artifact that other builders use or reference (OSS project with users, widely-adopted pattern, talk or post others cite)? Claim alone is insufficient — the artifact must be named.
- YES → **Level 5**. Terminal.
- NO → **Level 4**. Terminal.

### Evidence requirement

Before emitting the score, collect the quoted spans from the application that triggered each passing gate. Minimums:

- Level 1: 1 quote showing AI presence.
- Level 2: 1 quote naming a specific dev-loop tool in the build-process context.
- Level 3: 2 quotes — one establishing production AI (in-product or in-ops), one additional supporting signal.
- Level 4: 3 quotes — production AI, craft-level concern (Gate 4a), architecture tradeoff (Gate 4b).
- Level 5: Level 4 quotes + 1 quote naming the public artifact.

If the quote minimums cannot be collected from the application text, drop one level and re-check. This prevents scoring on impression alone and makes the audit trail in Part 2 fall out automatically.

### Level names

Used in the Part 1 card output:

- 0 — (no label; use `—` or `insufficient data`)
- 1 — Prompter
- 2 — Builder
- 3 — Orchestrator
- 4 — Architect
- 5 — Exceptional

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

### Evidence requirement

Before emitting the score, collect the quoted spans that triggered each passing gate. Minimums:

- Level 1: 0 quotes (thesis-only is the absence of contact signal; confirm by noting no customer interaction is described).
- Level 2: 1 quote showing customer contact.
- Level 3: 2 quotes — one showing contact, one showing specific-archetype detail.
- Level 4: 3 quotes — contact, specific-archetype detail, and at least one Gate 3 signal (named individual, non-obvious behavior, or substitute awareness).
- Level 5: 4 quotes — Level 4 evidence plus either operator background (with substantive detail) or weird substructure clearly established.

If the quote minimums cannot be collected from the application text, drop one level and re-check.

### Level names

- 0 — (no label; use `—` or `insufficient data`)
- 1 — Thesis-only
- 2 — Surface
- 3 — Archetype
- 4 — Specific
- 5 — Operator

## Scoring rules

1. **ICP-fit is `AI Fluency >= 3` AND `Customer Insight >= 3`.** Anything else is not ICP-fit. If either score is 0, `icp_fit` is false and the reason should mention needing enrichment.

2. **Confidence** is anchored to evidence coverage:
   - **high**: quote minimums exceeded; signals appear in multiple answers; no contradictions.
   - **medium**: quote minimums met exactly; some contradiction; or passing gate was narrow.
   - **low**: quote minimums barely met; contradictory signals; or borderline gate decision. Use the `⚠️ Review` verdict and name the borderline gate in Part 2.

Quote the founder's own words where possible. Do not infer facts not present in the application.

## Output format

Two parts, Slack mrkdwn.

### Part 1: scoring cards

One card per application. Two lines.

- **Line 1:** `*{#}. {Founder name}* · {Company} · {Cohort} · {Loc}`
- **Line 2:** `{verdict} · AI Fluency {score} ({level name}) · Customer Insight {score} ({level name})`

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

- Bold any score ≥ 4 with `*…*` — e.g. `AI Fluency *4 (Architect)*`.
- Scores ≤ 3 are plain — e.g. `AI Fluency 3 (Orchestrator)`.

**Sparse / Level 0 rows:** collapse to a single Line 2. If founder name is known, still show Line 1 normally. If nothing is known, use `*{#}. —* · {Cohort or —}` for Line 1.

```
*{#}. {Founder name or —}* · {Company or —} · {Cohort} · {Loc or —}
❌ *Sparse application*
```

**Example (4 founders):**

```
*1. Jane Doe* · Acme · W25 · SF
✅ *Fit* · AI Fluency *4 (Architect)* · Customer Insight 3 (Archetype)

*2. Bob Smith* · Widget Co · W25 · NYC
❌ *Miss — AI fluency* · AI Fluency 2 (Builder) · Customer Insight *4 (Specific)*

*3. Clara Ng* · Bolt · W25 · SF
⚠️ *Review — low conf* · AI Fluency 3 (Orchestrator) · Customer Insight 3 (Archetype)

*4. John Kim* · Helix · W25 · Austin
❌ *Sparse application*
```

### Part 2: highlighted finds

One structured block per ICP-fit (`✅`) or borderline (`⚠️`) founder. Skip clear misses and Level 0s entirely.

**Format per block:**

```
*{#}. {Founder name} — {Company}* · AI Fluency {score} · Customer Insight {score} · {verdict}

*AI Fluency:* `"<exact quote from founder>"`
  → {signal name} ({Gate N})
*Customer Insight:* `"<exact quote from founder>"`
  → {signal name} ({Gate N})
*Traction:* <one line — only if shown in the application>
*Flags:* <one line — only if any apply>
```

**Rules:**

- Blank line between blocks.
- Quotes are verbatim from the founder's answers, in backticks.
- The `→` line names which signal the quote satisfies and the gate it triggered. Examples: `→ architecture tradeoff (Gate 4b)`, `→ non-obvious behavior (Gate 3b)`, `→ operator background, Path A (Gate 4)`.
- For borderline gates, replace the `→` line with: `→ borderline at Gate {N}: <one-line reason>`. Example: `→ borderline at Gate 4b: only one tradeoff statement, phrased loosely`.
- Drop `Traction` if the application doesn't show it.
- Drop `Flags` if empty. Flags are pod-level callouts only.

**Example:**

```
*1. Jane Doe — Acme* · AI Fluency 4 · Customer Insight 3 · ✅ *Fit*

*AI Fluency:* `"we had to cap context at 40k because reasoning degrades past that — tried chunking but retrieval lost compound filings"`
  → specific architecture tradeoff (Gate 4b)
*Customer Insight:* `"the banking ops leads we work with all maintain a shadow sheet because Netsuite doesn't track approvals — that's where the real workflow lives"`
  → non-obvious behavior + substitute awareness (Gate 3b + 3c)
*Traction:* 3 banking design partners, $30k MRR

*2. Clara Ng — Bolt* · AI Fluency 3 · Customer Insight 3 · ⚠️ *Review — borderline*

*AI Fluency:* `"our classifier sometimes gets tripped up on edge cases so we have retries"`
  → borderline at Gate 4a: retry mention is generic, no specific failure mode named
*Customer Insight:* `"ops managers at 3 of our pilots told us they'd quit if we went away"`
  → specific-archetype detail (Gate 2)
```

## Tone and style

Direct and analytical. No hedging, no padding. Quote founders' words as evidence, not decoration. When scoring is close, use `⚠️ Review` — don't fake confidence.

Slack mrkdwn only: `*bold*`, `_italic_`, `` `inline` ``, triple-backtick blocks. Never `**bold**`, `###`, or markdown tables in Slack output.