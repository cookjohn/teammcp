/**
 * Markdown rendering utility
 * Converts markdown text to HTML. Escapes HTML first, then applies transforms.
 */
import { escapeHtml } from './format.js'

/**
 * Render markdown string to HTML
 * @param {string} text - raw markdown text
 * @returns {string} - HTML string safe for v-html
 */
export function renderMarkdown(text) {
  if (!text) return ''

  // Step 1: Escape HTML to prevent XSS
  let html = escapeHtml(text)

  // Step 2: Extract code blocks to protect them from further transforms
  const codeBlocks = []
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length
    codeBlocks.push(`<pre class="md-code-block"><code class="lang-${lang || 'text'}">${code.trim()}</code></pre>`)
    return `\x00CODEBLOCK_${idx}\x00`
  })

  // Inline code (protect from further transforms)
  const inlineCodes = []
  html = html.replace(/`([^`\n]+)`/g, (_, code) => {
    const idx = inlineCodes.length
    inlineCodes.push(`<code class="md-inline-code">${code}</code>`)
    return `\x00INLINECODE_${idx}\x00`
  })

  // Step 3: Apply block-level transforms

  // Headings
  html = html.replace(/^### (.+)$/gm, '<h3 class="md-h3">$1</h3>')
  html = html.replace(/^## (.+)$/gm, '<h2 class="md-h2">$1</h2>')
  html = html.replace(/^# (.+)$/gm, '<h1 class="md-h1">$1</h1>')

  // Blockquotes
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote class="md-blockquote">$1</blockquote>')

  // Unordered lists
  html = html.replace(/^[\-\*] (.+)$/gm, '<li class="md-li">$1</li>')
  html = html.replace(/(<li class="md-li">[\s\S]*?<\/li>)\n?(?=(?:<li|$))/g, '$1')
  // Wrap consecutive <li> in <ul>
  html = html.replace(/((?:<li class="md-li">.*?<\/li>\n?)+)/g, '<ul class="md-ul">$1</ul>')

  // Ordered lists
  html = html.replace(/^\d+\. (.+)$/gm, '<li class="md-oli">$1</li>')
  html = html.replace(/((?:<li class="md-oli">.*?<\/li>\n?)+)/g, '<ol class="md-ol">$1</ol>')

  // Step 4: Inline transforms

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')

  // Strikethrough
  html = html.replace(/~~(.+?)~~/g, '<del>$1</del>')

  // Italic (single *)
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>')

  // Links [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" class="md-link">$1</a>')

  // Auto-link URLs (not already in href="...")
  html = html.replace(/(?<!["=])(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener" class="md-link">$1</a>')

  // Step 5: Line breaks
  html = html.replace(/\n/g, '<br>')

  // Step 6: Restore code blocks and inline code
  html = html.replace(/\x00CODEBLOCK_(\d+)\x00/g, (_, idx) => codeBlocks[parseInt(idx)])
  html = html.replace(/\x00INLINECODE_(\d+)\x00/g, (_, idx) => inlineCodes[parseInt(idx)])

  return html
}
