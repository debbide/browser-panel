#!/usr/bin/env bash
# Shared helpers: download GitHub release and sync code WITHOUT touching local data/scripts.
# shellcheck shell=bash

# Paths under project root that must never be deleted or overwritten by updates.
# (tasks = business scripts; data = sqlite; logs/screenshots/runtime = runtime state)
RELEASE_PRESERVE_NAMES=(
  tasks
  data
  logs
  screenshots
  runtime-data
  node_modules
  .venv
  .git
  .env
  .env.panel
  .env.local
)

REPO_SLUG_DEFAULT="debbide/browser-panel"

is_preserved_name() {
  local name="$1"
  local p
  for p in "${RELEASE_PRESERVE_NAMES[@]}"; do
    [[ "$name" == "$p" ]] && return 0
  done
  # any .env* stays local
  [[ "$name" == .env* ]] && return 0
  return 1
}

detect_repo_slug() {
  if [[ -n "${GITHUB_REPO:-}" ]]; then
    echo "$GITHUB_REPO"
    return
  fi
  if command -v git >/dev/null 2>&1 && git -C "${1:-.}" remote get-url origin >/dev/null 2>&1; then
    local url
    url="$(git -C "$1" remote get-url origin 2>/dev/null || true)"
    # https://github.com/owner/repo.git or git@github.com:owner/repo.git
    if [[ "$url" =~ github.com[:/]([^/]+/[^/.]+)(\.git)?$ ]]; then
      echo "${BASH_REMATCH[1]}"
      return
    fi
  fi
  echo "$REPO_SLUG_DEFAULT"
}

# Print tag name for latest release (or "" on failure)
latest_release_tag() {
  local slug="$1"
  local json
  json="$(curl -fsSL "https://api.github.com/repos/${slug}/releases/latest" 2>/dev/null || true)"
  if [[ -z "$json" ]]; then
    return 1
  fi
  # prefer python for json; fallback grep
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json,sys; print(json.load(sys.stdin).get("tag_name") or "")' <<<"$json" 2>/dev/null || true
  else
    echo "$json" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1
  fi
}

# Download source tarball for tag (or latest) into $2 directory (created).
# Sets global RELEASE_TAG_RESOLVED
download_release_tree() {
  local slug="$1"
  local dest="$2"
  local tag="${3:-}"
  mkdir -p "$dest"

  if [[ -z "$tag" || "$tag" == "latest" ]]; then
    tag="$(latest_release_tag "$slug" || true)"
  fi

  local url
  if [[ -n "$tag" ]]; then
    RELEASE_TAG_RESOLVED="$tag"
    url="https://github.com/${slug}/archive/refs/tags/${tag}.tar.gz"
    echo "[release] tag=${tag}"
    if ! curl -fsSL "$url" -o "${dest}/src.tgz"; then
      echo "[release] tag tarball failed, try latest codeload..."
      url="https://codeload.github.com/${slug}/tar.gz/refs/tags/${tag}"
      curl -fsSL "$url" -o "${dest}/src.tgz"
    fi
  else
    # No GitHub Release yet — fall back to default branch archive
    RELEASE_TAG_RESOLVED="branch-master"
    echo "[release] no release found; using master branch archive"
    url="https://codeload.github.com/${slug}/tar.gz/refs/heads/master"
    curl -fsSL "$url" -o "${dest}/src.tgz"
  fi

  mkdir -p "${dest}/tree"
  tar -xzf "${dest}/src.tgz" -C "${dest}/tree" --strip-components=1
  echo "[release] extracted to ${dest}/tree"
}

# Copy code from $1 (release tree) into $2 (project root). Never touches preserve list.
safe_sync_release_into() {
  local src="$1"
  local dst="$2"
  local name

  if [[ ! -d "$src" || ! -f "$src/package.json" ]]; then
    echo "[release] invalid source tree: $src" >&2
    return 1
  fi
  mkdir -p "$dst"

  echo "[release] sync code → $dst"
  echo "[release] preserve: ${RELEASE_PRESERVE_NAMES[*]} .env*"

  # Top-level entries only
  shopt -s dotglob nullglob
  for path in "$src"/*; do
    name="$(basename "$path")"
    if is_preserved_name "$name"; then
      echo "[release] skip (preserve): $name"
      continue
    fi
    if [[ -d "$path" ]]; then
      mkdir -p "$dst/$name"
      # refresh directory contents; do not --delete outside this subdir's new files carefully:
      # use rsync if available
      if command -v rsync >/dev/null 2>&1; then
        rsync -a --delete "$path"/ "$dst/$name"/
      else
        rm -rf "$dst/$name"
        cp -a "$path" "$dst/$name"
      fi
      echo "[release] updated dir: $name/"
    else
      cp -a "$path" "$dst/$name"
      echo "[release] updated file: $name"
    fi
  done
  shopt -u dotglob nullglob

  # Ensure preserve dirs exist (do not wipe if already there)
  local p
  for p in tasks data logs screenshots runtime-data; do
    mkdir -p "$dst/$p"
  done

  echo "[release] sync done (tasks/data/logs/... untouched)"
}
