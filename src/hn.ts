export interface HNStory {
  id: string
  title: string
  url?: string
  author: string
  points: number
  numComments: number
  createdAt: number
  text?: string
}

export interface HNComment {
  by?: string
  text?: string
  time: number
}

const ALGOLIA = 'https://hn.algolia.com/api/v1'

interface AlgoliaHit {
  objectID: string
  title: string
  url?: string
  author: string
  points?: number
  num_comments?: number
  created_at_i: number
  story_text?: string
}

interface AlgoliaItem {
  id: number
  author?: string
  text?: string
  created_at_i: number
  children?: AlgoliaItem[]
}

export async function fetchTopStories(count = 18, page = 0): Promise<HNStory[]> {
  const res = await fetch(`${ALGOLIA}/search?tags=front_page&hitsPerPage=${count}&page=${page}`)
  const data: { hits: AlgoliaHit[] } = await res.json()
  return data.hits.map(h => ({
    id: h.objectID,
    title: h.title,
    url: h.url,
    author: h.author,
    points: h.points ?? 0,
    numComments: h.num_comments ?? 0,
    createdAt: h.created_at_i,
    text: h.story_text,
  }))
}

export async function fetchStoryComments(storyId: string, max = 15): Promise<HNComment[]> {
  const res = await fetch(`${ALGOLIA}/items/${storyId}`)
  const item: AlgoliaItem = await res.json()
  return (item.children ?? [])
    .filter(c => c.text && c.author)
    .slice(0, max)
    .map(c => ({ by: c.author, text: c.text, time: c.created_at_i }))
}

export async function fetchArticleText(url: string): Promise<string> {
  const res = await fetch(`https://r.jina.ai/${url}`, {
    headers: { Accept: 'text/plain' },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return cleanArticle(await res.text())
}

// Jina reader prefixes that appear at the top of every response
const JINA_META_PREFIXES = ['title:', 'url source:', 'published time:', 'markdown content:']

// Lines that contain nothing but UI chrome — matched after lowercasing and trimming
const NOISE_LINES = new Set([
  'advertisement', 'skip advertisement', 'skip ad', 'skip to content',
  'listen', 'listen to article', 'audio article',
  'subscribe', 'sign up', 'sign in', 'log in', 'log out',
  'share', 'share this', 'share article',
  'sponsored', 'sponsored content', 'promoted',
  'loading...', 'loading', 'continue reading', 'read more',
  'newsletter', 'follow us', 'related articles', 'related stories',
  'comments', 'leave a comment', 'view comments',
])

function cleanArticle(text: string): string {
  // Strip markdown formatting first
  let out = text
    .replace(/!\[.*?\]\(.*?\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*{1,2}([^*\n]+)\*{1,2}/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^[-*+]\s+/gm, '• ')
    .replace(/^>\s*/gm, '')

  // Remove noise lines
  out = out
    .split('\n')
    .filter(line => {
      const t = line.trim()
      if (!t) return true  // preserve blank lines (paragraph breaks)
      const lower = t.toLowerCase()
      if (JINA_META_PREFIXES.some(p => lower.startsWith(p))) return false
      if (NOISE_LINES.has(lower)) return false
      return true
    })
    .join('\n')

  return out.replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function stripHtml(html: string): string {
  return html
    .replace(/<p\s*\/?>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function timeAgo(ts: number): string {
  const diff = Math.floor(Date.now() / 1000) - ts
  if (diff < 3600) return `${Math.floor(diff / 60)}m`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`
  return `${Math.floor(diff / 86400)}d`
}

// Paginate body text with byte-accurate limits (SDK enforces UTF-8 byte counts).
// Both rebuildPageContainer and textContainerUpgrade share a 999-byte hard limit.
const _enc = new TextEncoder()
export const byteLen = (s: string) => _enc.encode(s).length

export function paginateArticle(text: string, firstByteLimit: number, restByteLimit: number): string[] {
  const pages: string[] = []
  let rest = text.trim()
  let isFirst = true
  while (rest.length > 0) {
    const limit = isFirst ? firstByteLimit : restByteLimit
    isFirst = false
    if (byteLen(rest) <= limit) { pages.push(rest); break }
    // Binary search: max chars where UTF-8 byte count ≤ limit
    let lo = 0, hi = Math.min(rest.length, limit)
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (byteLen(rest.slice(0, mid)) <= limit) lo = mid
      else hi = mid - 1
    }
    // Walk back to word boundary
    let cut = lo
    while (cut > 0 && rest[cut] !== ' ' && rest[cut] !== '\n') cut--
    if (cut === 0) cut = lo
    pages.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  return pages.length ? pages : ['No content available.']
}

export function formatStoryItem(story: HNStory, rank: number): string {
  const prefix = `${rank}. `
  const maxTitle = 48 - prefix.length
  const title = story.title.length > maxTitle
    ? story.title.slice(0, maxTitle - 1) + '…'
    : story.title
  return `${prefix}${title}`
}

export function getDomain(url?: string): string {
  if (!url) return 'news.ycombinator.com'
  try { return new URL(url).hostname.replace(/^www\./, '') }
  catch { return url.slice(0, 25) }
}
