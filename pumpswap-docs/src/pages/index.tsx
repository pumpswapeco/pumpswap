import SocialLinks from '@site/src/components/SocialLinks';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import styles from './index.module.css';

const features = [
  {
    title: 'No-Code Solana Staking',
    description:
      'Help Solana project founders create and manage staking pools without building all the underlying infrastructure themselves.',
    label: 'STAKING INFRASTRUCTURE',
    illustration: 'staking',
  },
  {
    title: 'Security-Focused Development',
    description:
      'Development priorities include token compatibility, administrative controls, automated testing, and independent security review.',
    label: 'SECURITY & VALIDATION',
    illustration: 'security',
  },
  {
    title: 'A Broader Ecosystem',
    description:
      'Pumpswap combines its staking infrastructure focus with a longer-term vision for a hybrid cryptocurrency exchange.',
    label: 'ECOSYSTEM VISION',
    illustration: 'ecosystem',
  },
];

function FeatureIllustration({ type }: { type: string }) {
  if (type === 'staking') {
    return (
      <svg viewBox="0 0 240 130" role="img" aria-label="Illustration of staking rewards">
        <defs>
          <linearGradient id="stakingGlow" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#55f2a4" />
            <stop offset="100%" stopColor="#13a86c" />
          </linearGradient>
        </defs>
        <circle cx="120" cy="65" r="51" fill="#143d30" />
        <circle cx="120" cy="65" r="37" fill="none" stroke="#55f2a4" strokeWidth="1.5" strokeDasharray="4 5" />
        <rect x="83" y="46" width="74" height="43" rx="9" fill="#0b2019" stroke="#55f2a4" strokeWidth="1.5" />
        <path d="M99 65 L113 77 L140 53" fill="none" stroke="url(#stakingGlow)" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="63" cy="39" r="8" fill="#55f2a4" opacity=".75" />
        <circle cx="177" cy="91" r="11" fill="#55f2a4" opacity=".25" stroke="#55f2a4" />
        <path d="M57 88 L69 88 M63 82 L63 94 M176 32 L176 46 M169 39 L183 39" stroke="#55f2a4" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }

  if (type === 'security') {
    return (
      <svg viewBox="0 0 240 130" role="img" aria-label="Illustration of security and protection">
        <path d="M120 15 L168 33 V64 C168 91 148 107 120 118 C92 107 72 91 72 64 V33 Z" fill="#143d30" stroke="#55f2a4" strokeWidth="2" />
        <path d="M120 28 L155 41 V64 C155 83 141 96 120 105 C99 96 85 83 85 64 V41 Z" fill="#0b2019" />
        <path d="M101 64 L114 77 L140 49" fill="none" stroke="#55f2a4" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="57" cy="48" r="5" fill="#55f2a4" />
        <circle cx="184" cy="78" r="7" fill="#55f2a4" opacity=".65" />
        <path d="M49 83 H67 M58 74 V92 M180 36 H196 M188 28 V44" stroke="#55f2a4" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 240 130" role="img" aria-label="Illustration of a connected ecosystem">
      <g stroke="#55f2a4" strokeWidth="1.5" opacity=".75">
        <path d="M120 64 L75 35 M120 64 L165 35 M120 64 L75 96 M120 64 L165 96" />
      </g>
      <circle cx="120" cy="64" r="25" fill="#143d30" stroke="#55f2a4" strokeWidth="2" />
      <circle cx="120" cy="64" r="12" fill="#55f2a4" opacity=".2" />
      <path d="M113 64 H127 M120 57 V71" stroke="#55f2a4" strokeWidth="3" strokeLinecap="round" />
      <circle cx="70" cy="31" r="17" fill="#0b2019" stroke="#55f2a4" strokeWidth="1.5" />
      <circle cx="170" cy="31" r="17" fill="#0b2019" stroke="#55f2a4" strokeWidth="1.5" />
      <circle cx="70" cy="99" r="17" fill="#0b2019" stroke="#55f2a4" strokeWidth="1.5" />
      <circle cx="170" cy="99" r="17" fill="#0b2019" stroke="#55f2a4" strokeWidth="1.5" />
      <path d="M64 31 H76 M70 25 V37 M164 31 H176 M170 25 V37 M64 99 H76 M70 93 V105 M164 99 H176 M170 93 V105" stroke="#55f2a4" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export default function Home() {
  return (
    <Layout
      title="Documentation"
      description="Official Pumpswap product documentation"
    >
      <header className={styles.hero}>
        <div className="container">
          <p className={styles.eyebrow}>SOLANA INFRASTRUCTURE · ECOSYSTEM</p>
          <h1>Pumpswap Documentation</h1>
          <p className={styles.subtitle}>
            Hybrid Exchange Ecosystem &amp; Solana Staking Infrastructure
          </p>
          <p>
            Explore the platform, understand its development status, and follow
            the roadmap for future products.
          </p>
          <div className={styles.buttons}>
            <Link
              className="button button--secondary button--lg"
              to="/docs/overview/introduction"
            >
              Explore Documentation
            </Link>
            <Link
              className="button button--outline button--secondary button--lg"
              to="/docs/staking/introduction"
            >
              Staking Platform
            </Link>
          </div>
        </div>
      </header>

      <main>
        <section className={styles.features}>
          <div className="container">
            <div className="row">
              {features.map((feature) => (
                <div className="col col--4" key={feature.title}>
                  <article className={styles.feature}>
                    <div className={styles.illustration}>
                      <FeatureIllustration type={feature.illustration} />
                    </div>
                    <p className={styles.featureLabel}>{feature.label}</p>
                    <h2>{feature.title}</h2>
                    <p>{feature.description}</p>
                  </article>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className={styles.statusSection}>
          <div className="container">
            <h2>Development Status</h2>
            <p>
              The staking platform is undergoing Solana Devnet development and
              testing. Independent security auditing and mainnet readiness
              remain important milestones.
            </p>
            <p>
              The hybrid exchange and Pumpswap Liquidity Hub (PLH) token sale
              are planned or upcoming initiatives, not features represented as
              already operational.
            </p>
            <Link to="/docs/security/security-status">
              Read the security status →
            </Link>
          </div>
        </section>

        <section className={styles.socialSection}>
          <h2>Join the Pumpswap Ecosystem</h2>
          <p>
            Follow our progress, explore the platform, and connect with the
            community.
          </p>
          <SocialLinks />
        </section>
      </main>
    </Layout>
  );
}




