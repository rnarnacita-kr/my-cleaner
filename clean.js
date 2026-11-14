/* clean.js — rules/<파일 이름>.json 의 처방(do)을 읽어 표를 정리한다.
 * 처방 값(조직명, 기준 시각, 숫자 기준 등)은 이 파일에 없다. 모두 처방 파일에서 온다.
 * 이 파일은 브라우저 안에서만 돈다. 어디로도 데이터를 보내지 않는다. */
(function (root) {
  "use strict";

  /* 처방 종류별 실행 순서: 형식 맞추기 → 표기 → 채우기 → 중복 → 검사 */
  const PHASE = {
    keep: 0, trim: 1, id_format: 1, date: 1, time: 1, number: 1,
    map: 2, set_value_when: 2.5, clear_exact_times: 2.6, fill_from_neighbors: 3, recompute_from_times: 3.5, dedupe_exact: 4, flag_key_conflict: 5,
    flag_invalid: 6, pair_check: 6, range_check: 6, sum_check: 6,
    judgment_check: 6, flag_blank: 6, flag_blank_when: 6,
    flag_record_when: 6, flag_value_when: 6, night_check: 6, flag_blip: 6
  };
  const ACTION_LABEL = { fix: "고침", flag: "표시", delete: "지움", keep: "그대로" };

  /* ---------- 작은 도구 ---------- */
  const isBlank = v => v === null || v === undefined || (typeof v === "string" && v.trim() === "");
  const pad = n => String(n).padStart(2, "0");
  const hhmm = m => { m = ((m % 1440) + 1440) % 1440; return pad(Math.floor(m / 60)) + ":" + pad(m % 60); };
  const r2 = x => Math.round(x * 100) / 100;
  const ov = (a, b, c, d) => Math.max(0, Math.min(b, d) - Math.max(a, c));
  const show = v => isBlank(v) ? "(빈칸)" : (typeof v === "number" ? String(r2(v)) : String(v));
  const DAY = 86400000, EPOCH = Date.UTC(1899, 11, 30);

  function validYMD(y, m, d) {
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  }
  const isoOf = (y, m, d) => y + "-" + pad(m) + "-" + pad(d);
  function serialToISO(n) {
    const t = new Date(EPOCH + Math.floor(n) * DAY);
    return isoOf(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
  }
  function isoToSerial(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    return (Date.UTC(y, m - 1, d) - EPOCH) / DAY;
  }
  const isISO = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && validYMD(+v.slice(0, 4), +v.slice(5, 7), +v.slice(8, 10));
  const isHHMM = v => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
  const minutesOf = v => isHHMM(v) ? (+v.slice(0, 2)) * 60 + (+v.slice(3, 5)) : null;

  /* 날짜 읽기: {iso, cell} | {invalid:true} | null(못 읽음) */
  function parseDate(v, p) {
    if (typeof v === "number") {
      if (v > 19000000 && v < 21000000) { const s = String(Math.round(v)); return mk(+s.slice(0, 4), +s.slice(4, 6), +s.slice(6, 8), false); }
      return { iso: serialToISO(v), cell: true };
    }
    const s = String(v).trim(); let m;
    if ((m = s.match(/^(\d{4})\s*[-\/.]\s*(\d{1,2})\s*[-\/.]\s*(\d{1,2})\.?$/))) return mk(+m[1], +m[2], +m[3], false);
    if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) return mk(+m[1], +m[2], +m[3], false);
    if ((m = s.match(/^(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일$/))) return mk(+m[1], +m[2], +m[3], false);
    if ((m = s.match(/^(\d{1,2})월\s*(\d{1,2})일$/)) && p.default_year) return mk(+p.default_year, +m[1], +m[2], false);
    if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) {
      if (p.slash_order === "mdy") return mk(+m[3], +m[1], +m[2], false);
      if (p.slash_order === "dmy") return mk(+m[3], +m[2], +m[1], false);
    }
    return null;
    function mk(y, mo, d, cell) { return validYMD(y, mo, d) ? { iso: isoOf(y, mo, d), cell } : { invalid: true }; }
  }

  /* 시각 읽기: {min, cell} | {invalid:true} | null */
  function parseTime(v, p) {
    if (typeof v === "number") {
      if (v >= 0 && v < 1) return { min: Math.round(v * 1440) % 1440, cell: true };
      if (Number.isInteger(v) && v >= 0 && v <= 2359) return chk(Math.floor(v / 100), v % 100);
      return { invalid: true };
    }
    const s = String(v).trim(); let m;
    const sepDot = p.dot_means === "hour.minute";
    const re = sepDot
      ? /^(오전|오후|AM|PM)?\s*(\d{1,2})\s*(?::|시|\.)\s*(\d{1,2})\s*분?(?::\d{2})?\s*(AM|PM)?$/i
      : /^(오전|오후|AM|PM)?\s*(\d{1,2})\s*(?::|시)\s*(\d{1,2})\s*분?(?::\d{2})?\s*(AM|PM)?$/i;
    if ((m = s.match(re))) {
      let h = +m[2]; const mi = +m[3]; const ap = (m[1] || m[4] || "").toUpperCase();
      if (ap === "오후" || ap === "PM") { if (h < 12) h += 12; } else if ((ap === "오전" || ap === "AM") && h === 12) h = 0;
      return chk(h, mi);
    }
    if ((m = s.match(/^(\d{1,2})시$/))) return chk(+m[1], 0);
    if ((m = s.match(/^(\d{3,4})$/))) { const n = +m[1]; return chk(Math.floor(n / 100), n % 100); }
    return null;
    function chk(h, mi) { return (h >= 0 && h <= 23 && mi >= 0 && mi <= 59) ? { min: h * 60 + mi, cell: false } : { invalid: true }; }
  }

  function parseNumber(v) {
    if (typeof v === "number") return v;
    const s = String(v).trim().replace(/\s+/g, ""); let m;
    if ((m = s.match(/^(-?\d+(?:\.\d+)?)(시간|h|hr|hrs)?$/i))) return +m[1];
    if ((m = s.match(/^(\d{1,2}):(\d{2})$/))) return r2(+m[1] + (+m[2]) / 60);
    return null;
  }
  const num = v => (typeof v === "number" && isFinite(v)) ? v : null;

  function parseSchedule(s) {
    const m = typeof s === "string" ? s.match(/^(\d{2}):(\d{2})~(\d{2}):(\d{2})$/) : null;
    if (!m) return null;
    const st = (+m[1]) * 60 + (+m[2]); let en = (+m[3]) * 60 + (+m[4]);
    if (en <= st) en += 1440;
    return { s: st, e: en };
  }

  /* ---------- 계산 도우미 (검사와 참고값에 함께 쓴다) ---------- */
  function sumExpected(row, check) {
    let total = 0;
    for (const c of check.sum) { const x = num(row.v[c]); if (x === null) return null; total += x; }
    for (const p of (check.plus || [])) if (row.v[p.column] === p.equals) total += p.add;
    return r2(total);
  }

  function judgmentExpected(row, p, schedStr) {
    const sc = parseSchedule(schedStr !== undefined ? schedStr : row.v[p.schedule]);
    if (!sc) return null;
    let ti = minutesOf(row.v[p.in_time]), to = minutesOf(row.v[p.out_time]);
    const overnight = sc.e > 1440;
    if (ti !== null && overnight && ti < 720) ti += 1440;
    if (to !== null) {
      if (overnight && to < 720) to += 1440;
      if (ti !== null) while (to <= ti) to += 1440;
    }
    const L = p.labels, out = { sc, ti, to };
    if (ti !== null) {
      const late = ti - sc.s > p.late_after_min;
      out.inJ = late ? L.late : L.normal;
      out.lateMin = late ? ti - sc.s : 0;
    }
    if (to !== null) {
      /* 연장 판정 시작과 연장시간 세는 시작을 따로 둘 수 있다 (없으면 overtime_from_end_min 하나로) */
      const judgeFrom = sc.e + (p.overtime_judgment_from_end_min !== undefined ? p.overtime_judgment_from_end_min : p.overtime_from_end_min);
      const countFrom = sc.e + (p.overtime_count_from_end_min !== undefined ? p.overtime_count_from_end_min : p.overtime_from_end_min);
      if (sc.e - to > p.early_before_min) { out.outJ = L.early; out.ot = 0; }
      else if (to >= judgeFrom) { out.outJ = L.overtime; out.ot = r2(Math.floor(Math.max(0, to - countFrom) / p.overtime_unit_min) * p.overtime_unit_min / 60); }
      else {
        out.outJ = L.normal; out.ot = 0;
        if (p.review_band && to > sc.e + p.review_band.after_end_min) out.review = p.review_band.message;
      }
    }
    return out;
  }

  /* ---------- 처방 파일 검사 ---------- */
  function validateRules(rules, header) {
    const problems = [];
    if (!rules || !Array.isArray(rules.prescriptions)) { problems.push("처방 목록(prescriptions)이 없습니다."); return problems; }
    const colsOf = d => {
      const out = [];
      ["column", "left", "right", "schedule", "in_time", "out_time", "in_judgment", "out_judgment",
        "late_minutes_column", "overtime_column", "when_column", "leave_column"].forEach(k => { if (typeof d[k] === "string") out.push(d[k]); });
      ["columns", "date_columns", "time_columns", "flag_blank", "present", "positive", "require_present", "rest_judgment_columns", "zero_columns"].forEach(k => { if (Array.isArray(d[k])) out.push(...d[k]); });
      if (d.limits) out.push(...Object.keys(d.limits));
      if (d.checks) d.checks.forEach(c => { out.push(c.target, ...c.sum); (c.plus || []).forEach(p => out.push(p.column)); });
      if (d.type === "recompute_from_times" && d.columns) out.push(...Object.values(d.columns));
      return out;
    };
    rules.prescriptions.forEach(p => {
      if (!p.do || !(p.do.type in PHASE)) { problems.push(`처방 ${p.id}: 정리기가 모르는 종류(${p.do ? p.do.type : "do 없음"})라 건너뜁니다.`); return; }
      const miss = colsOf(p.do).filter(c => !header.includes(c));
      if (miss.length) problems.push(`처방 ${p.id}: 파일에 없는 칸(${[...new Set(miss)].join(", ")})이 있어 건너뜁니다.`);
    });
    (rules.settings && rules.settings.key || []).forEach(k => { if (!header.includes(k)) problems.push(`키 칸 '${k}'이 파일에 없습니다.`); });
    return problems;
  }

  /* ---------- 정리 ---------- */
  function clean(aoa, rules) {
    const st = rules.settings || {};
    const flagCol = st.flag_column || "_표시";
    const rawHeader = (aoa[0] || []).map(h => h == null ? "" : String(h).trim());
    const keepIdx = rawHeader.map((h, i) => i).filter(i => rawHeader[i] !== flagCol && rawHeader[i] !== "");
    const header = keepIdx.map(i => rawHeader[i]);
    const problems = validateRules(rules, header);
    const runnable = (rules.prescriptions || []).filter(p => p.do && p.do.type in PHASE && !problems.some(x => x.startsWith(`처방 ${p.id}:`)));

    const rows = [];
    for (let r = 1; r < aoa.length; r++) {
      const line = aoa[r] || []; const v = {};
      header.forEach((h, j) => { const x = line[keepIdx[j]]; v[h] = x === undefined ? null : x; });
      if (header.every(h => isBlank(v[h]))) continue;
      rows.push({ no: r + 1, v, flags: [], deleted: false, dupOf: null });
    }
    const changes = [];
    const perRule = {};
    (rules.prescriptions || []).forEach(p => perRule[p.id] = { fix: 0, delete: 0, flag: 0 });
    const live = () => rows.filter(r => !r.deleted);
    const key = st.key || [];
    const person = st.person_column, dateCol = st.date_column;

    const setVal = (row, col, after, p, beforeShown) => {
      changes.push({ no: row.no, key: key.map(k => row.v[k]), col, before: beforeShown !== undefined ? beforeShown : show(row.v[col]), after: show(after), action: "수정", pid: p.id, why: p.why });
      row.v[col] = after; perRule[p.id].fix++;
    };
    /* note: 고친 일에 붙이는 확인 표시 (다시 돌리면 고칠 것이 없어 생기지 않으므로 «두 번 돌려도 같은 결과» 비교에서 뺀다) */
    const addFlag = (row, col, msg, p, note) => {
      if (row.flags.some(f => f.pid === p.id && f.col === col && f.msg === msg)) return;
      row.flags.push({ col, msg, pid: p.id, why: p.why, note: !!note }); perRule[p.id].flag++;
    };
    const ruleById = id => (rules.prescriptions || []).find(p => p.id === id);
    /* 계산에 쓸 스케줄: schedule_rule(근무조↔스케줄 처방)이 있으면 근무조에 맞는 스케줄, 휴무·공휴일은 그대로 */
    const scheduleOf = (row, d) => {
      const raw = row.v[d.schedule];
      const rr = d.schedule_rule ? ruleById(d.schedule_rule) : null;
      if (rr && rr.do && rr.do.type === "pair_check") {
        const pairs = rr.do.pairs || {};
        if ((pairs.always_allowed || []).includes(raw)) return raw;
        const L = row.v[rr.do.left];
        if (typeof pairs[L] === "string") return pairs[L];
      }
      return raw;
    };
    const parseRange = s => { const m = typeof s === "string" ? s.match(/^(\d{2}:\d{2})~(\d{2}:\d{2})$/) : null; if (!m) return null; const a = minutesOf(m[1]); let b = minutesOf(m[2]); if (b <= a) b += 1440; return { s: a, e: b }; };

    const ordered = runnable.map((p, i) => ({ p, i })).sort((a, b) => (PHASE[a.p.do.type] - PHASE[b.p.do.type]) || (a.i - b.i)).map(x => x.p);

    for (const p of ordered) {
      const d = p.do;
      switch (d.type) {
        case "keep": break;

        case "trim":
          live().forEach(r => { const x = r.v[d.column]; if (typeof x === "string" && x !== x.trim() && x.trim() !== "") setVal(r, d.column, x.trim(), p, "«" + x + "»"); });
          break;

        case "map":
          (d.columns || [d.column]).forEach(col => live().forEach(r => {
            const x = r.v[col];
            if (typeof x !== "string") return;
            if (Object.prototype.hasOwnProperty.call(d.mapping || {}, x)) setVal(r, col, d.mapping[x], p, "«" + x + "»");
            else if ((d.flag_values || []).includes(x)) addFlag(r, col, `«${x}»: ${d.flag_message || "뜻을 알 수 없음"}`, p);
          }));
          break;

        case "set_value_when":
          live().forEach(r => {
            if (!(d.when_in || []).includes(r.v[d.when_column])) return;
            const present = (d.require_present || []).every(c => !isBlank(r.v[c]));
            (d.columns || []).forEach(col => {
              const x = r.v[col];
              if (present && (d.from || []).includes(x)) {
                setVal(r, col, d.to, p, "«" + x + "»");
                if (d.review_message) addFlag(r, col, `${d.review_message} (${d.when_column} «${r.v[d.when_column]}», 원래 «${x}»)`, p, true);
              }
              else if (!present && d.flag_message && !isBlank(x) && !(d.allowed || []).includes(x))
                addFlag(r, col, `${d.flag_message} (${d.when_column} «${r.v[d.when_column]}», ${col} «${x}»)`, p);
            });
          });
          break;

        case "id_format": {
          const re = new RegExp("^" + d.prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\d{" + d.digits + "}$");
          live().forEach(r => {
            const x = r.v[d.column]; if (isBlank(x)) return;
            let s = String(x).trim().toUpperCase().replace(/[\s\-_]/g, "");
            if (new RegExp("^\\d{" + d.digits + "}$").test(s)) s = d.prefix + s;
            if (re.test(s) && s !== x) setVal(r, d.column, s, p, "«" + x + "»");
          });
          break;
        }

        case "date":
          live().forEach(r => {
            const x = r.v[d.column]; if (isBlank(x)) return;
            if (isISO(x) && r._dateCell && r._dateCell[d.column]) return;
            const res = parseDate(x, d);
            if (res && res.iso) {
              (r._dateCell = r._dateCell || {})[d.column] = true;
              if (res.cell) r.v[d.column] = res.iso;
              else setVal(r, d.column, res.iso, p, "«" + x + "» (글자)");
            }
          });
          break;

        case "time":
          d.columns.forEach(c => live().forEach(r => {
            const x = r.v[c]; if (isBlank(x) || isHHMM(x)) return;
            const res = parseTime(x, d);
            if (res && res.min !== undefined) setVal(r, c, hhmm(res.min), p, res.cell ? "(엑셀 시간 셀) " + hhmm(res.min) : "«" + x + "»");
          }));
          break;

        case "number":
          live().forEach(r => {
            const x = r.v[d.column]; if (isBlank(x) || typeof x === "number") return;
            const n = parseNumber(x);
            if (n !== null) setVal(r, d.column, n, p, "«" + x + "» (글자)");
          });
          break;

        case "fill_from_neighbors": {
          const byPerson = {};
          live().forEach(r => { const who = r.v[person], when = r.v[dateCol]; if (isBlank(who) || !isISO(when)) return; (byPerson[who] = byPerson[who] || []).push(r); });
          live().forEach(r => {
            if (!isBlank(r.v[d.column])) return;
            const list = byPerson[r.v[person]], when = r.v[dateCol];
            if (!list || !isISO(when)) { addFlag(r, d.column, "빈칸 — 사람·날짜를 알 수 없어 채우지 않음", p); return; }
            const before = list.filter(x => x.v[dateCol] < when && !isBlank(x.v[d.column])).sort((a, b) => a.v[dateCol] < b.v[dateCol] ? 1 : -1)[0];
            const after = list.filter(x => x.v[dateCol] > when && !isBlank(x.v[d.column])).sort((a, b) => a.v[dateCol] > b.v[dateCol] ? 1 : -1)[0];
            if (before && after && before.v[d.column] === after.v[d.column]) setVal(r, d.column, before.v[d.column], p, "(빈칸)");
            else if (d.allow_one_side && (before || after) && !(before && after)) setVal(r, d.column, (before || after).v[d.column], p, "(빈칸)");
            else addFlag(r, d.column, "빈칸 — " + (before && after ? (d.message_boundary || "앞뒤 날짜 값이 달라 채우지 않음") + ` (앞 «${before.v[d.column]}» · 뒤 «${after.v[d.column]}»)` : "앞이나 뒤 날짜가 없어 채우지 않음"), p);
          });
          break;
        }

        case "clear_exact_times": {
          const rr = d.schedule_rule ? ruleById(d.schedule_rule) : null;
          if (!rr || !rr.do || rr.do.type !== "pair_check") break;
          live().forEach(r => {
            const work = rr.do.pairs[r.v[rr.do.left]];
            const m = typeof work === "string" ? work.match(/^(\d{2}:\d{2})~(\d{2}:\d{2})$/) : null;
            if (!m || r.v[d.in_time] !== m[1] || r.v[d.out_time] !== m[2]) return;
            const rest = (d.rest_values || []).includes(r.v[d.schedule]);
            const leave = (d.leave_values || []).includes(r.v[d.leave_column]);
            if (!rest && !leave) return;
            setVal(r, d.in_time, null, p, m[1]); setVal(r, d.out_time, null, p, m[2]);
            if (rest) {
              (d.rest_judgment_columns || []).forEach(c => { if (r.v[c] !== d.rest_label) setVal(r, c, d.rest_label, p); });
              (d.zero_columns || []).forEach(c => { const x = num(r.v[c]); if (x === null || Math.abs(x) > 0.005) setVal(r, c, 0, p); });
            }
            addFlag(r, d.in_time, `${d.message || "정각 기록을 지움"} (원래 ${m[1]}~${m[2]}, ${rest ? d.schedule + " «" + r.v[d.schedule] + "»" : d.leave_column + " «" + r.v[d.leave_column] + "»"})`, p, true);
          });
          break;
        }

        case "recompute_from_times": {
          const jr = ruleById(d.judgment_rule); if (!jr || !jr.do) break;
          const J = jr.do, L = J.labels, C = d.columns;
          const brk = parseRange(d.break), nt = parseRange(d.night);
          const nightMin = (a, b) => nt ? ov(a, b, nt.s, nt.e) + ov(a, b, nt.s - 1440, nt.e - 1440) + ov(a, b, nt.s + 1440, nt.e + 1440) : 0;
          const brkMin = (a, b) => brk ? ov(a, b, brk.s, brk.e) : 0;
          const put = (r, col, val) => {
            if (!col) return;
            const cur = r.v[col];
            const same = typeof val === "number" ? (num(cur) !== null && Math.abs(num(cur) - val) < 0.005) : cur === val;
            if (!same) setVal(r, col, val, p);
          };
          live().forEach(r => {
            const inJ = r.v[J.in_judgment], outJ = r.v[J.out_judgment];
            const leave = Object.keys(d.leave || {}).find(k => inJ === k || outJ === k);
            if (leave !== undefined) {   // 연차·결근: 근무시간 0, 총 = 인정시간
              [C.late, C.normal, C.overtime, C.night, C.holiday, C.real].forEach(c => put(r, c, 0));
              put(r, C.total, d.leave[leave]);
              return;
            }
            const ti0 = minutesOf(r.v[J.in_time]), to0 = minutesOf(r.v[J.out_time]);
            if (ti0 === null || to0 === null) {                // 시간이 없거나 못 읽으면 고치지 않음
              if ((d.unknown_in || []).includes(inJ)) addFlag(r, J.in_judgment, `«${inJ}»: ${d.unknown_message || "뜻을 알 수 없는 판정"}`, p);
              return;
            }
            if ((d.rest_values || []).includes(r.v[J.schedule])) { // 휴무·공휴일
              if (inJ !== d.holiday_label) return;
              let ti = ti0, to = to0; while (to <= ti) to += 1440;
              const hol = r2(((to - ti) - brkMin(ti, to)) / 60);
              [C.late, C.normal, C.overtime].forEach(c => put(r, c, 0));
              put(r, C.night, r2(nightMin(ti, to) / 60)); put(r, C.holiday, hol); put(r, C.real, hol); put(r, C.total, hol);
              return;
            }
            if ((d.skip_judgments || []).includes(inJ) || (d.skip_judgments || []).includes(outJ)) return;
            const ex = judgmentExpected(r, J, scheduleOf(r, J));
            if (!ex || ex.ti === null || ex.to === null || ex.inJ === undefined || ex.outJ === undefined) return;
            const ws = Math.max(ex.ti, ex.sc.s), we = Math.min(ex.to, ex.sc.e);
            const nm = we > ws ? (we - ws) - brkMin(ws, we) : 0;
            const fillIn = (d.work_in || []).includes(inJ) || (d.fill_blank_judgments && isBlank(inJ)) || (d.unknown_in || []).includes(inJ);
            const fillOut = (d.work_out || []).includes(outJ) || (d.fill_blank_judgments && isBlank(outJ));
            if (fillIn) put(r, J.in_judgment, ex.inJ);
            if (fillOut) put(r, J.out_judgment, ex.outJ);
            const normal = r2(nm / 60), real = r2(normal + ex.ot);
            put(r, C.late, ex.lateMin); put(r, C.normal, normal); put(r, C.overtime, ex.ot);
            put(r, C.night, r2(nightMin(Math.max(ex.ti, ex.sc.s), ex.to) / 60)); put(r, C.holiday, 0);
            put(r, C.real, real); put(r, C.total, real);
          });
          break;
        }

        case "dedupe_exact": {
          const seen = new Map();
          live().forEach(r => {
            const sig = JSON.stringify(header.map(h => r.v[h]));
            if (seen.has(sig)) {
              r.deleted = true; r.dupOf = seen.get(sig).no; perRule[p.id].delete++;
              changes.push({ no: r.no, key: key.map(k => r.v[k]), col: "(행 전체)", before: "", after: "", action: "삭제", pid: p.id, why: p.why, note: r.dupOf + "행과 모든 칸이 같음" });
            } else seen.set(sig, r);
          });
          break;
        }

        case "flag_key_conflict": {
          const groups = new Map();
          live().forEach(r => { if (key.some(k => isBlank(r.v[k]))) return; const k = JSON.stringify(key.map(c => r.v[c])); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
          groups.forEach(list => {
            if (list.length < 2) return;
            list.forEach(r => {
              const others = list.filter(o => o !== r);
              const diff = header.filter(h => others.some(o => show(o.v[h]) !== show(r.v[h])));
              addFlag(r, "", `같은 ${key.join("·")} ${others.map(o => o.no).join(", ")}행과 ${diff.join(", ") || "값"}이(가) 다름`, p);
            });
          });
          break;
        }

        case "flag_invalid":
          live().forEach((r, idx, arr) => {
            (d.date_columns || []).forEach(c => {
              const x = r.v[c]; if (isBlank(x) || isISO(x)) return;
              const res = parseDate(x, { default_year: null, slash_order: null });
              let msg = res && res.invalid ? `달력에 없는 날짜 «${x}»` : `날짜로 읽을 수 없는 값 «${x}»`;
              const est = estimateDate(r, arr, c);
              if (d.fix_estimate && est.iso) { setVal(r, c, est.iso, p, "«" + x + "»"); addFlag(r, c, `${d.fix_note || "추정해 고침"} (원래 «${x}» → ${est.iso})`, p, true); return; }
              if (d.estimate) msg += " (참고: " + est.text + ")";
              addFlag(r, c, msg, p);
            });
            (d.time_columns || []).forEach(c => {
              const x = r.v[c]; if (isBlank(x) || isHHMM(x)) return;
              const res = parseTime(x, { dot_means: "hour.minute" });
              addFlag(r, c, (res && res.invalid ? `있을 수 없는 시각 «${x}»` : `시각으로 읽을 수 없는 값 «${x}»`) + (d.estimate ? " (참고: 추정할 근거 없음)" : ""), p);
            });
          });
          break;

        case "pair_check":
          live().forEach(r => {
            const L = r.v[d.left], R = r.v[d.right];
            if (isBlank(L) || isBlank(R) || (d.pairs.always_allowed || []).includes(R)) return;
            if (typeof d.pairs[L] === "string" && d.pairs[L] !== R) {
              if (d.fix) setVal(r, d.right, d.pairs[L], p, "«" + R + "»");
              else addFlag(r, d.right, `${d.message || "짝이 맞지 않음"}: ${d.left} «${L}»는 ${d.pairs[L]}인데 «${R}»`, p);
            }
          });
          break;

        case "range_check": {
          const hintRule = d.hint_rule ? ruleById(d.hint_rule) : null;
          const hint = (r, c) => {
            if (!hintRule || !hintRule.do || hintRule.do.type !== "sum_check") return "";
            const ck = hintRule.do.checks.find(k => k.target === c); if (!ck) return "";
            const e = sumExpected(r, ck); return e === null ? "" : ` (참고: 계산값 ${e})`;
          };
          live().forEach(r => {
            (d.flag_blank || []).forEach(c => { if (isBlank(r.v[c])) addFlag(r, c, "빈칸" + hint(r, c), p); });
            Object.keys(d.limits || {}).forEach(c => {
              const x = num(r.v[c]); if (x === null) return; const lim = d.limits[c];
              const pre = d.message ? d.message + ": " : "";
              if (lim.min !== undefined && x < lim.min) addFlag(r, c, `${pre}${c} ${r2(x)} (기준 ${lim.min} 미만)` + hint(r, c), p);
              if (lim.max !== undefined && x > lim.max) addFlag(r, c, `${pre}${c} ${r2(x)} (기준 ${lim.max} 초과)` + hint(r, c), p);
            });
          });
          break;
        }

        case "sum_check":
          live().forEach(r => d.checks.forEach(ck => {
            const t = num(r.v[ck.target]); if (t === null) return;
            const e = sumExpected(r, ck); if (e === null) return;
            if (Math.abs(t - e) > 0.011) addFlag(r, ck.target, `계산 규칙과 다름: ${r2(t)}, 계산값 ${e} (${ck.sum.join("+")}${(ck.plus || []).length ? "+인정시간" : ""})`, p);
          }));
          break;

        case "judgment_check":
          live().forEach(r => {
            const ex = judgmentExpected(r, d, scheduleOf(r, d)); if (!ex) return;
            const L = d.labels;
            const inJ = r.v[d.in_judgment], outJ = r.v[d.out_judgment];
            if (ex.inJ !== undefined && (inJ === L.normal || inJ === L.late)) {
              if (inJ !== ex.inJ) addFlag(r, d.in_judgment, `출근 ${hhmm(ex.ti)} (기준 ${hhmm(ex.sc.s)})인데 «${inJ}» — 기준상 «${ex.inJ}»`, p);
              const lm = num(r.v[d.late_minutes_column]);
              if (lm !== null && Math.abs(lm - ex.lateMin) > 0.5) addFlag(r, d.late_minutes_column, `${d.late_minutes_column} ${r2(lm)}분 — 기준상 ${ex.lateMin}분`, p);
            }
            if (ex.outJ !== undefined && (outJ === L.normal || outJ === L.early || outJ === L.overtime)) {
              if (outJ !== ex.outJ) addFlag(r, d.out_judgment, `퇴근 ${hhmm(ex.to)} (기준 ${hhmm(ex.sc.e)})인데 «${outJ}» — 기준상 «${ex.outJ}»`, p);
              const ot = num(r.v[d.overtime_column]);
              if (ot !== null && Math.abs(ot - ex.ot) > 0.011) addFlag(r, d.overtime_column, `${d.overtime_column} ${r2(ot)} — 기준상 ${ex.ot}`, p);
            }
            if (ex.review && (outJ === L.normal || outJ === L.early || outJ === L.overtime || isBlank(outJ)))
              addFlag(r, d.out_time, `${ex.review} (퇴근 ${hhmm(ex.to)})`, p);
          });
          break;

        case "flag_blank": {
          const hr = d.hint_rule ? ruleById(d.hint_rule) : null;
          live().forEach(r => {
            if (!isBlank(r.v[d.column])) return;
            let h = "";
            if (hr && hr.do && hr.do.type === "judgment_check") {
              const ex = judgmentExpected(r, hr.do, scheduleOf(r, hr.do));
              if (ex) { const v = d.column === hr.do.out_judgment ? ex.outJ : d.column === hr.do.in_judgment ? ex.inJ : undefined; if (v !== undefined) h = ` (참고: 기준상 «${v}»)`; }
            }
            addFlag(r, d.column, (d.message || "빈칸") + h, p);
          });
          break;
        }

        case "flag_blank_when":
          live().forEach(r => { if ((d.when_in || []).includes(r.v[d.when_column]) && isBlank(r.v[d.column])) addFlag(r, d.column, d.message || "빈칸", p); });
          break;

        case "flag_record_when":
          live().forEach(r => {
            if (!(d.when_in || []).includes(r.v[d.when_column])) return;
            const found = (d.present || []).filter(c => !isBlank(r.v[c])).concat((d.positive || []).filter(c => { const x = num(r.v[c]); return x !== null && x > 0; }));
            if (found.length) addFlag(r, found[0], `${d.message || "기록이 있음"} (${d.when_column} «${r.v[d.when_column]}», ${found.map(c => c + " " + show(r.v[c])).join(", ")})`, p);
          });
          break;

        case "flag_value_when":
          live().forEach(r => {
            if (!(d.when_in || []).includes(r.v[d.when_column])) return;
            const x = r.v[d.column];
            if (!isBlank(x) && !(d.allowed || []).includes(x)) addFlag(r, d.column, `${d.message || "허용되지 않은 값"} (${d.when_column} «${r.v[d.when_column]}», ${d.column} «${x}»)`, p);
          });
          break;

        case "night_check": {
          const ws0 = minutesOf(d.window_start), we0 = minutesOf(d.window_end);
          if (ws0 === null || we0 === null) break;
          const wEnd = we0 <= ws0 ? we0 + 1440 : we0;
          live().forEach(r => {
            const y = num(r.v[d.column]); if (y === null || y <= 0) return;
            const ti = minutesOf(r.v[d.in_time]); let to = minutesOf(r.v[d.out_time]);
            if (ti === null || to === null) return;
            while (to <= ti) to += 1440;
            const overlap = ov(ti, to, ws0, wEnd) + ov(ti, to, ws0 - 1440, wEnd - 1440) + ov(ti, to, ws0 + 1440, wEnd + 1440);
            if (overlap === 0) addFlag(r, d.column, `${d.message || "야간 시간대 근무가 없음"} (출근 ${r.v[d.in_time]} · 퇴근 ${r.v[d.out_time]}, ${d.column} ${r2(y)})`, p);
          });
          break;
        }

        case "flag_blip": {
          const byP = {};
          live().forEach(r => { const who = r.v[person], when = r.v[dateCol]; if (isBlank(who) || !isISO(when) || isBlank(r.v[d.column])) return; (byP[who] = byP[who] || []).push(r); });
          Object.values(byP).forEach(list => {
            list.sort((a, b) => a.v[dateCol] < b.v[dateCol] ? -1 : a.v[dateCol] > b.v[dateCol] ? 1 : 0);
            for (let i = 1; i < list.length - 1; i++) {
              const a = list[i - 1].v[d.column], x = list[i].v[d.column], b = list[i + 1].v[d.column];
              if (a === b && x !== a) {
                if (d.fix) setVal(list[i], d.column, a, p, "«" + x + "»");
                else addFlag(list[i], d.column, `${d.message || "앞뒤와 다른 값"} (앞 «${a}» · 이날 «${x}» · 뒤 «${b}»)`, p);
              }
            }
          });
          break;
        }
      }
    }

    const kept = live();
    const flagText = r => r.flags.map(f => (f.col ? f.col + ": " : "") + f.msg).join(" / ");
    const changedRows = new Set(changes.filter(c => c.action === "수정").map(c => c.no));
    return {
      header, flagCol, problems, changes, rows, kept,
      dateColumns: runnable.filter(p => p.do.type === "date").map(p => p.do.column),
      outRows: kept.map(r => header.map(h => r.v[h]).concat([flagText(r)])),
      stats: {
        before: rows.length, after: kept.length, deleted: rows.length - kept.length,
        fixedValues: changes.filter(c => c.action === "수정").length, fixedRows: changedRows.size,
        flaggedRows: kept.filter(r => r.flags.length).length,
        flags: kept.reduce((a, r) => a + r.flags.length, 0)
      },
      perRule
    };
    function estimateDate(r, arr, c) {
      const none = { text: "추정할 근거 없음", iso: null };
      const who = r.v[person]; if (isBlank(who)) return none;
      const same = arr.filter(x => x.v[person] === who);
      const i = same.indexOf(r);
      const prev = same.slice(0, i).reverse().find(x => isISO(x.v[c]));
      const next = same.slice(i + 1).find(x => isISO(x.v[c]));
      if (prev && next) {
        const a = isoToSerial(prev.v[c]), b = isoToSerial(next.v[c]);
        if (b - a === 2) { const iso = serialToISO(a + 1); return { text: "같은 사원 앞뒤 줄로 보면 " + iso, iso }; }
      }
      return none;
    }
  }

  /* 정리본을 엑셀로 저장했다가 다시 읽었을 때의 모양 (두 번 돌리기 검사용) */
  function asReadBack(result) {
    const header = result.header.concat([result.flagCol]);
    const di = result.dateColumns.map(c => result.header.indexOf(c));
    return [header].concat(result.outRows.map(row => row.map((x, j) => di.includes(j) && isISO(x) ? isoToSerial(x) : (x === "" && j === row.length - 1 ? null : x))));
  }

  const api = { clean, asReadBack, validateRules, isoToSerial, serialToISO, isISO, show, ACTION_LABEL };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.Cleaner = api;
})(this);
