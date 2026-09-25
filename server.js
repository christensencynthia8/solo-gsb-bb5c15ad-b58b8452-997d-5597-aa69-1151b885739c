'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'cues.json');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// 数据持久化（本地 JSON 文件）
// ---------------------------------------------------------------------------

function sampleCues() {
  const id = () => crypto.randomUUID();
  const lightOpen = id();
  const musicOpen = id();
  const lightAct1 = id();
  return [
    { id: lightOpen, name: '开场灯光', channel: '灯光', duration: 30, start: { type: 'fixed', seconds: 0 } },
    { id: musicOpen, name: '开场音乐', channel: '音响', duration: 45, start: { type: 'after', cueId: lightOpen, delay: 0 } },
    { id: lightAct1, name: '第一幕灯效', channel: '灯光', duration: 60, start: { type: 'after', cueId: musicOpen, delay: 5 } },
    { id: id(), name: '幕布升起', channel: '机械', duration: 20, start: { type: 'fixed', seconds: 10 } },
    // 故意与「第一幕灯效」在灯光通道上重叠，用于演示冲突标注（允许保留，供排练调整）
    { id: id(), name: '特殊灯效(待调整)', channel: '灯光', duration: 30, start: { type: 'fixed', seconds: 100 } },
  ];
}

function ensureDataFile() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ cues: sampleCues() }, null, 2));
  }
}

function loadCues() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return Array.isArray(raw.cues) ? raw.cues : [];
  } catch {
    return [];
  }
}

function saveCues(cues) {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ cues }, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

// ---------------------------------------------------------------------------
// 调度计算：固定秒数 或 「某提示结束后 + 延迟」；检测缺失引用与循环依赖
// ---------------------------------------------------------------------------

function computeSchedule(cues) {
  const byId = new Map(cues.map((c) => [c.id, c]));
  const computed = new Map(); // id -> { start, end }
  const state = new Map(); // id -> 'visiting' | 'done'

  function visit(cue, trail) {
    const st = state.get(cue.id);
    if (st === 'done') return computed.get(cue.id).start;
    if (st === 'visiting') {
      const names = [...trail, cue.id].map((id) => `「${(byId.get(id) || {}).name || id}」`);
      throw new Error(`检测到循环依赖: ${names.join(' → ')}`);
    }
    state.set(cue.id, 'visiting');

    let start;
    if (cue.start && cue.start.type === 'fixed') {
      start = cue.start.seconds;
    } else if (cue.start && cue.start.type === 'after') {
      const ref = byId.get(cue.start.cueId);
      if (!ref) throw new Error(`提示「${cue.name}」跟随的提示不存在（引用 ${cue.start.cueId}）`);
      const refStart = visit(ref, [...trail, cue.id]);
      start = refStart + ref.duration + cue.start.delay;
    } else {
      throw new Error(`提示「${cue.name}」的开始方式无效`);
    }

    computed.set(cue.id, { start, end: start + cue.duration });
    state.set(cue.id, 'done');
    return start;
  }

  for (const cue of cues) visit(cue, []);
  return computed;
}

// 返回错误消息或 null
function scheduleError(cues) {
  try {
    computeSchedule(cues);
    return null;
  } catch (e) {
    return e.message;
  }
}

// ---------------------------------------------------------------------------
// 冲突检测：同一通道上按左闭右开 [start, end) 判定重叠，首尾相接不算冲突
// ---------------------------------------------------------------------------

function findConflicts(cues, computed) {
  const byChannel = new Map();
  for (const c of cues) {
    const t = computed.get(c.id);
    if (!t) continue;
    if (!byChannel.has(c.channel)) byChannel.set(c.channel, []);
    byChannel.get(c.channel).push({ id: c.id, name: c.name, start: t.start, end: t.end });
  }

  const pairs = [];
  const rangesByChannel = {};

  for (const [channel, list] of byChannel) {
    list.sort((a, b) => a.start - b.start || a.end - b.end);
    const ranges = [];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (b.start >= a.end) break; // 左闭右开：b.start === a.end 为首尾相接，不冲突
        const from = Math.max(a.start, b.start);
        const to = Math.min(a.end, b.end);
        pairs.push({ channel, aId: a.id, bId: b.id, aName: a.name, bName: b.name, from, to });
        ranges.push({ from, to });
      }
    }
    // 合并本通道上的冲突时段
    ranges.sort((x, y) => x.from - y.from || x.to - y.to);
    const merged = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
      else merged.push({ ...r });
    }
    if (merged.length) rangesByChannel[channel] = merged;
  }

  return { pairs, rangesByChannel };
}

function buildState(cues) {
  let computed;
  let error = null;
  try {
    computed = computeSchedule(cues);
  } catch (e) {
    error = e.message;
    computed = new Map();
  }
  const conflicts = findConflicts(cues, computed);
  return {
    error,
    cues: cues.map((c) => ({ ...c, computed: computed.get(c.id) || null })),
    channels: [...new Set(cues.map((c) => c.channel))],
    conflicts: conflicts.pairs,
    conflictRanges: conflicts.rangesByChannel,
  };
}

// ---------------------------------------------------------------------------
// 输入校验
// ---------------------------------------------------------------------------

function validateCueInput(body) {
  const errors = [];
  const cue = {};

  if (typeof body.name !== 'string' || !body.name.trim()) errors.push('名称不能为空');
  else cue.name = body.name.trim();

  if (typeof body.channel !== 'string' || !body.channel.trim()) errors.push('设备通道不能为空');
  else cue.channel = body.channel.trim();

  const duration = Number(body.duration);
  if (!Number.isFinite(duration) || duration <= 0) errors.push('持续秒数必须为正数');
  else cue.duration = duration;

  const s = body.start || {};
  if (s.type === 'fixed') {
    const seconds = Number(s.seconds);
    if (!Number.isFinite(seconds) || seconds < 0) errors.push('固定开始秒数必须为非负数');
    else cue.start = { type: 'fixed', seconds };
  } else if (s.type === 'after') {
    if (typeof s.cueId !== 'string' || !s.cueId) {
      errors.push('必须选择所跟随的提示');
    } else {
      const delay = Number(s.delay);
      if (!Number.isFinite(delay) || delay < 0) errors.push('延迟秒数必须为非负数');
      else cue.start = { type: 'after', cueId: s.cueId, delay };
    }
  } else {
    errors.push('开始方式必须为 fixed（固定秒数）或 after（跟随提示）');
  }

  return { errors, cue };
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

app.get('/api/state', (req, res) => {
  res.json(buildState(loadCues()));
});

app.post('/api/cues', (req, res) => {
  const { errors, cue } = validateCueInput(req.body || {});
  if (errors.length) return res.status(400).json({ error: errors.join('；') });

  cue.id = crypto.randomUUID();
  const cues = [...loadCues(), cue];

  const err = scheduleError(cues); // 拒绝不存在的引用与循环依赖
  if (err) return res.status(400).json({ error: err });

  saveCues(cues);
  res.status(201).json(buildState(cues));
});

app.put('/api/cues/:id', (req, res) => {
  const cues = loadCues();
  const idx = cues.findIndex((c) => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '提示不存在' });

  const { errors, cue } = validateCueInput(req.body || {});
  if (errors.length) return res.status(400).json({ error: errors.join('；') });

  cue.id = req.params.id;
  const next = cues.slice();
  next[idx] = cue;

  const err = scheduleError(next); // 重算全部后继提示；拒绝不存在的引用与循环依赖
  if (err) return res.status(400).json({ error: err });

  saveCues(next);
  res.json(buildState(next));
});

app.delete('/api/cues/:id', (req, res) => {
  const cues = loadCues();
  const target = cues.find((c) => c.id === req.params.id);
  if (!target) return res.status(404).json({ error: '提示不存在' });

  const dependents = cues.filter((c) => c.start && c.start.type === 'after' && c.start.cueId === req.params.id);
  if (dependents.length) {
    return res.status(400).json({ error: `无法删除：${dependents.map((d) => `「${d.name}」`).join('、')} 跟随此提示，请先调整它们的开始方式` });
  }

  saveCues(cues.filter((c) => c.id !== req.params.id));
  res.json(buildState(loadCues()));
});

// ---------------------------------------------------------------------------

ensureDataFile();
app.listen(PORT, () => {
  console.log(`演出提示单服务已启动: http://localhost:${PORT}`);
  console.log(`数据文件: ${DATA_FILE}`);
});
