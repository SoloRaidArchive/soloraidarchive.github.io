(function(){
  "use strict";

  var ICON_BASE = "https://duiker101.github.io/pokemon-type-svg-icons/icons/";
  var COLORS = {
    normal:"#9199A1", fire:"#FF9C54", water:"#4D90D5", electric:"#F3D23B", grass:"#63BB5B",
    ice:"#74CEC0", fighting:"#CE4069", poison:"#AB6AC8", ground:"#D97746", flying:"#8FA8DD",
    psychic:"#F97176", bug:"#90C12C", rock:"#C7B78B", ghost:"#5269AC", dragon:"#0A6DC4",
    dark:"#5A5366", steel:"#5A8EA1", fairy:"#EC8FE6"
  };
  var TYPES = Object.keys(COLORS);
  var SE = 1.6, NVE = 0.625, IMM = 0.390625;

  // attacking type -> { defending type: multiplier }; anything absent is neutral.
  var CHART = {
    normal:   { rock:NVE, steel:NVE, ghost:IMM },
    fire:     { grass:SE, ice:SE, bug:SE, steel:SE, fire:NVE, water:NVE, rock:NVE, dragon:NVE },
    water:    { fire:SE, ground:SE, rock:SE, water:NVE, grass:NVE, dragon:NVE },
    electric: { water:SE, flying:SE, electric:NVE, grass:NVE, dragon:NVE, ground:IMM },
    grass:    { water:SE, ground:SE, rock:SE, fire:NVE, grass:NVE, poison:NVE, flying:NVE, bug:NVE, dragon:NVE, steel:NVE },
    ice:      { grass:SE, ground:SE, flying:SE, dragon:SE, fire:NVE, water:NVE, ice:NVE, steel:NVE },
    fighting: { normal:SE, ice:SE, rock:SE, dark:SE, steel:SE, poison:NVE, flying:NVE, psychic:NVE, bug:NVE, fairy:NVE, ghost:IMM },
    poison:   { grass:SE, fairy:SE, poison:NVE, ground:NVE, rock:NVE, ghost:NVE, steel:IMM },
    ground:   { fire:SE, electric:SE, poison:SE, rock:SE, steel:SE, grass:NVE, bug:NVE, flying:IMM },
    flying:   { grass:SE, fighting:SE, bug:SE, electric:NVE, rock:NVE, steel:NVE },
    psychic:  { fighting:SE, poison:SE, psychic:NVE, steel:NVE, dark:IMM },
    bug:      { grass:SE, psychic:SE, dark:SE, fire:NVE, fighting:NVE, poison:NVE, flying:NVE, ghost:NVE, steel:NVE, fairy:NVE },
    rock:     { fire:SE, ice:SE, flying:SE, bug:SE, fighting:NVE, ground:NVE, steel:NVE },
    ghost:    { ghost:SE, psychic:SE, dark:NVE, normal:IMM },
    dragon:   { dragon:SE, steel:NVE, fairy:IMM },
    dark:     { ghost:SE, psychic:SE, fighting:NVE, dark:NVE, fairy:NVE },
    steel:    { ice:SE, rock:SE, fairy:SE, fire:NVE, water:NVE, electric:NVE, steel:NVE },
    fairy:    { fighting:SE, dragon:SE, dark:SE, fire:NVE, poison:NVE, steel:NVE }
  };

  var CSS =
    ".tb-badges{display:inline-flex;flex-wrap:wrap;gap:5px;align-items:center}" +
    ".tb-pill{display:inline-flex;align-items:center;gap:4px;color:#fff;font-weight:800;" +
      "text-transform:capitalize;border-radius:99px;white-space:nowrap;line-height:1;" +
      "font-family:'Manrope',sans-serif;font-size:11.5px;padding:4px 9px 4px 6px}" +
    ".tb-pill img,.head .tb-pill img{width:12px;height:12px;min-width:12px;max-width:12px;" +
      "min-height:12px;max-height:12px;flex:0 0 12px;object-fit:contain;" +
      "filter:brightness(0) invert(1);visibility:visible}" +
    ".tb-pill b{font-weight:800;opacity:.85;margin-left:1px}" +
    ".tb-matchups{display:flex;flex-direction:column;gap:7px;padding:12px 0 14px;" +
      "border-bottom:1px solid var(--border,#e7edf5)}" +
    ".tb-row{display:flex;align-items:flex-start;gap:10px}" +
    ".tb-label{flex:0 0 64px;font-size:11.5px;font-weight:800;letter-spacing:.02em;" +
      "color:var(--ink-dim,var(--text-dim,#767f96));padding-top:4px}" +
    ".tb-row .tb-badges{flex:1;min-width:0}" +
    ".tb-none{font-size:12px;color:var(--ink-dim,var(--text-dim,#767f96));padding-top:3px}" +
    "@media (max-width:480px){.tb-row{flex-direction:column;gap:4px}.tb-label{flex:none;padding-top:0}}";

  function injectCss(){
    if(document.getElementById("tb-style")) return;
    var s = document.createElement("style");
    s.id = "tb-style";
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function esc(s){
    return String(s).replace(/[&<>"]/g, function(c){
      return { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c];
    });
  }

  // parse multiplier into text
  function fmt(m){
    var r = Math.round(m * 1000) / 1000;
    return "×" + (r >= 1 ? r.toFixed(r === 1.6 ? 1 : 2) : String(parseFloat(r.toFixed(3))));
  }

  function pill(type, mult){
    var t = String(type).toLowerCase();
    var bg = COLORS[t] || "#9199A1";
    return '<span class="tb-pill" style="background:' + bg + '" title="' + esc(t) +
      (mult ? " " + fmt(mult) : "") + '">' +
      '<img src="' + ICON_BASE + esc(t) + '.svg" alt="" loading="lazy" onerror="this.remove()">' +
      esc(t) + (mult ? "<b>" + fmt(mult) + "</b>" : "") + "</span>";
  }

  function badgesHTML(types){
    var list = (types || []).filter(Boolean);
    if(!list.length) return "";
    return '<span class="tb-badges">' + list.map(function(t){ return pill(t); }).join("") + "</span>";
  }

  // Damage multiplier of every attacking type against a defender of the given type(s).
  function matchups(types){
    var defs = (types || []).map(function(t){ return String(t).toLowerCase(); }).filter(Boolean);
    var weak = [], resist = [];
    TYPES.forEach(function(atk){
      var m = 1;
      defs.forEach(function(d){ m *= (CHART[atk][d] || 1); });
      if(m > 1.0001) weak.push({ type:atk, mult:m });
      else if(m < 0.9999) resist.push({ type:atk, mult:m });
    });
    weak.sort(function(a, b){ return b.mult - a.mult; });
    resist.sort(function(a, b){ return a.mult - b.mult; });
    return { weak:weak, resist:resist };
  }

  function matchupsHTML(types){
    if(!types || !types.length) return "";
    var m = matchups(types);
    function row(label, list){
      return '<div class="tb-row"><div class="tb-label">' + label + "</div>" +
        (list.length
          ? '<span class="tb-badges">' + list.map(function(x){ return pill(x.type, x.mult); }).join("") + "</span>"
          : '<span class="tb-none">None</span>') + "</div>";
    }
    return '<div class="tb-matchups">' + row("Weak to", m.weak) + row("Resists", m.resist) + "</div>";
  }

  var _load = null, _types = new Map();
  function load(){
    if(_load) return _load;
    _load = fetch("/csv/pokemon-stats.csv").then(function(res){
      if(!res.ok) throw new Error("pokemon-stats.csv HTTP " + res.status);
      return res.text();
    }).then(function(text){
      var lines = text.split(/\r?\n/).filter(function(l){ return l.trim(); });
      var head = lines.shift().split(",").map(function(h){ return h.trim(); });
      var iN = head.indexOf("name"), i1 = head.indexOf("type1"), i2 = head.indexOf("type2");
      lines.forEach(function(l){
        var c = l.split(",");
        var n = (c[iN] || "").trim().toLowerCase();
        var t = [(c[i1] || "").trim().toLowerCase(), (c[i2] || "").trim().toLowerCase()].filter(Boolean);
        if(n && t.length) _types.set(n, t);
      });
      return _types;
    }).catch(function(e){
      _load = null;   // let a later caller retry
      throw e;
    });
    return _load;
  }

  function typesOf(name){ return _types.get(String(name || "").trim().toLowerCase()) || []; }

  function mount(opts){
    injectCss();
    return load().then(function(){
      var types = typesOf(opts.name);
      if(!types.length) return types;     // unknown Pokémon: leave the slots empty rather than guess
      if(opts.badges) opts.badges.innerHTML = badgesHTML(types);
      if(opts.matchups) opts.matchups.innerHTML = matchupsHTML(types);
      return types;
    }).catch(function(e){
      console.error("Type badges unavailable:", e);
      return [];
    });
  }

  window.TypeBadges = {
    mount: mount, load: load, typesOf: typesOf,
    badgesHTML: badgesHTML, matchupsHTML: matchupsHTML, matchups: matchups,
    COLORS: COLORS, TYPES: TYPES
  };
})();
