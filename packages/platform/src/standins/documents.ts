import type {DocumentSource} from '@tsp/contracts';

/**
 * Stand-in for document links (review finding 4). The public build cannot open the internal
 * document service, so every link reads as "not available" and the helpers say so and ask for
 * the text. The internal build reads the real documents through `Platform.documents`
 * (docs/handover/integration.md, "Document links").
 */
export function noDocuments(): DocumentSource {
  return {
    async read() {
      return null;
    },
  };
}
