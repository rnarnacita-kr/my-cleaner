/* app.js — 화면. 파일은 이 브라우저 안에서만 읽고 계산한다. 서버로 보내는 코드는 없다. */
(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const C = window.Cleaner;
  const S = { base: "", fileName: "", aoa: null, rules: null, rulesFrom: "", result: null, idem: null, view: "changes" };

  /* ---------- 내려받기: claude.ai 안에서는 downloads 기능, 내 컴퓨터에서 열면 일반 내려받기 ---------- */
  let DL = null;
  (async () => { try { if (window.claude && window.claude.use) DL = await window.claude.use("downloads"); } catch (e) { DL = null; } })();
  async function saveFile(name, bytes) {
    if (DL) {
      try { await DL.save({ filename: name, data: bytes }); return name + " 저장됨"; }
      catch (e) {
        const c = e && e.code;
        if (c === "declined") return "저장을 취소했습니다.";
        if (c === "rate_limited") return "이미 저장 창이 열려 있습니다. 잠시 뒤 다시 눌러 주세요.";
        if (c && !["unavailable", "not_granted", "capability_disabled", "capability_removed"].includes(c)) return "저장하지 못했습니다 (" + c + ").";
      }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
    a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    return name + " 내려받기를 시작했습니다. 아무 일도 없으면 claude.ai 링크나 내 컴퓨터에서 열어 주세요.";
  }

  /* ---------- 파일 읽기 ---------- */
  function readBytes(file) {
    return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(new Uint8Array(fr.result)); fr.onerror = () => rej(fr.error); fr.readAsArrayBuffer(file); });
  }
  function decodeText(bytes) {
    let t = new TextDecoder("utf-8").decode(bytes);
    const BAD = String.fromCharCode(0xFFFD), BOM = String.fromCharCode(0xFEFF);
    if (t.includes(BAD)) { try { t = new TextDecoder("euc-kr").decode(bytes); } catch (e) { /* 그대로 */ } }
    return t.charAt(0) === BOM ? t.slice(1) : t;
  }
  async function readTable(file, keepStrings) {
    const bytes = await readBytes(file);
    const isCsv = /\.csv$/i.test(file.name);
    const wb = isCsv ? XLSX.read(decodeText(bytes), { type: "string", raw: true }) : XLSX.read(bytes, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    let aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false });
    if (isCsv && !keepStrings) aoa = aoa.map((row, i) => i === 0 ? row : row.map(v => typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : (v === "" ? null : v)));
    return { aoa, sheets: wb.SheetNames };
  }

  /* ---------- 1. 파일 넣기 ---------- */
  async function onData(file) {
    hide("err"); hide("rulesBox"); hide("runBox"); hide("resultBox"); hide("answerBox");
    S.result = null;
    try {
      const { aoa, sheets } = await readTable(file, false);
      if (!aoa.length) throw new Error("빈 파일입니다.");
      S.aoa = aoa; S.fileName = file.name; S.base = file.name.replace(/\.[^.]+$/, "");
      const header = (aoa[0] || []).filter(h => h != null && String(h).trim() !== "");
      const dataRows = aoa.slice(1).filter(r => (r || []).some(v => v != null && String(v).trim() !== "")).length;
      $("fileInfo").innerHTML =
        `<div class="kv"><span>파일</span><b>${esc(file.name)}</b></div>` +
        `<div class="kv"><span>줄 수</span><b class="mono">${dataRows}</b><em>머리글 빼고</em></div>` +
        `<div class="kv"><span>칸 수</span><b class="mono">${header.length}</b></div>` +
        `<div class="kv"><span>시트</span><b>${esc(sheets[0])}</b>${sheets.length > 1 ? `<em>시트 ${sheets.length}개 중 첫 시트만 정리</em>` : ""}</div>`;
      show("fileBox");
      await loadRules();
    } catch (e) { fail("파일을 읽지 못했습니다. " + (e.message || e)); }
  }

  /* ---------- 2. 처방 읽기 ---------- */
  async function loadRules() {
    S.rules = null;
    const tries = [`rules/${encodeURIComponent(S.base)}.json`, `rules/${S.base}.json`];
    for (const u of tries) {
      try {
        const r = await fetch(u, { cache: "no-store" });
        if (r.ok) { const j = await r.json(); setRules(j, `rules/${S.base}.json`); return; }
      } catch (e) { /* 다음 시도 */ }
    }
    $("rulesMissing").innerHTML = `<p class="warn"><b>이 파일에 맞는 처방이 없습니다.</b> <span class="mono">rules/${esc(S.base)}.json</span>을 찾지 못했습니다.</p><p class="note">처방 파일(.json)을 골라 올리면 그 처방으로 정리합니다. 올린 파일도 이 컴퓨터 밖으로 나가지 않습니다.</p>`;
    show("rulesMissing"); hide("rulesList"); show("rulesBox"); show("rulesPick");
  }
  async function onRulesFile(file) {
    try { const j = JSON.parse(decodeText(await readBytes(file))); setRules(j, "올린 파일: " + file.name); }
    catch (e) { fail("처방 파일을 읽지 못했습니다. JSON 형식인지 확인해 주세요. (" + (e.message || e) + ")"); }
  }
  function setRules(j, from) {
    hide("err");
    if (!j || !Array.isArray(j.prescriptions)) { fail("처방 파일에 처방 목록(prescriptions)이 없습니다."); return; }
    S.rules = j; S.rulesFrom = from;
    const header = (S.aoa[0] || []).map(h => h == null ? "" : String(h).trim());
    const problems = C.validateRules(j, header);
    const colText = c => Array.isArray(c) ? c.join(" · ") : (c || "");
    $("rulesHead").innerHTML = `<b>${esc(from)}</b> · 처방 ${j.prescriptions.length}건` + (j.owner ? ` · 승인 ${esc(j.owner)}` : "") + (j.updated ? ` · ${esc(j.updated)}` : "");
    $("rulesProblems").innerHTML = problems.length ? `<ul class="warn">${problems.map(p => `<li>${esc(p)}</li>`).join("")}</ul>` : "";
    $("rulesTable").innerHTML = "<thead><tr><th>칸</th><th>증상</th><th>처리</th><th>이유</th></tr></thead><tbody>" +
      j.prescriptions.map(p => {
        const act = p.action || (p.do && p.do.type);
        return `<tr><td>${esc(colText(p.column))}</td><td>${esc(p.symptom || "")}</td><td><span class="pill a-${esc(act)}">${esc(C.ACTION_LABEL[act] || act)}</span></td><td>${esc(p.why || "")}${p.why_threshold ? `<br><span class="note">${esc(p.why_threshold)}</span>` : ""}</td></tr>`;
      }).join("") + "</tbody>";
    hide("rulesMissing"); show("rulesList"); show("rulesBox"); show("rulesPick"); show("runBox");
    $("rulesPickLabel").textContent = "다른 처방 파일 올리기";
  }

  /* ---------- 3. 규칙대로 정리 ---------- */
  function run() {
    hide("err");
    try {
      const res = C.clean(S.aoa, S.rules);
      const again = C.clean(C.asReadBack(res), S.rules);
      const dataSame = JSON.stringify(res.kept.map(r => res.header.map(h => r.v[h]))) === JSON.stringify(again.kept.map(r => again.header.map(h => r.v[h])));
      const flagSig = rr => JSON.stringify(rr.kept.map(r => r.flags.filter(f => !f.note).map(f => f.pid + "|" + f.col).sort()));
      S.idem = { same: dataSame && again.stats.fixedValues === 0 && again.stats.deleted === 0 && flagSig(res) === flagSig(again), again: again.stats };
      S.result = res; S.view = "changes";
      render(); show("resultBox"); show("answerBox"); hide("answerResult");
      $("resultBox").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (e) { fail("정리하는 중 문제가 생겼습니다. " + (e.message || e)); }
  }

  function render() {
    const r = S.result, st = r.stats, idem = S.idem;
    $("stats").innerHTML = [
      ["행", `${st.before} → ${st.after}`],
      ["지운 행", st.deleted],
      ["고친 값", `${st.fixedValues}<small>건 · ${st.fixedRows}행</small>`],
      ["표시한 행", `${st.flaggedRows}<small>행 · ${st.flags}건</small>`, "flag"],
      ["두 번 돌려도 같은 결과", idem.same ? "예" : "아니오", idem.same ? "ok" : "bad"]
    ].map(([k, v, cls]) => `<div class="stat ${cls || ""}"><div class="k">${k}</div><div class="v">${v}</div></div>`).join("");
    $("idemNote").textContent = idem.same ? "정리본을 다시 정리해도 바뀌는 값·지워지는 행이 없습니다."
      : `정리본을 다시 정리했더니 고친 값 ${idem.again.fixedValues}건 · 지운 행 ${idem.again.deleted}행이 더 나왔습니다. 처방 순서나 내용을 확인해 주세요.`;
    $("perRule").innerHTML = "<thead><tr><th>처방</th><th>칸</th><th>처리</th><th class='n'>고침</th><th class='n'>지움</th><th class='n'>표시</th></tr></thead><tbody>" +
      S.rules.prescriptions.map(p => {
        const c = r.perRule[p.id] || { fix: 0, delete: 0, flag: 0 }; const act = p.action || (p.do && p.do.type);
        return `<tr><td class="mono">${esc(p.id)}</td><td>${esc(Array.isArray(p.column) ? p.column.join(" · ") : p.column)}</td><td><span class="pill a-${esc(act)}">${esc(C.ACTION_LABEL[act] || act)}</span></td><td class="n">${c.fix || ""}</td><td class="n">${c.delete || ""}</td><td class="n">${c.flag || ""}</td></tr>`;
      }).join("") + "</tbody>";
    $("tabChanges").setAttribute("aria-selected", S.view === "changes");
    $("tabFlags").setAttribute("aria-selected", S.view === "flags");
    const key = (S.rules.settings && S.rules.settings.key) || [];
    let html;
    if (S.view === "changes") {
      html = `<thead><tr><th class="n">원본 행</th>${key.map(k => `<th>${esc(k)}</th>`).join("")}<th>칸</th><th>처리</th><th>바꾸기 전</th><th>바꾼 후</th><th>처방</th></tr></thead><tbody>` +
        (r.changes.map(c => `<tr><td class="n">${c.no}</td>${c.key.map(k => `<td class="mono">${esc(C.show(k))}</td>`).join("")}<td>${esc(c.col)}</td><td><span class="pill ${c.action === "삭제" ? "a-delete" : "a-fix"}">${c.action}</span></td><td class="mono">${esc(c.before)}</td><td class="mono">${esc(c.action === "삭제" ? c.note : c.after)}</td><td class="mono">${esc(c.pid)}</td></tr>`).join("") || `<tr><td colspan="9" class="empty">바꾼 값이 없습니다.</td></tr>`) + "</tbody>";
    } else {
      const fr = r.kept.filter(x => x.flags.length);
      html = `<thead><tr><th class="n">원본 행</th>${key.map(k => `<th>${esc(k)}</th>`).join("")}<th>${esc(r.flagCol)}</th></tr></thead><tbody>` +
        (fr.map(x => `<tr><td class="n">${x.no}</td>${key.map(k => `<td class="mono">${esc(C.show(x.v[k]))}</td>`).join("")}<td>${x.flags.map(f => `<div><span class="mono dim">${esc(f.pid)}</span> ${esc(f.col ? f.col + ": " : "")}${esc(f.msg)}</div>`).join("")}</td></tr>`).join("") || `<tr><td colspan="9" class="empty">표시한 행이 없습니다.</td></tr>`) + "</tbody>";
    }
    $("detail").innerHTML = html;
  }

  /* ---------- 4. 내려받기 (엑셀 파일이라 한글이 깨지지 않는다) ---------- */
  function cleanWorkbook() {
    const r = S.result;
    const aoa = [r.header.concat([r.flagCol])].concat(r.outRows.map(row => row.map(v => v == null ? "" : v)));
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    r.dateColumns.forEach(c => {
      const j = r.header.indexOf(c); if (j < 0) return;
      for (let i = 1; i < aoa.length; i++) { const v = aoa[i][j]; if (C.isISO(v)) ws[XLSX.utils.encode_cell({ r: i, c: j })] = { t: "n", v: C.isoToSerial(v), z: "yyyy-mm-dd" }; }
    });
    ws["!cols"] = aoa[0].map((h, j) => ({ wch: j === aoa[0].length - 1 ? 80 : Math.max(8, String(h).length * 2 + 2) }));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "정리본");
    return new Uint8Array(XLSX.write(wb, { bookType: "xlsx", type: "array" }));
  }
  function logWorkbook() {
    const r = S.result, key = (S.rules.settings && S.rules.settings.key) || [];
    const why = id => { const p = S.rules.prescriptions.find(x => x.id === id); return p ? p.why : ""; };
    const rows = [];
    r.changes.forEach(c => rows.push({ no: c.no, k: c.key.map(C.show), col: c.col, b: c.action === "삭제" ? "" : c.before, a: c.action === "삭제" ? c.note : c.after, act: c.action, pid: c.pid, why: c.why || why(c.pid) }));
    r.kept.forEach(x => x.flags.forEach(f => rows.push({ no: x.no, k: key.map(k => C.show(x.v[k])), col: f.col || "(행 전체)", b: f.col ? C.show(x.v[f.col]) : "", a: f.msg, act: "표시", pid: f.pid, why: f.why || why(f.pid) })));
    rows.sort((a, b) => a.no - b.no);
    const aoa = [["원본 행"].concat(key, ["칸", "바꾸기 전 / 현재 값", "바꾼 후 / 표시 내용", "처리", "처방", "이유"])].concat(rows.map(x => [x.no].concat(x.k, [x.col, x.b, x.a, x.act, x.pid, x.why])));
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = [8].concat(key.map(() => 12), [12, 18, 40, 6, 22, 60]).map(w => ({ wch: w }));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "바꾼 기록");
    return new Uint8Array(XLSX.write(wb, { bookType: "xlsx", type: "array" }));
  }

  /* ---------- 5. 정답과 대조 (정답 파일은 내 컴퓨터에서 고른다) ---------- */
  async function onAnswer(file) {
    try {
      const { aoa } = await readTable(file, true);
      const r = S.result, key = (S.rules.settings && S.rules.settings.key) || [];
      const ah = (aoa[0] || []).map(h => h == null ? "" : String(h).trim());
      const missKey = key.filter(k => !ah.includes(k));
      if (missKey.length) throw new Error("정답 파일에 키 칸(" + missKey.join(", ") + ")이 없습니다.");
      const cols = r.header.filter(h => ah.includes(h));
      const dateCols = r.dateColumns;
      const norm = (v, c) => {
        if (v == null) return "";
        if (typeof v === "number") return dateCols.includes(c) ? C.serialToISO(v) : String(Math.round(v * 100) / 100);
        const s = String(v).trim();
        if (/^-?\d+(\.\d+)?$/.test(s)) return String(Math.round(Number(s) * 100) / 100);
        return s;
      };
      const ansRows = aoa.slice(1).filter(row => (row || []).some(v => v != null && String(v).trim() !== "")).map(row => { const o = {}; ah.forEach((h, j) => o[h] = row[j]); return o; });
      const kOf = o => key.map(k => norm(o[k], k)).join(" / ");
      const mine = new Map(), dupMine = [];
      r.kept.forEach(x => { const k = kOf(x.v); if (mine.has(k)) dupMine.push(k); else mine.set(k, x); });
      const seenAns = new Set();
      let matchRows = 0, keyMatched = 0; const colMiss = {}; const diffs = []; const onlyAns = [];
      ansRows.forEach(o => {
        const k = kOf(o); seenAns.add(k);
        const x = mine.get(k); if (!x) { onlyAns.push(k); return; }
        keyMatched++;
        let ok = true;
        cols.forEach(c => { const a = norm(o[c], c), b = norm(x.v[c], c); if (a !== b) { ok = false; colMiss[c] = (colMiss[c] || 0) + 1; diffs.push({ k, c, mine: b, ans: a, no: x.no, flags: flagsFor(x, c) }); } });
        if (ok) matchRows++;
      });
      const onlyMine = [...mine.keys()].filter(k => !seenAns.has(k));
      const totalDiff = diffs.length;
      $("answerResult").innerHTML =
        `<div class="stats">` + [["정답 행", ansRows.length], ["정리본 행", r.kept.length], ["키가 맞는 행", keyMatched], ["모든 칸 일치", matchRows, "ok"], ["어긋난 칸", totalDiff, totalDiff ? "bad" : "ok"]]
          .map(([k, v, cls]) => `<div class="stat ${cls || ""}"><div class="k">${k}</div><div class="v">${v}</div></div>`).join("") + `</div>` +
        `<p class="note">대조한 칸 ${cols.length}개 (${esc(cols.join(", "))}). 키: ${esc(key.join(" + "))}. ${r.flagCol} 칸은 대조하지 않습니다.</p>` +
        (onlyAns.length ? `<p class="warn">정답에만 있는 행 ${onlyAns.length}: ${esc(onlyAns.slice(0, 20).join(" · "))}${onlyAns.length > 20 ? " …" : ""}</p>` : "") +
        (onlyMine.length ? `<p class="warn">정리본에만 있는 행 ${onlyMine.length}: ${esc(onlyMine.slice(0, 20).join(" · "))}${onlyMine.length > 20 ? " …" : ""}</p>` : "") +
        (dupMine.length ? `<p class="warn">정리본에서 키가 겹치는 행 ${dupMine.length}: ${esc(dupMine.slice(0, 20).join(" · "))} (첫 행만 대조)</p>` : "") +
        (totalDiff ? `<h3>칸별 어긋남</h3><p class="note">칸 버튼을 누르면 그 칸의 어긋난 건만 보여 줍니다.</p><div class="chips" id="diffChips"></div><div id="diffTable"></div>`
          : `<p class="okline">대조한 모든 칸이 정답과 같습니다.</p>`);
      S.diffs = diffs; S.colMiss = colMiss; S.diffFilter = "전체";
      if (totalDiff) renderDiffs();
      show("answerResult");
    } catch (e) { fail("정답 파일을 대조하지 못했습니다. " + (e.message || e)); }
  }

  /* 어긋난 칸의 까닭: 그 칸의 표시 → 행 전체 표시 → 같은 행 다른 칸의 표시 순서로 찾는다 */
  function flagsFor(row, col) {
    const same = row.flags.filter(f => f.col === col);
    if (same.length) return { kind: "same", list: same.map(f => f.msg) };
    const whole = row.flags.filter(f => !f.col);
    if (whole.length) return { kind: "row", list: whole.map(f => f.msg) };
    const other = row.flags.filter(f => f.col && f.col !== col);
    if (other.length) return { kind: "other", list: other.map(f => f.col + ": " + f.msg) };
    return { kind: "none", list: [] };
  }
  function flagCell(fl) {
    if (!fl || fl.kind === "none") return `<td class="miss">(표시 없음)</td>`;
    const pre = fl.kind === "row" ? "(행 전체) " : fl.kind === "other" ? "(다른 칸) " : "";
    return `<td>${fl.list.map(m => `<div>${esc(pre + m)}</div>`).join("")}</td>`;
  }

  function renderDiffs() {
    const cols = Object.keys(S.colMiss).sort((a, b) => S.colMiss[b] - S.colMiss[a]);
    const btn = (key, label, n) => `<button type="button" class="chip" data-col="${esc(key)}" aria-pressed="${S.diffFilter === key}">${esc(label)} <b class="mono">${n}</b></button>`;
    $("diffChips").innerHTML = btn("전체", "전체", S.diffs.length) + cols.map(c => btn(c, c, S.colMiss[c])).join("");
    $("diffChips").querySelectorAll("button").forEach(b => b.addEventListener("click", () => { S.diffFilter = b.dataset.col; renderDiffs(); }));
    const shown = S.diffFilter === "전체" ? S.diffs : S.diffs.filter(d => d.c === S.diffFilter);
    $("diffTable").innerHTML = `<p class="note">${S.diffFilter === "전체" ? "모든 칸" : "«" + esc(S.diffFilter) + "» 칸"} · ${shown.length}건</p>` +
      `<div class="tablebox"><table><thead><tr><th class="n">원본 행</th><th>키</th><th>칸</th><th>정리본</th><th>정답</th><th>표시 내용</th></tr></thead><tbody>` +
      shown.slice(0, 500).map(d => `<tr><td class="n">${d.no}</td><td class="mono">${esc(d.k)}</td><td>${esc(d.c)}</td><td class="mono">${esc(d.mine || "(빈칸)")}</td><td class="mono">${esc(d.ans || "(빈칸)")}</td>${flagCell(d.flags)}</tr>`).join("") +
      `</tbody></table></div>${shown.length > 500 ? `<p class="note">앞의 500건만 보여 줍니다.</p>` : ""}`;
  }

  /* ---------- 공통 ---------- */
  function show(id) { $(id).hidden = false; }
  function hide(id) { $(id).hidden = true; }
  function fail(msg) { $("err").textContent = msg; show("err"); }

  function bindDrop(zone, input, handler) {
    zone.addEventListener("click", () => input.click());
    zone.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
    input.addEventListener("change", () => { if (input.files[0]) handler(input.files[0]); input.value = ""; });
    ["dragenter", "dragover"].forEach(t => zone.addEventListener(t, e => { e.preventDefault(); zone.classList.add("over"); }));
    ["dragleave", "drop"].forEach(t => zone.addEventListener(t, e => { e.preventDefault(); zone.classList.remove("over"); }));
    zone.addEventListener("drop", e => { const f = e.dataTransfer.files[0]; if (f) handler(f); });
  }
  window.addEventListener("dragover", e => e.preventDefault());
  window.addEventListener("drop", e => e.preventDefault());

  bindDrop($("drop"), $("fileInput"), onData);

  /* 샘플 파일: 사이트에 함께 둔 연습용 파일을 내려받아 끌어다 놓은 것처럼 처리한다 */
  /* claude.ai 링크는 엑셀 파일을 그대로 올릴 수 없어서, 링크에는 같은 파일을 base64 글자로 바꾼 .txt를 함께 둔다 */
  const SAMPLE = { path: "data/" + encodeURIComponent("근태관리") + ".xlsx", b64: "data/" + encodeURIComponent("근태관리") + ".xlsx.b64.txt", name: "근태관리.xlsx" };
  async function loadSample() {
    try { const r = await fetch(SAMPLE.path, { cache: "no-store" }); if (r.ok) return await r.blob(); } catch (e) { /* 다음 방법 */ }
    const r = await fetch(SAMPLE.b64, { cache: "no-store" });
    if (!r.ok) throw new Error("샘플 파일을 찾지 못했습니다 (" + r.status + ").");
    const bin = atob((await r.text()).replace(/\s+/g, ""));
    const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes]);
  }
  $("sampleBtn").addEventListener("click", async () => {
    const btn = $("sampleBtn"); btn.disabled = true; hide("err");
    try {
      await onData(new File([await loadSample()], SAMPLE.name));
    } catch (e) {
      fail("샘플 파일을 불러오지 못했습니다. " + (e.message || e) + " 내 컴퓨터에서 index.html을 바로 열었다면, 폴더에서 서버를 띄워 열거나 파일을 직접 끌어다 놓아 주세요.");
    } finally { btn.disabled = false; }
  });
  $("rulesPickBtn").addEventListener("click", () => $("rulesInput").click());
  $("rulesInput").addEventListener("change", () => { const f = $("rulesInput").files[0]; if (f) onRulesFile(f); $("rulesInput").value = ""; });
  $("runBtn").addEventListener("click", run);
  $("tabChanges").addEventListener("click", () => { S.view = "changes"; render(); });
  $("tabFlags").addEventListener("click", () => { S.view = "flags"; render(); });
  $("dlClean").addEventListener("click", async () => { $("dlNote").textContent = await saveFile(S.base + "_정리본.xlsx", cleanWorkbook()); });
  $("dlLog").addEventListener("click", async () => { $("dlNote").textContent = await saveFile(S.base + "_바꾼기록.xlsx", logWorkbook()); });
  $("answerBtn").addEventListener("click", () => $("answerInput").click());
  $("answerInput").addEventListener("change", () => { const f = $("answerInput").files[0]; if (f) onAnswer(f); $("answerInput").value = ""; });
})();
