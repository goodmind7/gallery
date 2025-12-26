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

## Publish to Docker Hub (App Image)

- Login:
```bash
docker login
```
- Build the app image:
```bash
docker build -t iyfhan/gallery-app:latest app
```
- Push:
```bash
docker push iyfhan/gallery-app:latest
```

## Release Tags

- Build and push a versioned tag (e.g., 1.0.0):
```bash
docker build -t iyfhan/gallery-app:1.0.0 app
docker push iyfhan/gallery-app:1.0.0
```
- The production compose pins the app image to `iyfhan/gallery-app:1.0.0` for reproducible deploys. To upgrade:
```bash
# build & push new tag
docker build -t iyfhan/gallery-app:1.0.1 app
docker push iyfhan/gallery-app:1.0.1

# update docker-compose.prod.yml image to iyfhan/gallery-app:1.0.1
# then redeploy
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

## Run on PC (Production Compose)

1. Copy the project folder or clone it to your PC.
2. Create `.env` from the example and edit secrets:
```bash
cp .env.example .env
```
3. Start with the production compose:
```bash
docker compose -f docker-compose.prod.yml up -d
```
4. Visit `http://localhost:8080`.

Note: Production MySQL is pinned to `8.0.40` in `docker-compose.prod.yml` to avoid unexpected upgrades. To change versions, update the image tag and re-create the DB volume (see reset steps below).

### Nginx Version Pin
- Both dev and prod compose files pin nginx to `nginx:1.27-alpine` to avoid surprise upgrades.
- To upgrade nginx:
```bash
# edit docker-compose*.yml to a new tag, e.g., nginx:1.27.2-alpine
docker compose pull
docker compose up -d
```

### MySQL Initialization Notes
- The production compose uses a named volume `mysql_data` so the database initializes cleanly from `db/init.sql` on first run.
- If you previously mounted `./data/mysql`, the init script will NOT run because the data directory isn’t empty.
- To reset safely:
```bash
docker compose down
mv data/mysql data/mysql.backup-$(date +%F)
docker volume rm $(docker volume ls -q | grep mysql_data) || true
docker compose -f docker-compose.prod.yml up -d
```
This will allow MySQL to initialize fresh and apply `db/init.sql`.
