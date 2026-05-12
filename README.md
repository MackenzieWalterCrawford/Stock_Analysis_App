# Stock_Analysis_App

An application for visualizing stock prices and financial ratios.

## Tech Stack

- **Frontend**: React 19 + TypeScript + Vite + Recharts
- **Backend**: Express 5 + TypeScript + Prisma ORM
- **Database**: PostgreSQL 16
- **Cache**: Redis 7
- **Containerization**: Docker Compose

## Prerequisites

- [Node.js](https://nodejs.org/) (v18 or higher)
- [Docker](https://www.docker.com/) and Docker Compose
- npm or yarn

## Quick Start

Run everything (database, backend, and frontend) with a single command:

```bash
./start-dev.sh
```

This will start:
- PostgreSQL on `localhost:5432`
- Redis on `localhost:6379`
- Backend API on `localhost:3001`
- Frontend on `localhost:5173`

## Manual Setup

### 1. Database

Start the PostgreSQL and Redis containers:

```bash
docker-compose up -d
```

This starts:
| Service | Port | Description |
|---------|------|-------------|
| PostgreSQL | 5432 | Primary database |
| Redis | 6379 | Cache layer |
| pgAdmin | 5050 | Database GUI (optional) |

**Database Credentials:**
- Database: `stockdata`
- Username: `stockuser`
- Password: `stockpass123`

### 2. Backend

```bash
cd backend

# Install dependencies
npm install

# Generate Prisma client
npm run prisma:generate

# Run database migrations
npm run prisma:migrate

# Start development server
npm run dev
```

The backend API will be available at `http://localhost:3001`.

**Available Scripts:**
| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server with hot reload |
| `npm run build` | Build for production |
| `npm run start` | Run production build |
| `npm run prisma:studio` | Open Prisma Studio (database GUI) |

### 3. Frontend

```bash
cd frontend

# Install dependencies
npm install

# Start development server
npm run dev
```

The frontend will be available at `http://localhost:5173`.

**Available Scripts:**
| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server with hot reload |
| `npm run build` | Build for production |
| `npm run preview` | Preview production build |
| `npm run lint` | Run ESLint |

## Project Structure

```
Stock_Analysis_App/
├── backend/
│   ├── src/              # Backend source code
│   ├── prisma/           # Database schema and migrations
│   └── package.json
├── frontend/
│   ├── src/              # React components and pages
│   └── package.json
├── docker-compose.yml    # Database containers
└── start-dev.sh          # Quick start script
```
