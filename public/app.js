(() => {
  const NAME_RE = /^\p{L}[\p{L}\p{M} .'-]{1,59}$/u;
  const $ = (id) => document.getElementById(id);

  const state = {
    cred: null,       // Google sign-in token (checked again by the server)
    loc: null,        // { lat, lng, accuracy }
    submitting: false,
  };

  // ---------- device recognition ----------
  // A random ID kept in this browser; the server also keeps it in a cookie.
  function getDeviceId() {
    try {
      let id = localStorage.getItem('did');
      if (!/^[a-f0-9]{32}$/.test(id || '')) {
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        id = Array.from(bytes, (x) => x.toString(16).padStart(2, '0')).join('');
        localStorage.setItem('did', id);
      }
      return id;
    } catch (_) {
      return ''; // storage blocked: the server cookie still works
    }
  }
  function saveDeviceId(id) {
    try { if (id) localStorage.setItem('did', id); } catch (_) { /* ignore */ }
  }
  // Phone model and settings, used only to flag possible sharing for a human to review
  function fingerprint() {
    const n = navigator, s = window.screen;
    let tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (_) { /* ignore */ }
    return [n.userAgent, n.platform, n.language, `${s.width}x${s.height}`, s.colorDepth,
      window.devicePixelRatio, n.hardwareConcurrency, n.deviceMemory, tz].join('|');
  }

  // ---------- helpers ----------
  async function api(path, body) {
    const res = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch (_) { /* non-JSON error */ }
    if (!res.ok) {
      const err = new Error(data.message || 'Something went wrong. Try again.');
      err.code = data.error;
      throw err;
    }
    return data;
  }

  function note(el, tone, text) {
    el.textContent = text;
    el.dataset.tone = tone;
    el.hidden = !text;
  }
  function setStep(id, s) { $(id).dataset.state = s; }

  const val = () => ({
    name: $('name').value.trim().replace(/\s+/g, ' '),
    domain: $('domain').value, // optional
    role: $('role').value,
  });
  const detailsValid = () => {
    const v = val();
    return !!state.cred && NAME_RE.test(v.name) && !!v.role;
  };

  function refresh() {
    const detailsOk = detailsValid();
    setStep('step-details', detailsOk ? 'ok' : 'idle');
    $('btn-submit').disabled = !(detailsOk && state.loc) || state.submitting;
  }

  // ---------- step 1: Sign in with Google ----------
  function showSignin() {
    $('signed-in').hidden = true;
    $('signin-box').hidden = false;
    const el = $('g-btn');
    el.innerHTML = '';
    const w = Math.min(320, Math.max(200, el.parentElement.clientWidth || 280));
    google.accounts.id.renderButton(el, {
      type: 'standard', theme: 'outline', size: 'large',
      text: 'signin_with', shape: 'rectangular', logo_alignment: 'left', width: w,
    });
  }

  async function onCredential(resp) {
    note($('auth-note'), 'info', 'Checking your account…');
    try {
      const r = await api('/api/auth', { credential: resp.credential });
      state.cred = resp.credential;
      $('signin-box').hidden = true;
      $('signed-in').hidden = false;
      $('who').textContent = `Signed in as ${r.email}`;
      if (!$('name').value.trim() && r.name) $('name').value = r.name;
      note($('auth-note'), '', '');
    } catch (e) {
      state.cred = null;
      note($('auth-note'), 'error', e.message);
    }
    refresh();
  }

  function switchAccount() {
    state.cred = null;
    note($('auth-note'), '', '');
    google.accounts.id.disableAutoSelect();
    showSignin();
    refresh();
  }

  function setupGoogle(clientId) {
    let tries = 0;
    const timer = setInterval(() => {
      if (window.google && google.accounts && google.accounts.id) {
        clearInterval(timer);
        google.accounts.id.initialize({
          client_id: clientId,
          callback: onCredential,
          auto_select: false,
          cancel_on_tap_outside: true,
        });
        showSignin();
      } else if (++tries > 100) {
        clearInterval(timer);
        note($('auth-note'), 'error', 'Could not load Google sign-in. Check your connection and reload. If you opened this link inside WhatsApp or Instagram, open it in Chrome or Safari instead.');
      }
    }, 100);
  }

  // ---------- step 2: location ----------
  function locError(err) {
    switch (err.code) {
      case 1:
        return 'Location is blocked. Tap the lock icon in the address bar, set Location to Allow, then check again.';
      case 2:
        return 'Your device could not find its position. Turn on Location/GPS, then check again.';
      case 3:
        return 'Location timed out. Move near a window or outdoors and try again.';
      default:
        return 'Could not read your location.';
    }
  }

  function checkLocation() {
    if (!('geolocation' in navigator)) {
      setStep('step-location', 'error');
      return note($('loc-note'), 'error', 'This browser does not support location. Try Chrome or Safari.');
    }
    setStep('step-location', 'busy');
    note($('loc-note'), 'info', 'Reading your position…');
    state.loc = null;
    refresh();
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude: lat, longitude: lng, accuracy } = pos.coords;
        try {
          const r = await api('/api/check-location', { lat, lng, accuracy });
          state.loc = { lat, lng, accuracy };
          setStep('step-location', 'ok');
          note($('loc-note'), 'ok', `You are at the venue (${Math.round(r.distance)} m from centre, GPS ±${Math.round(accuracy)} m).`);
        } catch (e) {
          setStep('step-location', 'error');
          note($('loc-note'), 'error', e.message);
        }
        refresh();
      },
      (err) => {
        setStep('step-location', 'error');
        note($('loc-note'), 'error', locError(err));
        refresh();
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
    );
  }

  // ---------- submit ----------
  async function submit() {
    state.submitting = true;
    refresh();
    note($('submit-note'), 'info', 'Submitting…');
    const v = val();
    try {
      const r = await api('/api/attendance', {
        ...v,
        credential: state.cred,
        lat: state.loc.lat,
        lng: state.loc.lng,
        accuracy: state.loc.accuracy,
        deviceId: getDeviceId(),
        fp: fingerprint(),
      });
      saveDeviceId(r.deviceId);
      $('flow').hidden = true;
      $('btn-submit').hidden = true;
      note($('submit-note'), '', '');
      $('done-name').textContent = r.name;
      $('done-email').textContent = r.email;
      $('done-time').textContent = r.timestamp;
      $('done-status').textContent = r.status;
      $('done').hidden = false;
    } catch (e) {
      note($('submit-note'), 'error', e.message);
      if (e.code === 'BAD_EMAIL' || e.code === 'AUTH_FAILED') {
        // Sign-in was refused or has expired: ask for a fresh one
        state.cred = null;
        note($('auth-note'), 'error', e.message);
        showSignin();
      }
      if (['OUT_OF_RANGE', 'LOW_ACCURACY', 'BAD_LOCATION'].includes(e.code)) {
        state.loc = null;
        setStep('step-location', 'error');
        note($('loc-note'), 'error', e.message);
      }
    } finally {
      state.submitting = false;
      refresh();
    }
  }

  // ---------- boot ----------
  async function init() {
    try {
      const cfg = await api('/api/config');
      $('club-name').textContent = cfg.clubName;
      document.title = `${cfg.clubName} – mark attendance`;
      for (const d of cfg.domains) $('domain').add(new Option(d, d));
      for (const r of cfg.roles) $('role').add(new Option(r, r));
      setupGoogle(cfg.clientId);
    } catch (e) {
      note($('submit-note'), 'error', 'Could not reach the server. Reload the page.');
    }

    $('name').addEventListener('input', refresh);
    $('btn-switch').addEventListener('click', switchAccount);
    $('domain').addEventListener('change', refresh);
    $('role').addEventListener('change', refresh);
    $('btn-loc').addEventListener('click', checkLocation);
    $('btn-submit').addEventListener('click', submit);
    refresh();
  }

  init();
})();
