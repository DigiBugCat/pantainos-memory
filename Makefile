ENV ?= prod
DB_NAME = pantainos-memory
BACKUP_DIR = backups
TIMESTAMP = $(shell date +%Y%m%d-%H%M%S)
BACKUP_FILE = $(BACKUP_DIR)/backup-$(ENV)-$(TIMESTAMP).sql

.PHONY: build backup deploy deploy-only

build:
	pnpm build

backup:
	@mkdir -p $(BACKUP_DIR)
	@echo "Backing up D1 ($(ENV))..."
	npx wrangler d1 export $(DB_NAME) --remote --output $(BACKUP_FILE)
	@echo "Backup saved: $(BACKUP_FILE)"

deploy: backup build
	cd infra && tofu apply -var="environment=$(ENV)"

deploy-only: build
	cd infra && tofu apply -var="environment=$(ENV)"
