import { useId, useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { TrendSeries } from '../data/types';
import { STATE_LABEL, formatDate, formatMoney } from '../lib/format';
import { StateChip } from './primitives';

/** Round up to 1, 2 or 5 × 10^n so tick labels are whole, readable numbers. */
export function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

const W = 640;
const H = 180;
const PAD = { top: 16, right: 16, bottom: 28, left: 44 };

function fmt(v: number | null, unit: TrendSeries['unit']) {
  if (v === null) return 'No data';
  if (unit === 'usd') return formatMoney(v);
  if (unit === 'pct') return `${(v * 100).toFixed(1)}%`;
  return String(v);
}

/**
 * Single-series line chart. One axis, hairline grid, 2px line, crosshair + tooltip on hover
 * and keyboard (arrow keys). Null points are gaps, never zero. A table view is always available.
 */
export function TrendChart({ series, height = H }: { series: TrendSeries; height?: number }) {
  const [active, setActive] = useState<number | null>(null);
  const titleId = useId();
  const pts = series.points;
  const values = pts.map((p) => p.value).filter((v): v is number => v !== null);
  const hasData = values.length > 0;
  const dataMax = Math.max(0, ...values);
  const max = niceMax(dataMax);
  const innerW = W - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (pts.length === 1 ? innerW / 2 : (i / (pts.length - 1)) * innerW);
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH;

  const path = useMemo(() => {
    let d = '';
    let pen = false;
    pts.forEach((p, i) => {
      if (p.value === null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`;
      pen = true;
    });
    return d;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pts, max, height]);

  // An all-zero series gets a single $0 tick: no invented scale above the data.
  const ticks = dataMax === 0 ? [0] : [0, max / 2, max];

  function onMove(e: PointerEvent<SVGSVGElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.round(((px - PAD.left) / innerW) * (pts.length - 1));
    setActive(Math.min(pts.length - 1, Math.max(0, i)));
  }
  function onKey(e: KeyboardEvent<SVGSVGElement>) {
    if (e.key === 'ArrowRight') setActive((a) => Math.min(pts.length - 1, (a ?? -1) + 1));
    else if (e.key === 'ArrowLeft') setActive((a) => Math.max(0, (a ?? pts.length) - 1));
    else if (e.key === 'Escape') setActive(null);
    else return;
    e.preventDefault();
  }

  const a = active !== null ? pts[active] : null;

  return (
    <figure className="chart">
      <figcaption className="chart__cap">
        <span id={titleId} className="chart__title">
          {series.label}
        </span>
        <StateChip state={series.state} />
      </figcaption>
      <div className="chart__plot">
        <svg
          viewBox={`0 0 ${W} ${height}`}
          preserveAspectRatio="none"
          role="img"
          aria-labelledby={titleId}
          aria-describedby={`${titleId}-desc`}
          tabIndex={0}
          onPointerMove={onMove}
          onPointerLeave={() => setActive(null)}
          onKeyDown={onKey}
          onBlur={() => setActive(null)}
        >
          <desc id={`${titleId}-desc`}>
            {hasData
              ? `${series.period.label}. Values: ${pts.map((p) => `${formatDate(p.date)} ${fmt(p.value, series.unit)}`).join(', ')}.`
              : `${series.period.label}. ${STATE_LABEL[series.state]}: no daily values available.`}
          </desc>
          {ticks.map((t, i) => (
            <g key={i}>
              <line className="chart__grid" x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} />
              <text className="chart__tick" x={PAD.left - 8} y={y(t) + 4} textAnchor="end">
                {hasData ? fmt(t, series.unit) : ''}
              </text>
            </g>
          ))}
          <line className="chart__axis" x1={PAD.left} x2={W - PAD.right} y1={PAD.top + innerH} y2={PAD.top + innerH} />
          {pts.map((p, i) => (
            <text key={p.date} className="chart__tick" x={x(i)} y={height - 8} textAnchor="middle">
              {formatDate(p.date)}
            </text>
          ))}
          {hasData && <path className="chart__line" d={path} vectorEffect="non-scaling-stroke" />}
          {hasData &&
            pts.map((p, i) =>
              p.value === null ? null : (
                <circle key={i} className="chart__dot" cx={x(i)} cy={y(p.value)} r={active === i ? 4.5 : 0} vectorEffect="non-scaling-stroke" />
              ),
            )}
          {active !== null && (
            <line className="chart__cross" x1={x(active)} x2={x(active)} y1={PAD.top} y2={PAD.top + innerH} vectorEffect="non-scaling-stroke" />
          )}
        </svg>
        {!hasData && (
          <div className="chart__nodata">
            <StateChip state={series.state === 'verified' ? 'unknown' : series.state} />
            <span>No daily values from {series.source}.</span>
          </div>
        )}
        {a && (
          <div
            className="chart__tip"
            role="status"
            style={{ left: `${(x(active!) / W) * 100}%` }}
          >
            <span className="chart__tip-date">{formatDate(a.date)}</span>
            <strong>{fmt(a.value, series.unit)}</strong>
          </div>
        )}
      </div>
      <details className="chart__table">
        <summary>View as table</summary>
        <table className="table table--compact">
          <caption className="sr-only">{series.label}, {series.period.label}</caption>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col" className="num">{series.label}</th>
            </tr>
          </thead>
          <tbody>
            {pts.map((p) => (
              <tr key={p.date}>
                <td>{formatDate(p.date)}</td>
                <td className="num">{fmt(p.value, series.unit)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

/** 12-month relative-interest bars (single hue). Labelled as relative, never as volume. */
export function SeasonBars({ months, peak, launchBy, source }: { months: (number | null)[]; peak: string; launchBy: string; source: string }) {
  const names = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
  const full = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return (
    <figure className="season">
      <div className="season__bars" role="img" aria-label={`Relative interest by month. Peak ${peak}; launch by ${launchBy}. Source: ${source}.`}>
        {months.map((v, i) => (
          <div key={i} className="season__col" title={`${full[i]}: ${v ?? 'no data'}`}>
            <span
              className={`season__bar${full[i] === peak ? ' is-peak' : ''}${full[i] === launchBy ? ' is-launch' : ''}`}
              style={{ height: `${Math.max(4, v ?? 0)}%` }}
            />
            <span className="season__m" aria-hidden="true">
              {names[i]}
            </span>
          </div>
        ))}
      </div>
      <figcaption className="season__cap">
        Relative interest (100 = peak). Peak <strong>{peak}</strong>, launch by <strong>{launchBy}</strong>. {source}.
      </figcaption>
    </figure>
  );
}

/** Horizontal meter for a 0–100 score component. */
export function Meter({ label, value, weight, display }: { label: string; value: number; weight?: number; display?: string }) {
  return (
    <div className="meter">
      <div className="meter__row">
        <span>{label}</span>
        <span className="meter__val">
          {display ?? value}
          {weight !== undefined && weight > 0 && <span className="meter__w"> × {Math.round(weight * 100)}%</span>}
        </span>
      </div>
      <div className="meter__track" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value} aria-valuetext={display}>
        <span className="meter__fill" style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}
