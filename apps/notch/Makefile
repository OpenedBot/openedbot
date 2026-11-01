APP      := OHBPopup
DIST     := dist/$(APP).app
BIN      := .build/release/$(APP)

.PHONY: build bundle run dev test clean

## Signé par l'identité locale stable (scripts/dev-sign.sh) : le trousseau ne redemande
## pas le mot de passe à chaque build.
build:
	swift build -c release
	scripts/dev-sign.sh $(BIN)

## Crée un bundle .app minimal (LSUIElement : pas d'icône dans le Dock).
bundle: build
	rm -rf $(DIST)
	mkdir -p $(DIST)/Contents/MacOS
	cp $(BIN) $(DIST)/Contents/MacOS/$(APP)
	cp Resources/Info.plist $(DIST)/Contents/
	mkdir -p $(DIST)/Contents/Resources
	cp -R .build/release/openedbot-notch_OHBPopup.bundle $(DIST)/Contents/Resources/
	scripts/dev-sign.sh $(DIST)

run: bundle
	open $(DIST)

## Lancement direct sans bundle (pratique en itération).
dev:
	swift run $(APP)

test:
	swift test

clean:
	rm -rf .build dist
