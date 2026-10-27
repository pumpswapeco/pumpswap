import React from 'react';

const allocations = [
  { label: 'Public sale', percentage: 36, color: '#20c997' },
  { label: 'Liquidity and listings', percentage: 20, color: '#339af0' },
  { label: 'Community and staking', percentage: 15, color: '#845ef7' },
  { label: 'Team and founders', percentage: 10, color: '#f59f00' },
  { label: 'Marketing and partnerships', percentage: 9, color: '#f06595' },
  { label: 'Treasury and ecosystem', percentage: 6, color: '#12b886' },
  { label: 'Advisors and KOLs', percentage: 4, color: '#868e96' },
];

const communityRewards = [
  {
    label: 'LP staking rewards',
    percentage: 40,
    amount: '300M PLH',
    color: '#20c997',
  },
  {
    label: 'PLH staking rewards',
    percentage: 40,
    amount: '300M PLH',
    color: '#845ef7',
  },
  {
    label: 'Airdrops and community',
    percentage: 20,
    amount: '150M PLH',
    color: '#339af0',
  },
];

function polarPoint(
  cx: number,
  cy: number,
  radius: number,
  angle: number,
) {
  const radians = ((angle - 90) * Math.PI) / 180;

  return {
    x: cx + radius * Math.cos(radians),
    y: cy + radius * Math.sin(radians),
  };
}

function pieSlice(startAngle: number, endAngle: number) {
  const start = polarPoint(100, 100, 82, startAngle);
  const end = polarPoint(100, 100, 82, endAngle);
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;

  return `M 100 100 L ${start.x} ${start.y} A 82 82 0 ${largeArc} 1 ${end.x} ${end.y} Z`;
}

export function PlhAllocationChart() {
  let angle = 0;

  return (
    <section
      className="tokenomics-chart"
      aria-labelledby="plh-allocation-title"
    >
      <div className="tokenomics-chart__heading">
        <div>
          <span className="tokenomics-eyebrow">PROPOSED TOKENOMICS</span>
          <h3 id="plh-allocation-title">PLH token allocation</h3>
          <p>Proposed distribution of the 5 billion PLH supply.</p>
        </div>

        <span className="tokenomics-total">5B PLH</span>
      </div>

      <div className="tokenomics-chart__layout">
        <svg
          className="tokenomics-pie"
          viewBox="0 0 200 200"
          role="img"
          aria-label="Pie chart showing the proposed PLH token allocation"
        >
          {allocations.map((item) => {
            const start = angle;
            const end = angle + item.percentage * 3.6;
            angle = end;

            return (
              <path
                key={item.label}
                d={pieSlice(start, end)}
                fill={item.color}
                stroke="var(--ifm-background-surface-color)"
                strokeWidth="1.5"
              />
            );
          })}

          <circle
            cx="100"
            cy="100"
            r="43"
            fill="var(--ifm-background-surface-color)"
          />

          <text
            x="100"
            y="96"
            textAnchor="middle"
            fill="var(--ifm-font-color-base)"
            fontSize="15"
            fontWeight="700"
          >
            5B
          </text>

          <text
            x="100"
            y="113"
            textAnchor="middle"
            fill="var(--ifm-font-color-secondary)"
            fontSize="9"
          >
            TOTAL PLH
          </text>
        </svg>

        <div className="tokenomics-legend">
          {allocations.map((item) => (
            <div className="tokenomics-legend__item" key={item.label}>
              <span
                className="tokenomics-legend__dot"
                style={{ backgroundColor: item.color }}
                aria-hidden="true"
              />

              <span className="tokenomics-legend__label">
                {item.label}
              </span>

              <strong>{item.percentage}%</strong>

              <span className="tokenomics-legend__amount">
                {(5_000_000_000 * item.percentage / 100).toLocaleString(
                  'en-US',
                )}{' '}
                PLH
              </span>
            </div>
          ))}
        </div>
      </div>

      <p className="tokenomics-disclaimer">
        Proposed allocation only. This chart does not confirm token
        deployment, wallet balances, vesting, or on-chain locks.
      </p>
    </section>
  );
}

export function PlhCirculationChart() {
  return (
    <section
      className="tokenomics-chart"
      aria-labelledby="plh-circulation-title"
    >
      <div className="tokenomics-chart__heading">
        <div>
          <span className="tokenomics-eyebrow">
            PROPOSED LAUNCH TARGET
          </span>

          <h3 id="plh-circulation-title">Initial supply breakdown</h3>

          <p>
            Target composition of the 5 billion PLH supply at launch.
          </p>
        </div>
      </div>

      <div
        className="tokenomics-supply-bar"
        role="img"
        aria-label="Proposed target: 40 percent initial circulation and 60 percent remaining supply"
      >
        <div className="tokenomics-supply-bar__circulating">
          40%
        </div>

        <div className="tokenomics-supply-bar__remaining">
          60%
        </div>
      </div>

      <div className="tokenomics-supply-legend">
        <div>
          <span
            className="tokenomics-legend__dot"
            style={{ backgroundColor: '#20c997' }}
          />

          <span>
            <strong>2 billion PLH</strong>
            <small>Initial circulation target</small>
          </span>
        </div>

        <div>
          <span
            className="tokenomics-legend__dot"
            style={{ backgroundColor: '#495057' }}
          />

          <span>
            <strong>3 billion PLH</strong>
            <small>Remaining supply target</small>
          </span>
        </div>
      </div>

      <p className="tokenomics-disclaimer">
        The remaining supply is not necessarily all locked. Actual
        circulating supply and enforceable restrictions must be verified
        at launch.
      </p>
    </section>
  );
}

export function PlhCommunityRewardsChart() {
  let angle = 0;

  return (
    <section
      className="tokenomics-chart"
      aria-labelledby="plh-community-rewards-title"
    >
      <div className="tokenomics-chart__heading">
        <div>
          <span className="tokenomics-eyebrow">
            PROPOSED REWARDS MODEL
          </span>

          <h3 id="plh-community-rewards-title">
            Community rewards allocation
          </h3>

          <p>
            Illustrative breakdown of the proposed 750 million PLH
            allocation.
          </p>
        </div>

        <span className="tokenomics-total">750M PLH</span>
      </div>

      <div className="tokenomics-chart__layout">
        <svg
          className="tokenomics-pie"
          viewBox="0 0 200 200"
          role="img"
          aria-label="Proposed community rewards allocation: 40 percent LP staking rewards, 40 percent PLH staking rewards, and 20 percent community incentives"
        >
          {communityRewards.map((item) => {
            const start = angle;
            const end = angle + item.percentage * 3.6;
            angle = end;

            return (
              <path
                key={item.label}
                d={pieSlice(start, end)}
                fill={item.color}
                stroke="var(--ifm-background-surface-color)"
                strokeWidth="1.5"
              />
            );
          })}

          <circle
            cx="100"
            cy="100"
            r="43"
            fill="var(--ifm-background-surface-color)"
          />

          <text
            x="100"
            y="96"
            textAnchor="middle"
            fill="var(--ifm-font-color-base)"
            fontSize="13"
            fontWeight="700"
          >
            750M
          </text>

          <text
            x="100"
            y="113"
            textAnchor="middle"
            fill="var(--ifm-font-color-secondary)"
            fontSize="9"
          >
            PLH REWARDS
          </text>
        </svg>

        <div className="tokenomics-legend">
          {communityRewards.map((item) => (
            <div className="tokenomics-legend__item" key={item.label}>
              <span
                className="tokenomics-legend__dot"
                style={{ backgroundColor: item.color }}
                aria-hidden="true"
              />

              <span className="tokenomics-legend__label">
                {item.label}
              </span>

              <strong>{item.percentage}%</strong>

              <span className="tokenomics-legend__amount">
                {item.amount}
              </span>
            </div>
          ))}
        </div>
      </div>

      <p className="tokenomics-disclaimer">
        Illustrative proposal only. These rewards have not been confirmed
        as funded or active. Actual allocations and release schedules may
        change.
      </p>
    </section>
  );
}
export function PlhTokenOverviewCards() {
  const stats = [
    {
      label: 'Maximum Supply Target',
      value: '5 Billion',
      detail: 'PLH proposed total supply',
      percentage: '100%',
    },
    {
      label: 'Initial Circulation Target',
      value: '2 Billion',
      detail: 'PLH targeted at launch',
      percentage: '40%',
    },
    {
      label: 'Remaining Supply Target',
      value: '3 Billion',
      detail: 'PLH outside initial circulation',
      percentage: '60%',
    },
  ];

  return (
    <div className="tokenomics-stat-grid">
      {stats.map((stat) => (
        <article className="tokenomics-stat-card" key={stat.label}>
          <span className="tokenomics-stat-card__label">
            {stat.label}
          </span>

          <strong className="tokenomics-stat-card__value">
            {stat.value}
          </strong>

          <span className="tokenomics-stat-card__detail">
            {stat.detail}
          </span>

          <span className="tokenomics-stat-card__percentage">
            {stat.percentage} of proposed supply
          </span>
        </article>
      ))}
    </div>
  );
}
