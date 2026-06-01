(function () {
  const storageKey = "shelf-docs-theme";
  const root = document.documentElement;
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
  const toggleIcon = `
    <svg class="theme-icon-moon" viewBox="0 0 20 20" aria-hidden="true"><path d="M14.6 12.1A6.5 6.5 0 0 1 7.4 2.7a6.5 6.5 0 1 0 7.2 9.4z" fill="currentColor"></path></svg>
    <svg class="theme-icon-sun" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="3.4" fill="currentColor"></circle><g stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><line x1="10" y1="2" x2="10" y2="4"></line><line x1="10" y1="16" x2="10" y2="18"></line><line x1="2" y1="10" x2="4" y2="10"></line><line x1="16" y1="10" x2="18" y2="10"></line><line x1="4.2" y1="4.2" x2="5.6" y2="5.6"></line><line x1="14.4" y1="14.4" x2="15.8" y2="15.8"></line><line x1="4.2" y1="15.8" x2="5.6" y2="14.4"></line><line x1="14.4" y1="5.6" x2="15.8" y2="4.2"></line></g></svg>
  `;

  function preferredTheme() {
    const saved = window.localStorage.getItem(storageKey);
    if (saved === "light" || saved === "dark") return saved;
    return systemDark.matches ? "dark" : "light";
  }

  function applyTheme(theme) {
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
      button.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
      button.setAttribute("title", theme === "dark" ? "Switch to light mode" : "Switch to dark mode");
      if (button.innerHTML !== toggleIcon) button.innerHTML = toggleIcon;
    });
  }

  applyTheme(preferredTheme());

  window.addEventListener("DOMContentLoaded", () => {
    applyTheme(preferredTheme());
    document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
      button.addEventListener("click", () => {
        const nextTheme = root.dataset.theme === "dark" ? "light" : "dark";
        window.localStorage.setItem(storageKey, nextTheme);
        applyTheme(nextTheme);
      });
    });
  });

  systemDark.addEventListener("change", () => {
    if (!window.localStorage.getItem(storageKey)) applyTheme(preferredTheme());
  });
})();
