## ffmpeg-worker

HTTP service to:
- download Google Drive video/audio using an OAuth access token
- clip + resize to 1080x1920 using ffmpeg
- optionally mix background music
- upload the rendered clip back to Google Drive

### Run locally
```bash
npm i
npm start
# http://localhost:3000/health
