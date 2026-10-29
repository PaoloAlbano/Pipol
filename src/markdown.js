import { marked } from 'marked'
import DOMPurify from 'dompurify'

// GFM (~~strike~~, `code`) + single newline → <br>
marked.use({ breaks: true, gfm: true })

const escapeAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Only http(s) links become anchors; anything else (javascript:, mailto:, …) stays plain text.
// When the label doesn't mention the real host, the host is shown next to it so
// [google.com](https://evil.example) can't pass one site off as another.
marked.use({
  renderer: {
    link(token) {
      const label = this.parser.parseInline(token.tokens)
      let url
      try {
        url = new URL(token.href)
      } catch {
        return label
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return label
      const anchor = `<a href="${escapeAttr(url.href)}">${label}</a>`
      if (token.text.toLowerCase().includes(url.hostname.toLowerCase())) return anchor
      return `${anchor}<span class="link-host"> (${escapeAttr(url.hostname)})</span>`
    },
  },
})

// Open every link in a new tab without leaking the opener or referrer
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer nofollow')
  }
})

// Allow mark tag for @mention highlighting
const PURIFY_CONFIG = {
  ALLOWED_TAGS: [
    'p',
    'br',
    'strong',
    'b',
    'em',
    'i',
    'del',
    's',
    'code',
    'pre',
    'ul',
    'ol',
    'li',
    'blockquote',
    'mark',
    'a',
    'span',
  ],
  ALLOWED_ATTR: ['class', 'href'],
  ALLOWED_URI_REGEXP: /^https?:/i,
}

/** Markdown → sanitized HTML for chat messages (safe for dangerouslySetInnerHTML). */
export function renderMarkdown(content) {
  const raw = marked.parse(content)
  const sanitized = DOMPurify.sanitize(raw, PURIFY_CONFIG)
  // Highlight @mentions — safe to do after DOMPurify since < in text is already &lt;
  return sanitized.replace(/>([^<]+)</g, (match, text) => {
    const highlighted = text.replace(/\B@([\w-]+)/g, '<mark class="mention">@$1</mark>')
    return `>${highlighted}<`
  })
}
