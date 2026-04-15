export function sanitizeCommentaryText(raw: string): string {
  let text = raw.trim();

  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  text = text.replace(/https?:\/\/\S+/gi, '');
  text = text.replace(
    /\s*\((?:https?:\/\/)?(?:www\.)?[a-z0-9.-]+\.[a-z]{2,}(?:\/[^)\s]*)?\)\s*/gi,
    ' '
  );
  text = text.replace(
    /(^|\s)(?:www\.)?[a-z0-9.-]+\.(?:com|net|org|gr|es|it|de|fr|io|tv|eu|pt|co\.uk)(?:\/[^\s]*)?(?=$|\s|[.,;:!?])/gi,
    '$1'
  );
  text = text.replace(/[ \t]+\n/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.replace(/\s{2,}/g, ' ');
  text = text.replace(/\s+([.,;:!?])/g, '$1');

  return text.trim();
}