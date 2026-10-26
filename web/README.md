# Frontend demo

A clickable demo of the platform, built with Next.js 16 and Astryx. A PM trains a model by talking to an agent: the agent asks questions, asks for approvals and sends links that open workspace panels beside the chat. It uses only made-up data, has no backend, and supports English and Chinese.

```bash
npm install
npm run dev     # http://localhost:3000
npm run build   # static export to out/
npm run build:artifact   # one HTML file with inline CSS and JS, for the shared private link
```

## How it fits together

- `src/story/`: the scripted conversation for the "Content value" model (`contentValue.ts`), the read-only history of the other two models (`models.ts`), and `StoryProvider`, which reveals items one by one and moves on when the user answers the card a step waits for.
- `src/components/cards/`: the agent's cards in the chat: question, approval, progress, result, advice and link.
- `src/components/panels/`: the nine workspace panels. Each unlocks when the story reaches the card named in `PANEL_UNLOCKED_BY`. A chat link written as `#panel-<id>` opens one.
- `src/components/charts/`: small charts built from plain HTML and SVG (bars, lines, confusion matrix).
- `src/mock/`: made-up labels, posts and metrics. Every score is computed from the confusion matrices in `metrics.ts`, so all screens agree. Change the matrices, not the numbers on screen.
- `src/i18n/`: `t(key)` for app chrome in `messages.ts`, and `tr(t('English', '中文'))` for copy that sits next to its data.

Astryx is pinned to an exact version, because it is a 0.x beta. Look up component APIs with `npx astryx component <Name>`.
