(() => {
  const NAME_RE = /^\p{L}[\p{L}\p{M} .'-]{1,59}$/u;
  const EMAIL_RE = /^[a-z0-9._%+-]+@vit\.edu$/i;
  const $ = (id) => document.getElementById(id);

  const state = {
    loc: null,        // { lat, lng, accuracy }
    submitting: false,
  };

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
    email: $('email').value.trim().toLowerCase(),
    domain: $('domain').value, // optional
    role: $('role').value,
  });
  const detailsValid = () => {
    const v = val();
    return NAME_RE.test(v.name) && EMAIL_RE.test(v.email) && !!v.role;
  };

  function refresh() {
    const detailsOk = detailsValid();
    setStep('step-details', detailsOk ? 'ok' : 'idle');
    $('btn-submit').disabled = !(detailsOk && state.loc) || state.submitting;
  }

  // ---------- step 1: details ----------
  function checkEmailField() {
    const e = $('email').value.trim();
    if (!e) return note($('email-note'), '', '');
    if (EMAIL_RE.test(e)) return note($('email-note'), 'ok', 'College email accepted.');
    note($('email-note'), 'error', 'Use your college email ending in @vit.edu.');
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
        lat: state.loc.lat,
        lng: state.loc.lng,
        accuracy: state.loc.accuracy,
      });
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
      if (e.code === 'BAD_EMAIL') {
        note($('email-note'), 'error', e.message);
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
    } catch (e) {
      note($('submit-note'), 'error', 'Could not reach the server. Reload the page.');
    }

    $('name').addEventListener('input', refresh);
    $('email').addEventListener('input', () => { checkEmailField(); refresh(); });
    $('domain').addEventListener('change', refresh);
    $('role').addEventListener('change', refresh);
    $('btn-loc').addEventListener('click', checkLocation);
    $('btn-submit').addEventListener('click', submit);
    refresh();
  }

  init();
})();
