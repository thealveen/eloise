# Iterativo DB Schema (public)

Iterativo is an accelerator. Each year has a **Winter** batch (Feb–May) and a **Summer** batch (Jul–Oct); within a year W precedes S (e.g. W25 before S25). Founders submit an `application` tied to a `cohort`; answers fill an `answer` row per `question`; the app moves through `evaluation_stage` values, logged in `evaluation_stage_change`, and reviewers post `feedback` rows at each interview stage.

Lead tables exist in the DB but are **unused** — ignore `lead`, `lead_stage`, `lead_stage_change`. Investment/portfolio tables (`investment`, `funding_round`, `portfolio_update`, etc.) also exist but are empty.

Every table has `created_at timestamptz NOT NULL`, `updated_at timestamptz`, and most have `created_by_id / updated_by_id / deleted_by_id` → `profile(id)` plus a nullable `deleted_at`. These are omitted below for brevity; assume they exist.

---

## program
The accelerator itself. Currently a single row ("Accelerator").

| column | type | null | notes |
|---|---|---|---|
| id | uuid | no | **PK** |
| name | text | no | UNIQUE |
| description | text | yes | |
| type | text | yes | |

## cohort
One row per batch (W20, S20, ..., W26, S26).

| column | type | null | notes |
|---|---|---|---|
| id | uuid | no | **PK** |
| program_id | uuid | no | → program(id) |
| name | text | no | UNIQUE, e.g. "Winter 2025" |
| shortname | text | no | UNIQUE, e.g. "W25" |
| start_date | date | yes | Winter = Feb 1, Summer = Jul 1 |
| end_date | date | yes | Winter = May 1, Summer = Oct 1 |
| location | text | yes | |

## company
Applicant company. One company can apply to multiple cohorts (multiple `application` rows).

| column | type | null | notes |
|---|---|---|---|
| id | uuid | no | **PK** |
| name | text | no | |
| website | text | yes | |
| industry | text | yes | free text, sparsely populated |
| stage | text | yes | free text, sparsely populated |
| location | text | yes | |
| lifecycle_status | text | no | currently always `"applied"` — not a useful filter |
| airtable_id | text | yes | UNIQUE, legacy import key |

## person
Any human — founder, reviewer, contact. Linked to `profile` for team members.

| column | type | null | notes |
|---|---|---|---|
| id | uuid | no | **PK** |
| first_name | text | yes | |
| last_name | text | yes | |
| email | text | yes | UNIQUE |
| linkedin_url | text | yes | |
| bio | text | yes | |
| location | text | yes | |
| timezone | text | yes | |
| phone | text | yes | |
| primary_role | text | yes | |
| is_founder | bool | yes | |
| is_investor | bool | yes | |
| is_starred | bool | no | |
| roles_json | jsonb | yes | |
| source | text | yes | |
| tags | jsonb | yes | |

## profile
Iterativo team member layer. A `person` becomes a reviewer/admin by having a profile. **All `*_by_id` and `partner_id` FKs point here, not at `person`.**

| column | type | null | notes |
|---|---|---|---|
| id | uuid | no | **PK** |
| person_id | uuid | yes | → person(id) |
| role | enum | no | `admin` \| `staff` \| `user` |
| is_active | bool | yes | |

---

## application
The central table. One per (company, cohort) attempt.

| column | type | null | notes |
|---|---|---|---|
| id | uuid | no | **PK** |
| company_id | uuid | no | → company(id) |
| applicant_person_id | uuid | no | → person(id) — who submitted |
| applicant_user_id | uuid | yes | → profile(id) if submitter has a profile |
| cohort_id | uuid | yes | → cohort(id) |
| form_id | uuid | no | → application_form(id) |
| lead_id | uuid | yes | → lead(id) — **ignore, unused** |
| submission_status | text | no | always `"submitted"` in practice |
| submitted_at | timestamptz | yes | |
| evaluation_stage_id | uuid | yes | → evaluation_stage(id) — **current** stage |
| furthest_stage_id | uuid | yes | → evaluation_stage(id) — high-water mark; use this for funnel analysis (rejected apps lose their pre-rejection stage otherwise) |
| evaluation_owner_id | uuid | yes | → profile(id) |
| evaluation_decision | text | yes | `accepted` \| `rejected` \| null (pending) |
| decided_at | timestamptz | yes | |
| airtable_id | text | yes | UNIQUE |

## application_form
Versioned form definition. One active form at a time.

| column | type | null | notes |
|---|---|---|---|
| id | uuid | no | **PK** |
| name | text | no | UNIQUE(name, version) |
| version | int | yes | |
| program_id | uuid | yes | → program(id) |
| is_active | bool | yes | |

## form_section
Groups questions within a form.

| column | type | null | notes |
|---|---|---|---|
| id | uuid | no | **PK** |
| form_id | uuid | no | → application_form(id) |
| title | text | no | |
| description | text | yes | |
| sort_order | int | no | |

## question
A form field. `key` is the stable semantic identifier — query by `key`, not `label`.

| column | type | null | notes |
|---|---|---|---|
| id | uuid | no | **PK** |
| section_id | uuid | no | → form_section(id) |
| key | text | no | stable identifier, e.g. `company_name` |
| label | text | no | user-facing prompt |
| type | text | no | `text` \| `textarea` \| `url` \| `boolean` \| `number` \| `select` \| `multi_select` \| `file` |
| help_text | text | yes | |
| is_required | bool | yes | |
| validation_rules | jsonb | yes | |
| visibility_rules | jsonb | yes | |
| sort_order | int | no | |

### Current question catalog (key → type, section)
```
Company:              company_name (text), company_description (textarea), company_location (text),
                      company_sector (select), company_website (url)
Team:                 fulltime (boolean), cofounders (multi_select)
Pitch Materials:      pitch_video (url), pitch_deck (file), product_demo (url)
Problem & Solution:   problem (textarea), validation (textarea), market_size (textarea),
                      unique_insight (textarea), current_solution (textarea)
Traction:             progress (textarea), journey (textarea)
Fundraising:          total_raised (number), term_sheet (boolean)
Additional:           applied_before (boolean), team_bonding (textarea), anything_else (textarea)
```

## question_option
Choices for `select` / `multi_select` questions.

| column | type | null | notes |
|---|---|---|---|
| id | uuid | no | **PK** |
| question_id | uuid | no | → question(id) |
| value | text | no | |
| label | text | no | |
| sort_order | int | no | |
| is_active | bool | yes | |

## answer
**Polymorphic** — which `value_*` column is populated depends on `question.type`:

| question.type | populated column |
|---|---|
| text, textarea, url, file | `value_text` |
| number | `value_number` |
| boolean | `value_boolean` |
| select | `value_text` (holds the `question_option.value`) |
| multi_select | `value_json` (array of option values) |

| column | type | null | notes |
|---|---|---|---|
| id | uuid | no | **PK** |
| application_id | uuid | no | → application(id) |
| question_id | uuid | no | → question(id) |
| value_text | text | yes | |
| value_number | numeric | yes | |
| value_boolean | bool | yes | |
| value_json | jsonb | yes | |

---

## evaluation_stage
Static lookup. Seven rows, totally ordered by `sort_order`:

| sort_order | name | slug | is_terminal |
|---|---|---|---|
| 10 | Inbox Review | `inbox` | false |
| 20 | First Interview | `first_interview` | false |
| 30 | Final Interview | `final_interview` | false |
| 40 | Decision Pending | `decision_pending` | false |
| 50 | Offer Extended | `offer_extended` | false |
| 60 | Accepted | `accepted` | **true** |
| 70 | Rejected | `rejected` | **true** |

| column | type | null | notes |
|---|---|---|---|
| id | uuid | no | **PK** |
| name | text | no | |
| slug | text | no | UNIQUE — join target for `feedback.stage` |
| sort_order | int | no | |
| is_terminal | bool | yes | |
| program_id | uuid | yes | → program(id) |

## evaluation_stage_change
Audit log of stage transitions. `from_stage_id` is null for the first transition into `inbox`.

| column | type | null | notes |
|---|---|---|---|
| id | uuid | no | **PK** |
| application_id | uuid | no | → application(id) |
| from_stage_id | uuid | yes | → evaluation_stage(id) |
| to_stage_id | uuid | no | → evaluation_stage(id) |
| note | text | yes | |
| changed_by_id | uuid | yes | → profile(id) |

## feedback
Reviewer's write-up for a given interview. Rows exist for `first_interview` and `final_interview` stages only (no feedback written at other stages).

| column | type | null | notes |
|---|---|---|---|
| id | uuid | no | **PK** |
| application_id | uuid | no | → application(id) |
| stage | varchar | no | **string, not an FK** — join to `evaluation_stage.slug`. Values: `first_interview`, `final_interview` |
| partner_id | uuid | yes | → profile(id) (the reviewer) |
| recommendation_score | int | yes | 1–5 |
| market_score | int | yes | 1–5 |
| founder_score | int | yes | 1–5 |
| detailed_scores | jsonb | yes | rubric keys, see below |
| comments | text | yes | prose — **includes reject reasoning since `reject_reason` is unused** |
| red_flags | text | yes | |
| move_to_next_round | varchar | yes | **dirty**: values include `Yes`, `No`, `Maybe`, `true`, `false`, null. Normalize before filtering |
| reject_reason | varchar | yes | **always null in practice — don't rely on this** |
| reject_reason_other | text | yes | |

### `detailed_scores` jsonb keys (observed)
```
decision_bucket              (string: "Yes" / "No" / ...)
potential_star               (bool)
starred_for_future           (bool)
investment_recommendation    (string)
traction_score               (int 1–5)
founder_customer_insight     (int 1–5)
founder_execution            (int 1–5)
founder_fundraising          (int 1–5)
founder_structured_thinking  (int 1–5)
market_competition           (int 1–5)
market_problem_magnitude     (int 1–5)
market_problem_distribution  (int 1–5)
```
Not every row has every key — rubric evolved across cohorts.

---

## Query gotchas

1. **Soft deletes.** Every table with `deleted_at` should be filtered with `WHERE deleted_at IS NULL` unless you specifically want deleted rows.
2. **Current vs furthest stage.** `application.evaluation_stage_id` gets overwritten to `Rejected`/`Accepted` on decision. For "how far did it get," use `furthest_stage_id`.
3. **Feedback stage is a string.** `feedback.stage` is varchar matching `evaluation_stage.slug`, not a UUID FK.
4. **Reviewer name lookup.** `feedback.partner_id` → `profile.id` → `profile.person_id` → `person.first_name/last_name`. Two hops.
5. **Answer polymorphism.** Always check `question.type` to know which `value_*` column to read. `select` answers sit in `value_text` as the option's `value`, not its `label` — join `question_option` if you need the display label.
6. **Company applying multiple times.** A single `company_id` can have many `application` rows across cohorts. Group carefully.
7. **Cohort ordering.** Order by `cohort.start_date`, not `shortname` (alphabetical would put S20 before W20).
8. **`move_to_next_round` is dirty.** Use `WHERE LOWER(move_to_next_round) IN ('yes','true')` or similar; don't trust equality on a single value.
9. **`reject_reason` is effectively empty.** Rejection reasoning lives in `feedback.comments` as prose.
10. **`company.lifecycle_status`, `application.submission_status`** are currently single-value columns; filtering on them does nothing useful.