(function () {
  // The step-by-step "Connect your iPhone" guide: one small action per screen, a Next arrow, Back, swipe and arrow keys.
  // The parts the rest of the app talks to (the setup code, the Shortcut links, the first-purchase status) live in index.html.
  const root = document.getElementById('wiz');
  if (!root) return;
  const steps = Array.from(root.querySelectorAll('.wiz-step'));
  const bars = document.getElementById('wiz-bars');
  const back = document.getElementById('wiz-back');
  const next = document.getElementById('wiz-next');
  const count = document.getElementById('wiz-count');
  const done = document.getElementById('onboard-done');
  const onboard = document.getElementById('onboard');
  const last = steps.length - 1;
  let i = 0;
  steps.forEach(() => bars.append(document.createElement('i')));

  const draw = (backward, move) => {
    steps.forEach((s, n) => {
      s.hidden = n !== i;
      s.classList.toggle('wiz-in-back', n === i && !!backward);
    });
    Array.from(bars.children).forEach((b, n) => b.classList.toggle('on', n <= i));
    count.textContent = i === last ? 'All done' : 'Step ' + (i + 1) + ' of ' + last;
    back.hidden = i === 0;
    next.hidden = i === last;
    next.querySelector('span').textContent = i === last - 1 ? 'Finish' : 'Next';
    // Until the last screen the way out is a quiet "Skip for now"; on the last screen it is the main button.
    done.className = i === last ? 'primary wiz-done' : 'btn-plain wiz-skip';
    done.textContent = i === last ? 'Show my spending' : 'Skip for now';
    if (move) {
      const h = steps[i].querySelector('h1');
      if (h) { h.tabIndex = -1; try { h.focus({ preventScroll: true }); } catch (e) { /* older browsers */ } }
      window.scrollTo(0, 0);
    }
  };
  const go = (n, move) => {
    if (n < 0 || n > last) return;
    const backward = n < i;
    i = n;
    draw(backward, move !== false);
  };
  const reset = () => { i = 0; draw(false, false); };

  next.addEventListener('click', () => go(i + 1));
  back.addEventListener('click', () => go(i - 1));
  document.addEventListener('keydown', (e) => {
    if (onboard.hidden) return;
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.key === 'ArrowRight') go(i + 1);
    if (e.key === 'ArrowLeft') go(i - 1);
  });
  // Swiping works anywhere on the screen while the guide is open (the guide itself is only as tall as its content).
  let x0 = null;
  let y0 = null;
  document.addEventListener('touchstart', (e) => {
    if (onboard.hidden) return;
    x0 = e.touches[0].clientX;
    y0 = e.touches[0].clientY;
  }, { passive: true });
  document.addEventListener('touchend', (e) => {
    if (x0 === null || onboard.hidden) { x0 = null; return; }
    const dx = e.changedTouches[0].clientX - x0;
    const dy = e.changedTouches[0].clientY - y0;
    x0 = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? i + 1 : i - 1);
  }, { passive: true });

  window.spendWizard = { reset, go: (n) => go(n), step: () => i, count: steps.length };
  draw(false, false);
})();
