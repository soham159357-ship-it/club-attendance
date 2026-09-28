(() => {
  const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.13/model/';
  const NAME_RE = /^\p{L}[\p{L}\p{M} .'-]{1,59}$/u;
  const $ = (id) => document.getElementById(id);

  const state = {
    enrolled: null,      // null = unknown, true/false once /api/status answers
    loc: null,           // { lat, lng, accuracy }
    descriptors: null,   // captured face vectors
    stream: null,
    modelsReady: false,
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
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const val = () => ({
    name: $('name').value.trim().replace(/\s+/g, ' '),
    domain: $('domain').value,
    role: $('role').value,
  });
  const detailsValid = () => {
    const v = val();
        return NAME_RE.test(v.name) && v.role;
  };

  function refresh() {
    const detailsOk = detailsValid() && state.enrolled !== null;
    setStep('step-details', detailsOk ? 'ok' : 'idle');

    const enrollOk = state.enrolled !== false || ($('enroll-code').value.trim() && $('consent').checked);
    $('btn-scan').disabled = !(state.stream && state.modelsReady && detailsOk);
    $('btn-submit').disabled = !(detailsOk && enrollOk && state.loc && state.descriptors) || state.submitting;
  }

  // ---------- step 1: details ----------
  let statusTimer;
  function onNameChange() {
    state.enrolled = null;
    state.descriptors = null;
    setStep('step-face', 'idle');
    $('enroll-box').hidden = true;
    clearTimeout(statusTimer);
    if (!NAME_RE.test(val().name)) return refresh();
    statusTimer = setTimeout(async () => {
      try {
        const { enrolled } = await api('/api/status', { name: val().name });
        state.enrolled = enrolled;
        $('enroll-box').hidden = enrolled;
        note($('face-note'), 'info', enrolled
          ? 'Start the camera, then scan your face to verify.'
          : 'Start the camera. Registration takes three quick captures.');
      } catch (e) {
        note($('face-note'), 'error', e.message);
      }
      refresh();
    }, 500);
    refresh();
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

  // ---------- step 3: camera + face ----------
  async function startCamera() {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setStep('step-face', 'error');
      return note($('face-note'), 'error', 'The camera needs a secure (https) connection. Open the https link of this site.');
    }
    try {
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
          audio: false,
        });
      } catch (e) {
        if (e.name !== 'OverconstrainedError') throw e;
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }
      state.stream = stream;
      $('video').srcObject = stream;
      await $('video').play();
      $('cam').hidden = false;
      $('btn-cam').textContent = 'Restart camera';
      note($('face-note'), 'info', 'Centre your face in the oval, then tap Scan my face.');
    } catch (e) {
      setStep('step-face', 'error');
      const msg = {
        NotAllowedError: 'Camera access is blocked. Tap the lock icon in the address bar, set Camera to Allow, then start again.',
        PermissionDeniedError: 'Camera access is blocked. Tap the lock icon in the address bar, set Camera to Allow, then start again.',
        NotFoundError: 'No camera found on this device.',
        DevicesNotFoundError: 'No camera found on this device.',
        NotReadableError: 'Another app is using the camera. Close it and start again.',
        TrackStartError: 'Another app is using the camera. Close it and start again.',
      }[e.name] || 'Could not start the camera. Reload the page and try again.';
      note($('face-note'), 'error', msg);
    }
    refresh();
  }

  function stopCamera() {
    if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }

  // Mean brightness 0-255 of the current frame
  function brightness() {
    const c = $('probe');
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage($('video'), 0, 0, c.width, c.height);
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    return sum / (data.length / 4);
  }

  async function grabFrame() {
    const b = brightness();
    if (b < 55) return { issue: 'Too dark. Face a light source.' };
    if (b > 215) return { issue: 'Too bright or backlit. Turn away from the window or lamp behind you.' };

    const video = $('video');
    const dets = await faceapi
      .detectAllFaces(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 }))
      .withFaceLandmarks()
      .withFaceDescriptors();

    if (dets.length === 0) return { issue: 'No face found. Face the camera with your whole face in the oval.' };
    if (dets.length > 1) return { issue: 'More than one face in view. Only you should be in the frame.' };
    if (dets[0].detection.box.width / video.videoWidth < 0.25) return { issue: 'Move closer to the camera.' };
    return { descriptor: Array.from(dets[0].descriptor) };
  }

  async function scanFace() {
    const need = state.enrolled ? 2 : 3;
    const found = [];
    let lastIssue = '';
    state.descriptors = null;
    setStep('step-face', 'busy');
    $('cam').classList.add('scanning');
    $('btn-scan').disabled = true;
    note($('face-note'), 'info', 'Scanning. Hold still…');

    try {
      for (let attempt = 0; attempt < 10 && found.length < need; attempt++) {
        const r = await grabFrame();
        if (r.descriptor) found.push(r.descriptor);
        else lastIssue = r.issue;
        await sleep(350);
      }
    } catch (e) {
      lastIssue = 'Face scan failed. Reload the page and try again.';
    }

    $('cam').classList.remove('scanning');
    if (found.length >= need) {
      state.descriptors = found;
      setStep('step-face', 'ok');
      note($('face-note'), 'ok', 'Face captured. You can submit now.');
    } else {
      setStep('step-face', 'error');
      note($('face-note'), 'error', lastIssue || 'Could not capture a clear face. Scan again.');
    }
    refresh();
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
        descriptors: state.descriptors,
        enrollCode: $('enroll-code').value.trim(),
        consent: $('consent').checked,
      });
      stopCamera();
      $('flow').hidden = true;
      $('btn-submit').hidden = true;
      note($('submit-note'), '', '');
      $('done-name').textContent = r.name;
      $('done-time').textContent = r.timestamp;
      $('done-status').textContent = r.status;
      $('done').hidden = false;
    } catch (e) {
      note($('submit-note'), 'error', e.message);
      // Face data is single-use: force a fresh scan after any failed attempt
      state.descriptors = null;
      if (['FACE_MISMATCH', 'UNSTABLE_FACE', 'BAD_FACE', 'FACE_ALREADY_ENROLLED'].includes(e.code)) {
        setStep('step-face', 'error');
        note($('face-note'), 'error', 'Scan your face again.');
      } else {
        setStep('step-face', 'idle');
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
  async function loadModels() {
    try {
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
        faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
        faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
      ]);
      state.modelsReady = true;
      note($('face-note'), 'info', 'Enter your details, then start the camera.');
    } catch (e) {
      setStep('step-face', 'error');
      note($('face-note'), 'error', 'Could not load the face models. Check your connection and reload.');
    }
    refresh();
  }

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

    $('name').addEventListener('input', onNameChange);
    $('domain').addEventListener('change', refresh);
    $('role').addEventListener('change', refresh);
    $('enroll-code').addEventListener('input', refresh);
    $('consent').addEventListener('change', refresh);
    $('btn-loc').addEventListener('click', checkLocation);
    $('btn-cam').addEventListener('click', () => { stopCamera(); startCamera(); });
    $('btn-scan').addEventListener('click', scanFace);
    $('btn-submit').addEventListener('click', submit);
    document.addEventListener('visibilitychange', () => { if (document.hidden) stopCamera(); });

    loadModels();
    refresh();
  }

  init();
})();
