// The sprint theme. `astryx experimental theme editor` wrote this file once and never changes it again.
// The checked settings live in sprint.settings.json and the generated sprint.settings.ts;
// change them with `astryx experimental theme editor set sprint ...`. Add your own changes below: they win over the settings.
import {defineTheme} from '@astryxdesign/core/theme';
import {sprintSettings} from './sprint.settings';

// Neutral keeps its black accent. Indigo marks AI features only: the `ai` button variant
// (Ask AI, AI actions) and the `ai` badge.
const indigo = 'light-dark(#4f46e5, #818cf8)';
const indigoHover = 'light-dark(#4338ca, #a5b4fc)';
const onIndigo = 'light-dark(#ffffff, #1e1b4b)';

export const sprintTheme = defineTheme({
  extends: sprintSettings,
  name: 'sprint',
  components: {
    button: {
      'variant:ai': {backgroundColor: indigo, color: onIndigo, borderColor: 'transparent'},
    },
    badge: {
      'variant:ai': {backgroundColor: 'light-dark(#e0e7ff, #312e81)', color: 'light-dark(#4338ca, #c7d2fe)'},
    },
  },
});
