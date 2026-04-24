---
name: score-applications
description: Rate Iterative founders/applications on AI fluency and customer savvy against the rubric below. Invoke when the user asks to score, rate, or evaluate applications or founders against these two axes.
argumentHint: "<cohort-or-filter, e.g. 'W25' or 'last 10 apps'>"
---

# Score applications

Rate founders in the Iterative database on two independent axes: AI fluency and customer savvy. Score each application against the rubric below, then emit the three-part Slack-formatted output.

## How to gather input

If the user pasted application text inline, use that directly — don't issue a query.

If the user named a cohort, founder, company, or quantity, pull the data in **one JOINed query** — never fan out per-application. The query must stay small enough that the SDK doesn't persist the result to disk; if it does, scoring needs the whole payload back in context and you're better off re-running a tighter query than parsing the persisted file.

Query shape:

- Select from `application` + `person` + `company`, left-joining `answer` → `question` filtered to the scoring-signal keys only (see whitelist below).
- Truncate free-text answers inline: `LEFT(a.value_text, 2000) AS value_text`. 2000 chars is enough to apply the craft-vs-magic test; full length is gravy.
- Default batch cap: **10 applications**. Larger batches risk persistence + re-query cost — if the user explicitly asks for more, go up to 20 and warn them.
- Order by `application.created_at DESC` unless the user specified otherwise.

Question-key whitelist (from `prompts/schema.md` question catalog — these are the textarea/narrative fields that carry scoring signal):

```
company_description, problem, validation, market_size, unique_insight,
current_solution, progress, journey, anything_else
```

Boolean/number/select answers don't drive the rubric — skip them. Pull `person.bio`, `person.first_name`, `person.last_name`, `person.email`, `person.location`, `company.name`, `company.location`, `cohort.shortname` directly from the base tables (not through `answer`).

If an application is too sparse to rate (key fields empty, under ~500 words of substance), score it Level 0 on the relevant axis with `confidence: high` and note `insufficient data`.

If persistence triggers despite this shape, halve `LEFT()` to 1000 and drop the batch to 3 apps — don't reach for `Bash` to parse the persisted file for scoring.

Always cite founder name, company, and cohort in the output.

## AI fluency scale

**Level 0 — No signal or inconclusive.**
No AI presence anywhere in the application, OR the application is too sparse to judge (missing key fields, empty answers).

**Level 1 — Prompter.**
Uses AI as an end user. Language is "asking," "using," "getting it to do." No code artifacts. Doesn't name specific tools, or uses generic terms ("ChatGPT," "LLMs," "AI"). AI appears in personal tasks, not product or ops.

**Level 2 — Builder.**
Uses AI in their dev loop to ship faster. Names specific dev tools (Cursor, Claude Code, Aider, Copilot, v0). Product may or may not use AI — the AI lives in how they build, not what they built. Can talk about prompting at a working level.

**Level 3 — Orchestrator.**
Deploys AI systems in production. AI is doing work in the product or ops that would otherwise require humans or a team. Has working agent/workflow systems running in production (not demos). Names orchestration tools (n8n, Make, MCP, custom stacks). Can describe architecture choices.
KEY DISTINCTION vs Builder: the AI lives in the running product/business, not just the dev loop.

**Level 4 — Architect.**
Designs the infrastructure and custom frameworks agents run on. Talks about craft-level AI problems: context management, evals, failure modes, retry logic, tool design. THE HIGHEST-CONFIDENCE SIGNAL: talks about where AI BREAKS or what it CAN'T do, not just what it can. References specific technical decisions (model choice, token limits, architecture tradeoffs). Engineering depth is evident in language, not just claims.

**Level 5 — Exceptional.**
Builds infrastructure that pushes the frontier. Has shipped something other builders reference or use (open source, adopted pattern). Public credibility in builder communities. Operating at the edge of what commodity tools can do. Rare at application stage — should feel like "how is this person not already funded."

## Customer savvy scale

**Level 0 — No signal or inconclusive.**
No evidence of customer contact, or application too sparse.

**Level 1 — Thesis-only.**
Has a thesis about a market but no visible customer contact. Talks in abstractions.

**Level 2 — Surface.**
Has talked to a handful of people. Can describe the segment at a basic level. Not yet specific or weird.

**Level 3 — Knows the archetype.**
Knows the customer archetype well. Can describe a buyer persona with real specificity. Has done validation conversations. Uses concrete examples.

**Level 4 — Specific and weird.**
Names individuals they've talked to. Describes non-obvious behaviors. Knows what substitutes the customer uses today and WHY those substitutes fail. Specific enough that we'd spot the customer in the wild.

**Level 5 — Operator-level.**
Has worked in the market themselves, or has built such deep contact that they operate at an insider's level. Can explain the weird substructure — who pays whom, where the receipts actually happen, why obvious solutions don't work. Knows things nobody outside the space would.

## Scoring rules

1. The two axes are INDEPENDENT. Score them separately. A founder can be fluency 1 / customer 5, or fluency 4 / customer 2, etc.

2. Primary evidence source for fluency: HOW THE FOUNDER DESCRIBES THEIR OWN WORK. Language reveals fluency faster than artifact inspection. A founder who says "AI models suck in context traceability" reveals Level 4 in one sentence. A founder who says "leveraging AI" for the same task reveals Level 1-2.

3. Craft-vs-magic test. Founders who describe AI at a craft level (failure modes, evals, architecture, specific tools) score higher. Founders who describe AI at a magic level ("AI-powered," "leveraging LLMs") score lower, regardless of what they claim.

4. Marketing language is a downgrade signal. "AI-powered platform," "leveraging generative AI," "cutting-edge AI" without technical specifics = Level 1-2 at most, even if the product is technically sophisticated. (External artifacts could still upgrade the rating — but the written text alone gets the lower score.)

5. Sparse applications get Level 0. Don't guess. If key fields are empty or the application is under ~500 words of substance, score 0 with "insufficient data" and flag confidence high.

6. **ICP-fit is: `fluency >= 3` AND `customer >= 3`.** Anything else is not ICP-fit. If either score is 0, `icp_fit` is false and the reason should mention needing enrichment.

7. Confidence levels:
   - **high**: multiple signals visible, language is clear, evidence is unambiguous.
   - **medium**: some signals visible, partial evidence, or mixed signals.
   - **low**: sparse data, one weak signal, or contradictory evidence — should be kicked to human review.

Quote the founder's own words where possible. Do not infer facts not present in the application.

## Output format

Three parts, Slack mrkdwn.

### Part 1: scoring cards

One card per application. No table, no code fence — Slack thread view is too narrow for aligned columns. Each card is two short lines:

- Line 1: `*{#}. {Founder name}* — {Company} · {Cohort} · {Loc}`
- Line 2: `Fluency *{score} {level name}* · Customer *{score}* · ICP {icp-marker}`

Rules:

- Separate cards with a blank line.
- `icp-marker` is one of `*YES*` / `close / marginal` / `no (fluency)` / `no (customer)` / `no (no AI)` / `— insufficient data`.
- `close / marginal` means: right at the threshold with real uncertainty (e.g. fluency 3 with low confidence, or a borderline customer 3).
- Bold any score ≥ 4 with `*…*` — e.g. `Fluency *4 Architect*` or `Customer *5*`.
- For Level 0 / insufficient-data rows: use `*{#}. —*` on line 1 with `—` for company and cohort if unknown, and `ICP — insufficient data` on line 2.

Example (3 founders):

```
*1. Jane Doe* — Acme · W25 · SF
Fluency *4 Architect* · Customer *3* · ICP *YES*

*2. Bob Smith* — Widget Co · W25 · NYC
Fluency 2 Builder · Customer *4* · ICP no (fluency)

*3. —* — insufficient data · W25 · —
Fluency 0 · Customer 0 · ICP — insufficient data
```

### Part 2: highlighted finds

One short paragraph per ICP-fit or borderline founder. Skip clear non-fits and Level 0s entirely.

Each paragraph should:

- State the rating ("fluency 4, customer 3").
- Quote the specific language that drove the fluency score — their exact words, in backticks. This is the audit trail.
- Note the standout customer signal if relevant.
- Give one line of traction or background if the application shows it.
- Flag whether they were previously rejected if the data shows it (check `evaluation_stage_change` for a prior `Rejected` terminal on the same company/founder) — these are retroactive-pipeline candidates.

### Part 3: patterns

3–5 short observations about the batch as a whole. Things to look for:

- Hit rate (`X out of Y ICP-fit`).
- Common failure modes (e.g. "high customer but low fluency is dominant").
- Geographic or cohort patterns.
- Data-quality issues (% sparse / Level 0).
- Anything unexpected worth flagging for the pod.

End with one concrete next action: `reach out to these N founders`, `score another batch`, or `this batch is done, move to X`.

## Tone and style

- Direct, analytical. No hedging. No padding.
- If a section is short because the batch is small, leave it short.
- Quote founders' words when they reveal something sharp — that's the evidence base, not decoration.
- When scoring is close or uncertain, say so explicitly and flag for human review. Don't fake confidence.
- Slack mrkdwn only: `*bold*`, `_italic_`, `` `inline` ``, triple-backtick blocks. Never `**bold**`, `###`, or markdown tables.
