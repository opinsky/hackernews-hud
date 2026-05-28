import {
  waitForEvenAppBridge,
  TextContainerProperty,
  ListContainerProperty,
  ListItemContainerProperty,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk'

import { getTextWidth, pxTruncate } from '@evenrealities/pretext'

import type { HNStory, HNComment } from './hn'
import {
  fetchTopStories,
  fetchStoryComments,
  fetchArticleText,
  stripHtml,
  timeAgo,
  paginateArticle,
  byteLen,
  formatStoryItem,
} from './hn'

// Pixel-accurate inner widths (container w − 2×(pad+border))
const BG_INNER_W = 576 - 2 * 4      // bgstories: w=576, pad=4, no border → 568px
const CONTENT_INNER_W = 576 - 2 * 6 // full-screen content: w=576, pad=6 → 564px

// Both rebuildPageContainer and textContainerUpgrade enforce a 999-byte UTF-8 limit.
const REBUILD_BYTE_LIMIT = 989
const UPGRADE_BYTE_LIMIT = 989

// ─── State ────────────────────────────────────────────────────────────────────

type Screen = 'loading' | 'news' | 'modal' | 'article' | 'comments'

const state = {
  screen: 'loading' as Screen,
  stories: [] as HNStory[],
  storyPage: 0,
  selectedStory: null as HNStory | null,
  contentPages: [] as string[],
  pageIndex: 0,
  initialized: false,
  busy: false,
}

// ─── Connectivity Diagnostics ──────────────────────────────────────────────────
console.log('--- HN AR CONNECTIVITY DIAGNOSTICS ---');
fetch('https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=1')
  .then(async (res) => {
    const data = await res.json();
    console.log('HN Algolia reachable! Hits count:', data.hits?.length);
  })
  .catch((err) => {
    console.error('HN Algolia connection test failed:', err);
  });

fetch('https://r.jina.ai/https://news.ycombinator.com')
  .then((res) => {
    console.log('Jina Reader reachable! Status:', res.status, 'StatusText:', res.statusText);
  })
  .catch((err) => {
    console.error('Jina Reader connection test failed:', err);
  });

// ─── Bridge ───────────────────────────────────────────────────────────────────

const bridge = await waitForEvenAppBridge()
bridge.onEvenHubEvent(handleEvent)

// ─── Boot ─────────────────────────────────────────────────────────────────────

await showLoading('Fetching Hacker News…')
try {
  console.log('Fetching top stories...');
  state.stories = await fetchTopStories(18)
  console.log(`Fetched ${state.stories.length} stories successfully.`);
  await showNewsList()
} catch (e) {
  console.error('Boot load failed:', e);
  await showLoading('Failed to load stories.\n\nCheck your connection.\nPress to retry.')
}

// ─── Event Handler ────────────────────────────────────────────────────────────

async function handleEvent(ev: {
  listEvent?: { currentSelectItemIndex?: number }
  textEvent?: { eventType?: number }
  sysEvent?: { eventType?: number }
}) {
  if (state.busy) return

  if (ev.listEvent) {
    const idx = ev.listEvent.currentSelectItemIndex ?? 0
    if (state.screen === 'news') {
      const hasPrev = state.storyPage > 0
      const nextIdx = hasPrev ? state.stories.length + 1 : state.stories.length
      if (hasPrev && idx === 0) {
        await run(loadPrevStories)
      } else if (idx === nextIdx) {
        await run(loadNextStories)
      } else {
        const storyIdx = hasPrev ? idx - 1 : idx
        state.selectedStory = state.stories[storyIdx] ?? null
        if (state.selectedStory) await run(() => showModal(state.selectedStory!))
      }
    } else if (state.screen === 'modal') {
      // Firmware handles list navigation — single press fires listEvent with chosen index
      if (idx === 0) await run(loadArticle)
      else if (idx === 1) await run(loadComments)
      else await run(showNewsList)
    }
    return
  }

  if (ev.textEvent) {
    return  // firmware handles internal scroll; page nav is via tap/2tap
  }

  if (ev.sysEvent) {
    const type = ev.sysEvent.eventType ?? 0
    if (type === 3) {
      if (state.screen === 'article' || state.screen === 'comments') {
        if (state.selectedStory) await run(() => showModal(state.selectedStory!))
      } else if (state.screen === 'modal') {
        await run(showNewsList)
      } else {
        await bridge.shutDownPageContainer(1)
      }
    } else if (type === 0) {
      if (state.screen === 'article' || state.screen === 'comments') {
        // Single tap: next page, or back to modal on last page
        if (state.pageIndex < state.contentPages.length - 1) {
          state.pageIndex++
          await run(flipPage)
        } else {
          if (state.selectedStory) await run(() => showModal(state.selectedStory!))
        }
      } else if (state.screen === 'loading') {
        await run(async () => {
          await showLoading('Retrying…')
          try {
            console.log('Retrying fetch stories...');
            state.stories = await fetchTopStories(18, state.storyPage)
            console.log(`Retried successfully: fetched ${state.stories.length} stories.`);
            await showNewsList()
          } catch (e) {
            console.error('Retry fetching failed:', e);
            await showLoading('Still failing.\n\nCheck connection.\nPress to retry.')
          }
        })
      }
    } else if (type === 7) {
      await bridge.shutDownPageContainer(0)
    }
  }
}

async function run(fn: () => Promise<void>) {
  state.busy = true
  try {
    await fn()
  } catch (e) {
    console.error('Action run failed:', e);
    state.screen = 'loading'
    try {
      await showLoading(`Error: ${String(e).slice(0, 120)}\n\nPress to retry.`)
    } catch (err) {
      console.error('Nested error trying to show failure screen:', err);
    }
  } finally {
    state.busy = false
  }
}

// ─── Content Loaders ─────────────────────────────────────────────────────────

async function loadArticle() {
  const story = state.selectedStory!
  await showLoading('Fetching article…')

  let rawText: string
  try {
    if (story.url) {
      console.log(`Fetching article text from URL: ${story.url}`);
      rawText = await fetchArticleText(story.url)
      console.log('Article text fetched successfully. Length:', rawText.length);
    } else if (story.text) {
      rawText = stripHtml(story.text)
    } else {
      rawText = 'No content available for this post.'
    }
  } catch (e) {
    console.error('Fetching article failed:', e);
    rawText = 'Could not fetch article content.'
  }

  const separator = '─────────────────────'
  const footer = '\n─ tap=next 2tap=back ─'
  // Compute body budget using worst-case prefix (most digits = widest prefix = shortest title)
  const worstPrefix = '99/99 · '
  const titleForBudget = pxTruncate(story.title, CONTENT_INNER_W - getTextWidth(worstPrefix))
  const headerForBudget = `${worstPrefix}${titleForBudget}\n${separator}\n`
  const bodyByteLimit = Math.max(80, REBUILD_BYTE_LIMIT - byteLen(headerForBudget) - byteLen(footer))
  const chunks = paginateArticle(rawText, bodyByteLimit, bodyByteLimit)

  state.contentPages = chunks.map((chunk, i) => {
    const prefix = `${i + 1}/${chunks.length} · `
    const title = pxTruncate(story.title, CONTENT_INNER_W - getTextWidth(prefix))
    return `${prefix}${title}\n${separator}\n${chunk}${footer}`
  })
  state.pageIndex = 0
  state.screen = 'article'
  await showContentPage()
}

async function loadComments() {
  const story = state.selectedStory!
  await showLoading('Loading comments…')

  let comments: HNComment[]
  try {
    console.log(`Loading comments for story: ${story.id}`);
    comments = await fetchStoryComments(story.id, 15)
    console.log(`Comments loaded successfully. Count: ${comments.length}`);
  } catch (e) {
    console.error('Loading comments failed:', e);
    comments = []
  }

  if (comments.length === 0) {
    state.contentPages = ['No comments yet.\n\nPress to go back.']
  } else {
    state.contentPages = comments.map((c, i) => {
      const header = `${c.by ?? '[deleted]'} · ${timeAgo(c.time)}\n─────────────────────\n`
      const nav = `\n─ ${i + 1}/${comments.length} · tap=next 2tap=back ─`
      const body = stripHtml(c.text ?? '')
      const pageByteLimit = i === 0 ? REBUILD_BYTE_LIMIT : UPGRADE_BYTE_LIMIT
      const bodyBudget = Math.max(4, pageByteLimit - byteLen(header) - byteLen(nav))
      const bodyBytes = byteLen(body)
      let truncated: string
      if (bodyBytes <= bodyBudget) {
        truncated = body
      } else {
        // binary search for max chars that fit in (bodyBudget - 3) bytes, leaving room for '…'
        const budget = bodyBudget - 3
        let lo = 0, hi = Math.min(body.length, budget)
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1
          if (byteLen(body.slice(0, mid)) <= budget) lo = mid
          else hi = mid - 1
        }
        truncated = body.slice(0, lo) + '…'
      }
      return header + truncated + nav
    })
  }
  state.pageIndex = 0
  state.screen = 'comments'
  await showContentPage()
}

async function loadNextStories() {
  await showLoading('Loading more stories…')
  try {
    console.log(`Loading next page of stories: page ${state.storyPage + 1}`);
    state.stories = await fetchTopStories(18, state.storyPage + 1)
    state.storyPage++
    console.log(`Page loaded successfully: ${state.stories.length} stories.`);
    await showNewsList()
  } catch (e) {
    console.error('Loading next stories failed:', e);
    await showLoading('Failed to load.\n\nPress to retry.')
  }
}

async function loadPrevStories() {
  await showLoading('Loading previous stories…')
  try {
    console.log(`Loading previous page of stories: page ${state.storyPage - 1}`);
    state.stories = await fetchTopStories(18, state.storyPage - 1)
    state.storyPage--
    console.log(`Page loaded successfully: ${state.stories.length} stories.`);
    await showNewsList()
  } catch (e) {
    console.error('Loading previous stories failed:', e);
    await showLoading('Failed to load.\n\nPress to retry.')
  }
}

// ─── Renderers ────────────────────────────────────────────────────────────────

async function showLoading(msg: string) {
  state.screen = 'loading'
  await renderPage({
    textObject: [
      txt(1, 'main', { y: 0, h: 280, capture: 1, pad: 8,
        content: `■ HACKER NEWS\n─────────────────────\n\n${msg}` }),
      txt(2, 'bgstories', { y: 280, h: 4, capture: 0, pad: 1, content: ' ' }),
    ],
    listObject: [
      lst(3, 'list', { y: 284, h: 4, capture: 0, pad: 1, items: [' '] }),
    ],
  })
}

async function showNewsList() {
  state.screen = 'news'
  const base = state.storyPage * 18
  const storyItems = state.stories.map((s, i) => formatStoryItem(s, base + i + 1))
  const hasPrev = state.storyPage > 0
  const items: string[] = hasPrev
    ? ['← Previous articles', ...storyItems, 'More articles →']
    : [...storyItems, 'More articles →']
  await renderPage({
    textObject: [
      txt(1, 'main', { y: 0, h: 36, capture: 0, pad: 4,
        content: '■ HACKER NEWS  ─  TOP STORIES' }),
      txt(2, 'bgstories', { y: 0, h: 0, capture: 0, pad: 0, content: '' }),
    ],
    listObject: [
      lst(3, 'list', { y: 36, h: 252, capture: 1, pad: 4, items }),
    ],
  })
}

async function showModal(story: HNStory) {
  state.screen = 'modal'

  // Background: selected story first with ▶ arrow, followed by 2 more
  const selectedIdx = Math.max(0, state.stories.findIndex(s => s.id === story.id))
  const bgText = state.stories
    .slice(selectedIdx, selectedIdx + 3)
    .map((s, i) => {
      const rank = selectedIdx + i + 1
      const prefix = i === 0 ? `▶ ${rank}. ` : `  ${rank}. `
      return prefix + pxTruncate(s.title, BG_INNER_W - getTextWidth(prefix))
    })
    .join('\n')

  const options = [
    story.url ? 'Read Article' : 'Read Post',
    `Read Comments (${story.numComments})`,
    '← Cancel',
  ]

  // Layout (pixel-calculated, fits within 288px screen):
  //   y=0   h=36   header
  //   y=36  h=89   bgstories (3 lines × 27px + 2×4px pad), ▶ on selected
  //   y=125 h=132  modal options list (3 items × 40px + 2×(4+2)px)
  //   total = 257px, 31px transparent at bottom
  await renderPage({
    textObject: [
      txt(1, 'main', { y: 0, h: 36, capture: 0, pad: 4,
        content: '■ HACKER NEWS  ─  TOP STORIES' }),
      txt(2, 'bgstories', { y: 36, h: 89, capture: 0, pad: 4,
        content: bgText }),
    ],
    listObject: [
      lst(3, 'list', {
        x: 16, y: 125, w: 544, h: 132,
        capture: 1, pad: 4, border: 2, borderColor: 15, radius: 2,
        items: options,
      }),
    ],
  })
}

async function showContentPage() {
  await renderPage({
    textObject: [
      txt(1, 'main', { y: 0, h: 288, capture: 1, pad: 6,
        content: state.contentPages[state.pageIndex] }),
      txt(2, 'bgstories', { y: 0, h: 0, capture: 0, pad: 0, content: '' }),
    ],
    listObject: [
      lst(3, 'list', { y: 0, h: 0, capture: 0, pad: 0, items: [''] }),
    ],
  })
}

async function flipPage() {
  await bridge.textContainerUpgrade(new TextContainerUpgrade({
    containerID: 1,
    containerName: 'main',
    content: state.contentPages[state.pageIndex],
    contentOffset: 0,
    contentLength: 0,
  }))
}

// ─── Container Factory Helpers ────────────────────────────────────────────────

interface TxtOpts {
  x?: number; y: number; w?: number; h: number
  capture: 0 | 1; pad: number; content: string
  border?: number; borderColor?: number; radius?: number
}

function txt(id: number, name: string, opts: TxtOpts): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: opts.x ?? 0,
    yPosition: opts.y,
    width: opts.w ?? 576,
    height: opts.h,
    borderWidth: opts.border ?? 0,
    borderColor: opts.borderColor ?? 0,
    borderRadius: opts.radius ?? 0,
    paddingLength: opts.pad,
    containerID: id,
    containerName: name,
    content: opts.content,
    isEventCapture: opts.capture,
  })
}

interface LstOpts {
  x?: number; y: number; w?: number; h: number
  capture: 0 | 1; pad: number; items: string[]
  border?: number; borderColor?: number; radius?: number
}

function lst(id: number, name: string, opts: LstOpts): ListContainerProperty {
  return new ListContainerProperty({
    xPosition: opts.x ?? 0,
    yPosition: opts.y,
    width: opts.w ?? 576,
    height: opts.h,
    borderWidth: opts.border ?? 0,
    borderColor: opts.borderColor ?? 0,
    borderRadius: opts.radius ?? 0,
    paddingLength: opts.pad,
    containerID: id,
    containerName: name,
    isEventCapture: opts.capture,
    itemContainer: new ListItemContainerProperty({
      itemCount: opts.items.length,
      itemWidth: 0,
      isItemSelectBorderEn: 1,
      itemName: opts.items,
    }),
  })
}

async function renderPage(containers: {
  textObject?: TextContainerProperty[]
  listObject?: ListContainerProperty[]
}) {
  const total =
    (containers.textObject?.length ?? 0) +
    (containers.listObject?.length ?? 0)

  if (!state.initialized) {
    console.log(`Calling createStartUpPageContainer with total containers: ${total}`);
    const result = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
      containerTotalNum: total,
      ...containers,
    }))
    console.log(`createStartUpPageContainer result: ${result}`);
    if (result !== 0) {
      console.error(`createStartUpPageContainer initialization failed: ${result}`);
    }
    state.initialized = true
  } else {
    console.log(`Calling rebuildPageContainer with total containers: ${total}`);
    const ok = await bridge.rebuildPageContainer(new RebuildPageContainer({
      containerTotalNum: total,
      ...containers,
    }))
    console.log(`rebuildPageContainer result: ${ok}`);
    if (!ok) {
      console.error('rebuildPageContainer failed payload:', JSON.stringify(containers));
      throw new Error(`rebuildPageContainer failed (content may exceed limit)`)
    }
  }
}
