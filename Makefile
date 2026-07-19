.PHONY: install dev dev-tunnel build check-key expose start-relay start-auth auth-gen-key auth-lint auth-format auth-test auth-test-watch test test-watch coverage lint format e2e e2e-notifications e2e-workspace e2e-headed

SERVEO_SUBDOMAIN ?= pipol
SERVEO_KEY       ?= ./serveo_key

install:
	pnpm install

dev:
	ALLOW_IDENTITY_RESET=true pnpm run dev

dev-tunnel:
	ALLOW_IDENTITY_RESET=true VITE_NO_SSL=1 pnpm run dev

build:
	pnpm run build

check-key:
	@test -f $(SERVEO_KEY) || { echo "Error: key file '$(SERVEO_KEY)' not found. Set SERVEO_KEY=<path> or place it at $(SERVEO_KEY)"; exit 1; }

expose: check-key
	chmod 400 $(SERVEO_KEY)
	ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i $(SERVEO_KEY) -R $(SERVEO_SUBDOMAIN):80:localhost:5173 serveo.net

start-relay:
	cd relay && npm run start

start-auth:
	cd auth && pnpm run start

auth-lint:
	cd auth && pnpm run lint

auth-format:
	cd auth && pnpm run format

auth-test:
	cd auth && pnpm run test

auth-test-watch:
	cd auth && pnpm run test:watch

auth-gen-key:
	@echo "PIPOL_MASTER_KEY_V1=$$(openssl rand -hex 32)"

test:
	pnpm run test:run

test-watch:
	pnpm run test

coverage:
	pnpm run test:coverage
	@node -e " \
	  const s = require('./coverage/coverage-summary.json').total; \
	  const f = n => String(n).padStart(5); \
	  console.log('\n📊  Overall coverage:  Stmts ' + f(s.statements.pct) + '%   Branch ' + f(s.branches.pct) + '%   Funcs ' + f(s.functions.pct) + '%   Lines ' + f(s.lines.pct) + '%\n'); \
	"

lint:
	pnpm run lint

format:
	pnpm run format

e2e:
	pnpm exec playwright test

e2e-headed:
	pnpm exec playwright test --headed
