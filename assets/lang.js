/* Language: English (the default) or Japanese, switched from the button in the menu.
   In Japanese:
   - Pokemon, move and type names are the official Japanese names (PokeAPI, in data/lang/ja.json);
   - short labels - menus, headings, buttons, column names, options, search hints - are in basic Japanese;
   - longer explanations stay in English.
   The page's own text is swapped as it's drawn (and redrawn); what you type is never changed, so the
   calculators keep working on the English names they always used.
   Search boxes take Japanese too (in either language): window.langHit(name, q) / langStarts(name, q)
   say whether an English name's Japanese name contains / starts with what was typed (hiragana or katakana).
   The choice is kept in this browser (localStorage "raidArchiveLang"), like Dark Mode; ?lang=ja / ?lang=en
   in a link sets it. */
(function(){
  var KEY = "raidArchiveLang", lang = "en";
  try{
    var q = new URLSearchParams(location.search).get("lang");
    if(q === "ja" || q === "en") localStorage.setItem(KEY, q);
    lang = localStorage.getItem(KEY) === "ja" ? "ja" : "en";
  }catch(e){}
  window.siteLang = lang;

  // ---- the menu button (in the nav partial; made here if a page has none)
  function wireButton(){
    var panel = document.getElementById("hamburgerPanel"); if(!panel) return;
    var b = document.getElementById("langToggle");
    if(!b){
      var theme = panel.querySelector(".hamburger-theme-toggle");
      b = document.createElement("button"); b.type = "button"; b.id = "langToggle";
      b.className = theme ? theme.className : "hamburger-theme-toggle";
      if(theme) theme.insertAdjacentElement("afterend", b); else panel.insertBefore(b, panel.firstChild);
    }
    b.setAttribute("data-no-ja", "");
    b.textContent = lang === "ja" ? "🌐 English" : "🌐 日本語";
    b.setAttribute("lang", lang === "ja" ? "en" : "ja");
    b.title = lang === "ja" ? "Switch to English" : "日本語に切り替え";
    if(b._langWired) return; b._langWired = true;
    b.addEventListener("click", function(e){
      e.stopPropagation();
      try{ localStorage.setItem(KEY, lang === "ja" ? "en" : "ja"); }catch(err){}
      var u = new URL(location.href); u.searchParams.delete("lang"); location.replace(u.toString());
    });
  }
  if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", wireButton); else wireButton();

  // ---- the data, and Japanese search
  var MAP = null, MOVE = {}, UI = {}, RE = [], JA_OF = {};   // JA_OF: english name -> its Japanese, in katakana
  var kata = function(s){ return String(s).replace(/[ぁ-ゖ]/g, function(c){ return String.fromCharCode(c.charCodeAt(0) + 0x60); }); };
  var hasJa = function(s){ return /[぀-ヿ一-鿿]/.test(s); };
  window.langHit = function(name, q){
    if(!MAP || !q || !hasJa(q)) return false;
    var j = JA_OF[String(name).toLowerCase()]; return !!j && j.indexOf(kata(q).trim()) >= 0;
  };
  window.langStarts = function(name, q){
    if(!MAP || !q || !hasJa(q)) return false;
    var j = JA_OF[String(name).toLowerCase()]; return !!j && j.indexOf(kata(q).trim()) === 0;
  };
  var base = (document.querySelector('script[src*="assets/lang.js"]') || {}).src || "";
  var url = base ? base.replace(/assets\/lang\.js.*$/, "data/lang/ja.json") : "data/lang/ja.json";
  var loading = null;
  function load(){
    if(loading) return loading;
    loading = fetch(url).then(function(r){ return r.json(); }).then(function(d){
      var M = {};
      ["pokemon", "moves", "types"].forEach(function(k){ var o = d[k] || {}; for(var n in o) M[n.toLowerCase()] = o[n]; });   // a type wins a clash...
      var mv = d.moves || {}; for(var n in mv){ var k = n.toLowerCase(); if(M[k] !== mv[n]) MOVE[k] = mv[n]; }   // ...except as a move (Psychic)
      var ui = d.ui || {}; for(var u in ui) UI[u.toLowerCase()] = ui[u];
      RE = (d.re || []).map(function(x){ return [new RegExp(x[0], "i"), x[1]]; });
      ["pokemon", "moves"].forEach(function(k){ var o = d[k] || {}; for(var n in o) JA_OF[n.toLowerCase()] = kata(o[n]); });
      MAP = M;
    }).catch(function(){});
    return loading;
  }
  if(lang !== "ja"){
    // English: the names are only needed once someone types Japanese into a search box
    document.addEventListener("focusin", function(e){ var t = e.target; if(t && t.tagName === "INPUT") load(); }, true);
    return;
  }

  // ---- Japanese: swap the page's text
  document.documentElement.setAttribute("lang", "ja");
  var hide = document.createElement("style"); hide.textContent = "body{opacity:0 !important}";
  document.head.appendChild(hide);
  var shown = function(){ if(hide.parentNode) hide.parentNode.removeChild(hide); };
  setTimeout(shown, 1500);   // never hidden for long, whatever happens

  var SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, INPUT: 1, NOSCRIPT: 1, CODE: 1, PRE: 1 };
  var TYPEISH = /(^|[\s_-])(ty|tys|tyc|tyn|ti|type|types|tf|elem)([\s_-]|$)/i, ctx = null;
  var done = new WeakMap();

  function name(s){
    var k = s.toLowerCase();
    if(MOVE[k] && MAP[k] !== MOVE[k]){   // a word that is both a type and a move: the type in a type chip, else the move
      for(var e = ctx, i = 0; e && i < 4; e = e.parentElement, i++){ if(TYPEISH.test(typeof e.className === "string" ? e.className : "")) return MAP[k]; }
      return MOVE[k];
    }
    return MAP[k] || null;
  }
  function one(s){ return name(s) || UI[s.toLowerCase()] || null; }
  // a name or label; a pattern ("+12 more", "63 bosses · 292 strategies"); or parts joined by " / ", " · ", ", "
  function tr(text, depth){
    var t = text.trim(); if(!t || t.length > 90 || !/[A-Za-z]/.test(t)) return null;
    var v = one(t); if(v) return text.replace(t, v);
    // set aside a leading emoji / arrow / "+ " and trailing ":" "…" "›" "→"
    var m = t.match(/^([^A-Za-z0-9]+)(.+)$/);
    if(m && (v = one(m[2]))) return text.replace(t, m[1] + v);
    m = t.match(/^(.*?[A-Za-z0-9)])(\s*[:…›→.]+\s*)$/);
    if(m && (v = one(m[1]) || (depth < 2 && tr(m[1], depth + 1)))) return text.replace(t, v.trim() + m[2]);
    m = t.match(/^(.+?)( #\d+)$/);
    if(m && (v = one(m[1]))) return text.replace(t, v + m[2]);
    for(var i = 0; i < RE.length; i++){
      var g = t.match(RE[i][0]); if(!g) continue;
      var miss = false;   // a %n part has to be a name or label we know ("for Eternatus"), or the pattern doesn't apply
      var out = RE[i][1].replace(/%(\d)/g, function(_, n){ var s = g[+n] || "", w = one(s) || (depth < 2 && tr(s, depth + 1)); if(!w) miss = true; return w || s; })
                        .replace(/\$(\d)/g, function(_, n){ return g[+n] || ""; });
      if(miss) continue;
      return text.replace(t, out.trim());
    }
    if(depth >= 2) return null;
    var seps = [" / ", " · ", ", "];
    for(var s = 0; s < seps.length; s++){
      if(t.indexOf(seps[s]) < 0) continue;
      var parts = t.split(seps[s]), outp = [], any = false;
      for(var j = 0; j < parts.length; j++){ var p = parts[j].trim(), w = p && (one(p) || tr(p, depth + 1)); if(w){ outp.push(w.trim()); any = true; } else outp.push(p); }
      if(any) return text.replace(t, outp.join(seps[s]));
    }
    return null;
  }
  function skip(el){
    for(var e = el; e && e.nodeType === 1; e = e.parentElement){
      if(SKIP[e.tagName] || e.isContentEditable || e.hasAttribute("data-no-ja")) return true;
      if(e.tagName === "OPTION" && !e.hasAttribute("value")) return true;   // its text is its value
    }
    return false;
  }
  function doText(n){
    if(done.get(n) === n.nodeValue) return;
    var p = n.parentElement; if(!p || skip(p)) return;
    ctx = p;
    var v = tr(n.nodeValue, 0);
    if(v !== null && v !== n.nodeValue) n.nodeValue = v;
    done.set(n, n.nodeValue);
  }
  function doAttr(el, a){
    var t = el.getAttribute(a), mark = "_ja_" + a; if(!t || el[mark] === t) return;
    ctx = el; var v = tr(t, 0); if(v !== null){ el[mark] = v; el.setAttribute(a, v); } else el[mark] = t;
  }
  // a name split up by a search highlight (<mark>Pal</mark>kia): the whole of it
  function doSplit(el){
    if(el._jaSplit === el.textContent || el.children.length > 3) return;
    for(var i = 0; i < el.childNodes.length; i++){ var c = el.childNodes[i]; if(c.nodeType === 1 && (!/^(MARK|B|STRONG|EM)$/.test(c.tagName) || c.children.length)) return; }
    ctx = el; var v = name(el.textContent.trim());
    if(v) el.textContent = v;
    el._jaSplit = el.textContent;
  }
  function el1(n){
    if(n.hasAttribute("title")) doAttr(n, "title");
    if(n.hasAttribute("placeholder")) doAttr(n, "placeholder");
    if(n.firstElementChild && n.querySelector(":scope > mark")) doSplit(n);
  }
  var FILTER = { acceptNode: function(n){
    if(n.nodeType !== 1) return NodeFilter.FILTER_ACCEPT;
    if(n.tagName === "INPUT"){ if(n.hasAttribute("placeholder")) doAttr(n, "placeholder"); return NodeFilter.FILTER_REJECT; }
    return (SKIP[n.tagName] || n.hasAttribute("data-no-ja")) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; } };
  function walk(root){
    if(!root) return;
    if(root.nodeType === 3){ doText(root); return; }
    if(root.nodeType !== 1) return;
    if(root.tagName === "INPUT"){ if(root.hasAttribute("placeholder")) doAttr(root, "placeholder"); return; }
    if(skip(root)) return;
    el1(root);
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, FILTER), n;
    while((n = w.nextNode())){ if(n.nodeType === 3) doText(n); else el1(n); }
  }
  var queued = [], timer = 0;
  function flush(){ timer = 0; var q = queued; queued = []; for(var i = 0; i < q.length; i++) walk(q[i]); }
  function start(){
    var head = document.title.split(" — ")[0], tt = tr(head, 0); if(tt) document.title = document.title.replace(head, tt);
    walk(document.body); shown();
    new MutationObserver(function(ms){
      for(var i = 0; i < ms.length; i++){
        var m = ms[i];
        if(m.type === "childList") for(var j = 0; j < m.addedNodes.length; j++) queued.push(m.addedNodes[j]);
        else queued.push(m.target);
      }
      if(!timer) timer = requestAnimationFrame(flush);
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["title", "placeholder"] });
  }
  load().then(function(){
    if(!MAP){ shown(); return; }
    if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
  });
})();
