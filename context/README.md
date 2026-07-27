# context/

Drop Markdown files here — battlecards, product one-pagers, ICP/persona notes,
objection handling, pricing. The copilot loads them and injects the most relevant
ones into its live question suggestions, so nudges are grounded in **your**
product and playbook instead of being generic.

- One topic per file. Keep them tight (a few hundred words each).
- Edit them here on disk, or from the app's **Context** tab.
- The example files (`product-onepager.md`, `battlecard-vs-workday.md`) are just
  samples — replace or delete them.

Selection is keyword-relevance to the live transcript within a character budget
(no external service). Swap in a real vector index later behind
`ContextLibrary.contextBlock()` without touching the rest of the app.
