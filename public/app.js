'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let state = null;
let msgTimer = null;

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function esc(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function fmt(sec) {
  const s = Math.round(sec * 10) / 10;
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  const restStr = Number.isInteger(rest) ? String(rest).padStart(2, '0') : rest.toFixed(1).padStart(4, '0');
  return `${m}:${restStr}`;
}

function showMsg(text, isError = false) {
  const el = $('#msg');
  el.textContent = text;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => { el.hidden = true; }, isError ? 8000 : 3000);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

function refOptions(selectedId, excludeId) {
  const opts = state.cues
    .filter((c) => c.id !== excludeId)
    .map((c) => `<option value="${esc(c.id)}" ${c.id === selectedId ? 'selected' : ''}>${esc(c.name)}</option>`)
    .join('');
  return opts || '<option value="">（无其他提示）</option>';
}

function renderTimeline() {
  const el = $('#timeline');
  const summary = $('#conflict-summary');
  el.innerHTML = '';
  summary.innerHTML = '';

  const withTime = state.cues.filter((c) => c.computed);
  if (!withTime.length) {
    el.innerHTML = '<div class="tl-empty">暂无提示，请先新增。</div>';
    return;
  }

  const maxEnd = Math.max(...withTime.map((c) => c.computed.end), 1);
  const labelW = 120;
  const laneW = Math.max(el.clientWidth - labelW - 4, 300);
  const px = laneW / maxEnd;

  const inner = document.createElement('div');
  inner.className = 'tl-inner';
  inner.style.width = `${labelW + laneW}px`;

  // 刻度尺
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  const step = steps.find((s) => s * px >= 70) || steps[steps.length - 1];
  const ruler = document.createElement('div');
  ruler.className = 'tl-ruler';
  ruler.style.width = `${laneW}px`;
  for (let t = 0; t <= maxEnd; t += step) {
    const tick = document.createElement('div');
    tick.className = 'tl-tick';
    tick.style.left = `${t * px}px`;
    tick.textContent = fmt(t);
    ruler.appendChild(tick);
  }
  inner.appendChild(ruler);

  // 冲突提示 id 集合
  const conflictIds = new Set();
  for (const p of state.conflicts) { conflictIds.add(p.aId); conflictIds.add(p.bId); }

  // 每个通道一行
  for (const ch of state.channels) {
    const row = document.createElement('div');
    row.className = 'tl-row';

    const label = document.createElement('div');
    label.className = 'tl-label';
    label.textContent = ch;
    label.title = ch;
    row.appendChild(label);

    const lane = document.createElement('div');
    lane.className = 'tl-lane';

    // 冲突时段（左闭右开区间的重叠段）
    for (const r of state.conflictRanges[ch] || []) {
      const band = document.createElement('div');
      band.className = 'conflict-band';
      band.style.left = `${r.from * px}px`;
      band.style.width = `${Math.max((r.to - r.from) * px, 2)}px`;
      band.title = `冲突时段 ${fmt(r.from)} – ${fmt(r.to)}`;
      lane.appendChild(band);
    }

    for (const c of state.cues.filter((x) => x.channel === ch && x.computed)) {
      const bar = document.createElement('div');
      bar.className = 'cue-bar' + (conflictIds.has(c.id) ? ' in-conflict' : '');
      bar.style.left = `${c.computed.start * px}px`;
      bar.style.width = `${Math.max(c.duration * px, 3)}px`;
      bar.textContent = c.name;
      bar.title = `${c.name}\n通道: ${c.channel}\n${fmt(c.computed.start)} – ${fmt(c.computed.end)}（${c.duration} 秒）`;
      lane.appendChild(bar);
    }

    row.appendChild(lane);
    inner.appendChild(row);
  }

  el.appendChild(inner);

  // 冲突汇总
  if (state.conflicts.length) {
    summary.innerHTML = state.conflicts
      .map((p) => `<div class="item">⚠ 通道「${esc(p.channel)}」：「${esc(p.aName)}」与「${esc(p.bName)}」在 ${fmt(p.from)} – ${fmt(p.to)} 重叠</div>`)
      .join('');
  } else {
    summary.innerHTML = '<div class="ok">✓ 所有通道均无冲突</div>';
  }
}

function renderTable() {
  const tbody = $('#cue-table tbody');
  const conflictIds = new Set();
  for (const p of state.conflicts) { conflictIds.add(p.aId); conflictIds.add(p.bId); }

  tbody.innerHTML = state.cues.map((c) => {
    const isAfter = c.start.type === 'after';
    const params = isAfter
      ? `<div class="params">
           <select class="f-ref" title="跟随的提示">${refOptions(c.start.cueId, c.id)}</select>
           <span>结束后 +</span>
           <input class="f-delay" type="number" min="0" step="any" value="${c.start.delay}">
           <span>秒</span>
         </div>`
      : `<div class="params">
           <input class="f-seconds" type="number" min="0" step="any" value="${c.start.seconds}">
           <span>秒</span>
         </div>`;

    const badge = conflictIds.has(c.id)
      ? '<span class="badge conflict">通道冲突</span>'
      : '<span class="badge">正常</span>';

    return `<tr data-id="${esc(c.id)}">
      <td><input class="f-name" value="${esc(c.name)}"></td>
      <td><input class="f-channel" value="${esc(c.channel)}" list="channel-list"></td>
      <td><input class="f-duration" type="number" min="0.1" step="any" value="${c.duration}"></td>
      <td>
        <select class="f-type">
          <option value="fixed" ${isAfter ? '' : 'selected'}>固定秒数</option>
          <option value="after" ${isAfter ? 'selected' : ''}>跟随提示</option>
        </select>
      </td>
      <td class="params-cell">${params}</td>
      <td class="mono">${c.computed ? fmt(c.computed.start) : '—'}</td>
      <td class="mono">${c.computed ? fmt(c.computed.end) : '—'}</td>
      <td>${badge}</td>
      <td class="row-actions">
        <button class="btn-save">保存</button>
        <button class="danger btn-del">删除</button>
      </td>
    </tr>`;
  }).join('');
}

function renderAddFormRefs() {
  const sel = $('#add-form select[name="cueId"]');
  const prev = sel.value;
  sel.innerHTML = refOptions(prev, null);
  $('#channel-list').innerHTML = state.channels.map((ch) => `<option value="${esc(ch)}">`).join('');
}

function renderAll() {
  renderTimeline();
  renderTable();
  renderAddFormRefs();
}

async function refresh() {
  try {
    state = await api('/api/state');
    if (state.error) showMsg(`数据警告：${state.error}`, true);
    renderAll();
  } catch (e) {
    showMsg(e.message, true);
  }
}

// ---------------------------------------------------------------------------
// 交互
// ---------------------------------------------------------------------------

function readRowPayload(row) {
  const type = row.querySelector('.f-type').value;
  const payload = {
    name: row.querySelector('.f-name').value,
    channel: row.querySelector('.f-channel').value,
    duration: row.querySelector('.f-duration').value,
    start: type === 'fixed'
      ? { type: 'fixed', seconds: row.querySelector('.f-seconds').value }
      : {
          type: 'after',
          cueId: row.querySelector('.f-ref').value,
          delay: row.querySelector('.f-delay').value,
        },
  };
  return payload;
}

function bindEvents() {
  // 行内：切换开始方式时重渲染该行参数区
  $('#cue-table').addEventListener('change', (e) => {
    if (!e.target.classList.contains('f-type')) return;
    const row = e.target.closest('tr');
    const id = row.dataset.id;
    const cue = state.cues.find((c) => c.id === id);
    const type = e.target.value;
    // 构造一个临时 start 用于渲染参数区
    const tmp = {
      ...cue,
      start: type === 'fixed'
        ? { type: 'fixed', seconds: cue.computed ? cue.computed.start : 0 }
        : { type: 'after', cueId: (state.cues.find((c) => c.id !== id) || {}).id || '', delay: 0 },
    };
    const isAfter = type === 'after';
    row.querySelector('.params-cell').innerHTML = isAfter
      ? `<div class="params">
           <select class="f-ref" title="跟随的提示">${refOptions(tmp.start.cueId, id)}</select>
           <span>结束后 +</span>
           <input class="f-delay" type="number" min="0" step="any" value="0">
           <span>秒</span>
         </div>`
      : `<div class="params">
           <input class="f-seconds" type="number" min="0" step="any" value="${tmp.start.seconds}">
           <span>秒</span>
         </div>`;
  });

  $('#cue-table').addEventListener('click', async (e) => {
    const row = e.target.closest('tr');
    if (!row) return;
    const id = row.dataset.id;

    if (e.target.classList.contains('btn-save')) {
      try {
        state = await api(`/api/cues/${id}`, { method: 'PUT', body: JSON.stringify(readRowPayload(row)) });
        renderAll();
        showMsg('已保存并重算全部提示');
      } catch (err) {
        showMsg(err.message, true);
      }
    }

    if (e.target.classList.contains('btn-del')) {
      const cue = state.cues.find((c) => c.id === id);
      if (!confirm(`确定删除提示「${cue ? cue.name : id}」？`)) return;
      try {
        state = await api(`/api/cues/${id}`, { method: 'DELETE' });
        renderAll();
        showMsg('已删除');
      } catch (err) {
        showMsg(err.message, true);
      }
    }
  });

  // 新增表单：开始方式切换
  const form = $('#add-form');
  form.startType.addEventListener('change', () => {
    const isAfter = form.startType.value === 'after';
    $$('.when-fixed', form).forEach((el) => { el.hidden = isAfter; });
    $$('.when-after', form).forEach((el) => { el.hidden = !isAfter; });
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const isAfter = form.startType.value === 'after';
    const payload = {
      name: form.name.value,
      channel: form.channel.value,
      duration: form.duration.value,
      start: isAfter
        ? { type: 'after', cueId: form.cueId.value, delay: form.delay.value }
        : { type: 'fixed', seconds: form.seconds.value },
    };
    try {
      state = await api('/api/cues', { method: 'POST', body: JSON.stringify(payload) });
      renderAll();
      form.reset();
      form.seconds.value = 0;
      form.delay.value = 0;
      form.startType.dispatchEvent(new Event('change'));
      showMsg('已新增并重算全部提示');
    } catch (err) {
      showMsg(err.message, true);
    }
  });

  window.addEventListener('resize', () => { if (state) renderTimeline(); });
}

bindEvents();
refresh();
