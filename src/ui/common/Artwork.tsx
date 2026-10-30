import { useId } from 'react';

// Original dimensional artwork: an interlocking cobalt ring and coral ribbon
// with floating spheres. Pure SVG so it stays crisp and adds no image weight.
export function Sculpture({ className, compact = false }: { className?: string; compact?: boolean }) {
  const uid = useId().replace(/:/g, '');
  const id = (name: string) => `${name}-${uid}`;
  const url = (name: string) => `url(#${id(name)})`;
  return (
    <svg className={className} viewBox="0 0 600 380" aria-hidden="true" focusable="false" preserveAspectRatio="xMidYMid slice">
      <defs>
        <radialGradient id={id('sb')} cx="0.34" cy="0.3" r="0.75">
          <stop offset="0" stopColor="#B9CEFF" />
          <stop offset="0.3" stopColor="#3D74FF" />
          <stop offset="0.75" stopColor="#0A3BD6" />
          <stop offset="1" stopColor="#0A1C7A" />
        </radialGradient>
        <radialGradient id={id('sc')} cx="0.34" cy="0.3" r="0.75">
          <stop offset="0" stopColor="#FFEBDD" />
          <stop offset="0.3" stopColor="#FF9F82" />
          <stop offset="0.72" stopColor="#FF6B48" />
          <stop offset="1" stopColor="#B83A26" />
        </radialGradient>
        <linearGradient id={id('rb')} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7FA6FF" />
          <stop offset="0.45" stopColor="#0052FF" />
          <stop offset="1" stopColor="#0B248F" />
        </linearGradient>
        <linearGradient id={id('rc')} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#FFD3B7" />
          <stop offset="0.35" stopColor="#FF8D6E" />
          <stop offset="0.7" stopColor="#F2603F" />
          <stop offset="1" stopColor="#FFB79A" />
        </linearGradient>
        <radialGradient id={id('glow')} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#FFB79A" stopOpacity="0.55" />
          <stop offset="1" stopColor="#FFB79A" stopOpacity="0" />
        </radialGradient>
        <filter id={id('blur')} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="10" />
        </filter>
        <clipPath id={id('front')}>
          <rect x="300" y="200" width="300" height="200" />
        </clipPath>
      </defs>

      <circle cx="380" cy="200" r="210" fill={url('glow')} />
      {!compact && <circle cx="470" cy="120" r="150" fill="#FFD3B7" opacity="0.18" />}

      {/* shadows */}
      <ellipse cx="320" cy="340" rx="190" ry="22" fill="#061A6B" opacity="0.35" filter={url('blur')} />

      {/* back of the ring */}
      <g transform="rotate(-24 310 190)">
        <ellipse cx="310" cy="190" rx="118" ry="132" fill="none" stroke={url('rb')} strokeWidth="54" />
        <ellipse cx="310" cy="190" rx="132" ry="146" fill="none" stroke="#fff" strokeOpacity="0.28" strokeWidth="5" />
      </g>

      {/* coral ribbon */}
      <path
        d="M 40 330 C 150 300, 170 120, 290 120 S 430 300, 520 250 S 600 110, 560 60"
        fill="none"
        stroke={url('rc')}
        strokeWidth="60"
        strokeLinecap="round"
      />
      <path
        d="M 40 312 C 150 282, 170 102, 290 102 S 430 282, 520 232 S 590 100, 556 52"
        fill="none"
        stroke="#fff"
        strokeOpacity="0.4"
        strokeWidth="7"
        strokeLinecap="round"
      />

      {/* front of the ring passes over the ribbon */}
      <g clipPath={url('front')}>
        <g transform="rotate(-24 310 190)">
          <ellipse cx="310" cy="190" rx="118" ry="132" fill="none" stroke={url('rb')} strokeWidth="54" />
          <ellipse cx="310" cy="190" rx="132" ry="146" fill="none" stroke="#fff" strokeOpacity="0.28" strokeWidth="5" />
        </g>
      </g>

      {/* spheres */}
      <circle cx="448" cy="62" r="30" fill={url('sb')} />
      <circle cx="186" cy="74" r="22" fill={url('sc')} />
      <circle cx="512" cy="300" r="34" fill={url('sc')} />
      <circle cx="118" cy="214" r="15" fill={url('sb')} />
      <circle cx="372" cy="338" r="18" fill={url('sb')} />
      <circle cx="560" cy="170" r="9" fill={url('sc')} />
      {!compact && <circle cx="250" cy="300" r="11" fill={url('sc')} />}
    </svg>
  );
}

export function Logo() {
  return (
    <span className="logo" aria-hidden="true">
      <span className="logo-c">C</span>
      <span className="logo-l">L</span>
    </span>
  );
}
