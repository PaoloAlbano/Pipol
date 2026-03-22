.PHONY: dev dev-tunnel check-key expose start-relay test test-watch coverage lint format

SERVEO_SUBDOMAIN ?= pipol
SERVEO_KEY       ?= ./serveo_key

dev:
	npm run dev

dev-tunnel:
	VITE_NO_SSL=1 npm run dev

check-key:
	@test -f $(SERVEO_KEY) || { echo "Error: key file '$(SERVEO_KEY)' not found. Set SERVEO_KEY=<path> or place it at $(SERVEO_KEY)"; exit 1; }

expose: check-key
	chmod 400 $(SERVEO_KEY)
	ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i $(SERVEO_KEY) -R $(SERVEO_SUBDOMAIN):80:localhost:5173 serveo.net

start-relay:
	cd relay && npm run start

test:
	npm run test:run

test-watch:
	npm run test

coverage:
	npm run test:coverage

lint:
	npm run lint

format:
	npm run format