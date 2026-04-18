# expected make version >= 3.82

.ONESHELL:

PROJECT_DIR := $(abspath .)
WEB_DIR := $(PROJECT_DIR)/web
POSTS_DIR := $(PROJECT_DIR)/contracts/posts

ifeq ($(CARGO_TARGET_DIR),)
$(error CARGO_TARGET_DIR is not set)
endif

build: \
	posts \
	publish-posts \
	webapp \
	publish-webapp

node: \
	build-tool \
	run-node

build-tool:
	cargo install freenet
	cargo install fdev

webapp:
	cd $(WEB_DIR)
	npm install
	npm run build
	fdev build

publish-webapp:
	cd $(WEB_DIR)
	fdev publish --code build/freenet/freenet_microblogging_web contract --state build/freenet/contract-state

posts:
	cd $(POSTS_DIR)
	fdev build
	hash=$$(bash -c "fdev inspect build/freenet/freenet_microblogging_posts key | grep 'code key:' | cut -d' ' -f3")
	mkdir -p $(WEB_DIR)/build
	echo $$hash
	echo -n $$hash > $(WEB_DIR)/model_code_hash.txt

publish-posts:
	cd $(POSTS_DIR)
	fdev publish --code build/freenet/freenet_microblogging_posts contract --state build/freenet/contract-state

run-node:
	RUST_BACKTRACE=1 RUST_LOG=freenet=debug,locutus_core=debug,locutus_node=debug,info freenet local
