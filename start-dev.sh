#!/bin/bash
set -e

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== Stock Analysis App - Dev Startup ==="
echo ""

# Start Docker services (PostgreSQL + Redis)
echo "[1/3] Starting PostgreSQL and Redis via Docker Compose..."
docker-compose -f "$ROOT_DIR/docker-compose.yml" up -d

# Wait for health checks to pass
echo "      Waiting for database services to be ready..."
sleep 8

# Start backend in a new terminal window
echo "[2/3] Starting backend server (http://localhost:3001)..."
start "Stock Backend" bash -c "cd '$ROOT_DIR/backend' && npm run dev; echo; echo 'Backend stopped. Press Enter to close.'; read"

sleep 2

# Start frontend in a new terminal window
echo "[3/3] Starting frontend dev server (http://localhost:5173)..."
start "Stock Frontend" bash -c "cd '$ROOT_DIR/frontend' && npm run dev; echo; echo 'Frontend stopped. Press Enter to close.'; read"

echo ""
echo "All services started!"
echo "  PostgreSQL : localhost:5432"
echo "  Redis      : localhost:6379"
echo "  Backend    : http://localhost:3001"
echo "  Frontend   : http://localhost:5173"
echo ""
echo "  Open the app: http://localhost:5173"
echo ""
echo "To stop Docker services later, run: docker-compose down"
