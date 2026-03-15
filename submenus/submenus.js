// ---- Submenus — category & source button handling ----

function categoryForSource(src) {
  if (src === 'random') return 'matrix';
  if (src === 'seismic' || src === 'daynight' || src === 'iss') return 'world';
  return 'others';
}

sourceCatBtns.forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const wrap = btn.closest('.source-cat-wrap');
    const isOpen = wrap.classList.contains('open');
    document.querySelectorAll('.source-cat-wrap').forEach(w => w.classList.remove('open'));
    if (!isOpen) wrap.classList.add('open');
  });
});

sourceSubBtns.forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const src = btn.dataset.source;
    const effect = btn.dataset.effect;
    if (effect) {
      if (dataSource !== 'random') activateSource('random');
      subEffect = effect;
      setColorGroupDisabled(subEffect === 'rainbow');
      sourceSubBtns.forEach(b => b.classList.toggle('active', b === btn));
      startSubEffect();
      if (subEffect === 'classic') drawAll();
    } else {
      activateSource(src);
    }
    document.querySelectorAll('.source-cat-wrap').forEach(w => w.classList.remove('open'));
  });
});

// ---- Initialise ----
resetToDefaults();
loadWorldMap();
