# Frontend demo

A clickable demo of the platform, built with Next.js 16 and Astryx. A PM trains a model by talking to an agent: the agent asks questions and for approvals, and every page it writes (schema, dataset, labeling task, eval report and so on) shows up in the chat as an artifact card. An artifact opens in a modal over the chat, like a Claude artifact. It uses only made-up data, has no backend, and supports English and Chinese.

The story uses a simplified multi-label teacher prompt for short videos, with three label fields: `primary_value` and `format` (pick one) and `topics` (pick 1 to 3). The prompt and its deliberate flaws are in [`docs/demo/video-tagging-prompt-v1.md`](../docs/demo/video-tagging-prompt-v1.md).

```bash
npm install
npm run dev     # http://localhost:3000
npm run build   # static export to out/
npm run build:artifact   # one HTML file with inline CSS and JS, for the shared private link
```

## How it fits together

- `src/story/`: the scripted conversation for the "Video tags" model (`videoTags.ts`), the read-only history of the other two models (`models.ts`), and `StoryProvider`, which reveals items one by one, moves on when the user answers the card a step waits for, and keeps the user's labels and disagreement decisions so closing a modal loses nothing.
- Artifacts: an `artifact` item in the script is a write the agent made (`created` or `updated`). The chat shows it as an `ArtifactCard`; the header's "Artifacts · N" menu lists the latest state of each; `ArtifactModal` opens one. "Open full page" only says where the standalone page will live, since those pages come after the demo.
- `src/components/cards/`: the agent's cards in the chat: question, approval, progress, result, advice and task.
- `src/components/panels/`: the ten artifact pages, including `LabelingPanel` (all three fields; revealing the teacher shows its full output) and `AdjudicationPanel` (disagreements with filters, side-by-side answers, the agent's suggestion and keyboard shortcuts 1, 2, A, J, K).
- `src/components/charts/`: small charts built from plain HTML and SVG (bars, lines, confusion matrix).
- `src/mock/`: made-up fields, posts, disagreements and metrics. Every score is computed from the confusion matrices and per-topic counts in `metrics.ts`, and the script computes the numbers it quotes from them, so all screens agree. Change the matrices, not the numbers on screen.
- `src/i18n/`: `t(key)` for app chrome in `messages.ts`, and `tr(t('English', '中文'))` for copy that sits next to its data.
- `src/app/globals.css`: the warm, Claude-like look is a set of token overrides on the Astryx neutral theme plus a few component styles. Icons that sit beside wrapping text use `.icon-line` and `.icon-slot`, which centers the icon on the first line.

Astryx is pinned to an exact version, because it is a 0.x beta. Look up component APIs with `npx astryx component <Name>`.
