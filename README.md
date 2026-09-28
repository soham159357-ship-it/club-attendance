# Club attendance: location + face verified

Members fill in name, domain and position, prove they are at the venue (GPS geofence), and pass a face check. Each success is logged to a Google Sheet.

## Architecture

```
Phone browser                          Node/Express server                 Google Sheets
-------------                          -------------------                 -------------
form + getUserMedia + Geolocation
face-api.js (TF.js, in browser)
  -> 128-number face vectors  --HTTPS-->  /api/attendance
                                          1. validate inputs
                                          2. geofence (haversine, server-side)
                                          3. face match (Euclidean distance)
                                          4. duplicate-per-day check   ------> "Attendance" tab
                                          5. enrollment: encrypt (AES-256-GCM) -> "Faces" tab
```

- Photos never leave the phone. Only 128-number face vectors are sent.
- The geofence and face match are decided on the server. The browser only gives early feedback.
- Face vectors are stored encrypted in a `Faces` tab of the same sheet, and cached in memory when the server starts.

## Files

| File | Purpose |
|---|---|
| `server.js` | API, geofence, face matching, enrollment, rate limiting |
| `lib/sheets.js` | Google Sheets read/write, auto-creates tabs and headers |
| `lib/security.js` | AES-256-GCM, haversine distance, vector maths |
| `public/index.html`, `style.css`, `app.js` | Mobile-first UI, camera, GPS, face capture |
| `.env.example` | All settings |

## Setup

### 1. Google Sheets (service account)

1. Go to https://console.cloud.google.com and create a project.
2. APIs & Services > Library > enable **Google Sheets API**.
3. APIs & Services > Credentials > Create credentials > **Service account**. Finish the wizard.
4. Open the service account > Keys > Add key > Create new key > **JSON**. A file downloads.
5. Create a new Google Sheet. Copy its ID from the URL: `docs.google.com/spreadsheets/d/<THIS_PART>/edit`.
6. Click **Share** and add the service account's email (`client_email` in the JSON) as **Editor**.
7. From the JSON file, copy `client_email` and `private_key` into `.env`.

The app creates the `Attendance` and `Faces` tabs itself. Keep the sheet's sharing limited to club heads, because `Faces` holds encrypted biometric data.

### 2. Configure

```bash
npm install
cp .env.example .env
npm run gen-key        # paste the output as ENCRYPTION_KEY
```

Set `VENUE_LAT` / `VENUE_LNG` (Google Maps: long-press the venue, tap the coordinates), `RADIUS_METERS` (50 to 100), and a private `ENROLL_CODE` to share with members.

Back up `ENCRYPTION_KEY`. If you lose it, stored faces cannot be read and everyone must re-enroll.

### 3. Run

```bash
npm start
```

Open http://localhost:3000 on your computer.

### 4. Camera and location need HTTPS

Browsers only allow camera and GPS on `https://` pages (or `localhost`). To test on a phone:

- Quick test: `npx cloudflared tunnel --url http://localhost:3000` (or ngrok) gives you a temporary https link.
- Real use: deploy to Render, Railway or Fly.io. They give you HTTPS automatically. Add the `.env` values as environment variables there. The `GOOGLE_PRIVATE_KEY` must keep its `\n` sequences.

### 5. Member permissions

- **Location:** tap Allow when prompted. If blocked: tap the lock icon next to the address, set Location to Allow. On iPhone also check Settings > Privacy > Location Services > Safari Websites.
- **Camera:** same steps, set Camera to Allow.
- Turn on the phone's Location (GPS) service. Indoors, stand near a window if accuracy is rejected.

## How verification works

- **Enrollment (first time):** name is unknown, so the app asks for the enrollment code and consent, captures 3 face frames, checks they are consistent, and rejects the face if it already belongs to another name. The averaged vector is encrypted and saved.
- **Attendance (later):** 2 frames are captured and the closest one must be within `FACE_MATCH_THRESHOLD` of the stored vector. Five failures lock that name for 10 minutes.
- One check-in per person per day.
- The app identifies members by full name, so spelling must match the registered name (case and extra spaces are ignored).

## Tuning

| Problem | Change |
|---|---|
| Real members rejected | Raise `FACE_MATCH_THRESHOLD` to 0.55 |
| Lookalikes accepted | Lower it to 0.45 |
| Valid members rejected at the venue | Raise `RADIUS_METERS` or `MAX_GPS_ACCURACY_METERS` |

## Known limits (be honest with your club)

- **Spoofing:** there is no liveness detection, so a printed photo or a photo on another phone could fool it. Adding a blink or head-turn challenge is the next upgrade. In the meantime, keep a head at the venue.
- **GPS can be faked** with developer tools or mock-location apps. The server range check stops honest mistakes, not determined cheating.
- **Biometric data:** get members' consent (the form has a checkbox), tell them where the data lives, and delete a person's row from `Faces` if they ask.
- **Free hosting** may sleep when idle. The first request after a sleep will be slow.
- The face-api.js library and models load from the jsDelivr CDN, so phones need internet access.
