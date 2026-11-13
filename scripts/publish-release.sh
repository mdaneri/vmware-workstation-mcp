#!/usr/bin/env bash
set -euo pipefail

version=${RELEASE_VERSION:?}
commit=${GITHUB_SHA:?}
tag="v$version"
archive="vmware-workstation-$version"
files=("dist/$archive.zip" "dist/$archive.mcpb" "dist/$archive-SHA256SUMS.txt")

for file in "${files[@]}"; do
  test -s "$file"
done
(cd dist && sha256sum --check "$archive-SHA256SUMS.txt")

# Honor an existing tag only when it resolves to the commit tested by this run.
tag_commit=$(git ls-remote origin "refs/tags/$tag" "refs/tags/$tag^{}" | tail -n 1 | cut -f 1)
if [[ -n "$tag_commit" && "$tag_commit" != "$commit" ]]; then
  echo "Tag $tag points to $tag_commit instead of $commit." >&2
  exit 1
fi

if release=$(gh release view "$tag" --json isDraft,targetCommitish,assets 2>&1); then
  if [[ $(jq -r '.isDraft' <<< "$release") == false ]]; then
    if [[ "$tag_commit" != "$commit" ]]; then
      echo "Published release $tag has no tag at $commit." >&2
      exit 1
    fi
    for file in "${files[@]}"; do
      jq -e --arg name "${file##*/}" \
        '.assets | any(.name == $name and .state == "uploaded" and .size > 0)' <<< "$release" > /dev/null
    done
    echo "Release $tag already has all three assets."
    exit 0
  fi
  # A failed upload can leave a draft. Resume it only for the same commit.
  if [[ -z "$tag_commit" && $(jq -r '.targetCommitish' <<< "$release") != "$commit" ]]; then
    echo "Draft $tag does not target $commit." >&2
    exit 1
  fi
  gh release upload "$tag" "${files[@]}" --clobber
  gh release edit "$tag" --draft=false
elif [[ "$release" == 'release not found' ]]; then
  gh release create "$tag" "${files[@]}" --target "$commit" \
    --title "VMware Workstation Plugin $tag" --generate-notes
else
  printf '%s\n' "$release" >&2
  exit 1
fi
