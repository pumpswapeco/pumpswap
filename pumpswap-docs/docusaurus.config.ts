import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  markdown: {
    mermaid: true,
  },
  title: 'Pumpswap',
  tagline: 'Hybrid Exchange Ecosystem & Solana Staking Infrastructure',
  favicon: 'img/favicon.ico',
  future: {v4: false},
  url: 'https://doc.pumpswap.biz',
  baseUrl: '/',
  organizationName: 'pumpswapeco',
  projectName: 'pumpswap',
  onBrokenLinks: 'throw',
  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },
  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
        },
        blog: {
          showReadingTime: true,
          blogTitle: 'Pumpswap Updates',
          blogDescription: 'Product development and ecosystem updates.',
        },
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],
  themes: ['@docusaurus/theme-mermaid'],
  themeConfig: {
    image: 'img/docusaurus-social-card.jpg',
    colorMode: {
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'Pumpswap',
      logo: {
        alt: 'Pumpswap logo',
        src: 'img/pumpswap-logo.png',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'mainSidebar',
          position: 'left',
          label: 'Documentation',
        },
        {
          to: '/blog',
          label: 'Updates',
          position: 'left',
        },
        {
          href: 'https://pumpswap.biz/',
          label: 'Official Website',
          position: 'right',
        },
        {
          href: 'https://liquidpump.app/',
          label: 'App',
          position: 'right',
        },
        {
          href: 'https://x.com/pumpswaps',
          label: 'X',
          position: 'right',
        },
        {
          href: 'https://t.me/pumpswapxchange',
          label: 'Telegram',
          position: 'right',
        },
        {
          href: 'https://pumpswap.medium.com/',
          label: 'Medium',
          position: 'right',
        },
        {
          href: 'https://github.com/pumpswapeco/pumpswap',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Documentation',
          items: [
            {
              label: 'Overview',
              to: '/docs/overview/introduction',
            },
            {
              label: 'Staking Platform',
              to: '/docs/staking/introduction',
            },
            {
              label: 'Security',
              to: '/docs/security/security-status',
            },
            {
              label: 'Tokenomics',
              to: '/docs/business/tokenomics',
            },
          ],
        },
        {
          title: 'Ecosystem',
          items: [
            {
              label: 'Official Website',
              href: 'https://pumpswap.biz/',
            },
            {
              label: 'LiquidPump Website',
              href: 'https://liquidpump.app/',
            },
            {
              label: 'GitHub',
              href: 'https://github.com/pumpswapeco/pumpswap',
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} Pumpswap.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
