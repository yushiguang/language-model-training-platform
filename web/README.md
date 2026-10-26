# Frontend demo

A clickable demo of the platform's workflow, built with Next.js 16 and Astryx. It uses only made-up data and has no backend, and it supports English and Chinese.

```bash
npm install
npm run dev     # http://localhost:3000
npm run build   # static export to out/
```

- `src/i18n/`: UI strings for `en` and `zh-CN`. Every visible string goes through `t()`.
- `src/mock/`: made-up data shaped like the future Go API responses.
- Astryx is pinned to an exact version, because it is a 0.x beta. Look up component APIs with `npx astryx component <Name>`.
