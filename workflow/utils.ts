import puppeteer from '@cloudflare/puppeteer'
import * as cheerio from 'cheerio'
import { $fetch } from 'ofetch'

async function getContentFromJina(url: string, format: 'html' | 'markdown', selector?: { include?: string, exclude?: string }, JINA_KEY?: string) {
  const jinaHeaders: HeadersInit = {
    'X-Retain-Images': 'none',
    'X-Return-Format': format,
  }

  if (JINA_KEY) {
    jinaHeaders.Authorization = `Bearer ${JINA_KEY}`
  }

  if (selector?.include) {
    jinaHeaders['X-Target-Selector'] = selector.include
  }

  if (selector?.exclude) {
    jinaHeaders['X-Remove-Selector'] = selector.exclude
  }

  console.info('get content from jina', url)
  const content = await $fetch(`https://r.jina.ai/${url}`, {
    headers: jinaHeaders,
    timeout: 30000,
    parseResponse: txt => txt,
  })
  return content
}

async function getContentFromFirecrawl(url: string, format: 'html' | 'markdown', selector?: { include?: string, exclude?: string }, FIRECRAWL_KEY?: string) {
  const firecrawlHeaders: HeadersInit = {
    Authorization: `Bearer ${FIRECRAWL_KEY}`,
  }

  try {
    console.info('get content from firecrawl', url)
    const result = await $fetch<{ success: boolean, data: Record<string, string> }>('https://api.firecrawl.dev/v2/scrape', {
      method: 'POST',
      headers: firecrawlHeaders,
      timeout: 30000,
      body: {
        url,
        formats: [format],
        onlyMainContent: true,
        includeTags: selector?.include ? [selector.include] : undefined,
        excludeTags: selector?.exclude ? [selector.exclude] : undefined,
      },
    })
    if (result.success) {
      return result.data[format] || ''
    }
    else {
      console.error(`get content from firecrawl failed: ${url} ${result}`)
      return ''
    }
  }
  catch (error: Error | any) {
    console.error(`get content from firecrawl failed: ${url} ${error}`, error.data)
    return ''
  }
}

export async function getHackerNewsTopStories(today: string, { JINA_KEY, FIRECRAWL_KEY }: { JINA_KEY?: string, FIRECRAWL_KEY?: string }) {
  const url = `https://news.ycombinator.com/front?day=${today}`

  const html = await getContentFromJina(url, 'html', {}, JINA_KEY)

  let $ = cheerio.load(html)
  let items = $('.athing.submission')

  if (!items.length) {
    const html = await getContentFromFirecrawl(url, 'html', {}, FIRECRAWL_KEY)

    $ = cheerio.load(html)
    items = $('.athing.submission')
  }

  const stories: Story[] = items.map((i, el) => ({
    id: $(el).attr('id'),
    title: $(el).find('.titleline > a').text(),
    url: $(el).find('.titleline > a').attr('href'),
    hackerNewsUrl: `https://news.ycombinator.com/item?id=${$(el).attr('id')}`,
  })).get()

  return stories.filter(story => story.id && story.url)
}

export async function getHackerNewsStory(story: Story, maxTokens: number, { JINA_KEY, FIRECRAWL_KEY }: { JINA_KEY?: string, FIRECRAWL_KEY?: string }) {
  const headers: HeadersInit = {
    'X-Retain-Images': 'none',
  }

  if (JINA_KEY) {
    headers.Authorization = `Bearer ${JINA_KEY}`
  }

  const [article, comments] = await Promise.all([
    getContentFromJina(story.url!, 'markdown', {}, JINA_KEY)
      .catch(() => getContentFromFirecrawl(story.url!, 'markdown', {}, FIRECRAWL_KEY)),
    getContentFromJina(`https://news.ycombinator.com/item?id=${story.id}`, 'markdown', { include: '.comment-tree', exclude: '.navs' }, JINA_KEY)
      .catch(() => getContentFromFirecrawl(`https://news.ycombinator.com/item?id=${story.id}`, 'markdown', { include: '.comment-tree', exclude: '.navs' }, FIRECRAWL_KEY)),
  ])
  return [
    story.title
      ? `
<title>
${story.title}
</title>
`
      : '',
    article
      ? `
<article>
${article.substring(0, maxTokens * 5)}
</article>
`
      : '',
    comments
      ? `
<comments>
${comments.substring(0, maxTokens * 5)}
</comments>
`
      : '',
  ].filter(Boolean).join('\n\n---\n\n')
}

export async function concatAudioFiles(audioFiles: string[], BROWSER: Fetcher, { workerUrl }: { workerUrl: string }) {
  const browser = await puppeteer.launch(BROWSER)
  const page = await browser.newPage()
  await page.goto(`${workerUrl}/audio`)

  console.info('start concat audio files', audioFiles)
  const fileUrl = await page.evaluate(async (audioFiles) => {
    // 此处 JS 运行在浏览器中
    // @ts-expect-error 浏览器内的对象
    const blob = await concatAudioFilesOnBrowser(audioFiles)

    const result = new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onloadend = () => resolve(reader.result)
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
    return await result
  }, audioFiles) as string

  console.info('concat audio files result', fileUrl.substring(0, 100))

  await browser.close()

  const response = await fetch(fileUrl)
  return await response.blob()
}
