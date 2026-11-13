import type { BrowShape, EyeShape, FaceSpec, FaceStyle, MouthShape } from '../core/expression';

/**
 * 屏幕上的那张脸。
 *
 * 只负责把 `FaceSpec` 画成几何图形，不做任何状态判断——判断在 `core/expression.ts`，
 * 那里能单测，这里只能靠眼睛看。drawing 用的都是 currentColor，
 * 换屏幕配色时脸会跟着走，不需要改这个文件。
 *
 * 坐标系统：viewBox 200×100，左眼中心 (58,45)、右眼 (142,45)、嘴中心 (100,76)。
 */
export function Face({
  spec,
  open,
  talking,
  variant = 'classic',
}: {
  spec: FaceSpec;
  /** 画风：同一张脸谱换一种画法，表情含义不变。 */
  variant?: FaceStyle;
  /** 嘴的张合 0–1；大于 0 时用椭圆覆盖嘴型。 */
  open: number;
  /** 它在说话：给嘴加一个开合动画，否则「会说话的脸」看起来是静止的。 */
  talking: boolean;
}) {
  return (
    <svg
      className={`face face-${variant}`}
      viewBox="0 0 200 100"
      role="img"
      aria-label={`伙伴表情：${spec.label}`}
      shapeRendering={variant === 'pixel' ? 'crispEdges' : undefined}
      data-face={spec.key}
    >
      <Brows shape={spec.brows} pixel={variant === 'pixel'} />
      {variant === 'round' ? (
        <RoundEyes shape={spec.eyes} />
      ) : variant === 'pixel' ? (
        <PixelEyes shape={spec.eyes} />
      ) : (
        <Eyes shape={spec.eyes} />
      )}
      {open > 0 ? (
        <ellipse
          className={talking ? 'mouth-talking' : undefined}
          cx="100"
          cy={76 + open * 2}
          rx={8 + open * 3}
          ry={3 + open * 9}
          fill="currentColor"
          opacity=".85"
        />
      ) : variant === 'pixel' ? (
        <PixelMouth shape={spec.mouth} />
      ) : (
        <Mouth shape={spec.mouth} />
      )}
      <g fill="currentColor" opacity={spec.blush * 0.32}>
        <rect x="27" y="67" width="22" height="7" rx="3" />
        <rect x="151" y="67" width="22" height="7" rx="3" />
      </g>
      <Extra kind={spec.extra} />
    </svg>
  );
}

function Eyes({ shape }: { shape: EyeShape }) {
  switch (shape) {
    // 弯成月牙：只有真笑的时候眼睛才这样，这也是最容易被认出来的一种。
    case 'happy':
      return (
        <g fill="none" stroke="currentColor" strokeWidth="10" strokeLinecap="round">
          <path d="M45 49 Q58 24 71 49" />
          <path d="M129 49 Q142 24 155 49" />
        </g>
      );
    case 'closed':
      return (
        <g stroke="currentColor" strokeWidth="8" strokeLinecap="round">
          <path d="M45 49h26" />
          <path d="M129 49h26" />
        </g>
      );
    // 压扁：眉头一压就是「在专心」，比任何文字都快。
    case 'narrow':
      return (
        <g fill="currentColor">
          <rect x="47" y="34" width="22" height="20" rx="7" />
          <rect x="131" y="34" width="22" height="20" rx="7" />
        </g>
      );
    case 'wide':
      return (
        <g fill="currentColor">
          <circle cx="58" cy="45" r="14" />
          <circle cx="142" cy="45" r="14" />
        </g>
      );
    // 一高一低：疑惑。两只眼不一样大，是这块屏上最省地方的「挑眉」。
    case 'side':
      return (
        <g fill="currentColor">
          <rect x="47" y="23" width="22" height="40" rx="8" />
          <rect x="131" y="33" width="22" height="20" rx="7" />
        </g>
      );
    default:
      // 只有这个走眨眼动画：闭着或弯着的眼再眨一次会闪成一条缝。
      return (
        <g className="eyes" fill="currentColor">
          <rect x="47" y="23" width="22" height="40" rx="8" />
          <rect x="131" y="23" width="22" height="40" rx="8" />
        </g>
      );
  }
}

/** 圆眼豆豆：眼睛都是圆，带一点高光，更像玩偶。 */
function RoundEyes({ shape }: { shape: EyeShape }) {
  const shine = (cx: number, cy: number) => (
    <circle cx={cx} cy={cy} r="3.5" fill="var(--screen-bg, #fff)" opacity=".85" />
  );
  switch (shape) {
    case 'happy':
      return (
        <g fill="none" stroke="currentColor" strokeWidth="12" strokeLinecap="round">
          <path d="M46 50 Q58 30 70 50" />
          <path d="M130 50 Q142 30 154 50" />
        </g>
      );
    case 'closed':
      return (
        <g fill="none" stroke="currentColor" strokeWidth="9" strokeLinecap="round">
          <path d="M46 46 Q58 54 70 46" />
          <path d="M130 46 Q142 54 154 46" />
        </g>
      );
    case 'narrow':
      return (
        <g fill="currentColor">
          <ellipse cx="58" cy="46" rx="14" ry="8" />
          <ellipse cx="142" cy="46" rx="14" ry="8" />
        </g>
      );
    case 'wide':
      return (
        <g>
          <g fill="currentColor">
            <circle cx="58" cy="45" r="18" />
            <circle cx="142" cy="45" r="18" />
          </g>
          {shine(64, 38)}
          {shine(148, 38)}
        </g>
      );
    case 'side':
      return (
        <g>
          <g fill="currentColor">
            <circle cx="58" cy="43" r="15" />
            <circle cx="142" cy="47" r="10" />
          </g>
          {shine(63, 37)}
        </g>
      );
    default:
      return (
        <g className="eyes">
          <g fill="currentColor">
            <circle cx="58" cy="45" r="15" />
            <circle cx="142" cy="45" r="15" />
          </g>
          {shine(63, 39)}
          {shine(147, 39)}
        </g>
      );
  }
}

/** 像素屏：全是方块和直线，像老式 LCD。 */
function PixelEyes({ shape }: { shape: EyeShape }) {
  const pair = (w: number, h: number, dyRight = 0, hRight = h) => (
    <g fill="currentColor">
      <rect x={58 - w / 2} y={45 - h / 2} width={w} height={h} />
      <rect x={142 - w / 2} y={45 - hRight / 2 + dyRight} width={w} height={hRight} />
    </g>
  );
  switch (shape) {
    case 'happy':
      return (
        <g fill="none" stroke="currentColor" strokeWidth="8" strokeLinecap="square">
          <path d="M46 50 L58 36 L70 50" />
          <path d="M130 50 L142 36 L154 50" />
        </g>
      );
    case 'closed':
      return pair(26, 7);
    case 'narrow':
      return pair(24, 12);
    case 'wide':
      return pair(28, 28);
    case 'side':
      return pair(20, 32, 6, 14);
    default:
      return <g className="eyes">{pair(20, 32)}</g>;
  }
}

function PixelMouth({ shape }: { shape: MouthShape }) {
  const line = (d: string) => (
    <path d={d} stroke="currentColor" strokeWidth="5" fill="none" strokeLinecap="square" />
  );
  switch (shape) {
    case 'grin':
      return <path d="M84 71 H116 V77 H110 V83 H90 V77 H84 Z" fill="currentColor" opacity=".8" />;
    case 'frown':
      return line('M88 82 V77 H112 V82');
    case 'flat':
      return line('M88 77 H112');
    case 'o':
      return (
        <rect
          x="93"
          y="70"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="4"
        />
      );
    case 'tiny':
      return <rect x="97" y="74" width="6" height="6" fill="currentColor" opacity=".8" />;
    default:
      return line('M88 72 V77 H112 V72');
  }
}

function Brows({ shape, pixel = false }: { shape: BrowShape; pixel?: boolean }) {
  if (shape === 'none') return null;
  const paths =
    shape === 'sad'
      ? ['M45 26 L71 17', 'M129 17 L155 26']
      : shape === 'raised'
        ? ['M45 17 L71 17', 'M131 19 L155 11']
        : ['M45 22 L71 17', 'M129 17 L155 22'];
  return (
    <g
      stroke="currentColor"
      strokeWidth="5"
      strokeLinecap={pixel ? 'square' : 'round'}
      opacity=".75"
      fill="none"
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </g>
  );
}

function Mouth({ shape }: { shape: MouthShape }) {
  switch (shape) {
    case 'grin':
      return (
        <path
          d="M84 71q16 20 32 0Z"
          fill="currentColor"
          fillOpacity=".28"
          stroke="currentColor"
          strokeWidth="5"
          strokeLinejoin="round"
        />
      );
    case 'frown':
      return (
        <path
          d="M88 80q12-12 24 0"
          stroke="currentColor"
          strokeWidth="5"
          fill="none"
          strokeLinecap="round"
        />
      );
    case 'flat':
      return (
        <path
          d="M88 76h24"
          stroke="currentColor"
          strokeWidth="5"
          fill="none"
          strokeLinecap="round"
        />
      );
    case 'o':
      return (
        <ellipse cx="100" cy="77" rx="7" ry="8" fill="none" stroke="currentColor" strokeWidth="4" />
      );
    case 'tiny':
      return <circle cx="100" cy="77" r="3" fill="currentColor" opacity=".8" />;
    default:
      return (
        <path
          d="M88 73q12 12 24 0"
          stroke="currentColor"
          strokeWidth="5"
          fill="none"
          strokeLinecap="round"
        />
      );
  }
}

/** 右上角那个小符号。位置固定，不随脸型动，避免每张脸都要重新调坐标。 */
function Extra({ kind }: { kind: FaceSpec['extra'] }) {
  switch (kind) {
    case 'zzz':
      return (
        <g fill="currentColor" opacity=".65">
          <text x="148" y="32" fontSize="14" fontWeight="500">
            z
          </text>
          <text x="161" y="20" fontSize="10" fontWeight="500">
            z
          </text>
        </g>
      );
    case 'question':
      return (
        <text x="149" y="30" fill="currentColor" opacity=".8" fontSize="22" fontWeight="500">
          ?
        </text>
      );
    case 'sweat':
      return (
        <path
          d="M0 0Q5 8 0 11Q-5 8 0 0Z"
          transform="translate(160 10)"
          fill="currentColor"
          opacity=".5"
        />
      );
    case 'heart':
      return (
        <path
          d="M0 4C-6-3-15 2-11 8L0 17L11 8C15 2 6-3 0 4Z"
          transform="translate(155 4) scale(.8)"
          fill="currentColor"
          opacity=".6"
        />
      );
    case 'think':
      return (
        <g fill="currentColor" opacity=".5">
          <circle cx="150" cy="27" r="3" />
          <circle cx="159" cy="19" r="2.4" />
          <circle cx="167" cy="12" r="1.8" />
        </g>
      );
    case 'note':
      return (
        <g fill="currentColor" opacity=".6">
          <circle cx="151" cy="25" r="3.4" />
          <circle cx="163" cy="22" r="3.4" />
          <path
            d="M154 25V11l12-3v14"
            stroke="currentColor"
            strokeWidth="2"
            fill="none"
            strokeLinecap="round"
          />
        </g>
      );
    default:
      return null;
  }
}
