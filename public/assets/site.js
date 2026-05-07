// Pages are now fully self-contained HTML — this script only adds a few
// progressive enhancements (cookie banner, online image upgrades, reveal
// animations). The page is fully usable without JavaScript.

function maybeShowCookieNotice() {
  const key = "cresteraconstructionauthority_cookie_consent_v1";
  try {
    const current = localStorage.getItem(key);
    if (current) return;
  } catch {
    return;
  }

  const banner = document.createElement("div");
  banner.className = "cookie-banner";
  banner.setAttribute("role", "dialog");
  banner.setAttribute("aria-label", "Cookie notice");

  const msg = document.createElement("p");
  msg.className = "cookie-banner-text";
  msg.textContent = "We use essential cookies to operate this website. Optional analytics/marketing cookies may be enabled later. ";

  const link = document.createElement("a");
  link.href = "/cookie-policy.html";
  link.textContent = "Cookie Policy";
  msg.appendChild(link);
  msg.appendChild(document.createTextNode("."));

  const actions = document.createElement("div");
  actions.className = "cookie-banner-actions";

  const essentialBtn = document.createElement("button");
  essentialBtn.type = "button";
  essentialBtn.className = "submit";
  essentialBtn.textContent = "Essential only";

  const allBtn = document.createElement("button");
  allBtn.type = "button";
  allBtn.className = "submit";
  allBtn.textContent = "Accept optional";
  allBtn.style.background = "var(--accent)";
  allBtn.style.color = "var(--charcoal)";

  function setConsent(value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Ignore storage errors (private mode, disabled storage).
    }
    banner.remove();
  }

  essentialBtn.addEventListener("click", () => setConsent("essential"));
  allBtn.addEventListener("click", () => setConsent("all"));

  actions.appendChild(essentialBtn);
  actions.appendChild(allBtn);

  banner.appendChild(msg);
  banner.appendChild(actions);
  document.body.appendChild(banner);
}

function maybeUpgradeOnlineImages() {
  document.querySelectorAll("img[data-online-src]").forEach((img) => {
    const online = img.getAttribute("data-online-src");
    const fallbackSrc = img.getAttribute("src") || "/assets/images/hero.svg";
    if (!online || img.dataset.onlineTried) return;
    img.dataset.onlineTried = "1";

    const probe = new Image();
    probe.onload = () => {
      img.addEventListener(
        "error",
        () => {
          img.src = fallbackSrc;
        },
        { once: true }
      );
      img.src = online;
    };
    probe.onerror = () => undefined;
    probe.src = online;
  });
}

function maybeUpgradeHeroImage() {
  const el = document.querySelector(".hero.hero-image");
  if (!el) return;
  const online = el.getAttribute("data-hero-online");
  if (!online) return;
  const img = new Image();
  img.onload = () => {
    el.style.setProperty("--hero-image", `url('${online.replace(/'/g, "%27")}')`);
  };
  img.src = online;
}

async function main() {
  maybeShowCookieNotice();
  maybeUpgradeOnlineImages();
  maybeUpgradeHeroImage();

  const reveal = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add("in-view");
          reveal.unobserve(e.target);
        }
      }
    },
    { threshold: 0.12 }
  );
  document.querySelectorAll(".reveal").forEach((el) => reveal.observe(el));

  // Avoid leaving below-the-fold content invisible in environments where
  // intersection updates are delayed (e.g., full-page capture / print).
  const REVEAL_FALLBACK_DELAY_MS = 1200;
  setTimeout(() => {
    document.querySelectorAll(".reveal").forEach((el) => el.classList.add("in-view"));
  }, REVEAL_FALLBACK_DELAY_MS);
}

main();
