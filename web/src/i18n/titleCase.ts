const SMALL = new Set(['a', 'an', 'the', 'and', 'or', 'but', 'nor', 'of', 'to', 'in', 'on', 'for', 'at', 'by', 'vs.', 'with', 'from', 'as', 'per']);

function capitalize(word: string): string {
  // Leave alone anything with digits or inner capitals, such as v3, 8B, macro-F1 or ts-1.
  if (/\d/.test(word) || /[A-Z]/.test(word.slice(1))) return word;
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * English titles in Title Case ("Labeling task" → "Labeling Task"). Short words stay lower case
 * except at the start. Text without Latin letters, such as Chinese, passes through unchanged.
 */
export function titleCase(text: string): string {
  let isFirst = true;
  return text.replace(/[A-Za-z][\w'’.]*(?:-[A-Za-z][\w'’.]*)*/g, word => {
    const lower = word.toLowerCase();
    const keep = (!isFirst && SMALL.has(lower)) || /\d/.test(word);
    const out = keep ? word : word.split('-').map(capitalize).join('-');
    isFirst = false;
    return out;
  });
}
