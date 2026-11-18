import type {DocumentSource} from '@yushiguang/sprint-contracts';

/**
 * Stand-in for document links (review finding 4). The stand-ins open no document service, so
 * every link reads as "not available" and the helpers say so and ask for the text. A deployment
 * reads the real documents through `Platform.documents` (docs/integration.md, "Document links").
 */
export function noDocuments(): DocumentSource {
  return {
    async read() {
      return null;
    },
  };
}
