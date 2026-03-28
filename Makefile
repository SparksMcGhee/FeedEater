COMPOSE ?= docker compose
ANSIBLE_INVENTORY ?= ansible/inventory.ini

.PHONY: up down ps logs build pull restart db-push deploy

up:
	$(COMPOSE) up -d --build

down:
	$(COMPOSE) down

ps:
	$(COMPOSE) ps

logs:
	$(COMPOSE) logs -f --tail=200

build:
	$(COMPOSE) build

pull:
	$(COMPOSE) pull

restart:
	$(COMPOSE) restart

deploy:
	@if [ ! -f .env ]; then echo "ERROR: .env not found. Copy .env.example and fill in FEED_SETTINGS_KEY / FEED_INTERNAL_TOKEN."; exit 1; fi
	@if [ -z "$$(grep -s FEED_SETTINGS_KEY .env | cut -d= -f2)" ]; then echo "ERROR: FEED_SETTINGS_KEY missing from .env"; exit 1; fi
	@if [ -z "$$(grep -s FEED_INTERNAL_TOKEN .env | cut -d= -f2)" ]; then echo "ERROR: FEED_INTERNAL_TOKEN missing from .env"; exit 1; fi
	set -a && . ./.env && set +a && ansible-playbook -i $(ANSIBLE_INVENTORY) ansible/deploy.yml

# Creates/updates platform tables using Prisma (idempotent).
db-push:
	$(COMPOSE) run --rm --workdir /app api npx prisma db push --schema packages/db/prisma/schema.prisma


