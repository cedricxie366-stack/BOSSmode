# Data checks, review, and local delivery

Use this only for non-registration file/data artifacts. `artifact-data-v1` does not execute candidate code, browse sources, or certify semantics.

Before editing, pass an `acceptancePlan` to `builder_begin_change`:

```json
{
  "checks": [
    {"id":"report","kind":"text_contains","path":"report.md","value":"Limitations"},
    {"id":"metadata","kind":"json_fields","path":"sources.json","fields":{"sources":"array"}},
    {"id":"asset","kind":"file","path":"diagram.svg","minBytes":20,"maxBytes":500000}
  ],
  "reviewCriteria": [
    {"id":"accuracy","text":"Claims are supported by sources and uncertainty is disclosed"},
    {"id":"fit","text":"The outcome answers the agreed user need"}
  ]
}
```

Checks are frozen in the task and input digest, not read from candidate-owned configuration. Supported kinds are `file`, `text_contains` (literal, not regex), and `json_fields` (top-level fields: string/number/boolean/object/array). Relative paths only, 1–40 checks, 1–20 review criteria, at most 1 MiB per checked file. Source `assistant_proposed` is not proof the user approved the criteria. Passing returns `needs_review`.

After `builder_verify_change`, obtain the verification evidence ID and candidateDigest from returned evidence.details. Actually inspect the checked files and sources as needed. Record one criterion at a time using `builder_record_review`: current state revision, task/attempt IDs, verificationEvidenceId, candidateDigest, criterionId, reviewerType (`assistant` or `user_attributed`), outcome (`satisfied`, `changes_requested`, `unknown`), concrete comment and sourceRef. Do not invent user feedback. User-attributed feedback is stored as assistant-attributed, never Host-attested approval.

Reviews append without replacing history. A sourceRef explains where an opinion came from; it does not automatically prove its correctness. Any content or contract change requires fresh verification. Missing sources or unresolved professional questions should remain unknown. Record real counterexamples, not only favorable observations.

`builder_prepare_delivery` checks report hashes, exact candidate/snapshot identity, current contract and unresolved writers. It copies the frozen files into a new local delivery directory containing product/, host-report.json, delivery.json and README.txt. It never publishes or grants user approval. Outstanding changes_requested blocks delivery; missing/unknown criteria remain needs_review. Satisfied recorded criteria produce reviewed_candidate, not accepted. Registration acceptance remains scoped to its fixed behavior checks, not blanket product readiness.

Share the useful output location and explain what was checked, reviewed, and remains undecided. A delivery manifest is an audit record, not evidence that arbitrary content is safe or production-ready.
