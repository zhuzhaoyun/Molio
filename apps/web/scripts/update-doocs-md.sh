#!/bin/bash
# Update vendored @md/core from doocs/md upstream
# Usage: ./scripts/update-doocs-md.sh [version|branch|commit]
# Example: ./scripts/update-doocs-md.sh main
#          ./scripts/update-doocs-md.sh v2.1.0

set -e

DOOCS_MD_VERSION=${1:-main}
VENDOR_DIR="./vendor/doocs-md"
TEMP_DIR=$(mktemp -d)

echo "📦 Updating doocs/md @ $DOOCS_MD_VERSION..."
echo ""

# Clone the repository
echo "Cloning doocs/md..."
gh repo clone doocs/md "$TEMP_DIR" -- --depth 1 --branch "$DOOCS_MD_VERSION" 2>/dev/null || \
  git clone --depth 1 --branch "$DOOCS_MD_VERSION" https://github.com/doocs/md.git "$TEMP_DIR"

# Check if clone succeeded
if [ ! -d "$TEMP_DIR/packages/core" ]; then
  echo "❌ Clone failed or version not found"
  rm -rf "$TEMP_DIR"
  exit 1
fi

# Get version info
VERSION=$(cat "$TEMP_DIR/packages/core/package.json" | grep '"version"' | head -1 | sed 's/.*: "\(.*\)".*/\1/')
echo "Found @md/core version: $VERSION"
echo ""

# Copy @md/core source
echo "Copying @md/core/src/ → $VENDOR_DIR/src/"
rm -rf "$VENDOR_DIR/src"
cp -r "$TEMP_DIR/packages/core/src" "$VENDOR_DIR/src"

# Copy theme CSS files
echo "Copying themes → $VENDOR_DIR/themes/"
rm -rf "$VENDOR_DIR/themes"
mkdir -p "$VENDOR_DIR/themes"
cp -r "$TEMP_DIR/packages/shared/src/configs/theme-css/"* "$VENDOR_DIR/themes/"

# Copy shared dependencies (types and utils that @md/core imports)
echo "Copying shared dependencies → $VENDOR_DIR/shared/"
rm -rf "$VENDOR_DIR/shared"
mkdir -p "$VENDOR_DIR/shared"
cp -r "$TEMP_DIR/packages/shared/src/types" "$VENDOR_DIR/shared/" 2>/dev/null || true
cp -r "$TEMP_DIR/packages/shared/src/utils" "$VENDOR_DIR/shared/" 2>/dev/null || true

# Update version in package.json
if [ -n "$VERSION" ]; then
  sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" "$VENDOR_DIR/package.json"
fi

# Cleanup
rm -rf "$TEMP_DIR"

echo ""
echo "✅ Updated doocs-md to version $VERSION"
echo ""
echo "Next steps:"
echo "  1. Run 'pnpm install' to update dependencies"
echo "  2. Run 'pnpm typecheck' to verify types"
echo "  3. Run 'pnpm dev' to test the application"
