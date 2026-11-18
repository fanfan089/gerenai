/* ============================================================
 * app.js — 考试规划官 主逻辑
 *  - DeepSeek OpenAI 兼容接口（流式 SSE）
 *  - 分层长期记忆：核心档案 + 滚动摘要 + 全量归档检索 + 最近对话
 * ============================================================ */
(() => {
  'use strict';

  const $  = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const now = () => Date.now();
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const GLOBAL = '__global__';

  // ---------- 设置（localStorage） ----------
  const DEFAULT_SETTINGS = {
    apiKey: '',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    thinking: false,
    webSearch: true,
    ctx: 12,
    memory: true,
    autoConsolidate: true,
  };
  let S = loadSettings();
  function loadSettings() {
    try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('examai.settings') || '{}') }; }
    catch { return { ...DEFAULT_SETTINGS }; }
  }
  function saveSettings() { localStorage.setItem('examai.settings', JSON.stringify(S)); }

  // ---------- 运行时状态 ----------
  const state = {
    view: 'chat',
    chatMode: localStorage.getItem('examai.chatMode') || 'chat', // 'chat' 自由聊天 | 'exam' 考试规划
    exams: [],
    examId: localStorage.getItem('examai.currentExam') || null,
    messages: [],
    controller: null,
    streaming: false,
    lastContext: null,
    pendingImages: [],   // 待发送的已压缩图片 data URL 数组
  };

  // ---------- 图片处理 ----------
  const MAX_IMG_SIDE = 1280;   // 压缩后最长边，够模型看清且省 token
  const MAX_IMGS = 6;          // 单条消息最多图片数

  // 压缩图片为 base64 data URL（canvas 等比缩小 + JPEG 编码）
  function compressImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('读取图片失败'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('图片解码失败'));
        img.onload = () => {
          let { width, height } = img;
          const scale = Math.min(1, MAX_IMG_SIDE / Math.max(width, height));
          width = Math.max(1, Math.round(width * scale));
          height = Math.max(1, Math.round(height * scale));
          const canvas = document.createElement('canvas');
          canvas.width = width; canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#fff';               // JPEG 无透明通道，白底兜底
          ctx.fillRect(0, 0, width, height);
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', 0.82));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function renderPendingImages() {
    const box = $('#attachPreview');
    box.innerHTML = state.pendingImages.map((src, i) =>
      `<div class="thumb"><img src="${src}" alt="待发送图片 ${i + 1}"><button class="thumb-del" data-idx="${i}" title="移除">×</button></div>`
    ).join('');
    box.hidden = state.pendingImages.length === 0;
  }

  // 当前对话的存储分区：自由聊天用 GLOBAL，考试模式用对应考试 id
  function activeKey() {
    return state.chatMode === 'exam' && state.examId ? state.examId : GLOBAL;
  }

  // ---------- Toast ----------
  let toastTimer;
  function toast(msg, ms = 2200) {
    const el = $('#toast');
    el.textContent = msg; el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.hidden = true, ms);
  }

  // ============================================================
  // 记忆系统
  // ============================================================

  // 建立核心档案默认值（带字段补全，兼容旧数据/导入数据缺字段的情况）
  async function ensureProfile() {
    let p = await DB.get('profile', 'main');
    if (!p) {
      p = { id: 'main', summary: '', facts: [], goals: [], updatedAt: now() };
      await DB.put('profile', p);
    }
    // normalize：无论数据来自旧版本还是手动导入，都补齐成完整结构
    p.summary = typeof p.summary === 'string' ? p.summary : '';
    p.facts = Array.isArray(p.facts) ? p.facts : [];
    p.goals = Array.isArray(p.goals) ? p.goals : [];
    p.updatedAt = p.updatedAt || now();
    return p;
  }

  // 分词（简单：连续中文 2~4 字 + 数字 + 英文单词）
  function tokenize(text) {
    const out = [];
    const en = text.match(/[a-zA-Z]{2,}/g) || [];
    const num = text.match(/\d+/g) || [];
    const zh = text.match(/[\u4e00-\u9fa5]+/g) || [];
    out.push(...en.map(x => x.toLowerCase()), ...num);
    zh.forEach(seg => {
      if (seg.length <= 4) out.push(seg);
      else for (let i = 0; i < seg.length - 1; i++) out.push(seg.slice(i, i + 2));
    });
    return [...new Set(out)];
  }

  // 从全量归档里检索与当前输入相关的历史（跳过已压缩的）
  function retrieve(examId, query, limit = 5) {
    const kws = tokenize(query);
    if (!kws.length) return [];
    return DB.messagesByExam(examId).then(all => {
      const pool = all.filter(m => m.digested !== true && m.role !== 'system' && !query.includes(m.content));
      const scored = pool.slice(-600).map(m => {
        const t = m.content || '';
        let score = 0;
        for (const k of kws) if (t.includes(k)) score += k.length >= 3 ? 2 : 1;
        return { m, score };
      }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
      return scored.slice(0, limit).map(x => ({
        role: x.m.role === 'user' ? '用户' : '助手',
        content: x.m.content.length > 220 ? x.m.content.slice(0, 220) + '…' : x.m.content,
        ts: x.m.ts,
      }));
    });
  }

  // 构造注入的 system prompt（含全部记忆层）
  async function buildSystem(exam, userInput) {
    const isExam = state.chatMode === 'exam';
    // 人设随模式切换：自由聊天是通用助手，考试模式才是规划官
    const persona = isExam
      ? '你是"考试规划官"，贴心务实、擅长制定学习计划的 AI 助手。请用中文回答，简洁有条理，多用清单和具体可执行的时间安排。'
      : '你是用户的 AI 聊天伙伴，聪明、亲切、博识，什么都能聊——学习、工作、生活、情感、写作、答疑、脑暴都可以。请用中文自然对话，回答有实质内容，不空泛，必要时用清单或分点让信息清晰。';

    let examBlock = '';
    if (isExam) {
      examBlock = exam ? `
【当前考试】
- 名称：${exam.name}
- 考试日期：${exam.date || '未设置'}
- 今日：${new Date().toLocaleDateString('zh-CN')}
- 科目与进度：
${(exam.subjects || []).map(s => `  · ${s.name} ${s.done ? '[已完成]' : '[进行中]'}`).join('\n') || '  （未设置科目）'}
` : '\n【当前状态】考试模式下尚未选择考试，可提醒用户到「考试」页添加或选中一场考试。\n';
    }

    if (!S.memory) {
      return { text: `${persona}\n${examBlock}`, layers: ['基础人设'] };
    }

    const profile = await ensureProfile();
    const key = activeKey();
    const digests = await DB.digestsByExam(key);
    const recentDigests = digests.slice(-3);
    const related = await retrieve(key, userInput || '', 5);

    const layers = ['基础人设'];
    if (isExam) layers.push('考试档案');
    let text = `${persona}
你拥有跨越数月甚至数年的长期记忆，会主动结合下面提供的历史记忆来理解用户。若记忆与当前问题相关，自然地使用它们，但不要刻意炫耀"我记得"。
${examBlock}`;

    if (profile.summary || profile.facts.length || profile.goals.length) {
      layers.push('核心档案');
      text += `\n【长期记忆 · 核心档案】\n`;
      if (profile.summary) text += `总体情况：${profile.summary}\n`;
      if (profile.goals.length) text += `目标：\n${profile.goals.map(g => '  - ' + g).join('\n')}\n`;
      if (profile.facts.length) text += `已记住的重要事实与约定：\n${profile.facts.slice(-30).map(f => '  - ' + f.text).join('\n')}\n`;
    }
    if (recentDigests.length) {
      layers.push(`滚动摘要×${recentDigests.length}`);
      text += `\n【历史对话摘要】\n${recentDigests.map(d => `（${new Date(d.toTs).toLocaleDateString('zh-CN')} 前后）\n${d.content}`).join('\n\n')}\n`;
    }
    if (related.length) {
      layers.push(`相关历史×${related.length}`);
      text += `\n【相关的过往对话片段】\n${related.map(r => `${r.role}：${r.content}`).join('\n')}\n`;
    }
    return { text, layers };
  }

  // 自动整理记忆：把未压缩的旧消息交给 AI 生成结构化更新
  async function consolidate(force = false) {
    const examId = activeKey();
    const all = await DB.messagesByExam(examId);
    const unprocessed = all.filter(m => m.digested !== true && m.role !== 'system');
    // 保留最近 10 条不压缩，保证对话连贯
    const keepRecent = 10;
    const toCompress = unprocessed.length > keepRecent ? unprocessed.slice(0, unprocessed.length - keepRecent) : [];
    if (!toCompress.length && !force) { toast('暂无需要整理的对话'); return; }
    if (!S.apiKey) { toast('请先到设置里填写 API Key'); return; }
    if (!toCompress.length) { toast('对话还太少，暂时无需整理'); return; }

    toast('正在整理长期记忆…');
    const profile = await ensureProfile();
    const digestList = await DB.digestsByExam(examId);
    const prevDigest = digestList.length ? digestList[digestList.length - 1].content : '（无）';

    const convo = toCompress.map(m => {
      const c = m.content || (m.images && m.images.length ? '（发送了一张图片）' : '');
      return `${m.role === 'user' ? '用户' : '助手'}：${c}`;
    }).join('\n');
    const prompt = `你在维护一个考试规划助手的"长期记忆档案"。请根据【过往摘要】【现有档案】【新对话】，输出更新后的记忆。

【过往摘要】
${prevDigest}

【现有核心档案】
总体情况：${profile.summary || '（无）'}
目标：${profile.goals.join('；') || '（无）'}
事实：${profile.facts.map(f => f.text).join('；') || '（无）'}

【新对话（需要被压缩）】
${convo}

请严格只输出一个 JSON 对象（不要 Markdown，不要多余文字），格式：
{
  "summary": "对用户整体情况的最新概括，150字以内",
  "goals": ["目标1", "目标2"],
  "facts": ["需要长期记住的事实/偏好/约定1", "事实2"],
  "digest": "对【新对话】的摘要，保留关键信息、决定、进度变化，250字以内"
}
要求：facts 与 goals 要合并旧内容并去重，不要丢失重要的旧事实；不要编造对话里没有的信息。`;

    try {
      const res = await fetch(`${S.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${S.apiKey}` },
        body: JSON.stringify({
          model: S.model,
          messages: [{ role: 'user', content: prompt }],
          thinking: { type: 'disabled' },
          stream: false,
          temperature: 0.2,
        }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 120));
      const data = await res.json();
      let content = data.choices?.[0]?.message?.content || '';
      content = content.replace(/```json/ig, '').replace(/```/g, '').trim();
      let parsed;
      try { parsed = JSON.parse(content); }
      catch {
        // 解析失败：退化为纯文本摘要，至少不丢记忆
        parsed = { summary: profile.summary, goals: profile.goals, facts: profile.facts.map(f => f.text), digest: content.slice(0, 600) };
      }
      await DB.put('profile', {
        id: 'main',
        summary: String(parsed.summary || '').slice(0, 800),
        goals: asArr(parsed.goals).slice(0, 40),
        facts: asArr(parsed.facts).slice(-60).map(t => ({ text: String(t).slice(0, 200), ts: now() })),
        updatedAt: now(),
      });
      await DB.put('digests', {
        id: uid(), examId,
        content: String(parsed.digest || '').slice(0, 1200),
        fromTs: toCompress[0].ts, toTs: toCompress[toCompress.length - 1].ts,
        createdAt: now(),
      });
      for (const m of toCompress) { m.digested = true; await DB.put('messages', m); }
      toast(`记忆已整理：压缩 ${toCompress.length} 条对话`);
      renderMemory();
    } catch (e) {
      console.error(e);
      toast('整理失败：' + e.message, 3000);
    }
  }
  function asArr(x) {
    if (Array.isArray(x)) return x.filter(Boolean);
    if (typeof x === 'string') return x.split(/[；;\n]/).map(s => s.trim()).filter(Boolean);
    return [];
  }

  // ============================================================
  // 对话
  // ============================================================
  function renderMessages() {
    const list = $('#msgList');
    const empty = $('#emptyChat');
    const nonSystem = state.messages.filter(m => m.role !== 'system');
    if (!nonSystem.length) {
      list.querySelectorAll('.msg').forEach(n => n.remove());
      if (!empty.parentNode) list.appendChild(empty);
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    // 只移除气泡，保留 #emptyChat 节点本身（否则 setChatMode 里访问其子元素会报错中断）
    list.querySelectorAll('.msg').forEach(n => n.remove());
    for (const m of nonSystem) appendMsgBubble(m);
    scrollBottom();
  }

  function appendMsgBubble(m, streamEl) {
    const list = $('#msgList');
    if ($('#emptyChat') && !$('#emptyChat').hidden) $('#emptyChat').hidden = true;
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + (m.role === 'user' ? 'me' : 'ai');
    const avatar = m.role === 'user' ? '我' : '🎓';
    const name = m.role === 'user' ? '' : '<div class="msg-name">我的 AI 助手</div>';
    const imgsHtml = (!streamEl && m.images && m.images.length)
      ? `<div class="msg-images">${m.images.map((src, i) => `<img src="${src}" data-preview="${i}" alt="图片 ${i + 1}">`).join('')}</div>` : '';
    const voiceRow = m.role === 'assistant'
      ? `<div class="msg-actions"><button class="voice-btn" data-voice title="朗读这条回复"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1-3.29-2.5-4.03v8.05c1.5-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg><span class="voice-label">朗读</span></button></div>`
      : '';
    wrap.innerHTML = `
      <div class="msg-avatar">${avatar}</div>
      <div class="msg-body">
        ${name}
        <div class="bubble md">${imgsHtml}${streamEl ? '' : md(m.content) + renderCitations(m.citations)}</div>
        ${voiceRow}
        ${m.layers && m.layers.length ? `<div class="mem-used"><span class="dot"></span>已调用记忆：${m.layers.join(' · ')}</div>` : ''}
      </div>`;
    list.appendChild(wrap);
    scrollBottom();
    return wrap.querySelector('.bubble');
  }

  function scrollBottom() {
    const l = $('#msgList');
    requestAnimationFrame(() => { l.scrollTop = l.scrollHeight; });
  }

  // ---- 语音朗读（浏览器内置语音合成，无需联网、不额外收费）----
  const speech = {
    supported: 'speechSynthesis' in window,
    activeBtn: null,
    voices: [],
  };
  if (speech.supported) {
    const loadVoices = () => { speech.voices = window.speechSynthesis.getVoices() || []; };
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
  }
  function pickChineseVoice() {
    const vs = speech.voices;
    return vs.find(v => /^zh[-_]CN/i.test(v.lang))
        || vs.find(v => /^zh/i.test(v.lang))
        || vs.find(v => /Chinese/i.test(v.name))
        || null;
  }
  // 从一条消息气泡提取纯文本用于朗读（去掉图片/引用来源/搜索提示等噪音）
  function speechTextFromBubble(btn) {
    const msg = btn.closest('.msg');
    if (!msg) return '';
    const bubble = msg.querySelector('.bubble');
    if (!bubble) return '';
    const clone = bubble.cloneNode(true);
    clone.querySelectorAll('.msg-images, .cite-label, .cite-item, .searching-hint, .md-table').forEach(n => n.remove());
    return (clone.textContent || '').replace(/\s{3,}/g, '\n').trim();
  }
  function resetSpeechBtn() {
    if (speech.activeBtn) {
      speech.activeBtn.classList.remove('speaking');
      const label = speech.activeBtn.querySelector('.voice-label');
      if (label) label.textContent = '朗读';
      speech.activeBtn = null;
    }
  }
  function stopSpeech() {
    if (speech.supported) window.speechSynthesis.cancel();
    resetSpeechBtn();
  }
  function toggleSpeech(btn) {
    if (!speech.supported) { toast('当前浏览器不支持语音朗读'); return; }
    // 再点正在朗读的按钮 → 停止
    if (speech.activeBtn === btn) { stopSpeech(); return; }
    stopSpeech();
    const text = speechTextFromBubble(btn);
    if (!text) { toast('这条消息还没有可朗读的内容'); return; }
    let u;
    try { u = new SpeechSynthesisUtterance(text); }
    catch (e) { toast('该浏览器无法创建语音，换用系统浏览器试试'); return; }
    u.lang = 'zh-CN';
    u.rate = 1; u.pitch = 1; u.volume = 1;
    const v = pickChineseVoice();
    if (v) { u.voice = v; u.lang = v.lang; }
    u.onend = () => resetSpeechBtn();
    u.onerror = () => resetSpeechBtn();
    btn.classList.add('speaking');
    const label = btn.querySelector('.voice-label');
    if (label) label.textContent = '停止';
    speech.activeBtn = btn;
    // 部分移动浏览器需先 resume 再 speak
    try { window.speechSynthesis.resume(); } catch (e) {}
    window.speechSynthesis.speak(u);
  }

  // 极简 Markdown 渲染
  function md(text) {
    if (!text) return '';
    const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    let h = esc.replace(/```([\w-]*)\n([\s\S]*?)```/g, (_, lang, code) => `<pre><code>${code}</code></pre>`);
    h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    h = h.replace(/^###\s+(.+)$/gm, '<strong>$1</strong>');
    h = h.replace(/^##\s+(.+)$/gm, '<strong>$1</strong>');
    h = h.replace(/^#\s+(.+)$/gm, '<strong>$1</strong>');
    h = renderTables(h);
    h = h.replace(/^\s*[-*]\s+(.+)$/gm, '<li>$1</li>');
    h = h.replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, '<ul>$1</ul>');
    h = h.replace(/\n/g, '<br>');
    h = h.replace(/<\/ul><br>/g, '</ul>').replace(/<br><ul>/g, '<ul>');
    h = h.replace(/<\/table><br>/g, '</table>').replace(/<br><div class="md-table-wrap">/g, '<div class="md-table-wrap">');
    return h;
  }

  // 把 Markdown 表格解析成 HTML 表格（在换行转 <br> 之前调用）
  function renderTables(h) {
    const lines = h.split('\n');
    const out = [];
    let i = 0;
    const rowRe = /^\s*\|.*\|\s*$/;
    const sepRe = /^\s*\|[\s:|\-]+\|\s*$/;
    const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(s => s.trim());
    while (i < lines.length) {
      if (rowRe.test(lines[i]) && i + 1 < lines.length && sepRe.test(lines[i + 1])) {
        const head = cells(lines[i]);
        i += 2;
        const rows = [];
        while (i < lines.length && rowRe.test(lines[i])) { rows.push(cells(lines[i])); i++; }
        let t = '<div class="md-table-wrap"><table class="md-table"><thead><tr>';
        head.forEach(c => { t += `<th>${c}</th>`; });
        t += '</tr></thead><tbody>';
        rows.forEach(r => {
          t += '<tr>';
          for (let k = 0; k < head.length; k++) t += `<td>${r[k] != null ? r[k] : ''}</td>`;
          t += '</tr>';
        });
        t += '</tbody></table></div>';
        out.push(t);
      } else {
        out.push(lines[i]); i++;
      }
    }
    return out.join('\n');
  }

  // 渲染联网搜索的引用来源
  function renderCitations(cits) {
    if (!cits || !cits.length) return '';
    const items = cits.slice(0, 6).map((c, i) => {
      let host = '';
      try { host = new URL(c.url).hostname.replace(/^www\./, ''); } catch { host = '来源'; }
      return `<a href="${c.url}" target="_blank" rel="noopener" class="cite-item"><span class="cite-n">${i + 1}</span><span class="cite-host">${escHtml(host)}</span></a>`;
    }).join('');
    return `<div class="citations"><div class="cite-label">🌐 引用来源</div><div class="cite-list">${items}</div></div>`;
  }
  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // 把历史消息转成 API 的 content：纯文字用字符串，带图片用内容块数组
  function toContent(m) {
    if (m.images && m.images.length) {
      const parts = [];
      if (m.content) parts.push({ type: 'text', text: m.content });
      for (const src of m.images) parts.push({ type: 'image_url', image_url: { url: src, detail: 'low' } });
      return parts;
    }
    return m.content || '';
  }

  async function send(text) {
    text = (text || '').trim();
    // 取走待发送图片（即使没有文字，只要发了图片就允许发送）
    const images = state.pendingImages.slice();
    state.pendingImages = [];
    renderPendingImages();
    if ((!text && !images.length) || state.streaming) return;
    if (!S.apiKey) { toast('请先到「设置」里填写 DeepSeek API Key'); go('settings'); return; }

    const exam = state.chatMode === 'exam' ? (state.exams.find(e => e.id === state.examId) || null) : null;
    const sys = await buildSystem(exam, text || '（用户发送了一张图片）');
    state.lastContext = sys;

    const userMsg = { id: uid(), examId: activeKey(), role: 'user', content: text, ts: now() };
    if (images.length) userMsg.images = images;
    state.messages.push(userMsg);
    await DB.put('messages', userMsg);
    appendMsgBubble(userMsg);

    // 组装发给 API 的消息（系统提示 + 最近 N 条 + 当前输入）
    const ctxCount = S.ctx;
    const history = state.messages.filter(m => m.role !== 'system' && m.id !== userMsg.id).slice(-ctxCount);
    const payloadMsgs = [{ role: 'system', content: sys.text }];
    for (const m of history) payloadMsgs.push({ role: m.role, content: toContent(m) });
    payloadMsgs.push({ role: 'user', content: toContent(userMsg) });

    setStreaming(true);
    $('#typing').hidden = false;
    const aiMsg = { id: uid(), examId: activeKey(), role: 'assistant', content: '', layers: sys.layers, ts: now() };
    const bubble = appendMsgBubble(aiMsg, true);
    let full = '';
    let buffer = '';
    let citations = [];
    let searchingShown = false;

    try {
      state.controller = new AbortController();
      const res = await fetch(`${S.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${S.apiKey}` },
        signal: state.controller.signal,
        body: JSON.stringify({
          model: S.model,
          messages: payloadMsgs,
          stream: true,
          thinking: { type: S.thinking ? 'enabled' : 'disabled' },
          ...(S.thinking ? { reasoning_effort: 'medium' } : {}),
          ...(S.webSearch ? { tools: [{ type: 'deepseek_web_search' }] } : {}),
        }),
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`HTTP ${res.status}：${errText.slice(0, 160)}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      $('#typing').hidden = true;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const data = t.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const obj = JSON.parse(data);
            const choice = obj.choices?.[0];
            // 联网搜索事件提示
            const evt = choice?.server_tool_event;
            if (evt && evt.type === 'call_started' && !searchingShown) {
              searchingShown = true;
              bubble.innerHTML = '<div class="searching-hint"><span class="spin"></span>正在联网搜索最新信息…</div>' + md(full);
              scrollBottom();
            }
            // 引用来源（最后一个 chunk 汇总给出）
            const anns = choice?.delta?.annotations;
            if (Array.isArray(anns)) {
              for (const a of anns) {
                const c = a.url_citation;
                if (c && c.url && !citations.some(x => x.url === c.url)) citations.push({ url: c.url, title: c.title || c.url });
              }
            }
            const delta = choice?.delta?.content || '';
            if (delta) {
              full += delta;
              let html = md(full);
              if (searchingShown && !full) html = '<div class="searching-hint"><span class="spin"></span>正在联网搜索最新信息…</div>' + html;
              bubble.innerHTML = html;
              scrollBottom();
            }
          } catch { /* 忽略心跳/不完整帧 */ }
        }
      }
      aiMsg.content = full || '（没有收到内容，请重试）';
      if (citations.length) aiMsg.citations = citations;
      bubble.innerHTML = md(aiMsg.content) + renderCitations(citations);
      state.messages.push(aiMsg);
      await DB.put('messages', aiMsg);

      // 自动整理记忆（异步，不阻塞）
      if (S.autoConsolidate) {
        const cnt = await DB.messagesByExam(aiMsg.examId);
        const un = cnt.filter(m => m.digested !== true && m.role !== 'system').length;
        if (un >= 30) setTimeout(() => consolidate(false), 400);
      }
      updateTokenHint();
    } catch (e) {
      $('#typing').hidden = true;
      if (e.name === 'AbortError') {
        bubble.innerHTML = md(full || '（已停止）') + (full ? '\n\n_（已停止生成）_' : '');
        aiMsg.content = full || '（已停止）';
        state.messages.push(aiMsg);
        await DB.put('messages', aiMsg);
      } else {
        bubble.innerHTML = md(full) + `\n\n⚠️ 出错了：${e.message}`;
        toast('请求失败：' + e.message, 3500);
      }
    } finally {
      setStreaming(false);
    }
  }

  function setStreaming(on) {
    state.streaming = on;
    $('#sendBtn').disabled = on;
    $('#stopRow').hidden = !on;
  }

  function updateTokenHint() {
    const chars = state.messages.reduce((n, m) => n + (m.content?.length || 0), 0);
    $('#tokenHint').textContent = `本地归档 ${state.messages.length} 条 · 约 ${Math.round(chars / 1.6)} tokens 历史`;
  }

  // ============================================================
  // 考试管理
  // ============================================================
  async function loadExams() {
    state.exams = await DB.all('exams');
    if (state.examId && !state.exams.find(e => e.id === state.examId)) state.examId = null;
    renderExams();
    renderBanner();
    updateCtxLabel();
  }

  function daysLeft(date) {
    if (!date) return null;
    const d = new Date(date + 'T00:00:00');
    return Math.ceil((d - new Date()) / 86400000);
  }

  function renderExams() {
    const box = $('#examList');
    if (!state.exams.length) {
      box.innerHTML = '<div class="empty-exam">还没有考试。<br>点右上角「+ 添加考试」，我就能开始帮你规划了。</div>';
      return;
    }
    box.innerHTML = '';
    for (const e of state.exams) {
      const dl = daysLeft(e.date);
      const subs = e.subjects || [];
      const done = subs.filter(s => s.done).length;
      const pct = subs.length ? Math.round(done / subs.length * 100) : 0;
      const card = document.createElement('div');
      card.className = 'exam-card' + (state.examId === e.id ? ' selected' : '');
      card.innerHTML = `
        ${state.examId === e.id ? '<span class="selected-flag">当前</span>' : ''}
        <div class="exam-card-top">
          <div><div class="exam-card-name">${escHtml(e.name)}</div>
          <div class="exam-card-date">${e.date || '未设置日期'}</div></div>
          ${dl !== null ? `<div class="days-pill ${dl <= 30 ? 'urgent' : ''}">${dl >= 0 ? '剩 ' + dl + ' 天' : '已过 ' + (-dl) + ' 天'}</div>` : ''}
        </div>
        <div class="exam-card-subs">
          ${subs.map((s, i) => `<span class="sub-tag" data-exam="${e.id}" data-idx="${i}" style="${s.done ? 'opacity:.5;text-decoration:line-through' : ''}">${s.done ? '✓ ' : ''}${escHtml(s.name)}</span>`).join('') || '<span class="sub-tag">未设置科目</span>'}
        </div>
        ${subs.length ? `<div class="exam-card-bar"><div class="exam-card-fill" style="width:${pct}%"></div></div>` : ''}`;
      card.addEventListener('click', (ev) => {
        const tag = ev.target.closest('.sub-tag');
        if (tag && tag.dataset.idx !== undefined) {
          const idx = +tag.dataset.idx;
          e.subjects[idx].done = !e.subjects[idx].done;
          DB.put('exams', e).then(() => { renderExams(); renderBanner(); });
          return;
        }
        selectExam(e.id);
      });
      box.appendChild(card);
    }
  }

  function renderBanner() {
    const b = $('#examBanner');
    // 横幅只在考试模式且有选中考试时显示
    if (state.chatMode !== 'exam') { b.hidden = true; return; }
    const e = state.exams.find(x => x.id === state.examId);
    if (!e) { b.hidden = true; return; }
    b.hidden = false;
    $('#bannerName').textContent = e.name;
    const dl = daysLeft(e.date);
    $('#bannerDays').textContent = dl !== null ? (dl >= 0 ? `距考试 ${dl} 天` : `已过 ${-dl} 天`) : '';
    const subs = e.subjects || [];
    const pct = subs.length ? Math.round(subs.filter(s => s.done).length / subs.length * 100) : 0;
    $('#bannerFill').style.width = pct + '%';
  }

  async function selectExam(id) {
    state.examId = id;
    localStorage.setItem('examai.currentExam', id || '');
    // 点选考试自动切到考试模式
    if (state.chatMode !== 'exam') await setChatMode('exam', false);
    await loadMessages();
    renderExams();
    renderBanner();
    updateCtxLabel();
    go('chat');
    toast(id ? '已进入考试规划模式' : '已选择考试');
  }

  async function loadMessages() {
    state.messages = await DB.messagesByExam(activeKey());
    renderMessages();
    updateTokenHint();
  }

  function escHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // 考试编辑弹窗
  let editingExamId = null;
  function openExamModal(exam) {
    editingExamId = exam ? exam.id : null;
    $('#examModalTitle').textContent = exam ? '编辑考试' : '添加考试';
    $('#exName').value = exam?.name || '';
    $('#exDate').value = exam?.date || '';
    $('#exSubjects').value = (exam?.subjects || []).map(s => s.name).join('\n');
    $('#btnDeleteExam').hidden = !exam;
    $('#examModal').hidden = false;
  }

  // ============================================================
  // 记忆页
  // ============================================================
  async function renderMemory() {
    const p = await ensureProfile();
    const digests = await DB.digestsByExam(activeKey());
    const total = await DB.countMessages();
    const compressed = (await DB.all('messages')).filter(m => m.digested).length;
    $('#memStats').innerHTML = `
      <div class="stat-box"><div class="stat-num">${total}</div><div class="stat-label">总对话条数</div></div>
      <div class="stat-box"><div class="stat-num">${digests.length}</div><div class="stat-label">记忆摘要</div></div>
      <div class="stat-box"><div class="stat-num">${p.facts.length}</div><div class="stat-label">记住的事实</div></div>`;

    $('#profileView').innerHTML = `
      ${p.summary ? `<div class="profile-section"><b>总体情况</b>${escHtml(p.summary)}</div>` : '<div class="profile-section">（暂无，聊天几次后 AI 会自动归纳）</div>'}
      ${p.goals.length ? `<div class="profile-section"><b>目标</b>${p.goals.map(g => `<div class="fact-item">• ${escHtml(g)}</div>`).join('')}</div>` : ''}
      ${p.facts.length ? `<div class="profile-section"><b>已记住的事实</b>${p.facts.map(f => `<div class="fact-item">• ${escHtml(f.text)} <span style="opacity:.5">${new Date(f.ts).toLocaleDateString('zh-CN')}</span></div>`).join('')}</div>` : ''}
      <div class="hint">上次更新：${new Date(p.updatedAt).toLocaleString('zh-CN')}</div>`;

    $('#digestView').innerHTML = digests.length
      ? digests.slice().reverse().map(d => `<div class="digest-item"><div class="digest-meta">${new Date(d.fromTs).toLocaleDateString('zh-CN')} → ${new Date(d.toTs).toLocaleDateString('zh-CN')}</div>${escHtml(d.content)}</div>`).join('')
      : '<div>（暂无滚动摘要，对话满 30 条会自动压缩，也可点上方「立即整理」）</div>';
  }

  // 设置对话模式（自由聊天 / 考试规划）
  async function setChatMode(mode, doReload = true) {
    state.chatMode = mode;
    localStorage.setItem('examai.chatMode', mode);
    // 更新切换按钮高亮
    $$('#modeSwitch .mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    // 更新空状态文案与快捷问题
    const isExam = mode === 'exam';
    $('#emptyIcon').textContent = isExam ? '🎯' : '💬';
    $('#emptyTitle').textContent = isExam ? '考试规划模式' : '你的 AI 聊天伙伴';
    $('#emptyDesc').textContent = isExam
      ? '选中一场考试后，我会围绕它帮你排计划、盯进度。所有对话都会记住，随时切回「自由聊天」也能无缝衔接。'
      : '什么都能聊——学习、工作、生活、答疑、写东西。你说过的每件事我都会长期记住，聊得越久越懂你。想专门规划考试时，点上方「考试规划」切换。';
    const quick = isExam
      ? [
          ['📅 制定本周计划', '帮我根据目前的考试制定一份本周复习计划'],
          ['📊 总结复习进度', '总结一下我现在的复习进度和薄弱环节'],
          ['💪 调整状态', '我最近状态有点焦虑，帮我调整一下计划'],
        ]
      : [
          ['✨ 你能帮我做什么', '你能帮我做什么？'],
          ['🧩 帮我理清一件事', '帮我梳理一下最近让我纠结的事情'],
          ['📖 讲点有意思的', '给我讲讲一个有意思的知识点'],
        ];
    $('#quickStarts').innerHTML = quick.map(q => `<button class="quick-btn" data-q="${q[1]}">${q[0]}</button>`).join('');
    $$('#quickStarts .quick-btn').forEach(b => b.addEventListener('click', () => send(b.dataset.q)));
    $('#input').placeholder = isExam ? '输入消息，例如：帮我排一下今天的复习任务…' : '输入消息，什么都能聊…';
    updateCtxLabel();
    renderBanner();
    if (doReload) await loadMessages();
  }

  function updateCtxLabel() {
    if (state.chatMode === 'exam') {
      const e = state.exams.find(x => x.id === state.examId);
      $('#ctxLabel').textContent = e ? e.name : '考试规划 · 未选考试';
    } else {
      $('#ctxLabel').textContent = '自由聊天';
    }
  }

  // ============================================================
  // 视图 / 设置
  // ============================================================
  function go(view) {
    if (view !== 'chat' && speech.supported) stopSpeech();
    state.view = view;
    $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
    $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
    if (view === 'memory') renderMemory();
  }

  function fillSettings() {
    $('#setApiKey').value = S.apiKey;
    $('#setBaseUrl').value = S.baseUrl;
    $('#setModel').value = S.model;
    $('#setWebSearch').checked = S.webSearch;
    $('#setThinking').checked = S.thinking;
    $('#setCtx').value = S.ctx;
    $('#ctxVal').textContent = S.ctx;
    $('#setMemory').checked = S.memory;
    $('#setAutoConsolidate').checked = S.autoConsolidate;
    updateMemChip();
  }
  function bindSettings() {
    $('#setApiKey').addEventListener('change', e => { S.apiKey = e.target.value.trim(); saveSettings(); });
    $('#setBaseUrl').addEventListener('change', e => { S.baseUrl = e.target.value.trim() || DEFAULT_SETTINGS.baseUrl; saveSettings(); });
    $('#setModel').addEventListener('change', e => { S.model = e.target.value; saveSettings(); });
    $('#setWebSearch').addEventListener('change', e => { S.webSearch = e.target.checked; saveSettings(); });
    $('#setThinking').addEventListener('change', e => { S.thinking = e.target.checked; saveSettings(); });
    $('#setCtx').addEventListener('input', e => { S.ctx = +e.target.value; $('#ctxVal').textContent = S.ctx; saveSettings(); });
    $('#setMemory').addEventListener('change', e => { S.memory = e.target.checked; saveSettings(); updateMemChip(); });
    $('#setAutoConsolidate').addEventListener('change', e => { S.autoConsolidate = e.target.checked; saveSettings(); });
  }
  function updateMemChip() {
    const chip = $('#memChip');
    chip.classList.toggle('off', !S.memory);
    $('#memChipText').textContent = S.memory ? '记忆已开启' : '记忆已关闭';
  }

  async function testConnection() {
    const r = $('#testResult');
    r.textContent = '测试中…'; r.style.color = '';
    if (!S.apiKey) { r.textContent = '请先填写 API Key'; r.style.color = 'var(--danger)'; return; }
    try {
      const res = await fetch(`${S.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${S.apiKey}` },
        body: JSON.stringify({ model: S.model, messages: [{ role: 'user', content: '回复"OK"两个字即可' }], stream: false, thinking: { type: 'disabled' }, max_tokens: 20 }),
      });
      const txt = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}：${txt.slice(0, 140)}`);
      const data = JSON.parse(txt);
      const c = data.choices?.[0]?.message?.content || '';
      r.textContent = `✅ 连接成功（${S.model}）：${c.slice(0, 40)}`;
      r.style.color = 'var(--ok)';
    } catch (e) {
      r.textContent = '❌ 失败：' + e.message;
      r.style.color = 'var(--danger)';
    }
  }

  // ============================================================
  // 事件绑定
  // ============================================================
  function setCompact(on) {
    $('#app').classList.toggle('compact', !!on);
    try { localStorage.setItem('examai.compact', on ? '1' : '0'); } catch (e) {}
  }

  function bind() {
    $('#btnCollapse').addEventListener('click', () => setCompact(true));
    $('#btnExpand').addEventListener('click', () => setCompact(false));
    $$('.tab').forEach(t => t.addEventListener('click', () => go(t.dataset.view)));
    $('#sendBtn').addEventListener('click', () => { const v = $('#input').value; $('#input').value = ''; send(v); });
    $('#input').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const v = e.target.value; e.target.value = ''; send(v); }
    });
    $('#input').addEventListener('input', e => {
      e.target.style.height = 'auto';
      e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
    });
    $('#stopBtn').addEventListener('click', () => state.controller?.abort());

    // ---- 图片：选择 / 压缩 / 删除 / 预览 ----
    $('#btnAttach').addEventListener('click', () => $('#imageInput').click());
    $('#imageInput').addEventListener('change', async e => {
      const files = Array.from(e.target.files || []).filter(f => f.type.startsWith('image/'));
      e.target.value = '';
      if (!files.length) return;
      if (state.pendingImages.length >= MAX_IMGS) { toast(`一条消息最多 ${MAX_IMGS} 张图片`); return; }
      toast('正在处理图片…');
      let added = 0;
      for (const f of files) {
        if (state.pendingImages.length >= MAX_IMGS) { toast(`一条消息最多 ${MAX_IMGS} 张图片`); break; }
        try { state.pendingImages.push(await compressImage(f)); added++; }
        catch (err) { console.error(err); toast('有图片处理失败，已跳过'); }
      }
      if (added) renderPendingImages();
    });
    // 删除待发送图片（事件委托）
    $('#attachPreview').addEventListener('click', e => {
      const del = e.target.closest('.thumb-del');
      if (!del) return;
      state.pendingImages.splice(+del.dataset.idx, 1);
      renderPendingImages();
    });
    // 点击消息里的图片 → 放大预览（事件委托）
    $('#msgList').addEventListener('click', e => {
      const vb = e.target.closest('[data-voice]');
      if (vb) { toggleSpeech(vb); return; }
      const im = e.target.closest('img[data-preview]');
      if (!im) return;
      $('#imgPreview').src = im.src;
      $('#imgModal').hidden = false;
    });

    $('#btnClearChat').addEventListener('click', async () => {
      if (!confirm('清空当前对话记录？（长期记忆档案和摘要会保留）')) return;
      const id = activeKey();
      const msgs = await DB.messagesByExam(id);
      for (const m of msgs) await DB.del('messages', m.id);
      await loadMessages();
      toast('对话已清空');
    });
    $('#btnMemoryHint').addEventListener('click', async () => {
      const exam = state.chatMode === 'exam' ? (state.exams.find(e => e.id === state.examId) || null) : null;
      const sys = await buildSystem(exam, $('#input').value || '你好');
      $('#memModalBody').textContent = sys.text;
      $('#memModal').hidden = false;
    });

    // 模式切换：自由聊天 / 考试规划（快捷按钮由 setChatMode 渲染并绑定）
    $$('#modeSwitch .mode-btn').forEach(btn => btn.addEventListener('click', () => setChatMode(btn.dataset.mode)));

    $('#btnAddExam').addEventListener('click', () => openExamModal(null));
    $('#btnSaveExam').addEventListener('click', async () => {
      const name = $('#exName').value.trim();
      if (!name) { toast('请填写考试名称'); return; }
      const exam = editingExamId ? (state.exams.find(e => e.id === editingExamId) || {}) : { id: uid(), createdAt: now() };
      exam.name = name;
      exam.date = $('#exDate').value;
      exam.subjects = $('#exSubjects').value.split('\n').map(s => s.trim()).filter(Boolean)
        .map(n => {
          const old = (exam.subjects || []).find(s => s.name === n);
          return old || { name: n, done: false };
        });
      await DB.put('exams', exam);
      $('#examModal').hidden = true;
      await loadExams();
      if (!state.examId) await selectExam(exam.id);
      toast('已保存');
    });
    $('#btnDeleteExam').addEventListener('click', async () => {
      if (!editingExamId || !confirm('删除这场考试？相关对话会保留在归档里。')) return;
      await DB.del('exams', editingExamId);
      $('#examModal').hidden = true;
      if (state.examId === editingExamId) { state.examId = null; localStorage.removeItem('examai.currentExam'); await loadMessages(); }
      await loadExams();
      toast('已删除');
    });

    $$('[data-close]').forEach(el => el.addEventListener('click', () => {
      el.closest('.modal').hidden = true;
    }));

    $('#btnConsolidate').addEventListener('click', () => consolidate(false));
    $('#btnExport').addEventListener('click', async () => {
      const data = await DB.exportAll();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `AI助手-备份-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast('已导出备份文件');
    });
    $('#btnImport').addEventListener('click', () => $('#importFile').click());
    $('#importFile').addEventListener('change', async e => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        await DB.importAll(data);
        toast('导入成功，正在刷新…');
        setTimeout(() => location.reload(), 800);
      } catch (err) { toast('导入失败：' + err.message, 3000); }
      e.target.value = '';
    });

    $('#btnTest').addEventListener('click', testConnection);
    bindSettings();
  }

  // ============================================================
  // 启动
  // ============================================================
  async function init() {
    setCompact(localStorage.getItem('examai.compact') === '1');
    bind();
    fillSettings();
    await ensureProfile();
    await loadExams();
    await setChatMode(state.chatMode, false); // 应用模式 UI（不重复加载）
    await loadMessages();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  document.addEventListener('DOMContentLoaded', init);
})();
