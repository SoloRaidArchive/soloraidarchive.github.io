/* Falling season particles (leaves, snowflakes, petals, sparkles) in the empty margins beside a page's
   content. Each particle falls at its own speed with its own sway and spin. The shape comes from
   assets/seasons.css (--season-shape), so the light/dark switch and the "Default theme" button
   (which removes data-season) need nothing from here.
   The margins are measured from the page itself: everything that isn't fixed and isn't a full-width
   wrapper counts as content, so particles never cross a card, a heading or a table. A side narrower
   than MIN_GUTTER gets none. When neither side is wide enough (smaller desktop windows), particles
   fall across the whole window instead, behind the content (the layer sits under the page), so they
   show between and around the cards. Phones (narrower than MIN_WINDOW) get none. */
(function(){
  if(!document.documentElement) return;
  var MIN_GUTTER = 56, PAD = 24, PER_PX = 1 / 11.5, MAX_PER_SIDE = 16;
  var MIN_WINDOW = 700, BEHIND_PER_PX = 1 / 48, MAX_BEHIND = 26;
  var SPIN = { winter: 25, spring: 70, summer: 30, fall: 80 };
  var layer = null, lastKey = "";

  function rnd(a, z){ return a + Math.random() * (z - a); }

  // Left and right edge of the content, in viewport pixels.
  function contentEdges(){
    var vw = document.documentElement.clientWidth, L = vw, R = 0;
    function take(l, r){ if(r <= 0 || l >= vw) return; if(l < L) L = l; if(r > R) R = r; }
    function text(el){
      for(var n = el.firstChild; n; n = n.nextSibling){
        if(n.nodeType === 3 && n.textContent.trim()){
          var rg = document.createRange(); rg.selectNodeContents(n); var b = rg.getBoundingClientRect();
          if(b.width) take(b.left, b.right);
        }
      }
    }
    function walk(el, depth){
      for(var c = el.firstElementChild; c; c = c.nextElementSibling){
        if(c === layer || /^(SCRIPT|STYLE|LINK|TEMPLATE|NOSCRIPT)$/.test(c.tagName)) continue;
        var cs = getComputedStyle(c);
        if(cs.display === "none" || cs.visibility === "hidden" || cs.position === "fixed") continue;
        var r = c.getBoundingClientRect();
        if(r.width < 1 || r.height < 1){ if(cs.display === "contents") walk(c, depth + 1); continue; }
        if(r.right <= 0 || r.left >= vw) continue;   // parked off screen (closed panels)
        // the round buttons in the top corners (menu, settings): particles just pass behind them
        if(r.top + window.scrollY < 90 && r.width <= 120 && r.height <= 90 && (r.left < 120 || r.right > vw - 120)) continue;
        if(r.width >= vw - 40 && depth < 8){ text(c); walk(c, depth + 1); continue; }   // full-width wrapper: look inside
        take(r.left, r.right);
      }
    }
    if(document.body) walk(document.body, 0);
    if(L >= R) return null;
    return { vw: vw, left: L, right: R };
  }

  function build(){
    var e = contentEdges(); if(!e) return;
    var gl = Math.floor(e.left - PAD), gr = Math.floor(e.vw - e.right - PAD);
    var key = e.vw + ":" + gl + ":" + gr;
    if(key === lastKey) return;
    lastKey = key;
    var season = document.documentElement.getAttribute("data-season") || "fall";
    var spin = SPIN[season] || 40, html = "";
    var sides = [["l", gl, 0], ["r", gr, e.vw - gr]];
    // no room beside the content: the whole window, behind it (not on phones)
    if(gl < MIN_GUTTER && gr < MIN_GUTTER) sides = e.vw >= MIN_WINDOW ? [["all", e.vw, 0, MAX_BEHIND, BEHIND_PER_PX]] : [];
    sides.forEach(function(side){
      var w = side[1]; if(w < MIN_GUTTER) return;
      var n = Math.min(side[3] || MAX_PER_SIDE, Math.max(3, Math.round(w * (side[4] || PER_PX))));
      for(var i = 0; i < n; i++){
        var size = rnd(11, 22), amp = rnd(6, 16);
        var room = w - size - 2 * amp - 8;                       // keep the sway inside the margin
        var x = side[2] + amp + 4 + Math.max(0, room) * Math.min(1, (i + rnd(0.1, 0.9)) / n);
        var d = rnd(22, 42), s = rnd(2.8, 5.5), r0 = rnd(-spin, spin);
        html += '<span class="pf" style="left:' + x.toFixed(0) + 'px;width:' + size.toFixed(1) + 'px;height:' + size.toFixed(1)
          + 'px;opacity:' + rnd(0.65, 1).toFixed(2) + ';--d:' + d.toFixed(1) + 's;--delay:-' + rnd(0, d).toFixed(1)
          + 's;--y0:' + rnd(0, 100).toFixed(0) + 'vh;--s:' + s.toFixed(1) + 's;--sdelay:-' + rnd(0, s).toFixed(1)
          + 's;--amp:' + amp.toFixed(0) + 'px;--r0:' + r0.toFixed(0) + 'deg;--r1:' + (r0 + rnd(-spin, spin)).toFixed(0) + 'deg"><i></i></span>';
      }
    });
    if(!layer){
      layer = document.createElement("div");
      layer.className = "pf-layer"; layer.setAttribute("aria-hidden", "true");
      document.body.insertBefore(layer, document.body.firstChild);
    }
    layer.innerHTML = html;
  }

  function start(){
    build();
    // lists that load after the page (raids, tables) can widen the content - look again a little later
    setTimeout(build, 1500); setTimeout(build, 5000);
    var t; window.addEventListener("resize", function(){ clearTimeout(t); t = setTimeout(build, 250); });
  }
  if(document.readyState === "complete") start();
  else window.addEventListener("load", start);
})();
