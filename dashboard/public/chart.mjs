import { valid } from './core.mjs';

export function number(v, digits = 3) { return valid(v) ? v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '—'; }
export function usd(v) { return valid(v) ? '$' + number(v, 2) : '—'; }
const short = v => Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(1) + 'm' : Math.abs(v) >= 1000 ? (v / 1000).toFixed(0) + 'k' : Math.abs(v) < 0.1 && v !== 0 ? v.toPrecision(2) : v.toFixed(v < 10 ? 2 : 0);

export class HistoryChart {
  constructor(canvas, tooltip, onHover) {
    this.canvas = canvas; this.tooltip = tooltip; this.onHover = onHover; this.rows = []; this.metrics = []; this.hover = null;
    canvas.addEventListener('pointermove', e => {
      if (!this.rows.length || !this.plot) return;
      const rect = canvas.getBoundingClientRect(), x = e.clientX - rect.left;
      const { left, width } = this.plot;
      if (x < left || x > left + width) return this.clearHover();
      this.hover = Math.max(0, Math.min(this.rows.length - 1, Math.round((x - left) / width * (this.rows.length - 1))));
      this.draw(); this.showTooltip(); this.onHover(this.rows[this.hover]);
    });
    canvas.addEventListener('pointerleave', () => this.clearHover());
    canvas.addEventListener('blur', () => this.clearHover());
    canvas.addEventListener('keydown', e => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(e.key) || !this.rows.length) return;
      e.preventDefault();
      if (e.key === 'Escape') return this.clearHover();
      this.hover = e.key === 'Home' ? 0 : e.key === 'End' ? this.rows.length - 1 : Math.max(0, Math.min(this.rows.length - 1, (this.hover ?? this.rows.length - 1) + (e.key === 'ArrowLeft' ? -1 : 1)));
      this.draw(); this.showTooltip(); this.onHover(this.rows[this.hover]);
    });
    this.observer = new ResizeObserver(() => { this.draw(); if (this.hover !== null) this.showTooltip(); });
    this.observer.observe(canvas);
  }
  clearHover() { this.hover = null; this.tooltip.hidden = true; this.draw(); this.onHover(null); }
  setData(rows, metrics, options) { this.rows = rows; this.metrics = metrics; this.options = options; this.hover = null; this.tooltip.hidden = true; this.canvas.dataset.series = metrics.map(m => m.id).join(','); this.draw(); }
  piDetail() { return this.options?.mode === 'raw' && this.metrics.length === 1 && this.metrics[0].id === 'pi'; }
  series() {
    if (!this.metrics.length) return [];
    const series = this.piDetail() ? [
      { key: 'ma111', label: '111 日均线', color: '#db6851', money: true },
      { key: 'ma350x2', label: '350 日均线 × 2', color: '#388f86', money: true }
    ] : this.metrics.map((m, i) => ({ key: this.options.mode === 'percentile' ? 'p_' + m.id : m.id, rawKey: m.id, label: m.name, color: m.color, unit: m.unit, dash: i >= 6 ? [5, 3] : [] }));
    if (this.options.showPrice) series.push({ key: 'price', label: 'BTC 价格', color: getComputedStyle(document.documentElement).getPropertyValue('--btc').trim(), money: true, right: !this.piDetail() });
    return series;
  }
  draw() {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = Math.min(devicePixelRatio || 1, 2), w = rect.width, h = rect.height;
    this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr);
    const ctx = this.canvas.getContext('2d'); ctx.scale(dpr, dpr); ctx.clearRect(0, 0, w, h);
    if (!this.rows.length || !this.metrics.length) return;
    const style = getComputedStyle(document.documentElement), muted = style.getPropertyValue('--muted').trim(), grid = style.getPropertyValue('--grid').trim();
    const isPi = this.piDetail(), right = this.options.showPrice && !isPi, normalized = this.options.mode === 'percentile';
    const left = w < 500 ? 42 : 54, top = 23, width = w - left - (right ? (w < 500 ? 48 : 62) : 22), height = h - top - 31;
    this.plot = { left, top, width, height };
    const series = this.series();
    const scaleFor = (keys, isLog, fixed = false) => {
      const transform = v => isLog ? Math.log10(v) : v;
      const usable = v => valid(v) && (!isLog || v > 0);
      const values = this.rows.flatMap(r => keys.map(k => r[k])).filter(usable);
      if (!values.length) return null;
      let lo = values.reduce((a, v) => Math.min(a, v), Infinity), hi = values.reduce((a, v) => Math.max(a, v), -Infinity);
      if (!fixed && !isPi && this.metrics.length === 1) for (const level of this.metrics[0].levels) {
        // Always show the nearby reference lines without compressing a far-off range.
        if ((!isLog || level > 0) && level >= lo - Math.abs(lo) * .5 && level <= hi + Math.abs(hi)) { lo = Math.min(lo, level); hi = Math.max(hi, level); }
      }
      lo = transform(lo); hi = transform(hi);
      const pad = Math.max((hi - lo) * .11, Math.abs(hi) * .015, .03);
      lo = !isLog && lo >= 0 ? Math.max(0, lo - pad) : lo - pad; hi += pad;
      if (fixed) { lo = 0; hi = 100; }
      return { lo, hi, usable, y: v => top + height * (1 - (transform(v) - lo) / (hi - lo)), value: p => isLog ? 10 ** (hi - p * (hi - lo)) : hi - p * (hi - lo) };
    };
    const primary = scaleFor(series.filter(s => !s.right).map(s => s.key), !normalized && this.options.log, normalized);
    const secondary = right ? scaleFor(['price'], this.options.log) : null;
    this.scales = { primary, secondary };
    const x = i => left + (this.rows.length === 1 ? width / 2 : i / (this.rows.length - 1) * width);
    ctx.font = `${w < 500 ? 9 : 10}px -apple-system, "Segoe UI", sans-serif`;
    ctx.lineWidth = 1; ctx.strokeStyle = grid; ctx.fillStyle = muted;
    for (let j = 0; j <= 4; j++) {
      const yy = top + j * height / 4;
      ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(left + width, yy); ctx.stroke();
      ctx.textAlign = 'right'; if (primary) ctx.fillText((isPi ? '$' : '') + short(primary.value(j / 4)), left - 9, yy + 3);
      ctx.textAlign = 'left'; if (secondary) ctx.fillText('$' + short(secondary.value(j / 4)), left + width + 9, yy + 3);
    }
    ctx.textAlign = 'left'; ctx.fillText(isPi ? 'USD' : normalized ? '历史分位 0–100' : '原始数值', left, 12);
    if (right) { ctx.textAlign = 'right'; ctx.fillText('BTC / USD', left + width, 12); }
    const ticks = w < 500 ? 3 : 5;
    for (let i = 0; i <= ticks; i++) {
      const index = Math.round(i / ticks * (this.rows.length - 1)), date = this.rows[index].date;
      ctx.textAlign = i === 0 ? 'left' : i === ticks ? 'right' : 'center';
      ctx.fillText(this.rows.length > 800 ? date.slice(0, 7) : date.slice(5), x(index), h - 10);
    }
    ctx.save(); ctx.beginPath(); ctx.rect(left, top, width, height); ctx.clip();
    if (primary && !isPi && !normalized && this.metrics.length === 1) {
      this.metrics[0].levels.forEach((level, index) => {
        if (!primary.usable(level)) return;
        const yy = primary.y(level);
        if (yy < top || yy > top + height) return;
        ctx.setLineDash([4, 5]); ctx.strokeStyle = '#9aa5be80'; ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(left + width, yy); ctx.stroke(); ctx.setLineDash([]);
        ctx.textAlign = 'left'; ctx.fillStyle = muted; ctx.fillText(this.metrics[0].labels[index], left + 7, yy - 5);
      });
    }
    // Paint price first so the indicator stays legible in front of it.
    [...series].reverse().forEach(s => {
      const scale = s.right ? secondary : primary;
      if (!scale) return;
      ctx.strokeStyle = s.color; ctx.lineWidth = s.key === 'price' ? 1.35 : 1.85; ctx.globalAlpha = s.key === 'price' ? .7 : 1;
      ctx.setLineDash(s.dash || []);
      ctx.lineJoin = 'round'; ctx.beginPath(); let started = false;
      this.rows.forEach((r, i) => { if (!scale.usable(r[s.key])) { started = false; return; } const yy = scale.y(r[s.key]); if (!started) { ctx.moveTo(x(i), yy); started = true; } else ctx.lineTo(x(i), yy); });
      ctx.stroke(); ctx.globalAlpha = 1; ctx.setLineDash([]);
    });
    if (isPi && primary) this.rows.forEach((r, i) => { if (!r.piCross) return; ctx.fillStyle = '#db6851'; ctx.beginPath(); ctx.arc(x(i), primary.y(r.ma111), 4, 0, Math.PI * 2); ctx.fill(); });
    if (this.hover !== null && this.rows[this.hover]) {
      const xx = x(this.hover); ctx.strokeStyle = muted; ctx.globalAlpha = .5; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(xx, top); ctx.lineTo(xx, top + height); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
      for (const s of series) { const v = this.rows[this.hover][s.key], scale = s.right ? secondary : primary; if (!scale || !scale.usable(v)) continue; ctx.beginPath(); ctx.arc(xx, scale.y(v), 3, 0, Math.PI * 2); ctx.fillStyle = s.color; ctx.fill(); }
    }
    ctx.restore();
  }
  showTooltip() {
    const row = this.rows[this.hover]; if (!row || !this.plot) return;
    this.tooltip.replaceChildren();
    const title = document.createElement('strong'); title.textContent = row.date + ' · UTC'; this.tooltip.append(title);
    const series = this.series(); if (this.piDetail()) series.unshift({ key: 'pi', label: 'Pi 比率' });
    for (const s of series) {
      const line = document.createElement('div'); line.className = 'tip-line';
      const label = document.createElement('span'); label.textContent = s.label;
      const value = document.createElement('b'); value.textContent = s.money ? usd(row[s.key]) : number(row[s.rawKey || s.key]) + (s.unit || '') + (s.rawKey && this.options.mode === 'percentile' ? ' · P' + number(row[s.key], 1) : ''); line.append(label, value); this.tooltip.append(line);
    }
    if (this.metrics.length === 1 && this.metrics[0].id === 'mining') { const line = document.createElement('div'); line.className = 'tip-line'; line.textContent = '电费成本 ' + usd(row.cost); this.tooltip.append(line); }
    if (this.metrics.some(m => m.id === 'pi') && row.piCross) { const note = document.createElement('div'); note.className = 'tip-cross'; note.textContent = 'Pi 当日发生上穿'; this.tooltip.append(note); }
    this.tooltip.hidden = false;
    const { left, width } = this.plot, xx = left + this.hover / Math.max(1, this.rows.length - 1) * width;
    const max = this.canvas.clientWidth - this.tooltip.offsetWidth - 5;
    this.tooltip.style.left = Math.max(5, Math.min(max, xx > this.canvas.clientWidth / 2 ? xx - this.tooltip.offsetWidth - 14 : xx + 14)) + 'px';
    this.tooltip.style.top = '20px';
    this.canvas.setAttribute('aria-label', `${row.date}，${this.metrics.map(m => m.name + ' ' + number(row[m.id])).join('；')}。使用左右方向键查看日期。`);
  }
}
