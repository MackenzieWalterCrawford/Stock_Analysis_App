#!/bin/bash

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

cleanup() {
    echo ""
    echo "Stopping services..."
    kill $BACKEND_PID $FRONTEND_PID 2>/dev/null
    exit 0
}

trap cleanup INT TERM

echo "=== Stock Analysis App - Dev Startup ==="
echo ""

# Start Docker services
echo "[1/5] Starting PostgreSQL and Redis via Docker Compose..."
docker-compose -f "$ROOT_DIR/docker-compose.yml" up -d

echo "      Waiting for database services to be ready..."
sleep 3

# Install backend dependencies if needed
echo "[2/5] Checking backend dependencies..."
if [ ! -d "$ROOT_DIR/backend/node_modules" ]; then
    echo "      Installing backend dependencies..."
    cd "$ROOT_DIR/backend" && npm install
fi

# Generate Prisma client
echo "[3/5] Generating Prisma client..."
cd "$ROOT_DIR/backend" && npm run prisma:generate

# Install frontend dependencies if needed
echo "[4/5] Checking frontend dependencies..."
if [ ! -d "$ROOT_DIR/frontend/node_modules" ]; then
    echo "      Installing frontend dependencies..."
    cd "$ROOT_DIR/frontend" && npm install
fi

echo "[5/5] Starting servers..."
echo ""
# Start backend - MUST cd into directory so dotenv finds .env file
cd "$ROOT_DIR/backend"
npm run dev &
BACKEND_PID=$!

# Wait for backend to start
sleep 3

# Start frontend - MUST cd into directory
cd "$ROOT_DIR/frontend"
npm run dev &
FRONTEND_PID=$!

echo ""
echo "=========================================="
echo "All services starting!"
echo "  PostgreSQL : localhost:5432"
echo "  Redis      : localhost:6379"
echo "  Backend    : http://localhost:3001"
echo "  Frontend   : http://localhost:5173"
echo ""
echo "  Open the app: http://localhost:5173"
echo ""
echo "Press Ctrl+C to stop all services..."
echo "=========================================="
echo ""

wait
