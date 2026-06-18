test: ## Run offline tests
	npx vitest --reporter=verbose --run

test-live: ## Run offline and live API tests (needs API keys)
	AI_LIVE=1 npx vitest --reporter=verbose --run

test-watch: ## Run tests in watch mode
	npx vitest

types: ## Generate .d.ts from JSDoc
	npx tsc --declaration --allowJs --emitDeclarationOnly --skipLibCheck \
		--target es2020 --module nodenext --moduleResolution nodenext \
		--strict false --esModuleInterop true --outDir ./types src/index.js

types-clean: ## Remove generated types
	rm -rf types

clean: ## Remove node_modules
	rm -rf node_modules

install: ## Install dependencies
	npm install

.PHONY: help
help: ## Show help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(firstword $(MAKEFILE_LIST)) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[32m%-20s\033[0m %s\n", $$1, $$2}'
