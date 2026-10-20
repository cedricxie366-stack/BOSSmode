# BOSSmode — Your turn to be the boss.

[中文](README.md) | [English](README.en.md)

BOSSmode, formerly **Builder Mode**, is a local product-collaboration plugin for **Codex** and **DeepSeek Harness (DSH)**. Describe your goal, try the result, and make the decisions that matter. One accountable AI partner handles research, implementation, coordination, checks, and explanations.

The aim is not to make you manage a collection of agents. It is to give you a clear view of what works, what happens next, and which trade-offs need your judgment.

This time, you get to say “I have an idea,” try the result, give feedback, and make the call. The “boss making wishes” line is a joke—not a promise of magic. Checkable work and continued improvement are the point.

The owner experience does not mean zero involvement or unlimited autonomy. You still own direction, scope, budget, permissions, and important business choices. The long-term vision is professional AI collaboration shaped around ordinary people's goals—not a fixed industry template or a predetermined cast of roles. Current support is narrower than that vision.

**Open-source preview · Apache License 2.0 · Bring your own host and model access.** Model usage may incur charges; open-source code does not mean free or unlimited inference. This is a community project, not an official OpenAI or DeepSeek product.

## What the workflow feels like

1. **Align first.** Get a short first-version proposal: what you will receive, where you will use it, what is in and out, and the next tangible checkpoint.
2. **Let the lead execute.** Once aligned, routine work proceeds without repeated “should I continue?” questions. Picking an AI provider alone is not approval of the whole product plan.
3. **Review outcomes.** See usable work, important limits, and the consequences of real choices—not a wall of internal task IDs.
4. **Revise and resume.** Give feedback in your own words. The lead records current decisions and can recover the project in a new conversation without asking you to repeat the entire brief.

You can say: “I want to build … Help me understand the smallest useful version first.” Later: “This feels too complicated—simplify it,” or “What can I actually try now?” Confusion is valid feedback; you do not need to rewrite it as a technical bug report.

## Tested environment

- macOS 15.5 on Apple Silicon; Node.js 24.
- Codex CLI 0.154.0.
- DSH 0.2.1-rc.2, using its official local Web UI and native sessions.

Standalone packaged desktop applications, Intel Macs, Windows, Linux, and other host versions have **not** been verified. A package appearing in a plugin list does not prove full support. See [validation scope and retained failures](release/validation.json).

Version `0.2.0-preview.3` adds pre-send wording review for progress updates, questions and final replies. The lead submits the actual draft, revises flagged jargon or excessive technical detail, and sends the passing text unchanged. Plain language is the default. Only an explicit user statement of relevant technical background permits limited detail in that area; the user can switch back to plain language at any time. Successfully saved preferences can be read in a new conversation.

The local checker makes no additional model calls and does not persist full reply drafts. Known wording rules are combined with disclosed assistant semantic self-review; this is not independent factual verification or a host-wide output interceptor. Rules may miss problems. Technical background never grants permission for actions. Saving a preference still follows host approval policy: a denied save is disclosed, not bypassed or presented as persistent. See [this update's validation scope](release/reply-review-validation.json).

Version `0.2.0-preview.2` was the branding/bilingual update. The historical full real-model build workflow baseline remains `0.2.0-preview.1`, described in `release/validation.json`. Current wording tests and synthetic scenarios do not certify real user comprehension or repeat every host UI workflow.

## Install in DSH

Prerequisites: DSH 0.2.1-rc.2, Node.js 24, Git, and pnpm. From a downloaded or cloned source directory:

```sh
dsh plugin --profile web add "file:$PWD"
dsh web
```

Or install the pinned GitHub version:

```sh
dsh plugin --profile web add github:cedricxie366-stack/BOSSmode#v0.2.0-preview.3
```

The official DSH plugin manager can also install the local source directory. For compatibility, its package identifier remains `builder-mode`; the description identifies it as BOSSmode. All three components should be running. Configure your model access in DSH itself. BOSSmode does not choose a model, collect credentials, or relax permissions.

Choose a **separate product folder** for your work, not the plugin source directory.

SDK users can install into the `sdk` profile; headless users can install into `headless`. Profiles are configured independently. The tested SDK integration does not provide the Web UI's interactive approval flow. Do not disable safeguards to make automation pass, and do not control one session from two DSH processes at once.

Disable the plugin using its switch. To uninstall:

```sh
dsh plugin --profile web remove builder-mode
```

These actions do not delete your product files or `.builder-mode` project records.

## Install in Codex

From the source root:

```sh
npm --prefix plugins/builder-mode test
codex plugin marketplace add .
codex plugin add builder-mode@builder-mode-local
```

The display name is **BOSSmode**. The installation identifier is deliberately unchanged. Installation requires your permission and does not alter authentication. After an update, use a new conversation to ensure the complete new instructions are loaded. Do not let old/new versions—or different hosts—write the same product concurrently.

## Boundaries that matter

- The registration example has behavioral checks. Research, content, and general file deliverables have structural/data checks and version-bound reviews. Passing those checks is **not** certification of factual, creative, or professional quality.
- Backup covers project state, journals, and frozen evidence/deliverables. It is not a whole-computer backup and does not automatically include every live business database or the current working tree.
- Unknown executor state blocks conflicting new work. A model's assertion is not proof that another executor has stopped.
- User responses are recorded with attribution; they are not cryptographic authorization. Publishing, sending, payments, and sensitive-data use still require separately scoped permission.
- Unattended production deployment, payments, and real-customer-data workflows are not supported by this preview. Skill instructions are not an unbypassable operating-system sandbox.
- Use either Codex or DSH. A separate Builder Web application is not required.

## Rename compatibility

The product and GitHub repository are now **BOSSmode**. The `builder-mode` package/skill identifiers, `builder_*` tools, `.builder-mode` data directory, and old release tags remain intact. **Do not manually rename them or rebuild an existing project.** The old GitHub repository address redirects to the new one. This name change is not a trademark clearance.

This independently maintained repository is not affiliated with other similarly named AI products. Identify this project by its repository URL and installation instructions. The name has other users; no exclusivity or trademark protection is claimed.

## Feedback and contribution

Tell us what you wanted, what happened, and which step made you handle technical work you did not want to own. Use this repository's Issues; see [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md) for contribution and private security-reporting guidance.

Do not upload secrets, complete session logs, user projects, or project databases. The plugin does not automatically publish your work. Installation tests and synthetic scenarios show bounded behavior—not a user-success statistic.

Licensed under [Apache License 2.0](LICENSE). External hosts and model services retain their own terms; see [DEPENDENCIES.md](DEPENDENCIES.md).
