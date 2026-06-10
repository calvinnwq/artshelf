/* Artshelf docs — chrome rendered from one manifest. */
(function () {
  "use strict";

  var NAV = [
    {
      title: "Start",
      items: [
        { n: "01", t: "Overview", h: "index.html" },
        { n: "02", t: "Install", h: "install.html" },
        { n: "03", t: "Quickstart", h: "quickstart.html" }
      ]
    },
    {
      title: "Agents",
      items: [
        {
          n: "04", t: "Agent usage", h: "agent-usage.html",
          children: [
            { n: "4.1", t: "Create", h: "agent-create.html" },
            { n: "4.2", t: "Monitor", h: "agent-monitor.html" },
            { n: "4.3", t: "Review", h: "agent-review.html" },
            { n: "4.4", t: "Clean", h: "agent-clean.html" }
          ]
        },
        { t: "Agent skill", h: "https://github.com/calvinnwq/artshelf/blob/main/skills/artshelf/SKILL.md", ext: true }
      ]
    },
    {
      title: "Reference",
      items: [
        { n: "05", t: "CLI reference", h: "reference.html" },
        { t: "GitHub", h: "https://github.com/calvinnwq/artshelf", ext: true }
      ]
    }
  ];

  var ORDER = [];
  NAV.forEach(function (g) {
    g.items.forEach(function (i) {
      if (!i.ext) {
        ORDER.push(i);
        (i.children || []).forEach(function (c) { ORDER.push(c); });
      }
    });
  });

  var page = document.body.dataset.page || "index.html";

  /* ---------- theme ---------- */

  var THEME_KEY = "artshelf-docs-theme";
  function getStoredTheme() {
    try {
      return window.localStorage.getItem(THEME_KEY);
    } catch (_) {
      return null;
    }
  }
  function setStoredTheme(t) {
    try {
      window.localStorage.setItem(THEME_KEY, t);
    } catch (_) {}
  }
  function preferredTheme() {
    return getStoredTheme() ||
      (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  }
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    document.querySelectorAll("[data-theme-toggle]").forEach(function (b) {
      b.setAttribute("aria-pressed", t === "dark" ? "true" : "false");
    });
  }
  document.addEventListener("click", function (e) {
    if (!e.target.closest("[data-theme-toggle]")) return;
    var next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    setStoredTheme(next);
    applyTheme(next);
  });

  /* ---------- sidebar ---------- */

  function navLink(item, child) {
    var a = document.createElement("a");
    a.href = item.h;
    if (item.ext) { a.className = "ext"; a.rel = "noopener"; }
    if (item.h === page) a.setAttribute("aria-current", "page");
    if (item.n) {
      var n = document.createElement("span");
      n.className = "n";
      n.textContent = item.n;
      a.appendChild(n);
    }
    a.appendChild(document.createTextNode(item.t));
    return a;
  }

  function renderSidebar() {
    var nav = document.getElementById("sidebar");
    if (!nav) return;
    NAV.forEach(function (group) {
      var box = document.createElement("div");
      box.className = "nav-group";
      var h = document.createElement("p");
      h.className = "nav-group-title";
      h.textContent = group.title;
      box.appendChild(h);
      group.items.forEach(function (item) {
        box.appendChild(navLink(item));
        if (item.children) {
          var kids = document.createElement("div");
          kids.className = "children";
          kids.setAttribute("aria-label", item.t + " workflow pages");
          item.children.forEach(function (c) { kids.appendChild(navLink(c, true)); });
          box.appendChild(kids);
        }
      });
      nav.appendChild(box);
    });
  }

  /* ---------- pager ---------- */

  function renderPager() {
    var el = document.getElementById("pager");
    if (!el) return;
    var idx = ORDER.findIndex(function (i) { return i.h === page; });
    if (idx < 0) return;
    var prev = ORDER[idx - 1];
    var next = ORDER[idx + 1];
    el.innerHTML = "";
    [["prev", prev, "← Previous"], ["next", next, "Next →"]].forEach(function (def) {
      if (!def[1]) { el.appendChild(document.createElement("span")); return; }
      var a = document.createElement("a");
      a.className = def[0];
      a.href = def[1].h;
      a.innerHTML = '<span class="dir">' + def[2] + '</span><span class="t">' + def[1].t + "</span>";
      el.appendChild(a);
    });
  }

  /* ---------- headings: ids, anchors, toc ---------- */

  function slug(text) {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }

  function renderToc() {
    var toc = document.getElementById("toc");
    var heads = document.querySelectorAll("article h2, article h3");
    var links = [];
    heads.forEach(function (h) {
      if (!h.id) h.id = slug(h.textContent);
      var a = document.createElement("a");
      a.href = "#" + h.id;
      a.textContent = "#";
      a.className = "anchor";
      a.setAttribute("aria-label", "Link to " + h.textContent);
      h.appendChild(a);
      if (toc) {
        var t = document.createElement("a");
        t.href = "#" + h.id;
        t.textContent = h.childNodes[0].textContent.trim();
        if (h.tagName === "H3") t.className = "sub";
        toc.appendChild(t);
        links.push({ head: h, link: t });
      }
    });
    if (!links.length) return;
    /* getBoundingClientRect, not offsetTop: the entrance animation transforms
       sections, which makes them offsetParents and breaks offsetTop math. */
    function spy() {
      var current = links[0];
      links.forEach(function (l) {
        if (l.head.getBoundingClientRect().top <= 120) current = l;
      });
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) {
        current = links[links.length - 1];
      }
      links.forEach(function (l) { l.link.classList.toggle("active", l === current); });
    }
    window.addEventListener("scroll", spy, { passive: true });
    window.addEventListener("resize", spy, { passive: true });
    spy();
  }

  /* ---------- copy buttons ---------- */

  function renderCopy() {
    document.querySelectorAll("article pre").forEach(function (pre) {
      var wrap = document.createElement("div");
      wrap.className = "snippet";
      pre.parentNode.insertBefore(wrap, pre);
      wrap.appendChild(pre);
      var btn = document.createElement("button");
      btn.className = "copy-btn";
      btn.type = "button";
      btn.textContent = "copy";
      btn.addEventListener("click", function () {
        navigator.clipboard.writeText(pre.textContent.trim()).then(function () {
          btn.textContent = "copied";
          btn.classList.add("done");
          setTimeout(function () {
            btn.textContent = "copy";
            btn.classList.remove("done");
          }, 1400);
        });
      });
      wrap.appendChild(btn);
    });
  }

  /* ---------- mobile drawer ---------- */

  document.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-menu]");
    if (btn) {
      var open = document.body.classList.toggle("nav-open");
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      return;
    }
    if (document.body.classList.contains("nav-open") && e.target.closest("#sidebar a")) {
      document.body.classList.remove("nav-open");
    }
  });

  /* ---------- search palette ---------- */

  var INDEX = null;

  function buildIndex() {
    if (INDEX) return Promise.resolve(INDEX);
    var cached = sessionStorage.getItem("artshelf-docs-index-v1");
    if (cached) { INDEX = JSON.parse(cached); return Promise.resolve(INDEX); }
    var parser = new DOMParser();
    return Promise.all(ORDER.map(function (p) {
      return fetch(p.h).then(function (r) { return r.text(); }).then(function (html) {
        var doc = parser.parseFromString(html, "text/html");
        var entries = [{ t: p.t, h: p.h, where: p.t }];
        doc.querySelectorAll("article h2, article h3").forEach(function (head) {
          var text = head.textContent.trim();
          entries.push({ t: text, h: p.h + "#" + slug(text), where: p.t });
        });
        return entries;
      }).catch(function () { return [{ t: p.t, h: p.h, where: p.t }]; });
    })).then(function (lists) {
      INDEX = lists.flat();
      try { sessionStorage.setItem("artshelf-docs-index-v1", JSON.stringify(INDEX)); } catch (e) {}
      return INDEX;
    });
  }

  var palette, paletteInput, paletteResults, backdrop, selIdx = 0;

  function openPalette() {
    if (!palette) buildPalette();
    backdrop.hidden = false;
    palette.hidden = false;
    paletteInput.value = "";
    renderResults("");
    paletteInput.focus();
    buildIndex();
  }

  function closePalette() {
    if (!palette) return;
    backdrop.hidden = true;
    palette.hidden = true;
  }

  function buildPalette() {
    backdrop = document.createElement("div");
    backdrop.className = "palette-backdrop";
    backdrop.hidden = true;
    backdrop.addEventListener("click", closePalette);

    palette = document.createElement("div");
    palette.className = "palette";
    palette.hidden = true;
    palette.setAttribute("role", "dialog");
    palette.setAttribute("aria-label", "Search documentation");

    paletteInput = document.createElement("input");
    paletteInput.type = "search";
    paletteInput.placeholder = "Search pages, sections, commands…";
    paletteInput.addEventListener("input", function () { renderResults(paletteInput.value); });
    paletteInput.addEventListener("keydown", function (e) {
      var items = paletteResults.querySelectorAll("a");
      if (e.key === "ArrowDown") { e.preventDefault(); selIdx = Math.min(selIdx + 1, items.length - 1); paint(items); }
      else if (e.key === "ArrowUp") { e.preventDefault(); selIdx = Math.max(selIdx - 1, 0); paint(items); }
      else if (e.key === "Enter" && items[selIdx]) { items[selIdx].click(); }
    });

    paletteResults = document.createElement("div");
    paletteResults.className = "palette-results";

    palette.appendChild(paletteInput);
    palette.appendChild(paletteResults);
    document.body.appendChild(backdrop);
    document.body.appendChild(palette);
  }

  function paint(items) {
    items.forEach(function (a, i) { a.classList.toggle("sel", i === selIdx); });
    if (items[selIdx]) items[selIdx].scrollIntoView({ block: "nearest" });
  }

  function renderResults(q) {
    selIdx = 0;
    buildIndex().then(function (index) {
      var query = q.trim().toLowerCase();
      var hits = !query
        ? index.filter(function (e) { return !e.h.includes("#"); })
        : index.filter(function (e) { return e.t.toLowerCase().includes(query); }).slice(0, 12);
      paletteResults.innerHTML = "";
      if (!hits.length) {
        var empty = document.createElement("p");
        empty.className = "empty";
        empty.textContent = "No matches — try a command name or stage.";
        paletteResults.appendChild(empty);
        return;
      }
      hits.forEach(function (hit, i) {
        var a = document.createElement("a");
        a.href = hit.h;
        if (i === 0) a.className = "sel";
        var label = document.createElement("span");
        label.textContent = hit.t;
        var where = document.createElement("span");
        where.className = "where";
        where.textContent = hit.where;
        a.appendChild(label);
        a.appendChild(where);
        paletteResults.appendChild(a);
      });
    });
  }

  document.addEventListener("click", function (e) {
    if (e.target.closest("[data-search-open]")) openPalette();
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "/" && !e.target.closest("input, textarea") && (!palette || palette.hidden)) {
      e.preventDefault();
      openPalette();
    } else if (e.key === "Escape") {
      closePalette();
      document.body.classList.remove("nav-open");
    }
  });

  /* ---------- boot ---------- */

  applyTheme(preferredTheme());
  renderSidebar();
  renderPager();
  renderToc();
  renderCopy();
})();
