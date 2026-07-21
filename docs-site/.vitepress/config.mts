import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'

// OpenPendle documentation site.
// Deployed as its own Cloudflare Pages project at https://docs.openpendle.com
// (root dir `docs-site`, build `npm run docs:build`, output `.vitepress/dist`).
// Kept fully static + self-contained (local search, no external services) to
// match the app's censorship-resistant, self-hostable posture. Mermaid diagrams
// render client-side via vitepress-plugin-mermaid.

const GITHUB = 'https://github.com/ggmatch-mod/open-pendle'
const APP = 'https://openpendle.com'

export default withMermaid(
  defineConfig({
    title: 'OpenPendle',
    description:
      'Documentation for OpenPendle — a static, open-source Pendle frontend for market discovery, fixed-yield tools, positions, and community-pool creation.',
    lang: 'en-US',
    cleanUrls: true,
    lastUpdated: true,
    ignoreDeadLinks: false,

    head: [
      ['link', { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
      ['meta', { name: 'theme-color', content: '#6366F1' }],
      ['meta', { property: 'og:title', content: 'OpenPendle Docs' }],
      ['meta', { property: 'og:description', content: 'How to use OpenPendle — the permissionless frontend for Pendle V2 markets.' }],
      ['meta', { property: 'og:type', content: 'website' }],
      ['meta', { name: 'twitter:card', content: 'summary' }],
    ],

    themeConfig: {
      logo: '/favicon.svg',
      siteTitle: 'OpenPendle Docs',

      nav: [
        { text: 'Quickstart', link: '/introduction/quickstart' },
        { text: 'Concepts', link: '/concepts/how-pendle-works' },
        { text: 'Guides', link: '/guides/connecting-a-wallet' },
        { text: 'Create', link: '/create/overview' },
        { text: 'Reference', link: '/reference/architecture' },
        { text: 'Launch app ↗', link: APP },
      ],

      sidebar: [
        {
          text: 'Introduction',
          collapsed: false,
          items: [
            { text: 'Quickstart', link: '/introduction/quickstart' },
            { text: 'What is OpenPendle', link: '/introduction/what-is-openpendle' },
            { text: 'Why OpenPendle', link: '/introduction/why-openpendle' },
          ],
        },
        {
          text: 'Understanding Pendle',
          collapsed: true,
          items: [
            { text: 'How Pendle works', link: '/concepts/how-pendle-works' },
            { text: 'Standardized Yield (SY)', link: '/concepts/standardized-yield' },
            { text: 'Principal Tokens (PT)', link: '/concepts/principal-tokens' },
            { text: 'Yield Tokens (YT)', link: '/concepts/yield-tokens' },
            { text: 'Liquidity & the AMM', link: '/concepts/liquidity-and-amm' },
            { text: 'Maturity & redemption', link: '/concepts/maturity' },
            { text: 'Anatomy of a pool', link: '/concepts/pool-anatomy' },
            { text: 'Community pools & incentives', link: '/concepts/community-pools' },
            { text: 'Glossary', link: '/concepts/glossary' },
          ],
        },
        {
          text: 'Using OpenPendle',
          collapsed: true,
          items: [
            { text: 'Connecting a wallet', link: '/guides/connecting-a-wallet' },
            { text: 'Browsing & networks', link: '/guides/browsing' },
            { text: 'Exploring markets', link: '/guides/exploring-markets' },
            { text: 'PT looping', link: '/guides/looping' },
            { text: 'Yield alerts', link: '/guides/yield-alerts' },
            { text: 'Opening a pool', link: '/guides/opening-a-pool' },
            { text: 'Buying PT (fixed yield)', link: '/guides/buying-pt' },
            { text: 'PT limit orders', link: '/guides/limit-orders' },
            { text: 'Buying YT (yield exposure)', link: '/guides/buying-yt' },
            { text: 'Minting & redeeming', link: '/guides/minting-redeeming' },
            { text: 'Providing liquidity', link: '/guides/providing-liquidity' },
            { text: 'Positions & rewards', link: '/guides/positions' },
            { text: 'Saved pools & privacy', link: '/guides/saved-pools' },
          ],
        },
        {
          text: 'Creating a pool',
          collapsed: true,
          items: [
            { text: 'Overview', link: '/create/overview' },
            { text: 'Creating an SY', link: '/create/standardized-yield' },
            { text: 'Deploying the market', link: '/create/deploying-a-market' },
            { text: 'Initializing the oracle', link: '/create/price-oracle' },
            { text: 'Pool incentives', link: '/create/incentives' },
          ],
        },
        {
          text: 'Reference',
          collapsed: true,
          items: [
            { text: 'How OpenPendle works', link: '/reference/architecture' },
            { text: 'Networks & contracts', link: '/reference/networks-and-contracts' },
            { text: 'Risks & disclosures', link: '/reference/risks' },
            { text: 'Self-hosting', link: '/reference/self-hosting' },
            { text: 'FAQ', link: '/reference/faq' },
          ],
        },
      ],

      socialLinks: [{ icon: 'github', link: GITHUB }],

      search: { provider: 'local' },

      editLink: {
        pattern: `${GITHUB}/edit/main/docs-site/:path`,
        text: 'Edit this page on GitHub',
      },

      footer: {
        message: 'Released under the GPL-3.0 License. Not affiliated with Pendle Finance.',
        copyright: 'OpenPendle is a gift to Pendle\'s community — built by ggmxbt.',
      },
    },
  }),
)
