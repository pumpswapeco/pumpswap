import Link from '@docusaurus/Link';

const links = [
  {
    label: 'Pumpswap Website',
    href: 'https://pumpswap.biz',
    icon: '↗',
  },
  {
    label: 'LiquidPump App',
    href: 'https://liquidpump.app',
    icon: '◈',
  },
  {
    label: 'Pumpswap on X',
    href: 'https://x.com/pumpswaps',
    icon: '𝕏',
  },
  {
    label: 'Pumpswap Telegram',
    href: 'https://t.me/pumpswapxchange',
    icon: '➤',
  },
  {
    label: 'Pumpswap on Medium',
    href: 'https://medium.com/@pumpswap/pumpswap-no-code-staking-platform-for-solana-projects-spl-token-2022-c7767e8594b4',
    icon: 'M',
  },
  {
    label: 'Pumpswap on GitHub',
    href: 'https://github.com/pumpswapeco/pumpswap',
    icon: '⌘',
  },
];

export default function SocialLinks() {
  return (
    <div className="pumpswap-social-links">
      {links.map((link) => (
        <Link
          key={link.label}
          href={link.href}
          className="pumpswap-social-link"
          aria-label={link.label}
          title={link.label}
          target="_blank"
          rel="noopener noreferrer"
        >
          <span aria-hidden="true">{link.icon}</span>
          <span>{link.label}</span>
        </Link>
      ))}
    </div>
  );
}



