/* ============================================================
   英语零基础 · 句子学堂  —  前端逻辑（Flask 版本）
   数据来自后端 /api/sentences；检测来自 /api/quiz；生成来自 /api/generate
   ============================================================ */

(function () {
  "use strict";

  const K_LEARNED = "eng_learned_ids";
  const K_LEVEL = "eng_level_override";
  const K_REVIEW = "eng_review";   // 错题本：{ [sentence_id]: [word, ...] }
  const K_SCENARIO = "eng_scenario"; // 当前沟通情景，"全部" 表示不限
  const QUIZ_EVERY = 5; // 每学 5 句检测一次

  const $ = (s) => document.querySelector(s);
  const sentenceEl = $("#sentence");
  const detailEl = $("#detail");
  const levelTagEl = $("#levelTag");
  const progressTextEl = $("#progressText");
  const barEl = $("#barFill");
  const overlayEl = $("#overlay");
  const levelSel = $("#levelSelect");
  const genScenario = $("#genScenario");
  const genStatus = $("#genStatus");
  const quizOverlay = $("#quizOverlay");

  let allSentences = [];
  let current = null;
  let quizQuestions = [];
  let quizSel = [];
  let quizSubmitted = false;

  // ---------- 存储 ----------
  function getLearned() {
    try { return JSON.parse(localStorage.getItem(K_LEARNED)) || []; }
    catch (e) { return []; }
  }
  function saveLearned(v) { localStorage.setItem(K_LEARNED, JSON.stringify(v)); }
  function getReview() {
    try { return JSON.parse(localStorage.getItem(K_REVIEW)) || {}; }
    catch (e) { return {}; }
  }
  function saveReview(v) { localStorage.setItem(K_REVIEW, JSON.stringify(v)); }
  function getScenario() { return localStorage.getItem(K_SCENARIO) || "全部"; }
  function setScenario(v) { localStorage.setItem(K_SCENARIO, v); }

  function autoLevel() {
    const n = getLearned().length;
    return Math.min(5, 1 + Math.floor(n / 5));
  }
  function currentLevel() {
    const ov = parseInt(localStorage.getItem(K_LEVEL) || "0", 10);
    return ov > 0 ? ov : autoLevel();
  }

  function showToast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(t._t);
    t._t = setTimeout(() => t.classList.remove("show"), 1800);
  }

  // ---------- 发音 ----------
  let _voices = [];
  function loadVoices() {
    if (!("speechSynthesis" in window)) return;
    _voices = window.speechSynthesis.getVoices() || [];
  }
  function pickEnglishVoice() {
    if (!_voices.length) return null;
    // 优先美/英/澳式英文嗓，其次任意 en 开头嗓
    return _voices.find(v => /^en[-_](US|GB|AU)/i.test(v.lang)) ||
           _voices.find(v => /^en/i.test(v.lang)) || null;
  }
  if ("speechSynthesis" in window) {
    loadVoices();
    // 部分浏览器（尤其移动端）语音列表异步加载，加载完再刷新
    window.speechSynthesis.onvoiceschanged = loadVoices;
  }
  function speak(text) {
    if (!("speechSynthesis" in window)) {
      showToast("当前浏览器不支持语音，请用手机系统 Safari / Chrome 打开");
      return;
    }
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-US";
    u.rate = 0.9; u.pitch = 1;
    const v = pickEnglishVoice();
    if (v) u.voice = v; // 显式选用英文嗓，避免中文手机静音
    u.onerror = () => showToast("发音失败：该设备可能未安装英文语音包");
    try { window.speechSynthesis.cancel(); } catch (e) {}
    window.speechSynthesis.speak(u);
  }

  // ---------- 数据 ----------
  async function fetchSentences() {
    const r = await fetch("/api/sentences");
    if (!r.ok) throw new Error("加载句子失败 HTTP " + r.status);
    allSentences = await r.json();
  }

  function poolForLevel(level) {
    const learned = getLearned();
    const sc = getScenario();
    return allSentences.filter((s) =>
      s.level <= level && !learned.includes(s.id) &&
      (sc === "全部" || s.scenario === sc));
  }
  function pickNext() {
    const sc = getScenario();
    // 1) 优先复习错题句（仅限当前情景）
    const review = getReview();
    const reviewIds = Object.keys(review);
    if (reviewIds.length) {
      const cand = allSentences.filter((s) =>
        reviewIds.includes(s.id) && (sc === "全部" || s.scenario === sc));
      if (cand.length) return cand[Math.floor(Math.random() * cand.length)];
    }
    // 2) 正常按等级取新句子（当前情景内）
    const level = currentLevel();
    let pool = poolForLevel(level);
    if (pool.length === 0 && level < 5) pool = poolForLevel(level + 1);
    if (pool.length === 0) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // ---------- 沟通情景选择 ----------
  const SCENARIO_ORDER = ["日常", "交通出行", "商场购物", "餐厅用餐"];
  function scenarioList() {
    const set = new Set(allSentences.map((s) => s.scenario).filter(Boolean));
    const ordered = SCENARIO_ORDER.filter((s) => set.has(s));
    set.forEach((s) => { if (!ordered.includes(s)) ordered.push(s); });
    return ["全部", ...ordered];
  }
  function renderScenarioBar() {
    const bar = $("#scenarioBar");
    if (!bar) return;
    const cur = getScenario();
    bar.innerHTML = "";
    scenarioList().forEach((sc) => {
      const chip = document.createElement("button");
      chip.className = "chip" + (sc === cur ? " active" : "");
      chip.textContent = sc;
      chip.addEventListener("click", () => selectScenario(sc));
      bar.appendChild(chip);
    });
  }
  function selectScenario(sc) {
    setScenario(sc);
    renderScenarioBar();
    showNext();
    showToast(sc === "全部" ? "已显示全部情景" : "情景：" + sc);
  }

  // ---------- 渲染 ----------
  function renderSentence(s) {
    sentenceEl.innerHTML = "";
    if (!s) return;
    s.words.forEach((wd, i) => {
      const span = document.createElement("span");
      span.className = "word";
      span.textContent = wd.w;
      span.dataset.idx = i;
      span.addEventListener("click", () => selectWord(i));
      sentenceEl.appendChild(span);
      if (i === s.words.length - 1) {
        const p = document.createElement("span");
        p.className = "punct"; p.textContent = ".";
        sentenceEl.appendChild(p);
      } else {
        sentenceEl.appendChild(document.createTextNode(" "));
      }
    });
  }

  function selectWord(i) {
    if (!current) return;
    const wd = current.words[i];
    document.querySelectorAll(".word").forEach((el) => el.classList.remove("active"));
    const el = document.querySelector('.word[data-idx="' + i + '"]');
    if (el) el.classList.add("active");

    detailEl.className = "detail";
    detailEl.innerHTML =
      '<div class="d-top">' +
        '<span class="d-word">' + escapeHtml(wd.w) + "</span>" +
        (wd.ipa ? '<span class="d-ipa">' + escapeHtml(wd.ipa) + "</span>" : "") +
        '<button class="d-play" title="听发音">🔊</button>' +
      "</div>" +
      '<div class="d-zh">' + escapeHtml(wd.zh) + "</div>" +
      '<div class="d-py">中文谐音：<b>' + escapeHtml(wd.py) + "</b></div>";
    detailEl.querySelector(".d-play").addEventListener("click", () => speak(wd.w));
    speak(wd.w);
  }

  function clearDetail() {
    detailEl.className = "detail empty";
    detailEl.textContent = "👆 点击上面的任意单词，查看中文意思、谐音并听发音";
  }

  function renderProgress() {
    const learned = getLearned().length;
    const level = currentLevel();
    levelTagEl.textContent = "等级 " + level + " · " + levelLabel(level);
    progressTextEl.innerHTML = "已学会 <b>" + learned + "</b> 句";
    const total = allSentences.length;
    const pct = total ? Math.min(100, Math.round((learned / total) * 100)) : 0;
    barEl.style.width = pct + "%";
  }

  function levelLabel(l) { return ["", "超短句", "短句", "中句", "较长句", "长句"][l] || ""; }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---------- 流程 ----------
  function showNext() {
    current = pickNext();
    if (!current) {
      sentenceEl.innerHTML =
        '<div style="font-size:18px;color:var(--muted);text-align:center;padding:20px 0;">' +
        "🎉 当前等级句子都学完啦！去设置里升级等级，或用 DeepSeek 生成更多句子吧。" +
        "</div>";
      clearDetail();
      return;
    }
    renderSentence(current);
    clearDetail();
  }

  async function markLearned() {
    if (!current) return;
    const learned = getLearned();
    if (!learned.includes(current.id)) {
      learned.push(current.id);
      saveLearned(learned);
    }
    // 这道错题句重新学会后，从错题本移除（只复现一次）
    const review = getReview();
    if (review[current.id]) {
      delete review[current.id];
      saveReview(review);
    }
    renderProgress();
    if (learned.length % QUIZ_EVERY === 0) {
      await openQuiz();
    } else {
      showNext();
      showToast("已学会，继续加油！");
    }
  }

  function skip() { showNext(); }
  function playSentence() { if (current) speak(current.text.replace(/\.$/, "")); }

  // ---------- 检测 ----------
  async function openQuiz() {
    try {
      // 检测只针对当前情景已学的句子
      const sc = getScenario();
      const learned = getLearned();
      const learnedIds = (sc === "全部")
        ? learned
        : learned.filter((id) => {
            const s = allSentences.find((x) => x.id === id);
            return s && s.scenario === sc;
          });
      const r = await fetch("/api/quiz", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ learned_ids: learnedIds }),
      });
      const data = await r.json();
      quizQuestions = data.questions || [];
    } catch (e) {
      quizQuestions = [];
    }
    if (!quizQuestions.length) { showNext(); return; }
    renderQuiz();
    quizOverlay.classList.add("show");
  }

  function renderQuiz() {
    quizSel = quizQuestions.map(() => -1);
    quizSubmitted = false;
    const body = $("#quizBody");
    body.innerHTML = "";
    quizQuestions.forEach((q, qi) => {
      const item = document.createElement("div");
      item.className = "q-item";
      const qdiv = document.createElement("div");
      qdiv.className = "q-q";
      if (q.type === "listen") {
        const pb = document.createElement("button");
        pb.className = "q-listen"; pb.textContent = "🔊";
        pb.addEventListener("click", () => speak(q.audio));
        qdiv.appendChild(pb);
      }
      const pt = document.createElement("span");
      pt.textContent = q.prompt;
      qdiv.appendChild(pt);
      item.appendChild(qdiv);

      const list = document.createElement("div");
      list.className = "q-opts";
      q.options.forEach((opt, oi) => {
        const b = document.createElement("button");
        b.className = "q-opt"; b.textContent = opt;
        b.addEventListener("click", () => {
          if (quizSubmitted) return;
          quizSel[qi] = oi;
          list.querySelectorAll(".q-opt").forEach((el, j) =>
            el.classList.toggle("sel", j === oi));
        });
        list.appendChild(b);
      });
      item.appendChild(list);
      body.appendChild(item);
    });
    $("#quizResult").textContent = "";
    $("#quizResult").className = "status";
    const sa = $("#quizActions");
    sa.innerHTML = '<button class="btn btn-primary" id="btnSubmitQuiz" style="flex:1;justify-content:center;">提交答案</button>';
    $("#btnSubmitQuiz").addEventListener("click", submitQuiz);
  }

  function submitQuiz() {
    if (quizSubmitted) return;
    quizSubmitted = true;
    let correct = 0;
    const items = document.querySelectorAll(".q-item");
    const review = getReview();
    const wrongList = [];
    quizQuestions.forEach((q, qi) => {
      const opts = items[qi].querySelectorAll(".q-opt");
      const sel = quizSel[qi];
      const isRight = sel >= 0 && q.options[sel] === q.answer;
      if (isRight) {
        correct++;
      } else {
        // 记录错题：错词 + 来源句子（下一轮学习复现该句）
        const sid = q.sentence_id;
        if (sid) {
          review[sid] = review[sid] || [];
          if (!review[sid].includes(q.answer)) review[sid].push(q.answer);
        }
        wrongList.push({ word: q.answer, sentence: q.sentence_text || "" });
      }
      opts.forEach((el, oi) => {
        const isAnswer = q.options[oi] === q.answer;
        if (isAnswer) el.classList.add("right");
        else if (oi === sel) el.classList.add("wrong");
      });
      // 题级对错标识
      const item = items[qi];
      item.classList.add(isRight ? "q-right" : "q-wrong");
      const qhead = item.querySelector(".q-q");
      let badge = qhead.querySelector(".q-badge");
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "q-badge";
        qhead.appendChild(badge);
      }
      badge.textContent = isRight ? "✓ 答对" : "✗ 答错";
    });
    saveReview(review);

    const total = quizQuestions.length;
    const ratio = correct / total;
    let cls = "ok", txt = "太棒了！";
    if (ratio < 0.5) { cls = "low"; txt = "继续加油～"; }
    else if (ratio < 1) { cls = "mid"; txt = "还不错！"; }
    const res = $("#quizResult");
    let html = '<div class="q-result-big ' + cls + '">你答对了 ' + correct + " / " + total + " 题 · " + txt + "</div>";
    if (wrongList.length) {
      html += '<div class="q-wrong-list"><div class="q-wrong-title">📌 以下错题下一轮会再次出现：</div>';
      wrongList.forEach((w) => {
        html += '<div class="q-wrong-row">· <b>' + escapeHtml(w.word) + "</b>" +
          (w.sentence ? "（来自：" + escapeHtml(w.sentence) + "）" : "") + "</div>";
      });
      html += "</div>";
    }
    res.className = "status " + cls;
    res.innerHTML = html;

    const sa = $("#quizActions");
    sa.innerHTML = '<button class="btn btn-primary" id="btnSubmitQuiz" style="flex:1;justify-content:center;">继续学习 ➜</button>';
    $("#btnSubmitQuiz").addEventListener("click", () => {
      quizOverlay.classList.remove("show");
      showNext();
      showToast("检测完成，继续学习！");
    });
  }

  // ---------- 设置 ----------
  function openSheet() {
    levelSel.value = localStorage.getItem(K_LEVEL) || "0";
    // 填充生成用情景下拉（不含"全部"）
    const cur = getScenario();
    genScenario.innerHTML = "";
    scenarioList().filter((s) => s !== "全部").forEach((s) => {
      const o = document.createElement("option");
      o.value = s; o.textContent = s;
      if (s === cur) o.selected = true;
      genScenario.appendChild(o);
    });
    if (cur !== "全部" && !scenarioList().includes(cur)) {
      const o = document.createElement("option");
      o.value = cur; o.textContent = cur; o.selected = true;
      genScenario.appendChild(o);
    }
    overlayEl.classList.add("show");
  }
  function closeSheet() { overlayEl.classList.remove("show"); }
  function saveSettings() {
    localStorage.setItem(K_LEVEL, levelSel.value);
    renderProgress();
    showToast("设置已保存");
    closeSheet();
  }
  function resetProgress() {
    if (!confirm("确定清空学习进度吗？（已生成的句子保留在服务端）")) return;
    localStorage.removeItem(K_LEARNED);
    localStorage.removeItem(K_REVIEW);
    renderProgress();
    showNext();
    showToast("已重置进度");
  }

  async function generate() {
    const level = currentLevel();
    const sc = (genScenario && genScenario.value) ? genScenario.value : getScenario();
    const scLabel = (sc === "全部") ? "日常" : sc;
    genStatus.className = "status";
    genStatus.textContent = "正在用 DeepSeek 生成「" + scLabel + "」等级 " + level + " 的句子…";
    try {
      const r = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level: level, count: 5, scenario: scLabel }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || ("HTTP " + r.status));
      await fetchSentences();
      showNext();
      genStatus.className = "status ok";
      genStatus.textContent = "✅ 成功生成 " + ((data.sentences || []).length) + " 句，已加入学习池！";
      showToast("DeepSeek 已生成新句子");
    } catch (e) {
      genStatus.className = "status err";
      genStatus.textContent = "生成失败：" + e.message;
    }
  }

  // ---------- 绑定 ----------
  function bind() {
    $("#btnLearned").addEventListener("click", markLearned);
    $("#btnSkip").addEventListener("click", skip);
    $("#btnPlay").addEventListener("click", playSentence);
    $("#btnSettings").addEventListener("click", openSheet);
    $("#btnCloseSheet").addEventListener("click", closeSheet);
    overlayEl.addEventListener("click", (e) => { if (e.target === overlayEl) closeSheet(); });
    $("#btnSaveSettings").addEventListener("click", saveSettings);
    $("#btnGenerate").addEventListener("click", generate);
    $("#btnReset").addEventListener("click", resetProgress);
  }

  // ---------- 启动 ----------
  async function init() {
    bind();
    try {
      await fetchSentences();
    } catch (e) {
      sentenceEl.innerHTML = '<div style="color:var(--err);padding:20px 0;">加载失败：' + escapeHtml(e.message) + "<br>请确认 Flask 后端已启动（python app.py）。</div>";
      return;
    }
    renderScenarioBar();
    renderProgress();
    showNext();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
