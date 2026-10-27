import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  mainSidebar: [
    {
      type: 'category',
      label: 'Overview',
      items: [
        'overview/introduction',
        'overview/problem-statement',
        'overview/vision-and-objectives',
        'overview/ecosystem',
      ],
    },
    {
      type: 'category',
      label: 'Staking Platform',
      items: [
        'staking/introduction',
        'staking/architecture',
        'staking/pools-and-rewards',
        'staking/token-compatibility',
        'staking/nft-boosts',
        'staking/administrative-controls',
      ],
    },
    {
      type: 'category',
      label: 'Security',
      items: [
        'security/security-status',
        'security/risks-and-limitations',
      ],
    },
    {
      type: 'category',
      label: 'Hybrid Exchange',
      items: [
        'exchange/vision-and-features',
        'exchange/roadmap',
      ],
    },
    {
      type: 'category',
      label: 'Business & Tokenomics',
      items: [
        'business/tokenomics',
        'business/liquidpump-and-plh',
        'business/business-strategy',
      ],
    },
    {
      type: 'category',
      label: 'Roadmap & Community',
      items: [
        'community/roadmap',
        'community/project-team',
      ],
    },
  ],
};

export default sidebars;




