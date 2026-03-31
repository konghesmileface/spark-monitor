// World Monitor — Product Homepage interactions
// 1. Nav scroll: transparent → glassmorphism
// 2. Counter animation (IntersectionObserver)
// 3. Scroll reveal ([data-reveal])
// 4. Smooth anchor scrolling

// ── Nav scroll effect ──
const nav = document.getElementById('mainNav');
if (nav) {
  const onScroll = () => {
    if (window.scrollY > 60) {
      nav.classList.add('scrolled');
    } else {
      nav.classList.remove('scrolled');
    }
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

// ── Counter animation ──
function animateCounter(el: HTMLElement) {
  const target = parseInt(el.getAttribute('data-count') || '0', 10);
  if (!target) return; // skip text-only counters like "24/7"
  const duration = 2000;
  const start = performance.now();

  const step = (now: number) => {
    const elapsed = now - start;
    const progress = Math.min(elapsed / duration, 1);
    // ease-out cubic
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = Math.round(eased * target);

    if (target >= 100) {
      el.textContent = current.toLocaleString() + '+';
    } else {
      el.textContent = String(current);
    }

    if (progress < 1) {
      requestAnimationFrame(step);
    }
  };

  requestAnimationFrame(step);
}

// Observe counter elements
const counterEls = document.querySelectorAll<HTMLElement>('[data-count]');
if (counterEls.length > 0) {
  const counterObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          animateCounter(entry.target as HTMLElement);
          counterObserver.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.3 }
  );
  counterEls.forEach((el) => counterObserver.observe(el));
}

// ── Scroll reveal ──
const revealEls = document.querySelectorAll<HTMLElement>('[data-reveal]');
if (revealEls.length > 0) {
  const revealObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          // stagger: add small delay based on element index within parent
          const el = entry.target as HTMLElement;
          const siblings = el.parentElement?.querySelectorAll('[data-reveal]');
          let idx = 0;
          if (siblings) {
            siblings.forEach((sib, i) => {
              if (sib === el) idx = i;
            });
          }
          el.style.transitionDelay = `${idx * 80}ms`;
          el.classList.add('revealed');
          revealObserver.unobserve(el);
        }
      });
    },
    { threshold: 0.1, rootMargin: '0px 0px -40px 0px' }
  );
  revealEls.forEach((el) => revealObserver.observe(el));
}

// ── Smooth anchor scroll ──
document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]').forEach((anchor) => {
  anchor.addEventListener('click', (e) => {
    const href = anchor.getAttribute('href');
    if (!href || href === '#') return;
    const target = document.querySelector(href);
    if (target) {
      e.preventDefault();
      const navHeight = nav?.offsetHeight || 64;
      const top = target.getBoundingClientRect().top + window.scrollY - navHeight;
      window.scrollTo({ top, behavior: 'smooth' });
    }
  });
});
