// Theme toggle
  const root = document.documentElement;
  const elTheme = document.getElementById('toggleTheme');

  // Set favicon based on current theme.
  function setFaviconByTheme(theme) {
    try {
      const isLight = theme === 'light';
      const href = isLight ? './assets/favicon-dark.ico' : './assets/favicon.ico';
      let link = document.querySelector('link[rel="icon"][data-dyn]');
      if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        link.setAttribute('data-dyn', '1');
        link.sizes = 'any';
        document.head.appendChild(link);
      }
      const abs = new URL(href, location.href).href;
      if (link.href !== abs) link.href = href;
    } catch {}
  }

  function applyTheme(theme) {
    const isLight = theme === 'light';
    root.setAttribute('data-theme', theme);
    if (elTheme) {
      const icon = elTheme.querySelector('img');
      if (icon) {
        icon.src = isLight ? './assets/sun.svg' : './assets/moon.svg';
      }
    }
    // Update favicon to match theme
    setFaviconByTheme(theme);
  }
  
  // Initialize theme on page load
  function initTheme() {
    const saved = localStorage.getItem('theme');
    let theme = saved;
  
    // If no saved theme, use the system preference
    if (!theme) {
      theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
  
    applyTheme(theme);
    requestAnimationFrame(() => {
      root.classList.remove('no-theme-transition');
    });
  }
  
  // Listen for system preference changes
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', (e) => {
    if (!localStorage.getItem('theme')) { // only auto-update if the user didn’t choose manually
      const newTheme = e.matches ? 'light' : 'dark';
      applyTheme(newTheme);
    }
  });
  
  // Toggle button logic
  if (elTheme) {
    elTheme.addEventListener('click', () => {
      document.body.classList.add('transitioning');
      const current = root.getAttribute('data-theme');
      const theme = current === 'light' ? 'dark' : 'light';
      localStorage.setItem('theme', theme);
      applyTheme(theme);
  
      setTimeout(() => {
        document.body.classList.remove('transitioning');
      }, 300);
    });
  }
  
  initTheme();

  // Mobile menu toggle
  const mobileMenuBtn = document.getElementById('mobileMenuBtn');
  const mobileMenu = document.getElementById('mobileMenu');
  if (mobileMenuBtn && mobileMenu) {
    mobileMenuBtn.addEventListener('click', () => {
      mobileMenuBtn.classList.toggle('active');
      mobileMenu.classList.toggle('active');
    });

    // Close helpers
    const closeMobileMenu = () => {
      mobileMenuBtn.classList.remove('active');
      mobileMenu.classList.remove('active');
    };

    // Close when clicking outside the menu or the button (mobile-friendly)
    const maybeCloseOnOutside = (e) => {
      if (!mobileMenu.classList.contains('active')) return;
      const target = e.target;
      // Don't close if clicking on theme toggle buttons or their children
      const isThemeButton = target.closest('#toggleTheme') || target.closest('#toggleThemeMobile');
      if (isThemeButton) return;
      if (!mobileMenu.contains(target) && !mobileMenuBtn.contains(target)) {
        closeMobileMenu();
      }
    };
    document.addEventListener('click', maybeCloseOnOutside, { passive: true });
    document.addEventListener('touchstart', maybeCloseOnOutside, { passive: true });

    // Close on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && mobileMenu.classList.contains('active')) {
        closeMobileMenu();
      }
    });

    // Close if viewport switches to desktop
    window.addEventListener('resize', () => {
      if (window.innerWidth > 768 && mobileMenu.classList.contains('active')) {
        closeMobileMenu();
      }
    });
  }

  // Sync mobile menu with desktop controls
  function syncMobileMenu() {
    const statusFilter = document.getElementById('statusFilter');
    const sortBy = document.getElementById('sortBy');
    const statusFilterMobile = document.getElementById('statusFilterMobile');
    const sortByMobile = document.getElementById('sortByMobile');
    
    if (statusFilter && statusFilterMobile) {
      statusFilterMobile.value = statusFilter.value;
    }
    if (sortBy && sortByMobile) {
      sortByMobile.value = sortBy.value;
    }
  }

  // API base for Docker Engine (behind a reverse proxy).
  const API_BASE = (window.__API_BASE__ || '/docker'); // Engine API version; proxy to negotiate newer if needed. [web:10][web:19]

  // App state
  let containers = [];
  let statsStreams = new Map();
  let auto = true;
  let pollTimer = null;
  let manualStatsControl = new Set(); // Track containers with manual stats control

  const elList = document.getElementById('list');
  const elCount = document.getElementById('count');
  const elSearch = document.getElementById('search');
  const elStatus = document.getElementById('statusFilter');
  const elSort = document.getElementById('sortBy');
  const elRunning = document.getElementById('statRunning');
  const elStopped = document.getElementById('statStopped');
  const elImages = document.getElementById('statImages');
  const elUpdated = document.getElementById('statUpdated');
  const elRefresh = document.getElementById('refresh');
  const elToggle = document.getElementById('togglePoll');

  // Get configuration from server
  const CONFIG = window.__CONFIG__ || { 
    logLevel: 'info', 
    time: { source: 'local', format: '24h', timeZone: 'UTC' } 
  };
  const TIME_CONFIG = CONFIG.time;
  
  function timeNow() {
    const d = new Date();
    
    // Format based on 12h/24h preference and timezone for local time source
    const opts = {
      hour12: TIME_CONFIG.format === '12h',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZone: TIME_CONFIG.source === 'local' ? TIME_CONFIG.timeZone : undefined
    };
    
    return d.toLocaleTimeString(undefined, opts);
  }
  
  // Error state management
  function setErrorState() {
    const refreshBtn = document.getElementById('refresh');
    const refreshMobileBtn = document.getElementById('refreshMobile');
    if (refreshBtn) refreshBtn.classList.add('error');
    if (refreshMobileBtn) refreshMobileBtn.classList.add('error');
  }
  
  function clearErrorState() {
    const refreshBtn = document.getElementById('refresh');
    const refreshMobileBtn = document.getElementById('refreshMobile');
    if (refreshBtn) refreshBtn.classList.remove('error');
    if (refreshMobileBtn) refreshMobileBtn.classList.remove('error');
  }
  
  // Spin animation management
  function triggerSpin(buttonElement) {
    if (buttonElement && !buttonElement.classList.contains('spinning')) {
      buttonElement.classList.add('spinning');
      setTimeout(() => buttonElement.classList.remove('spinning'), 1000);
    }
  }
  function fmtBytes(n) {
    if (n == null) return '-';
    const units = ['B','KiB','MiB','GiB','TiB'];
    let i=0, v = n;
    while (v >= 1024 && i < units.length-1) { v/=1024; i++; }
    return `${v.toFixed(1)} ${units[i]}`;
  }
  function imageParts(image) {
    if (!image) return {repo:'', tag:''};
    if (image.includes('@')) {
      const [repo] = image.split('@');
      return {repo, tag:'digest'};
    }
    const ix = image.lastIndexOf(':');
    if (ix > 0 && !image.includes('://')) {
      return {repo: image.slice(0, ix), tag: image.slice(ix+1)};
    }
    return {repo: image, tag: 'latest'};
  }
  function portString(p) {
    if (!p || !p.length) return '-';
    return p.map(x => {
      const left = `${x.PrivatePort}/${x.Type}`;
      if (x.PublicPort) return `${x.IP || '0.0.0.0'}:${x.PublicPort} → ${left}`;
      return left;
    }).join(', ');
  }
  function stateChip(state) {
    const s = (state||'').toLowerCase();
    if (s === 'running') return '<span class="chip ok">running</span>';
    if (s === 'exited') return ''; // Don't show exited state chip
    if (s === 'paused') return '<span class="chip warn">paused</span>';
    if (s === 'restarting') return '<span class="chip warn">restarting</span>';
    if (s === 'created') return '<span class="chip">created</span>';
    return `<span class="chip">${s||'unknown'}</span>`;
  }
  // Rate limiting state
  const rateLimiter = {
    lastRequest: 0,
    minInterval: 1000, // Minimum time between requests (1 second)
    backoffInterval: 1000, // Start with 1 second backoff
    maxBackoff: 10000, // Maximum backoff of 10 seconds
  };

  async function fetchJSON(url, opts) {
    try {
      // Implement rate limiting
      const now = Date.now();
      const timeSinceLastRequest = now - rateLimiter.lastRequest;
      
      if (timeSinceLastRequest < rateLimiter.minInterval) {
        await new Promise(resolve => setTimeout(resolve, rateLimiter.minInterval - timeSinceLastRequest));
      }

      rateLimiter.lastRequest = Date.now();
      const r = await fetch(url, opts);

      if (r.ok) {
        // Reset backoff on success
        rateLimiter.backoffInterval = 1000;
        return await r.json();
      }

      if (r.status === 429) {
        // Increase backoff time
        rateLimiter.backoffInterval = Math.min(rateLimiter.backoffInterval * 2, rateLimiter.maxBackoff);
        rateLimiter.minInterval = rateLimiter.backoffInterval;
        throw new Error(`Rate limited - backing off for ${rateLimiter.backoffInterval/1000} seconds`);
      }

      throw new Error(`HTTP ${r.status} ${r.statusText} - ${url}`);
    } catch (error) {
      if (error instanceof TypeError && error.message.includes('Failed to fetch')) {
        throw new Error(`Cannot connect to Docker API at ${url} - Is the Docker daemon running and accessible?`);
      }
      throw error;
    }
  }



  async function loadContainers() {
    // Clear error state on new load attempt
    clearErrorState();
    
    try {
      // Store active stats streams before updating
      const activeStatsIds = Array.from(statsStreams.keys());
      
      const list = await fetchJSON(`${API_BASE}/containers/json?all=1`);
      
      // If the fetch was successful, update the containers list
      if (list) {
        containers = list.map(c => ({
          id: c.Id,
          names: c.Names || [],
          name: (c.Names && c.Names[0]) ? c.Names[0].replace(/^\//,'') : c.Id.slice(0,12),
          image: c.Image || '',
          state: c.State || '',
          status: c.Status || '',
          ports: c.Ports || [],
          created: c.Created ? (typeof c.Created === 'number' ? c.Created*1000 : new Date(c.Created).getTime()) : 0,
          cpu: null,
          mem: null,
          memLimit: null
        }));
      }
      
      updateSummary();
      render();
      
      // Preserve the active stats streams and their indicators after re-rendering
      // This ensures the red dots stay visible after container data refresh
      activeStatsIds.forEach(id => {
        if (containers.find(c => c.id === id) && statsStreams.has(id)) {
          updateStatsIndicator(id, true);
        }
      });
      
      // If auto mode is enabled, start stats for running containers
      // BUT respect manual control - don't override user's explicit choices
      if (auto) {
        containers.filter(c => c.state === 'running').forEach(c => {
          // Only start stats if:
          // 1. Stream is not already active
          // 2. User hasn't manually disabled it
          if (!statsStreams.has(c.id) && !manualStatsControl.has(c.id)) {
            openStatsStream(c.id);
            updateStatsIndicator(c.id, true);
          }
        });
      }
      
      // Clear error state on successful load
      clearErrorState();
    } catch (error) {
      setErrorState();
      console.error('Failed to load containers:', error);
    }
  }

  function updateSummary() {
    const running = containers.filter(c => c.state==='running').length;
    const images = new Set(containers.map(c => c.image)).size;
    const stopped = containers.length - running;
    elRunning.textContent = running;
    elStopped.textContent = stopped;
    elImages.textContent = images;
    elUpdated.textContent = timeNow();
    elCount.textContent = `${containers.length} containers`;
  }

  function filtered() {
    const q = elSearch.value.trim().toLowerCase();
    const st = elStatus.value;
    let arr = containers.filter(c => {
      const matchesQ = !q || c.name.toLowerCase().includes(q) || c.image.toLowerCase().includes(q);
      const matchesS = !st || c.state === st;
      return matchesQ && matchesS;
    });
    const s = elSort.value;
    if (s === 'name') arr.sort((a,b)=>a.name.localeCompare(b.name));
    if (s === 'state') arr.sort((a,b)=>a.state.localeCompare(b.state) || a.name.localeCompare(b.name));
    if (s === 'created') arr.sort((a,b)=>b.created - a.created);
    return arr;
  }

  function render() {
    const newOrder = filtered();
    const newIds = new Set(newOrder.map(c => c.id));
    const currentElements = Array.from(elList.children);
    const currentIds = new Set(currentElements.map(el => el.dataset.id));
  
    // 1. Remove elements that are no longer present
    currentElements.forEach(el => {
      if (!newIds.has(el.dataset.id)) {
        el.remove();
      }
    });
  
    // 2. Add new elements and update existing ones
    newOrder.forEach((c, index) => {
      const existingEl = elList.querySelector(`[data-id="${c.id}"]`);
      if (existingEl) {
        // Update existing card's content if needed
        updateCard(existingEl, c);
      } else {
        // Create a new card if it doesn't exist
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = renderCard(c);
        const newEl = tempDiv.firstElementChild;
        // Insert it into the correct position
        const nextEl = elList.children[index];
        elList.insertBefore(newEl, nextEl || null);
      }
    });
  
    // 3. Re-order existing elements to match the new sort order
    newOrder.forEach((c, index) => {
      const el = elList.querySelector(`[data-id="${c.id}"]`);
      if (elList.children[index] !== el) {
        elList.insertBefore(el, elList.children[index]);
      }
    });
  
    if (elList.children.length === 0) {
      elList.innerHTML = `<div class="card">No containers match.</div>`;
    }
  }

  function updateCard(el, c) {
    // Update dot class
    const dot = el.querySelector('.dot');
    const dotClass = c.state === 'running' ? 'ok' : (c.state === 'exited' ? 'down' : '');
    if (dot && dot.className !== `dot ${dotClass}`) {
      dot.className = `dot ${dotClass}`;
    }

    // Update state chip using data attribute
    const stateChip = el.querySelector('.chips [data-chip-type="state"]');
    if (c.state === 'exited') {
      // Remove the state chip for exited containers if it exists
      if (stateChip) {
        stateChip.remove();
      }
    } else if (stateChip) {
      // Update existing state chip
      if (stateChip.textContent !== c.state) {
        stateChip.className = `chip ${dotClass}`;
        stateChip.textContent = c.state;
      }
    } else if (c.state) {
      // Create state chip if it doesn't exist and state is not exited
      const statusChip = el.querySelector('.chips [data-chip-type="status"]');
      const newStateChip = document.createElement('span');
      newStateChip.className = `chip ${dotClass}`;
      newStateChip.setAttribute('data-chip-type', 'state');
      newStateChip.textContent = c.state;
      if (statusChip) {
        statusChip.parentNode.insertBefore(newStateChip, statusChip);
      }
    }

    // Update status chip using data attribute
    const statusChip = el.querySelector('.chips [data-chip-type="status"]');
    if (statusChip && statusChip.textContent !== c.status) {
      statusChip.textContent = c.status;
    }
  }

  function renderCard(c) {
    const {repo, tag} = imageParts(c.image);
    const ports = portString(c.ports);
  const dotClass = c.state==='running' ? 'ok' : (c.state==='exited' ? 'down' : '');
  const cpu = c.cpu==null ? '' : `${c.cpu.toFixed(1)}%`;
  const mem = c.mem==null ? '' : `${fmtBytes(c.mem)}${c.memLimit?` / ${fmtBytes(c.memLimit)}`:''}`;
    const created = c.created ? new Date(c.created).toLocaleString(undefined, {
    hour12: TIME_CONFIG.format === '12h',
    timeZone: TIME_CONFIG.source === 'local' ? TIME_CONFIG.timeZone : undefined,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }) : '-';
    const imgHref = guessImageURL(repo, tag);

    return `
      <div class="card" data-id="${c.id}">
        <div class="head">
          <div>
            <div class="name">
              <span class="dot ${dotClass}"></span>
              <span>${escapeHTML(c.name)}</span>
            </div>
            <div class="id">${c.id.slice(0,12)}</div>
          </div>
          <div class="chips">
            ${c.state && c.state !== 'exited' ? `<span class="chip ${dotClass}" data-chip-type="state">${escapeHTML(c.state)}</span>` : ''}
            ${c.status ? `<span class="chip" data-chip-type="status">${escapeHTML(c.status)}</span>` : ''}
            <button class="chip icon-chip" data-action="stats" data-id="${c.id}" title="Toggle live stats">
              <div class="stats-indicator"></div>
            </button>
          </div>
        </div>

        <div class="row">
          <div class="col image">
            <div class="image-placeholder" aria-hidden="true"></div>
            <div class="image-link" style="margin-top:6px;">
              <a href="${imgHref}" target="_blank" rel="noreferrer noopener">${escapeHTML(repo)}:${escapeHTML(tag)}</a>
            </div>
          </div>

          <div class="col stats-col">
            <div class="usage">CPU: <span data-cpu="${c.id}">${cpu}</span> Mem: <span data-mem="${c.id}">${mem}</span></div>
          </div>

          <div class="col"></div>
          
          <div class="col ports">${escapeHTML(ports)}</div>
        </div>

        <div class="grid hide-md" style="margin-top:8px">
          <div class="col"><span class="chip">Created</span> ${escapeHTML(created)}</div>
          <div class="col image-id-col">
            <span class="chip">Image ID</span><span class="image-id-text">${escapeHTML(repo)}</span>
          </div>
          <div class="col"><span class="chip">Tag</span> ${escapeHTML(tag)}</div>
          <div class="col"></div><div class="col"></div><div class="col"></div>
        </div>
      </div>
    `;
  }

  function escapeHTML(s) {
    return (s==null?'':String(s)).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  }
  function guessImageURL(repo, tag) {
    if (!repo) return '#';
    if (repo.includes('/') && !repo.startsWith('library/')) {
      return `https://${repo.split('/')[0]}/${repo.split('/').slice(1).join('/')}:${tag}`;
    }
    const name = repo.includes('/') ? repo.split('/')[1] : repo;
    return `https://hub.docker.com/_/${encodeURIComponent(name)}?tab=tags&name=${encodeURIComponent(tag)}`;
  }

  function updateStatsIndicator(id, isActive) {
    const indicator = document.querySelector(`[data-id="${id}"] .stats-indicator`);
    if (indicator) {
      indicator.classList.toggle('active', isActive);
    }
  }

  function restartStatsStreams() {
    for (const [id, ctl] of statsStreams) { try { ctl.abort(); } catch {} }
    statsStreams.clear();
    // No auto-start to keep the UI fast; start streams via the per-card toggle
  }

  function openStatsStream(id) {
    const ctrl = new AbortController();
    statsStreams.set(id, ctrl);
    const url = `${API_BASE}/containers/${id}/stats?stream=1`; // per-container live stats. [web:10][web:39]
    fetch(url, { signal: ctrl.signal }).then(async r => {
      if (!r.ok || !r.body) throw new Error(`stats ${r.status}`);
      const reader = r.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buf = ''; let lastUpdate = 0;
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        buf += decoder.decode(value, {stream:true});
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx+1);
          if (!line) continue;
          try {
            const obj = JSON.parse(line);
            const ts = performance.now();
            if (ts - lastUpdate > 1000) { // Reduce update frequency to once per second
              lastUpdate = ts;
              updateUsageFromStats(id, obj);
            }
          } catch {}
        }
      }
    }).catch(() => {
      statsStreams.delete(id);
      updateStatsIndicator(id, false);
    });
  }

  // Fetch a single, non-streaming stats snapshot for a container
  async function fetchStatsOnce(id) {
    try {
      const s = await fetchJSON(`${API_BASE}/containers/${id}/stats?stream=0`);
      updateUsageFromStats(id, s);
    } catch (e) {
      // Swallow per-container errors to keep UX smooth on manual refresh
      // console.debug('one-shot stats failed', id, e);
    }
  }

  // When Auto is OFF and user presses Refresh, fetch a one-time stats snapshot
  async function fetchOneShotStatsForVisible() {
    // Only consider currently running containers in the filtered view
    const ids = filtered().filter(c => c.state === 'running').map(c => c.id);
    // Limit concurrency a bit to avoid hammering the engine
    const concurrency = 4;
    let i = 0;
    const next = async () => {
      if (i >= ids.length) return;
      const id = ids[i++];
      await fetchStatsOnce(id);
      return next();
    };
    const workers = Array.from({ length: Math.min(concurrency, ids.length) }, next);
    await Promise.allSettled(workers);
  }

  function updateUsageFromStats(id, s) {
    // CPU% formula consistent with Engine stats output. [web:10][web:39]
    let cpuPct = null;
    try {
      const cpu = s.cpu_stats || {};
      const pre = s.precpu_stats || {};
      const cpuDelta = (cpu.cpu_usage?.total_usage ?? 0) - (pre.cpu_usage?.total_usage ?? 0);
      const sysDelta = (cpu.system_cpu_usage ?? 0) - (pre.system_cpu_usage ?? 0);
      const online = cpu.online_cpus || (cpu.cpu_usage?.percpu_usage?.length || 1);
      cpuPct = (sysDelta > 0 && cpuDelta > 0) ? (cpuDelta / sysDelta) * online * 100 : 0;
    } catch {}
    const memUsage = s.memory_stats?.usage ?? null;
    const memLimit = s.memory_stats?.limit ?? null;

    const elCPU = document.querySelector(`[data-cpu="${id}"]`);
    const elMem = document.querySelector(`[data-mem="${id}"]`);
    if (elCPU && cpuPct != null) elCPU.textContent = `${cpuPct.toFixed(1)}%`;
    if (elMem) elMem.textContent = `${fmtBytes(memUsage)}${memLimit?` / ${fmtBytes(memLimit)}`:''}`;

    const idx = containers.findIndex(c => c.id === id);
    if (idx >= 0) {
      containers[idx].cpu = cpuPct;
      containers[idx].mem = memUsage;
      containers[idx].memLimit = memLimit;
    }
  }

  // Mobile menu elements
  const elStatusMobile = document.getElementById('statusFilterMobile');
  const elSortMobile = document.getElementById('sortByMobile');
  const elRefreshMobile = document.getElementById('refreshMobile');
  const elToggleMobile = document.getElementById('togglePollMobile');
  const elThemeMobile = document.getElementById('toggleThemeMobile');


  // Sync mobile menu events
  function syncMobileEvents() {
    if (elStatus && elStatusMobile) {
      elStatus.addEventListener('change', () => {
        elStatusMobile.value = elStatus.value;
        render();
      });
      elStatusMobile.addEventListener('change', () => {
        elStatus.value = elStatusMobile.value;
        render();
      });
    }
    if (elSort && elSortMobile) {
      elSort.addEventListener('change', () => {
        elSortMobile.value = elSort.value;
        render();
      });
      elSortMobile.addEventListener('change', () => {
        elSort.value = elSortMobile.value;
        render();
      });
    }
    if (elRefresh && elRefreshMobile) {
      elRefreshMobile.addEventListener('click', async () => {
        triggerSpin(elRefreshMobile);
        await loadContainers();
        // If Auto is OFF, do a one-shot stats refresh so CPU/Mem are populated once
        if (!auto) {
          await fetchOneShotStatsForVisible();
        }
      });
    }
    if (elToggle && elToggleMobile) {
      elToggleMobile.addEventListener('click', () => {
        elToggle.click();
      });
    }
  
    if (elTheme && elThemeMobile) {
      elThemeMobile.addEventListener('click', (e) => {
        // Prevent the mobile menu from closing when switching theme
        e.stopPropagation();
        elTheme.click();
      });
    }
  }
  syncMobileEvents();

  // Events
  elSearch.addEventListener('input', () => {
    localStorage.setItem('searchQuery', elSearch.value);
    render();
  });
  elStatus.addEventListener('change', () => {
    localStorage.setItem('statusFilter', elStatus.value);
    render();
  });
  elSort.addEventListener('change', () => {
    localStorage.setItem('sortBy', elSort.value);
    render();
  });
  elRefresh.addEventListener('click', async () => {
    triggerSpin(elRefresh);
    await loadContainers();
    // If Auto is OFF, do a one-shot stats refresh so CPU/Mem are populated once
    if (!auto) {
      await fetchOneShotStatsForVisible();
    }
  });
  elToggle.addEventListener('click', () => {
    auto = !auto;
    localStorage.setItem('autoRefresh', auto);
    elToggle.firstElementChild.textContent = `Auto: ${auto ? 'On' : 'Off'}`;
    if (elToggleMobile) elToggleMobile.firstElementChild.textContent = `Auto: ${auto ? 'On' : 'Off'}`;
    if (auto) {
      startPolling();
      // Enable stats for all running containers when Auto is turned on
      // But respect manual control preferences
      containers.filter(c => c.state === 'running').forEach(c => {
        if (!statsStreams.has(c.id) && !manualStatsControl.has(c.id)) {
          openStatsStream(c.id);
          updateStatsIndicator(c.id, true);
        }
      });
    } else {
      stopPolling();
      // Clear manual control tracking when turning Auto off
      manualStatsControl.clear();
      // Stop all stats streams when Auto is turned off
      for (const [id, ctl] of statsStreams) {
        try { ctl.abort(); } catch {}
        updateStatsIndicator(id, false);
      }
      statsStreams.clear();
    }
  });


  document.getElementById('list').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = btn.getAttribute('data-id');
    const action = btn.getAttribute('data-action');

    if (action === 'stats') {
      const ctl = statsStreams.get(id);
      if (ctl) { 
        // Stop the stats stream for this specific container
        try { ctl.abort(); } catch {} 
        statsStreams.delete(id);
        updateStatsIndicator(id, false);
        // Mark this container as manually controlled (disabled)
        manualStatsControl.add(id);
        // Clear the stats data for this container
        const idx = containers.findIndex(c => c.id === id);
        if (idx >= 0) {
          containers[idx].cpu = null;
          containers[idx].mem = null;
          containers[idx].memLimit = null;
        }
        // Update the display immediately
        const elCPU = document.querySelector(`[data-cpu="${id}"]`);
        const elMem = document.querySelector(`[data-mem="${id}"]`);
  if (elCPU) elCPU.textContent = '';
  if (elMem) elMem.textContent = '';
      } else {
        // Start the stats stream for this specific container
        openStatsStream(id);
        updateStatsIndicator(id, true);
        // Remove from manual control (user wants it enabled)
        manualStatsControl.delete(id);
      }
    }
  });

  function startPolling() {
    stopPolling(); 
    pollTimer = setInterval(() => {
      loadContainers().catch(()=>{});
    }, 5000);
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  // Handle page visibility changes to pause/resume polling
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      // Tab is hidden, stop all polling and stats streams to save resources
      stopPolling();
      for (const [id, ctl] of statsStreams) {
        try { ctl.abort(); } catch {}
        updateStatsIndicator(id, false);
      }
      statsStreams.clear();
      if (CONFIG.logLevel === 'debug') {
        document.title = 'ServAnt - Paused';
      }
    } else {
      // Tab is visible, resume based on 'auto' state
      if (auto) {
        loadContainers().catch(()=>{}); // Refresh immediately
        startPolling();
        // Restart stats streams for running containers, respecting manual control
        containers.filter(c => c.state === 'running').forEach(c => {
          if (!statsStreams.has(c.id) && !manualStatsControl.has(c.id)) {
            openStatsStream(c.id);
            updateStatsIndicator(c.id, true);
          }
        });
      }
      document.title = 'ServAnt';
    }
  });

  (async function init() {
    elSearch.value = localStorage.getItem('searchQuery') || '';
    elStatus.value = localStorage.getItem('statusFilter') || '';
    elSort.value = localStorage.getItem('sortBy') || 'name';
    auto = localStorage.getItem('autoRefresh') !== 'false';
    elToggle.firstElementChild.textContent = `Auto: ${auto ? 'On' : 'Off'}`;
    if (elToggleMobile) elToggleMobile.firstElementChild.textContent = `Auto: ${auto ? 'On' : 'Off'}`;
    syncMobileMenu();

    // Autofocus search on desktop
    if (window.innerWidth > 1024) {
      elSearch.focus();
    }
    
    try {
      await loadContainers();
      startPolling();
      // Enable stats for all running containers on initial load since auto starts as ON
      // On first load, there's no manual control yet, so enable all
      if (auto) {
        containers.filter(c => c.state === 'running').forEach(c => {
          if (!statsStreams.has(c.id)) {
            openStatsStream(c.id);
            updateStatsIndicator(c.id, true);
          }
        });
      }
    } catch (e) {
      document.getElementById('list').innerHTML = `
        <div class="card">
          <div style="font-weight:600;margin-bottom:6px">Cannot reach Docker Engine API</div>
          <div style="color:var(--muted);font-size:14px">
            Please set up a reverse proxy so this app can call
            <code>/docker</code> endpoints. Endpoints used:
            <code>/containers/json?all=1</code>,
            <code>/containers/{id}/stats?stream=1</code>,
            <code>/containers/{id}/json</code>.
          </div>
        </div>
      `;
    }
  })();