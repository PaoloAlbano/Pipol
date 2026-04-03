.PHONY: install dev dev-tunnel build check-key expose start-relay test test-watch coverage lint format

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
