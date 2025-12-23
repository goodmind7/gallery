# Simple Web Gallery (Node.js + MySQL + Nginx)

A minimal image gallery with uploads, built in JavaScript (Node.js), MySQL for metadata, and Nginx serving the frontend and proxying API. Designed to run via Docker on your DXP2800 Ugreen NAS (path: /volume2/docker/gallery) with an N100 CPU.

## Components
- Nginx: Serves `public/` and exposes `/uploads` (static) and proxies `/api/*` to the app.
- App (Node.js): Express API for listing and uploading images; stores metadata in MySQL; saves files to `data/uploads`.
- MySQL: Stores image info (`filename`, `title`, `created_at`). Initialized via `db/init.sql`.

## Quick Start (on NAS)

1. SSH to your NAS and go to the project folder:
```bash
cd /volume2/docker/gallery
```

2. Create `.env` from the example and edit secrets:
```bash
cp .env.example .env
# edit .env with secure passwords
```

3. Build and start services:
```bash
docker compose up -d --build
```

4. Open the gallery:
- URL: http://192.168.0.104:8080
- URL: http://i.goodmind.kr (가비아 A레코드 설정)

## Project Structure
- `docker-compose.yml` — Orchestrates `db`, `app`, and `nginx`.
- `nginx/nginx.conf` — Static files + `/api` proxy; exposes `/uploads`.
- `app/` — Node.js service: Express API, MySQL client, multer for uploads.
- `public/` — Frontend assets (HTML/CSS/JS).
- `db/init.sql` — Creates `images` table on first run.
- `data/` — Persistent volumes: `uploads/` for files, `mysql/` for DB.

## API
- `GET /api/images` — List images (id, filename, title, created_at).
- `POST /api/images` — Upload image (multipart/form-data; fields: `image`, `title`).

## Notes
- Uploaded files are saved to `data/uploads` and served at `/uploads/<filename>`.
- Nginx `client_max_body_size` is set to 20M (adjust in `nginx/nginx.conf`).
- The app reads DB creds from environment variables provided by `docker-compose.yml` and `.env`.

## Maintenance
- Update containers:
```bash
docker compose pull
docker compose up -d --build
```
- View logs:
```bash
docker compose logs -f app
```
- Stop services:
```bash
docker compose down
```

## Troubleshooting
- If `db` is not healthy, ensure the environment variables are correct and the NAS allows container networking.
- Check volume permissions if uploads fail (`data/uploads` must be writable).
